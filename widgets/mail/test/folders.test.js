// "함께 볼 메일함" (#80): the picker list from LIST (special-use folders left out), the settings value, folder-aware
// ids and category keys, and one account's sync of chosen mailboxes against the fake IMAP server: the first look
// is silent, a folder is checked with STATUS and opened only when it changed, mail sorted into a folder by a
// server rule gives a card, read / flag / body act on the folder, INBOX keeps IDLE on the one connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountSync, folderKeyOf, FOLDER_POLL_MS } = require('../lib/account');
const { classify, pickerFolders, cleanFolders } = require('../lib/folders');
const { messageId, parseId, listItem } = require('../lib/inbox');
const { messageKey } = require('../lib/categories');
const { ImapClient } = require('../lib/imap-client');
const { FakeImap, textMessage } = require('./fake-imap');

const NOW = Date.now();
const H = 3600000;
const CAFE = { raw: '&znTTmA- &xUy5vA-', name: '카페 알림' }; // modified UTF-7 of "카페 알림"
const ACCOUNT = { id: 'a1', name: '회사', host: 'imap.x.test', port: 993, security: 'tls', username: 'me', folders: [CAFE] };

function memCache(initial = null) {
  const c = { data: initial, load: () => c.data && JSON.parse(JSON.stringify(c.data)), save: (d) => (c.data = JSON.parse(JSON.stringify(d))) };
  return c;
}

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

/** Long timers never fire, except the folder check, which runs every pollMs (null: never). */
const deps = (fake, pollMs) => ({
  ...fake.deps(),
  setTimeout: (fn, ms) => (ms === FOLDER_POLL_MS && pollMs ? setTimeout(fn, pollMs) : ms > 2000 ? { never: true } : setTimeout(fn, ms)),
  clearTimeout: (t) => (t && !t.never ? clearTimeout(t) : undefined),
});

async function setup(t, { inbox = [], folder = [], account = ACCOUNT, pollMs = null, cache = memCache() } = {}) {
  const fake = new FakeImap({ messages: inbox });
  fake.boxes['카페 알림'] = { flags: [], messages: folder, uidValidity: 9 };
  fake.boxes['Sent'] = { flags: ['\\Sent'], messages: [] };
  await fake.listen();
  const sync = new AccountSync({ account, password: () => 'pw', cache, deps: deps(fake, pollMs), cacheSize: 50, pageSize: 2 });
  const arrivals = [];
  sync.on('new', (list) => arrivals.push(...list));
  t.after(async () => {
    await sync.stop();
    await fake.close();
  });
  return { fake, sync, arrivals, cache };
}

const synced = (sync) => waitFor(() => sync.status.state === 'ok' && !sync.dirty && [...sync.folders.values()].every((f) => f.known));
const KEY = folderKeyOf(CAFE.raw);

// ---- pure parts ----

test('#80 picker: INBOX left out; sent / drafts / trash / junk / all-mail marked by SPECIAL-USE or name; \\Noselect not selectable', () => {
  const list = pickerFolders([
    { name: 'INBOX', raw: 'INBOX', flags: [] },
    { name: '카페 알림', raw: '&znTTmA- &xUy5vA-', flags: ['\\HasNoChildren'] },
    { name: 'Sent Items', raw: 'Sent Items', flags: [] },
    { name: '보낸편지함', raw: 'x1', flags: [] },
    { name: 'Archive2', raw: 'a2', flags: ['\\Sent'] },
    { name: 'Drafts', raw: 'Drafts', flags: ['\\Drafts'] },
    { name: '휴지통', raw: 't', flags: [] },
    { name: 'Spam', raw: 'Spam', flags: [] },
    { name: '[Gmail]/All Mail', raw: '[Gmail]/All Mail', flags: ['\\All'], delimiter: '/' },
    { name: '[Gmail]', raw: '[Gmail]', flags: ['\\Noselect'] },
    { name: '뉴스레터', raw: '&usSyKA-', flags: [] },
  ]);
  assert.deepEqual(list.map((f) => f.name), ['카페 알림', 'Sent Items', '보낸편지함', 'Archive2', 'Drafts', '휴지통', 'Spam', '[Gmail]/All Mail', '[Gmail]', '뉴스레터']);
  const by = Object.fromEntries(list.map((f) => [f.name, f]));
  assert.equal(by['카페 알림'].selectable, true);
  assert.equal(by['카페 알림'].raw, '&znTTmA- &xUy5vA-');
  assert.equal(by['뉴스레터'].selectable, true);
  for (const n of ['Sent Items', '보낸편지함', 'Archive2']) assert.equal(by[n].special, 'sent', n);
  assert.equal(by.Drafts.special, 'drafts');
  assert.equal(by['휴지통'].special, 'trash');
  assert.equal(by.Spam.special, 'junk');
  assert.equal(by['[Gmail]/All Mail'].special, 'all');
  for (const f of list.filter((x) => x.special)) assert.equal(f.selectable, false, f.name);
  assert.equal(by['[Gmail]'].selectable, false);
  assert.equal(classify({ name: 'Sent', raw: 'Sent', flags: [] }).specialLabel, '보낸편지함');
});

test('#80 settings value: raw + name, INBOX / duplicates / line breaks / junk dropped, at most 10', () => {
  assert.deepEqual(cleanFolders([{ raw: 'A', name: '가' }, { raw: 'A', name: 'again' }, { raw: 'inbox' }, { raw: 'B\r\nX' }, { raw: '' }, null, { raw: 'C' }]), [
    { raw: 'A', name: '가' },
    { raw: 'C', name: 'C' },
  ]);
  assert.equal(cleanFolders(Array.from({ length: 15 }, (_, i) => ({ raw: `f${i}` }))).length, 10);
  assert.deepEqual(cleanFolders('nope'), []);
});

test('#80 ids: INBOX "acc:uid", a folder "acc:<key>:uid"; list items carry folder and folderKey; category keys per folder without Message-ID', () => {
  assert.match(KEY, /^[0-9a-f]{8}$/);
  assert.equal(messageId('a1', 5), 'a1:5');
  assert.equal(messageId('a1', 5, KEY), `a1:${KEY}:5`);
  assert.deepEqual(parseId(`a1:${KEY}:5`), { accountId: 'a1', folderKey: KEY, uid: 5 });
  assert.deepEqual(parseId('a1:5'), { accountId: 'a1', folderKey: '', uid: 5 });
  assert.equal(parseId('a1:zz:5'), null);
  const item = listItem({ id: 'a1', name: '회사', color: '#fff' }, { uid: 5, folder: '카페 알림', folderKey: KEY, date: 1 });
  assert.equal(item.id, `a1:${KEY}:5`);
  assert.equal(item.folder, '카페 알림');
  assert.equal(listItem({ id: 'a1' }, { uid: 5 }).folder, 'INBOX');
  // Categories follow the Message-ID wherever the mail is; without one, the folder and its UIDVALIDITY count.
  assert.equal(messageKey('a1', { uid: 5, folderKey: KEY, messageId: '<X@y>' }, 1), 'a1|mid:x@y');
  assert.equal(messageKey('a1', { uid: 5, folderKey: KEY, uidValidity: 9 }, 1), `a1|uid:${KEY}:9:5`);
  assert.notEqual(messageKey('a1', { uid: 5, folderKey: KEY, uidValidity: 9 }, 9), messageKey('a1', { uid: 5 }, 9));
});

test('#80 client: LIST decodes modified UTF-7 names and keeps the raw one; STATUS by raw name', async (t) => {
  const fake = new FakeImap({ messages: [textMessage(1)] });
  fake.boxes['카페 알림'] = { flags: [], messages: [textMessage(4, { flags: ['\\Seen'] }), textMessage(7)], uidValidity: 9 };
  await fake.listen();
  t.after(() => fake.close());
  const c = new ImapClient({ host: 'x', port: 993, security: 'tls', username: 'me', password: 'pw', deps: fake.deps() });
  await c.open();
  const boxes = await c.list();
  const cafe = boxes.find((b) => b.name === '카페 알림');
  assert.equal(cafe.raw, CAFE.raw);
  assert.deepEqual(await c.status(cafe.raw, ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN']), { MESSAGES: 2, UIDNEXT: 8, UIDVALIDITY: 9, UNSEEN: 1 });
  c.close();
});

// ---- one account with a chosen mailbox ----

test('#80 first look at a chosen mailbox is silent; its mail joins the list with the folder name; counts add up', async (t) => {
  const { sync, arrivals, fake } = await setup(t, {
    inbox: [textMessage(1, { date: NOW - 3 * H, subject: 'inbox mail' })],
    folder: [textMessage(10, { date: NOW - H, subject: 'cafe new', text: '카페 글' }), textMessage(11, { date: NOW - 2 * H, flags: ['\\Seen', '\\Flagged'] })],
  });
  sync.start();
  await synced(sync);
  assert.deepEqual(sync.list().map((m) => [m.uid, m.folder || 'INBOX']), [
    [10, '카페 알림'],
    [11, '카페 알림'],
    [1, 'INBOX'],
  ]);
  assert.equal(sync.find(10, KEY).snippet, '카페 글');
  assert.equal(sync.find(10, KEY).folderKey, KEY);
  assert.equal(sync.find(10), null, 'uid 10 is not an INBOX message');
  assert.equal(sync.totalUnread(), 2);
  assert.equal(sync.totalFlagged(), 1);
  assert.deepEqual(sync.folderInfo(), [{ key: KEY, name: '카페 알림', unread: 1, error: null }]);
  assert.deepEqual(arrivals, []);
  assert.equal(fake.conns.size, 1, 'one connection per account');
  // IDLE stays on INBOX: new INBOX mail still arrives through it.
  fake.deliver(textMessage(2, { date: NOW, subject: 'inbox new' }));
  await waitFor(() => arrivals.length === 1);
  assert.equal(arrivals[0].subject, 'inbox new');
  assert.equal(arrivals[0].folderKey, undefined);
});

test('#80 the folder is checked with STATUS every few minutes and opened only when it changed; a rule-sorted arrival gives a card', async (t) => {
  const { sync, arrivals, fake } = await setup(t, { inbox: [textMessage(1, { date: NOW - H })], folder: [textMessage(10, { date: NOW - H })], pollMs: 40 });
  sync.start();
  await synced(sync);
  const selects = fake.selectLog.filter((n) => n !== 'INBOX').length;
  const statuses = fake.statusCount;
  await waitFor(() => fake.statusCount >= statuses + 3);
  assert.equal(fake.selectLog.filter((n) => n !== 'INBOX').length, selects, 'unchanged folder: STATUS only, no SELECT');
  // A server rule moves new mail into the folder.
  fake.deliverTo('카페 알림', textMessage(12, { date: NOW, subject: '규칙으로 옮겨진 메일' }));
  await waitFor(() => arrivals.length === 1);
  assert.equal(arrivals[0].subject, '규칙으로 옮겨진 메일');
  assert.equal(arrivals[0].folder, '카페 알림');
  assert.equal(arrivals[0].folderKey, KEY);
  assert.ok(sync.find(12, KEY));
  assert.equal(sync.totalUnread(), 3);
  assert.equal(fake.conns.size, 1);
  // Back on INBOX after the folder look: INBOX IDLE still delivers.
  fake.deliver(textMessage(2, { date: NOW, subject: 'inbox' }));
  await waitFor(() => arrivals.length === 2);
});

test('#80 a mailbox added later starts silent (no cards for what it already holds); removed ones leave the list', async (t) => {
  const { sync, arrivals } = await setup(t, {
    account: { ...ACCOUNT, folders: [] },
    inbox: [textMessage(1, { date: NOW - H })],
    folder: [textMessage(10, { date: NOW - 60000, subject: 'already there' })],
  });
  sync.start();
  await waitFor(() => sync.status.state === 'ok' && !sync.dirty);
  assert.equal(sync.list().length, 1);
  sync.account = { ...ACCOUNT };
  await sync.refresh();
  assert.equal(sync.list().length, 2);
  assert.deepEqual(arrivals, [], 'the first look at a newly added mailbox is silent');
  sync.account = { ...ACCOUNT, folders: [] };
  await sync.refresh();
  assert.deepEqual(sync.list().map((m) => m.uid), [1]);
  assert.equal(sync.totalUnread(), 1);
});

test('#80 read / flag / body act on the folder (and INBOX is selected again); the same UID in INBOX is untouched', async (t) => {
  const { sync, fake } = await setup(t, {
    inbox: [textMessage(10, { date: NOW - 2 * H, subject: 'inbox ten', text: 'INBOX 본문' })],
    folder: [textMessage(10, { date: NOW - H, subject: 'folder ten', text: '폴더 본문' })],
  });
  sync.start();
  await synced(sync);
  const folderMsg = fake.boxes['카페 알림'].messages[0];
  await sync.setSeen(10, true, KEY);
  assert.ok(folderMsg.flags.includes('\\Seen'));
  assert.ok(!fake.messages[0].flags.includes('\\Seen'), 'INBOX uid 10 untouched');
  assert.equal(sync.find(10, KEY).unread, false);
  assert.equal(sync.find(10).unread, true);
  assert.equal(sync.totalUnread(), 1);
  await sync.setFlag(10, '\\Flagged', true, KEY);
  assert.ok(folderMsg.flags.includes('\\Flagged'));
  const body = await sync.body(10, KEY);
  assert.match(body.text, /폴더 본문/);
  assert.match((await sync.body(10)).text, /INBOX 본문/);
  assert.equal(fake.selectLog[fake.selectLog.length - 1], 'INBOX', 'INBOX selected again');
  // Our own read does not make the next check reopen the folder.
  const f = sync.folders.get(KEY);
  const st = await sync.exec((c) => c.status(f.raw, ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN']));
  assert.equal(f.sig, `${st.UIDVALIDITY}:${st.UIDNEXT}:${st.MESSAGES}:${st.UNSEEN}`);
});

test('#80 a message in INBOX and in a folder (Gmail labels) shows once, from INBOX; a missing folder is an error line, INBOX goes on', async (t) => {
  const { sync, fake } = await setup(t, {
    account: { ...ACCOUNT, folders: [CAFE, { raw: 'Gone', name: '없는 메일함' }] },
    inbox: [textMessage(1, { date: NOW - H, messageId: '<same@x>' })],
    folder: [textMessage(5, { date: NOW - H, messageId: '<same@x>' }), textMessage(6, { date: NOW - 2 * H })],
  });
  sync.start();
  await waitFor(() => sync.status.state === 'ok' && !sync.dirty && sync.folders.get(KEY).known);
  assert.deepEqual(sync.list().map((m) => [m.uid, m.folderKey || '']), [
    [1, ''],
    [6, KEY],
  ]);
  const gone = sync.folderInfo().find((x) => x.name === '없는 메일함');
  assert.ok(gone.error);
  assert.equal(sync.status.state, 'ok');
  assert.equal(fake.conns.size, 1);
});

test('#80 the cache keeps folder headers without snippets; a restart shows them at once and reopens only what changed', async (t) => {
  const cache = memCache();
  {
    const { sync } = await setup(t, { inbox: [textMessage(1, { date: NOW - H })], folder: [textMessage(10, { date: NOW - H, text: '비밀 본문' })], cache });
    sync.start();
    await synced(sync);
    await sync.stop();
  }
  const saved = JSON.stringify(cache.data);
  assert.equal(cache.data.folders.length, 1);
  assert.equal(cache.data.folders[0].messages.length, 1);
  assert.ok(!/비밀 본문|snippet/.test(saved));
  const fake = new FakeImap({ messages: [textMessage(1, { date: NOW - H })] });
  fake.boxes['카페 알림'] = { flags: [], messages: [textMessage(10, { date: NOW - H, text: '비밀 본문' })], uidValidity: 9 };
  await fake.listen();
  const sync = new AccountSync({ account: ACCOUNT, password: () => 'pw', cache, deps: deps(fake, null), cacheSize: 50, pageSize: 2 });
  t.after(async () => {
    await sync.stop();
    await fake.close();
  });
  assert.ok(sync.find(10, KEY), 'shown from the cache before connecting');
  assert.equal(sync.find(10, KEY).folder, '카페 알림');
  sync.start();
  await waitFor(() => sync.status.state === 'ok' && !sync.dirty && fake.statusCount >= 1);
  assert.equal((fake.selectLog || []).filter((n) => n !== 'INBOX').length, 0, 'unchanged since the cache: not opened');
});
