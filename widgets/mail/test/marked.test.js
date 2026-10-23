// 안 읽음 / 중요 from the server (#83): the counts and the lists behind them are the same UID SEARCH UNSEEN /
// FLAGGED of INBOX and the chosen mailboxes, also for mail older than the loaded headers; 더 보기 fetches more of
// that list; read / flag changes (here or elsewhere) move both together.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountSync, folderKeyOf } = require('../lib/account');
const { FakeImap, textMessage } = require('./fake-imap');

const NOW = Date.now();
const H = 3600000;
const CAFE = { raw: '&znTTmA- &xUy5vA-', name: '카페 알림' };
const KEY = folderKeyOf(CAFE.raw);
const ACCOUNT = { id: 'a1', name: '회사', host: 'imap.x.test', port: 993, security: 'tls', username: 'me', folders: [CAFE] };

const deps = (fake) => ({
  ...fake.deps(),
  setTimeout: (fn, ms) => (ms > 2000 ? { never: true } : setTimeout(fn, ms)),
  clearTimeout: (t) => (t && !t.never ? clearTimeout(t) : undefined),
});

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

/** INBOX of n messages (uid 1 oldest) and a folder of m; flags by uid. */
function box(n, { flagged = [], read = () => true, base = 0, start = 1, tag = 'i' } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const uid = start + i;
    const flags = [];
    if (read(uid)) flags.push('\\Seen');
    if (flagged.includes(uid)) flags.push('\\Flagged');
    return textMessage(uid, { date: NOW - base - (n - i) * H, subject: `m${uid}`, flags, messageId: `<${tag}${uid}@x.test>` });
  });
}

async function setup(t, { inbox, folder, cacheSize = 10, account = ACCOUNT } = {}) {
  const fake = new FakeImap({ messages: inbox });
  fake.boxes['카페 알림'] = { flags: [], messages: folder, uidValidity: 9 };
  await fake.listen();
  const sync = new AccountSync({ account, password: () => 'pw', cache: null, deps: deps(fake), cacheSize, pageSize: 5 });
  t.after(async () => {
    await sync.stop();
    await fake.close();
  });
  sync.start();
  await waitFor(() => sync.status.state === 'ok' && !sync.dirty && sync.folders.get(KEY)?.known);
  return { fake, sync };
}

test('#83 중요: the count and the list are the same server list, old flagged mail included, INBOX + folder', async (t) => {
  const { sync } = await setup(t, {
    inbox: box(60, { flagged: [3, 15, 40, 55] }),
    folder: box(30, { flagged: [2, 5], base: 100 * H, tag: 'f' }),
  });
  assert.equal(sync.totalFlagged(), 6, 'server count: 4 in INBOX + 2 in the folder');
  const before = sync.markedList({ flagged: true });
  assert.equal(before.total, 6);
  assert.equal(before.missing, true, 'most of them are older than the loaded headers');
  assert.ok(before.headers.length < 6);
  assert.equal(await sync.demandMarked({ flagged: true }, 200), 5);
  const after = sync.markedList({ flagged: true });
  assert.equal(after.headers.length, sync.totalFlagged());
  assert.equal(after.missing, false);
  assert.deepEqual(after.headers.map((h) => [h.folderKey || '', h.uid]), [
    ['', 55],
    ['', 40],
    ['', 15],
    ['', 3],
    [KEY, 5],
    [KEY, 2],
  ]);
  assert.ok(after.headers.every((h) => h.flagged));
  assert.equal(after.headers[4].folder, '카페 알림');
  assert.ok(after.headers[3].snippet !== null, 'fetched with a snippet like loaded mail');
  // The default list (no filter) stays the newest loaded headers only.
  assert.equal(sync.list().length, 20);
  // Opening / unflagging one of them works through the same lookup.
  assert.ok(sync.find(3));
  await sync.setFlag(3, '\\Flagged', false);
  assert.equal(sync.totalFlagged(), 5);
  assert.equal(sync.markedList({ flagged: true }).headers.length, 5);
  await sync.setFlag(2, '\\Flagged', false, KEY);
  assert.equal(sync.totalFlagged(), 4);
  assert.deepEqual(sync.folderInfo(), [{ key: KEY, name: '카페 알림', unread: 0, error: null }]);
});

test('#83 안 읽음: unread count == unread list across INBOX and the folder; reading moves both; paging by n per mailbox', async (t) => {
  const unreadInbox = [1, 2, 4, 8, 16, 32, 50, 59];
  const unreadFolder = [1, 7, 20];
  const { sync, fake } = await setup(t, {
    inbox: box(60, { read: (u) => !unreadInbox.includes(u) }),
    folder: box(30, { read: (u) => !unreadFolder.includes(u), base: 100 * H, tag: 'f' }),
  });
  assert.equal(sync.totalUnread(), 11);
  // Paging: 2 per mailbox first, then 4, then everything.
  await sync.demandMarked({ unread: true }, 2);
  let m = sync.markedList({ unread: true });
  assert.equal(m.total, 11);
  assert.equal(m.missing, true);
  assert.deepEqual(
    m.headers.filter((h) => !h.folderKey).map((h) => h.uid),
    [59, 50],
    'INBOX: the newest two (both in the loaded range)',
  );
  await sync.demandMarked({ unread: true }, 4);
  m = sync.markedList({ unread: true });
  assert.equal(m.headers.length, 7);
  await sync.demandMarked({ unread: true }, 200);
  m = sync.markedList({ unread: true });
  assert.equal(m.headers.length, 11);
  assert.equal(m.missing, false);
  assert.ok(m.headers.every((h) => h.unread));
  // Read here: count and list drop together.
  await sync.setSeen(4, true);
  await sync.setSeen(7, true, KEY);
  assert.equal(sync.totalUnread(), 9);
  assert.equal(sync.markedList({ unread: true }).headers.length, 9);
  // Read elsewhere (another program) and an old message marked unread there: after the next check both follow,
  // and the newly unread old message's header is fetched because the list is open.
  fake.messages[0].flags.push('\\Seen'); // uid 1
  fake.messages[9].flags = fake.messages[9].flags.filter((f) => f !== '\\Seen'); // uid 10
  await sync.refresh();
  m = sync.markedList({ unread: true });
  assert.equal(sync.totalUnread(), 9);
  assert.equal(m.headers.length, 9);
  assert.ok(m.headers.some((h) => h.uid === 10 && !h.folderKey));
  assert.ok(!m.headers.some((h) => h.uid === 1 && !h.folderKey));
  // Closing the list lets the extra headers go; the count stays.
  await sync.demandMarked({}, 0);
  assert.equal(sync.totalUnread(), 9);
  assert.equal(sync.markedList({ unread: true }).missing, true);
});

test('#83 a message in INBOX and in a folder (Gmail labels) counts once, like it shows once', async (t) => {
  const inbox = box(3, { flagged: [3] });
  inbox[2].messageId = '<same@x>';
  const folder = box(2, { flagged: [1, 2], base: 10 * H, tag: 'f' });
  folder[1].messageId = '<same@x>';
  const { sync } = await setup(t, { inbox, folder });
  await sync.demandMarked({ flagged: true }, 200);
  const m = sync.markedList({ flagged: true });
  assert.equal(m.headers.length, 2);
  assert.equal(m.total, 2);
  assert.equal(sync.totalFlagged(), 2);
});
