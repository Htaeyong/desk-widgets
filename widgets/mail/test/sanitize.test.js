// The preview's HTML sanitizer and document (#65): scripts, frames, objects, forms, event handlers and
// javascript: links never reach the preview; remote images are counted and blocked by the CSP until allowed.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/sanitize');
const { requestAllowed, documentUrl, MAX_DATA_URL } = require('../lib/preview');

const clean = (html, opts) => S.sanitizeHtml(html, opts).html;

test('drops scripts, frames, objects, forms, svg and their content; keeps the text around them', () => {
  const out = clean('<p>a</p><script>alert(1)</script><iframe src="https://x"></iframe><object data="x"><b>inside</b></object><svg><script>x</script></svg>b<form action="https://evil"><input name="pw"><button>보내기</button></form><textarea>secret</textarea><embed src=x>');
  assert.equal(out, '<p>a</p>b보내기');
  assert.doesNotMatch(clean('<SCRIPT>bad()</SCRIPT ><scr<script>ipt>x</script>'), /<script/i);
});

test('drops event handlers, javascript: / data: links (also entity-encoded), keeps http(s) and mailto', () => {
  const out = clean('<a href="javascript:alert(1)" onclick="x()">1</a><a href="&#106;avascript:alert(1)">2</a><a href=" java\tscript:x">3</a><a href="data:text/html,x">4</a><a href="https://ok.example/a?b=1&amp;c=2">5</a><a href="mailto:a@b.c">6</a><div onmouseover="x" style="color:red">7</div>');
  assert.equal(
    out,
    '<a rel="noreferrer noopener">1</a><a rel="noreferrer noopener">2</a><a rel="noreferrer noopener">3</a><a rel="noreferrer noopener">4</a><a href="https://ok.example/a?b=1&amp;c=2" rel="noreferrer noopener">5</a><a href="mailto:a@b.c" rel="noreferrer noopener">6</a><div style="color:red">7</div>',
  );
  assert.equal(S.isOpenableLink('https://x.test'), true);
  assert.equal(S.isOpenableLink('mailto:a@b.c'), true);
  for (const bad of ['javascript:x', 'file:///c:/x', 'data:text/html,x', 'ms-settings:', 'vbscript:x']) assert.equal(S.isOpenableLink(bad), false, bad);
});

test('images: cid resolved from the message, data images kept, remote ones counted (blocked until allowed)', () => {
  const res = S.sanitizeHtml('<img src="cid:logo@x"><img src="cid:missing"><img src="data:image/png;base64,AAAA"><img src="https://t.example/p.gif"><td background="http://bg.example/b.png"><p style="background:url(https://i.example/x.png)">t</p><img src="data:text/html;base64,PHNjcmlwdD4=">', {
    cid: { 'logo@x': 'data:image/png;base64,LOGO' },
  });
  assert.equal(res.remoteImages, 3);
  assert.match(res.html, /<img src="data:image\/png;base64,LOGO">/);
  assert.match(res.html, /<img src="https:\/\/t\.example\/p\.gif">/);
  assert.doesNotMatch(res.html, /data:text\/html/);
  assert.equal((res.html.match(/<img/g) || []).length, 5, 'a missing cid image keeps an empty tag');
});

test('style: expression(), javascript:, @import and behaviors removed; meta refresh, base and link dropped', () => {
  const out = clean('<style>@import url(https://x/a.css); p { color: red; width: expression(alert(1)); background: url(javascript:x) } </style><meta http-equiv="refresh" content="0;url=https://x"><base href="https://evil/"><link rel=stylesheet href="https://x/c.css"><p style="behavior:url(x.htc);color:blue">a</p>');
  assert.doesNotMatch(out, /@import|expression\(|javascript:|<meta|<base|<link|behavior:/i);
  assert.match(out, /<style>/);
  assert.match(out, /color:blue/);
});

test('unbalanced and odd markup is closed, comments and doctype dropped, text escaped', () => {
  assert.equal(clean('<!DOCTYPE html><!-- c --><div><b>x</div> 1 < 2 &amp; 3 > 2'), '<div><b>x</b></div> 1 &lt; 2 &amp; 3 &gt; 2');
  assert.equal(clean('<p title="a&quot;b" id="x" class="c">t</p>'), '<p title="a&quot;b" class="c">t</p>', 'id dropped, attribute values re-escaped');
  assert.equal(clean('<img src="x" onerror=alert(1)//'), '<img>', 'an unterminated tag: handler and relative src dropped');
});

test('html to text for snippets and the theme preview; plain text to safe HTML', () => {
  assert.equal(S.htmlToText('<style>p{}</style><p>안녕하세요&nbsp;반갑습니다</p><ul><li>하나</li><li>둘</li></ul><script>x</script>끝<br>줄'), '안녕하세요 반갑습니다\n\n• 하나\n• 둘\n끝\n줄');
  assert.equal(S.textToHtml('a <b> https://x.test/a?b=1, end'), '<pre class="plain">a &lt;b&gt; <a href="https://x.test/a?b=1" rel="noreferrer noopener">https://x.test/a?b=1</a>, end</pre>');
  assert.equal(S.snippetOf('> quoted\n  real   text  '), 'real text');
  assert.equal(S.snippetOf('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
});

test('preview document: CSP blocks remote loads unless this message is allowed; the session filter agrees', () => {
  const blocked = S.buildDocument('<p>x</p>');
  assert.match(blocked, /default-src 'none'/);
  assert.match(blocked, /img-src data:;/);
  assert.match(blocked, /script-src 'none'/);
  assert.match(S.buildDocument('', { allowRemote: true }), /img-src data: https: http:;/);
  const allow = { webContentsId: 7, remote: true };
  assert.equal(requestAllowed({ url: 'data:image/png;base64,AA', resourceType: 'image', webContentsId: 7 }, null), true);
  assert.equal(requestAllowed({ url: 'https://t.example/p.gif', resourceType: 'image', webContentsId: 7 }, null), false, 'not allowed by default');
  assert.equal(requestAllowed({ url: 'https://t.example/p.gif', resourceType: 'image', webContentsId: 7 }, allow), true);
  assert.equal(requestAllowed({ url: 'https://t.example/x.css', resourceType: 'stylesheet', webContentsId: 7 }, allow), false, 'images only');
  assert.equal(requestAllowed({ url: 'https://t.example/p', resourceType: 'mainFrame', webContentsId: 7 }, allow), false, 'no navigation');
  assert.equal(requestAllowed({ url: 'https://t.example/p.gif', resourceType: 'image', webContentsId: 8 }, allow), false, 'another view');
  assert.equal(requestAllowed({ url: 'file:///c:/x.png', resourceType: 'image', webContentsId: 7 }, allow), false);
});

test('preview document size: too big for a data URL -> without inline images -> text', () => {
  const big = `<img src="data:image/png;base64,${'A'.repeat(MAX_DATA_URL)}">`;
  const r1 = documentUrl({ html: big, htmlNoCid: '<p>small</p>', text: 't' }, false);
  assert.equal(r1.reduced, true);
  assert.match(Buffer.from(r1.url.split(',')[1], 'base64').toString(), /<p>small<\/p>/);
  const r2 = documentUrl({ html: '<p>ok</p>', text: 't' }, false);
  assert.equal(r2.reduced, false);
  const r3 = documentUrl({ html: big, htmlNoCid: big, text: '본문' }, false);
  assert.match(Buffer.from(r3.url.split(',')[1], 'base64').toString(), /<pre class="plain">본문<\/pre>/);
});
