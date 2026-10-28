// Date phrases, repeat rules and recurrence of the to-do notes (#111). Fixed clocks only.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/dates');

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 10, 20, 10, 0); // Tuesday 2026-10-20 10:00
const when = (text, now = NOW) => D.parseWhen(text, now);
const due = (date, time = null) => ({ date, time });

test('phrases from the to-do widget keep their meaning', () => {
  assert.deepEqual(when('내일 오후 3시 30분').due, due('2026-10-21', '15:30'));
  assert.deepEqual(when('모레').due, due('2026-10-22'));
  assert.deepEqual(when('9시').due, due('2026-10-21', '09:00'), 'a time already past today means tomorrow');
  assert.equal(when('내일 25시').error, 'invalid');
  assert.deepEqual(when('다음 주 월요일 9시').due, due('2026-10-26', '09:00'));
  const weekly = when('매주 월요일 18시');
  assert.deepEqual(weekly.due, due('2026-10-26', '18:00'));
  assert.deepEqual(weekly.rule, { kind: 'weekly', n: 1, days: [1] });
});

test('relative dates and weekdays', () => {
  assert.deepEqual(when('오늘').due, due('2026-10-20'));
  assert.deepEqual(when('글피').due, due('2026-10-23'));
  assert.deepEqual(when('3일 뒤').due, due('2026-10-23'));
  assert.deepEqual(when('2주 후').due, due('2026-11-03'));
  assert.deepEqual(when('다음 달').due, due('2026-11-20'));
  assert.deepEqual(when('금요일').due, due('2026-10-23'));
  assert.deepEqual(when('금').due, due('2026-10-23'));
  assert.deepEqual(when('화').due, due('2026-10-20'), 'today is that weekday');
  assert.deepEqual(when('화 9시').due, due('2026-10-27', '09:00'), 'that weekday today but its time has passed');
  assert.deepEqual(when('이번 주 금').due, due('2026-10-23'));
  assert.deepEqual(when('이번 주 월').due, due('2026-10-26'), 'this week\'s Monday has passed: the coming one');
  assert.deepEqual(when('다음 주 월요일').due, due('2026-10-26'));
  assert.deepEqual(when('주말').due, due('2026-10-24'));
});

test('absolute dates: month/day in the Korean order, past dates move to next year / month', () => {
  assert.deepEqual(when('10/30').due, due('2026-10-30'));
  assert.deepEqual(when('10.30').due, due('2026-10-30'));
  assert.deepEqual(when('10월 30일').due, due('2026-10-30'));
  assert.deepEqual(when('1/5').due, due('2027-01-05'), 'already past this year');
  assert.deepEqual(when('30일').due, due('2026-10-30'));
  assert.deepEqual(when('5일').due, due('2026-11-05'), 'past this month: next month');
  assert.deepEqual(when('31일', at(2026, 11, 2)).due, due('2026-12-31'), 'November has no 31st');
  assert.deepEqual(when('2026-10-30').due, due('2026-10-30'));
  assert.deepEqual(when('2027년 1월 5일').due, due('2027-01-05'));
  assert.deepEqual(when('2/29').due, due('2028-02-29'), 'the next leap year');
  assert.equal(when('2/30').error, 'invalid');
  assert.equal(when('13/1').error, 'invalid');
  assert.deepEqual(when('12/31 23:59', at(2026, 12, 31, 23, 0)).due, due('2026-12-31', '23:59'), 'just before midnight on New Year\'s Eve');
});

test('times: 오전/오후 12시, half hours, words, 1~6시 mean the afternoon', () => {
  assert.deepEqual(when('오전 12시', at(2026, 10, 20, 0, 0) - 1).due, due('2026-10-20', '00:00'));
  assert.deepEqual(when('내일 오후 12시').due, due('2026-10-21', '12:00'));
  assert.deepEqual(when('3시 반').due, due('2026-10-20', '15:30'));
  assert.deepEqual(when('15:30').due, due('2026-10-20', '15:30'));
  assert.deepEqual(when('내일 아침').due, due('2026-10-21', '09:00'));
  assert.deepEqual(when('내일 점심').due, due('2026-10-21', '12:00'));
  assert.deepEqual(when('저녁').due, due('2026-10-20', '18:00'));
  assert.deepEqual(when('밤').due, due('2026-10-20', '21:00'));
  assert.deepEqual(when('금요일 5시').due, due('2026-10-23', '17:00'));
  assert.deepEqual(when('새벽 3시').due, due('2026-10-21', '03:00'));
  assert.equal(when('오후 13시').error, 'invalid');
  assert.equal(when('3시 75분').error, 'invalid');
});

test('repeat phrases (fixed dates) and their normalized text round-trips', () => {
  const cases = [
    ['매일', { kind: 'daily', n: 1 }, '매일'],
    ['평일', { kind: 'weekly', n: 1, days: [1, 2, 3, 4, 5] }, '평일'],
    ['주말마다', { kind: 'weekly', n: 1, days: [0, 6] }, '주말마다'],
    ['매주 금', { kind: 'weekly', n: 1, days: [5] }, '매주 금'],
    ['매주 월수금', { kind: 'weekly', n: 1, days: [1, 3, 5] }, '매주 월수금'],
    ['매주 월, 수, 금요일', { kind: 'weekly', n: 1, days: [1, 3, 5] }, '매주 월수금'],
    ['매주 일 토', { kind: 'weekly', n: 1, days: [0, 6] }, '주말마다'],
    ['격주 화', { kind: 'weekly', n: 2, days: [2] }, '격주 화'],
    ['매월 1일', { kind: 'monthly', n: 1, day: 1 }, '매월 1일'],
    ['매달 1일', { kind: 'monthly', n: 1, day: 1 }, '매월 1일'],
    ['매월 말일', { kind: 'monthly', n: 1, day: -1 }, '매월 말일'],
    ['매월 첫째 월요일', { kind: 'monthly', n: 1, nth: 1, weekday: 1 }, '매월 첫째 월요일'],
    ['매월 마지막 금요일', { kind: 'monthly', n: 1, nth: -1, weekday: 5 }, '매월 마지막 금요일'],
    ['매년 3월 15일', { kind: 'yearly', month: 3, day: 15 }, '매년 3월 15일'],
    ['3일마다', { kind: 'daily', n: 3 }, '3일마다'],
    ['2주마다', { kind: 'weekly', n: 2, days: null }, '격주'],
    ['3개월마다', { kind: 'monthly', n: 3, day: null }, '3개월마다'],
    ['완료 후 30일', { kind: 'after', n: 30, unit: 'day' }, '완료 후 30일'],
    ['완료 후 2주', { kind: 'after', n: 2, unit: 'week' }, '완료 후 2주'],
    ['완료 후 3개월', { kind: 'after', n: 3, unit: 'month' }, '완료 후 3개월'],
  ];
  for (const [text, rule, normal] of cases) {
    assert.deepEqual(D.parseRepeat(text), rule, text);
    assert.equal(D.formatRepeat(rule), normal, text);
    assert.deepEqual(D.parseRepeat(D.formatRepeat(rule)), D.parseRepeat(normal), `${text} round trip`);
  }
  assert.deepEqual(D.parseRepeat('주말'), { kind: 'weekly', n: 1, days: [0, 6] }, '"주말" alone in front matter = every weekend');
  assert.equal(D.parseRepeat('가끔'), null);
  assert.equal(D.parseRepeat('매월 32일'), null);
});

test('repeat phrases with a time give the first date from today', () => {
  assert.deepEqual(when('매월 1일 오전 9시'), { due: due('2026-11-01', '09:00'), rule: { kind: 'monthly', n: 1, day: 1 } });
  assert.deepEqual(when('매일 9시').due, due('2026-10-21', '09:00'), "today's 9:00 has passed");
  assert.deepEqual(when('매일 11시').due, due('2026-10-20', '11:00'));
  assert.deepEqual(when('매월 마지막 금요일').due, due('2026-10-30'));
  assert.deepEqual(when('완료 후 30일').due, due('2026-10-20'));
});

test('English phrases', () => {
  assert.deepEqual(when('today').due, due('2026-10-20'));
  assert.deepEqual(when('tomorrow 3pm').due, due('2026-10-21', '15:00'));
  assert.deepEqual(when('fri').due, due('2026-10-23'));
  assert.deepEqual(when('next mon').due, due('2026-10-26'));
  assert.deepEqual(when('10/30').due, due('2026-10-30'));
  assert.deepEqual(when('3pm').due, due('2026-10-20', '15:00'));
  assert.deepEqual(when('every day').rule, { kind: 'daily', n: 1 });
  assert.deepEqual(when('every fri').rule, { kind: 'weekly', n: 1, days: [5] });
  assert.deepEqual(when('every month on 1').rule, { kind: 'monthly', n: 1, day: 1 });
  assert.deepEqual(when('every 2 weeks').rule, { kind: 'weekly', n: 2, days: null });
  assert.deepEqual(when('after 30 days').rule, { kind: 'after', n: 30, unit: 'day' });
});

test('the first line suggestion reads only the end and keeps a title', () => {
  const s = D.parseSuffix('보고서 제출 금요일 5시', NOW);
  assert.equal(s.title, '보고서 제출');
  assert.equal(s.phrase, '금요일 5시');
  assert.deepEqual(s.due, due('2026-10-23', '17:00'));
  assert.equal(D.parseSuffix('장보기', NOW), null);
  assert.equal(D.parseSuffix('내일', NOW), null, 'nothing left for a title');
  assert.equal(D.parseSuffix('오늘 할 일', NOW), null, 'a normal title is not a date suffix');
  assert.equal(D.parseSuffix('월간 보고 매월 1일', NOW).rule.day, 1);
});

test('front matter values: due forms, stamps', () => {
  assert.deepEqual(D.parseDueValue('2026-11-01'), due('2026-11-01'));
  assert.deepEqual(D.parseDueValue('2026-11-01 09:00'), due('2026-11-01', '09:00'));
  assert.deepEqual(D.parseDueValue('2026-11-01T09:00'), due('2026-11-01', '09:00'));
  assert.deepEqual(D.parseDueValue('2026-11-01T09:00:00'), due('2026-11-01', '09:00'));
  assert.equal(D.parseDueValue('2026-02-30'), null);
  assert.equal(D.parseDueValue('내일쯤'), null);
  assert.equal(D.formatDueValue(due('2026-11-01', '09:00')), '2026-11-01 09:00');
  assert.equal(D.stampOf(at(2026, 10, 25, 14, 3)), '2026-10-25 14:03');
  assert.equal(D.parseStamp('2026-10-25 14:03'), at(2026, 10, 25, 14, 3));
});

test('fixed repeats: next due after completion skips missed dates (design 5.3)', () => {
  const monthly = D.parseRepeat('매월 1일');
  // Completed on time.
  assert.deepEqual(D.nextDue(monthly, due('2026-11-01', '09:00'), at(2026, 11, 1, 10)), due('2026-12-01', '09:00'));
  // Completed late (11/3): 12/1, the 11/1 date is not made again.
  assert.deepEqual(D.nextDue(monthly, due('2026-11-01', '09:00'), at(2026, 11, 3, 10)), due('2026-12-01', '09:00'));
  // Completed early: the date after the current due.
  assert.deepEqual(D.nextDue(monthly, due('2026-11-01'), at(2026, 10, 20)), due('2026-12-01'));
  // Missed for months: the first date after today.
  assert.deepEqual(D.nextDue(monthly, due('2026-08-01'), at(2026, 10, 20)), due('2026-11-01'));
  assert.deepEqual(D.nextDue(D.parseRepeat('매주 월수금'), due('2026-10-21'), at(2026, 10, 21, 12)), due('2026-10-23'));
  assert.deepEqual(D.nextDue(D.parseRepeat('평일'), due('2026-10-23'), at(2026, 10, 23, 12)), due('2026-10-26'));
  assert.deepEqual(D.nextDue(D.parseRepeat('격주 화'), due('2026-10-20'), at(2026, 10, 20, 12)), due('2026-11-03'));
  assert.deepEqual(D.nextDue(D.parseRepeat('3일마다'), due('2026-10-20'), at(2026, 10, 25)), due('2026-10-26'), 'counted from the due');
  assert.deepEqual(D.nextDue(D.parseRepeat('3개월마다'), due('2026-10-20'), at(2026, 10, 20)), due('2027-01-20'));
  assert.deepEqual(D.nextDue(D.parseRepeat('매월 첫째 월요일'), due('2026-11-02'), at(2026, 11, 2)), due('2026-12-07'));
  assert.deepEqual(D.nextDue(D.parseRepeat('매월 마지막 금요일'), due('2026-10-30'), at(2026, 10, 30)), due('2026-11-27'));
  assert.deepEqual(D.nextDue(D.parseRepeat('매일'), due('2026-12-31', '23:30'), at(2026, 12, 31, 23, 40)), due('2027-01-01', '23:30'), 'over the year end');
});

test('monthly on the 31st: the last day of short months, then the 31st again', () => {
  const r = D.parseRepeat('매월 31일');
  assert.deepEqual(D.nextDue(r, due('2026-10-31'), at(2026, 10, 31)), due('2026-11-30'));
  assert.deepEqual(D.nextDue(r, due('2026-11-30'), at(2026, 11, 30)), due('2026-12-31'));
  assert.deepEqual(D.nextDue(r, due('2027-01-31'), at(2027, 1, 31)), due('2027-02-28'));
  assert.deepEqual(D.nextDue(r, due('2028-01-31'), at(2028, 1, 31)), due('2028-02-29'), 'leap year');
  assert.deepEqual(D.nextDue(D.parseRepeat('매월 말일'), due('2027-02-28'), at(2027, 2, 28)), due('2027-03-31'));
  assert.deepEqual(D.nextDue(D.parseRepeat('매년 2월 29일'), due('2028-02-29'), at(2028, 2, 29)), due('2029-02-28'));
});

test('repeat after completion: the completion day + the period, the time kept', () => {
  assert.deepEqual(D.nextDue(D.parseRepeat('완료 후 30일'), due('2026-10-01', '09:00'), at(2026, 10, 20, 15)), due('2026-11-19', '09:00'));
  assert.deepEqual(D.nextDue(D.parseRepeat('완료 후 2주'), due('2026-10-01'), at(2026, 10, 20)), due('2026-11-03'));
  assert.deepEqual(D.nextDue(D.parseRepeat('완료 후 3개월'), due('2026-10-01'), at(2026, 11, 30)), due('2027-02-28'));
});

test('missed dates of a repeating note are counted, not created', () => {
  const r = D.parseRepeat('매일');
  assert.equal(D.missedCount(r, due('2026-10-20', '09:00'), at(2026, 10, 20, 8)), 0);
  assert.equal(D.missedCount(r, due('2026-10-20', '09:00'), at(2026, 10, 20, 10)), 1);
  assert.equal(D.missedCount(r, due('2026-10-18', '09:00'), at(2026, 10, 20, 10)), 3);
  assert.equal(D.missedCount(D.parseRepeat('매월 1일'), due('2026-09-01'), at(2026, 10, 20)), 2);
  assert.equal(D.missedCount(null, due('2026-09-01'), at(2026, 10, 20)), 1);
  assert.equal(D.missedCount(r, due('2026-10-20'), at(2026, 10, 20, 23, 59)), 0, 'an all-day due is missed from the next midnight');
});

test('changing a rule: does the due fit it, and the aligned date', () => {
  const r = D.parseRepeat('매월 15일');
  assert.equal(D.fitsRule(r, due('2026-11-01')), false);
  assert.deepEqual(D.alignDue(r, due('2026-11-01', '09:00')), due('2026-11-15', '09:00'));
  assert.equal(D.fitsRule(D.parseRepeat('3일마다'), due('2026-11-01')), true);
});

test('reminders: timed, before, the day before, all-day at the set time, off', () => {
  const d = due('2026-11-02', '15:00');
  assert.equal(D.remindAt(d, null, '09:00'), at(2026, 11, 2, 15));
  assert.equal(D.remindAt(d, D.parseRemind('10분 전'), '09:00'), at(2026, 11, 2, 14, 50));
  assert.equal(D.remindAt(d, D.parseRemind('1시간 전'), '09:00'), at(2026, 11, 2, 14));
  assert.equal(D.remindAt(d, D.parseRemind('1일 전 18:00'), '09:00'), at(2026, 11, 1, 18));
  assert.equal(D.remindAt(d, D.parseRemind('없음'), '09:00'), null);
  assert.equal(D.remindAt(due('2026-11-02'), null, '09:00'), at(2026, 11, 2, 9));
  assert.equal(D.remindAt(due('2026-11-02'), null, ''), null, 'all-day reminders switched off');
  assert.equal(D.formatRemind(D.parseRemind('30분 전')), '30분 전');
  assert.equal(D.formatRemind(D.parseRemind('전날 18:00')), '1일 전 18:00');
  assert.equal(D.parseRemind('가끔'), null);
});

test('the preview text of the date box', () => {
  assert.equal(D.describeDue(due('2026-11-02', '15:00'), NOW), '11월 2일 (월) 오후 3:00');
  assert.equal(D.describeDue(due('2027-01-05'), NOW), '2027년 1월 5일 (화)');
  assert.equal(D.describeDue(due('2026-11-02', '00:30'), NOW), '11월 2일 (월) 오전 12:30');
});
