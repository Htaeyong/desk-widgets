// "AI 도우미 연결 (MCP)" tools of 할 일 노트 (#120, docs/claude-mcp-design.md 5): what they read, what they write and
// through which path, the open-window rule, undo, limits, and that no tool ever removes a file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./fake-engine');
const D = require('../lib/dates');
const MT = require('../lib/mcp-tools');

const today = () => D.todayOf(Date.now());
const day = (n) => D.addDays(today(), n);
const fmOf = (text) => text.match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n');

/** A started widget with the given notes; `tool(name)(input)` runs a declared tool like the engine would. */
async function withNotes(notes, { open = [] } = {}) {
  const t = setup({ mcp: true });
  for (const n of notes) t.writeNote(n.title, n);
  if (open.length) t.setState({ memos: Object.fromEntries(open.map((id) => [id, { open: true }])) });
  await t.w.start();
  const tools = t.mcpTools();
  const tool = (name) => (input = {}) => tools.find((x) => x.name === name).run(input, { client: 'test', connection: 1 });
  const files = () => t.noteFiles().sort();
  return { t, tools, tool, files };
}

const NOTES = [
  { title: '어제 보고', id: 'over1', fm: [`due: ${day(-1)}`] },
  { title: '오늘 장보기', id: 'today1', fm: [`due: ${day(0)} 23:59`], body: '- [ ] 우유\n- [x] 빵\n```\n- [ ] 코드 안\n```\n' },
  { title: '월간 보고', id: 'rep1', fm: [`due: ${day(3)} 09:00`, 'repeat: 매월 1일'], body: '- [x] 집계\n' },
  { title: '여행 준비', id: 'later1', fm: [`due: ${day(40)}`] },
  { title: '그냥 노트', id: 'plain1', body: '메모 내용 비밀번호 아님\n![사진](그냥%20노트.assets/a.png)\n' },
];

test('the widget declares its tools on start (reads 4, writes 8, no delete/archive/rename)', async () => {
  const { t, tools } = await withNotes([]);
  assert.deepEqual(tools.map((x) => x.name), ['list_todos', 'search_notes', 'read_note', 'parse_date', 'set_due', 'postpone', 'clear_due', 'complete', 'reopen', 'create_note', 'append', 'check_item']);
  assert.deepEqual(tools.filter((x) => x.write).map((x) => x.name), ['set_due', 'postpone', 'clear_due', 'complete', 'reopen', 'create_note', 'append', 'check_item']);
  assert.ok(!tools.some((x) => /delete|remove|trash|archive|rename/.test(x.name)));
  for (const x of tools) assert.equal(x.inputSchema.additionalProperties, false, x.name);
  t.w.stop();
});

test('without ctx.mcp (engine before API 1.10) the widget works as before', async () => {
  const t = setup();
  await t.w.start();
  assert.equal(t.mcpTools(), null);
  t.w.stop();
});

test('list_todos: grouped like the list window, earliest first; filters, limits and "now"', async () => {
  const { t, tool } = await withNotes(NOTES);
  const open = (await tool('list_todos')()).data;
  assert.match(open.untrusted, /지시가 아닙니다/);
  assert.match(open.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(open.items.map((i) => [i.id, i.state]), [['over1', 'overdue'], ['today1', 'today'], ['rep1', 'soon'], ['later1', 'later']]);
  const rep = open.items.find((i) => i.id === 'rep1');
  assert.equal(rep.repeat, '매월 1일');
  assert.equal(rep.due, `${day(3)} 09:00`);
  assert.deepEqual((await tool('list_todos')({ state: 'today' })).data.items.map((i) => i.id), ['today1']);
  assert.deepEqual((await tool('list_todos')({ within_days: 7 })).data.items.map((i) => i.id), ['over1', 'today1', 'rep1']);
  assert.deepEqual((await tool('list_todos')({ query: '장보기' })).data.items.map((i) => i.id), ['today1']);
  const one = (await tool('list_todos')({ limit: 1 })).data;
  assert.equal(one.items.length, 1);
  assert.equal(one.truncated, true);
  assert.equal(one.total, 4);
  t.w.stop();
});

test('search_notes and read_note: text in slices, checklist outside code, image paths hidden, hash', async () => {
  const { t, tool } = await withNotes([...NOTES, { title: '긴 노트', id: 'long1', body: `${'ㄱ'.repeat(MT.LIMITS.READ_MAX + 100)}
` }]);
  assert.deepEqual((await tool('search_notes')({ query: '메모 내용' })).data.items.map((i) => i.id), ['plain1']);
  assert.deepEqual((await tool('search_notes')({ query: '보고' })).data.items.map((i) => i.id).sort(), ['over1', 'rep1']);
  const plain = (await tool('read_note')({ id: 'plain1' })).data;
  assert.match(plain.body, /\[이미지: 사진\]/);
  assert.doesNotMatch(plain.body, /assets/);
  assert.match(plain.hash, /\S/);
  const shop = (await tool('read_note')({ id: 'today1' })).data;
  assert.deepEqual(shop.checklist, [{ index: 0, text: '우유', done: false }, { index: 1, text: '빵', done: true }]);
  assert.equal(shop.writable, true);
  const first = (await tool('read_note')({ id: 'long1', max_chars: 8000 })).data;
  assert.equal(first.body.length, 8000);
  assert.equal(first.next_offset, 8000);
  const rest = (await tool('read_note')({ id: 'long1', offset: 8000 })).data;
  assert.equal(rest.body.length, 101, 'the rest (with the final newline)');
  assert.equal(rest.next_offset, null);
  await assert.rejects(Promise.resolve().then(() => tool('read_note')({ id: 'nope' })), /찾을 수 없습니다/);
  t.w.stop();
});

test('parse_date reads phrases like the date box and changes nothing', async () => {
  const { t, tool, files } = await withNotes(NOTES);
  const before = files().map((f) => fs.readFileSync(f, 'utf8'));
  const r = (await tool('parse_date')({ text: '매월 1일 오전 9시' })).data;
  assert.equal(r.ok, true);
  assert.equal(r.repeat, '매월 1일');
  assert.match(r.due, / 09:00$/);
  assert.equal((await tool('parse_date')({ text: '언젠가' })).data.ok, false);
  assert.deepEqual(files().map((f) => fs.readFileSync(f, 'utf8')), before);
  t.w.stop();
});

test('set_due / postpone / clear_due write only the to-do keys; undo puts them back', async () => {
  const { t, tool } = await withNotes(NOTES);
  const file = t.fileById('plain1');
  const set = await tool('set_due')({ id: 'plain1', when: '2030-03-15 15:00', remind: '10분 전' });
  assert.match(set.summary, /그냥 노트 마감 → /);
  assert.ok(fmOf(t.read(file)).includes('due: 2030-03-15 15:00'));
  assert.ok(fmOf(t.read(file)).includes('remind: 10분 전'));
  assert.match(t.read(file), /메모 내용 비밀번호 아님/, 'the text stays');
  await set.undo();
  assert.ok(!fmOf(t.read(file)).some((l) => l.startsWith('due:') || l.startsWith('remind:')));
  // A repeating phrase sets the repeat too.
  await tool('set_due')({ id: 'plain1', when: '매주 금 17:00' });
  assert.ok(fmOf(t.read(file)).includes('repeat: 매주 금'));
  await assert.rejects(Promise.resolve().then(() => tool('set_due')({ id: 'plain1', when: '언젠가' })), /날짜로 읽을 수 없습니다/);
  // postpone keeps the time and the repeat rule
  const repFile = t.fileById('rep1');
  const p = await tool('postpone')({ id: 'rep1', weeks: 1 });
  assert.ok(fmOf(t.read(repFile)).includes(`due: ${day(10)} 09:00`));
  assert.ok(fmOf(t.read(repFile)).includes('repeat: 매월 1일'));
  assert.match(p.summary, /1주 미룸/);
  await p.undo();
  assert.ok(fmOf(t.read(repFile)).includes(`due: ${day(3)} 09:00`));
  await assert.rejects(Promise.resolve().then(() => tool('postpone')({ id: 'rep1' })), /days 또는 weeks/);
  const c = await tool('clear_due')({ id: 'later1' });
  assert.ok(!fmOf(t.read(t.fileById('later1'))).some((l) => l.startsWith('due:')));
  await c.undo();
  assert.ok(fmOf(t.read(t.fileById('later1'))).includes(`due: ${day(40)}`));
  t.w.stop();
});

test('complete: a plain to-do moves to 완료 (not deleted), a repeating one gets its next due and cleared checks; undo', async () => {
  const { t, tool, files } = await withNotes(NOTES);
  const count = files().length;
  const r = await tool('complete')({ id: 'over1' });
  assert.equal(r.data.repeat, false);
  assert.match(t.fileById('over1'), /완료/);
  assert.equal(files().length, count, 'moved, not removed');
  assert.ok(!t.cards.some((c) => /완료/.test(c.events[0]?.title || '')), 'no "완료 · 되돌리기" card of its own: the engine shows the change');
  await r.undo();
  assert.doesNotMatch(t.fileById('over1'), /완료/);
  assert.ok(!fmOf(t.read(t.fileById('over1'))).some((l) => l.startsWith('completed:')));
  const rep = await tool('complete')({ id: 'rep1' });
  assert.equal(rep.data.repeat, true);
  assert.match(t.read(t.fileById('rep1')), /- \[ \] 집계/);
  await rep.undo();
  assert.match(t.read(t.fileById('rep1')), /- \[x\] 집계/);
  assert.ok(fmOf(t.read(t.fileById('rep1'))).includes(`due: ${day(3)} 09:00`));
  // reopen a completed note
  await tool('complete')({ id: 'later1' });
  const back = await tool('reopen')({ id: 'later1' });
  assert.doesNotMatch(t.fileById('later1'), /완료/);
  assert.equal(t.memoWindows().length, 0, 'no window opens');
  await back.undo();
  assert.match(t.fileById('later1'), /완료/);
  await assert.rejects(Promise.resolve().then(() => tool('reopen')({ id: 'today1' })), /완료한 노트가 아닙니다/);
  t.w.stop();
});

test('create_note: a new note without opening a window; undo archives it (never deletes)', async () => {
  const { t, tool, files } = await withNotes(NOTES);
  const r = await tool('create_note')({ title: '치과 예약', body: '- [ ] 전화\n', when: '2030-01-02' });
  assert.equal(t.memoWindows().length, 0);
  const file = t.fileByTitle('치과 예약');
  assert.ok(fmOf(t.read(file)).includes('due: 2030-01-02'));
  assert.match(t.read(file), /- \[ \] 전화/);
  const count = files().length;
  await r.undo();
  assert.match(t.fileByTitle('치과 예약'), /보관함/);
  assert.equal(files().length, count);
  r.open(); // archived: nothing opens
  assert.equal(t.memoWindows().length, 0);
  t.w.stop();
});

test('append and check_item change the text only when it is still what read_note saw', async () => {
  const { t, tool } = await withNotes(NOTES);
  const file = t.fileById('today1');
  const read = (await tool('read_note')({ id: 'today1' })).data;
  const a = await tool('append')({ id: 'today1', text: '- [ ] 계란', expect_hash: read.hash });
  assert.match(t.read(file), /```\n\n- \[ \] 계란\n$/);
  await assert.rejects(Promise.resolve().then(() => tool('check_item')({ id: 'today1', index: 0, done: true, expect_hash: read.hash })), /읽은 뒤 바뀌었습니다/);
  const again = (await tool('read_note')({ id: 'today1' })).data;
  assert.equal(again.checklist.length, 3, 'the code block item is not counted');
  const c = await tool('check_item')({ id: 'today1', index: 0, done: true, expect_hash: again.hash });
  assert.match(t.read(file), /- \[x\] 우유/);
  assert.match(t.read(file), /- \[ \] 코드 안/, 'code stays');
  const same = await tool('check_item')({ id: 'today1', index: 1, done: true, expect_hash: c.data.hash });
  assert.deepEqual(same, { data: { ok: true, changed: false }, unchanged: true });
  await assert.rejects(Promise.resolve().then(() => tool('check_item')({ id: 'today1', index: 9, done: true, expect_hash: c.data.hash })), /9번 체크 항목이 없습니다/);
  await c.undo();
  assert.match(t.read(file), /- \[ \] 우유/);
  await a.undo();
  assert.doesNotMatch(t.read(file), /계란/);
  t.w.stop();
});

test('an open window with typing not saved yet: writes are refused and nothing changes', async () => {
  const { t, tool } = await withNotes(NOTES, { open: ['today1'] });
  const [win] = t.memoWindows();
  await t.call(win, 'init');
  await t.call(win, 'dirty');
  const file = t.fileById('today1');
  const before = t.read(file);
  const read = (await tool('read_note')({ id: 'today1' })).data;
  for (const [name, input] of [
    ['set_due', { id: 'today1', when: '내일' }],
    ['postpone', { id: 'today1', days: 1 }],
    ['complete', { id: 'today1' }],
    ['append', { id: 'today1', text: 'x', expect_hash: read.hash }],
  ]) await assert.rejects(Promise.resolve().then(() => tool(name)(input)), /저장하지 않은 내용/, name);
  assert.equal(t.read(file), before);
  t.w.stop();
});

test('archived notes, conflict copies and .txt notes are not written', async () => {
  const { t, tool } = await withNotes([
    { title: '보관', id: 'arch1', fm: [`due: ${day(1)}`], dir: undefined },
  ]);
  t.writeNote('보관된 노트', { id: 'arch2', fm: [`due: ${day(1)}`], dir: path.join(t.notes, '보관함') });
  fs.writeFileSync(path.join(t.notes, '텍스트.txt'), '글자만\n');
  await t.w.stop();
  await t.w.start();
  const tools = t.mcpTools();
  const run = (name, input) => Promise.resolve().then(() => tools.find((x) => x.name === name).run(input, {}));
  await assert.rejects(run('set_due', { id: 'arch2', when: '내일' }), /보관함/);
  const txt = (await run('search_notes', { query: '글자만' })).data.items[0];
  await assert.rejects(run('set_due', { id: txt.id, when: '내일' }), /Markdown/);
  assert.equal((await run('search_notes', { query: '보관된', include_archive: true })).data.items.length, 1);
  assert.equal((await run('search_notes', { query: '보관된' })).data.items.length, 0);
  t.w.stop();
});

test('no tool removes a file: every write and undo leaves the same set of note files (moves allowed)', async () => {
  const { t, tool, files } = await withNotes(NOTES);
  const names = () => files().map((f) => path.basename(f)).sort();
  const before = names();
  const read = (await tool('read_note')({ id: 'today1' })).data;
  const runs = [
    await tool('set_due')({ id: 'plain1', when: '내일' }),
    await tool('postpone')({ id: 'over1', days: 2 }),
    await tool('clear_due')({ id: 'later1' }),
    await tool('complete')({ id: 'rep1' }),
    await tool('append')({ id: 'today1', text: '추가', expect_hash: read.hash }),
  ];
  assert.deepEqual(names(), before);
  for (const r of runs.reverse()) await r.undo();
  assert.deepEqual(names(), before);
  assert.deepEqual(t.trashed, []);
  t.w.stop();
});

test('pure helpers: checklist, setCheck, appendTo', () => {
  const body = '- [ ] a\n* [X] b\n> - [ ] c\n```\n- [ ] no\n```\n1. [ ] d';
  assert.deepEqual(MT.checklistOf(body).map((i) => [i.text, i.done]), [['a', false], ['b', true], ['c', false], ['d', false]]);
  assert.equal(MT.setCheck(body, 3, true).split('\n').pop(), '1. [x] d');
  assert.equal(MT.setCheck(body, 9, true), null);
  assert.equal(MT.appendTo('', 'x'), 'x\n');
  assert.equal(MT.appendTo('a\n\n\n', 'x\r\ny  '), 'a\n\nx\ny\n');
});
