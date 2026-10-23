// Stopwatch / timer math, presets, the stopwatch/timer setting (#46), and the timer alarm in the widget's main code (#45).
const test = require('node:test');
const assert = require('node:assert/strict');
const TM = require('../kit/timer-model');
const { DEFAULTS, BOUNDS_KEYS, boundsKey, sanitize, sanitizeBounds, upgrade } = require('../clock-settings');
const { setup } = require('./fake-host');

test('stopwatch: start, pause, resume and reset add up the running spans', () => {
  let sw = TM.swReset();
  assert.equal(TM.swElapsed(sw, 5000), 0);
  sw = TM.swStart(sw, 1000);
  assert.equal(TM.swElapsed(sw, 3500), 2500);
  assert.equal(TM.swStart(sw, 3000), sw, 'starting a running stopwatch changes nothing');
  sw = TM.swPause(sw, 4000);
  assert.deepEqual(sw, { startedAt: null, elapsed: 3000 });
  assert.equal(TM.swElapsed(sw, 99999), 3000, 'paused time does not count');
  sw = TM.swStart(sw, 10000);
  assert.equal(TM.swElapsed(sw, 10500), 3500);
  assert.deepEqual(TM.swReset(), { startedAt: null, elapsed: 0 });
});

test('timer: remaining time, pause/resume, end detection and reset', () => {
  let t = TM.tmStart(TM.TIMER, 1000, 60);
  assert.equal(TM.tmStatus(t), 'running');
  assert.equal(TM.tmRemaining(t, 1000), 60000);
  assert.equal(TM.tmRemaining(t, 21000), 40000);
  t = TM.tmPause(t, 21000);
  assert.equal(TM.tmStatus(t), 'paused');
  assert.equal(TM.tmRemaining(t, 999999), 40000);
  t = TM.tmStart(t, 50000, 5); // resume ignores the given seconds
  assert.equal(t.duration, 60000);
  assert.equal(TM.tmIsOver(t, 89999), false);
  assert.equal(TM.tmIsOver(t, 90000), true);
  assert.equal(TM.tmRemaining(t, 120000), 0);
  t = TM.tmFinish(t);
  assert.equal(TM.tmStatus(t), 'done');
  assert.equal(TM.tmIsOver(t, 200000), false);
  assert.equal(TM.tmStatus(TM.tmStart(t, 1, 10)), 'running', 'a finished timer starts again');
  t = TM.tmReset(t);
  assert.equal(TM.tmStatus(t), 'idle');
  assert.equal(TM.tmRemaining(t, 0), 60000);
});

test('display texts', () => {
  assert.equal(TM.formatStopwatch(0), '00:00.00');
  assert.equal(TM.formatStopwatch(61234), '01:01.23');
  assert.equal(TM.formatStopwatch(3723450), '1:02:03.45');
  assert.equal(TM.formatRemaining(300000), '05:00');
  assert.equal(TM.formatRemaining(299001), '05:00', 'rounds up to the second');
  assert.equal(TM.formatRemaining(3661000), '1:01:01');
  assert.equal(TM.formatDuration(180), '3분');
  assert.equal(TM.formatDuration(90), '1분 30초');
  assert.equal(TM.formatDuration(3600), '1시간');
  assert.equal(TM.formatDuration(3605), '1시간 5초');
});

test('time input fields: two digits while typing, clamped and zero-padded after (#51)', () => {
  assert.equal(TM.typedDigits('123'), '12');
  assert.equal(TM.typedDigits('7a-'), '7');
  assert.equal(TM.typedDigits('e5.9'), '59');
  assert.equal(TM.typedDigits(''), '');
  assert.equal(TM.typedDigits(undefined), '');
  assert.equal(TM.fieldValue('99', 23), 23);
  assert.equal(TM.fieldValue('075', 59), 7, 'only the first two digits count');
  assert.equal(TM.fieldValue('', 59), 0);
  assert.equal(TM.fieldValue('x', 59), 0);
  assert.equal(TM.fieldText('7', 23), '07');
  assert.equal(TM.fieldText('60', 59), '59');
  assert.equal(TM.fieldText('', 23), '00');
});

test('tab badges (#50): dot state and short time, nothing when idle or finished', () => {
  assert.equal(TM.formatShort(5), '0:05');
  assert.equal(TM.formatShort(754), '12:34');
  assert.equal(TM.formatShort(3723), '1:02:03');
  assert.equal(TM.swBadge(TM.swReset(), 1000), null);
  const sw = TM.swStart(TM.swReset(), 1000);
  assert.deepEqual(TM.swBadge(sw, 1000 + 754900), { state: 'running', text: '12:34' });
  assert.deepEqual(TM.swBadge(TM.swPause(sw, 4500), 99999), { state: 'paused', text: '0:03' });
  assert.equal(TM.tmBadge(TM.TIMER, 0), null);
  const t = TM.tmStart(TM.TIMER, 0, 3723);
  assert.deepEqual(TM.tmBadge(t, 500), { state: 'running', text: '1:02:03' }, 'rounded up like the timer screen');
  assert.deepEqual(TM.tmBadge(TM.tmPause(t, 3000), 50000), { state: 'paused', text: '1:02:00' });
  assert.equal(TM.tmBadge(TM.tmFinish(t), 0), null);
});

test('tab badges redraw only when their text changes', () => {
  const sw = TM.swStart(TM.swReset(), 1000);
  const t = TM.tmStart(TM.TIMER, 0, 60);
  assert.equal(TM.badgeDelay(TM.swReset(), TM.TIMER, 5000), null, 'nothing running: no redraw');
  assert.equal(TM.badgeDelay(sw, TM.TIMER, 1300), 700);
  assert.equal(TM.badgeDelay(TM.swReset(), t, 200), 800);
  assert.equal(TM.badgeDelay(sw, t, 1200), 800);
  assert.equal(TM.badgeDelay(TM.swReset(), t, 1000), 1000, 'never 0');
  assert.equal(TM.badgeDelay(TM.swPause(sw, 2000), TM.tmPause(t, 3000), 9000), null, 'paused badges are static');
});

test('presets are three slots within 1s..23:59:59', () => {
  assert.deepEqual(TM.sanitizePresets(undefined), [180, 300, 600]);
  assert.deepEqual(TM.sanitizePresets([60, 'x', 999999, 4]), [60, 300, TM.MAX_SECONDS]);
  assert.deepEqual(TM.sanitizePresets([0, -5, 1.4]), [1, 1, 1]);
  assert.equal(TM.MAX_SECONDS, 86399);
});

test('stopwatch/timer settings are sanitized and off by default', () => {
  assert.equal(DEFAULTS.tools, false);
  const s = sanitize({ ...DEFAULTS, tools: 'yes', lastTab: 'nope', timerSeconds: 0, timerPresets: [1], stopwatch: { startedAt: 'x' }, timer: null });
  assert.equal(s.tools, true);
  assert.equal(s.lastTab, 'clock');
  assert.equal(s.timerSeconds, 1);
  assert.deepEqual(s.timerPresets, [1, 300, 600]);
  assert.deepEqual(s.stopwatch, { startedAt: null, elapsed: 0 });
  assert.deepEqual(s.timer, TM.TIMER);
  assert.equal(sanitize({ ...DEFAULTS, lastTab: 'timer' }).lastTab, 'timer');
});

test('bounds keys: layout, plus "+tools" while the tabs are on', () => {
  assert.equal(boundsKey('digital', false), 'digital');
  assert.equal(boundsKey('digital', true), 'digital+tools');
  assert.equal(boundsKey('analog', true), 'analog+tools');
  assert.deepEqual(BOUNDS_KEYS, ['digital', 'digital+tools', 'analog', 'analog+tools']);
});

test('a settings file from before #45 gets the new keys, stopwatch/timer off', () => {
  const bounds = { x: 1, y: 2, width: 220, height: 96 };
  const old = upgrade({ showSeconds: true, themeId: 'analog', windowBounds: { digital: bounds, analog: null } });
  const s = sanitize({ ...DEFAULTS, ...old });
  assert.deepEqual(s.windowBounds, { digital: bounds, 'digital+tools': null, analog: null, 'analog+tools': null });
  assert.equal(s.themeId, 'analog');
  assert.equal(s.tools, false);
  assert.equal(s.lastTab, 'clock');
  assert.deepEqual(s.timerPresets, [180, 300, 600]);
  assert.equal(s.timerSeconds, 300);
});

test('the #45 "multi" theme becomes dark glass with stopwatch/timer on, its bounds become digital+tools', () => {
  const digital = { x: 1, y: 2, width: 220, height: 96 };
  const multi = { x: 5, y: 6, width: 260, height: 200 };
  const timer = { duration: 60000, startedAt: 123, elapsed: 0, done: false };
  const old = upgrade({ themeId: 'multi', lastTab: 'timer', timer, windowBounds: { digital, analog: null, multi } });
  assert.equal(old.themeId, 'dark-glass');
  assert.equal(old.tools, true);
  assert.deepEqual(old.windowBounds, { digital, 'digital+tools': multi, analog: null, 'analog+tools': null });
  const s = sanitize({ ...DEFAULTS, ...old });
  assert.equal(s.lastTab, 'timer');
  assert.deepEqual(s.timer, timer, 'a running timer is kept');
  // Saved digital+tools bounds win over leftover multi bounds.
  assert.deepEqual(sanitizeBounds({ 'digital+tools': digital, multi })['digital+tools'], digital);
  assert.equal(upgrade({ themeId: 'neon', tools: false }).tools, false);
});

// ---- the widget's main code, called the way a theme calls it (clock theme contract v1, #60) ----

test('theme calls change the saved state and the themes get it', async (t) => {
  const { widget, call, lastEmitted, getState } = setup({ tools: true });
  t.after(() => widget.stop());
  assert.deepEqual(await call('stopwatch.start'), { ok: true });
  assert.equal(TM.swRunning(getState().stopwatch), true);
  assert.equal(TM.swRunning(lastEmitted('timers').stopwatch), true);
  await call('timer.start', 90);
  assert.equal(getState().timer.duration, 90000);
  assert.equal(getState().timerSeconds, 90);
  await call('timer.start', 30); // already running: ignored
  assert.equal(getState().timer.duration, 90000);
  await call('timer.savePreset', 1, 45);
  assert.deepEqual(getState().timerPresets, [180, 45, 600]);
  await call('timer.usePreset', 2);
  assert.equal(getState().timer.duration, 600000);
  await call('timer.usePreset', 'constructor');
  assert.equal(getState().timer.duration, 600000, 'only slot numbers');
  await call('setTab', 'timer');
  assert.equal(getState().lastTab, 'timer');
  assert.equal(lastEmitted('settings').lastTab, 'timer');
  await call('setTab', 'bogus');
  assert.equal(getState().lastTab, 'timer');
  const state = await call('getState');
  assert.equal(state.ok, true);
  assert.deepEqual(Object.keys(state.result).sort(), ['settings', 'timers']);
  assert.deepEqual(Object.keys(state.result.settings).sort(), ['alwaysOnTop', 'hour12', 'lastTab', 'locale', 'showSeconds', 'tools']);
});

test('the theme API is an allow-list: undeclared calls and events are refused', async (t) => {
  const { widget, call, opts, host, getState } = setup();
  t.after(() => widget.stop());
  const names = Object.keys(opts().methods).sort();
  assert.deepEqual(names, [
    'alarms.add', 'alarms.edit', 'alarms.remove', 'alarms.toggle',
    'getState', 'setTab',
    'stopwatch.pause', 'stopwatch.reset', 'stopwatch.start',
    'timer.pause', 'timer.reset', 'timer.savePreset', 'timer.set', 'timer.start', 'timer.usePreset',
  ]);
  assert.deepEqual(opts().events, ['settings', 'timers']);
  const res = await call('settings.save', { themeId: 'x' });
  assert.equal(res.ok, false);
  assert.equal((await call('openUrl', 'https://example.com')).ok, false);
  assert.equal(host.emit('secret', {}), false);
  assert.equal(getState().themeId, 'dark-glass');
});

test('the preview reads the state but its buttons do nothing and alarm changes are refused', async (t) => {
  const { widget, previewCall, getState } = setup({ tools: true });
  t.after(() => widget.stop());
  assert.equal((await previewCall('getState')).ok, true);
  assert.equal(await previewCall('stopwatch.start'), null);
  assert.equal(await previewCall('timer.start', 60), null);
  assert.equal(await previewCall('timer.savePreset', 0, 10), null);
  assert.equal(await previewCall('setTab', 'alarm'), null);
  const add = await previewCall('alarms.add', { hour: 7, minute: 0, name: '', days: [] });
  assert.equal(add.ok, false);
  assert.equal(TM.swRunning(getState().stopwatch), false);
  assert.equal(TM.tmStatus(getState().timer), 'idle');
  assert.deepEqual(getState().timerPresets, [180, 300, 600]);
  assert.equal(getState().lastTab, 'clock');
  assert.deepEqual(getState().alarms, []);
});

test('a timer that ran out while the engine was off rings on start; 다시 시작 restarts the same time', (t) => {
  const timer = { duration: 120000, startedAt: Date.now() - 200000, elapsed: 0, done: false };
  const { widget, notified, getState } = setup({ timer });
  t.after(() => widget.stop());
  assert.equal(notified.length, 1);
  const [card] = notified[0].events;
  assert.equal(card.type, 'card');
  assert.equal(card.title, '타이머 종료');
  assert.equal(card.body, '2분 타이머가 끝났습니다');
  assert.equal(card.tag, 'clock-timer');
  assert.equal(card.sticky, true);
  assert.equal(card.sound, true);
  assert.deepEqual(card.actions, [{ id: 'restart', label: '다시 시작' }]);
  assert.equal(TM.tmStatus(getState().timer), 'done');
  notified[0].options.onAction(card, 'restart');
  assert.equal(TM.tmStatus(getState().timer), 'running');
  assert.equal(getState().timer.duration, 120000);
});

test('stopping the widget cancels the timer timeout and closes the theme windows; a running timer survives', async () => {
  const { widget, call, notified, calls, getState } = setup();
  assert.equal(calls.open, 1);
  await call('timer.start', 1);
  widget.stop();
  assert.equal(calls.close, 1);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(notified.length, 0);
  assert.equal(TM.tmRunning(getState().timer), true);
});

test('the menu and the settings window: stopwatch/timer switches the window size variant and keeps a running timer', async (t) => {
  const { widget, call, opts, calls, lastEmitted, getState } = setup({ tools: false });
  t.after(() => widget.stop());
  await call('timer.start', 60);
  assert.equal(opts().variant(), null);
  const items = opts().menuItems({ frame: 'main' });
  const tools = items.find((i) => i.label === '스톱워치·타이머 사용');
  assert.equal(tools.checked, false);
  assert.deepEqual(items.find((i) => i.label === '테마').submenu.map((x) => x.label), ['다크 글래스', '아날로그']);
  tools.click({ checked: true });
  assert.equal(getState().tools, true);
  assert.equal(opts().variant(), 'tools');
  assert.equal(calls.applyVariant, 1);
  assert.equal(lastEmitted('settings').tools, true);
  widget.settings.save({ ...widget.settings.get(), tools: false });
  assert.equal(getState().tools, false);
  assert.equal(calls.applyVariant, 2);
  assert.equal(TM.tmStatus(getState().timer), 'running', 'the setting does not reset the timer');
  items.find((i) => i.label === '항상 위에 표시').click({ checked: true });
  assert.deepEqual(calls.pinned, [true]);
});

test('saving a theme and opacities from the engine theme section reloads and repaints', (t) => {
  const { widget, calls, getState } = setup();
  t.after(() => widget.stop());
  const base = widget.settings.get();
  assert.equal(base.themeId, 'dark-glass');
  assert.deepEqual(base.themeOpacity, {});
  widget.settings.save({ ...base, themeId: 'analog', themeOpacity: { analog: 40 } });
  assert.equal(getState().themeId, 'analog');
  assert.deepEqual(getState().themeOpacity, { analog: 40 });
  assert.equal(calls.reload, 1);
  assert.equal(calls.applyBackground, 1);
  assert.deepEqual(calls.live.at(-1), [null, null], 'a dragged value ends at save');
  // A save without the theme section keeps the stored theme and opacities.
  widget.settings.save({ showSeconds: true, hour12: false, alwaysOnTop: false, tools: false });
  assert.equal(getState().themeId, 'analog');
  assert.deepEqual(getState().themeOpacity, { analog: 40 });
  assert.equal(calls.reload, 1);
});

test('the clock widget asks for engine API 1.3, declares the clock theme contract and keeps version 1.0.0', () => {
  const manifest = require('../widget.json');
  assert.equal(manifest.engineApi, '1.3');
  assert.equal(manifest.version, '1.0.0');
  assert.deepEqual(manifest.themes, { contract: 'clock', contractVersions: [1], default: 'dark-glass' });
});
