// Month grid, day placement, ordering and the upcoming list (kit/model.js, local time).
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../kit/model');

/** A timed event from local wall times. */
const timed = (title, start, end, extra = {}) => ({ title, allDay: false, start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...extra });
const allDay = (title, start, end, extra = {}) => ({ title, allDay: true, start, end, ...extra });

test('Sunday-start grid of October 2026: 6 weeks from 9/27', () => {
  const g = M.monthGrid(2026, 10, 0);
  assert.equal(g.days.length, 42);
  assert.equal(g.from, '2026-09-27');
  assert.equal(g.to, '2026-11-08');
  assert.equal(g.days[0].weekday, 0);
  assert.equal(g.days.find((d) => d.key === '2026-10-01').inMonth, true);
  assert.equal(g.days[0].inMonth, false);
  assert.equal(g.days.filter((d) => d.inMonth).length, 31);
});

test('Monday-start grid and labels', () => {
  const g = M.monthGrid(2026, 10, 1);
  assert.equal(g.from, '2026-09-28');
  assert.equal(g.days[0].weekday, 1);
  assert.deepEqual(M.weekdayLabels(1), ['월', '화', '수', '목', '금', '토', '일']);
  assert.deepEqual(M.weekdayLabels(0), ['일', '월', '화', '수', '목', '금', '토']);
  // A month starting on the week's first day starts the grid on the 1st.
  assert.equal(M.monthGrid(2026, 6, 1).from, '2026-06-01');
  assert.equal(M.monthGrid(2026, 2, 0).from, '2026-02-01');
});

test('days an event covers', () => {
  assert.deepEqual(M.eventDays(allDay('a', '2026-10-20', '2026-10-23')), ['2026-10-20', '2026-10-21', '2026-10-22']);
  assert.deepEqual(M.eventDays(allDay('b', '2026-10-20', '2026-10-21')), ['2026-10-20']);
  assert.deepEqual(M.eventDays(timed('c', '2026-10-20T23:00', '2026-10-21T01:00')), ['2026-10-20', '2026-10-21']);
  assert.deepEqual(M.eventDays(timed('d', '2026-10-20T22:00', '2026-10-21T00:00')), ['2026-10-20'], 'ending at midnight does not reach the next day');
  assert.deepEqual(M.eventDays(timed('e', '2026-10-20T09:00', '2026-10-20T09:00')), ['2026-10-20']);
});

test('a day lists all-day events first, then by start time', () => {
  const events = [
    timed('늦은 회의', '2026-10-20T15:00', '2026-10-20T16:00'),
    timed('아침', '2026-10-20T08:00', '2026-10-20T08:30'),
    allDay('휴가', '2026-10-19', '2026-10-22'),
    timed('전날부터', '2026-10-19T22:00', '2026-10-20T02:00'),
  ];
  const map = M.byDay(events);
  assert.deepEqual(
    map.get('2026-10-20').map((e) => e.title),
    ['휴가', '전날부터', '아침', '늦은 회의'],
  );
  assert.equal(M.timeLabel(events[3], '2026-10-20'), '~ 02:00');
  assert.equal(M.timeLabel(events[3], '2026-10-19'), '22:00 ~');
  assert.equal(M.timeLabel(events[1], '2026-10-20'), '08:00 – 08:30');
  assert.equal(M.timeLabel(events[2], '2026-10-20'), '종일');
});

test('upcoming: from today for N days, ended events dropped, grouped by day in order', () => {
  const now = new Date('2026-10-18T12:00');
  const events = [
    timed('끝난 회의', '2026-10-18T09:00', '2026-10-18T10:00'),
    timed('진행 중', '2026-10-18T11:00', '2026-10-18T13:00'),
    timed('오후', '2026-10-18T15:00', '2026-10-18T16:00'),
    allDay('오늘 종일', '2026-10-18', '2026-10-19'),
    timed('모레', '2026-10-20T10:00', '2026-10-20T11:00'),
    timed('8일 뒤', '2026-10-26T10:00', '2026-10-26T11:00'),
    allDay('어제 끝남', '2026-10-16', '2026-10-18'),
  ];
  const groups = M.upcoming(events, now, 7);
  assert.deepEqual(
    groups.map((g) => [g.key, g.events.map((e) => e.title)]),
    [
      ['2026-10-18', ['오늘 종일', '진행 중', '오후']],
      ['2026-10-20', ['모레']],
    ],
  );
});

test('day dots: distinct colors, at most three', () => {
  const list = ['#111111', '#222222', '#111111', '#333333', '#444444'].map((color, i) => ({ title: String(i), color }));
  assert.deepEqual(M.dayColors(list), ['#111111', '#222222', '#333333']);
  assert.deepEqual(M.dayColors(undefined), []);
});

test('titles', () => {
  assert.equal(M.dayTitle('2026-10-18'), '10월 18일 (일)');
  assert.equal(M.detailTime(allDay('a', '2026-10-20', '2026-10-23')), '2026. 10. 20. (화) – 2026. 10. 22. (목) 종일');
  assert.equal(M.detailTime(timed('b', '2026-10-20T09:00', '2026-10-20T10:30')), '2026. 10. 20. (화) 09:00 – 10:30');
});

test('#78 newEventDefaults: next full hour for 1 hour, or the chosen day as all-day', () => {
  const at = (s) => new Date(s);
  const now = at('2026-10-26T14:20:00');
  assert.deepEqual(M.newEventDefaults(null, now, false), { allDay: false, startDate: '2026-10-26', startTime: '15:00', endDate: '2026-10-26', endTime: '16:00', timed: { startDate: '2026-10-26', startTime: '15:00', endDate: '2026-10-26', endTime: '16:00' } });
  const other = M.newEventDefaults('2026-11-03', now, false);
  assert.deepEqual([other.startDate, other.startTime, other.endDate, other.endTime], ['2026-11-03', '15:00', '2026-11-03', '16:00']);
  // All-day: the chosen day alone (end date is inclusive in the editor); today when none is given.
  const day = M.newEventDefaults('2026-11-03', now, true);
  assert.equal(day.allDay, true);
  assert.deepEqual([day.startDate, day.endDate], ['2026-11-03', '2026-11-03']);
  assert.deepEqual(day.timed, other.timed, 'unchecking 종일 falls back to the usual 1 hour');
  assert.deepEqual([M.newEventDefaults(null, now, true).startDate, M.newEventDefaults(null, now, true).endDate], ['2026-10-26', '2026-10-26']);
  assert.equal(M.newEventDefaults('2026-11-03', now, undefined).allDay, false);
  // After 23:00 today the next full hour is tomorrow 00:00: timed starts there, all-day stays on today.
  const late = at('2026-10-31T23:30:00');
  const t = M.newEventDefaults('2026-10-31', late, false);
  assert.deepEqual([t.startDate, t.startTime, t.endDate, t.endTime], ['2026-11-01', '00:00', '2026-11-01', '01:00']);
  const a = M.newEventDefaults('2026-10-31', late, true);
  assert.deepEqual([a.startDate, a.endDate, a.timed.startDate], ['2026-10-31', '2026-10-31', '2026-11-01']);
  // A chosen later day at 22:30 keeps the same hour on that day and ends after midnight.
  const night = M.newEventDefaults('2026-12-31', at('2026-10-31T21:30:00'), false);
  assert.deepEqual([night.startTime, night.endDate, night.endTime], ['22:00', '2026-12-31', '23:00']);
  const cross = M.newEventDefaults('2026-12-31', at('2026-10-31T22:30:00'), false);
  assert.deepEqual([cross.startTime, cross.endDate, cross.endTime], ['23:00', '2027-01-01', '00:00']);
});

test('to-do overlay colours: user-chosen, defaults kept, invalid values fall back', () => {
  const { sanitize, DEFAULTS } = require('../lib/settings');
  assert.equal(DEFAULTS.notesColor, '#e8b923');
  assert.equal(DEFAULTS.todoColor, '#f7ad52');
  const s = sanitize({ notesColor: '#3366FF', todoColor: 'red' });
  assert.equal(s.notesColor, '#3366ff');
  assert.equal(s.todoColor, '#f7ad52');
  assert.equal(sanitize({}).notesColor, '#e8b923');
});

test('#122 editor: the end follows the start by the kept duration', () => {
  const f = { startDate: '2026-11-06', startTime: '10:00', endDate: '2026-11-06', endTime: '11:00' };
  assert.equal(M.editorDuration(f, false), 60);
  assert.deepEqual(M.editorEnd({ ...f, startTime: '14:00' }, 60, false), { endDate: '2026-11-06', endTime: '15:00' });
  // Crossing midnight rolls the end date; a multi-day length is kept.
  assert.deepEqual(M.editorEnd({ ...f, startTime: '23:30' }, 60, false), { endDate: '2026-11-07', endTime: '00:30' });
  assert.equal(M.editorDuration({ ...f, endDate: '2026-11-07', endTime: '09:30' }, false), 1410);
  assert.deepEqual(M.editorEnd({ ...f, startDate: '2026-12-31' }, 1410, false), { endDate: '2027-01-01', endTime: '09:30' });
});

test('#122 editor: all-day works on dates only; empty or invalid input changes nothing', () => {
  const f = { startDate: '2026-11-06', startTime: '', endDate: '2026-11-08', endTime: '' };
  assert.equal(M.editorDuration(f, true), 2);
  assert.deepEqual(M.editorEnd({ ...f, startDate: '2026-11-30' }, 2, true), { endDate: '2026-12-02', endTime: '' });
  assert.equal(M.editorEnd({ ...f, startDate: '' }, 2, true), null);
  const t = { startDate: '2026-11-06', startTime: '10:00', endDate: '2026-11-06', endTime: '11:00' };
  assert.equal(M.editorEnd({ ...t, startTime: '' }, 60, false), null);
  assert.equal(M.editorEnd(t, null, false), null);
  assert.equal(M.editorDuration({ ...t, startTime: '' }, false), null);
  assert.equal(M.editorDuration({ ...t, endTime: '09:00' }, false), null); // end before start: keep the old length
  assert.equal(M.editorDuration({ ...f, endDate: '2026-11-01' }, true), null);
});

test('#123 normalizeTime: tidies 24-hour input, rejects the rest', () => {
  for (const [input, want] of [['930', '09:30'], ['1830', '18:30'], ['18', '18:00'], ['9:5', '09:05'], ['09:30', '09:30'], [' 7 ', '07:00'], ['0', '00:00'], ['00:00', '00:00'], ['23:59', '23:59'], ['2359', '23:59'], ['905', '09:05']]) {
    assert.equal(M.normalizeTime(input), want, input);
  }
  assert.equal(M.normalizeTime(''), '');
  assert.equal(M.normalizeTime('   '), '');
  assert.equal(M.normalizeTime(undefined), '');
  for (const bad of ['25:00', '24:00', '2400', '12:60', '1260', 'abc', '오후 07:05', '1:2:3', '12345', '-1', '9.5']) assert.equal(M.normalizeTime(bad), null, bad);
});

test('#123 stepTime: 5-minute steps that wrap at midnight', () => {
  assert.equal(M.stepTime('09:00', 1), '09:05');
  assert.equal(M.stepTime('09:00', -1), '08:55');
  assert.equal(M.stepTime('09:02', 1), '09:05'); // snaps to the 5-minute grid
  assert.equal(M.stepTime('09:02', -1), '09:00');
  assert.equal(M.stepTime('23:55', 1), '00:00');
  assert.equal(M.stepTime('23:59', 1), '00:00');
  assert.equal(M.stepTime('00:00', -1), '23:55');
  assert.equal(M.stepTime('930', 1), '09:35');
  assert.equal(M.stepTime('', 1), '00:05');
  assert.equal(M.stepTime('abc', 1), null);
  assert.equal(M.stepTime('24:00', -1), null);
});
