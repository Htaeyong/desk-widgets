// One account's sync against the fake IMAP server (#65): first sync silent, new mail through IDLE, flags and
// deletes from other clients, UIDVALIDITY change, no retry loop after a refused login, paging, bodies, flags,
// pause / resume, and a cache without bodies or snippets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountSync, parseInternalDate } = require('../lib/account');
const { FakeImap, textMessage, altMessage } = require('./fake-imap');

const ACCOUNT = { id: 'a1', name: '회사', host: 'imap.x.test', port: 993, security: 'tls', username: 'me' };
const NOW = Date.now();
const H = 3600000;

/** Long timers (IDLE refresh, backoff) never fire in tests; short ones run. */
const deps = (fake) => ({
  ...fake.deps(),
  setTimeout: (fn, ms) => (ms > 2000 ? { never: true } : setTimeout(fn, ms)),
  clearTimeout: (t) => (t && !t.never ? clearTimeout(t) : undefined),
});

function memCache(initial = null) {
  const c = { data: initial, load: () => c.data && JSON.parse(JSON.stringify(c.data)), save: (d) => (c.data = JSON.parse(JSON.stringify(d))) };
  return c;
}

async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

async function setup(t, { messages, cache = memCache(), cacheSize = 50, server = {} } = {}) {
  const fake = new FakeImap({ messages, ...server });
  await fake.listen();
  const sync = new AccountSync({ account: ACCOUNT, password: () => 'pw', cache, deps: deps(fake), cacheSize, pageSize: 2 });
  const arrivals = [];
  sync.on('new', (list) => arrivals.push(...list));
  t.after(async () => {
    await sync.stop();
    await fake.close();
  });
  return { fake, sync, arrivals, cache };
}

const synced = (sync) => waitFor(() => sync.status.state === 'ok' && !sync.dirty);

test('INTERNALDATE parsing', () => {
  assert.equal(parseInternalDate('17-Jul-1996 02:44:25 -0700'), Date.parse('1996-07-17T09:44:25Z'));
  assert.equal(parseInternalDate(' 1-Jan-2026 00:00:00 +0900'), Date.parse('2025-12-31T15:00:00Z'));
  assert.equal(parseInternalDate('nonsense'), null);
});

test('first sync is silent; headers newest first with snippets; the cache holds no snippets or bodies', async (t) => {
  const { sync, arrivals, cache } = await setup(t, {
    messages: [
      textMessage(1, { date: NOW - 3 * H, subject: '=?UTF-8?B?7ZWc6riA?=', text: '첫 번째 메일 본문' }),
      textMessage(2, { date: NOW - 2 * H, flags: ['\\Seen'], text: 'second' }),
      altMessage(3, { date: NOW - H, html: '<p>HTML <b>본문</b></p>', text: 'plain 본문', attachment: '보고서.pdf' }),
    ],
  });
  sync.start();
  await synced(sync);
  assert.deepEqual(sync.list().map((m) => m.uid), [3, 2, 1]);
  assert.equal(sync.list()[2].subject, '한글');
  assert.deepEqual(sync.list().map((m) => m.snippet), ['plain 본문', 'second', '첫 번째 메일 본문']);
  assert.equal(sync.list()[0].hasAttachments, true);
  assert.equal(sync.unread, 2);
  assert.deepEqual(arrivals, [], 'no cards on the first sync');
  const saved = JSON.stringify(cache.data);
  assert.equal(cache.data.messages.length, 3);
  assert.ok(!/본문|second|snippet/.test(saved), 'no body text or snippet on disk');
  assert.equal(cache.data.uidValidity, 1);
});

test('new mail through IDLE: one "new" event; old or already read arrivals give none', async (t) => {
  const { fake, sync, arrivals } = await setup(t, { messages: [textMessage(1, { date: NOW - H })] });
  sync.start();
  await synced(sync);
  await waitFor(() => fake.log.some((l) => / IDLE$/.test(l)));
  fake.deliver(textMessage(2, { date: NOW, subject: '새 메일', from: { name: '김부장', address: 'boss@x.test' } }));
  await waitFor(() => arrivals.length === 1);
  assert.deepEqual([arrivals[0].uid, arrivals[0].subject, arrivals[0].from.name], [2, '새 메일', '김부장']);
  assert.equal(sync.list()[0].uid, 2);
  assert.ok(fake.log.includes('DONE'), 'IDLE ended before fetching');
  await waitFor(() => fake.log.filter((l) => / IDLE$/.test(l)).length >= 2);
  fake.deliver(textMessage(3, { date: NOW - 48 * H, subject: '옮겨진 옛 메일' }));
  fake.deliver(textMessage(4, { date: NOW, subject: '이미 읽음', flags: ['\\Seen'] }));
  await waitFor(() => sync.messages.has(4));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(arrivals.length, 1, 'older than 12 hours or read elsewhere: no card');
});

test('flags changed and mail deleted by another client are picked up', async (t) => {
  const { fake, sync } = await setup(t, { messages: [textMessage(1, { date: NOW - 2 * H }), textMessage(2, { date: NOW - H })] });
  sync.start();
  await synced(sync);
  assert.equal(sync.unread, 2);
  fake.messages[0].flags = ['\\Seen', '\\Flagged'];
  for (const c of fake.conns) c.send('* 1 FETCH (FLAGS (\\Seen \\Flagged))');
  await waitFor(() => sync.unread === 1 && sync.messages.get(1).flagged);
  fake.expunge(2);
  await waitFor(() => !sync.messages.has(2));
  assert.deepEqual(sync.list().map((m) => m.uid), [1]);
});

test('UIDVALIDITY changed since the cache: start over silently', async (t) => {
  const cache = memCache({ uidValidity: 1, highest: 9, hasMore: false, unread: 0, messages: [{ uid: 9, date: NOW, subject: 'old', from: null, structure: null }] });
  const { sync, arrivals } = await setup(t, { cache, server: { uidValidity: 2 }, messages: [textMessage(1, { date: NOW }), textMessage(2, { date: NOW })] });
  assert.equal(sync.list()[0].subject, 'old', 'the cache shows at once');
  sync.start();
  await synced(sync);
  assert.deepEqual(sync.list().map((m) => m.uid).sort(), [1, 2]);
  assert.deepEqual(arrivals, []);
  assert.equal(sync.uidValidity, 2);
});

test('restart with a cache: only newer UIDs are fetched; far behind keeps just the newest page', async (t) => {
  const cache = memCache({ uidValidity: 1, highest: 2, hasMore: false, unread: 0, messages: [{ uid: 2, date: NOW - H, subject: 'cached', from: null, structure: null, unread: true }, { uid: 1, date: NOW - 2 * H, subject: 'cached1', from: null, structure: null }] });
  const msgs = [1, 2, 3, 4, 5, 6].map((u) => textMessage(u, { date: NOW - (10 - u) * 60000 }));
  const { fake, sync, arrivals } = await setup(t, { cache, cacheSize: 3, messages: msgs });
  sync.start();
  await synced(sync);
  assert.ok(fake.log.some((l) => /UID SEARCH UID 3:\*/.test(l)));
  assert.deepEqual(sync.list().map((m) => m.uid), [6, 5, 4], 'four new > cacheSize 3: newest page only');
  assert.equal(sync.hasMore, true);
  assert.deepEqual(arrivals, [], 'first sync of the run');
});

test('a refused login is not retried on its own; refresh() tries once more', async (t) => {
  const { fake, sync } = await setup(t, { messages: [], server: { pass: 'other' } });
  sync.start();
  await waitFor(() => sync.status.state === 'error');
  assert.equal(sync.status.kind, 'auth');
  assert.match(sync.status.error, /Invalid credentials/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.logins, 1, 'no retry loop (accounts can be locked by repeated failures)');
  sync.refresh();
  await waitFor(() => fake.logins === 2);
});

test('paging: older mail below the oldest loaded UID, hasMore ends', async (t) => {
  const msgs = [1, 2, 3, 4, 5].map((u) => textMessage(u, { date: NOW - (10 - u) * H }));
  const { sync } = await setup(t, { cacheSize: 2, messages: msgs });
  sync.start();
  await synced(sync);
  assert.deepEqual(sync.list().map((m) => m.uid), [5, 4]);
  assert.equal(sync.hasMore, true);
  assert.equal(await sync.loadMore(2), 2);
  assert.deepEqual(sync.list().map((m) => m.uid), [5, 4, 3, 2]);
  assert.equal(sync.list()[3].snippet, 'body');
  assert.equal(await sync.loadMore(2), 1);
  assert.equal(sync.hasMore, false);
});

test('body on demand (html, text, attachments) and \\Seen on the server', async (t) => {
  const { fake, sync } = await setup(t, { messages: [altMessage(1, { date: NOW, html: '<p>안녕</p>', text: '안녕', attachment: 'a.pdf' })] });
  sync.start();
  await synced(sync);
  const b = await sync.body(1);
  assert.equal(b.html, '<p>안녕</p>');
  assert.equal(b.text, '안녕');
  assert.deepEqual(b.attachments, [{ name: 'a.pdf', size: 3000, type: 'application/pdf' }]);
  assert.ok(fake.log.some((l) => /BODY\.PEEK\[1\.2\]/.test(l)), 'PEEK: reading does not mark it read by itself');
  assert.ok(!fake.log.some((l) => /BODY\.PEEK\[2\]/.test(l)), 'the attachment is not downloaded');
  await sync.setSeen(1, true);
  assert.deepEqual(fake.messages[0].flags, ['\\Seen']);
  assert.equal(sync.unread, 0);
  await sync.setSeen(1, false);
  assert.deepEqual(fake.messages[0].flags, []);
});

test('pause closes the connection; back: reconnect and mail that came meanwhile gets a card', async (t) => {
  const { fake, sync, arrivals } = await setup(t, { messages: [textMessage(1, { date: NOW - H })] });
  sync.start();
  await synced(sync);
  sync.setPaused(true);
  await waitFor(() => fake.conns.size === 0);
  assert.equal(sync.status.state, 'paused');
  fake.messages.push(textMessage(2, { date: NOW, subject: '자리 비운 동안' }));
  sync.setPaused(false);
  await waitFor(() => arrivals.length === 1);
  assert.equal(arrivals[0].subject, '자리 비운 동안');
});

test('#72 the 중요 count comes from the server (UID SEARCH FLAGGED over the whole INBOX)', async (t) => {
  const msgs = [1, 2, 3, 4].map((u) => textMessage(u, { date: NOW - u * H, flags: u <= 3 ? ['\\Flagged'] : [] }));
  const { fake, sync } = await setup(t, { cacheSize: 2, messages: msgs });
  sync.start();
  await synced(sync);
  assert.equal(sync.list().length, 2, 'only two headers loaded');
  assert.equal(sync.flagged, 3, 'but three flagged on the server');
  assert.ok(fake.log.some((l) => /SEARCH FLAGGED$/.test(l)));
});

test('#79 refresh(): resolves after a real re-check (also while IDLE) with the new mail it found; failures and pause answer too', async (t) => {
  const { fake, sync } = await setup(t, { messages: [textMessage(1, { date: NOW - H })] });
  sync.start();
  await synced(sync);
  await waitFor(() => fake.log.some((l) => / IDLE$/.test(l)));
  // A message the server did not announce (some servers do not push EXISTS reliably).
  fake.messages.push(textMessage(2, { date: NOW }));
  const res = await sync.refresh();
  assert.deepEqual(res, { ok: true, fresh: 1 });
  assert.ok(fake.log.includes('DONE'), 'the IDLE round ended for the check');
  assert.deepEqual(await sync.refresh(), { ok: true, fresh: 0 }, 'nothing new');
  sync.setPaused(true);
  assert.deepEqual(await sync.refresh(), { ok: true, paused: true, fresh: 0 });
});

test('#79 refresh() after a refused login: tries again and answers with the reason', async (t) => {
  const { fake, sync } = await setup(t, { messages: [], server: { pass: 'other' } });
  sync.start();
  await waitFor(() => sync.status.state === 'error');
  const res = await sync.refresh();
  assert.equal(res.ok, false);
  assert.match(res.message, /Invalid credentials/);
  assert.equal(fake.logins, 2);
});
