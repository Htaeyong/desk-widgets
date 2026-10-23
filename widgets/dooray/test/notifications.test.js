const test = require('node:test');
const assert = require('node:assert/strict');
const { diffPosts, overdueTransitions } = require('../backend/events');
const { stackPositions, capacity, CARD } = require('../../../engine/main/notifications');

const ME = 'me';
const member = (id) => ({ type: 'member', member: { organizationMemberId: id, name: id } });

function post(id, { to = [], from = 'other', cls = 'registered', wf = 'w1', createdAt = '2026-10-16T01:00:00Z', updatedAt = createdAt } = {}) {
  return {
    id,
    subject: `task ${id}`,
    project: { id: 'p1', code: 'P' },
    workflowClass: cls,
    workflow: { id: wf, name: wf },
    users: { from: member(from), to: to.map(member) },
    createdAt,
    updatedAt,
  };
}

const since = Date.parse('2026-10-16T02:00:00Z');
const later = '2026-10-16T03:00:00Z';
const types = (events) => events.map((e) => `${e.type}:${e.post?.id ?? e.task?.id}`).sort();

test('baseline fetch produces no events', () => {
  assert.deepEqual(diffPosts(null, [post('1', { createdAt: later })], [], { meId: ME, since }), []);
});

test('new tasks, assignment, status change and closing are detected', () => {
  const prev = new Map([
    ['a', post('a', { to: ['x'] })],
    ['b', post('b', { to: [ME], wf: 'w1' })],
    ['c', post('c', { to: [ME] })],
    ['d', post('d', { to: ['x'] })],
  ]);
  const next = [
    post('a', { to: ['x', ME], updatedAt: later }), // assigned to me
    post('b', { to: [ME], wf: 'w2', updatedAt: later }), // my task changed status
    post('d', { to: ['x'], wf: 'w2', updatedAt: later }), // someone else's task: ignored
    post('n', { createdAt: later }), // new task by someone else
    post('m', { createdAt: later, from: ME }), // new task I created: ignored
    post('z', { to: [ME], createdAt: later }), // new task assigned to me: "assigned" wins over "created"
    post('old', { createdAt: '2026-10-01T00:00:00Z' }), // newly visible but old: ignored
  ];
  const closed = [post('c', { to: [ME], cls: 'closed', updatedAt: later }), post('x', { to: [ME], cls: 'closed' })];

  const events = diffPosts(prev, next, closed, { meId: ME, since });
  assert.deepEqual(types(events), ['assigned:a', 'assigned:z', 'closed:c', 'created:n', 'status:b']);
  assert.equal(events.find((e) => e.type === 'status').from, 'w1');
});

test('overdue transitions only for tasks seen before and not already overdue', () => {
  const prev = new Map([
    ['1', 'soon'],
    ['2', 'overdue'],
  ]);
  const tasks = [
    { id: '1', dueState: 'overdue' },
    { id: '2', dueState: 'overdue' },
    { id: '3', dueState: 'overdue' },
  ];
  assert.deepEqual(overdueTransitions(prev, tasks).map((e) => e.task.id), ['1']);
  assert.deepEqual(overdueTransitions(null, tasks), []);
});

test('cards stack upwards from the bottom-right without overlapping', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const pos = stackPositions(3, wa);
  assert.equal(pos[0].x, 1920 - CARD.width - CARD.margin);
  assert.equal(pos[0].y, 1040 - CARD.margin - CARD.height);
  for (let i = 1; i < pos.length; i++) {
    assert.equal(pos[i - 1].y - pos[i].y, CARD.height + CARD.gap, 'one card height + gap apart');
  }
});

test('capacity respects the user maximum and the screen height', () => {
  assert.equal(capacity(3, { x: 0, y: 0, width: 1920, height: 1040 }), 3);
  assert.equal(capacity(10, { x: 0, y: 0, width: 1366, height: 400 }), 2);
  assert.equal(capacity(5, { x: 0, y: 0, width: 800, height: 100 }), 1);
});

// ---------- scope, comments and mentions ----------

const { isRelated, commentCandidates, commentEvent, mentions, preview } = require('../backend/events');

function withCc(p, ids) {
  return { ...p, users: { ...p.users, cc: ids.map(member) } };
}

test('scope: assignee, CC and author can each be switched off', () => {
  const p = withCc(post('1', { to: ['x'], from: ME }), [ME]);
  assert.ok(isRelated(p, ME, { assignee: true, cc: false, author: true }), 'author');
  assert.ok(isRelated(p, ME, { assignee: false, cc: true, author: false }), 'cc');
  assert.ok(!isRelated(p, ME, { assignee: true, cc: false, author: false }));
});

test('status change on a CC task notifies only when CC is in scope', () => {
  const prev = new Map([['c', withCc(post('c', { to: ['x'] }), [ME])]]);
  const next = [withCc(post('c', { to: ['x'], wf: 'w2', updatedAt: later }), [ME])];
  assert.equal(diffPosts(prev, next, [], { meId: ME, since, scope: { assignee: true, cc: true, author: true } }).length, 1);
  assert.equal(diffPosts(prev, next, [], { meId: ME, since, scope: { assignee: true, cc: false, author: true } }).length, 0);
});

test('comment candidates are tasks updated since the watermark and since we last saw them', () => {
  const prev = new Map([
    ['a', post('a', { updatedAt: '2026-10-16T01:00:00Z' })],
    ['b', post('b', { updatedAt: later })],
    ['c', post('c', { updatedAt: '2026-10-16T01:00:00Z' })],
  ]);
  const open = [
    post('a', { updatedAt: later }), // changed since last time
    post('b', { updatedAt: later }), // unchanged
    post('n', { createdAt: later }), // brand-new task
    post('v', { createdAt: '2026-10-01T00:00:00Z', updatedAt: later }), // old task we just started seeing
  ];
  const closed = [
    post('c', { cls: 'closed', updatedAt: later }), // was open, now closed with activity
    post('z', { cls: 'closed', updatedAt: later }), // long-closed task: skipped
  ];
  const c = commentCandidates(prev, open, closed, since);
  assert.deepEqual(c.map((x) => [x.post.id, x.isNew]).sort(), [
    ['a', false],
    ['c', false],
    ['n', true],
  ]);
  assert.equal(commentCandidates(null, open, closed, since).length, 0, 'baseline');
});

const log = (id, by, text, createdAt = later) => ({
  id,
  type: 'comment',
  createdAt,
  creator: { member: { organizationMemberId: by, name: by } },
  body: { content: text },
});
const mentionMe = `확인 부탁 [@나](dooray://t/members/${ME} "me") 드립니다`;

test('comment logs become comment or mention events; my own and old comments are ignored', () => {
  const p = post('1');
  const opts = { meId: ME, since, wantComment: true, wantMention: true };
  const logs = [log('l3', 'kim', '두 번째'), log('l2', ME, '제 댓글'), log('l1', 'lee', '첫 번째'), log('l0', 'lee', '옛날', '2026-10-15T00:00:00Z')];

  const c = commentEvent(p, logs, opts);
  assert.equal(c.type, 'comment');
  assert.deepEqual(c.comment, { id: 'l3', authorId: 'kim', author: 'kim', text: '두 번째', count: 2 });

  const m = commentEvent(p, [log('l5', 'kim', '일반'), log('l4', 'lee', mentionMe)], opts);
  assert.equal(m.type, 'mention');
  assert.equal(m.comment.text, '확인 부탁 @나 드립니다');

  assert.equal(commentEvent(p, logs, { ...opts, wantComment: false }), null, 'comments off, no mention');
  assert.equal(commentEvent(p, [log('x', ME, mentionMe)], opts), null, 'mentioning myself');
});

test('mention detection and preview text', () => {
  assert.ok(mentions(mentionMe, ME));
  assert.ok(!mentions(mentionMe, 'someone'));
  assert.equal(preview('**굵게** [링크](http://x) <br> ![img](a.png) 끝'), '굵게 링크 끝');
});
