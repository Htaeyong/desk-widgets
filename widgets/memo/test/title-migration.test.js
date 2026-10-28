// The #113 tidy-up of a note folder from before notes had id file names (lib/title-migration.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../lib/library');
const TM = require('../lib/title-migration');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memo-title-migration-'));
const put = (file, text, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
};

async function tidy(dir) {
  const lib = new Library({ dir, ids: { load: () => ({}), save() {} } });
  await lib.scan();
  const result = await TM.apply(TM.plan(lib));
  await lib.scan();
  return { lib, result };
}

test('sticky notes: id file names, titles into front matter, auto-added numbers go, change times stay; again = nothing', async () => {
  const one = tmp();
  const past = new Date(2026, 0, 5, 12);
  put(path.join(one, '회의.md'), '---\ndesk-widgets-memo: aaa111\n---\n![그림](회의.assets/a.png)\n', past);
  put(path.join(one, '회의.assets', 'a.png'), 'png');
  put(path.join(one, '보관함', '회의 (2).md'), '---\ndesk-widgets-memo: bbb222\n---\n보관\n', past);
  put(path.join(one, '장 (2).md'), '---\ndesk-widgets-memo: ccc333\n---\n', past);
  put(path.join(one, '이미 새 형식.md'), '---\ntitle: 다른 제목\ndesk-widgets-memo: ddd444\n---\n', past);
  put(path.join(one, '손으로.md'), '그냥 메모\n', past);
  const two = tmp();
  fs.cpSync(one, two, { recursive: true });
  const { lib, result } = await tidy(one);
  assert.equal(result.changed, 4);
  assert.equal(result.renamed.length, 4);
  assert.equal(result.unnumbered, 1);
  assert.equal(TM.noticeText(result), '노트 저장 방식이 바뀌어 기존 노트 4개의 파일 이름을 바꿨습니다. 내용은 그대로이고, 제목 끝에 자동으로 붙었던 번호 1개만 뺐습니다.');
  assert.equal(lib.get('bbb222').title, '회의');
  assert.equal(path.relative(one, lib.get('bbb222').file), path.join('보관함', 'bbb222.md'));
  assert.equal(lib.get('ccc333').title, '장 (2)');
  assert.equal(lib.get('ddd444').title, '다른 제목');
  assert.equal(path.basename(lib.get('ddd444').file), 'ddd444.md');
  assert.equal(fs.readFileSync(path.join(one, '보관함', 'bbb222.md'), 'utf8'), '---\ntitle: 회의\ndesk-widgets-memo: bbb222\n---\n보관\n');
  // The assets folder goes with the note, and the image link with it.
  assert.equal(fs.readFileSync(path.join(one, 'aaa111.md'), 'utf8'), '---\ntitle: 회의\ndesk-widgets-memo: aaa111\n---\n![그림](aaa111.assets/a.png)\n');
  assert.equal(fs.readFileSync(path.join(one, 'aaa111.assets', 'a.png'), 'utf8'), 'png');
  assert.equal(fs.statSync(path.join(one, 'aaa111.md')).mtimeMs, past.getTime());
  assert.equal(fs.readFileSync(path.join(one, '손으로.md'), 'utf8'), '그냥 메모\n', 'not our note: untouched');
  assert.deepEqual(TM.plan(lib), []);
  // Another PC with the same files ends with the same names and bytes.
  await tidy(two);
  for (const rel of ['aaa111.md', path.join('aaa111.assets', 'a.png'), path.join('보관함', 'bbb222.md'), 'ccc333.md', 'ddd444.md', '손으로.md']) {
    assert.equal(fs.readFileSync(path.join(two, rel), 'utf8'), fs.readFileSync(path.join(one, rel), 'utf8'));
  }
});
