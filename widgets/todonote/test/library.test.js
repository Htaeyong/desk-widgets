// The notes folder (#75): ids, renames, conflict copies, archive, .txt memos and the .assets copy rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library, relinkAssets } = require('../lib/library');
const F = require('../lib/files');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-lib-'));
  let ids = {};
  const trashed = [];
  const lib = new Library({
    dir,
    ids: { load: () => ids, save: (m) => (ids = m) },
    trash: async (p) => {
      trashed.push(p);
      fs.rmSync(p, { recursive: true, force: true });
    },
  });
  return { dir, lib, ids: () => ids, trashed };
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('new memos are files with our id in front matter; scanning finds them again by id', async () => {
  const { dir, lib } = setup();
  const before = Date.now();
  const m = await lib.create({ title: '장보기', body: '- [ ] 우유\n' });
  // #113: "YYYYMMDD-HHmmss-<id>.md" from the creation time, which is also in front matter.
  assert.ok(m.created >= before && m.created <= Date.now());
  assert.equal(m.file, path.join(dir, `${F.idFileStem(m.id, m.created)}.md`));
  assert.match(path.basename(m.file), new RegExp(`^\\d{8}-\\d{6}-${m.id}\\.md$`));
  assert.equal(fs.readFileSync(m.file, 'utf8'), `---\ntitle: 장보기\ncreated: ${new Date(m.created).toISOString()}\ndesk-widgets-memo: ${m.id}\n---\n- [ ] 우유\n`);
  const fresh = new Library({ dir, ids: { load: () => ({}), save() {} } });
  await fresh.scan();
  assert.equal(fresh.get(m.id).title, '장보기');
  assert.equal(fresh.get(m.id).preview, '우유');
});

test('a memo renamed by another program keeps its id and title (front matter); one without front matter keeps it by path', async () => {
  const { dir, lib, ids } = setup();
  const m = await lib.create({ title: '하나', body: '본문\n' });
  write(path.join(dir, '외부.md'), '앞 내용 없음\n');
  write(path.join(dir, '옛 노트.txt'), '텍스트 노트\n');
  await lib.scan();
  const outside = lib.list().find((x) => x.title === '외부');
  const txt = lib.list().find((x) => x.title === '옛 노트');
  assert.equal(txt.ext, 'txt');
  assert.ok(Object.values(ids()).includes(outside.id), 'the id is remembered by path');
  fs.renameSync(m.file, path.join(dir, '둘.md'));
  const changes = await lib.scan();
  // The title is in the front matter (#113): a new file name alone does not change it.
  assert.equal(lib.get(m.id).title, '하나');
  assert.equal(path.basename(lib.get(m.id).file), '둘.md');
  assert.deepEqual(changes.moved, [m.id]);
  assert.equal(lib.list().find((x) => x.title === '외부').id, outside.id, 'same id on the next scan');
  // Our first write adds the id to its front matter, keeping the body.
  await lib.write(outside.id, '앞 내용 없음\n고침\n');
  assert.match(fs.readFileSync(path.join(dir, '외부.md'), 'utf8'), new RegExp(`^---\\ntitle: 외부\\ndesk-widgets-memo: ${outside.id}\\n---\\n앞 내용 없음\\n고침\\n$`));
  // A .txt memo is written as plain text, without front matter.
  await lib.write(txt.id, '고친 텍스트\n');
  assert.equal(fs.readFileSync(path.join(dir, '옛 노트.txt'), 'utf8'), '고친 텍스트\n');
});

test('other front matter (e.g. Obsidian properties) is kept when saving', async () => {
  const { dir, lib } = setup();
  write(path.join(dir, '속성.md'), '---\ntags: [일]\naliases: []\n---\n본문\n');
  await lib.scan();
  const m = lib.list()[0];
  const r = await lib.read(m.id);
  assert.equal(r.body, '본문\n');
  await lib.write(m.id, '새 본문\n');
  assert.equal(fs.readFileSync(m.file, 'utf8'), `---\ntitle: 속성\ntags: [일]\naliases: []\ndesk-widgets-memo: ${m.id}\n---\n새 본문\n`);
});

test('a conflict copy (same id in two files) keeps the original and marks the copy', async () => {
  const { dir, lib } = setup();
  const m = await lib.create({ title: '회의', body: '원본\n' });
  await lib.scan();
  // OneDrive names its copies "<name>-<PC name>.md".
  write(path.join(dir, '회의-DESKTOP-AB12.md'), fs.readFileSync(m.file, 'utf8').replace('원본', '다른 PC에서 고침'));
  await lib.scan();
  // The copy has the same title in its front matter (#113); its file name tells them apart.
  const copy = lib.list().find((x) => x.conflictOf === m.id);
  assert.equal(path.basename(copy.file), '회의-DESKTOP-AB12.md');
  assert.equal(copy.title, '회의');
  assert.equal(lib.get(m.id).title, '회의');
  assert.notEqual(copy.id, m.id);
  assert.equal(copy.conflictOf, m.id);
  assert.equal(copy.hasFmId, false);
  // Its id is stable across scans, and writing it gives the copy its own id.
  await lib.scan();
  assert.equal(lib.list().find((x) => path.basename(x.file) === '회의-DESKTOP-AB12.md').id, copy.id);
  await lib.write(copy.id, '다른 PC에서 고침\n');
  await lib.scan();
  assert.equal(lib.get(copy.id).conflictOf, null);
  assert.equal(lib.get(m.id).title, '회의');
});

test('rename only rewrites the front matter title: file, assets folder and links stay (#113)', async () => {
  const { dir, lib } = setup();
  const m = await lib.create({ title: '여행', body: '' });
  const file = m.file;
  const assets = lib.assetsName(m);
  const name = await lib.addAssetBytes(m.id, '지도.png', Buffer.from([137, 80, 78, 71]));
  const body = `![지도](${assets}/${encodeURIComponent(name)}) [표](<${assets}/a b.pdf>)\n`;
  await lib.write(m.id, body);
  await lib.rename(m.id, '제주 여행');
  assert.equal(lib.get(m.id).file, file, 'file name unchanged');
  assert.ok(fs.existsSync(path.join(dir, assets, '지도.png')), 'assets folder unchanged');
  assert.equal(lib.get(m.id).title, '제주 여행');
  assert.match(fs.readFileSync(file, 'utf8'), /^---\ntitle: 제주 여행\n/);
  assert.equal((await lib.read(m.id)).body, body, 'links unchanged');
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(file), assets].sort());
  // A title another note has: both keep it, no file gets a number; the same title again is a no-op.
  const other = await lib.create({ title: '겹침' });
  await lib.rename(m.id, '겹침');
  assert.equal(lib.get(m.id).title, '겹침');
  assert.equal(lib.get(other.id).title, '겹침');
  assert.equal(lib.get(m.id).file, file);
  assert.ok(!fs.readdirSync(dir).some((f) => / \(2\)/.test(f)));
  assert.match(fs.readFileSync(lib.get(m.id).file, 'utf8'), /^---\ntitle: 겹침\n/);
  const before = lib.get(m.id).mtimeMs;
  await lib.rename(m.id, '겹침');
  assert.equal(lib.get(m.id).mtimeMs, before);
  // Invalid characters are replaced.
  await lib.rename(m.id, 'a/b:c');
  assert.equal(lib.get(m.id).title, 'a b c');
});

test('relinkAssets only touches link destinations of that folder', () => {
  const body = '![a](옛.assets/a.png) 옛.assets/ 글자 [b](./옛.assets/b.pdf) [c](옛.assets2/c.png) [d](%EC%98%9B.assets/d.png)\n';
  assert.equal(relinkAssets(body, '옛.assets', '새 이름.assets'), '![a](새%20이름.assets/a.png) 옛.assets/ 글자 [b](새%20이름.assets/b.pdf) [c](옛.assets2/c.png) [d](새%20이름.assets/d.png)\n');
});

test('archive and restore move the memo and its assets; trash uses the Recycle Bin callback', async () => {
  const { dir, lib, trashed } = setup();
  const m = await lib.create({ title: '보관할 것', body: '' });
  await lib.addAssetBytes(m.id, 'x.png', Buffer.from([1]));
  const name = path.basename(m.file);
  const assets = lib.assetsName(m);
  // #113: the same file name in every folder.
  await lib.archive(m.id);
  assert.ok(fs.existsSync(path.join(dir, '보관함', name)));
  assert.ok(fs.existsSync(path.join(dir, '보관함', assets, 'x.png')));
  await lib.scan();
  assert.equal(lib.get(m.id).archived, true);
  assert.equal(lib.get(m.id).title, '보관할 것');
  await lib.restore(m.id);
  assert.ok(fs.existsSync(path.join(dir, name)));
  await lib.scan();
  assert.equal(lib.get(m.id).archived, false);
  await lib.trash(m.id);
  assert.deepEqual(trashed.map((p) => path.basename(p)), [name, assets]);
  assert.equal(lib.get(m.id), null);
});

test('a .txt memo converted to Markdown keeps its text and id; the .txt moves to the archive', async () => {
  const { dir, lib } = setup();
  write(path.join(dir, '할일.txt'), '# 해시\n- 대시\n');
  await lib.scan();
  const t = lib.list()[0];
  const m = await lib.convertToMd(t.id);
  assert.equal(m.id, t.id);
  assert.equal(m.ext, 'md');
  assert.equal((await lib.read(t.id)).body, '\\# 해시\n\\- 대시\n');
  assert.ok(fs.existsSync(path.join(dir, '보관함', '할일.txt')));
  assert.ok(!fs.existsSync(path.join(dir, '할일.txt')));
  await lib.scan();
  assert.equal(lib.get(t.id).ext, 'md');
});

test('.assets copy rules: image types, size, folders, files already there, path traversal', async () => {
  const { dir, lib } = setup();
  const m = await lib.create({ title: '첨부', body: '' });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-src-'));
  write(path.join(src, '보고서.pdf'), 'pdf');
  write(path.join(src, '사진.JPG'), 'jpg');
  const a = await lib.addAssetFile(m.id, path.join(src, '보고서.pdf'));
  assert.deepEqual(a, { name: '보고서.pdf', image: false });
  const b = await lib.addAssetFile(m.id, path.join(src, '보고서.pdf'));
  assert.equal(b.name, '보고서 (2).pdf', 'a second copy gets a new name');
  assert.equal((await lib.addAssetFile(m.id, path.join(src, '사진.JPG'))).image, true);
  // A file already in this memo's assets folder is linked, not copied.
  const inside = await lib.addAssetFile(m.id, path.join(lib.assetsDir(m), '보고서.pdf'));
  assert.equal(inside.name, '보고서.pdf');
  assert.equal(fs.readdirSync(lib.assetsDir(m)).length, 3);
  await assert.rejects(lib.addAssetFile(m.id, src), /폴더/);
  await assert.rejects(lib.addAssetFile(m.id, path.join(src, '없음.pdf')), { code: 'ENOENT' });
  await assert.rejects(lib.addAssetBytes(m.id, 'x.svg', Buffer.from('<svg/>')), /PNG/);
  await assert.rejects(lib.addAssetBytes(m.id, 'x.png', Buffer.alloc(21 * 1024 * 1024)), /20MB/);
  assert.equal(await lib.addAssetBytes(m.id, '..\\..\\x.png', Buffer.from([1])), 'x.png');
  assert.ok(fs.existsSync(path.join(lib.assetsDir(m), 'x.png')));
  // No temporary files are left in the assets folder.
  assert.ok(!fs.readdirSync(lib.assetsDir(m)).some((f) => f.endsWith('.tmp')));
  // Resolving: only names inside this memo's assets folder.
  assert.equal(lib.resolveAsset(m.id, '보고서.pdf'), path.join(lib.assetsDir(m), '보고서.pdf'));
  for (const bad of ['../첨부.md', '..', '.', 'sub/x', 'C:\\Windows\\win.ini', '', '없는 파일.pdf']) assert.equal(lib.resolveAsset(m.id, bad), null, bad);
  write(path.join(dir, 'img', 'a.png'), 'x');
  assert.equal(lib.resolveRelative(m.id, 'img/a.png'), path.join(dir, 'img', 'a.png'));
  for (const bad of ['../x.png', 'C:/Windows/win.ini', '\\\\server\\x.png', '/etc/passwd']) assert.equal(lib.resolveRelative(m.id, bad), null, bad);
});

test('temporary files, other extensions and subfolders are not memos', async () => {
  const { dir, lib } = setup();
  write(path.join(dir, '.노트.md.ab12.tmp'), 'x');
  write(path.join(dir, '.hidden.md'), 'x');
  write(path.join(dir, 'image.png'), 'x');
  write(path.join(dir, 'sub', '안쪽.md'), 'x');
  fs.mkdirSync(path.join(dir, '폴더.md'));
  write(path.join(dir, '진짜.MD'), 'x');
  await lib.scan();
  assert.deepEqual(lib.list().map((m) => m.title), ['진짜']);
});

test('changes: content changed outside, removed, added', async () => {
  const { dir, lib } = setup();
  const m = await lib.create({ title: '감시', body: 'a\n' });
  await lib.scan();
  const before = fs.statSync(m.file).mtimeMs;
  fs.writeFileSync(m.file, fs.readFileSync(m.file, 'utf8') + 'b\n');
  fs.utimesSync(m.file, new Date(), new Date(before + 5000));
  let c = await lib.scan();
  assert.deepEqual(c.changed, [m.id]);
  fs.unlinkSync(m.file);
  c = await lib.scan();
  assert.deepEqual(c.removed, [m.id]);
  write(path.join(dir, '새것.md'), 'x');
  c = await lib.scan();
  assert.equal(c.added.length, 1);
});
