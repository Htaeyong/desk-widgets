// [[ ]] links between memos (#75): parsing and saving, link index, backlinks, renames that follow, the widget calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const md = require('../lib/markdown');
const { parseHtml, sanitizeHtml } = require('../lib/html');
const { Library } = require('../lib/library');

const ASSETS = '노트.assets';
const html = (src, o = {}) => sanitizeHtml(md.renderHtml(md.parse(src), { assetsDir: ASSETS, ...o }));
const roundTrip = (src) => md.toMarkdown(parseHtml(html(src)), { assetsDir: ASSETS });

test('round trip: [[제목]], [[제목|글자]], [[제목#소제목]], [[폴더/파일.md]], ![[그림]]', () => {
  for (const src of ['[[회의록]] 확인\n', '[[회의록|지난 회의]] 참고\n', '[[회의록#안건]]\n', '[[폴더/회의록.md]]\n', '- [ ] [[장보기]] 정리\n', '| [[a]] | b |\n| --- | --- |\n', '| [[a\\|글]] | b |\n| --- | --- |\n','![[그림.png]]\n']) {
    assert.equal(roundTrip(src), src);
  }
});

test('a table cell written by Obsidian with an unescaped [[a|글]] stays one cell', () => {
  assert.match(html('| [[a|글]] | b |\n| --- | --- |\n'), /<th><a class="wiki" data-wiki="a">글<\/a><\/th><th>b<\/th>/);
});

test('[[ inside code, broken or empty brackets stay text', () => {
  for (const src of ['`[[코드]]`\n', '```\n[[블록]]\n```\n', '[[ ]] 와 [[a\n', '[[a]b]]\n']) {
    const h = html(src);
    assert.doesNotMatch(h, /data-wiki/, src);
  }
});

test('rendered link: class wiki, target kept, missing memos marked', () => {
  const h = html('[[있음]] [[없음|글자]]\n', { wikiExists: (t) => t === '있음' });
  assert.match(h, /<a class="wiki" data-wiki="있음">있음<\/a>/);
  assert.match(h, /<a class="wiki" data-wiki="없음" data-missing="1">글자<\/a>/);
});

test('saving from the editor: edited link text becomes a label; brackets and pipes cannot break the link', () => {
  const tree = parseHtml('<p><a class="wiki" data-wiki="회의록">회의록</a> <a class="wiki" data-wiki="회의록">이번 회의</a> <a class="wiki" data-wiki="a">x]]|y</a></p>');
  assert.equal(md.toMarkdown(tree, { assetsDir: ASSETS }), '[[회의록]] [[회의록|이번 회의]] [[a|x y]]\n');
  // An invalid target does not reach the page.
  assert.equal(sanitizeHtml('<a class="wiki" data-wiki="a]]b">t</a>'), '<a class="wiki">t</a>');
  assert.equal(md.toMarkdown(parseHtml('<p><a class="wiki">글자만</a></p>'), { assetsDir: ASSETS }), '글자만\n');
});

test('wikiKey and collectLinks: by title, case-insensitive, folders, .md and headings ignored', () => {
  assert.equal(md.wikiKey('폴더/회의록.MD#안건'), '회의록');
  assert.equal(md.wikiKey('Note'), 'note');
  assert.deepEqual(md.collectLinks('[[회의록]] [[Note#x]] [b](장보기.md) [c](https://x.test/a.md) `[[아님]]`\n'), ['회의록', 'note', '장보기']);
});

test('relinkTitle: every link form follows the rename; code and other titles are untouched', () => {
  const src = '[[회의록]] [[회의록|글]] [[회의록#안건]] [[폴더/회의록.md]] [[회의록 2]] [x](회의록.md) [y](./회의록.md#a) `[[회의록]]`\n\n```\n[[회의록]]\n```\n';
  assert.equal(
    md.relinkTitle(src, '회의록', '주간 회의'),
    '[[주간 회의]] [[주간 회의|글]] [[주간 회의#안건]] [[폴더/주간 회의.md]] [[회의록 2]] [x](주간%20회의.md) [y](./주간%20회의.md#a) `[[회의록]]`\n\n```\n[[회의록]]\n```\n',
  );
  assert.equal(md.relinkTitle('[[A]] [[a]]', 'a', 'B'), '[[B]] [[B]]', 'case-insensitive like the lookup');
  assert.equal(md.relinkTitle('[a](새%20노트.md)', '새 노트', '장보기'), '[a](장보기.md)');
});

test('#113 relinkTitle with file names apart from titles: [[title]], [[file name]] and relative links', () => {
  const src = '[[회의]] [[회의 (2)|둘째]] [x](회의%20%282%29.md) [[다른]]\n';
  assert.equal(md.relinkTitle(src, '회의', '보고', '회의 (2)', '보고'), '[[보고]] [[보고|둘째]] [x](보고.md) [[다른]]\n');
  // [[회의]] means another memo of that title: only the file name links follow.
  assert.equal(md.relinkTitle(src, null, '보고', '회의 (2)', '보고'), '[[회의]] [[보고|둘째]] [x](보고.md) [[다른]]\n');
  // [[회의 (2)]] means another memo too (its title): only the relative link follows.
  assert.equal(md.relinkTitle(src, null, '보고', '회의 (2)', '보고', false), '[[회의]] [[회의 (2)|둘째]] [x](보고.md) [[다른]]\n');
});

test('#113 front matter title: read in any key case and quoting, written in place or first, quoted when YAML needs it', () => {
  assert.equal(md.frontMatterTitle(['tags: [a]', 'Title: "회의 #1"']), '회의 #1');
  assert.equal(md.frontMatterTitle(["title: '그건 ''예''야'"]), "그건 '예'야");
  assert.equal(md.frontMatterTitle(['title: 장보기 # 주석']), '장보기');
  assert.equal(md.frontMatterTitle(['title:', '  - 목록']), null, 'an empty or list value: no title');
  assert.equal(md.frontMatterTitle(null), null);
  assert.deepEqual(md.withFrontMatterTitle(['tags: [a]'], '회의'), ['title: 회의', 'tags: [a]']);
  assert.deepEqual(md.withFrontMatterTitle(['tags: [a]', 'Title: 옛', 'due: 2026-10-30', 'title: 또'], '새'), ['tags: [a]', 'title: 새', 'due: 2026-10-30']);
  assert.deepEqual(md.withFrontMatterTitle(['title:', '  - a', '  - b', 'x: 1'], '새'), ['title: 새', 'x: 1']);
  for (const title of ['[기획] 회신', '- 목록 같은', '2026-10-27', '123', 'true', 'a #b', "it's", '#해시', 'a "q" b', '회의 (2)', '!중요', '@사람']) {
    const [line] = md.withFrontMatterTitle([], title);
    assert.equal(md.frontMatterTitle([line]), title, `${title} -> ${line}`);
  }
  assert.deepEqual(md.withFrontMatterTitle([], '회의 (2)'), ['title: 회의 (2)']);
  assert.deepEqual(md.withFrontMatterTitle([], '2026-10-27'), ['title: "2026-10-27"']);
});

test('#113 library: the same title twice, files apart; [[제목]] means the newer one, [[file name]] the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wiki-'));
  const lib = new Library({ dir, ids: { load: () => ({}), save() {} } });
  const a = await lib.create({ title: '회의', body: '첫째\n' });
  const b = await lib.create({ title: '회의', body: '둘째\n' });
  // #113: two id-named files, the same title in both.
  const bStem = path.basename(b.file, '.md');
  assert.notEqual(a.file, b.file);
  assert.match(bStem, new RegExp(`^\\d{8}-\\d{6}-${b.id}$`));
  assert.equal(a.title, '회의');
  assert.equal(b.title, '회의');
  const c = await lib.create({ title: '링크', body: `[[회의]] [[${bStem}]]\n` });
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(a.file, past, past);
  await lib.scan();
  assert.equal(lib.findByTitle('회의').id, b.id, 'the most recently changed');
  assert.equal(lib.findByTitle(bStem).id, b.id, 'no such title: by file name');
  assert.deepEqual(lib.backlinks(b.id).map((m) => m.id), [c.id]);
  assert.deepEqual(lib.backlinks(a.id), [], '[[회의]] does not mean this one');
  await lib.write(a.id, '첫째 고침\n');
  assert.equal(lib.findByTitle('회의').id, a.id);
  // A file renamed by another program (or the sync's " (2)") keeps the title from its front matter.
  fs.renameSync(a.file, path.join(dir, '회의 (3).md'));
  await lib.scan();
  assert.equal(lib.get(a.id).title, '회의');
  // A file without a title line (made in Explorer or Obsidian) is titled by its file name.
  fs.writeFileSync(path.join(dir, '외부 노트.md'), '본문\n');
  await lib.scan();
  assert.ok(lib.list().some((m) => m.title === '외부 노트'));
});

test('library: lookup by title and backlinks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wiki-'));
  const lib = new Library({ dir, ids: { load: () => ({}), save() {} } });
  const a = await lib.create({ title: '회의록', body: '안건\n' });
  const b = await lib.create({ title: '할 일', body: '- [ ] [[회의록]] 정리\n' });
  const c = await lib.create({ title: '노트', body: '[보기](회의록.md) [[할 일|todo]]\n' });
  await lib.scan();
  assert.equal(lib.findByTitle('회의록').id, a.id);
  assert.equal(lib.findByTitle('폴더/회의록.md#안건').id, a.id);
  assert.equal(lib.findByTitle('없는 노트'), null);
  assert.deepEqual(lib.backlinks(a.id).map((m) => m.title).sort(), ['노트', '할 일']);
  assert.deepEqual(lib.backlinks(b.id).map((m) => m.title), ['노트']);
  assert.deepEqual(lib.backlinks(c.id), []);
  // A link written later is seen after the write.
  await lib.write(a.id, '[[노트]]\n');
  assert.deepEqual(lib.backlinks(c.id).map((m) => m.title), ['회의록']);
  // An archived memo is found after an open one of the same title.
  await lib.archive(a.id);
  await lib.create({ title: '회의록', body: '' });
  assert.equal(lib.findByTitle('회의록').archived, false);
});
