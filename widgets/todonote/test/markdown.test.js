// Markdown <-> editor HTML (#75): every supported element must come back as the same Markdown after a trip through
// the editor's HTML (rendered, sanitized, parsed like the page's DOM tree).
const test = require('node:test');
const assert = require('node:assert/strict');
const md = require('../lib/markdown');
const { parseHtml, sanitizeHtml } = require('../lib/html');

const ASSETS = '장보기.assets';
const html = (src, images) => sanitizeHtml(md.renderHtml(md.parse(src), { assetsDir: ASSETS, images }));
const back = (h) => md.toMarkdown(parseHtml(h), { assetsDir: ASSETS });
const roundTrip = (src) => back(html(src));

const SAME = {
  'heading levels': '# 제목 1\n\n## 제목 2\n\n### 제목 3\n\n###### 제목 6\n',
  'paragraphs and line breaks (one newline is a break)': '첫 줄\n둘째 줄\n\n새 문단\n',
  'bold, italic, strike, inline code': '**굵게** *기울임* ~~취소선~~ `코드` 그리고 한글\n',
  'nested marks': '**굵게 *안쪽* 끝**\n',
  'code block with language': '```js\nconst a = 1;\n// <b>그대로</b>\n```\n',
  'code block without language and with backticks inside': '````\n```\n안쪽 펜스\n```\n````\n',
  'bullet list with nesting': '- 하나\n- 둘\n  - 중첩\n  - 중첩 둘\n- 셋\n',
  'numbered list from 3': '3. 셋\n4. 넷\n',
  'numbered list inside a bullet list': '- 항목\n  1. 하위 하나\n  2. 하위 둘\n',
  'checkbox list': '- [ ] 우유 사기\n- [x] 빵 사기\n',
  'checkbox list nested': '- [ ] 할 일\n  - [x] 하위 완료\n',
  'quote with a list': '> 인용 첫 줄\n> 둘째 줄\n>\n> - 인용 안 목록\n',
  links: '[네이버](https://www.naver.com) 와 [메일](mailto:me@example.com)\n',
  'bare URL': '주소 https://example.com/a_b?x=1 끝\n',
  'link with title': '[문서](https://example.com "설명")\n',
  'horizontal rule': '위\n\n---\n\n아래\n',
  'table with alignment and pipe': '| 이름 | 수량 | 노트 |\n| --- | :---: | ---: |\n| 사과 | 3 | a \\| b |\n| **배** | 1 |  |\n',
  'image in assets folder': '![영수증](장보기.assets/영수증%201.png)\n',
  'attachment link': '[견적서.pdf](장보기.assets/견적서.pdf)\n',
  'relative image elsewhere in the folder': '![그림](images/a.png)\n',
  'remote image (kept, not loaded)': '![로고](https://example.com/logo.png)\n',
  'other memo link': '[다른 노트](다른%20노트.md)\n',
  'escaped characters': '별표 \\* 밑줄 \\_x\\_ snake_case 백틱 \\` [a\\](b) 그리고 1. 목록 아님\n',
  'line-start markers stay text': '\\# 제목 아님\n\n\\- 목록 아님\n\n\\> 인용 아님\n',
  'raw HTML stays text': '<b>굵게 아님</b> <script>alert(1)</script>\n',
  'empty paragraph kept': '위\n\n&nbsp;\n\n아래\n',
  'entity-like text': 'AT\\&amp;T 그대로\n',
  'two lists in a row stay two lists': '- 가\n- 나\n\n* 다\n',
  'Korean only': '오늘 할 일: 은행, 우체국, 병원 예약\n',
};

for (const [name, src] of Object.entries(SAME)) {
  test(`round trip: ${name}`, () => {
    assert.equal(roundTrip(src), src);
  });
}

test('normalized forms read back the same (setext, * bullets, numbering, angle destinations)', () => {
  assert.equal(roundTrip('제목\n===\n'), '# 제목\n');
  assert.equal(roundTrip('* a\n* b\n'), '- a\n- b\n');
  assert.equal(roundTrip('1. a\n1. b\n'), '1. a\n2. b\n');
  assert.equal(roundTrip('__굵게__ _기울임_\n'), '**굵게** *기울임*\n');
  assert.equal(roundTrip('**a*b** _c_\n'), '**a\\*b** *c*\n');
  assert.equal(roundTrip('![a](<장보기.assets/a b.png>)\n'), '![a](장보기.assets/a%20b.png)\n');
  // Loose list items keep their paragraphs.
  assert.equal(roundTrip('- a\n\n  두 번째 문단\n- b\n'), '- a\n\n  두 번째 문단\n- b\n');
});

test('rendered HTML: images get data URLs only from the given map, others stay placeholders', () => {
  const images = new Map([['asset:a.png', 'data:image/png;base64,AAAA']]);
  const h = html('![a](장보기.assets/a.png) ![b](장보기.assets/b.png) ![c](https://x.test/c.png)\n', images);
  const imgs = [...h.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 3);
  assert.ok(imgs[0].includes('data-asset="a.png"') && imgs[0].includes('src="data:image/png;base64,AAAA"') && !imgs[0].includes('data-missing'));
  assert.ok(imgs[1].includes('data-asset="b.png"') && imgs[1].includes('data-missing="1"') && !/ src=/.test(imgs[1]));
  assert.ok(imgs[2].includes('data-src="https://x.test/c.png"') && imgs[2].includes('data-missing="1"') && !/ src=/.test(imgs[2]));
});

test('rendered HTML: only http(s)/mailto links get an href', () => {
  const h = html('[a](javascript:alert(1)) [b](file:///C:/x) [c](https://ok.test) [d](data:text/html,x)\n');
  assert.match(h, /<a data-href="javascript:alert\(1\)">a<\/a>/);
  assert.match(h, /<a data-href="file:\/\/\/C:\/x">b<\/a>/);
  assert.match(h, /<a href="https:\/\/ok\.test">c<\/a>/);
  assert.doesNotMatch(h, / href="(javascript|file|data):/);
  // ...and they are written back as they were.
  assert.equal(back(h), '[a](javascript:alert(1)) [b](file:///C:/x) [c](https://ok.test) [d](data:text/html,x)\n');
});

test('task list HTML has clickable checkboxes and the checked state comes back from the DOM', () => {
  const h = html('- [ ] a\n- [x] b\n');
  assert.match(h, /<ul class="task"><li class="task" data-task=" "><input type="checkbox" contenteditable="false">a<\/li><li class="task" data-task="x"><input type="checkbox" checked contenteditable="false">b<\/li><\/ul>/);
  // The page sends the live checkbox state as a "checked" attribute.
  const tree = parseHtml('<ul class="task"><li class="task" data-task=" "><input type="checkbox" checked>a</li><li><input type="checkbox">b</li></ul>');
  assert.equal(md.toMarkdown(tree, { assetsDir: ASSETS }), '- [x] a\n- [ ] b\n');
});

test('editor DOM quirks: divs, b/i/strike, spans, stray <br>, nbsp, lists nested directly in lists', () => {
  const tree = parseHtml(
    '<div>첫&nbsp;&nbsp;줄<br></div><div><b>굵게</b> <i>기울</i> <strike>취소</strike> <span style="font-weight: 700">진하게</span> <font>글꼴</font></div>' +
      '<ul><li>a</li><ul><li>a-1</li></ul><li>b</li></ul><p><br></p><p><br></p>',
  );
  assert.equal(md.toMarkdown(tree, { assetsDir: ASSETS }), '첫  줄\n\n**굵게** *기울* ~~취소~~ **진하게** 글꼴\n\n- a\n  - a-1\n- b\n');
});

test('marks around spaces and empty marks', () => {
  const tree = parseHtml('<p>a<b> 굵게 </b>b<i></i>c</p>');
  assert.equal(md.toMarkdown(tree, { assetsDir: ASSETS }), 'a **굵게** bc\n');
});

test('inline code with backticks and a zero-width placeholder', () => {
  assert.equal(md.toMarkdown(parseHtml('<p><code>a`b</code> <code>\u200b</code>x</p>'), { assetsDir: ASSETS }), '``a`b`` x\n');
  assert.equal(roundTrip('``a`b``\n'), '``a`b``\n');
});

test('front matter: our id is read, other lines are kept, id is added once', () => {
  const src = '---\ntags: [집]\ndesk-widgets-memo: abc123\n---\n본문\n';
  const fm = md.splitFrontMatter(src);
  assert.equal(fm.id, 'abc123');
  assert.deepEqual(fm.lines, ['tags: [집]', 'desk-widgets-memo: abc123']);
  assert.equal(fm.body, '본문\n');
  assert.equal(md.joinFrontMatter(fm.lines, 'abc123', fm.body), src);
  assert.equal(md.joinFrontMatter(null, 'new1', '본문\n'), '---\ndesk-widgets-memo: new1\n---\n본문\n');
  assert.equal(md.splitFrontMatter('본문만\n').id, null);
  assert.equal(md.splitFrontMatter('---\ndesk-widgets-memo: ../../x\n---\n').id, null, 'ids are plain names');
  assert.equal(md.splitFrontMatter('\ufeff---\r\ndesk-widgets-memo: crlf01\r\n---\r\n본문').body, '본문');
});

test('plain text: list preview and .txt conversion keep every line', () => {
  assert.equal(md.toPlainText('# 제목\n\n- [ ] **할 일**\n'), '제목\n할 일');
  const converted = md.textToMarkdown('# 해시로 시작\n- 대시\n*별*\n\n\n다음');
  assert.equal(converted, '\\# 해시로 시작\n\\- 대시\n\\*별\\*\n\n다음\n');
  assert.equal(md.toPlainText(converted), '# 해시로 시작\n- 대시\n*별*\n다음');
});

test('destinations: encoded for spaces and parentheses, classified per memo', () => {
  assert.equal(md.encodeDest('장보기.assets/a (1).png'), '장보기.assets/a%20%281%29.png');
  assert.deepEqual(md.classifyDest('장보기.assets/a%20b.png', ASSETS), { kind: 'asset', value: 'a b.png' });
  assert.equal(md.classifyDest('장보기.assets/../x.png', ASSETS).kind, 'relative');
  assert.equal(md.classifyDest('장보기.assets/sub/x.png', ASSETS).kind, 'relative');
  assert.equal(md.classifyDest('JavaScript:alert(1)', ASSETS).kind, 'other');
  assert.equal(md.classifyDest('\\\\server\\share\\x', ASSETS).kind, 'other');
});

test('large and odd input does not hang', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `- [${i % 2 ? 'x' : ' '}] 항목 ${i} **굵게** _a_ \`c\` [l](https://e.test/${i})`).join('\n') + '\n';
  const t = Date.now();
  assert.equal(roundTrip(big), big.replace(/_a_/g, '*a*'));
  assert.ok(Date.now() - t < 5000);
  assert.doesNotThrow(() => roundTrip('*'.repeat(5000) + '_'.repeat(5000) + '['.repeat(2000) + '`'.repeat(2000)));
});
