// Titles apart from file names (#113): a note the widget makes is "YYYYMMDD-HHmmss-<id>.md" for good, its title in
// front matter; completing, un-completing, archiving and renaming never change the name ("(2)" only for a clash with
// another file in the target folder); which note [[제목]] means.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../lib/library');
const md = require('../lib/markdown');
const F = require('../lib/files');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todonote-title-'));
  const lib = new Library({ dir, ids: { load: () => ({}), save() {} } });
  return { dir, lib };
}

const names = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
const titleOf = (file) => md.frontMatterTitle(md.splitFrontMatter(fs.readFileSync(file, 'utf8')).lines);
const idName = (m) => `${F.idFileStem(m.id, m.created)}.md`;

async function completeAt(lib, id, stamp) {
  await lib.updateFrontMatter(id, { completed: stamp });
  return lib.complete(id);
}

test('the same title twice: two id-named files, both keep the title', async () => {
  const { dir, lib } = setup();
  const a = await lib.create({ title: '주간 보고' });
  const b = await lib.create({ title: '주간 보고' });
  assert.notEqual(a.file, b.file);
  assert.deepEqual(names(dir), [idName(a), idName(b)].sort());
  assert.ok(!names(dir).some((n) => n.includes('주간 보고') || / \(2\)/.test(n)), 'no title and no number in the file names');
  assert.equal(a.title, '주간 보고');
  assert.equal(b.title, '주간 보고');
  assert.equal(titleOf(a.file), '주간 보고');
  assert.equal(titleOf(b.file), '주간 보고');
  const again = new Library({ dir, ids: { load: () => ({}), save() {} } });
  await again.scan();
  assert.deepEqual(again.list().map((m) => m.title), ['주간 보고', '주간 보고']);
});

test('completing moves the file into the done folder under the same name; the title never changes', async () => {
  const { dir, lib } = setup();
  const done = path.join(dir, '완료');
  const a = await lib.create({ title: '보고서', fm: { due: '2026-10-24' } });
  const b = await lib.create({ title: '보고서', fm: { due: '2026-10-25' } });
  const c = await lib.create({ title: '보고서', fm: { due: '2026-10-26' } });
  const before = [a, b, c].map((m) => path.basename(m.file));
  await completeAt(lib, a.id, '2026-10-25 10:00');
  await completeAt(lib, b.id, '2026-10-25 18:00');
  await completeAt(lib, c.id, '2026-10-26 09:00');
  assert.deepEqual([a, b, c].map((m) => lib.get(m.id).file), before.map((n) => path.join(done, n)), 'same names, no completion date in front');
  assert.deepEqual(names(done), [...before].sort());
  assert.deepEqual([a, b, c].map((m) => lib.get(m.id).title), ['보고서', '보고서', '보고서']);
  assert.equal(titleOf(lib.get(b.id).file), '보고서');
  assert.deepEqual(names(dir), [], 'nothing left in the notes folder');
  // [[보고서]] with no open-able note: the most recently completed one.
  assert.equal(lib.findByTitle('보고서').id, c.id);
  // An open-able note of that title comes first.
  const d = await lib.create({ title: '보고서' });
  assert.equal(lib.findByTitle('보고서').id, d.id);
});

test('a clash in the target folder (another file of that name) gets " (2)"; the title stays, the assets and links follow', async () => {
  const { dir, lib } = setup();
  const m = await lib.create({ title: '정리', fm: { due: '2026-10-24' } });
  const stem = path.basename(m.file, '.md');
  await lib.write(m.id, `![a](${stem}.assets/a.png)\n`);
  fs.mkdirSync(lib.assetsDir(m));
  fs.writeFileSync(path.join(lib.assetsDir(m), 'a.png'), 'x');
  // Another file (e.g. copied in by hand) already has this name in the done folder.
  fs.mkdirSync(path.join(dir, '완료'));
  fs.writeFileSync(path.join(dir, '완료', `${stem}.md`), '남의 파일\n');
  await completeAt(lib, m.id, '2026-10-25 10:00');
  assert.equal(lib.get(m.id).file, path.join(dir, '완료', `${stem} (2).md`));
  assert.equal(fs.readFileSync(path.join(dir, '완료', `${stem}.md`), 'utf8'), '남의 파일\n', 'the other file is untouched');
  assert.equal(lib.get(m.id).title, '정리');
  assert.equal(titleOf(lib.get(m.id).file), '정리');
  assert.ok(fs.existsSync(path.join(dir, '완료', `${stem} (2).assets`, 'a.png')));
  assert.equal((await lib.read(m.id)).body, `![a](${md.encodeDest(`${stem} (2).assets`)}/a.png)\n`);
  // An old done note without a title line is titled by its file name (no migration).
  fs.writeFileSync(path.join(dir, '완료', '옛 완료.md'), '---\ndue: 2026-01-01\ncompleted: 2026-01-02 10:00\n---\n본문\n');
  await lib.scan();
  assert.ok(lib.list().some((x) => x.title === '옛 완료' && x.done));
  assert.equal(lib.get(m.id).title, '정리');
});

test('un-completing goes back under the same file name; assets and links stay as they were', async () => {
  const { dir, lib } = setup();
  const m = await lib.create({ title: '견적', fm: { due: '2026-10-24' } });
  const name = path.basename(m.file);
  const assets = lib.assetsName(m);
  const body = `![a](${assets}/a.png)\n`;
  await lib.write(m.id, body);
  fs.mkdirSync(lib.assetsDir(m));
  fs.writeFileSync(path.join(lib.assetsDir(m), 'a.png'), 'x');
  await completeAt(lib, m.id, '2026-10-25 10:00');
  assert.equal(lib.get(m.id).file, path.join(dir, '완료', name));
  assert.ok(fs.existsSync(path.join(dir, '완료', assets, 'a.png')));
  await lib.updateFrontMatter(m.id, { completed: null });
  await lib.restore(m.id);
  assert.equal(lib.get(m.id).file, path.join(dir, name));
  assert.ok(fs.existsSync(path.join(dir, assets, 'a.png')));
  assert.equal((await lib.read(m.id)).body, body);
  // A new note of the same title does not take its name: the second round trip keeps it too.
  await completeAt(lib, m.id, '2026-10-26 10:00');
  const other = await lib.create({ title: '견적' });
  assert.notEqual(path.basename(other.file), name);
  await lib.restore(m.id);
  assert.equal(lib.get(m.id).file, path.join(dir, name));
  assert.equal(lib.get(m.id).title, '견적');
  assert.equal((await lib.read(m.id)).body, body);
});

test('rename: only the front matter title changes, never the file, its assets folder or image links; also in the done folder', async () => {
  const { dir, lib } = setup();
  const plan = await lib.create({ title: '계획' });
  const m = await lib.create({ title: '초안' });
  const file = m.file;
  const assets = lib.assetsName(m);
  await lib.addAssetBytes(m.id, 'a.png', Buffer.from([1]));
  const body = `![a](${assets}/a.png)\n`;
  await lib.write(m.id, body);
  await lib.rename(m.id, '계획');
  assert.equal(lib.get(m.id).title, '계획');
  assert.equal(lib.get(plan.id).title, '계획', 'the other note keeps the title too');
  assert.equal(lib.get(m.id).file, file, 'file name unchanged, no " (2)"');
  assert.equal(titleOf(file), '계획');
  await lib.rename(m.id, '최종');
  assert.equal(lib.get(m.id).file, file);
  assert.equal(titleOf(file), '최종');
  assert.ok(fs.existsSync(path.join(dir, assets, 'a.png')), 'assets folder unchanged');
  assert.equal((await lib.read(m.id)).body, body, 'image links unchanged');
  // A done note renamed: the same file name in the done folder, only the title changes.
  await lib.updateFrontMatter(m.id, { due: '2026-10-24' });
  await completeAt(lib, m.id, '2026-10-25 10:00');
  await lib.rename(m.id, '최종 보고');
  assert.equal(lib.get(m.id).file, path.join(dir, '완료', path.basename(file)));
  assert.equal(titleOf(lib.get(m.id).file), '최종 보고');
  assert.ok(fs.existsSync(path.join(dir, '완료', assets, 'a.png')));
  assert.equal((await lib.read(m.id)).body, body);
});

test('a note moved to the archive and back writes its title, so a numbered file name never becomes the title', async () => {
  const { dir, lib } = setup();
  fs.writeFileSync(path.join(dir, '메모.md'), '---\ndesk-widgets-memo: abc123\n---\n본문\n');
  fs.mkdirSync(path.join(dir, '보관함'));
  fs.writeFileSync(path.join(dir, '보관함', '메모.md'), '다른 노트\n');
  await lib.scan();
  await lib.archive('abc123');
  assert.equal(path.basename(lib.get('abc123').file), '메모 (2).md');
  assert.equal(titleOf(lib.get('abc123').file), '메모');
  await lib.scan();
  assert.equal(lib.get('abc123').title, '메모');
});
