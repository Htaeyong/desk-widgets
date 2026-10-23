const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProjectDashboard, effectiveDeadline, DEFAULT_RULES } = require('../backend/aggregate');

const now = new Date('2026-10-16T05:00:00Z');
const rules = { ...DEFAULT_RULES, dueSoonDays: 3 };
const ctx = { meId: 'me', now, rules, webUrl: 'https://x.dooray.com' };

function post(id, overrides = {}) {
  return {
    id,
    subject: `task ${id}`,
    taskNumber: `P/${id}`,
    number: Number(id),
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: `2026-10-${String(10 + Number(id)).padStart(2, '0')}T00:00:00Z`,
    priority: 'none',
    workflowClass: 'registered',
    workflow: { id: 'wf1', name: '접수' },
    users: { from: null, to: [], cc: [] },
    ...overrides,
  };
}

const me = { type: 'member', member: { organizationMemberId: 'me', name: '나' } };
const other = { type: 'member', member: { organizationMemberId: 'o1', name: '동료' } };

test('date-only due dates count until the end of that local day', () => {
  const midnight = new Date(2026, 9, 16, 0, 0, 0);
  assert.equal(effectiveDeadline(midnight.toISOString()).getTime(), new Date(2026, 9, 17).getTime());
  const withTime = new Date(2026, 9, 16, 14, 30, 0);
  assert.equal(effectiveDeadline(withTime.toISOString()).getTime(), withTime.getTime());
  assert.equal(effectiveDeadline(null), null);
});

test('counts, due states and assignee load', () => {
  const posts = [
    post('1', { workflowClass: 'working', workflow: { id: 'wf2', name: '처리중' }, dueDate: '2026-10-10T03:00:00Z', users: { to: [me] } }),
    post('2', { dueDate: '2026-10-17T03:00:00Z', users: { to: [other] } }),
    post('3', { workflowClass: 'backlog', workflow: { id: 'wf0', name: '대기' }, dueDate: '2026-11-30T03:00:00Z', users: { to: [me, other] } }),
    post('4', {}),
  ];
  const dash = buildProjectDashboard({ id: 10, code: '프로젝트' }, posts, { ...ctx, closedRecently: 2 });

  assert.deepEqual(dash.counts, {
    open: 4,
    backlog: 1,
    registered: 2,
    working: 1,
    overdue: 1,
    dueSoon: 1,
    mine: 2,
    unassigned: 1,
    closedRecently: 2,
  });
  assert.equal(dash.id, '10');
  assert.equal(dash.name, '프로젝트');
  assert.deepEqual(dash.tasks.overdue.map((t) => t.id), ['1']);
  assert.deepEqual(dash.tasks.dueSoon.map((t) => t.id), ['2']);
  // Overdue task first, then by updatedAt desc
  assert.deepEqual(dash.tasks.mine.map((t) => t.id), ['1', '3']);
  assert.deepEqual(dash.tasks.recent.map((t) => t.id), ['4', '3', '2', '1']);
  assert.deepEqual(dash.workflows.map((w) => [w.class, w.name, w.count]), [
    ['backlog', '대기', 1],
    ['registered', '접수', 2],
    ['working', '처리중', 1],
  ]);
  const meLoad = dash.assignees.find((a) => a.isMe);
  assert.deepEqual(meLoad, { id: 'me', name: '나', open: 2, working: 1, overdue: 1, isMe: true });
  assert.equal(dash.tasks.open[0].url, 'https://x.dooray.com/project/tasks/4');
});

test('task lists respect taskListLimit', () => {
  const posts = Array.from({ length: 15 }, (_, i) => post(String(i + 1)));
  const dash = buildProjectDashboard({ id: 1, code: 'P' }, posts, { ...ctx, rules: { ...rules, taskListLimit: 5 } });
  assert.equal(dash.tasks.recent.length, 5);
  assert.equal(dash.tasks.open.length, 15);
});

test('task tags are resolved through the tag index', () => {
  const { toTag, buildTask } = require('../backend/aggregate');
  const tagIndex = new Map([
    ['t1', toTag({ id: 't1', name: '고객사: 예시시청', color: 'ECF7FF', tagGroup: { name: '고객사' } })],
    ['t2', toTag({ id: 't2', name: '긴급', color: 'bad', tagGroup: null })],
  ]);
  const task = buildTask(post('1', { tags: [{ id: 't1' }, { id: 't2' }, { id: 'unknown' }] }), { ...ctx, tagIndex });
  assert.deepEqual(task.tags, [
    { id: 't1', name: '고객사: 예시시청', color: '#ECF7FF', group: '고객사' },
    { id: 't2', name: '긴급', color: '', group: null },
  ]);
  assert.deepEqual(buildTask(post('2'), ctx).tags, []);
});

test('projects follow the saved order; unknown ones keep their order at the end', () => {
  const { orderProjects } = require('../backend/aggregate');
  const list = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  assert.deepEqual(orderProjects(list, ['d', 'b', 'gone']).map((p) => p.id), ['d', 'b', 'a', 'c', 'e']);
  assert.deepEqual(orderProjects(list, []).map((p) => p.id), ['a', 'b', 'c', 'd', 'e']);
});

test('personal project ("@id") shows as 개인 프로젝트', () => {
  const { projectLabel } = require('../backend/aggregate');
  assert.equal(projectLabel('@hong'), '개인 프로젝트');
  assert.equal(projectLabel('예시프로젝트(EXAMPLE)'), '예시프로젝트(EXAMPLE)');
  assert.equal(projectLabel(undefined), '');
});

test('client lists shared and personal projects (type=private) once each', async () => {
  const { createClient } = require('../backend/dooray');
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(url);
    seen.push(u.searchParams.get('type'));
    const result = u.searchParams.get('type') === 'private' ? [{ id: 9, code: '@me' }] : [{ id: 1, code: 'a' }, { id: 9, code: '@me' }];
    return new Response(JSON.stringify({ header: { isSuccessful: true }, result, totalCount: result.length }), { status: 200 });
  };
  try {
    const { items } = await createClient({ token: 't' }).listAllMyProjects();
    assert.deepEqual(items.map((p) => p.id), [1, 9]);
    assert.deepEqual(seen, [null, 'private']);
  } finally {
    global.fetch = realFetch;
  }
});
