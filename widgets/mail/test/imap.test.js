// IMAP response parsing and the client (#65), against an in-process fake server (never a real account).
const test = require('node:test');
const assert = require('node:assert/strict');
const { ResponseReader, parseResponse, str, compactSet, expandSet, bytesToText } = require('../lib/imap-parser');
const { ImapClient, quote } = require('../lib/imap-client');
const utf7 = require('../lib/utf7');
const { parseEnvelope, parseBodyStructure } = require('../lib/mime');
const { FakeImap, textMessage } = require('./fake-imap');

const B = (s) => Buffer.from(s, 'latin1');
const parseAll = (...chunks) => {
  const r = new ResponseReader();
  return chunks.flatMap((c) => r.push(B(c))).map(parseResponse);
};

test('reader: responses split across chunks, literals with CRLF inside, {n+} literals', () => {
  const res = parseAll('* 1 FETCH (UID 5 BODY[1]<0> {8}\r\nab', '\r\ncd\r\n FLAGS (\\Seen \\Flagged))\r\n* 3 EXI', 'STS\r\n* 2 FETCH (UID 6 BODY[TEXT] {3+}\r\nxyz)\r\n');
  assert.equal(res.length, 3);
  assert.equal(res[0].type, 'FETCH');
  assert.equal(res[0].num, 1);
  assert.equal(str(res[0].attrs.UID), '5');
  assert.equal(res[0].attrs['BODY[1]<0>'].toString('latin1'), 'ab\r\ncd\r\n');
  assert.deepEqual(res[0].attrs.FLAGS, ['\\Seen', '\\Flagged']);
  assert.deepEqual([res[1].type, res[1].num], ['EXISTS', 3]);
  assert.equal(res[2].attrs['BODY[TEXT]'].toString(), 'xyz');
});

test('parser: quoted strings with escapes, NIL, nested lists, status codes, continuation', () => {
  const [a, b, c, d, e] = parseAll(
    '* LIST (\\HasNoChildren) "/" "My \\"box\\" \\\\ x"\r\n',
    'A1 OK [UIDVALIDITY 3857529045] SELECT done\r\n',
    'A2 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n',
    '+ idling\r\n',
    '* SEARCH 2 84 882\r\n',
  );
  assert.equal(a.type, 'LIST');
  assert.deepEqual(a.values[0], ['\\HasNoChildren']);
  assert.equal(str(a.values[2]), 'My "box" \\ x');
  assert.deepEqual([b.tag, b.type, b.code.name, str(b.code.args[0]), b.text], ['A1', 'OK', 'UIDVALIDITY', '3857529045', 'SELECT done']);
  assert.deepEqual([c.type, c.code.name, c.text], ['NO', 'AUTHENTICATIONFAILED', 'Invalid credentials (Failure)']);
  assert.deepEqual([d.tag, d.type, d.text], ['+', 'CONTINUE', 'idling']);
  assert.deepEqual(e.values.map(Number), [2, 84, 882]);
  // A status text may hold unbalanced brackets and quotes: kept as text, not parsed.
  const [f] = parseAll('* OK [ALERT] Please "log in" via (web\r\n');
  assert.deepEqual([f.code.name, f.text], ['ALERT', 'Please "log in" via (web']);
  // HEADER.FIELDS with a space inside the brackets stays one key.
  const [g] = parseAll('* 4 FETCH (UID 9 BODY[HEADER.FIELDS (TO CC)] {4}\r\nTo:x)\r\n');
  assert.equal(g.attrs['BODY[HEADER.FIELDS (TO CC)]'].toString(), 'To:x');
});

test('IDLE notifications: EXISTS, EXPUNGE, FETCH flags without UID', () => {
  const res = parseAll('* 23 EXISTS\r\n* 3 EXPUNGE\r\n* 5 FETCH (FLAGS (\\Seen))\r\n* 1 RECENT\r\n');
  assert.deepEqual(res.map((r) => [r.type, r.num]), [['EXISTS', 23], ['EXPUNGE', 3], ['FETCH', 5], ['RECENT', 1]]);
  assert.equal(res[2].attrs.UID, undefined);
});

test('ENVELOPE: encoded words, groups skipped, address lists, Message-ID', () => {
  const [r] = parseAll(
    '* 1 FETCH (UID 7 ENVELOPE ("Mon, 19 Oct 2026 09:00:00 +0900" "=?UTF-8?B?7ZWc6riAIOygnOuqqQ==?=" (("=?euc-kr?B?yKux5rW/?=" NIL "hong" "example.com")) NIL NIL (("Me" NIL "me" "x.test")(NIL NIL "team" NIL)("A" NIL "a" "x.test")(NIL NIL NIL NIL)) NIL NIL NIL "<abc@x.test>"))\r\n',
  );
  const env = parseEnvelope(r.attrs.ENVELOPE);
  assert.equal(env.subject, '한글 제목');
  assert.deepEqual(env.from, [{ name: '홍길동', address: 'hong@example.com' }]);
  assert.deepEqual(env.to.map((a) => a.address), ['me@x.test', 'a@x.test'], 'group markers are not addresses');
  assert.equal(env.messageId, '<abc@x.test>');
  assert.equal(env.date, Date.parse('2026-10-19T00:00:00Z'));
});

test('BODYSTRUCTURE: multipart/mixed with alternative, attachment with RFC 2231 name, single part', () => {
  const [r] = parseAll(
    `* 1 FETCH (UID 8 BODYSTRUCTURE ((("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 120 4 NIL NIL NIL NIL)("text" "html" ("charset" "euc-kr") NIL NIL "base64" 400 6 NIL NIL NIL NIL) "alternative" ("boundary" "a") NIL NIL NIL)("application" "pdf" ("name*" "UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf") NIL NIL "base64" 4000 NIL ("attachment" ("filename*" "UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf")) NIL NIL) "mixed" ("boundary" "m") NIL NIL NIL))\r\n`,
  );
  const tree = parseBodyStructure(r.attrs.BODYSTRUCTURE);
  assert.equal(tree.type, 'multipart');
  assert.equal(tree.subtype, 'mixed');
  assert.deepEqual(tree.children[0].children.map((c) => [c.part, c.subtype, c.encoding, c.params.charset]), [['1.1', 'plain', 'quoted-printable', 'utf-8'], ['1.2', 'html', 'base64', 'euc-kr']]);
  assert.equal(tree.children[1].part, '2');
  assert.equal(tree.children[1].disposition.params.filename, '보고서.pdf');
  const [s] = parseAll('* 2 FETCH (UID 9 BODYSTRUCTURE ("text" "plain" ("charset" "us-ascii") NIL NIL "7bit" 12 1 NIL NIL NIL NIL))\r\n');
  const single = parseBodyStructure(s.attrs.BODYSTRUCTURE);
  assert.deepEqual([single.part, single.root, single.size], ['1', true, 12]);
});

test('sets and helpers: compact UID sets, expand, 8-bit header bytes, quoting', () => {
  assert.equal(compactSet([5, 1, 2, 3, 9, 7, 8]), '1:3,5,7:9');
  assert.deepEqual(expandSet('1:3,7,10:9'), [1, 2, 3, 7, 9, 10]);
  assert.equal(bytesToText(Buffer.from('한글', 'utf8')), '한글');
  assert.equal(bytesToText(Buffer.from('c7d1b1db', 'hex')), '한글', 'raw EUC-KR header bytes');
  assert.equal(quote('pa"s\\s'), '"pa\\"s\\\\s"');
  assert.ok(quote('비밀번호').literal, 'non-ASCII goes as a literal');
});

test('modified UTF-7 folder names', () => {
  assert.equal(utf7.decode('~peter/mail/&U,BTFw-/&ZeVnLIqe-'), '~peter/mail/台北/日本語', 'RFC 3501 example');
  assert.equal(utf7.encode('~peter/mail/台北/日本語'), '~peter/mail/&U,BTFw-/&ZeVnLIqe-');
  assert.equal(utf7.decode(utf7.encode('받은편지함')), '받은편지함');
  assert.equal(utf7.decode('Tom &- Jerry'), 'Tom & Jerry');
  assert.equal(utf7.encode('Tom & Jerry/보낸'), 'Tom &- Jerry/&vPSwuA-');
  assert.equal(utf7.decode(utf7.encode('日本語 ✓ mix')), '日本語 ✓ mix');
});

async function server(t, opts) {
  const fake = new FakeImap(opts);
  await fake.listen();
  t.after(() => fake.close());
  return fake;
}

test('client: TLS connect, AUTHENTICATE PLAIN (SASL-IR), SELECT, SEARCH, FETCH, STORE, LOGOUT', async (t) => {
  const fake = await server(t, { messages: [textMessage(3, { subject: 'a' }), textMessage(5, { subject: 'b', flags: ['\\Seen'] })] });
  const c = new ImapClient({ host: 'imap.x.test', port: 993, security: 'tls', username: 'me', password: 'pw', deps: fake.deps() });
  await c.open();
  assert.equal(fake.lastLogin.user, 'me');
  assert.ok(fake.log.some((l) => /AUTHENTICATE PLAIN \S+/.test(l)), 'SASL-IR: the token on the same line');
  const box = await c.select('INBOX');
  assert.deepEqual([box.exists, box.uidValidity, box.uidNext], [2, 1, 6]);
  assert.deepEqual(await c.uidSearch('UID 4:*'), [5]);
  assert.equal(await c.count('UNSEEN'), 1);
  const rows = await c.fetch('3:5', 'UID FLAGS');
  assert.deepEqual(rows.map((r) => [r.UID, r.FLAGS.map(str)]), [[3, []], [5, ['\\Seen']]]);
  await c.store('3', true, ['\\Seen']);
  assert.deepEqual(fake.messages[0].flags, ['\\Seen']);
  await c.logout();
  assert.ok(c.closed);
});

test('client: LOGIN with a literal for a non-ASCII password when AUTH=PLAIN is not offered', async (t) => {
  const fake = await server(t, { caps: ['IMAP4rev1', 'IDLE'], pass: '비밀번호1' });
  const c = new ImapClient({ host: 'h', port: 993, security: 'tls', username: 'me', password: '비밀번호1', deps: fake.deps() });
  await c.open();
  assert.equal(fake.lastLogin.pass, '비밀번호1');
  assert.ok(fake.log.some((l) => /^A\d+ LOGIN "me" "비밀번호1"$/.test(l)), 'sent as a synchronizing literal');
  await c.logout();
});

test('client: STARTTLS upgrades before login; a server without STARTTLS gets no password', async (t) => {
  const fake = await server(t, {});
  const c = new ImapClient({ host: 'h', port: 143, security: 'starttls', username: 'me', password: 'pw', deps: fake.deps() });
  await c.open();
  assert.equal(fake.lastLogin.tls, true, 'logged in only after STARTTLS');
  const order = fake.log.map((l) => l.split(' ')[1]);
  assert.ok(order.indexOf('STARTTLS') < order.indexOf('AUTHENTICATE'));
  await c.logout();

  const plain = await server(t, { starttls: false });
  const d = new ImapClient({ host: 'h', port: 143, security: 'starttls', username: 'me', password: 'secret-pw', deps: plain.deps() });
  await assert.rejects(d.open(), (err) => err.kind === 'starttls');
  assert.equal(plain.logins, 0);
  assert.ok(!plain.log.some((l) => l.includes('secret-pw') || l.includes(Buffer.from('\0me\0secret-pw').toString('base64'))), 'the password never went out');
  d.close();
  // No plain-text security mode exists.
  const e = new ImapClient({ host: 'h', port: 143, security: 'none', username: 'me', password: 'x', deps: plain.deps() });
  await assert.rejects(e.open(), (err) => err.kind === 'tls');
});

test('client: refused login is an auth error with the server text; IDLE delivers EXISTS and ends with DONE', async (t) => {
  const fake = await server(t, { messages: [textMessage(1)] });
  const bad = new ImapClient({ host: 'h', port: 993, security: 'tls', username: 'me', password: 'wrong', deps: fake.deps() });
  await assert.rejects(bad.open(), (err) => err.kind === 'auth' && /Invalid credentials/.test(err.message));
  bad.close();

  const c = new ImapClient({ host: 'h', port: 993, security: 'tls', username: 'me', password: 'pw', deps: fake.deps() });
  await c.open();
  await c.select('INBOX');
  const seen = [];
  c.on('mailbox', (r) => seen.push([r.type, r.num]));
  const idle = await c.idle();
  fake.deliver(textMessage(2));
  await new Promise((r) => setTimeout(r, 50));
  await idle.done();
  assert.deepEqual(seen, [['EXISTS', 2]]);
  assert.ok(fake.log.includes('DONE'));
  // Commands work again after IDLE.
  assert.deepEqual(await c.uidSearch('UID 2:*'), [2]);
  await c.logout();
});
