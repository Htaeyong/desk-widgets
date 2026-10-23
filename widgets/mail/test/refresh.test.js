// 새로고침 feedback (#79): the kit button (pressed + spinning at least 0.6 s, then the result) and its texts.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../kit/refresh');

function fakeButton() {
  const classes = new Set();
  const attrs = {};
  let click = null;
  return {
    classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) },
    dataset: {},
    setAttribute: (k, v) => (attrs[k] = v),
    removeAttribute: (k) => delete attrs[k],
    addEventListener: (_t, fn) => (click = fn),
    click: () => click(),
    classes,
  };
}

test('result texts: new mail, none, one error, several errors, a failed call', () => {
  assert.equal(R.resultText({ ok: true, accounts: 2, newMail: 3, errors: [] }), '새 메일 3통');
  assert.equal(R.resultText({ ok: true, accounts: 2, newMail: 0, errors: [] }), '새 메일 없음');
  assert.equal(R.resultText({ ok: true, accounts: 2, newMail: 0, errors: [{ name: '회사', message: '로그인 거절' }] }), '새 메일 없음 · 회사: 로그인 거절');
  assert.equal(R.resultText({ ok: true, accounts: 1, newMail: 0, errors: [{ name: '회사', message: 'x' }] }), '회사: x', 'all failed: no "새 메일 없음"');
  assert.equal(R.resultText({ ok: true, accounts: 3, newMail: 1, errors: [{ name: 'A', message: 'x' }, { name: 'B', message: 'y' }] }), '새 메일 1통 · 연결 오류 2개 (A, B)');
  assert.equal(R.resultText({ ok: false, message: '꺼짐' }), '새로고침하지 못했습니다: 꺼짐');
  assert.equal(R.resultText(null), '새로고침하지 못했습니다');
});

test('button: pressed and spinning at once, at least minMs, ignores a second press, then the result', async () => {
  const b = fakeButton();
  let resolveRun;
  const waits = [];
  const notes = [];
  let clock = 1000;
  const r = R.bind(b, {
    run: () => new Promise((res) => (resolveRun = res)),
    notice: (t, err) => notes.push([t, err]),
    now: () => clock,
    wait: (ms) => (waits.push(ms), Promise.resolve()),
  });
  const p = r.press();
  assert.ok(b.classes.has('spin') && b.classes.has('pressed'), 'feedback before the server answers');
  assert.equal(b.dataset.busy, '1');
  assert.equal(await r.press(), null, 'a second press while running does nothing');
  clock += 120; // the server answered quickly
  resolveRun({ ok: true, accounts: 1, newMail: 0, errors: [] });
  await p;
  assert.deepEqual(waits, [480], 'kept spinning up to 600 ms');
  assert.equal(b.classes.has('spin'), false);
  assert.equal(b.dataset.busy, undefined);
  assert.deepEqual(notes, [['새 메일 없음', false]]);
  // A slow answer: no extra wait; a thrown error becomes a message.
  const p2 = r.press();
  clock += 5000;
  resolveRun({ ok: true, accounts: 1, newMail: 2, errors: [] });
  await p2;
  assert.deepEqual(waits, [480]);
  const r2 = R.bind(fakeButton(), { run: async () => { throw new Error('끊김'); }, notice: (t, err) => notes.push([t, err]), wait: async () => {} });
  await r2.press();
  assert.deepEqual(notes.at(-1), ['새로고침하지 못했습니다: 끊김', true]);
});

test('only the ⟳ glyph spins: themes put it in <span class="glyph">, the CSS rotates that span and never the button', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'kit', 'refresh.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
  const animated = rules.filter(([, body]) => /animation\s*:/.test(body)).map(([sel]) => sel);
  assert.deepEqual(animated, ['.spin .glyph']);
  assert.match(rules.find(([sel]) => sel === '.glyph')[1], /display:\s*inline-block/);
  assert.match(rules.find(([sel]) => sel === '.glyph')[1], /transform-origin:\s*50% 50%/);
  for (const t of ['default', 'compact', 'dashboard']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'themes', t, 'index.html'), 'utf8');
    assert.match(html, /id="refresh"[^>]*><span class="glyph"[^>]*>⟳<\/span><\/button>/, t);
  }
  // A theme with a bare "⟳" button gets the span from bind().
  const made = [];
  const btn = {
    ...fakeButton(),
    textContent: ' ⟳ ',
    querySelector: () => null,
    ownerDocument: { createElement: () => ({ setAttribute() {}, className: '', textContent: '' }) },
    replaceChildren: (...kids) => made.push(...kids),
  };
  R.bind(btn, { run: async () => ({ ok: true }) });
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].className, made[0].textContent], ['glyph', '⟳']);
});
