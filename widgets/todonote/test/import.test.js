// Importing the frozen to-do widget's tasks into notes (#111, design 9.4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const X = require('../lib/external');
const { setup } = require('./fake-engine');

const at = (y, m, d, h = 23, mi = 59) => new Date(y, m - 1, d, h, mi).getTime();
const DATA = {
  lists: [
    { id: 'inbox', name: '' },
    { id: 'work', name: '업무' },
    { id: 'empty', name: '빈 목록' },
  ],
  tasks: [
    { id: 't1', listId: 'work', title: '주간 보고', dueAt: at(2026, 10, 30, 15, 0), dateOnly: false, repeatWeekday: 5, completedAt: null, source: null },
    { id: 't2', listId: 'work', title: '견적서 회신', dueAt: at(2026, 10, 28), dateOnly: true, repeatWeekday: null, completedAt: null, source: { widgetId: 'dooray', itemId: '9', url: 'https://x.dooray.com/project/posts/9' } },
    { id: 't3', listId: 'inbox', title: '우유 사기', dueAt: null, dateOnly: false, repeatWeekday: null, completedAt: null, source: null },
    { id: 't4', listId: 'inbox', title: '*빵*', dueAt: null, dateOnly: false, repeatWeekday: null, completedAt: null, source: null },
    { id: 't5', listId: 'inbox', title: '끝난 일', dueAt: at(2026, 10, 1), dateOnly: true, repeatWeekday: null, completedAt: at(2026, 10, 2, 10, 0), source: null },
    { id: 't6', listId: 'work', title: '끝난 체크', dueAt: null, dateOnly: false, repeatWeekday: null, completedAt: at(2026, 10, 2, 10, 0), source: null },
  ],
};

test('the plan: dated / repeating tasks one note each, undated ones one checklist per list, done ones only on request', () => {
  const plan = X.importPlan(DATA);
  assert.deepEqual(plan.map((n) => [n.kind, n.title, n.folder]), [
    ['list', '할 일 - 할 일', 'notes'],
    ['task', '주간 보고', 'notes'],
    ['task', '견적서 회신', 'notes'],
  ]);
  const [list, weekly, quote] = plan;
  assert.deepEqual(weekly.fm, { due: '2026-10-30 15:00', repeat: '매주 금', source: 'todo', 'source-id': 't1' });
  assert.deepEqual(quote.fm, { due: '2026-10-28', source: 'todo', 'source-id': 't2', 'source-url': 'https://x.dooray.com/project/posts/9' });
  assert.match(quote.body, /\[두레이에서 열기\]\(https:\/\/x\.dooray\.com\/project\/posts\/9\)/);
  assert.equal(list.body, '# 할 일 - 할 일\n\n- [ ] 우유 사기\n- [ ] \\*빵\\*\n');
  assert.deepEqual(list.fm, { source: 'todo', 'source-id': 'list-inbox' });
  const all = X.importPlan(DATA, { includeDone: true });
  const done = all.find((n) => n.title === '끝난 일');
  assert.equal(done.folder, 'done');
  assert.equal(done.fm.completed, '2026-10-02 10:00');
  assert.match(all.find((n) => n.title === '할 일 - 업무').body, /- \[x\] 끝난 체크/);
  assert.deepEqual(X.importPlan(DATA, { has: (k) => ['t1', 't2', 'list-inbox'].includes(k) }), [], 'nothing twice');
});

test('the widget: imports through the engine, makes the notes, a second import makes nothing, needs a new engine', async () => {
  let reads = 0;
  const integrations = { importLegacy: async (id) => (reads++, id === 'todo' ? { ok: true, result: DATA } : { ok: false, code: 'route-denied' }) };
  const t = setup({ integrations });
  await t.w.start();
  const r = await t.w.settings.handlers.importTodo({ includeDone: true });
  assert.equal(r.ok, true);
  assert.equal(r.message, '노트 3개, 체크 목록 노트 2개를 만들었습니다 · 할 일 목록 위젯은 위젯 관리에서 끌 수 있습니다.');
  // #113: imported notes get id file names ("YYYYMMDD-HHmmss-<id>.md"); the title is in front matter.
  const weekly = t.fileByTitle('주간 보고');
  assert.equal(path.dirname(weekly), t.notes);
  assert.match(path.basename(weekly), /^\d{8}-\d{6}-[0-9a-z]+\.md$/);
  const doneFile = t.fileByTitle('끝난 일');
  assert.equal(path.dirname(doneFile), path.join(t.notes, '완료'), 'a done task goes into the done folder');
  assert.match(path.basename(doneFile), /^\d{8}-\d{6}-[0-9a-z]+\.md$/, 'no completion date in the file name');
  assert.match(t.read(weekly), /^---\ntitle: 주간 보고\ncreated: \S+\ndue: 2026-10-30 15:00\nrepeat: 매주 금\nsource: todo\nsource-id: t1\ndesk-widgets-memo: /);
  const list = await t.call(t.listWindow(), 'view', { view: 'todo' });
  assert.ok(list.items.some((m) => m.title === '견적서 회신' && m.todo?.due === '2026-10-28'));
  const again = await t.w.settings.handlers.importTodo({ includeDone: true });
  assert.equal(again.message, '가져올 새 할 일이 없습니다(이미 가져왔거나 완료한 할 일뿐입니다).');
  assert.equal(reads, 2);
  t.w.stop();
  const old = setup();
  await old.w.start();
  assert.match((await old.w.settings.handlers.importTodo({})).message, /엔진 API 1\.7/);
  old.w.stop();
});
