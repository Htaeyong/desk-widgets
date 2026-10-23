// Recipient chips (#68): the shared address module used by the composer page and the main code
// (composer/addresses.js), and the reply / reply-all prefill rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../composer/addresses');
const { replyRecipients } = require('../lib/handoff');

test('pasted text -> one chip per address; quotes and <> protect commas; red chips for non-addresses', () => {
  assert.deepEqual(A.splitEntries('홍길동 <hong@example.com>, b@x.com'), ['홍길동 <hong@example.com>', 'b@x.com']);
  assert.deepEqual(A.splitEntries('"Kim, J" <k@y.com>; a@b.co\n\tc@d.io,,'), ['"Kim, J" <k@y.com>', 'a@b.co', 'c@d.io']);
  assert.deepEqual(A.parseEntry('홍길동 <hong@example.com>'), { name: '홍길동', address: 'hong@example.com', valid: true, raw: '홍길동 <hong@example.com>' });
  assert.deepEqual(A.parseEntry('"Kim, J" <k@y.com>'), { name: 'Kim, J', address: 'k@y.com', valid: true, raw: '"Kim, J" <k@y.com>' });
  assert.equal(A.parseEntry('a@b.co').name, '');
  for (const bad of ['bad', 'x@y', 'a@@b.co', '<>', 'a b@c.co', '이름만 <>']) assert.equal(A.parseEntry(bad).valid, false, bad);
  const { list, bad } = A.parseAddresses('홍길동 <hong@example.com>, b@x.com, B@X.com; 오타@');
  assert.deepEqual(list, [{ name: '홍길동', address: 'hong@example.com' }, { name: '', address: 'b@x.com' }], 'duplicates dropped (case-insensitive)');
  assert.deepEqual(bad, ['오타@']);
});

test('chip label and tooltip', () => {
  assert.equal(A.chipLabel({ name: '홍길동', address: 'hong@example.com' }), '홍길동');
  assert.equal(A.chipLabel({ name: '', address: 'b@x.com' }), 'b@x.com');
  assert.equal(A.fullText({ name: '홍길동', address: 'hong@example.com' }), '홍길동 <hong@example.com>');
  assert.equal(A.fullText({ name: '', address: 'b@x.com' }), 'b@x.com');
});

test('checkList before sending: lists of { name, address } pass; red chips, injection and >100 are refused', () => {
  assert.deepEqual(A.checkList([{ name: '홍길동', address: 'hong@example.com' }, { name: '', address: 'HONG@example.com' }, { name: 'b', address: 'b@x.com' }]), {
    list: [{ name: '홍길동', address: 'hong@example.com' }, { name: 'b', address: 'b@x.com' }],
  });
  assert.match(A.checkList([{ address: 'not an address', invalid: true }]).error, /올바르지 않습니다: not an address/);
  assert.match(A.checkList([{ address: 'a@b.co', invalid: true }]).error, /올바르지 않습니다/, 'a chip the page marked red stays refused');
  assert.ok(A.checkList([{ address: 'a@b.co\r\nBcc: z@z.co' }]).error, 'no header injection through an address');
  assert.equal(A.checkList([{ name: 'x\r\nBcc: z@z.co', address: 'a@b.co' }]).list[0].name, 'x Bcc: z@z.co', 'line breaks in a name are flattened');
  assert.match(A.checkList(Array.from({ length: 101 }, (_, i) => ({ address: `u${i}@x.co` }))).error, /100명/);
  assert.deepEqual(A.checkList(null), { list: [] });
});

test('prefill: reply = Reply-To or From; reply all adds To / Cc without the sending account and duplicates', () => {
  const msg = {
    from: { name: '김부장', address: 'boss@y.test' },
    replyTo: [],
    to: [{ name: '나', address: 'me@x.test' }, { name: '', address: 'kim@y.test' }],
    cc: [{ name: '', address: 'BOSS@y.test' }, { name: '이대리', address: 'lee@y.test' }, { name: '', address: 'ME@x.test' }],
  };
  assert.deepEqual(replyRecipients('reply', msg, 'me@x.test'), { to: [msg.from], cc: [] });
  const all = replyRecipients('replyAll', msg, 'me@x.test');
  assert.deepEqual(all.to, [msg.from]);
  assert.deepEqual(all.cc.map((a) => a.address), ['kim@y.test', 'lee@y.test'], 'own address (any case) and From left out');
  assert.deepEqual(replyRecipients('reply', { ...msg, replyTo: [{ name: '목록', address: 'list@y.test' }] }, 'me@x.test').to, [{ name: '목록', address: 'list@y.test' }]);
  // Replying to a mail the account sent itself keeps the own address rather than an empty To.
  assert.deepEqual(replyRecipients('reply', { ...msg, from: { name: '나', address: 'me@x.test' } }, 'me@x.test').to.map((a) => a.address), ['me@x.test']);
});

const { swapSignature } = require('../composer/signature');
const { composeBody } = require('../lib/handoff');

test('signature: new / reply / forward get it; changing the sending account swaps it only if unedited', () => {
  const msg = { from: { name: '김부장', address: 'boss@y.test' }, to: [], cc: [], subject: 's', date: Date.now() };
  for (const action of ['compose', 'reply', 'forward']) assert.match(composeBody(action, { msg, text: '원문', signature: '홍길동 드림' }), /\n\n-- \n홍길동 드림/, action);
  const reply = composeBody('reply', { msg, text: '원문', signature: '회사 서명' });
  const swapped = swapSignature(reply, '회사 서명', '개인 서명');
  assert.equal(swapped.swapped, true);
  assert.ok(swapped.body.includes('-- \n개인 서명') && !swapped.body.includes('회사 서명'));
  assert.ok(swapped.body.indexOf('개인 서명') < swapped.body.indexOf('님이 작성'), 'still above the quote');
  // Edited by the user: left alone.
  const edited = reply.replace('회사 서명', '회사 서명 (오늘은 재택)');
  assert.deepEqual(swapSignature(edited, '회사 서명', '개인 서명'), { body: edited, swapped: false });
  // To an account without a signature: removed; from none to one: inserted after the first line.
  assert.equal(swapSignature(reply, '회사 서명', '').body.includes('-- '), false);
  const none = composeBody('reply', { msg, text: '원문', signature: '' });
  const added = swapSignature(none, '', '새 서명');
  assert.equal(added.swapped, true);
  assert.ok(added.body.indexOf('-- \n새 서명') < added.body.indexOf('님이 작성'));
  assert.equal(swapSignature('본문만', '', '').swapped, false);
});
