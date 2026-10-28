// Windows that share one renderer process (#109, docs/memory-review.md). Electron gives every BrowserWindow its own
// renderer (~16 MB each); a window opened with window.open() from a page lives in that page's process instead. A group
// keeps one hidden, empty host page and opens its windows from there, so all of them share the host's process.
//
// Only the engine opens them: the host page has no preload and no content (CSP default-src 'none'), and its
// window-open handler allows a request only when its name is a one-time random token the engine just registered
// together with the exact url. Everything else is denied, from the host and from every grouped window.
// The grouped windows run in the default session, like the windows they replace.
//
// One process means one crash: if it dies, every window of the group shows nothing. The group then drops the host
// (the next open() starts a new one) and each window's webContents gets 'render-process-gone', on which its owner
// reopens it.
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

const HOST_HTML = path.join(__dirname, '..', 'renderer', 'group-host.html');
const OPEN_TIMEOUT_MS = 15000;
const HOST_IDLE_MS = 5000; // after the last window closed, the host (and with it the process) goes

const deny = () => ({ action: 'deny' });

/** The webPreferences every grouped window gets whatever the caller asked for. */
function lockedPreferences(prefs = {}) {
  const { partition: _p, session: _s, nodeIntegration: _n, nodeIntegrationInSubFrames: _ns, webviewTag: _w, ...rest } = prefs;
  return { ...rest, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false };
}

class WindowGroup {
  /**
   * @param {{ name: string, BrowserWindow?: Function, hostHtml?: string, idleMs?: number, timeoutMs?: number }} opts
   *   BrowserWindow replaces electron's in tests.
   */
  constructor({ name, BrowserWindow, hostHtml = HOST_HTML, idleMs = HOST_IDLE_MS, timeoutMs = OPEN_TIMEOUT_MS }) {
    this.name = name;
    this.BrowserWindow = BrowserWindow || require('electron').BrowserWindow;
    this.hostHtml = hostHtml;
    this.idleMs = idleMs;
    this.timeoutMs = timeoutMs;
    this.host = null;
    this.hostReady = null;
    this.pending = new Map(); // token -> { url, options, resolve, reject, timer }
    this.windows = new Set();
    this.idleTimer = null;
    this.destroyed = false;
  }

  hostAlive() {
    return Boolean(this.host && !this.host.isDestroyed() && !this.host.webContents.isCrashed());
  }

  /** The hidden host page, started when needed (again after a crash or after the group was empty). */
  ensureHost() {
    if (this.hostAlive() && this.hostReady) return this.hostReady;
    this.dropHost();
    const host = new this.BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: lockedPreferences({ spellcheck: false, backgroundThrottling: true }),
    });
    this.host = host;
    const wc = host.webContents;
    wc.setWindowOpenHandler((details) => this.allow(details));
    wc.on('did-create-window', (win, details) => this.created(win, details));
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.on('render-process-gone', () => {
      if (this.host === host) this.dropHost();
    });
    this.hostReady = host.loadFile(this.hostHtml).then(() => host);
    this.hostReady.catch(() => {
      if (this.host === host) this.dropHost();
    });
    return this.hostReady;
  }

  dropHost() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const host = this.host;
    this.host = null;
    this.hostReady = null;
    for (const [token, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`window group ${this.name}: host is gone`));
      this.pending.delete(token);
    }
    if (host && !host.isDestroyed()) host.destroy();
  }

  /** The host's window-open handler: only a request the engine registered a moment ago, with its exact url. */
  allow({ url, frameName }) {
    const req = this.pending.get(frameName);
    if (!req || req.url !== url || req.claimed) return deny();
    req.claimed = true;
    return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: req.options };
  }

  created(win, { frameName }) {
    const req = this.pending.get(frameName);
    if (!req) {
      win.destroy(); // not ours (cannot happen: the handler allowed it), never kept
      return;
    }
    this.pending.delete(frameName);
    clearTimeout(req.timer);
    const wc = win.webContents;
    // A grouped page opens nothing and goes nowhere, like the windows it replaces. Its first navigation (to the
    // requested page, started by window.open) passes this check once.
    wc.setWindowOpenHandler(deny);
    let first = true;
    wc.on('will-navigate', (event, url) => {
      if (first && (event.url ?? url) === req.url) first = false;
      else event.preventDefault();
    });
    wc.once('did-finish-load', () => (first = false));
    this.windows.add(win);
    clearTimeout(this.idleTimer);
    win.on('closed', () => {
      this.windows.delete(win);
      this.scheduleIdle();
    });
    req.resolve(win);
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.windows.size || this.pending.size) return;
    this.idleTimer = setTimeout(() => {
      if (!this.windows.size && !this.pending.size) this.dropHost();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * Opens a local page as a new window in the group's process.
   * @param {string} file  html file
   * @param {{ query?: object, options: object }} opts  BrowserWindow options (webPreferences are locked down)
   * @returns {Promise<BrowserWindow>}
   */
  async open(file, { query, options }) {
    if (this.destroyed) throw new Error(`window group ${this.name} is closed`);
    const url = new URL(pathToFileURL(file).href);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const host = await this.ensureHost();
    const token = `g${crypto.randomBytes(16).toString('hex')}`;
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`window group ${this.name}: the window did not open`));
        this.scheduleIdle();
      }, this.timeoutMs);
      this.pending.set(token, { url: url.href, options: { ...options, webPreferences: lockedPreferences(options.webPreferences) }, resolve, reject, timer });
    });
    // The page's own script runs nothing here; this call is the engine's.
    host.webContents.executeJavaScript(`void window.open(${JSON.stringify(url.href)}, ${JSON.stringify(token)})`, true).catch(() => {});
    return opened;
  }

  /** Closes every window of the group and the host. */
  destroy() {
    this.destroyed = true;
    for (const win of [...this.windows]) if (!win.isDestroyed()) win.destroy();
    this.windows.clear();
    this.dropHost();
  }
}

module.exports = { WindowGroup, lockedPreferences, HOST_HTML };
