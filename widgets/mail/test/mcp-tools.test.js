// "AI 도우미 연결 (MCP)" for the mail widget (#121, engine API 1.10): three read-only tools over the headers the
// widget already has and its own BODY.PEEK body path. Nothing is marked read, no login or server detail leaves,
// mail text is plain text and flagged as untrusted, results fit the engine's 12,000-character limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../index');
const { createStore: engineStore } = require('../../../engine/main/store');
const { checkInput, cleanTools, LIMITS } = require('../../../engine/main/mcp-host');
const { DEFAULTS, sanitize } = require('../lib/settings');
const MT = require('../lib/mcp-tools');
const { withThemeHost } = require('./theme-host');
const { FakeImap, textMessage } = require('./fake-imap');

const mailDir = path.join(__dirname, '..');
const fakeCrypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };
const NOW = Date.now();
const PASSWORD = 'S3cret-App-Pass-9431';
const HOST = 'imap.secret-host.test';

function setup({ fake = null, flags = {}, mcp = true } = {}) {
  let state = sanitize({ ...DEFAULTS });
  let tools = null;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-mcp-'));
  const { ctx, th } = withThemeHost({
    id: 'mail',
    dir: mailDir,
    dataDir,
    flags,
    app: { locale: () => 'ko-KR' },
    createStore: (options) => (options?.file && !options.file.endsWith('settings.json') ? engineStore(options)
      : { load: () => state, save: (v) => (state = sanitize({ ...state, ...v })) }),
    openExternal: async () => {},
    sendToSettings: () => {},
    handle: () => {},
    notify: () => {},
    openAppWindow: () => { throw new Error('no windows in these tests'); },
    confirm: async () => 0,
    // ctx.mcp (engine API 1.10): the declared tools, called directly by the tests
    ...(mcp ? { mcp: { registerTools: (list) => ((tools = list), true) } } : {}),
  });
  const widget = create(ctx, { crypto: fakeCrypto, imap: fake?.deps(), mock: { arriveAfterMs: 0 }, notifier: { setTimeout: (fn) => setTimeout(fn, 5) } });
  return { widget, th, tools: () => tools, getState: () => state };
}

async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out');
}

/** An HTML-only message with a script, a remote (tracking) image, a link with a token and a PDF attachment. */
function htmlMessage(uid, { date, subject, from }) {
  const html = Buffer.from(
    '<html><head><style>p{color:red}</style><script>alert("steal")</script></head><body>' +
      '<p>안녕하세요, 견적서를 보내 드립니다.</p><img src="https://track.example/pixel.gif?u=42" alt="">' +
      '<p><a href="https://evil.example/login?token=abc123">여기</a>를 눌러 확인하세요. https://docs.example/view?sig=zzz999#frag</p></body></html>',
    'utf8',
  );
  const pdf = Buffer.from('JVBERi0xLjQKJcfsj6IKNSAwIG9iago=');
  return {
    uid,
    date,
    subject,
    from,
    to: [{ name: '나', address: 'me@x.test' }],
    cc: [{ name: '박과장', address: 'park@y.test' }],
    flags: [],
    structure: `(("text" "html" ("charset" "utf-8") NIL NIL "7bit" ${html.length} 1 NIL NIL NIL NIL)("application" "pdf" ("name" "quote.pdf") NIL NIL "base64" 4000 NIL ("attachment" ("filename" "quote.pdf")) NIL NIL) "mixed" ("boundary" "b0") NIL NIL NIL)`,
    parts: { 1: html, 2: pdf },
  };
}

const LONG = Array.from({ length: 600 }, (_, i) => `${i + 1}번째 줄 "따옴표"와 내용입니다.`).join('\n');

test('tools: three read-only tools with closed schemas the engine accepts', () => {
  assert.deepEqual(MT.TOOLS.map((t) => t.name), ['list_unread', 'search_messages', 'read_message']);
  for (const t of MT.TOOLS) {
    assert.ok(!t.write, `${t.name} is read only`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.match(t.title, /[가-힣]/);
    for (const p of Object.values(t.inputSchema.properties)) assert.ok(['string', 'integer', 'number', 'boolean', 'array'].includes(p.type));
  }
  const clean = cleanTools(MT.TOOLS.map((t) => ({ ...t, run: () => ({ data: {} }) })));
  assert.equal(clean.length, 3, 'the engine keeps all three');
  for (const t of clean) assert.ok(!t.write);
  assert.ok(checkInput(MT.TOOLS[2].inputSchema, { id: 'x', send: true }), 'unknown fields are refused');
  // No tool that could change mail.
  for (const t of MT.TOOLS) assert.doesNotMatch(t.name, /send|reply|delete|move|mark|flag|categor/);
});

test('real IMAP account: unread list, search, plain-text read with paging; nothing marked read, no secrets', async (t) => {
  const fake = new FakeImap({
    messages: [
      textMessage(1, { date: NOW - 4 * 3600000, subject: '지난 회의록', text: '지난주 회의록입니다.', flags: ['\\Seen'] }),
      htmlMessage(2, { date: NOW - 3 * 3600000, subject: '견적서 송부', from: { name: '거래처', address: 'sales@vendor.test' } }),
      textMessage(3, { date: NOW - 2 * 3600000, subject: '긴 보고서', text: LONG }),
      textMessage(4, { date: NOW - 3600000, subject: '예산 승인 요청', from: { name: '김부장', address: 'boss@y.test' }, text: '예산안을 검토해 주세요.' }),
    ],
    user: 'me@x.test',
    pass: PASSWORD,
  });
  await fake.listen();
  t.after(() => fake.close());
  const { widget, tools, getState } = setup({ fake });
  const acc = { provider: 'other', host: HOST, port: 993, security: 'tls', username: 'me@x.test', name: '회사 메일' };
  const ok = await widget.settings.handlers.check({ ...acc, password: PASSWORD });
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(widget.settings.save({ accounts: [{ ...acc, draft: ok.token }] }), { ok: true });
  widget.start();
  t.after(() => widget.stop());
  assert.ok(tools(), 'tools registered on start');
  const run = Object.fromEntries(tools().map((x) => [x.name, x]));
  const results = [];
  const call = async (name, input) => {
    assert.equal(checkInput(run[name].inputSchema, input), null, `${name} input is valid`);
    const r = await run[name].run(input, { client: 'test' });
    const json = JSON.stringify(r.data);
    assert.ok(json.length <= LIMITS.MAX_RESULT_CHARS, `${name}: ${json.length} chars`);
    results.push(json);
    return r.data;
  };

  // Headers and their previews come from the widget's own sync.
  await waitFor(async () => {
    const r = await run.list_unread.run({});
    return r.data.items.length === 3 && r.data.items.every((m) => m.preview);
  });
  const fetchesBefore = fake.log.filter((l) => /FETCH/i.test(l)).length;

  const list = await call('list_unread', {});
  assert.equal(list.untrusted, MT.UNTRUSTED);
  assert.match(list.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(list.items.map((m) => m.subject), ['예산 승인 요청', '긴 보고서', '견적서 송부'], 'newest first, read mail left out');
  assert.equal(list.total_unread, 3);
  assert.equal(list.not_loaded, false);
  assert.deepEqual(list.accounts.map((a) => a.name), ['회사 메일']);
  const boss = list.items[0];
  assert.equal(boss.account, '회사 메일');
  assert.deepEqual(boss.from, { name: '김부장', address: 'boss@y.test' });
  assert.match(boss.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(boss.preview, '예산안을 검토해 주세요.');
  const quote = list.items[2];
  assert.equal(quote.has_attachments, true);
  assert.ok(quote.preview.length <= 160);
  assert.doesNotMatch(quote.preview, /alert|steal|pixel|token=/);
  assert.ok(list.items[1].preview.length <= 160);
  assert.equal(fake.log.filter((l) => /FETCH/i.test(l)).length, fetchesBefore, 'the list makes no IMAP request');

  const one = await call('list_unread', { limit: 1 });
  assert.equal(one.items.length, 1);
  assert.equal(one.truncated, true);
  assert.equal((await call('list_unread', { account: '회사' })).items.length, 3);
  await assert.rejects(() => run.list_unread.run({ account: '없는 계정' }), /메일 계정이 없습니다/);

  // Search: subject / sender / preview; unread only unless include_read.
  assert.deepEqual((await call('search_messages', { query: '예산' })).items.map((m) => m.subject), ['예산 승인 요청']);
  assert.deepEqual((await call('search_messages', { query: 'boss@y.test' })).items.map((m) => m.subject), ['예산 승인 요청']);
  assert.deepEqual((await call('search_messages', { query: '견적서 보내' })).items.map((m) => m.subject), ['견적서 송부'], 'all words, preview text too');
  assert.equal((await call('search_messages', { query: '회의록' })).items.length, 0, 'read mail needs include_read');
  const old = await call('search_messages', { query: '회의록', include_read: true });
  assert.deepEqual(old.items.map((m) => [m.subject, m.unread]), [['지난 회의록', false]]);
  assert.equal(old.searched, 'loaded');
  assert.equal(old.untrusted, MT.UNTRUSTED);

  // read_message: HTML as plain text, attachment names only.
  const msg = await call('read_message', { id: quote.id });
  assert.equal(msg.untrusted, MT.UNTRUSTED);
  assert.match(msg.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(msg.subject, '견적서 송부');
  assert.deepEqual(msg.from, { name: '거래처', address: 'sales@vendor.test' });
  assert.deepEqual(msg.to, [{ name: '나', address: 'me@x.test' }]);
  assert.deepEqual(msg.cc, [{ name: '박과장', address: 'park@y.test' }]);
  assert.match(msg.body, /견적서를 보내 드립니다/);
  assert.match(msg.body, /여기를 눌러 확인하세요/);
  assert.match(msg.body, /https:\/\/docs\.example\/view\?…/, 'a link in the text stays readable without its query');
  for (const bad of ['<', 'alert', 'steal', 'pixel.gif', 'track.example', 'token', 'abc123', 'zzz999', 'color:red']) assert.ok(!msg.body.includes(bad), `no ${bad}`);
  assert.deepEqual(msg.attachments, [{ name: 'quote.pdf', size: 3000, type: 'application/pdf' }]);
  assert.equal(msg.next_offset, null);
  assert.equal(msg.unread, true);
  assert.ok(!JSON.stringify(msg).includes('JVBER'), 'no attachment content');

  // Paging a long body.
  const long = list.items[1];
  const p1 = await call('read_message', { id: long.id });
  assert.equal(p1.offset, 0);
  assert.equal(p1.body.length, 6000);
  assert.equal(p1.next_offset, 6000);
  const pages = [p1.body];
  let next = p1.next_offset;
  while (next !== null) {
    const p = await call('read_message', { id: long.id, offset: next, max_chars: 8000 });
    assert.equal(p.offset, next);
    assert.ok(p.body.length <= 8000);
    pages.push(p.body);
    next = p.next_offset;
  }
  assert.equal(pages.join(''), LONG, 'the pages put together are the whole text');
  assert.equal(p1.body_chars, LONG.length);

  await assert.rejects(() => run.read_message.run({ id: 'nope:99' }), /메일을 찾지 못했습니다/);

  // Nothing was marked read: no STORE, no FETCH of BODY[...] without PEEK, server flags unchanged.
  assert.ok(!fake.log.some((l) => /\bSTORE\b/i.test(l)), 'no STORE');
  assert.ok(!fake.log.some((l) => /FETCH/i.test(l) && /BODY\[/i.test(l)), 'bodies only with BODY.PEEK');
  assert.ok(fake.log.some((l) => /FETCH/i.test(l) && /BODY\.PEEK\[1\]/i.test(l)), 'the body was fetched with BODY.PEEK');
  for (const uid of [2, 3, 4]) assert.ok(!fake.messages.find((m) => m.uid === uid).flags.includes('\\Seen'), `uid ${uid} still unread`);
  assert.equal(getState().markReadOnOpen, DEFAULTS.markReadOnOpen);
  assert.equal((await call('list_unread', {})).items.length, 3, 'still three unread');

  // No login, password or server in any result.
  const all = results.join('\n');
  for (const secret of [PASSWORD, HOST, 'username', 'password', '"host"', 'secrets', 'token":']) assert.ok(!all.includes(secret), `${secret} not in results`);
});

test('without ctx.mcp the widget starts as before', async (t) => {
  const { widget, th, tools } = setup({ flags: { mockData: true }, mcp: false });
  widget.start();
  t.after(() => widget.stop());
  assert.equal(tools(), null);
  assert.ok((await th.call('list')).items.length >= 8);
});

test('mock data: tools work over the example accounts', async (t) => {
  const { widget, tools } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const run = Object.fromEntries(tools().map((x) => [x.name, x]));
  const list = (await run.list_unread.run({ limit: 50 })).data;
  assert.ok(list.items.length >= 4);
  assert.ok(list.items.every((m) => m.unread));
  for (let i = 1; i < list.items.length; i++) assert.ok(list.items[i - 1].date >= list.items[i].date);
  const work = (await run.list_unread.run({ account: '두레이' })).data;
  assert.ok(work.items.every((m) => m.account.includes('두레이')));
  const read = (await run.read_message.run({ id: list.items[0].id })).data;
  assert.equal(read.untrusted, MT.UNTRUSTED);
  assert.equal(typeof read.body, 'string');
  assert.ok(JSON.stringify(read).length <= LIMITS.MAX_RESULT_CHARS);
  // Reading did not mark it read.
  assert.ok((await run.list_unread.run({ limit: 50 })).data.items.some((m) => m.id === list.items[0].id));
});

test('pure: JSON escapes and long lists still fit the limit; links lose their query', () => {
  const account = { id: 'acc1', name: '테스트' };
  const h = { uid: 1, date: NOW, subject: 's', from: { name: 'a', address: 'a@x.test' }, to: Array.from({ length: 300 }, (_, i) => ({ name: `받는 사람 ${i}`, address: `r${i}@x.test` })), unread: true };
  const body = { text: '"\\\n'.repeat(5000), attachments: Array.from({ length: 100 }, (_, i) => ({ name: `file-${i}.bin`, size: 10, type: 'application/octet-stream' })) };
  const r = MT.readMessage(account, h, body, { max_chars: 8000 }, NOW);
  assert.ok(JSON.stringify(r).length <= LIMITS.MAX_RESULT_CHARS);
  assert.equal(r.to.length, 20);
  assert.equal(r.to_total, 300);
  assert.equal(r.attachments.length, 30);
  assert.equal(r.attachments_total, 100);
  assert.ok(r.next_offset > 0 && r.next_offset === r.body.length);
  const headers = Array.from({ length: 200 }, (_, i) => ({ uid: i + 1, date: NOW - i, subject: '가'.repeat(400), from: { name: '나'.repeat(200), address: 'x@y.test' }, snippet: '다'.repeat(400), unread: true }));
  const l = MT.listUnread([{ account, headers, total: 200 }], { limit: 50 }, NOW);
  assert.ok(JSON.stringify(l).length <= LIMITS.MAX_RESULT_CHARS);
  assert.equal(l.truncated, true);
  assert.equal(MT.plainLinks('보기: https://a.test/x?id=1&t=secret#y 끝'), '보기: https://a.test/x?… 끝');
  assert.equal(MT.stampOf(new Date(2026, 10, 6, 9, 5).getTime()), '2026-11-06 09:05');
});
