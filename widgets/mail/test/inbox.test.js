// Unified list merge / order / paging, notification grouping, mailto / webmail handoff (#65). Pure parts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { merge, needsMore, parseId, messageId } = require('../lib/inbox');
const { cardsFor, createNotifier, SUMMARY_OVER } = require('../lib/notify');
const { buildMailto, mailtoFor, webmailFor, MAX_MAILTO } = require('../lib/handoff');

const acc = (id, name = id) => ({ id, name, color: '#123456' });
const h = (uid, date, extra = {}) => ({ uid, date, subject: `s${uid}`, from: { name: '', address: `u${uid}@x.test` }, unread: false, ...extra });

test('merge: newest first across accounts, account order breaks ties, limit and hasMore', () => {
  const sources = [
    { account: acc('a'), headers: [h(1, 100), h(2, 300)], hasMore: false },
    { account: acc('b'), headers: [h(7, 200), h(8, 300)], hasMore: false },
  ];
  const all = merge(sources, 10);
  assert.deepEqual(all.items.map((m) => m.id), ['a:2', 'b:8', 'b:7', 'a:1']);
  assert.equal(all.hasMore, false);
  const page = merge(sources, 2);
  assert.deepEqual(page.items.map((m) => m.id), ['a:2', 'b:8']);
  assert.equal(page.hasMore, true);
  assert.equal(merge([{ ...sources[0], hasMore: true }], 10).hasMore, true, 'the server has older mail');
  const item = all.items[0];
  assert.deepEqual(Object.keys(item).sort(), ['accountId', 'accountName', 'answered', 'categoryIds', 'color', 'date', 'flagged', 'folder', 'folderKey', 'from', 'hasAttachments', 'id', 'snippet', 'subject', 'unread']);
});

test('needsMore: only accounts whose oldest loaded mail reaches into the page', () => {
  const sources = [
    { account: acc('a'), headers: [h(1, 500), h(2, 400)], hasMore: true }, // oldest 400
    { account: acc('b'), headers: [h(3, 900), h(4, 100)], hasMore: true }, // oldest 100, far below
    { account: acc('c'), headers: [], hasMore: true },
    { account: acc('d'), headers: [h(5, 50)], hasMore: false },
  ];
  assert.deepEqual(needsMore(sources, 3), ['a', 'c']);
  assert.deepEqual(needsMore(sources, 10), ['a', 'b', 'c'], 'a short list: everyone with more');
});

test('message ids', () => {
  assert.equal(messageId('m1a', 42), 'm1a:42');
  assert.deepEqual(parseId('m1a:42'), { accountId: 'm1a', folderKey: '', uid: 42 });
  assert.deepEqual(parseId('m1a:0a1b2c3d:42'), { accountId: 'm1a', folderKey: '0a1b2c3d', uid: 42 }, '#80: a chosen mailbox');
  assert.equal(messageId('m1a', 42, '0a1b2c3d'), 'm1a:0a1b2c3d:42');
  for (const bad of ['', 'x', 'a:b', '../x:1', 'a:1:2', null]) assert.equal(parseId(bad), null, String(bad));
});

const arrival = (n, accountId = 'a') => ({ id: `${accountId}:${n}`, accountId, accountName: '회사', from: { name: `보낸이${n}`, address: `p${n}@x.test` }, subject: `제목 ${n}` });

test('cards: one per message (title = sender, body = subject), a summary over the limit', () => {
  const one = cardsFor([arrival(1)]);
  assert.equal(one.length, 1);
  assert.deepEqual([one[0].type, one[0].title, one[0].body, one[0].icon, one[0].tag], ['card', '보낸이1', '제목 1 · 회사', 'mail', 'mail:a:1']);
  assert.deepEqual(one[0].actions.map((a) => [a.id, a.label]), [['open', '열기'], ['read', '읽음']]);
  assert.equal(cardsFor([1, 2, 3].map((n) => arrival(n))).length, SUMMARY_OVER);
  const many = cardsFor([1, 2, 3, 4, 5].map((n) => arrival(n)));
  assert.equal(many.length, 1);
  assert.equal(many[0].title, '새 메일 5통');
  assert.match(many[0].body, /^보낸이1, 보낸이2 외 3명 · 제목 5$/);
  assert.deepEqual(many[0].ids, ['a:1', 'a:2', 'a:3', 'a:4', 'a:5']);
  assert.equal(cardsFor([{ ...arrival(1), from: null, subject: '' }])[0].title, '(보낸 사람 없음)');
});

test('notifier: collects arrivals from several accounts, skips switched-off accounts', () => {
  const timers = [];
  const sent = [];
  const n = createNotifier({ enabled: (id) => id !== 'off', send: (c) => sent.push(c), setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  n.add([arrival(1, 'a')]);
  n.add([arrival(2, 'off'), arrival(3, 'b')]);
  assert.equal(timers.length, 1, 'one collect window');
  timers[0]();
  assert.deepEqual(sent.map((cards) => cards.map((c) => c.tag)), [['mail:a:1', 'mail:b:3']]);
  n.add([arrival(4, 'off')]);
  timers[1]();
  assert.equal(sent.length, 1, 'nothing to send');
});

const msg = {
  from: { name: '김부장', address: 'boss@x.test' },
  to: [{ name: '나', address: 'me@x.test' }, { name: '', address: 'kim@x.test' }],
  cc: [{ name: '', address: 'BOSS@x.test' }, { name: '', address: 'lee@x.test' }],
  replyTo: [],
  subject: '회의 자료',
  date: Date.parse('2026-10-19T01:00:00Z'),
  messageId: '<abc@x.test>',
};

test('mailto: encoded subject and body, @ kept, reply / reply all / forward, Re: not doubled', () => {
  assert.equal(buildMailto({ to: ['a@b.test'], subject: '안 녕&?', body: 'x\ny' }), 'mailto:a@b.test?subject=%EC%95%88%20%EB%85%95%26%3F&body=x%0D%0Ay');
  assert.equal(buildMailto({ to: ['bad address', 'x@y.test?cc=evil@z.test'] }), 'mailto:', 'unsafe addresses are dropped');
  const reply = mailtoFor('reply', { msg, text: '본문' });
  assert.match(reply, /^mailto:boss@x\.test\?subject=Re%3A%20/);
  assert.match(decodeURIComponent(reply), /김부장 <boss@x\.test> 작성:\r\n> 본문/);
  const all = mailtoFor('replyAll', { msg, text: '', self: 'me@x.test' });
  assert.match(all, /^mailto:boss@x\.test\?cc=kim@x\.test,lee@x\.test&/, 'self and duplicates left out');
  assert.match(mailtoFor('reply', { msg: { ...msg, subject: 'RE: 회의' } }), /subject=RE%3A%20%ED%9A%8C%EC%9D%98/);
  const fwd = decodeURIComponent(mailtoFor('forward', { msg, text: '원문' }));
  assert.match(fwd, /^mailto:\?subject=Fwd: 회의 자료&body=/);
  assert.match(fwd, /전달된 메일/);
  assert.equal(mailtoFor('compose', { to: 'a@b.test' }), 'mailto:a@b.test');
  assert.equal(mailtoFor('reply', { msg: { ...msg, replyTo: [{ address: 'list@x.test' }] } }).split('?')[0], 'mailto:list@x.test', 'Reply-To wins');
});

test('mailto length cap: the quoted body is cut (with …) so the link stays under the limit', () => {
  const long = '가'.repeat(3000);
  const url = mailtoFor('reply', { msg, text: long });
  assert.ok(url.length <= MAX_MAILTO, String(url.length));
  assert.match(decodeURIComponent(url), /…$/);
  assert.ok(buildMailto({ to: ['a@b.test'], subject: 's', body: 'x'.repeat(5000) }).length <= MAX_MAILTO);
});

test('webmail: Gmail compose / reply / open by Message-ID; others open their start page', () => {
  const gmail = { provider: 'gmail', webmail: 'https://mail.google.com/' };
  assert.equal(webmailFor(gmail, 'compose', { to: 'a@b.test' }), 'https://mail.google.com/mail/?view=cm&fs=1&to=a%40b.test');
  const r = new URL(webmailFor(gmail, 'reply', { msg }));
  assert.deepEqual([r.searchParams.get('to'), r.searchParams.get('su')], ['boss@x.test', 'Re: 회의 자료']);
  assert.equal(webmailFor(gmail, 'open', { msg }), 'https://mail.google.com/mail/#search/rfc822msgid%3Aabc%40x.test');
  assert.equal(webmailFor({ provider: 'naver', webmail: 'https://mail.naver.com/' }, 'reply', { msg }), 'https://mail.naver.com/');
  assert.equal(webmailFor({ provider: 'other', webmail: '' }, 'compose', {}), '');
});
