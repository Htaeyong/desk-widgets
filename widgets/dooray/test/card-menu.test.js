const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCategoryMenu } = require('../card-menu');
const { CategoryStore } = require('../backend/categories');

function setup({ live = null } = {}) {
  const store = new CategoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'card-menu-')), 'categories.json'));
  let published = 0;
  const service = {
    findTask: (id) => (live && live.id === id ? live : null),
    updateCategories(change) {
      const r = change(store);
      published++;
      return r;
    },
  };
  return { store, menu: createCategoryMenu({ categories: store, service }), published: () => published };
}

const task = { id: 't1', key: 'P/1', subject: '업무', projectId: 'p1', projectName: 'P', workflowClass: 'working', workflowName: '진행', assignees: [] };
const event = { type: 'mention', task };

test('category menu: offered for task cards, not for condition alerts', () => {
  const { menu } = setup();
  assert.equal(menu.appliesTo(event), true);
  assert.equal(menu.appliesTo({ type: 'created', task }), true);
  assert.equal(menu.appliesTo({ type: 'rule', rule: {} }), false);
  assert.equal(menu.appliesTo({ type: 'status' }), false);
});

test('category menu: lists categories with colors and toggles the task in and out', () => {
  const { store, menu, published } = setup();
  const a = store.create({ name: '이번 주', color: '#ff5555' });
  const b = store.create({ name: '보고' });
  assert.deepEqual(
    menu.items(event).map((i) => [i.label, i.checked]),
    [
      ['이번 주', false],
      ['보고', false],
    ]
  );
  assert.equal(menu.items(event)[0].color, '#ff5555');

  menu.toggle(event, b.id, true);
  menu.toggle(event, a.id, true);
  assert.deepEqual(store.assignments().t1.categoryIds.sort(), [a.id, b.id].sort());
  assert.equal(store.assignments().t1.task.subject, '업무'); // stored with the event's task copy
  assert.equal(published(), 2); // each change republishes the snapshot (widget updates)

  const after = menu.toggle(event, b.id, false);
  assert.deepEqual(after.map((i) => i.checked), [true, false]);
  menu.toggle(event, a.id, false);
  assert.equal(store.assignments().t1, undefined);
});

test('category menu: uses the live task when the dashboard has it', () => {
  const live = { ...task, subject: '새 제목' };
  const { store, menu } = setup({ live });
  const c = store.create({ name: '분류' });
  menu.toggle(event, c.id, true);
  assert.equal(store.assignments().t1.task.subject, '새 제목');
});

test('category menu: "새 분류" creates the category with the task in it; duplicates are refused', () => {
  const { store, menu } = setup();
  const existing = store.create({ name: '기존' });
  menu.toggle(event, existing.id, true);
  const items = menu.create.run(event, '급함');
  assert.deepEqual(items.map((i) => [i.label, i.checked]), [
    ['기존', true],
    ['급함', true],
  ]);
  assert.equal(store.assignments().t1.categoryIds.length, 2);
  assert.throws(() => menu.create.run(event, '급함'), /같은 이름/);
});
