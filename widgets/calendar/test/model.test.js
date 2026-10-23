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
