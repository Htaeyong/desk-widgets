// Test helper (#61): a stand-in for the engine's theme host (ctx.useThemes) that runs theme calls through the
// engine's real call rules (engine/main/theme-calls.js: allow-list, preview, user gesture, 64KB), so the
// widget's theme contract is tested the way a theme page reaches it.
const { normalizeMethods, normalizeEvents, dispatch } = require('../../../engine/main/theme-calls');

const BUILTIN = [
  { id: 'default', name: '기본', usable: true },
  { id: 'big', name: '큰 달력', usable: true },
];

/** Adds useThemes to a ctx; returns { ctx, th } where th.host / th.call / th.theme are ready after create(). */
function withThemeHost(ctx) {
  const th = { opts: null, host: null, emitted: [], live: [], reloads: 0, backgrounds: 0, opened: 0, closed: 0, focused: 0, pinned: null };
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
      settingsHandlers: () => ({
        themes: () => BUILTIN,
        previewTheme: () => null,
        openThemeFolder: () => null,
        liveOpacity: (id, value) => th.live.push([id, value]),
      }),
    };
    /** A theme page's call: activated = a click / key press just before, preview = the theme preview window. */
    th.call = (name, args = [], { activated = true, preview = false } = {}) =>
      dispatch(table, name, args, { frame: 'main', instanceId: null, preview, theme: { id: 'default', features: ['edit'] } }, { activated });
    th.theme = {
      get: () => th.call('getState'),
      /** { grid, upcoming } -> { grid, upcoming } through events.list (like the built-in themes' page). */
      events: async (ranges) => {
        const res = await th.call('events.list', [[ranges.grid, ranges.upcoming]]);
        return Array.isArray(res) ? { grid: res[0] || [], upcoming: res[1] || [] } : res;
      },
      save: (req, opts2) =>
        req.uid
          ? th.call('events.update', [{ sourceId: req.sourceId, calendarId: req.calendarId, uid: req.uid }, req.fields], opts2)
          : th.call('events.create', [{ sourceId: req.sourceId, calendarId: req.calendarId }, req.fields], opts2),
      remove: (req, opts2) => th.call('events.remove', [{ sourceId: req.sourceId, calendarId: req.calendarId, uid: req.uid }], opts2),
      openLink: (t, opts2) => th.call('events.openLink', [t], opts2),
      menu: () => th.opts.menuItems({ frame: 'main', preview: false }),
    };
    return th.host;
  };
  return { ctx, th };
}

module.exports = { withThemeHost, BUILTIN };
