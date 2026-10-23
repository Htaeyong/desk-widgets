// Settings file shape of the clock: defaults, sanitizing and migration of older files.
// Since #60 the look comes from theme packages on the engine theme host, which keeps its own keys in this file:
// themeId, alwaysOnTop, themeBounds, themeFrames, themeOpacity.
const TM = require('./kit/timer-model');
const AM = require('./kit/alarm-model');

const DEFAULT_THEME = 'dark-glass';
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Before #60: window bounds per layout and "stopwatch/timer on" (#41, #46). The engine's keys for the same windows:
// the default theme's layout is unnamed, the analog theme has its own page (layout "analog").
const LAYOUTS = ['digital', 'analog'];
const boundsKey = (layout, tools) => (tools ? `${layout}+tools` : layout);
const BOUNDS_KEYS = LAYOUTS.flatMap((layout) => [boundsKey(layout, false), boundsKey(layout, true)]);
const THEME_BOUNDS_KEYS = { digital: 'main', 'digital+tools': 'main+tools', analog: 'analog/main', 'analog+tools': 'analog/main+tools' };

const DEFAULTS = {
  showSeconds: false,
  hour12: false,
  alwaysOnTop: false,
  themeId: DEFAULT_THEME,
  // Stopwatch / timer / alarm tabs on every theme (#46; #45 had them as a separate theme).
  tools: false,
  // Last tab, the timer's set time and presets in seconds, and the running state
  // (timestamps, so a stopwatch/timer keeps counting across a restart of the engine).
  lastTab: 'clock',
  timerSeconds: TM.DEFAULT_TIMER_SECONDS,
  timerPresets: TM.DEFAULT_PRESETS,
  stopwatch: TM.STOPWATCH,
  timer: TM.TIMER,
  // Alarms (#51) and the time up to which they were handled (a later start finds missed ones from here).
  alarms: [],
  alarmCheckedAt: null,
};

const isBounds = (b) => Boolean(b) && typeof b === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]));
const pickBounds = (b) => (isBounds(b) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null);

/**
 * The pre-#60 per-layout bounds. Before #41 the file held one bounds object, which belongs to the digital layout;
 * the #45 "multi" theme's bounds belong to digital with stopwatch/timer on.
 */
function sanitizeBounds(value) {
  const src = isBounds(value) ? { digital: value } : value && typeof value === 'object' ? value : {};
  const from = { ...src, 'digital+tools': src['digital+tools'] || src.multi };
  return Object.fromEntries(BOUNDS_KEYS.map((key) => [key, pickBounds(from[key])]));
}

/** #53 opacity { themeId: 0..100 } -> the engine's themeOpacity (same values; the engine checks them again). */
function opacityMap(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [id, n] of Object.entries(src)) {
    if (THEME_ID.test(id) && typeof n === 'number' && Number.isFinite(n)) out[id] = Math.min(100, Math.max(0, Math.round(n)));
  }
  return out;
}

function sanitize(next) {
  return {
    ...next,
    showSeconds: Boolean(next.showSeconds),
    hour12: Boolean(next.hour12),
    alwaysOnTop: Boolean(next.alwaysOnTop),
    // Any theme id: the user's own themes count too; the engine falls back to the default for an unusable one.
    themeId: typeof next.themeId === 'string' && THEME_ID.test(next.themeId) ? next.themeId : DEFAULT_THEME,
    tools: Boolean(next.tools),
    lastTab: TM.TABS.includes(next.lastTab) ? next.lastTab : 'clock',
    timerSeconds: TM.clampSeconds(next.timerSeconds, TM.DEFAULT_TIMER_SECONDS),
    timerPresets: TM.sanitizePresets(next.timerPresets),
    stopwatch: TM.sanitizeStopwatch(next.stopwatch),
    timer: TM.sanitizeTimer(next.timer),
    alarms: AM.sanitizeAlarms(next.alarms),
    alarmCheckedAt: Number.isFinite(next.alarmCheckedAt) && next.alarmCheckedAt > 0 ? next.alarmCheckedAt : null,
  };
}

/**
 * Runs on the raw file before defaults are merged.
 * - #46: the #45 theme "multi" is dark glass with stopwatch/timer on.
 * - #60 (theme host, design §6.3): opacity -> themeOpacity, windowBounds -> themeBounds, once (an existing
 *   themeBounds / themeOpacity wins). The old keys stay, so going back to an older clock still finds them.
 */
function upgrade(raw) {
  let out = raw;
  if (out.themeId === 'multi') out = { ...out, themeId: DEFAULT_THEME, tools: true };
  if (out.windowBounds !== undefined) out = { ...out, windowBounds: sanitizeBounds(out.windowBounds) };
  if (out.themeOpacity === undefined && out.opacity !== undefined) out = { ...out, themeOpacity: opacityMap(out.opacity) };
  if (out.themeBounds === undefined && out.windowBounds !== undefined) {
    const themeBounds = {};
    for (const [old, key] of Object.entries(THEME_BOUNDS_KEYS)) if (out.windowBounds[old]) themeBounds[key] = out.windowBounds[old];
    out = { ...out, themeBounds };
  }
  return out;
}

module.exports = { DEFAULTS, DEFAULT_THEME, LAYOUTS, BOUNDS_KEYS, THEME_BOUNDS_KEYS, boundsKey, sanitize, sanitizeBounds, upgrade };
