const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RuleStore, RuleError, periodFor, isDue, evaluate, sanitizeRule, dayKey } = require('../backend/rules');

// Local times (the rules work in the PC's local calendar).
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const MON = at(2026, 10, 19, 10, 0); // Monday 10:00
const FRI = at(2026, 10, 16, 10, 0);

const rule = (over = {}) =>
  sanitizeRule({ name: '일일보고', projectIds: ['p1', 'p2'], time: '09:30', repeatMinutes: 60, ...over });

test('previous day skips the weekend on weekdays, not on everyday', () => {
  const p = periodFor(rule(), MON);
  assert.equal(p.from.getTime(), at(2026, 10, 16).getTime(), 'Monday checks Friday');
  assert.equal(p.to.getTime(), at(2026, 10, 17).getTime());
  assert.equal(p.label, '10/16(금)');
  assert.equal(periodFor(rule({ days: 'everyday' }), MON).from.getTime(), at(2026, 10, 18).getTime(), 'everyday: Sunday');
  assert.equal(periodFor(rule(), FRI).from.getTime(), at(2026, 10, 15).getTime());
});

test('today period runs from midnight until now', () => {
  const p = periodFor(rule({ period: 'today' }), FRI);
  assert.equal(p.from.getTime(), at(2026, 10, 16).getTime());
  assert.equal(p.to.getTime(), FRI.getTime());
});

test('due once a day after the check time, then repeats until resolved', () => {
  const r = rule();
  assert.equal(isDue(r, null, at(2026, 10, 16, 9, 29)), false, 'before 09:30');
  assert.equal(isDue(r, null, at(2026, 10, 16, 9, 30)), true);
  assert.equal(isDue(r, null, at(2026, 10, 17, 11, 0)), false, 'Saturday with weekdays');
  assert.equal(isDue(rule({ days: 'everyday' }), null, at(2026, 10, 17, 11, 0)), true);

  const unresolved = { date: dayKey(FRI), resolved: false, lastCheckedAt: at(2026, 10, 16, 9, 30).toISOString(), lastAlertAt: at(2026, 10, 16, 9, 30).toISOString() };
  assert.equal(isDue(r, unresolved, at(2026, 10, 16, 10, 0)), false, 'within repeat interval');
  assert.equal(isDue(r, unresolved, at(2026, 10, 16, 10, 30)), true, 'repeat after 60 minutes');
  assert.equal(isDue(rule({ repeatMinutes: 0 }), unresolved, at(2026, 10, 16, 15, 0)), false, 'no repeat');
  assert.equal(isDue(r, { ...unresolved, resolved: true }, at(2026, 10, 16, 15, 0)), false, 'resolved today');
  assert.equal(isDue(r, unresolved, at(2026, 10, 19, 9, 31)), true, 'new day');
  assert.equal(isDue(rule({ enabled: false }), null, FRI), false, 'disabled');
});

test('evaluate counts per project, honours the tag filter and the minimum', () => {
  const posts = [
    { project: { id: 'p1' }, tags: [{ id: 'daily' }] },
    { project: { id: 'p2' }, tags: [{ id: 'weekly' }] },
    { project: { id: 'other' }, tags: [] },
  ];
  const tagName = (id) => ({ daily: '일일보고', weekly: '주간보고' })[id];
  const names = (id) => ({ p1: '홍길동-업무보고', p2: '김철수-업무보고' })[id];

  const all = evaluate(rule(), posts, { projectName: names, tagName });
  assert.deepEqual(all.counts, { p1: 1, p2: 1 });
  assert.deepEqual(all.missing, []);

  const daily = evaluate(rule({ tag: '일일' }), posts, { projectName: names, tagName });
  assert.deepEqual(daily.missing, [{ id: 'p2', name: '김철수-업무보고', count: 0 }]);

  assert.equal(evaluate(rule({ minCount: 2 }), posts, { projectName: names, tagName }).missing.length, 2);
});

test('rule validation and storage', () => {
  assert.throws(() => sanitizeRule({ name: '', projectIds: ['p1'] }), RuleError);
  assert.throws(() => sanitizeRule({ name: 'x', projectIds: [] }), RuleError);
  assert.throws(() => sanitizeRule({ name: 'x', projectIds: ['p1'], time: '25:00' }), RuleError);

  const store = new RuleStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rules-')), 'rules.json'));
  const saved = store.save({ name: '일일보고', projectIds: ['p1'] });
  store.setState(saved.id, { date: '2026-10-16', resolved: true });
  store.save({ ...saved, minCount: 2 });
  assert.equal(store.stateOf(saved.id), null, 'editing a rule resets today\'s state');
  assert.equal(new RuleStore(store.filePath).rules()[0].minCount, 2, 'persisted');
  store.remove(saved.id);
  assert.equal(store.rules().length, 0);
});
