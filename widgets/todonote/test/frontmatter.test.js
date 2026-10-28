// To-do keys in a note's front matter (#111): reading what Obsidian / VS Code wrote, writing only our lines.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FM = require('../lib/frontmatter');
const md = require('../lib/markdown');
const { Library } = require('../lib/library');

const lines = (text) => md.splitFrontMatter(text).lines;

test('reading: a plain note, our keys, quotes, the T form, any case, the first of a repeated key', () => {
  assert.equal(FM.readTodo([]).due, null);
  const t = FM.readTodo(lines('---\ntags: [보고]\nDue: "2026-11-01T09:00"\nrepeat: \'매달 1일\'\ndue: 2027-01-01\nremind: 30분 전 # 알림\nreset-checks: false\nsource: dooray\nsource-id: 391\nsource-url: https://x.dooray.com/p/391\n---\n# 월간 보고\n'));
  assert.deepEqual(t.due, { date: '2026-11-01', time: '09:00' });
  assert.deepEqual(t.rule, { kind: 'monthly', n: 1, day: 1 });
  assert.deepEqual(t.remind, { kind: 'before', minutes: 30 });
  assert.equal(t.resetChecks, false);
  assert.equal(t.source, 'dooray');
  assert.equal(t.sourceId, '391');
  assert.equal(t.sourceUrl, 'https://x.dooray.com/p/391');
  assert.deepEqual(t.problems, []);
});

test('reading: a wrong value is reported and ignored, a repeat without due is ignored, a non-https url is dropped', () => {
  const t = FM.readTodo(['due: 내일쯤', 'repeat: 매일']);
  assert.equal(t.due, null);
  assert.equal(t.rule, null);
  assert.deepEqual(t.problems, [{ key: 'due', value: '내일쯤' }]);
  const r = FM.readTodo(['due: 2026-11-01', 'repeat: 가끔', 'source-url: javascript:alert(1)']);
  assert.deepEqual(r.due, { date: '2026-11-01', time: null });
  assert.equal(r.rule, null);
  assert.deepEqual(r.problems, [{ key: 'repeat', value: '가끔' }]);
  assert.equal(r.sourceUrl, null);
  assert.equal(FM.readTodo(['repeat: 매일']).problems.length, 0, 'no due: the repeat does not matter');
});

test('writing: our lines change in place, others (and their order) stay, null removes, repeats go', () => {
  const before = ['title: x', 'Due: 2026-01-01', 'tags:', '  - a', 'due: 2027-01-01', 'aliases: [y]'];
  assert.deepEqual(FM.setValues(before, { due: '2026-11-01 09:00', repeat: '매월 1일' }), ['title: x', 'due: 2026-11-01 09:00', 'tags:', '  - a', 'aliases: [y]', 'repeat: 매월 1일']);
  assert.deepEqual(FM.setValues(['due: 2026-01-01', 'a: b'], { due: null, remind: null }), ['a: b']);
  // A key of ours with an empty value owning a list under it: the list goes with it, the next key stays.
  assert.deepEqual(FM.setValues(['due:', '  - x', 'b: c'], { due: '2026-11-01' }), ['due: 2026-11-01', 'b: c']);
  assert.deepEqual(FM.setValues(['tags:', '  - due: 2026-01-01'], { due: '2026-11-01' }), ['tags:', '  - due: 2026-01-01', 'due: 2026-11-01'], 'indented keys are not ours');
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memo-fm-'));
const ids = () => {
  let map = {};
  return { load: () => map, save: (m) => (map = m) };
};

test('the index holds the to-do keys; front matter changes keep the other lines, BOM and CRLF files read', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '보고.md'), '﻿---\r\ntags: [일]\r\ndesk-widgets-memo: abc123\r\ndue: 2026-11-01\r\n---\r\n# 보고\r\n- [x] 하나\r\n');
  fs.writeFileSync(path.join(dir, '그냥.md'), '# 그냥 노트\n');
  fs.writeFileSync(path.join(dir, '깨짐.md'), '---\ndue: 2026-11-01\n# 닫는 줄 없음\n');
  const lib = new Library({ dir, ids: ids() });
  await lib.scan();
  const m = lib.get('abc123');
  assert.deepEqual(m.todo.due, { date: '2026-11-01', time: null });
  assert.equal(lib.list().find((x) => x.title === '그냥').todo, null);
  assert.equal(lib.list().find((x) => x.title === '깨짐').todo, null, 'no closing fence: a plain note');
  const r = await lib.updateFrontMatter('abc123', { due: '2026-11-02 09:00', repeat: '매월 2일' });
  const text = fs.readFileSync(m.file, 'utf8');
  assert.equal(text, '---\ntitle: 보고\ntags: [일]\ndue: 2026-11-02 09:00\nrepeat: 매월 2일\ndesk-widgets-memo: abc123\n---\n# 보고\r\n- [x] 하나\r\n');
  assert.equal(r.body, '# 보고\r\n- [x] 하나\r\n');
  assert.deepEqual(m.todo.rule, { kind: 'monthly', n: 1, day: 2 });
  // The body can change in the same write.
  await lib.updateFrontMatter('abc123', { due: null, repeat: null }, '# 보고\n');
  assert.equal(fs.readFileSync(m.file, 'utf8'), '---\ntitle: 보고\ntags: [일]\ndesk-widgets-memo: abc123\n---\n# 보고\n');
  assert.equal(m.todo, null);
});

test('the done folder: completing moves file and assets under the same name, it is scanned, restored, and found by [[links]]', async () => {
  const dir = tmp();
  const lib = new Library({ dir, ids: ids() });
  const m = await lib.create({ title: '견적서', fm: { due: '2026-10-30' } });
  const name = path.basename(m.file);
  const assets = lib.assetsName(m);
  const body = `![a](${assets}/a.png)
`;
  await lib.write(m.id, body);
  fs.mkdirSync(lib.assetsDir(m));
  fs.writeFileSync(path.join(lib.assetsDir(m), 'a.png'), 'x');
  assert.deepEqual(m.todo.due, { date: '2026-10-30', time: null });
  await lib.updateFrontMatter(m.id, { completed: '2026-10-25 10:00' });
  await lib.complete(m.id);
  // #113: in the done folder the file keeps its name; the title stays in front matter; links unchanged.
  assert.equal(m.file, path.join(dir, '완료', name));
  assert.ok(fs.existsSync(path.join(dir, '완료', assets, 'a.png')));
  assert.equal((await lib.read(m.id)).body, body);
  const lib2 = new Library({ dir, ids: ids() });
  await lib2.scan();
  const again = lib2.get(m.id);
  assert.equal(again.title, '견적서');
  assert.equal(again.done, true);
  assert.equal(again.archived, false);
  assert.equal(again.todo.completedAt, new Date(2026, 9, 25, 10).getTime());
  assert.equal(lib2.findByTitle('견적서').id, m.id);
  // A note of the same title in the notes folder wins over the completed one.
  const other = await lib2.create({ title: '견적서' });
  assert.equal(lib2.findByTitle('견적서').id, other.id);
  await lib2.restore(m.id);
  assert.equal(lib2.get(m.id).done, false);
  assert.equal(lib2.get(m.id).file, path.join(dir, name), 'back under the same file name');
  assert.ok(fs.existsSync(path.join(dir, assets, 'a.png')));
  assert.equal(lib2.get(m.id).title, '견적서');
  assert.equal((await lib2.read(m.id)).body, body);
});
