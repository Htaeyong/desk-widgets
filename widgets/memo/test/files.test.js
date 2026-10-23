// Memo file names and atomic writes (#75).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../lib/files');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memo-files-'));

test('titles become valid Windows file names', () => {
  assert.equal(F.sanitizeTitle('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(F.sanitizeTitle('  끝에 점...  '), '끝에 점');
  assert.equal(F.sanitizeTitle('탭\t줄\n바꿈'), '탭 줄 바꿈');
  assert.equal(F.sanitizeTitle('CON'), 'CON_');
  assert.equal(F.sanitizeTitle('com1.txt'), 'com1.txt_');
  assert.equal(F.sanitizeTitle('console'), 'console');
  assert.equal(F.sanitizeTitle(''), '새 노트');
  assert.equal(F.sanitizeTitle('...'), '새 노트');
  assert.equal(F.sanitizeTitle('???'), '새 노트');
  assert.equal([...F.sanitizeTitle('가'.repeat(200))].length, 80);
  // Emoji are kept whole when cut.
  assert.equal(F.sanitizeTitle('😀'.repeat(100)), '😀'.repeat(80));
  // Decomposed Hangul (e.g. from macOS) becomes composed.
  assert.equal(F.sanitizeTitle('\u1100\u1161'), '가');
});

test('the first line of text names a new memo', () => {
  assert.equal(F.titleFromText('\n\n  장보기 목록  \n우유'), '장보기 목록');
  assert.equal(F.titleFromText(''), '새 노트');
  assert.equal(F.titleFromText('가'.repeat(60)), '가'.repeat(40));
  assert.equal(F.titleFromText('a/b: c?'), 'a b c');
});

test('duplicate names get (2), (3); an assets folder also takes the name', () => {
  const dir = tmp();
  assert.equal(F.uniqueFileName(dir, '노트', 'md').title, '노트');
  fs.writeFileSync(path.join(dir, '노트.md'), '');
  assert.equal(F.uniqueFileName(dir, '노트', 'md').title, '노트 (2)');
  fs.mkdirSync(path.join(dir, '노트 (2).assets'));
  assert.equal(F.uniqueFileName(dir, '노트', 'md').title, '노트 (3)');
  // Case-insensitive like Windows.
  fs.writeFileSync(path.join(dir, 'Note.md'), '');
  assert.equal(F.uniqueFileName(dir, 'note', 'md').title, 'note (2)');
  // Renaming a memo to its own name keeps it.
  assert.equal(F.uniqueFileName(dir, '노트', 'md', { keep: path.join(dir, '노트.md') }).title, '노트');
  // A .txt with the same title does not block a .md.
  fs.writeFileSync(path.join(dir, '텍스트.txt'), '');
  assert.equal(F.uniqueFileName(dir, '텍스트', 'md').title, '텍스트');
});

test('asset names: sanitized, extension kept, duplicates numbered', () => {
  const dir = tmp();
  assert.equal(F.uniqueAssetName(dir, '스크린샷 1.PNG'), '스크린샷 1.PNG');
  fs.writeFileSync(path.join(dir, 'a.png'), '');
  assert.equal(F.uniqueAssetName(dir, 'a.png'), 'a (2).png');
  assert.equal(F.uniqueAssetName(dir, '..\\..\\evil.png'), 'evil.png');
  assert.equal(F.uniqueAssetName(dir, 'x:y.pdf'), 'x y.pdf');
});

test('isInside resolves .. and does not match prefixes', () => {
  assert.equal(F.isInside('C:\\a\\b', 'C:\\a\\b\\c.md'), true);
  assert.equal(F.isInside('C:\\a\\b', 'C:\\a\\b\\..\\c.md'), false);
  assert.equal(F.isInside('C:\\a\\b', 'C:\\a\\bc\\x.md'), false);
  assert.equal(F.isInside('C:\\a\\b', 'C:\\a\\b'), false);
  assert.equal(F.isInside('C:\\a\\b', 'C:\\a\\b', { orSame: true }), true);
});

test('atomic write: new file, overwrite, no temporary files left', async () => {
  const dir = tmp();
  const file = path.join(dir, '노트.md');
  await F.writeFileAtomic(file, '하나');
  assert.equal(fs.readFileSync(file, 'utf8'), '하나');
  await F.writeFileAtomic(file, '둘');
  assert.equal(fs.readFileSync(file, 'utf8'), '둘');
  F.writeFileAtomicSync(file, '셋');
  assert.equal(fs.readFileSync(file, 'utf8'), '셋');
  assert.deepEqual(fs.readdirSync(dir), ['노트.md']);
});

test('atomic write: a failed write keeps the old content and cleans up', async () => {
  const dir = tmp();
  const file = path.join(dir, '노트.md');
  fs.writeFileSync(file, '원래 내용');
  const fsp = {
    ...fs.promises,
    rename: async () => {
      const err = new Error('denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  await assert.rejects(F.writeFileAtomic(file, '새 내용', { retries: 1, fsp }), /denied/);
  assert.equal(fs.readFileSync(file, 'utf8'), '원래 내용');
  assert.deepEqual(fs.readdirSync(dir), ['노트.md']);
  await assert.rejects(F.writeFileAtomic(path.join(dir, 'missing', 'x.md'), 'x'), { code: 'ENOENT' });
});

test('atomic write: a rename refused for a moment is retried', async () => {
  const dir = tmp();
  const file = path.join(dir, '노트.md');
  let fails = 2;
  const fsp = {
    ...fs.promises,
    rename: async (a, b) => {
      if (fails-- > 0) {
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      }
      return fs.promises.rename(a, b);
    },
  };
  await F.writeFileAtomic(file, '됨', { fsp });
  assert.equal(fs.readFileSync(file, 'utf8'), '됨');
});
