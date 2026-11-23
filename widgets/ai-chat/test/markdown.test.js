// An answer's Markdown (#129): the to-do note widget's parser, copied unchanged, and a renderer that never makes HTML, a link
// element or an image. The drawn page is checked in page.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { WIDGET_DIR } = require('./helpers');

const ROOT = path.join(WIDGET_DIR, '..', '..');
const COPY = path.join(WIDGET_DIR, 'chat', 'markdown-parse.js');
const VIEW = path.join(WIDGET_DIR, 'chat', 'markdown-view.js');
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

/** The page's parser, loaded as the page loads it. */
function pageParser() {
  const window = {};
  vm.runInNewContext(read(COPY), { window });
  // Results cross from the page's realm: compare them as plain data.
  return { keys: Object.keys(window.AiChatMarkdown), parse: (md) => JSON.parse(JSON.stringify(window.AiChatMarkdown.parse(md))) };
}

test('the parser is the to-do note widget\'s, unchanged: a fix there must be copied here', () => {
  const copy = read(COPY);
  const body = copy.slice(copy.indexOf('// ---- copy start ----\n') + '// ---- copy start ----\n'.length, copy.indexOf('\n// ---- copy end ----'));
  assert.equal(body, read(path.join(ROOT, 'widgets', 'todonote', 'lib', 'markdown.js')).trimEnd());
  assert.deepEqual(pageParser().keys, ['parse']);
});

test('the shapes an answer uses: headings, tables with alignment and escaped pipes, rules, lists, tasks, quotes, code', () => {
  const { parse } = pageParser();
  const md = [
    '## 📅 내일 내 일정',
    '',
    '| 시간 | 일정 | 장소 |',
    '|:---|:---:|---:|',
    '| 09:00 | 회의 a \\| b | `x|y` |',
    '',
    '---',
    '- [x] 준비 끝',
    '- [ ] 자료 출력',
    '  1. 첫째',
    '> 인용 **굵게** *기울임* ~~취소~~',
    '```js',
    'const a = 1;',
    '```',
  ].join('\n');
  const blocks = parse(md);
  assert.deepEqual(blocks.map((b) => b.t), ['heading', 'table', 'hr', 'list', 'quote', 'code']);
  const table = blocks[1];
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.deepEqual(table.rows[0][1], [{ t: 'text', v: '회의 a | b' }]);
  assert.deepEqual(table.rows[0][2], [{ t: 'code', v: 'x|y' }]);
  assert.deepEqual(blocks[3].items.map((i) => i.checked), [true, false]);
  assert.equal(blocks[3].items[1].children[1].t, 'list');
  assert.deepEqual(blocks[4].children[0].children.filter((n) => n.t !== 'text').map((n) => n.t), ['strong', 'em', 'del']);
  assert.equal(blocks[5].text, 'const a = 1;');
});

test('attacks stay words: HTML, script links, images, and broken Markdown', () => {
  const { parse } = pageParser();
  const inline = (md) => parse(md)[0].children;
  const html = inline('<script>alert(1)</script><img src=http://x/y.png>');
  assert.equal(html[0].v, '<script>alert(1)</script><img src=', 'tags are text');
  assert.deepEqual(html.map((n) => n.t), ['text', 'link', 'text'], 'only the bare address becomes a link, which the view checks');
  const js = inline('[a](javascript:alert(1))').find((n) => n.t === 'link');
  assert.equal(js.href, 'javascript:alert(1)', 'the parser keeps it; the view refuses it below');
  assert.equal(inline('![x](http://127.0.0.1/p.png)')[0].t, 'img');
  for (const broken of ['**열림', '| a |\n|--', '```\n열린 코드', '[a](', '> > > > > > > > > > > > > > > > > > > > > > > > > > > > > > 깊음', `${'['.repeat(5000)}x`, `${'*'.repeat(20000)}`]) {
    assert.doesNotThrow(() => parse(broken), broken.slice(0, 20));
  }
});

test('a long answer parses quickly enough to redraw while it streams', () => {
  const { parse } = pageParser();
  const chunk = '## 제목\n\n| a | b |\n|---|---|\n| 1 | **2** |\n\n- 항목 [링크](https://example.com) `code`\n\n';
  const md = chunk.repeat(2000); // about 140 KB
  const started = process.hrtime.bigint();
  parse(md);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1500, `${ms} ms`);
});

test('the view: only web addresses become links, and it makes no HTML, link element, image or input', () => {
  const window = {};
  vm.runInNewContext(read(VIEW), { window, URL, document: {} });
  const { webAddress } = window.AiChatMarkdownView;
  assert.equal(webAddress('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(webAddress('http://xn--9n2bp8q.com/'), 'http://xn--9n2bp8q.com/');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:x', 'data:text/html,x', 'file:///C:/x', 'vbscript:x', 'ftp://x', 'about:blank', '//evil.example', 'relative/path', '']) {
    assert.equal(webAddress(bad), null, bad);
  }
  const source = read(VIEW);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.href\s*=|\.src\s*=|setAttribute\('(?:href|src|style|on)/);
  for (const tag of ['a', 'img', 'script', 'iframe', 'input', 'object', 'embed', 'style', 'link', 'svg']) {
    assert.doesNotMatch(source, new RegExp(`el\\('${tag}'|createElement\\('${tag}'`), tag);
  }
});
