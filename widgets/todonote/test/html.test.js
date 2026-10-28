// The sanitizer (#75): what a memo window shows is allow-listed HTML only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHtml, sanitizeTree, parseHtml } = require('../lib/html');

test('scripts, styles, frames, objects and forms are dropped with their content', () => {
  const out = sanitizeHtml('<p>a<script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe><object data="x"></object><form><input type="text" value="x"></form><svg><script>1</script></svg>b</p>');
  assert.equal(out, '<p>ab</p>');
});

test('event handlers and style attributes are removed', () => {
  assert.equal(sanitizeHtml('<p onclick="x()" style="color:red" class="x">a</p><img src="data:image/png;base64,AA==" onerror="x()">'), '<p>a</p><img src="data:image/png;base64,AA==">');
});

test('links: only http(s) and mailto keep an href', () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:x">b</a><a href="file:///C:/x">c</a><a href="data:text/html,x">d</a><a href="https://ok.test/?a=1&amp;b=2">e</a><a href="mailto:me@x.test">f</a><a href="java&#x0A;script:x">g</a>');
  assert.equal(out, '<a>a</a><a>b</a><a>c</a><a>d</a><a href="https://ok.test/?a=1&amp;b=2">e</a><a href="mailto:me@x.test">f</a><a>g</a>');
});

test('images: only inline raster data URLs as src (no remote, file or SVG)', () => {
  const out = sanitizeHtml('<img src="https://x.test/a.png"><img src="file:///C:/a.png"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="data:image/png;base64,iVBO"><img src="//x.test/a.png" alt="a">');
  assert.equal(out, '<img><img><img><img src="data:image/png;base64,iVBO"><img alt="a">');
});

test('unknown elements keep their text; attributes are filtered per element', () => {
  assert.equal(sanitizeHtml('<section><font color="red">글꼴</font><u>밑줄</u></section>'), '글꼴밑줄');
  assert.equal(sanitizeHtml('<ul class="task evil"><li class="task" data-task="x" id="a"><input type="checkbox" checked contenteditable="false" onclick="x"></li></ul>'), '<ul class="task"><li class="task" data-task="x"><input type="checkbox" checked contenteditable="false"></li></ul>');
  assert.equal(sanitizeHtml('<input type="text"><input type="checkbox" contenteditable="true">'), '<input type="checkbox">');
  assert.equal(sanitizeHtml('<a data-asset="../x" data-href="a.md">x</a><a data-asset="ok.pdf" class="attach">y</a>'), '<a data-href="a.md">x</a><a class="attach" data-asset="ok.pdf">y</a>');
  assert.equal(sanitizeHtml('<ol start="3x"><li>a</li></ol><ol start="3"></ol><th data-align="evil">x</th>'), '<ol><li>a</li></ol><ol start="3"></ol><th>x</th>');
});

test('text is escaped, comments and doctype vanish', () => {
  assert.equal(sanitizeHtml('<!doctype html><!-- x --><p>&lt;b&gt; &amp; "따옴표"</p>'), '<p>&lt;b&gt; &amp; "따옴표"</p>');
});

test('broken markup does not escape the allow list', () => {
  assert.equal(sanitizeHtml('<p><img src=x onerror=alert(1)//</p>'), '<p><img></p>');
  assert.equal(sanitizeHtml('<scr<script>ipt>alert(1)</script>'), 'ipt&gt;alert(1)');
  assert.equal(sanitizeHtml('<a href="https://ok.test" <script>x</script>>t</a>'), '<a href="https://ok.test">x&gt;t</a>'); // as a browser reads it: "<script" is an attribute name
});

test('parser: void elements, attributes without quotes, nesting', () => {
  const tree = parseHtml('<p>a<br>b<img alt=x>c</p><ul><li>1<ul><li>2</li></ul></li></ul>');
  assert.equal(tree.children[0].children.length, 5);
  assert.equal(tree.children[0].children[3].attrs.alt, 'x');
  assert.equal(tree.children[1].children[0].children[1].tag, 'ul');
});

test('editor trees from the page are normalized (unknown shapes dropped, depth limited)', () => {
  let deep = { type: 'text', value: 'x' };
  for (let i = 0; i < 100; i++) deep = { type: 'element', tag: 'B', attrs: { 'DATA-ASSET': 1 }, children: [deep] };
  const t = sanitizeTree({ children: [deep, null, 5, { type: 'element' }, { type: 'text', value: 7 }] });
  assert.equal(t.children.length, 2);
  assert.equal(t.children[0].tag, 'b');
  assert.equal(t.children[0].attrs['data-asset'], '1');
  assert.equal(t.children[1].value, '7');
});
