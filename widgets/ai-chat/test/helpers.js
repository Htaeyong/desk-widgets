// Shared test parts: a work folder with a fake `claude`, and a fake engine context. No real key, no real API call.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const WIDGET_DIR = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fake-claude.js');
// Shaped like a key, used only here. Never a real one.
const FAKE_KEY = `sk-ant-api03-${'test'.repeat(8)}-Z9y8`;
// Consent given and a model chosen.
const READY = { consent: { version: 1, at: '2026-11-07T00:00:00.000Z' }, modelChosen: true };

function workspace(behavior = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-test-'));
  const fake = path.join(dir, 'fake-claude.js');
  fs.copyFileSync(FAKE, fake);
  fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify(behavior));
  const cwd = path.join(dir, 'work folder');
  fs.mkdirSync(cwd);
  const calls = () => {
    const file = path.join(dir, 'calls.jsonl');
    if (!fs.existsSync(file)) return [];
    // Another fake may be writing its line right now: only whole lines count.
    const text = fs.readFileSync(file, 'utf8');
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  };
  const versionCalls = () => {
    const file = path.join(dir, 'versions.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0;
  };
  return {
    dir, fake, cwd, calls, versionCalls,
    configDir: path.join(dir, 'config'),
    resolve: () => ({ file: process.execPath, args: [fake] }),
    setBehavior: (next) => fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify(next)),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

/** An in-memory secret store. `encrypted: false` acts like a PC without DPAPI. The file holds a reversed copy, not the value. */
function fakeSecrets(file, { encrypted = true } = {}) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  const flip = (s) => [...s].reverse().join('');
  return {
    available: () => encrypted,
    set(id, value) {
      if (!encrypted) throw Object.assign(new Error('no dpapi'), { code: 'secret-unavailable' });
      fs.writeFileSync(file, JSON.stringify({ ...read(), [id]: flip(value) }));
    },
    get: (id) => (read()[id] ? flip(read()[id]) : ''),
    has: (id) => Boolean(read()[id]),
    delete(id) {
      const map = read();
      delete map[id];
      fs.writeFileSync(file, JSON.stringify(map));
    },
  };
}

function fakeWindow() {
  const win = new EventEmitter();
  const sent = [];
  let destroyed = false;
  return Object.assign(win, {
    sent,
    webContents: { send: (_channel, name, payload) => sent.push([name, payload]) },
    isDestroyed: () => destroyed,
    isVisible: () => !win.hiddenForTest,
    isMinimized: () => false,
    show() {},
    focus() {},
    close() {
      destroyed = true;
      win.emit('closed');
    },
  });
}

/** A fake engine context around the real settings sanitize. `dir` is the real widget folder, so bin\ is the real helper. */
function fakeContext(ws, { encrypted = true, initial = {} } = {}) {
  const dataDir = path.join(ws.dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const handlers = {};
  const windows = [];
  const opened = [];
  let tray = null;
  let settingsOpened = 0;
  const notified = [];
  const quits = [];
  let state = null;
  const ctx = {
    id: 'ai-chat',
    dir: WIDGET_DIR,
    dataDir,
    createStore: ({ defaults, sanitize }) => {
      state = sanitize({ ...defaults, ...initial });
      return { load: () => state, save: (values) => { state = sanitize({ ...state, ...values }); return state; } };
    },
    secrets: { open: () => fakeSecrets(path.join(dataDir, 'secrets.json'), { encrypted }) },
    handle: (channel, fn) => { handlers[channel] = fn; },
    openExternal: (url) => opened.push(url),
    openSettings: () => { settingsOpened++; },
    quit: () => { quits.push(Date.now()); },
    setTrayItems: (items) => { tray = items; return true; },
    notify: (events, options) => notified.push({ events, options }),
    beforeFocus() {},
    openAppWindow: (options) => {
      const win = Object.assign(fakeWindow(), { options });
      windows.push(win);
      return win;
    },
  };
  return { ctx, handlers, windows, opened, notified, quits, tray: () => tray, settingsOpened: () => settingsOpened, state: () => state };
}

/** Every file under a folder, as text. */
function allFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).map((f) => path.join(root, String(f))).filter((f) => fs.statSync(f).isFile());
}

module.exports = { WIDGET_DIR, FAKE, FAKE_KEY, READY, workspace, fakeSecrets, fakeWindow, fakeContext, allFiles };
