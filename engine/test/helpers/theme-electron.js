// A small Electron stand-in for the theme host tests (#57, #58): IPC handlers, windows and sessions are recorded.
// Install before requiring engine/main/theme-host.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ipcHandlers = new Map();
const sessions = new Map();
const windows = [];
let nextId = 1;

function fakeWebContents() {
  const listeners = new Map();
  return {
    id: nextId++,
    sent: [],
    url: null,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    on(name, fn) {
      listeners.set(name, [...(listeners.get(name) || []), fn]);
    },
    once(name, fn) {
      this.on(name, fn);
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) || []) fn(...args);
    },
    send(channel, ...payload) {
      this.sent.push([channel, ...payload]);
    },
    setWindowOpenHandler() {},
    loadURL(url) {
      this.url = url;
    },
    insertCSS: () => Promise.resolve('k'),
    removeInsertedCSS: () => Promise.resolve(),
    openDevTools() {},
  };
}

class BrowserWindow {
  constructor(options) {
    this.options = options;
    this.webContents = fakeWebContents();
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.minimum = [options.minWidth, options.minHeight];
    this.pinned = Boolean(options.alwaysOnTop);
    this.destroyed = false;
    this.listeners = new Map();
    windows.push(this);
  }
  on(name, fn) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), fn]);
  }
  once(name, fn) {
    this.on(name, fn);
  }
  emit(name, ...args) {
    for (const fn of this.listeners.get(name) || []) fn(...args);
  }
  loadURL(url) {
    this.webContents.loadURL(url);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  close() {
    this.destroy();
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(b) {
    this.bounds = { ...this.bounds, ...b };
  }
  getMinimumSize() {
    return this.minimum;
  }
  setMinimumSize(w, h) {
    this.minimum = [w, h];
  }
  isAlwaysOnTop() {
    return this.pinned;
  }
  setAlwaysOnTop(on) {
    this.pinned = on;
  }
  showInactive() {}
  show() {}
  focus() {}
}

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

const electron = {
  app: { getLocale: () => 'ko-KR', isReady: () => true },
  ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
  shell: { openPath: () => Promise.resolve('') },
  protocol: { registerSchemesAsPrivileged() {} },
  session: {
    fromPartition(partition) {
      if (!sessions.has(partition)) {
        sessions.set(partition, {
          partition,
          handlers: new Map(),
          protocol: { handle: (scheme, fn) => sessions.get(partition).handlers.set(scheme, fn) },
          webRequest: { onBeforeRequest() {} },
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
          on() {},
        });
      }
      return sessions.get(partition);
    },
  },
  screen: { getDisplayMatching: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) },
  BrowserWindow,
  WebContentsView: class {},
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
};

function install() {
  require.cache[require.resolve('electron')] = { id: 'electron', filename: require.resolve('electron'), loaded: true, exports: electron };
}

/** Calls an IPC handler the way a page would: event.sender is the page's webContents. */
function invoke(channel, sender, ...args) {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({ sender }, ...args);
}

/**
 * Runs a preload file in a sandbox like Electron's: require('electron') gives a contextBridge that records what is
 * exposed and an ipcRenderer that records calls. Returns { exposed, invoked, listeners, setActive }.
 */
function runPreload(file, { argv = [] } = {}) {
  const exposed = {};
  const invoked = [];
  const listeners = [];
  const navigator = { userActivation: { isActive: false } };
  const ipcRenderer = {
    invoke: (channel, ...args) => {
      invoked.push([channel, ...args]);
      return Promise.resolve({ channel, args });
    },
    on: (channel, fn) => listeners.push([channel, fn]),
    removeListener: (channel, fn) => {
      const i = listeners.findIndex(([c, f]) => c === channel && f === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const sandbox = {
    require: (name) => {
      if (name !== 'electron') throw new Error(`a sandboxed preload cannot require ${name}`);
      return { contextBridge: { exposeInMainWorld: (key, value) => (exposed[key] = value) }, ipcRenderer };
    },
    process: { argv },
    navigator,
    Promise,
    TypeError,
    Error,
    JSON,
    Map,
    Set,
    String,
    Number,
    Array,
    Boolean,
    Object,
    decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: path.basename(file) });
  return {
    exposed,
    invoked,
    listeners,
    setActive: (on) => (navigator.userActivation.isActive = on),
    emit: (channel, ...args) => listeners.filter(([c]) => c === channel).forEach(([, fn]) => fn({}, ...args)),
  };
}

module.exports = { install, electron, ipcHandlers, sessions, windows, invoke, runPreload, fakeWebContents, BrowserWindow };
