// Alarms (#51): next ring time, snooze, one-time alarms, missed alarms, sanitize, and ringing from the widget's main code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpec, sharedPart } = require('../../../engine/main/sync-store');
const AM = require('../kit/alarm-model');
const { DEFAULTS, sanitize } = require('../clock-settings');
const { setup } = require('./fake-host');

// Local wall-clock times. 2026-10-18 is a Sunday (getDay 0), 10-19 a Monday.
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m, 0, 0).getTime();
const alarm = (over = {}) => ({ id: 'a1', hour: 7, minute: 30, name: '기상', days: [], on: true, snoozeUntil: null, since: null, ...over });
const MIN = 60 * 1000;

test('sync omits this PC\'s alarm snooze, timer state, window state, and alarm check time', (t) => {
  const h = setup();
  t.after(() => h.widget.stop());
  const spec = h.storeSync;
  assert.deepEqual(sharedPart(alarm({ snoozeUntil: 123, since: 456 }), normalizeSpec(spec).collections.alarms), {
    id: 'a1', hour: 7, minute: 30, name: '기상', days: [], on: true,
  });
  for (const key of ['stopwatch', 'timer', 'alarmCheckedAt', 'lastTab', 'alwaysOnTop', 'themeBounds']) {
    assert.ok(!spec.shared.includes(key), key);
  }
});

test('sanitize: valid fields kept, bad ones dropped, at most 20, unique ids', () => {
  assert.deepEqual(AM.sanitizeAlarm(alarm({ days: [5, 1, 1, 9, 'x'], name: '  일이삼사오육칠팔구십일이삼사오육칠팔구십넘침  ' })), {
    ...alarm(),
    days: [1, 5],
    name: '일이삼사오육칠팔구십일이삼사오육칠팔구십',
  });
  assert.equal(AM.sanitizeAlarm(alarm({ hour: 24 })), null);
  assert.equal(AM.sanitizeAlarm(alarm({ minute: 1.5 })), null);
  assert.equal(AM.sanitizeAlarm(alarm({ id: '../x' })), null);
  assert.equal(AM.sanitizeAlarm(alarm({ on: undefined })).on, true);
  assert.equal(AM.sanitizeAlarm(alarm({ on: false })).on, false);
  const many = Array.from({ length: 25 }, (_, i) => alarm({ id: `a${i}` }));
  assert.equal(AM.sanitizeAlarms(many).length, AM.MAX_ALARMS);
  assert.deepEqual(AM.sanitizeAlarms([alarm(), alarm({ hour: 8 }), null, 'x']).map((a) => a.hour), [7]);
  assert.deepEqual(AM.sanitizeAlarms(undefined), []);
  assert.deepEqual(sanitize({ ...DEFAULTS, alarms: [alarm(), { id: 'bad' }] }).alarms, [alarm()]);
  assert.equal(sanitize({ ...DEFAULTS, alarmCheckedAt: 'x' }).alarmCheckedAt, null);
});

test('next time: once (today or tomorrow), weekdays, midnight wrap, off', () => {
  assert.equal(AM.nextOccurrence(alarm(), at(19, 6)), at(19, 7, 30), 'later today');
  assert.equal(AM.nextOccurrence(alarm(), at(19, 8)), at(20, 7, 30), 'past time today: tomorrow');
  assert.equal(AM.nextOccurrence(alarm(), at(19, 7, 30)), at(20, 7, 30), 'exactly now counts as passed');
  assert.equal(AM.nextOccurrence(alarm({ hour: 0, minute: 5 }), at(19, 23, 59)), at(20, 0, 5), 'midnight wrap');
  const weekdays = alarm({ days: [1, 2, 3, 4, 5] });
  assert.equal(AM.nextOccurrence(weekdays, at(17, 9)), at(19, 7, 30), 'Saturday -> Monday');
  assert.equal(AM.nextOccurrence(alarm({ days: [0] }), at(18, 8)), at(25, 7, 30), 'Sunday after the time -> next Sunday');
  assert.equal(AM.nextOccurrence(alarm({ on: false }), at(19, 6)), null);
  assert.equal(AM.nextOccurrence(alarm({ since: at(19, 7, 31) }), at(19, 6)), at(20, 7, 30), 'nothing before it was set');
  // Local time: the alarm hour is the local hour of the result.
  assert.equal(new Date(AM.nextOccurrence(alarm({ hour: 23, minute: 59 }), at(19, 0))).getHours(), 23);
});

test('snooze rings 5 minutes later, once, and comes before the regular time', () => {
  const s = AM.snooze(alarm({ days: [1] }), at(19, 7, 30));
  assert.equal(s.snoozeUntil, at(19, 7, 35));
  assert.equal(AM.nextDue(s, at(19, 7, 31)), at(19, 7, 35));
  const r = AM.processDue([s], at(19, 7, 34), at(19, 7, 35));
  assert.equal(r.ring.length, 1);
  assert.equal(r.ring[0].snooze, true);
  assert.equal(r.alarms[0].snoozeUntil, null, 'used up');
  assert.equal(AM.nextDue(r.alarms[0], at(19, 7, 36)), at(26, 7, 30), 'then the next Monday');
});

test('a one-time alarm turns itself off after ringing; its snooze still rings once', () => {
  const r = AM.processDue([alarm()], at(19, 7, 29), at(19, 7, 30));
  assert.equal(r.ring.length, 1);
  assert.equal(r.alarms[0].on, false);
  assert.equal(AM.nextDue(r.alarms[0], at(19, 7, 31)), null);
  const snoozed = AM.snooze(r.alarms[0], at(19, 7, 31));
  assert.equal(AM.nextDue(snoozed, at(19, 7, 32)), at(19, 7, 36));
  const r2 = AM.processDue([snoozed], at(19, 7, 32), at(19, 7, 36));
  assert.equal(r2.ring.length, 1);
  assert.equal(AM.nextDue(r2.alarms[0], at(19, 7, 37)), null);
  // A repeating alarm stays on.
  assert.equal(AM.processDue([alarm({ days: [1] })], at(19, 7), at(19, 7, 30)).alarms[0].on, true);
});

test('missed alarms: older than the grace go into one list, only from the last 12 hours, no repeats', () => {
  const daily = alarm({ id: 'd', days: [0, 1, 2, 3, 4, 5, 6], hour: 22, minute: 0, name: '약' });
  const once = alarm({ id: 'o', hour: 6, minute: 0, name: '' });
  const late = alarm({ id: 'l', hour: 9, minute: 0, name: '회의', days: [1] });
  // Engine off from Sunday 20:00 to Monday 09:01.
  const r = AM.processDue([daily, once, late], at(18, 20), at(19, 9, 1));
  assert.deepEqual(r.ring.map((h) => h.id), ['l'], 'due a minute ago: rings');
  assert.deepEqual(r.missed.map((h) => h.id), ['d', 'o'], 'sorted by time');
  assert.equal(AM.missedText(r.missed), '22:00 약, 06:00');
  assert.equal(r.alarms.find((a) => a.id === 'o').on, false);
  // Off for two days: only the last 12 hours are reported, but the one-time alarm still turns off.
  const r2 = AM.processDue([daily, alarm({ id: 'o2', hour: 6 })], at(17, 8), at(19, 9));
  assert.deepEqual(r2.missed.map((h) => h.at), [at(18, 22)]);
  assert.equal(r2.alarms[1].on, false);
  assert.ok(AM.GRACE_MS <= 2 * MIN);
});

test('texts and the alarm tab badge', () => {
  assert.equal(AM.daysText([]), '한 번');
  assert.equal(AM.daysText([0, 1, 2, 3, 4, 5, 6]), '매일');
  assert.equal(AM.daysText([1, 2, 3, 4, 5]), '평일');
  assert.equal(AM.daysText([0, 6]), '주말');
  assert.equal(AM.daysText([0, 1, 3]), '월·수·일');
  assert.equal(AM.ringText({ hour: 7, minute: 5, name: '' }), '07:05');
  assert.deepEqual(AM.alarmBadge([alarm(), alarm({ id: 'b', hour: 6, minute: 0 })], at(19, 5)), { state: 'next', text: '⏰ 06:00' });
  assert.equal(AM.alarmBadge([alarm({ on: false })], at(19, 5)), null);
});

// ---- the widget's main code, called the way a theme calls it (#60) ----

test('add, edit, toggle and delete from the alarm tab; bad values and unknown ids are refused', async (t) => {
  const { widget, call, lastEmitted, getState } = setup();
  t.after(() => widget.stop());
  const added = await call('alarms.add', { hour: 7, minute: 30, name: '기상', days: [1, 2] });
  assert.equal(added.ok, true);
  const [a] = getState().alarms;
  assert.equal(added.id, a.id);
  assert.equal(a.on, true);
  assert.ok(a.since > 0);
  assert.ok(lastEmitted('timers').alarms[0].next > Date.now(), 'the themes get the next ring time');
  assert.deepEqual(await call('alarms.edit', a.id, { hour: 8, minute: 0, name: '', days: [] }), { ok: true });
  assert.deepEqual([getState().alarms[0].hour, getState().alarms[0].name], [8, '']);
  assert.equal((await call('alarms.edit', a.id, { hour: 25, minute: 0 })).ok, false);
  assert.equal(getState().alarms[0].hour, 8);
  assert.deepEqual(await call('alarms.toggle', a.id, false), { ok: true });
  assert.equal(getState().alarms[0].on, false);
  assert.equal((await call('alarms.add', { hour: 'x', minute: 0 })).ok, false);
  assert.equal((await call('alarms.remove', 'nope')).ok, false);
  assert.deepEqual(await call('alarms.remove', a.id), { ok: true });
  assert.deepEqual(getState().alarms, []);
});

test('alarms due while the engine was off: one 놓친 알람 card without sound; a just-due one rings with snooze / off', (t) => {
  const now = Date.now();
  const d = new Date(now - 3 * 3600 * 1000);
  const missed = { id: 'm', hour: d.getHours(), minute: d.getMinutes(), name: '점심', days: [], on: true, snoozeUntil: null, since: null };
  const soon = { ...missed, id: 's', name: '회의', snoozeUntil: now - 30 * 1000 };
  const { widget, notified, getState } = setup({ alarms: [missed, soon], alarmCheckedAt: now - 5 * 3600 * 1000 });
  t.after(() => widget.stop());
  const cards = notified.map((n) => n.events[0]);
  const missedCard = cards.find((c) => c.title === '놓친 알람');
  assert.ok(missedCard);
  assert.equal(missedCard.sound, undefined);
  assert.match(missedCard.body, /점심/);
  assert.equal(cards.filter((c) => c.title === '놓친 알람').length, 1);
  const ring = notified.find((n) => n.events[0].title === '알람');
  assert.equal(ring.events[0].tag, 'clock-alarm-s');
  assert.equal(ring.events[0].sound, true);
  assert.equal(ring.events[0].sticky, true);
  assert.deepEqual(ring.events[0].actions.map((x) => x.id), ['snooze', 'off']);
  assert.equal(getState().alarms.find((a) => a.id === 'm').on, false, 'one-time alarm turned off');
  ring.options.onAction(ring.events[0], 'snooze');
  const snoozeUntil = getState().alarms.find((a) => a.id === 's').snoozeUntil;
  assert.ok(snoozeUntil - Date.now() > 4 * 60 * 1000);
  ring.options.onAction(ring.events[0], 'off');
  assert.equal(getState().alarms.find((a) => a.id === 's').snoozeUntil, null);
});

test('a first start reports nothing; stopping saves how far alarms were handled', () => {
  const d = new Date(Date.now() - 3600 * 1000);
  const { widget, notified, getState } = setup({ alarms: [{ id: 'x', hour: d.getHours(), minute: d.getMinutes(), days: [], on: true }] });
  assert.equal(notified.length, 0);
  widget.stop();
  assert.ok(getState().alarmCheckedAt > 0);
});
