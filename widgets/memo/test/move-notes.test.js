// Moving notes to a newly chosen note folder (#108): copy, check, then originals to the Recycle Bin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { moveNotes, planMove } = require('../lib/move-notes');

function folders(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const from = path.join(root, 'old');
  const to = path.join(root, 'new');
  const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write(from, '회의.md', '---\ndesk-widgets-memo: a\n---\n회의');
  write(from, '회의.assets/표.png', 'png');
  write(from, '메모.txt', '그냥 글');
  write(from, '보관함/지난 일.md', '보관');
  write(from, '완료/끝.md', '완료');
  write(from, 'desktop.ini', 'not a note');
  return { root, from, to, write };
}

const listAll = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).map((p) => p.replace(/\\/g, '/')).sort() : []);

test('notes, their .assets and the subfolders move; other files stay; originals go to the trash', async (t) => {
  const { from, to } = folders(t);
  const trashed = [];
  const r = await moveNotes({ from, to, subfolders: ['보관함', '완료'], trash: async (file) => { trashed.push(path.relative(from, file)); fs.rmSync(file, { recursive: true }); } });
  assert.equal(r.moved, 4);
  assert.deepEqual(listAll(to), ['메모.txt', '보관함', '보관함/지난 일.md', '완료', '완료/끝.md', '회의.assets', '회의.assets/표.png', '회의.md']);
  assert.equal(fs.readFileSync(path.join(to, '회의.assets', '표.png'), 'utf8'), 'png');
  assert.ok(fs.existsSync(path.join(from, 'desktop.ini')), 'files that are not notes stay');
  assert.ok(trashed.includes('회의.assets'));
  assert.equal(r.pathMap[path.resolve(from, '회의.md').toLowerCase()], path.resolve(to, '회의.md').toLowerCase());
  assert.deepEqual(r.leftBehind, []);
});

test('keeping the originals copies only', async (t) => {
  const { from, to } = folders(t);
  const r = await moveNotes({ from, to, subfolders: ['보관함'], keepOriginals: true, trash: async () => assert.fail('nothing goes to the trash') });
  assert.equal(r.moved, 3);
  assert.ok(fs.existsSync(path.join(from, '회의.md')));
  assert.ok(fs.existsSync(path.join(to, '회의.md')));
});

test('a same-name note without attachments gets a free name; with attachments the move is refused', async (t) => {
  const { from, to, write } = folders(t);
  write(to, '메모.txt', '새 폴더의 다른 글');
  const plan = planMove({ from, to, subfolders: ['보관함'] });
  assert.deepEqual(plan.refused, []);
  const r = await moveNotes({ from, to, subfolders: ['보관함'], keepOriginals: true });
  assert.deepEqual(r.renamed, [{ from: '메모.txt', to: '메모 (2).txt' }]);
  assert.equal(fs.readFileSync(path.join(to, '메모.txt'), 'utf8'), '새 폴더의 다른 글', 'the existing file is untouched');
  assert.equal(fs.readFileSync(path.join(to, '메모 (2).txt'), 'utf8'), '그냥 글');
  // A clash for a note with attachments: refused, nothing copied.
  const other = path.join(path.dirname(to), 'third');
  write(other, '회의.md', '이미 있음');
  await assert.rejects(moveNotes({ from, to: other, subfolders: [] }), /첨부 파일이 있어/);
  assert.deepEqual(listAll(other), ['회의.md']);
  assert.ok(fs.existsSync(path.join(from, '회의.md')), 'nothing left the old folder');
});

test('a copy that fails removes what it made and moves nothing', async (t) => {
  const { from, to } = folders(t);
  let copies = 0;
  const flaky = { ...fs, copyFileSync: (...args) => { if (++copies === 3) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fs.copyFileSync(...args); } };
  await assert.rejects(moveNotes({ from, to, subfolders: ['보관함'], fs: flaky }), /ENOSPC/);
  assert.deepEqual(listAll(to).filter((p) => /\.(md|txt|png)$/.test(p)), []);
  assert.ok(fs.existsSync(path.join(from, '회의.md')));
  assert.ok(fs.existsSync(path.join(from, '회의.assets', '표.png')));
});

test('a folder inside the other is refused; the same folder or a missing old folder moves nothing', async (t) => {
  const { from, to } = folders(t);
  await assert.rejects(moveNotes({ from, to: path.join(from, 'sub') }), /따로 떨어진 폴더/);
  await assert.rejects(moveNotes({ from, to: path.dirname(from) }), /따로 떨어진 폴더/);
  assert.equal((await moveNotes({ from, to: from })).moved, 0);
  assert.equal((await moveNotes({ from: path.join(from, 'none'), to })).moved, 0);
});
