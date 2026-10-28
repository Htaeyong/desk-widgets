// Window groups (#109): windows opened from one hidden host page share its renderer process. Only requests the
// engine registered are allowed, the windows' preferences are locked down, a crashed host is replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { WindowGroup, lockedPreferences } = require('../main/window-group');

/** A BrowserWindow stand-in: window.open() from executeJavaScript goes through the window-open handler. */
function fakeElectron() {
  const all = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      const wc = new EventEmitter();
      wc.crashed = false;
      wc.isCrashed = () => wc.crashed;
      wc.setWindowOpenHandler = (fn) => (wc.openHandler = fn);
      wc.executeJavaScript = async (code) => {
        const m = /window\.open\(("[^"]*"), ("[^"]*")\)/.exec(code);
        if (m) this.windowOpen(JSON.parse(m[1]), JSON.parse(m[2]));
      };
      this.webContents = wc;
      all.push(this);
    }
    loadFile(file) {
      this.loaded = file;
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
    /** What Chromium does for window.open(url, name) in this page. */
    windowOpen(url, frameName) {
      const answer = this.webContents.openHandler ? this.webContents.openHandler({ url, frameName, features: '' }) : { action: 'allow' };
      if (answer.action !== 'allow') return null;
      const child = new FakeWindow(answer.overrideBrowserWindowOptions || {});
      child.url = url;
      child.opener = this;
      this.webContents.emit('did-create-window', child, { url, frameName });
      return child;
    }
    crash() {
      this.webContents.crashed = true;
      this.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    }
  }
  return { BrowserWindow: FakeWindow, all };
}

const PAGE = path.join(__dirname, 'page.html');
const options = (prefs = {}) => ({ width: 260, height: 240, show: false, webPreferences: { preload: 'p.js', ...prefs } });

test('lockedPreferences: sandboxed, isolated, no Node, no webview, no own session', () => {
  const p = lockedPreferences({ preload: 'x.js', nodeIntegration: true, sandbox: false, contextIsolation: false, webviewTag: true, partition: 'persist:other', spellcheck: false });
  assert.deepEqual(p, { preload: 'x.js', spellcheck: false, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false });
});

test('windows open from one hidden host page (one process), with the url and locked preferences asked for', async () => {
  const fake = fakeElectron();
  const group = new WindowGroup({ name: 't', BrowserWindow: fake.BrowserWindow });
  const a = await group.open(PAGE, { options: options({ nodeIntegration: true }) });
  const b = await group.open(PAGE, { query: { id: 'n 2' }, options: options() });
  const hosts = fake.all.filter((w) => !w.opener);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].options.show, false);
  assert.equal(a.opener, hosts[0]);
  assert.equal(b.opener, hosts[0]);
  assert.match(a.url, /^file:\/\/.*page\.html$/);
  assert.match(b.url, /page\.html\?id=n\+2$/);
  assert.equal(a.options.webPreferences.nodeIntegration, false);
  assert.equal(a.options.webPreferences.sandbox, true);
  assert.equal(a.options.webPreferences.preload, 'p.js');
  assert.equal(a.options.width, 260);
  group.destroy();
  assert.ok(a.isDestroyed() && b.isDestroyed() && hosts[0].isDestroyed());
});

test('the host allows only a registered token with its exact url, once; grouped pages open nothing and stay put', async () => {
  const fake = fakeElectron();
  const group = new WindowGroup({ name: 't', BrowserWindow: fake.BrowserWindow });
  const win = await group.open(PAGE, { options: options() });
  const host = win.opener;
  // A page (or anything else) asking the host for a window: no token, a guessed token, another url.
  assert.equal(host.windowOpen('https://example.com/', 'x'), null);
  let token = null;
  const original = host.webContents.executeJavaScript;
  host.webContents.executeJavaScript = async (code) => {
    token = JSON.parse(/, ("[^"]*")\)/.exec(code)[1]);
    assert.equal(host.windowOpen('https://example.com/', token), null); // right token, wrong url
    return original(code);
  };
  await group.open(PAGE, { options: options() });
  assert.ok(token);
  assert.equal(host.windowOpen(win.url, token), null); // used once only
  // The grouped page's own window.open and navigation are refused.
  assert.deepEqual(win.webContents.openHandler({ url: 'https://example.com/', frameName: '' }), { action: 'deny' });
  // Its first navigation (to the page asked for) passes once; anything after that is refused.
  let prevented = false;
  win.webContents.emit('will-navigate', { url: win.url, preventDefault: () => (prevented = true) });
  assert.equal(prevented, false);
  win.webContents.emit('will-navigate', { url: win.url, preventDefault: () => (prevented = true) });
  assert.ok(prevented);
  prevented = false;
  const other = await group.open(PAGE, { options: options() });
  other.webContents.emit('will-navigate', { url: 'https://example.com/', preventDefault: () => (prevented = true) });
  assert.ok(prevented);
  prevented = false;
  host.webContents.emit('will-navigate', { preventDefault: () => (prevented = true) });
  assert.ok(prevented);
  group.destroy();
});

test('a crashed host is dropped; the next window starts a new host', async () => {
  const fake = fakeElectron();
  const group = new WindowGroup({ name: 't', BrowserWindow: fake.BrowserWindow });
  const a = await group.open(PAGE, { options: options() });
  const firstHost = a.opener;
  firstHost.crash();
  assert.ok(firstHost.isDestroyed());
  const b = await group.open(PAGE, { options: options() });
  assert.notEqual(b.opener, firstHost);
  assert.equal(fake.all.filter((w) => !w.opener).length, 2);
  group.destroy();
});

test('a window that never arrives fails after the timeout; an empty group lets its host (process) go', async () => {
  const fake = fakeElectron();
  const group = new WindowGroup({ name: 't', BrowserWindow: fake.BrowserWindow, idleMs: 20, timeoutMs: 30 });
  const win = await group.open(PAGE, { options: options() });
  const host = win.opener;
  host.webContents.executeJavaScript = async () => {}; // the page does not open it
  await assert.rejects(group.open(PAGE, { options: options() }), /did not open/);
  win.destroy();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(host.isDestroyed());
  assert.equal(group.host, null);
  group.destroy();
  await assert.rejects(group.open(PAGE, { options: options() }), /closed/);
});
