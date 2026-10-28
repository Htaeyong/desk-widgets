// Completed notes (#111, design 6): the done list, 되살리기, auto-delete timing (decision F) and its settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../lib/todo');
const { setup } = require('./fake-engine');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 25, 12).getTime();
const done = (id, { completedAt = NOW - 40 * DAY, mtimeMs = completedAt, ...extra } = {}) => ({
  id,
  ext: 'md',
  done: true,
  hasFmId: true,
  mtimeMs,
  todo: { due: { date: '2026-09-01', time: null }, rule: null, completedAt, problems: [] },
  ...extra,
});

test('auto-delete counts from the later of completion and the last change (decision F)', () => {
  const memos = [
    done('old'), // completed 40 days ago, untouched
    done('edited', { mtimeMs: NOW - 10 * DAY }), // completed 40 days ago, edited 10 days ago
    done('recent', { completedAt: NOW - 29 * DAY }),
    done('exact', { completedAt: NOW - 30 * DAY }),
  ];
  assert.deepEqual(T.autoDeleteCandidates(memos, NOW, { days: 30 }).map((m) => m.id), ['old', 'exact']);
  assert.deepEqual(T.autoDeleteCandidates(memos, NOW, { days: 7 }).map((m) => m.id), ['old', 'edited', 'recent', 'exact']);
  assert.deepEqual(T.autoDeleteCandidates(memos, NOW, { days: 0 }), [], '삭제 안 함');
  assert.equal(T.deleteText(memos[1], NOW, 30), '20일 뒤 삭제');
  assert.equal(T.deleteText(memos[0], NOW, 30), '곧 삭제');
});

test('auto-delete never touches what is not ours, repeating, open, broken, outside the done folder', () => {
  const memos = [
    done('noid', { hasFmId: false }),
    done('txt', { ext: 'txt' }),
    done('repeat', { todo: { due: { date: '2026-09-01' }, rule: { kind: 'daily', n: 1 }, completedAt: NOW - 40 * DAY, problems: [] } }),
    done('badrepeat', { todo: { due: null, rule: null, completedAt: NOW - 40 * DAY, problems: [{ key: 'repeat', value: '가끔' }] } }),
    done('nocompleted', { todo: { due: { date: '2026-09-01' }, rule: null, completedAt: null, problems: [] } }),
    done('open'),
    done('archived', { done: false, archived: true }),
    done('copy', { conflictOf: 'x' }),
    done('ok'),
  ];
  assert.deepEqual(T.autoDeleteCandidates(memos, NOW, { days: 7, openIds: new Set(['open']) }).map((m) => m.id), ['ok']);
  const many = Array.from({ length: 60 }, (_, i) => done(`n${i}`));
  assert.equal(T.autoDeleteCandidates(many, NOW, { days: 7 }).length, 50, 'at most 50 at a time');
});

test('the widget moves old completed notes to the Recycle Bin at start and tells the list; settings preview', async () => {
  const t = setup({ initial: { autoDeleteDays: 7 } });
  const doneDir = path.join(t.notes, '완료');
  const oldFile = t.writeNote('오래된', { id: 'old1', dir: doneDir, fm: ['due: 2026-01-01', 'completed: 2026-01-02 10:00'] });
  const past = new Date(2026, 0, 2).getTime() / 1000;
  fs.utimesSync(oldFile, past, past);
  fs.mkdirSync(path.join(doneDir, '오래된.assets'));
  const fresh = t.writeNote('방금', { id: 'new1', dir: doneDir, fm: ['due: 2026-01-01', 'completed: 2026-01-02 10:00'] }); // just written: mtime now
  const handmade = path.join(doneDir, '손으로.md');
  fs.writeFileSync(handmade, '---\ncompleted: 2026-01-02 10:00\n---\n');
  fs.utimesSync(handmade, past, past);
  await t.w.start();
  await t.until(() => t.trashed.length >= 2);
  assert.deepEqual(t.trashed.map((p) => path.basename(p)).sort(), ['오래된.assets', '오래된.md']);
  assert.ok(fs.existsSync(fresh), 'edited recently: counted from the change');
  assert.ok(fs.existsSync(handmade), 'no widget id: never deleted');
  // The list is open: the message goes to it right away.
  const told = () => t.listWindow().sent.some(([n, p]) => n === 'notice' && p.message === '자동 삭제: 완료 노트 1개를 휴지통으로 옮겼습니다.');
  assert.ok(await t.until(told));
  assert.equal(t.w.settings.get().autoDeleteDays, 7);
  assert.equal(t.w.settings.handlers.autoDeletePreview(7), 0);
  t.w.stop();
});

test('a Recycle Bin that refuses: nothing is deleted, the list says so', async () => {
  const t = setup({ initial: { autoDeleteDays: 7 } });
  t.electron.shell.trashItem = async () => {
    throw new Error('no recycle bin');
  };
  const file = t.writeNote('오래된', { id: 'old2', dir: path.join(t.notes, '완료'), fm: ['due: 2026-01-01', 'completed: 2026-01-02 10:00'] });
  const past = new Date(2026, 0, 2).getTime() / 1000;
  fs.utimesSync(file, past, past);
  await t.w.start();
  const list = await t.call(t.listWindow(), 'init');
  await t.until(() => /자동 삭제를 하지 못했습니다/.test(t.state().notice) || t.listWindow().sent.some(([n]) => n === 'notice'));
  assert.ok(fs.existsSync(file), 'kept where it was, under its name');
  assert.ok(list);
  t.w.stop();
});

test('the list: four views, to-do items carry their chip, the done view its delete text; 되살리기 opens the note', async () => {
  const t = setup({ initial: { autoDeleteDays: 30 } });
  t.writeNote('그냥', { id: 'pl11' });
  t.writeNote('지난 일', { id: 'od11', fm: ['due: 2020-01-01'] });
  t.writeNote('나중 일', { id: 'lt11', fm: ['due: 2099-01-01', 'repeat: 매년'] });
  const doneFile = t.writeNote('끝난 일', { id: 'dn11', dir: path.join(t.notes, '완료'), fm: ['due: 2020-01-01', 'completed: 2099-01-01 10:00'] });
  await t.w.start();
  const list = t.listWindow();
  const r = await t.call(list, 'view', { view: 'todo' });
  assert.equal(r.view, 'todo');
  const by = Object.fromEntries(r.items.map((m) => [m.id, m]));
  assert.equal(by.pl11.todo, null);
  assert.equal(by.od11.todo.state, 'overdue');
  assert.equal(by.lt11.todo.repeat, '매년');
  assert.equal(by.dn11.done, true);
  assert.match(by.dn11.deleteText, /일 뒤 삭제$/);
  assert.equal((await t.call(list, 'view', { view: 'nonsense' })).view, 'memos');
  await t.call(list, 'uncomplete', { id: 'dn11' });
  assert.ok(!fs.existsSync(doneFile));
  // #113: back in the notes folder under the same file name.
  assert.equal(t.fileById('dn11'), path.join(t.notes, '끝난 일.md'));
  assert.ok(!/completed:/.test(t.read(path.join(t.notes, '끝난 일.md'))));
  assert.equal(t.memoWindows().length, 1);
  t.w.stop();
});

test('settings: the to-do values are kept within their ranges', async () => {
  const t = setup();
  t.w.settings.save({ snoozeMinutes: 500, allDayRemind: '25:00', autoDeleteDays: 3, reopenRepeat: false, resetChecks: false });
  const s = t.w.settings.get();
  assert.equal(s.snoozeMinutes, 120);
  assert.equal(s.allDayRemind, '09:00');
  assert.equal(s.autoDeleteDays, 30);
  assert.equal(s.reopenRepeat, false);
  assert.equal(s.resetChecks, false);
  t.w.settings.save({ allDayRemind: '' });
  assert.equal(t.w.settings.get().allDayRemind, '');
});
