// Test helper: the clock widget with a fake engine context. ctx.useThemes returns a fake theme host that records what
// the widget does with it; theme calls go through the engine's real allow-list / preview rules (theme-calls.js).
const { normalizeMethods, normalizeEvents, dispatch } = require('../../../engine/main/theme-calls');
const { DEFAULTS, sanitize } = require('../clock-settings');
const { create } = require('../index');

/**
 * A fake hidden sound window (#130): records what it was opened with; finish() is the page closing itself.
 * soundOpen: replaces it (e.g. one that throws).
 */
function fakeSoundWindows() {
  const opened = [];
  const open = (query) => {
    const listeners = [];
    const win = {
      query,
      closed: false,
      close() {
        if (win.closed) return;
        win.closed = true;
        for (const fn of listeners) fn();
      },
      onClosed: (fn) => listeners.push(fn),
      finish: () => win.close(),
    };
    opened.push(win);
    return win;
  };
  return { opened, open, live: () => opened.filter((w) => !w.closed) };
}

function setup(
  initial = {},
  { themes = [{ id: 'dark-glass', name: '다크 글래스', usable: true }, { id: 'analog', name: '아날로그', usable: true }], mcp = false, dataDir = 'x', soundOpen = null, dialog = null, exists = null } = {},
) {
  const sound = fakeSoundWindows();
  let mcpTools = null;
  const notified = [];
  const emitted = [];
  const sentToSettings = [];
  const calls = { open: 0, close: 0, reload: 0, applyVariant: 0, applyBackground: 0, pinned: [], live: [] };
  let state = sanitize({ ...DEFAULTS, ...initial });
  let opts = null;
  let storeSync = null;
  const host = {
    open: () => calls.open++,
    close: () => calls.close++,
    reload: () => calls.reload++,
    applyVariant: () => calls.applyVariant++,
    applyBackground: () => calls.applyBackground++,
    setPinned: (on) => {
      calls.pinned.push(on);
      state = sanitize({ ...state, alwaysOnTop: on });
    },
    setLiveOpacity: (id, value) => calls.live.push([id, value]),
    emit: (name, payload) => {
      if (!opts.events.includes(name)) return false;
      emitted.push([name, payload]);
      return true;
    },
    focus: () => true,
    desktopWindows: () => [],
    settingsHandlers: () => ({ themes: () => themes, previewTheme() {}, openThemeFolder() {}, liveOpacity() {} }),
  };
  const ctx = {
    dir: `${__dirname}/..`,
    dataDir,
    createStore: (options) => {
      storeSync = options.sync;
      return { load: () => state, save: (v) => { state = sanitize({ ...state, ...v }); } };
    },
    useThemes: (o) => {
      opts = { ...o, methodTable: normalizeMethods(o.methods), events: normalizeEvents(o.events) };
      return host;
    },
    notify: (events, options) => notified.push({ events, options }),
    sendToSettings: (...a) => sentToSettings.push(a),
    // ctx.mcp (engine API 1.10, #121): the declared tools, called directly by the tests
    ...(mcp ? { mcp: { registerTools: (tools) => ((mcpTools = tools), true) } } : {}),
  };
  const widget = create(ctx, { openSoundWindow: soundOpen || sound.open, ...(dialog ? { dialog } : {}), ...(exists ? { exists } : {}) });
  widget.start();
  const entry = (preview) => ({ frame: 'main', instanceId: null, preview, theme: { id: state.themeId, features: ['tools'] } });
  /** A call from a theme page, as the engine routes it. */
  const call = (name, ...args) => dispatch(opts.methodTable, name, args, entry(false));
  const previewCall = (name, ...args) => dispatch(opts.methodTable, name, args, entry(true));
  const lastEmitted = (name) => emitted.filter((e) => e[0] === name).at(-1)?.[1];
  return { widget, opts: () => opts, host, calls, call, previewCall, notified, emitted, lastEmitted, sentToSettings, getState: () => state, storeSync, mcpTools: () => mcpTools, sound };
}

module.exports = { setup };
