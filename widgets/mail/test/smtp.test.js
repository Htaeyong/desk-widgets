// Sending (#68): the SMTP client against an in-process fake server, the MIME builder, and the Sent copy
// (IMAP APPEND, no duplicate). Never a real account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SmtpClient, dotStuff } = require('../lib/smtp-client');
const { buildMessage, parseAddresses, encodeWords, formatAddress, encodeQP, fileParams } = require('../lib/mime-build');
const { sendMail, findSent, shouldSave } = require('../lib/sender');
const { decodeWords, decodeQP, parseHeaders, parseHeaderParams } = require('../lib/mime');
const { replyRecipients, composeBody } = require('../lib/handoff');
const { FakeSmtp } = require('./fake-smtp');
const { FakeImap } = require('./fake-imap');

async function smtpServer(t, opts) {
  const s = new FakeSmtp(opts);
  await s.listen();
  t.after(() => s.close());
  return s;
}
const client = (s, extra = {}) => new SmtpClient({ host: 'smtp.x.test', port: 465, security: 'tls', username: 'me', password: 'pw', deps: s.deps(), ...extra });

test('SMTP: TLS, EHLO (multi-line), AUTH PLAIN, MAIL / RCPT / DATA with dot-stuffing, QUIT', async (t) => {
  const s = await smtpServer(t);
  const c = client(s);
  await c.open();
  assert.ok(c.ext.has('AUTH'));
  assert.ok(s.log.some((l) => /^AUTH PLAIN \S+$/.test(l)));
  await c.send({ from: 'me@x.test', recipients: ['a@y.test', 'b@y.test'], data: 'Subject: t\r\n\r\n.leading dot\r\nline\r\n' });
  await c.quit();
  assert.equal(s.messages.length, 1);
  assert.deepEqual(s.messages[0].rcpts, ['a@y.test', 'b@y.test']);
  assert.match(s.messages[0].data, /\r\n\.leading dot\r\n/, 'the server got the dot back after un-stuffing');
  assert.equal(dotStuff('a\r\n.b\r\n').toString(), 'a\r\n..b\r\n.\r\n');
});

test('SMTP: AUTH LOGIN when PLAIN is not offered; STARTTLS before login; no STARTTLS -> no password sent', async (t) => {
  const s = await smtpServer(t, { auth: 'LOGIN' });
  const c = client(s, { port: 587, security: 'starttls' });
  await c.open();
  assert.equal(s.lastLogin.tls, true, 'logged in after STARTTLS');
  assert.ok(s.log.indexOf('STARTTLS') < s.log.indexOf('AUTH LOGIN'));
  await c.quit();
  const plain = await smtpServer(t, { starttls: false, pass: 'secret-pw' });
  const d = client(plain, { port: 587, security: 'starttls', password: 'secret-pw' });
  await assert.rejects(d.open(), (err) => err.kind === 'starttls');
  assert.equal(plain.logins, 0);
  assert.ok(!plain.log.some((l) => l.includes(Buffer.from('\0me\0secret-pw').toString('base64'))));
  d.close();
  await assert.rejects(client(plain, { security: 'none' }).open(), (err) => err.kind === 'tls');
});

test('SMTP errors in Korean: refused login, sender not allowed, unknown recipient (nothing sent), size', async (t) => {
  const s = await smtpServer(t, { pass: 'other' });
  await assert.rejects(client(s).open(), (err) => err.kind === 'auth' && /로그인을 거절/.test(err.message) && /535/.test(err.message));
  const r = await smtpServer(t, { refuseFrom: true });
  const c = client(r);
  await c.open();
  await assert.rejects(c.send({ from: 'other@z.test', recipients: ['a@y.test'], data: 'x' }), (err) => err.kind === 'relay' && /보내는 주소/.test(err.message));
  c.close();
  const u = await smtpServer(t, { refuse: ['nobody@y.test'] });
  const d = client(u);
  await d.open();
  await assert.rejects(d.send({ from: 'me@x.test', recipients: ['a@y.test', 'nobody@y.test'], data: 'x' }), (err) => err.kind === 'recipient' && /nobody@y\.test/.test(err.message));
  assert.equal(u.messages.length, 0, 'a refused recipient stops the whole send');
  d.close();
  const z = await smtpServer(t, { size: 100 });
  const e = client(z);
  await e.open();
  await assert.rejects(e.send({ from: 'me@x.test', recipients: ['a@y.test'], data: 'x'.repeat(200) }), (err) => err.kind === 'size');
  e.close();
});

test('MIME: encoded Korean headers, QP body, threading, Bcc not written, CRLF and line lengths', () => {
  const { raw, messageId, recipients } = buildMessage({
    from: { name: '홍길동', address: 'hong@x.test' },
    to: [{ name: '김부장', address: 'boss@y.test' }, { name: 'Kim, J', address: 'k@y.test' }],
    cc: [{ name: '', address: 'c@y.test' }],
    bcc: [{ name: '', address: 'secret@y.test' }],
    subject: 'Re: 회의 자료 부탁드립니다 — 아주 긴 제목이 여러 단어로 나뉘어야 합니다',
    text: `안녕하세요.\n${'가'.repeat(120)}\n.점으로 시작\n끝 `,
    inReplyTo: '<orig@y.test>',
    references: ['<root@y.test>'],
    date: Date.UTC(2026, 9, 19, 5, 0, 0),
  });
  const text = raw.toString('utf8');
  const [head, body] = text.split('\r\n\r\n');
  assert.ok(!/[^\r]\n/.test(text), 'CRLF only');
  for (const line of text.split('\r\n')) assert.ok(line.length <= 78 || /^References:/.test(line), `line too long: ${line.slice(0, 40)}`);
  const h = parseHeaders(head);
  assert.equal(decodeWords(h.get('from')[0]), '홍길동 <hong@x.test>');
  assert.equal(decodeWords(h.get('to')[0]), '김부장 <boss@y.test>, "Kim, J" <k@y.test>');
  assert.equal(decodeWords(h.get('subject')[0]).replace(/\s+/g, ' '), 'Re: 회의 자료 부탁드립니다 — 아주 긴 제목이 여러 단어로 나뉘어야 합니다');
  assert.equal(h.get('in-reply-to')[0], '<orig@y.test>');
  assert.equal(h.get('references')[0], '<root@y.test> <orig@y.test>');
  assert.equal(h.get('message-id')[0], messageId);
  assert.match(messageId, /@x\.test>$/, 'Message-ID on the sender domain');
  assert.equal(h.has('bcc'), false, 'Bcc is never written');
  assert.deepEqual(recipients, ['boss@y.test', 'k@y.test', 'c@y.test', 'secret@y.test']);
  assert.match(h.get('content-transfer-encoding')[0], /quoted-printable/);
  assert.equal(decodeQP(body).toString('utf8').replace(/\r\n/g, '\n').trimEnd(), `안녕하세요.\n${'가'.repeat(120)}\n.점으로 시작\n끝 `.trimEnd());
  assert.match(body, /^=2E/m, 'a leading dot is encoded');
  // ASCII short text stays 7bit.
  assert.match(buildMessage({ from: { address: 'a@x.test' }, to: [{ address: 'b@x.test' }], subject: 'hi', text: 'hello' }).raw.toString(), /Content-Transfer-Encoding: 7bit/);
});

test('MIME: attachments in multipart/mixed with RFC 2231 Korean names and base64 lines', () => {
  const data = Buffer.from('%PDF-1.4 '.repeat(50));
  const { raw } = buildMessage({ from: { address: 'a@x.test' }, to: [{ address: 'b@x.test' }], subject: '첨부', text: '파일 보냅니다', attachments: [{ name: '보고서 최종.pdf', data }, { name: 'a.txt', data: Buffer.from('x') }] });
  const text = raw.toString();
  const boundary = /boundary="([^"]+)"/.exec(text)[1];
  const parts = text.split(`--${boundary}`).slice(1, -1);
  assert.equal(parts.length, 3);
  const [ph, pb] = parts[1].replace(/^\r\n/, '').split('\r\n\r\n');
  const ct = parseHeaderParams(parseHeaders(ph).get('content-disposition')[0]);
  assert.deepEqual([ct.value, ct.params.filename], ['attachment', '보고서 최종.pdf']);
  assert.match(ph, /Content-Type: application\/pdf/);
  assert.ok(pb.trim().split('\r\n').every((l) => l.length <= 76));
  assert.deepEqual(Buffer.from(pb.replace(/\s+/g, ''), 'base64'), data);
  assert.equal(fileParams('filename', 'a"b.txt'), 'filename="a_b.txt"');
  assert.match(text, /--[^\r]+--\r\n$/);
});

test('addresses, encoded words, QP lines', () => {
  const { list, bad } = parseAddresses('a@x.test, 홍길동 <h@x.kr>; "Kim, J" <k@y.com>\nbad, x@y');
  assert.deepEqual(list, [{ name: '', address: 'a@x.test' }, { name: '홍길동', address: 'h@x.kr' }, { name: 'Kim, J', address: 'k@y.com' }]);
  assert.deepEqual(bad, ['bad', 'x@y']);
  assert.equal(parseAddresses('evil@x.test\r\nBcc: z@z.test').bad.length, 1, 'no header injection');
  assert.equal(encodeWords('plain'), 'plain');
  assert.equal(decodeWords(encodeWords('한글 '.repeat(30)).replace(/\r\n /g, ' ')), '한글 '.repeat(30));
  assert.equal(formatAddress({ name: 'A.B', address: 'a@b.c' }), '"A.B" <a@b.c>');
  assert.ok(encodeQP('x'.repeat(300)).split('\r\n').every((l) => l.length <= 76));
});

test('reply recipients and the quoted body', () => {
  const msg = { from: { name: '김부장', address: 'boss@y.test' }, to: [{ name: '나', address: 'me@x.test' }, { name: '', address: 'kim@y.test' }], cc: [{ name: '', address: 'BOSS@y.test' }], replyTo: [], subject: '회의', date: Date.parse('2026-10-19T01:00:00Z') };
  assert.deepEqual(replyRecipients('reply', msg, 'me@x.test'), { to: [msg.from], cc: [] });
  assert.deepEqual(replyRecipients('replyAll', msg, 'me@x.test').cc.map((a) => a.address), ['kim@y.test']);
  const body = composeBody('reply', { msg, text: '자료 부탁\n> 이전 인용', signature: '홍길동' });
  assert.match(body, /^\n\n\n-- \n홍길동\n\n/, 'a line to write on, then the signature');
  assert.match(body, /김부장 <boss@y\.test> 님이 작성:\n> 자료 부탁\n>> 이전 인용$/);
  assert.match(composeBody('forward', { msg, text: '원문' }), /---------- 전달된 메일 ----------\n보낸 사람: 김부장 <boss@y\.test>\n날짜: .*\n제목: 회의\n받는 사람: 나 <me@x\.test>, kim@y\.test\n참조: BOSS@y\.test\n\n원문$/);
});

const ACCOUNT = { id: 'a1', provider: 'other', host: 'imap.x.test', port: 993, security: 'tls', username: 'me', smtpHost: 'smtp.x.test', smtpPort: 465, smtpSecurity: 'tls', saveSent: 'auto' };
const MSG = { from: { name: '나', address: 'me@x.test' }, to: [{ name: '', address: 'a@y.test' }], subject: '테스트', text: '본문' };

test('Sent copy: \\Sent folder found by flag or name, APPEND with \\Seen, no duplicate, Gmail left to the server', async (t) => {
  assert.equal(findSent([{ name: 'INBOX', flags: [] }, { name: '보낸메일함', flags: [], delimiter: '/' }]).name, '보낸메일함');
  assert.equal(findSent([{ name: 'Outbox', flags: ['\\Sent'] }, { name: 'Sent', flags: [] }]).name, 'Outbox');
  assert.equal(findSent([{ name: 'INBOX', flags: [] }]), null);
  assert.equal(shouldSave({ provider: 'gmail', saveSent: 'auto' }), false);
  assert.equal(shouldSave({ provider: 'naver', saveSent: 'auto' }), true);
  assert.equal(shouldSave({ provider: 'gmail', saveSent: 'on' }), true);
  assert.equal(shouldSave({ provider: 'naver', saveSent: 'off' }), false);

  const smtp = await smtpServer(t);
  const imap = new FakeImap({ messages: [] });
  imap.boxes['보낸메일함'] = { flags: ['\\Sent'], messages: [] };
  await imap.listen();
  t.after(() => imap.close());
  const res = await sendMail({ account: ACCOUNT, password: 'pw', msg: MSG, deps: { smtp: smtp.deps(), imap: imap.deps() }, waitMs: 0 });
  assert.equal(smtp.messages.length, 1);
  assert.deepEqual(res.sent, { saved: true, box: '보낸메일함' });
  assert.equal(imap.appends.length, 1);
  assert.match(imap.appends[0].flags, /\\Seen/);
  assert.ok(imap.appends[0].raw.includes(res.messageId));
  // The server already filed it (like Gmail): the copy is skipped.
  imap.boxes['보낸메일함'].messages = [];
  const smtp2 = await smtpServer(t);
  const orig = smtp2.onLine.bind(smtp2);
  smtp2.onLine = (c, line) => {
    orig(c, line);
    if (line === '.' && smtp2.messages.length) imap.boxes['보낸메일함'].messages.push({ raw: smtp2.messages.at(-1).data, flags: [] });
  };
  const res2 = await sendMail({ account: ACCOUNT, password: 'pw', msg: MSG, deps: { smtp: smtp2.deps(), imap: imap.deps() }, waitMs: 0 });
  assert.deepEqual(res2.sent, { saved: false, already: true, box: '보낸메일함' });
  assert.equal(imap.appends.length, 1, 'no duplicate');
  // Gmail (auto): no APPEND at all.
  const res3 = await sendMail({ account: { ...ACCOUNT, provider: 'gmail' }, password: 'pw', msg: MSG, deps: { smtp: smtp.deps(), imap: imap.deps() }, waitMs: 0 });
  assert.equal(res3.sent.reason, 'off');
  assert.equal(imap.appends.length, 1);
});

test('send: SMTP refusal throws (nothing sent, no Sent copy); a failing Sent copy does not fail the send', async (t) => {
  const smtp = await smtpServer(t, { pass: 'nope' });
  const imap = new FakeImap({ messages: [] });
  await imap.listen();
  t.after(() => imap.close());
  await assert.rejects(sendMail({ account: ACCOUNT, password: 'pw', msg: MSG, deps: { smtp: smtp.deps(), imap: imap.deps() }, waitMs: 0 }), (err) => err.kind === 'auth');
  assert.equal(imap.appends.length, 0);
  const ok = await smtpServer(t);
  const res = await sendMail({ account: ACCOUNT, password: 'pw', msg: MSG, deps: { smtp: ok.deps(), imap: imap.deps() }, waitMs: 0 });
  assert.equal(ok.messages.length, 1);
  assert.equal(res.sent.saved, false);
  assert.match(res.sent.reason, /보낸편지함을 찾지 못했습니다/);
  await assert.rejects(sendMail({ account: { ...ACCOUNT, smtpHost: '' }, password: 'pw', msg: MSG }), /SMTP/);
});
