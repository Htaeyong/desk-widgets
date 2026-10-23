// Clock settings: sanitizing, and the migration of older settings files (#41, #46, #53, #60 theme host §6.3).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, DEFAULT_THEME, sanitize, sanitizeBounds, upgrade } = require('../clock-settings');

const bounds = { x: 10, y: 20, width: 300, height: 120 };
const EMPTY = { digital: null, 'digital+tools': null, analog: null, 'analog+tools': null };
/** What the engine store does when it reads the file: upgrade, then defaults under it. */
const load = (raw) => ({ ...DEFAULTS, ...upgrade(raw) });

test('alwaysOnTop is a boolean and off by default', () => {
  assert.equal(DEFAULTS.alwaysOnTop, false);
  assert.equal(sanitize({ ...DEFAULTS, alwaysOnTop: 'yes' }).alwaysOnTop, true);
  assert.equal(sanitize({ ...DEFAULTS, alwaysOnTop: 0 }).alwaysOnTop, false);
});

test('theme ids: any valid id is kept (the user may install themes), junk falls back to dark glass', () => {
  assert.equal(DEFAULT_THEME, 'dark-glass');
  assert.equal(sanitize({ ...DEFAULTS, themeId: 'analog' }).themeId, 'analog');
  assert.equal(sanitize({ ...DEFAULTS, themeId: 'my-own-theme' }).themeId, 'my-own-theme');
  assert.equal(sanitize({ ...DEFAULTS, themeId: '../x' }).themeId, DEFAULT_THEME);
  assert.equal(sanitize({ ...DEFAULTS, themeId: undefined }).themeId, DEFAULT_THEME);
});

test('the old per-layout bounds are still read (an old single windowBounds is the digital one)', () => {
  assert.deepEqual(sanitizeBounds(bounds), { ...EMPTY, digital: bounds });
  assert.deepEqual(sanitizeBounds({ digital: { x: 'a' }, analog: null }), EMPTY);
  assert.deepEqual(upgrade({ showSeconds: true }), { showSeconds: true }, 'a file without these keys is left alone');
});

test('migration table to the theme host (#60): theme, opacity, bounds; timers and alarms untouched', () => {
  const a = { x: 1, y: 2, width: 170, height: 170 };
  const b = { x: 3, y: 4, width: 230, height: 250 };
  const c = { x: 5, y: 6, width: 260, height: 200 };
  const timer = { duration: 60000, startedAt: 123, elapsed: 0, done: false };
  const alarms = [{ id: 'a1', hour: 7, minute: 30, name: '기상', days: [1], on: true, snoozeUntil: null, since: null }];
  const raw = {
    themeId: 'analog',
    tools: true,
    alwaysOnTop: true,
    lastTab: 'alarm',
    opacity: { analog: 40, light: 0, nope: 'x' },
    windowBounds: { digital: bounds, 'digital+tools': c, analog: a, 'analog+tools': b },
    timer,
    alarms,
  };
  const s = sanitize(load(raw));
  assert.equal(s.themeId, 'analog', 'same theme id');
  assert.deepEqual(s.themeOpacity, { analog: 40, light: 0 }, 'opacity -> themeOpacity');
  assert.deepEqual(s.themeBounds, { main: bounds, 'main+tools': c, 'analog/main': a, 'analog/main+tools': b });
  assert.equal(s.alwaysOnTop, true);
  assert.equal(s.tools, true);
  assert.equal(s.lastTab, 'alarm');
  assert.deepEqual(s.timer, timer);
  assert.deepEqual(s.alarms, alarms);
  // The old keys stay for an older clock.
  assert.deepEqual(s.opacity, raw.opacity);
  assert.deepEqual(s.windowBounds, raw.windowBounds);
});

test('migration runs once: the engine keys win when they exist', () => {
  const saved = { main: { x: 9, y: 9, width: 222, height: 99 } };
  const s = load({ windowBounds: { digital: bounds }, themeBounds: saved, opacity: { light: 10 }, themeOpacity: { light: 70 } });
  assert.deepEqual(s.themeBounds, saved);
  assert.deepEqual(s.themeOpacity, { light: 70 });
  // Missing old keys: nothing is made up.
  const fresh = load({ themeId: 'neon' });
  assert.equal(fresh.themeBounds, undefined);
  assert.equal(fresh.themeOpacity, undefined);
});

test('older files: a single bounds object and the #45 "multi" theme still arrive at the right keys', () => {
  assert.deepEqual(load({ windowBounds: bounds }).themeBounds, { main: bounds });
  const multi = { x: 7, y: 8, width: 260, height: 200 };
  const s = load({ themeId: 'multi', windowBounds: { digital: bounds, multi } });
  assert.equal(s.themeId, 'dark-glass');
  assert.equal(s.tools, true);
  assert.deepEqual(s.themeBounds, { main: bounds, 'main+tools': multi });
});
