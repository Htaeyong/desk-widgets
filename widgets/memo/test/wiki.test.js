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
