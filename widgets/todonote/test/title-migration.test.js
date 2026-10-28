// The #113 tidy-up of a note folder from before notes had id file names (lib/title-migration.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../lib/library');
const TM = require('../lib/title-migration');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'title-migration-'));
const put = (file, text, mtime = null) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
};
const library = (dir) => new Library({ dir, ids: { load: () => ({}), save() {} } });

async function tidy(dir) {
  const lib = library(dir);
  await lib.scan();
  const result = await TM.apply(TM.plan(lib));
  await lib.scan();
  return { lib, result };
}

/** Every file under dir (relative path -> bytes as text), for comparing two folders. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const CREATED = new Date(2026, 9, 20, 9, 30, 0); // local time: the file name says 20261020-093000

function oldFolder(dir) {
  const past = new Date(2026, 0, 5, 12);
  put(path.join(dir, '회의.md'), '---\ndesk-widgets-memo: aaa111\ntags: [일]\n---\n본문\r\n', past);
  put(path.join(dir, '회의 (2).md'), '---\ndesk-widgets-memo: bbb222\n---\n둘째\n', past);
  put(path.join(dir, '장 (2).md'), '---\ndesk-widgets-memo: ccc333\n---\n직접 지은 이름\n', past);
  put(path.join(dir, '외부.md'), '# 다른 프로그램에서 만든 노트\n', past);
  put(path.join(dir, '텍스트.txt'), '그대로\n', past);
  put(path.join(dir, '만든 때 있음.md'), `---\ncreated: ${CREATED.toISOString()}\ntitle: 만든 때 있음\ndesk-widgets-memo: jjj000\n---\n`, past);
  put(path.join(dir, '20261027-101010-hhh888.md'), '---\ntitle: 이미 새 이름\ndesk-widgets-memo: hhh888\n---\n', past);
  put(path.join(dir, '보관함', '판 (2).md'), '---\ndesk-widgets-memo: ddd444\n---\n보관\n', past);
  put(path.join(dir, '보관함', '판 (3).md'), '---\ndesk-widgets-memo: eee555\n---\n보관\n', past);
  const done = path.join(dir, '완료');
  put(path.join(done, '보고서.md'), '---\ndue: 2026-10-24\ncompleted: 2026-10-25 10:00\ndesk-widgets-memo: fff666\n---\n![a](보고서.assets/a.png)\n', past);
  put(path.join(done, '보고서.assets', 'a.png'), 'x');
  put(path.join(done, '보고서 (2).md'), '---\ndue: 2026-10-24\ncompleted: 2026-10-25 18:00\ndesk-widgets-memo: aab000\n---\n같은 날\n', past);
  put(path.join(done, '날짜 없음.md'), '---\ndue: 2026-10-24\ndesk-widgets-memo: ggg777\n---\n', past);
  // A done file named by the 0.0.4-test.8 build: its title is already in front matter.
  put(path.join(done, '2026-10-24 예전.md'), '---\ncompleted: 2026-10-24 09:00\ntitle: 예전\ndesk-widgets-memo: iii999\n---\n', past);
  put(path.join(done, '손으로.md'), '---\ncompleted: 2026-10-20 10:00\n---\n', past);
  return { past, done };
}

test('old notes get id file names in their folder; titles go into front matter, numbers only go when a sibling explains them', async () => {
  const dir = tmp();
  const { past } = oldFolder(dir);
  const { lib, result } = await tidy(dir);
  assert.deepEqual(result.failed, []);
  const name = (id) => path.relative(dir, lib.get(id).file);
  const title = (id) => lib.get(id).title;
  assert.equal(name('aaa111'), 'aaa111.md', 'no creation time both PCs agree on: the id alone');
  assert.equal(title('aaa111'), '회의');
  assert.equal(name('bbb222'), 'bbb222.md');
  assert.equal(title('bbb222'), '회의', '"회의" exists: the number was added by the old version');
  assert.equal(title('ccc333'), '장 (2)', 'no "장" anywhere: maybe typed by the user');
  assert.equal(name('ddd444'), path.join('보관함', 'ddd444.md'), 'the note stays in its folder');
  assert.equal(title('ddd444'), '판', '"판 (2)" and "판 (3)": numbered siblings');
  assert.equal(title('eee555'), '판');
  assert.equal(name('jjj000'), '20261020-093000-jjj000.md', '"created:" in front matter: the time goes in front');
  assert.equal(name('hhh888'), '20261027-101010-hhh888.md', 'already an id name: kept');
  // Other front matter lines and the body (CRLF too) stay; the change time stays.
  assert.equal(fs.readFileSync(path.join(dir, 'aaa111.md'), 'utf8'), '---\ntitle: 회의\ndesk-widgets-memo: aaa111\ntags: [일]\n---\n본문\r\n');
  assert.equal(fs.statSync(path.join(dir, 'aaa111.md')).mtimeMs, past.getTime());
  assert.ok(!fs.existsSync(path.join(dir, '회의.md')));
  // Files without our id: name and bytes as they were.
  assert.equal(fs.readFileSync(path.join(dir, '외부.md'), 'utf8'), '# 다른 프로그램에서 만든 노트\n');
  assert.equal(fs.readFileSync(path.join(dir, '텍스트.txt'), 'utf8'), '그대로\n');
  assert.equal(lib.list().filter((m) => m.title === '외부').length, 1);
});

test('to-do notes: done files (also "YYYY-MM-DD 제목.md" of test.8) get id names; assets and links follow; the notice says what changed', async () => {
  const dir = tmp();
  const { done } = oldFolder(dir);
  const { lib, result } = await tidy(dir);
  assert.equal(path.basename(lib.get('fff666').file), 'fff666.md');
  assert.equal(path.dirname(lib.get('fff666').file), done);
  assert.ok(fs.existsSync(path.join(done, 'fff666.assets', 'a.png')));
  assert.ok(!fs.existsSync(path.join(done, '보고서.assets')));
  assert.equal((await lib.read('fff666')).body, '![a](fff666.assets/a.png)\n');
  assert.equal(lib.get('aab000').title, '보고서', '"보고서 (2)" next to "보고서": the number goes');
  assert.equal(path.basename(lib.get('ggg777').file), 'ggg777.md', 'no completion date needed any more');
  assert.equal(path.basename(lib.get('iii999').file), 'iii999.md');
  assert.equal(lib.get('iii999').title, '예전');
  assert.ok(fs.existsSync(path.join(done, '손으로.md')), 'not our note: kept');
  // 10 notes with our id renamed (not 20261027-101010-hhh888.md); 회의 (2), 판 (2), 판 (3), 보고서 (2) lose their number.
  assert.equal(result.renamed.length, 10);
  assert.equal(result.changed, 10);
  assert.equal(result.unnumbered, 4);
  assert.equal(TM.noticeText(result), '노트 저장 방식이 바뀌어 기존 노트 10개의 파일 이름을 바꿨습니다. 내용은 그대로이고, 제목 끝에 자동으로 붙었던 번호 4개만 뺐습니다.');
  assert.equal(TM.noticeText({ changed: 2, unnumbered: 0, failed: [], renamed: [{}, {}] }), '노트 저장 방식이 바뀌어 기존 노트 2개의 파일 이름을 바꿨습니다. 제목과 내용은 그대로입니다.');
});

test('running it again changes nothing; two PCs tidying copies of one folder end with the same names and bytes', async () => {
  const one = tmp();
  oldFolder(one);
  const two = tmp();
  fs.cpSync(one, two, { recursive: true });
  await tidy(one);
  const lib = library(one);
  await lib.scan();
  assert.deepEqual(TM.plan(lib), [], 'idempotent');
  await tidy(two);
  assert.deepEqual(snapshot(two), snapshot(one));
});

test('a note that cannot be tidied is left as it was and reported; the others go on', async () => {
  const dir = tmp();
  const { done } = oldFolder(dir);
  const lib = library(dir);
  await lib.scan();
  const items = TM.plan(lib);
  // Something takes the planned name before the rename.
  put(path.join(done, 'fff666.md'), '다른 프로그램이 만든 파일\n');
  const before = fs.readFileSync(path.join(done, '보고서.md'), 'utf8');
  const result = await TM.apply(items);
  assert.deepEqual(result.failed, ['보고서.md']);
  assert.equal(fs.readFileSync(path.join(done, '보고서.md'), 'utf8'), before, 'untouched');
  assert.ok(fs.existsSync(path.join(done, '보고서.assets', 'a.png')));
  assert.equal(fs.readFileSync(path.join(done, 'fff666.md'), 'utf8'), '다른 프로그램이 만든 파일\n');
  assert.equal(result.changed, 9);
  assert.match(TM.noticeText(result), /정리하지 못한 노트 1개\(그대로 둠, 다음에 켤 때 다시 시도\): 보고서\.md\./);
});

test('the widget tidies a folder once at start and says so; again after a restart: nothing; a new old folder: tidied too', async () => {
  const { setup } = require('./fake-engine');
  const t = setup({ initial: { titleFormat: {} } });
  t.writeNote('회의', { id: 'w11111' });
  t.writeNote('회의 (2)', { id: 'w22222' });
  t.writeNote('끝난 일', { id: 'w33333', dir: path.join(t.notes, '완료'), fm: ['due: 2026-10-24', 'completed: 2026-10-25 10:00'] });
  t.writeNote('손으로 만든 노트', {});
  await t.w.start();
  assert.ok(fs.existsSync(path.join(t.notes, '완료', 'w33333.md')));
  assert.match(t.read(path.join(t.notes, 'w22222.md')), /^---\ntitle: 회의\n/);
  assert.ok(fs.existsSync(path.join(t.notes, '손으로 만든 노트.md')), 'a file without our id keeps its name');
  const said = /노트 저장 방식이 바뀌어 기존 노트 3개의 파일 이름을 바꿨습니다/;
  const told = (w) => w.sent.some(([n, p]) => n === 'notice' && said.test(p.message));
  assert.ok(said.test(t.state().notice || '') || (t.listWindow() && told(t.listWindow())));
  assert.equal(t.state().titleFormat[t.notes.toLowerCase()], TM.FORMAT);
  const list = await t.call(t.listWindow(), 'init');
  assert.deepEqual(list.items.filter((i) => i.title === '회의').length, 2);
  t.w.stop();
  t.setState({ notice: '' });
  await t.w.start();
  assert.equal(t.state().notice, '', 'once per folder');
  // Another folder still in the old form: tidied when the note folder changes to it.
  const other = path.join(path.dirname(t.notes), `other-notes-${process.pid}-${Date.now()}`);
  put(path.join(other, '메모 (2).md'), '---\ndesk-widgets-memo: w44444\n---\n', new Date(2026, 0, 1));
  put(path.join(other, '메모.md'), '---\ndesk-widgets-memo: w55555\n---\n', new Date(2026, 0, 1));
  assert.equal((await t.w.settings.save({ notesDir: other })).ok, true);
  assert.ok(await t.until(() => fs.existsSync(path.join(other, 'w44444.md')) && /^---\ntitle: 메모\n/.test(fs.readFileSync(path.join(other, 'w44444.md'), 'utf8'))));
  assert.ok(await t.until(() => t.state().titleFormat[other.toLowerCase()] === TM.FORMAT));
  t.w.stop();
});

test('a folder tidied by a test build (titles only, marker 1) is tidied again for the id names', async () => {
  const { setup } = require('./fake-engine');
  const probe = setup();
  const t = setup({ initial: { notesDir: probe.notes, titleFormat: { [probe.notes.toLowerCase()]: 1 } } });
  t.writeNote('회의', { id: 'v11111', fm: ['title: 회의'], dir: probe.notes });
  await t.w.start();
  assert.ok(fs.existsSync(path.join(probe.notes, 'v11111.md')));
  assert.equal(t.state().titleFormat[probe.notes.toLowerCase()], TM.FORMAT);
  t.w.stop();
});

test('links to renamed files in other notes follow (any folder, encoded, with a heading, into assets); code stays', async () => {
  const dir = tmp();
  const past = new Date(2026, 0, 5, 12);
  put(path.join(dir, '회의 (2).md'), '---\ndesk-widgets-memo: aaa111\n---\n둘째\n', past);
  put(path.join(dir, '회의 (2).assets', 'a.png'), 'png');
  put(path.join(dir, '완료', '보고서.md'), '---\ncompleted: 2026-10-25 10:00\ndesk-widgets-memo: bbb222\n---\n[회의](../회의%20(2).md)\n', past);
  const linker = '---\ndesk-widgets-memo: ccc333\n---\n[a](회의%20(2).md) [b](<회의 (2).md#결정>) ![c](회의%20(2).assets/a.png) [d](완료/보고서.md)\n`[e](완료/보고서.md)`\n';
  put(path.join(dir, '링크.md'), linker, past);
  put(path.join(dir, '손으로.md'), '[x](완료/보고서.md)\n', past);
  const two = tmp();
  fs.cpSync(dir, two, { recursive: true });
  const { lib, result } = await tidy(dir);
  assert.deepEqual(result.failed, []);
  const body = (id) => fs.readFileSync(lib.get(id).file, 'utf8');
  assert.equal(path.basename(lib.get('ccc333').file), 'ccc333.md');
  assert.equal(body('ccc333'), '---\ntitle: 링크\ndesk-widgets-memo: ccc333\n---\n[a](aaa111.md) [b](<aaa111.md#결정>) ![c](aaa111.assets/a.png) [d](완료/bbb222.md)\n`[e](완료/보고서.md)`\n');
  assert.match(body('bbb222'), /\n\[회의\]\(\.\.\/aaa111\.md\)\n$/, 'from another folder');
  assert.equal(fs.readFileSync(path.join(dir, '손으로.md'), 'utf8'), '[x](완료/bbb222.md)\n', 'a note without our id: only its link changes, its name stays');
  assert.equal(fs.statSync(path.join(dir, '손으로.md')).mtimeMs, past.getTime());
  assert.equal(result.relinked, 3);
  assert.match(TM.noticeText(result), /노트 3개 안의 파일 링크도 새 이름으로 고쳤습니다\.$/);
  const again = library(dir);
  await again.scan();
  assert.deepEqual(TM.plan(again), [], 'idempotent');
  await tidy(two);
  assert.deepEqual(snapshot(two), snapshot(dir), 'two PCs agree');
});

test('a numbered title that another note links to as [[X (n)]] keeps its number: the link still finds it after the rename', async () => {
  const dir = tmp();
  put(path.join(dir, '회의.md'), '---\ndesk-widgets-memo: aaa111\n---\n');
  put(path.join(dir, '회의 (2).md'), '---\ndesk-widgets-memo: bbb222\n---\n');
  put(path.join(dir, '회의 (3).md'), '---\ndesk-widgets-memo: ccc333\n---\n');
  put(path.join(dir, '메모.md'), '---\ndesk-widgets-memo: ddd444\n---\n[[회의 (2)|둘째]] [[회의 (2)#결정]]\n');
  const { lib, result } = await tidy(dir);
  assert.equal(lib.get('bbb222').title, '회의 (2)', 'linked by the numbered name: kept');
  assert.equal(lib.get('ccc333').title, '회의', 'nothing links to "회의 (3)": the number goes');
  assert.equal(result.unnumbered, 1);
  assert.equal(lib.findByTitle('회의 (2)').id, 'bbb222');
  assert.equal(fs.readFileSync(lib.get('ddd444').file, 'utf8'), '---\ntitle: 메모\ndesk-widgets-memo: ddd444\n---\n[[회의 (2)|둘째]] [[회의 (2)#결정]]\n');
});
