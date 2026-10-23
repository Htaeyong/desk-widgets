// Creates and tracks the theme windows of one themed widget.
// Dooray (the legacy host): an "overview" window plus detached "project" widgets, saved as windowBounds /
// projectWidgets / alwaysOnTop. A widget with its own theme contract (#57): a "main" window plus optional
// further frames, saved as themeBounds / themeFrames / alwaysOnTop.
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const themes = require('./themes');
const { cssFor } = require('./theme-background');

const MARGIN = 24;
const PRELOAD_DIR = path.join(__dirname, '..', 'preload');

/**
 * The saved-bounds key of a window (#23, #57): the frame (plus its instance and size variant), prefixed by the
 * layout unless that is the widget's default layout. A color skin shares its base's sizes; a theme with its own
 * page keeps its own. Dooray keeps its original keys: "overview", "project:<id>", "board/overview".
 */
function boundsKeyOf({ legacy, defaultLayout, layout, frame, instanceId, variant }) {
  let key;
  if (legacy) key = frame === 'overview' ? 'overview' : `project:${instanceId}`;
  else key = `${frame}${instanceId ? `:${instanceId}` : ''}${variant ? `+${variant}` : ''}`;
  const lay = layout || defaultLayout;
  return lay === defaultLayout ? key : `${lay}/${key}`;
}

class ThemeWindows {
  /**
   * @param {{ settings: object, devtools?: boolean, onQuitRequest: () => void,
   *           backgroundOf?: (theme: object) => number | null, registry: object,
   *           frames?: string[], getVariant?: (frame: string) => string | null,
   *           additionalArguments?: string[], onMenu?: (entry: object) => void }} opts
   *   backgroundOf: the background opacity (0..1) a theme is drawn with, null when it does not opt in (#55).
   *   registry: the widget's themes (theme-registry.js); legacy = Dooray.
   *   frames: window kinds of a widget with its own contract; the first is the main window.
   */
  constructor({ settings, devtools = false, onQuitRequest, backgroundOf = () => null, registry, frames, getVariant, additionalArguments, onMenu }) {
    this.settings = settings;
    this.backgroundOf = backgroundOf;
    this.devtools = devtools;
    this.onQuitRequest = onQuitRequest;
    this.registry = registry;
    this.legacy = registry.legacy;
    this.frames = this.legacy ? ['overview', 'project'] : frames?.length ? frames : ['main'];
    this.mainFrame = this.frames[0];
    this.getVariant = this.legacy ? () => null : getVariant || (() => null);
    this.additionalArguments = additionalArguments || [];
    this.onMenu = onMenu;
    this.preload = path.join(PRELOAD_DIR, this.legacy ? 'theme.js' : 'widget-theme.js');
    // Setting names of the saved state (Dooray keeps its original ones).
    this.keys = this.legacy ? { bounds: 'windowBounds', list: 'projectWidgets' } : { bounds: 'themeBounds', list: 'themeFrames' };
    this.byWebContents = new Map(); // webContents.id -> entry
    this.quitting = false;
    this.theme = null;
  }

  /** Looks up the window entry for an IPC sender; null when the sender is not a theme window. */
  fromSender(sender) {
    return this.byWebContents.get(sender.id) || null;
  }

  /** Widget windows (the theme preview is not one: it is never anchored, saved or counted). */
  entries() {
    return [...this.byWebContents.values()].filter((e) => !e.preview);
  }

  /** Lets a theme page that lives outside these windows (the preview) use the theme API. */
  register(webContents, entry) {
    this.byWebContents.set(webContents.id, entry);
    webContents.once('destroyed', () => this.byWebContents.delete(webContents.id));
  }

  /** webPreferences of every theme page of this widget (widget windows and the preview). */
  webPreferences() {
    themes.ensureSession(this.registry);
    return {
      preload: this.preload,
      partition: this.registry.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      ...(this.additionalArguments.length ? { additionalArguments: this.additionalArguments } : {}),
    };
  }

  broadcast(channel, ...payload) {
    for (const e of this.byWebContents.values()) {
      const wc = e.webContents || e.win.webContents;
      if (!wc.isDestroyed()) wc.send(channel, ...payload);
    }
  }

  /**
   * Puts the background opacity (#55) on a theme page: the --theme-bg-alpha variable through an
   * engine-inserted stylesheet (outside the page's CSP, no theme code needed) plus the theme:background
   * event. A theme without "background" in theme.json is never touched. Calls run one at a time per page.
   */
  applyBackground(entry) {
    if (!entry.webContents && (!entry.win || entry.win.isDestroyed())) return;
    const wc = entry.webContents || entry.win.webContents;
    const alpha = this.backgroundOf(entry.theme || this.theme);
    entry.bgQueue = (entry.bgQueue || Promise.resolve())
      .then(async () => {
        if (wc.isDestroyed()) return;
        if (entry.bgCss) {
          const key = entry.bgCss;
          entry.bgCss = null;
          await wc.removeInsertedCSS(key).catch(() => {});
        }
        if (alpha === null || alpha === undefined) return;
        entry.bgCss = await wc.insertCSS(cssFor(alpha));
        wc.send('theme:background', { opacity: alpha });
      })
      .catch(() => {});
  }

  /** Re-applies the background opacity on every theme page (widgets and the preview). */
  applyBackgroundAll() {
    for (const e of this.byWebContents.values()) this.applyBackground(e);
  }

  /** A new document has none of the old inserted CSS: forget its key and apply again. */
  watchBackground(wc, entry) {
    wc.on('dom-ready', () => {
      entry.bgCss = null;
      this.applyBackground(entry);
    });
  }

  boundsKey(mode, projectId, variant = this.getVariant(mode)) {
    return boundsKeyOf({
      legacy: this.legacy,
      defaultLayout: this.registry.defaultTheme,
      layout: this.theme?.layoutId,
      frame: mode,
      instanceId: projectId,
      variant,
    });
  }

  /** The theme's size for a frame and variant: window["main+tools"] when the theme has it, else window.main. */
  sizeOf(theme, mode, variant = this.getVariant(mode)) {
    return (variant && theme.window[`${mode}+${variant}`]) || theme.window[mode] || theme.window[this.mainFrame];
  }

  /** Resizes a theme window (theme API v1.7), keeping its top-left corner and staying on screen. */
  setSize(entry, width, height) {
    const { win } = entry;
    const [minW, minH] = win.getMinimumSize();
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const w = Math.round(Math.min(Math.max(Number(width) || b.width, minW, 120), wa.width));
    const h = Math.round(Math.min(Math.max(Number(height) || b.height, minH, 32), wa.height));
    const y = Math.min(b.y, wa.y + wa.height - h);
    const x = Math.min(b.x, wa.x + wa.width - w);
    win.setBounds({ x, y, width: w, height: h });
    this.saveBoundsLater(entry);
    return { width: w, height: h };
  }

  // Use saved bounds only if they are still visible on a connected display.
  restoreBounds(key, size, index) {
    const saved = this.settings.load()[this.keys.bounds]?.[key];
    if (saved) {
      const display = screen.getDisplayMatching(saved);
      const wa = display.workArea;
      const visible =
        saved.x < wa.x + wa.width - 40 && saved.x + saved.width > wa.x + 40 && saved.y >= wa.y - 10 && saved.y < wa.y + wa.height - 40;
      if (visible) return saved;
    }
    const { workArea } = screen.getPrimaryDisplay();
    const offset = index * (size.width + 12);
    return {
      width: size.width,
      height: size.height,
      x: Math.max(workArea.x, workArea.x + workArea.width - size.width - MARGIN - offset),
      y: workArea.y + MARGIN,
    };
  }

  saveBounds(key, bounds) {
    const all = { ...(this.settings.load()[this.keys.bounds] || {}) };
    all[key] = bounds;
    this.settings.save({ [this.keys.bounds]: all });
  }

  saveBoundsLater(entry) {
    clearTimeout(entry.saveTimer);
    entry.saveTimer = setTimeout(() => {
      if (entry.win.isDestroyed()) return;
      this.saveBounds(entry.boundsKey || this.boundsKey(entry.mode, entry.projectId), entry.win.getBounds());
    }, 500);
  }

  /** Remembered extra windows: Dooray's { projectId, pinned }, others' { frame, instanceId, pinned }. */
  remembered() {
    const list = this.settings.load()[this.keys.list];
    return Array.isArray(list) ? list : [];
  }

  sameWindow(item, mode, projectId) {
    return this.legacy ? item.projectId === projectId : item.frame === mode && item.instanceId === projectId;
  }

  create(mode, projectId = null) {
    const theme = this.theme;
    const variant = this.getVariant(mode);
    const size = this.sizeOf(theme, mode, variant);
    const pinned =
      mode === this.mainFrame
        ? this.settings.load().alwaysOnTop
        : Boolean(this.remembered().find((w) => this.sameWindow(w, mode, projectId))?.pinned);
    const boundsKey = this.boundsKey(mode, projectId, variant);
    const bounds = this.restoreBounds(boundsKey, size, mode === this.mainFrame ? 0 : this.entries().length);

    const win = new BrowserWindow({
      ...bounds,
      minWidth: size.minWidth,
      minHeight: size.minHeight,
      frame: false,
      transparent: theme.window.transparent,
      backgroundColor: theme.window.transparent ? '#00000000' : '#1b1d22',
      resizable: true,
      skipTaskbar: true,
      alwaysOnTop: Boolean(pinned),
      hasShadow: !theme.window.transparent,
      show: false,
      webPreferences: this.webPreferences(),
    });

    if (process.platform === 'win32' && theme.window.material !== 'none' && typeof win.setBackgroundMaterial === 'function') {
      win.setBackgroundMaterial(theme.window.material);
    }

    const entry = { win, mode, projectId, variant, boundsKey, saveTimer: null };
    const wcId = win.webContents.id;
    this.byWebContents.set(wcId, entry);

    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => {
      // Allow in-theme navigation only (e.g. reload); everything else is blocked.
      if (!this.registry.isThemeUrl(theme, url)) event.preventDefault();
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    this.watchBackground(wc, entry);
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
        event.preventDefault();
        wc.reloadIgnoringCache();
      }
      if (input.key === 'F12' && this.devtools) wc.toggleDevTools();
    });
    // A right click on a drag region shows the Windows system menu; a widget with its own contract shows its menu.
    if (!this.legacy && this.onMenu) {
      win.on('system-context-menu', (event) => {
        event.preventDefault();
        this.onMenu(entry);
      });
    }

    win.on('moved', () => this.saveBoundsLater(entry));
    win.on('resized', () => this.saveBoundsLater(entry));
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => {
      clearTimeout(entry.saveTimer);
      this.byWebContents.delete(wcId);
    });

    win.loadURL(this.registry.themeUrl(theme));
    if (this.devtools) wc.openDevTools({ mode: 'detach' });
    return entry;
  }

  /** Opens the main window and every remembered extra window with the current theme. */
  openAll() {
    this.theme = this.registry.resolveTheme(this.settings.load().themeId);
    if (!this.theme) throw new Error('사용 가능한 테마가 없습니다.');
    this.create(this.mainFrame);
    for (const w of this.remembered()) {
      if (this.legacy) this.create('project', w.projectId);
      else if (this.frames.includes(w.frame) && w.frame !== this.mainFrame) this.create(w.frame, w.instanceId || null);
    }
  }

  /** Recreates all theme windows (transparency cannot change on a live window). */
  reloadAll() {
    const old = this.entries();
    this.quitting = true; // keep remembered widget list while closing
    for (const e of old) e.win.destroy();
    this.quitting = false;
    this.openAll();
  }

  /**
   * The widget's size variant changed (e.g. the clock's stopwatch/timer tabs turned on): each window keeps its
   * current bounds under the old key and takes the saved (or default) size of the new one, around the same center.
   */
  applyVariant() {
    for (const entry of this.entries()) {
      const variant = this.getVariant(entry.mode);
      const key = this.boundsKey(entry.mode, entry.projectId, variant);
      if (key === entry.boundsKey || entry.win.isDestroyed()) continue;
      clearTimeout(entry.saveTimer);
      const cur = entry.win.getBounds();
      this.saveBounds(entry.boundsKey, cur);
      entry.variant = variant;
      entry.boundsKey = key;
      const size = this.sizeOf(this.theme, entry.mode, variant);
      const saved = this.settings.load()[this.keys.bounds]?.[key];
      entry.win.setMinimumSize(size.minWidth, size.minHeight);
      entry.win.setBounds(
        saved || {
          width: size.width,
          height: size.height,
          x: Math.round(cur.x + cur.width / 2 - size.width / 2),
          y: Math.round(cur.y + cur.height / 2 - size.height / 2),
        }
      );
    }
  }

  /** Brings a widget to the front; beforeFocus lets the desktop anchor drop its owner link first. */
  focus(win) {
    this.beforeFocus?.(win);
    win.show();
    win.focus();
  }

  overview() {
    return this.entries().find((e) => e.mode === this.mainFrame) || null;
  }

  /** Opens (or brings forward) an extra window: a Dooray project widget, or another frame of the widget. */
  openFrame(mode, projectId) {
    const existing = this.entries().find((e) => e.mode === mode && e.projectId === projectId);
    if (existing) {
      this.focus(existing.win);
      return;
    }
    const list = this.remembered();
    if (!list.some((w) => this.sameWindow(w, mode, projectId))) {
      const item = this.legacy ? { projectId, pinned: false } : { frame: mode, instanceId: projectId, pinned: false };
      this.settings.save({ [this.keys.list]: [...list, item] });
    }
    this.create(mode, projectId);
  }

  openProject(projectId) {
    this.openFrame('project', projectId);
  }

  close(entry) {
    if (entry.mode === this.mainFrame) {
      this.onQuitRequest();
      return;
    }
    if (!this.quitting) {
      const list = this.remembered().filter((w) => !this.sameWindow(w, entry.mode, entry.projectId));
      this.settings.save({ [this.keys.list]: list });
    }
    entry.win.close();
  }

  togglePin(entry) {
    const next = !entry.win.isAlwaysOnTop();
    entry.win.setAlwaysOnTop(next);
    if (entry.mode === this.mainFrame) {
      this.settings.save({ alwaysOnTop: next });
    } else {
      const list = this.remembered().map((w) => (this.sameWindow(w, entry.mode, entry.projectId) ? { ...w, pinned: next } : w));
      this.settings.save({ [this.keys.list]: list });
    }
    return next;
  }

  setOverviewPinned(pinned) {
    this.overview()?.win.setAlwaysOnTop(pinned);
  }
}

module.exports = { ThemeWindows, boundsKeyOf };
