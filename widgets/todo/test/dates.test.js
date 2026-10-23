const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuickInput, nextRepeat } = require('../lib/dates');

const now = new Date(2026, 9, 20, 10, 0); // Tuesday, local time.

test('Korean quick entry keeps the title and resolves relative days and time', () => {
  const tomorrow = parseQuickInput('보고서 내일 오후 3시 30분', now);
  assert.equal(tomorrow.title, '보고서');
  assert.equal(tomorrow.dueAt, new Date(2026, 9, 21, 15, 30).getTime());
  assert.equal(tomorrow.dateOnly, false);
  assert.equal(parseQuickInput('정리 모레', now).dueAt, new Date(2026, 9, 22, 23, 59).getTime());
  assert.equal(parseQuickInput('회의 9시', now).dueAt, new Date(2026, 9, 21, 9).getTime(), 'elapsed time means tomorrow');
  assert.equal(parseQuickInput('서류 내일 25시', now).error, 'invalidDate');
  assert.equal(parseQuickInput('오늘 할 일', now).dueAt, null, 'a normal title is not a date suffix');
});

test('next week refers to the next calendar week and weekly tasks roll forward', () => {
  const nextMonday = parseQuickInput('회의 다음 주 월요일 9시', now);
  assert.equal(nextMonday.dueAt, new Date(2026, 9, 26, 9).getTime());
  const weekly = parseQuickInput('청소 매주 월요일 18시', now);
  assert.equal(weekly.dueAt, new Date(2026, 9, 26, 18).getTime());
  assert.equal(weekly.repeatWeekday, 1);
  assert.equal(nextRepeat(weekly, new Date(2026, 9, 26, 18).getTime()), new Date(2026, 10, 2, 18).getTime());
});
