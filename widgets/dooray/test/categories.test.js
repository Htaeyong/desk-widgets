const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CategoryStore, CategoryError } = require('../backend/categories');
const { buildCategories, buildTask, DEFAULT_RULES } = require('../backend/aggregate');

const now = new Date('2026-10-16T05:00:00Z');
const ctx = { meId: 'me', now, rules: DEFAULT_RULES, webUrl: 'https://x.dooray.com' };

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dooray-cat-'));
  return new CategoryStore(path.join(dir, 'categories.json'));
}

function task(id, overrides = {}) {
  return buildTask(
    {
      id,
      subject: `task ${id}`,
      project: { id: 'p1', code: '프로젝트' },
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: `2026-10-${String(10 + Number(id)).padStart(2, '0')}T00:00:00Z`,
      workflowClass: 'registered',
      workflow: { id: 'w', name: '접수' },
      users: { to: [] },
      ...overrides,
    },
    ctx
  );
}

test('create, rename, validate and persist categories', () => {
  const store = tempStore();
  const a = store.create({ name: '  이번 주   집중 ' });
  assert.equal(a.name, '이번 주 집중');
  assert.match(a.color, /^#[0-9a-f]{6}$/i);
  assert.throws(() => store.create({ name: '이번 주 집중' }), CategoryError);
  assert.throws(() => store.create({ name: '   ' }), CategoryError);
  assert.throws(() => store.create({ name: 'x'.repeat(31) }), CategoryError);
  assert.throws(() => store.update(a.id, { color: 'red' }), CategoryError);

  store.update(a.id, { name: '집중', color: '#112233' });
  const reloaded = new CategoryStore(store.filePath);
  assert.deepEqual(reloaded.categories(), [{ id: a.id, name: '집중', color: '#112233' }]);
});

test('assign tasks, delete category, clean up closed tasks', () => {
  const store = tempStore();
  const a = store.create({ name: 'A' });
  const b = store.create({ name: 'B' });

  store.setTaskCategories(task('1'), [a.id, b.id, 'unknown']);
  store.setTaskCategories(task('2', { workflowClass: 'closed' }), [a.id]);
  assert.deepEqual(store.assignments()['1'].categoryIds, [a.id, b.id]);

  // Empty list removes the assignment
  store.setTaskCategories(task('3'), [b.id]);
  store.setTaskCategories(task('3'), []);
  assert.equal(store.assignments()['3'], undefined);

  // Removing a category drops it from tasks and deletes empty assignments
  store.remove(a.id);
  assert.deepEqual(store.assignments()['1'].categoryIds, [b.id]);
  assert.equal(store.assignments()['2'], undefined);

  store.setTaskCategories(task('4', { workflowClass: 'closed' }), [b.id]);
  assert.equal(store.removeClosed(b.id), 1);
  assert.deepEqual(Object.keys(store.assignments()), ['1']);

  store.move(b.id, -1);
  assert.equal(store.categories()[0].id, b.id);
});

test('buildCategories merges live data, cached copies and ordering', () => {
  const defs = [{ id: 'c1', name: '집중', color: '#7aa7ff' }];
  const overdue = task('1', { dueDate: '2026-10-10T03:00:00Z' });
  const normal = task('2');
  const closedCached = task('3', { workflowClass: 'closed' });
  const goneCached = task('4');
  const assignments = {
    1: { categoryIds: ['c1'], task: { ...overdue, subject: 'old' } },
    2: { categoryIds: ['c1'], task: normal },
    3: { categoryIds: ['c1'], task: closedCached },
    4: { categoryIds: ['c1'], task: goneCached },
  };
  const live = new Map([
    ['1', overdue],
    ['2', normal],
    ['3', closedCached],
  ]);

  const [c] = buildCategories(defs, assignments, live, { now, rules: DEFAULT_RULES });
  assert.deepEqual(c.counts, { total: 4, open: 3, overdue: 1, dueSoon: 0, closed: 1 });
  assert.deepEqual(c.tasks.map((t) => t.id), ['1', '4', '2', '3']);
  assert.equal(c.tasks[0].subject, 'task 1', 'live data wins over cache');
  assert.equal(c.tasks.find((t) => t.id === '4').stale, true);
  assert.equal(c.tasks.find((t) => t.id === '3').dueState, 'none');
  assert.deepEqual(c.tasks[0].categoryIds, ['c1']);
});
