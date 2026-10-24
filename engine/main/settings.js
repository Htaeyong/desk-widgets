// Engine-wide settings in <userData>/settings.json. Each widget keeps its own settings
// under <userData>/widgets/<id>/ (see engine/main/widgets.js).
const path = require('path');
const { app } = require('electron');
const { createStore, clampInt } = require('./store');

const DEFAULTS = {
  // How widgets survive "Show desktop" (Win+D): 'anchor' (desktop-owned), 'raise' (re-show), 'off'
  desktopMode: 'anchor',
  launchAtStartup: false,
  // Stop polling after this many minutes without input (0 = never). Lock/suspend always pause.
  idleMinutes: 5,
  // Notification cards (what a widget notifies about is that widget's own setting)
  notifyDurationSec: 0, // 0 = stay until the user confirms
  notifyMaxVisible: 3,
  // Look for new engine/widget versions at startup and once a day (#104); installing is always the user's click
  updateCheck: true,
  // Widget on/off: { [widgetId]: { enabled } }; a widget missing here uses its manifest default
  widgets: {},
  // Set once the settings of the old "Dooray Widget" app were copied in (see migrate.js)
  migratedFrom: null,
};

const LIMITS = { MAX_IDLE_MINUTES: 240, MAX_NOTIFY_SEC: 3600, MAX_NOTIFY_VISIBLE: 10 };

function sanitize(next) {
  return {
    ...next,
    desktopMode: ['anchor', 'raise', 'off'].includes(next.desktopMode) ? next.desktopMode : DEFAULTS.desktopMode,
    launchAtStartup: Boolean(next.launchAtStartup),
    updateCheck: next.updateCheck !== false,
    idleMinutes: clampInt(next.idleMinutes, 0, LIMITS.MAX_IDLE_MINUTES, DEFAULTS.idleMinutes),
    notifyDurationSec: clampInt(next.notifyDurationSec, 0, LIMITS.MAX_NOTIFY_SEC, 0),
    notifyMaxVisible: clampInt(next.notifyMaxVisible, 1, LIMITS.MAX_NOTIFY_VISIBLE, DEFAULTS.notifyMaxVisible),
    widgets: Object.fromEntries(
      Object.entries(next.widgets || {})
        .filter(([id]) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
        .map(([id, w]) => [id, { enabled: Boolean(w?.enabled) }])
    ),
  };
}

const store = createStore({ file: () => path.join(app.getPath('userData'), 'settings.json'), defaults: DEFAULTS, sanitize });

module.exports = { ...store, DEFAULTS, LIMITS };
