// Background writes (#63): what the widget shows while a write runs, and the per-event queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyOverlays, overlayEvent, createQueue } = require('../lib/optimistic');

const OCT = [Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-11-01T00:00:00Z')];
const ev = (uid, title, extra = {}) => ({ uid, sourceId: 's', calendarId: 'c', title, allDay: false, start: '2026-10-20T01:00:00Z', end: '2026-10-20T02:00:00Z', ...extra });
const ov = (id, op, uid, fields, extra = {}) => ({ id, op, sourceId: 's', calendarId: 'c', uid, fields, color: '#123456', sourceName: '네이버 · 내 캘린더', title: fields?.title, ...extra });
const timed = (title, h) => ({ title, allDay: false, start: Date.UTC(2026, 9, 21, h), end: Date.UTC(2026, 9, 21, h + 1), location: '', description: '' });

test('create: a pending, read-only event in the calendar color; out of range: not shown', () => {
  const out = applyOverlays([ev('a', 'A')], [ov(1, 'create', 'pending:1', timed('새 일정', 9))], ...OCT);
  assert.equal(out.length, 2);
  const e = out[1];
  assert.deepEqual([e.uid, e.title, e.pending, e.readOnly, e.color, e.start], ['pending:1', '새 일정', true, true, '#123456', '2026-10-21T09:00:00.000Z']);
  assert.match(e.readOnlyReason, /저장 중/);
  const later = { ...timed('먼 일정', 9), start: Date.UTC(2027, 0, 5, 9), end: Date.UTC(2027, 0, 5, 10) };
  assert.equal(applyOverlays([], [ov(2, 'create', 'pending:2', later)], ...OCT).length, 0);
  assert.deepEqual(overlayEvent(ov(3, 'create', 'p', { title: '종일', allDay: true, start: '2026-10-22', end: '2026-10-23' })).start, '2026-10-22');
});

test('edit: the old form is replaced by the new one (also when moved to another day); delete: gone', () => {
  const events = [ev('a', 'A'), ev('b', 'B'), ev('a', 'A from another calendar', { calendarId: 'other' })];
  const edited = applyOverlays(events, [ov(1, 'edit', 'a', timed('A 수정', 15))], ...OCT);
  assert.deepEqual(edited.map((e) => [e.uid, e.calendarId, e.title, Boolean(e.pending)]), [
    ['b', 'c', 'B', false],
    ['a', 'other', 'A from another calendar', false],
    ['a', 'c', 'A 수정', true],
  ]);
  const deleted = applyOverlays(events, [ov(2, 'delete', 'b', null)], ...OCT);
  assert.deepEqual(deleted.map((e) => e.title), ['A', 'A from another calendar']);
  // In order: an edit then a delete of the same event = gone.
  assert.ok(!applyOverlays(events, [ov(1, 'edit', 'a', timed('A 수정', 15)), ov(2, 'delete', 'a', null)], ...OCT).some((e) => e.uid === 'a' && e.calendarId === 'c'));
  assert.deepEqual(applyOverlays(events, [], ...OCT), events);
});

test('queue: same key in order, other keys in parallel, a failing job does not block the next', async () => {
  const q = createQueue();
  const log = [];
  let releaseA;
  const a = q.run('e1', () => new Promise((r) => (releaseA = () => r(log.push('a done')))));
  const b = q.run('e1', async () => log.push('b'));
  const c = q.run('e2', async () => log.push('c'));
  await c;
  assert.deepEqual(log, ['c'], 'e2 did not wait for e1');
  releaseA();
  await Promise.all([a, b]);
  assert.deepEqual(log, ['c', 'a done', 'b']);
  const failing = q.run('e3', async () => {
    throw new Error('boom');
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await q.run('e3', async () => 'next'), 'next');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(q.size, 0, 'finished keys are forgotten');
});
