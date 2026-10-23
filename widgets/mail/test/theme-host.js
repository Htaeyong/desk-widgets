// Test helper (#65): a stand-in for the engine's theme host (ctx.useThemes) that runs theme calls through the
// engine's real call rules (engine/main/theme-calls.js: allow-list, preview, user gesture, 64KB).
const { normalizeMethods, normalizeEvents, dispatch } = require('../../../engine/main/theme-calls');

const BUILTIN = [
  { id: 'default', name: '기본', usable: true },
  { id: 'compact', name: '작은 카드', usable: true },
];

function withThemeHost(ctx) {
  const th = { opts: null, host: null, emitted: [], opened: 0, closed: 0, focused: 0, reloads: 0, backgrounds: 0, pinned: null };
  ctx.useThemes = (opts) => {
    th.opts = opts;
    const table = normalizeMethods(opts.methods);
    const events = normalizeEvents(opts.events);
    th.host = {
      open: () => th.opened++,
      close: () => th.closed++,
      focus: () => {
        th.focused++;
        return true;
      },
      desktopWindows: () => [{ fake: 'theme window' }],
      emit: (name, payload) => {
        if (!events.includes(name)) return false;
        th.emitted.push([name, payload]);
        return true;
      },
      reload: () => th.reloads++,
      applyBackground: () => th.backgrounds++,
      setPinned: (on) => {
        th.pinned = Boolean(on);
        opts.store.save({ alwaysOnTop: Boolean(on) });
      },
      settingsHandlers: () => ({ themes: () => BUILTIN, previewTheme: () => null, openThemeFolder: () => null, liveOpacity: () => null }),
    };
    /** A theme page's call: activated = a click / key press just before, preview = the theme preview window. */
    th.call = (name, args = [], { activated = true, preview = false } = {}) =>
      dispatch(table, name, args, { frame: 'main', instanceId: null, preview, theme: { id: 'default', features: [] } }, { activated });
    return th.host;
  };
  return { ctx, th };
}

module.exports = { withThemeHost, BUILTIN };
