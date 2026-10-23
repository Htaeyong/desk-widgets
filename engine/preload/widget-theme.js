// window.widget: the theme API of a widget with its own theme contract (#57). Dooray themes keep window.dooray
// (theme.js). The widget's methods and events arrive as --widget-theme-api (set by the engine), so the theme gets
// exactly what the widget declared; the engine checks every call again.
const { contextBridge, ipcRenderer } = require('electron');

function declared() {
  const arg = (process.argv || []).find((a) => a.startsWith('--widget-theme-api='));
  try {
    const spec = JSON.parse(decodeURIComponent(arg.slice('--widget-theme-api='.length)));
    return { methods: Array.isArray(spec.methods) ? spec.methods : [], events: Array.isArray(spec.events) ? spec.events : [] };
  } catch {
    return { methods: [], events: [] };
  }
}

const spec = declared();
const gestureNeeded = new Map(spec.methods.map((m) => [String(m.name), m.gesture === true]));
const events = new Set(spec.events.map(String));

// A user gesture is a click or key press just before the call; theme code cannot fake it (#57, calendar writes).
const activated = () => Boolean(globalThis.navigator?.userActivation?.isActive);

function call(name, ...args) {
  const key = String(name);
  if (!gestureNeeded.has(key)) return Promise.resolve({ ok: false, message: `지원하지 않는 호출입니다: ${key.slice(0, 64)}` });
  const gesture = activated();
  if (gestureNeeded.get(key) && !gesture) return Promise.resolve({ ok: false, message: '클릭이나 키 입력으로만 할 수 있습니다.' });
  return ipcRenderer.invoke('widget-theme:call', key, args, gesture);
}

// 'timer.start' -> api.timer.start(...)
const api = {};
for (const name of gestureNeeded.keys()) {
  const parts = name.split('.');
  let node = api;
  for (const part of parts.slice(0, -1)) node = node[part] = node[part] || {};
  node[parts.at(-1)] = (...args) => call(name, ...args);
}

const windowCall = (action, ...args) => ipcRenderer.invoke('widget-theme:window', action, ...args);

contextBridge.exposeInMainWorld('widget', {
  apiVersion: 1,
  getContext: () => ipcRenderer.invoke('widget-theme:context'),
  api,
  call,
  /** Subscribes to an event the widget declared. Returns an unsubscribe function. */
  on: (name, callback) => {
    if (typeof callback !== 'function') throw new TypeError('on requires a function');
    const wanted = String(name);
    if (!events.has(wanted)) throw new Error(`unknown event: ${wanted.slice(0, 64)}`);
    const listener = (_e, event, payload) => {
      if (event === wanted) callback(payload);
    };
    ipcRenderer.on('widget-theme:event', listener);
    return () => ipcRenderer.removeListener('widget-theme:event', listener);
  },
  /** Background opacity changes (#55): callback({ opacity }) with 0..1. The --theme-bg-alpha CSS variable is set either way. */
  onBackground: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onBackground requires a function');
    const listener = (_e, background) => callback(background);
    ipcRenderer.on('theme:background', listener);
    return () => ipcRenderer.removeListener('theme:background', listener);
  },
  openSettings: () => ipcRenderer.invoke('widget-theme:open-settings'),
  window: {
    /** Main window: turns the widget off. Another window: closes it. Preview: closes the preview. */
    close: () => windowCall('close'),
    togglePin: () => windowCall('toggle-pin'),
    getState: () => windowCall('state'),
    setSize: (width, height) => windowCall('set-size', Number(width), Number(height)),
    /** The right-click menu (the widget's items, then settings / widget manager / turn off / quit). */
    openMenu: () => windowCall('menu'),
  },
});
