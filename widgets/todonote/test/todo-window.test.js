// To-do notes from the note window (#111): setting and clearing a date, 완료 (plain and repeating), undo, outside edits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./fake-engine');
const D = require('../lib/dates');

const fmOf = (text) => text.match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n');
const lastMeta = (win) => win.sent.filter(([n]) => n === 'meta').pop()?.[1];

async function openNote(t, title, opts) {
  const file = t.writeNote(title, opts);
  t.setState({ memos: { ...t.state().memos, [opts.id]: { open: true, ...(opts.state || {}) } } });
  return file;
}

test('a plain note stays a plain note: opening, typing and closing add no to-do keys', async () => {
  const t = setup();
  const file = await openNote(t, '장보기', { id: 'plain1', fm: ['tags: [집]'], body: '- [ ] 우유\n' });
  await t.w.start();
  const [win] = t.memoWindows();
  const init = await t.call(win, 'init');
  assert.equal(init.meta.todo, null);
  await t.call(win, 'close');
  // Nothing was typed: the file is not written (its title stays its file name, #113).
  assert.deepEqual(fmOf(t.read(file)), ['tags: [집]', 'desk-widgets-memo: plain1']);
  t.w.stop();
});

test('the date box: a date with repeat and reminder goes into the front matter; clearing keeps other keys', async () => {
  const t = setup();
  const file = await openNote(t, '월간 보고', { id: 'rep1', fm: ['tags: [보고]'], body: '# 절차\n- [x] 집계\n' });
  await t.w.start();
  const [win] = t.memoWindows();
  await t.call(win, 'init');
  const parsed = await t.call(win, 'parseWhen', { text: '매월 1일 오전 9시' });
  assert.equal(parsed.repeat, '매월 1일');
  assert.match(parsed.preview, /1일 \(.\) 오전 9:00 · ↻ 매월 1일$/);
  assert.equal((await t.call(win, 'parseWhen', { text: '내일쯤' })).invalid, true);
  const r = await t.call(win, 'setDue', { due: parsed.due, repeat: '매달 1일', remind: '30분 전', resetChecks: true });
  assert.equal(r.ok, true);
  assert.deepEqual(fmOf(t.read(file)), ['title: 월간 보고', 'tags: [보고]', `due: ${parsed.due}`, 'repeat: 매월 1일', 'remind: 30분 전', 'reset-checks: true', 'desk-widgets-memo: rep1']);
  assert.equal(r.meta.todo.repeat, '매월 1일');
  assert.equal(lastMeta(win).todo.due, parsed.due);
  const cleared = await t.call(win, 'clearDue');
  assert.equal(cleared.meta.todo, null);
  assert.deepEqual(fmOf(t.read(file)), ['title: 월간 보고', 'tags: [보고]', 'desk-widgets-memo: rep1']);
  assert.match(t.read(file), /- \[x\] 집계/, 'the body is untouched');
  t.w.stop();
});

test('repeat choices, "맞출까요?" and the first line suggestion of a new note', async () => {
  const t = setup();
  await openNote(t, '새 노트', { id: 'new1', state: { autoTitle: true } });
  await openNote(t, '이름 있음', { id: 'named1' });
  await t.w.start();
  const [a, b] = t.memoWindows();
  const opts = await t.call(a, 'repeatOptions', { due: '2026-11-02 15:00' });
  assert.deepEqual(opts.items, ['매일', '평일', '매주 월', '매월 2일', '매년 11월 2일', '완료 후 1주', '완료 후 30일']);
  assert.deepEqual(await t.call(a, 'ruleFit', { due: '2026-11-01', repeat: '매월 15일' }), { ok: true, fits: false, aligned: '2026-11-15', alignedText: '11월 15일 (일)' });
  assert.equal((await t.call(a, 'ruleFit', { due: '2026-11-15', repeat: '매월 15일' })).fits, true);
  const s = await t.call(a, 'suggestDue', { line: '보고서 제출 금요일 5시' });
  assert.equal(s.suggestion.phrase, '금요일 5시');
  assert.match(s.suggestion.due, / 17:00$/);
  assert.equal((await t.call(b, 'suggestDue', { line: '보고서 제출 금요일 5시' })).suggestion, null, 'only new (automatically named) notes');
  t.w.stop();
});

test('완료 of a plain to-do: completed is written, the file moves to 완료, the window closes; undo brings it back', async () => {
  const t = setup();
  const file = await openNote(t, '견적서 회신', { id: 'done1', fm: ['due: 2026-10-24'], body: '본문\n' });
  await t.w.start();
  const [win] = t.memoWindows();
  await t.call(win, 'init');
  const r = await t.call(win, 'complete');
  assert.equal(r.ok, true);
  assert.equal(r.repeat, false);
  assert.ok(win.isDestroyed());
  assert.equal(t.state().memos.done1.open, false);
  // #113: the same file name in the done folder.
  const moved = path.join(t.notes, '완료', '견적서 회신.md');
  assert.ok(fs.existsSync(moved));
  assert.ok(!fs.existsSync(file));
  assert.ok(D.parseStamp(fmOf(t.read(moved)).find((l) => l.startsWith('completed: ')).slice(11)) <= Date.now());
  // The list's 되돌리기 (within 8 seconds).
  const list = await t.w.focus();
  assert.equal(list, true);
  await t.until(() => t.listWindow());
  const undo = await t.call(t.listWindow(), 'undoComplete', { id: 'done1' });
  assert.equal(undo.ok, true);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fmOf(t.read(file)), ['title: 견적서 회신', 'due: 2026-10-24', 'desk-widgets-memo: done1']);
  assert.equal(t.memoWindows().length, 1, 'the window opens again');
  t.w.stop();
});

test('완료 of a repeating note: next due, last-done, emptied checklist (not in code), the file stays; undo restores', async () => {
  const t = setup();
  const body = '# 절차\n- [x] 집계\n- [X] 비교\n- [ ] 제출\n```\n- [x] 코드 안\n```\n';
  const file = await openNote(t, '월간 보고', { id: 'rep2', fm: ['due: 2026-09-01 09:00', 'repeat: 매월 1일'], body });
  await t.w.start();
  const [win] = t.memoWindows();
  await t.call(win, 'init');
  const r = await t.call(win, 'complete');
  assert.equal(r.ok, true);
  assert.equal(r.repeat, true);
  assert.equal(r.reset, 2);
  assert.ok(win.isDestroyed());
  assert.ok(fs.existsSync(file), 'a repeating note stays where it is');
  const fm = fmOf(t.read(file));
  const next = D.nextDue(D.parseRepeat('매월 1일'), { date: '2026-09-01', time: '09:00' }, Date.now());
  assert.ok(fm.includes(`due: ${D.formatDueValue(next)}`));
  assert.ok(fm.some((l) => l.startsWith('last-done: ')));
  assert.ok(!fm.some((l) => l.startsWith('completed')));
  assert.equal(t.read(file).split('---\n').slice(2).join('---\n'), '# 절차\n- [ ] 집계\n- [ ] 비교\n- [ ] 제출\n```\n- [x] 코드 안\n```\n');
  assert.equal(t.state().memos.rep2.reopen, true, 'opens again at the next reminder');
  await t.w.focus();
  await t.until(() => t.listWindow());
  assert.equal((await t.call(t.listWindow(), 'undoComplete', { id: 'rep2' })).ok, true);
  assert.equal(t.read(file).split('---\n').slice(2).join('---\n'), body);
  assert.deepEqual(fmOf(t.read(file)), ['title: 월간 보고', 'due: 2026-09-01 09:00', 'repeat: 매월 1일', 'desk-widgets-memo: rep2']);
  t.w.stop();
});

test('reset-checks: false keeps the checklist', async () => {
  const t = setup({ initial: { resetChecks: true } });
  const file = await openNote(t, '기록', { id: 'rep3', fm: ['due: 2026-09-01', 'repeat: 매주 월', 'reset-checks: false'], body: '- [x] 했음\n' });
  await t.w.start();
  const [win] = t.memoWindows();
  await t.call(win, 'init');
  const r = await t.call(win, 'complete');
  assert.equal(r.reset, 0);
  assert.match(t.read(file), /- \[x\] 했음/);
  t.w.stop();
});

test('outside edits of the front matter reach the window; a wrong due is shown, not fixed', async () => {
  const t = setup();
  const file = await openNote(t, '바깥', { id: 'ext1', body: '본문\n' });
  await t.w.start();
  const [win] = t.memoWindows();
  await t.call(win, 'init');
  fs.writeFileSync(file, '---\ndesk-widgets-memo: ext1\ndue: 2026-12-24\n---\n본문\n');
  await t.call(t.listWindow() || win, 'flush');
  await t.w.focus();
  await t.until(() => t.listWindow());
  await t.call(t.listWindow(), 'refresh');
  assert.equal(lastMeta(win).todo.due, '2026-12-24');
  fs.writeFileSync(file, '---\ndesk-widgets-memo: ext1\ndue: 내일쯤\n---\n본문\n');
  await t.call(t.listWindow(), 'refresh');
  assert.equal(lastMeta(win).todo.due, null);
  assert.deepEqual(lastMeta(win).todo.problems, [{ key: 'due', value: '내일쯤' }]);
  assert.match(t.read(file), /due: 내일쯤/, 'the file is not fixed by itself');
  t.w.stop();
});

test('the note menu offers the to-do items', async () => {
  const menus = [];
  const t = setup({ menus });
  await openNote(t, '할 일', { id: 'menu1', fm: ['due: 2026-12-24'] });
  await openNote(t, '노트', { id: 'menu2' });
  await t.w.start();
  const byId = {};
  for (const w of t.memoWindows()) byId[(await t.call(w, 'init')).meta.id] = w;
  const [a, b] = [byId.menu1, byId.menu2];
  await t.call(a, 'menu', {});
  await new Promise((r) => setTimeout(r, 450)); // menus closer than 400 ms apart are one click
  await t.call(b, 'menu', {});
  const labels = (items) => items.map((i) => i.label).filter(Boolean);
  assert.ok(labels(menus[0]).includes('날짜 바꾸기…') && labels(menus[0]).includes('완료') && labels(menus[0]).includes('날짜 지우기 (노트로 되돌리기)'));
  assert.ok(labels(menus[1]).includes('날짜 정하기…') && !labels(menus[1]).includes('완료'));
  t.w.stop();
});
