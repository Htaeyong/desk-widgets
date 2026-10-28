// Two simulated PCs (#108): each has its own userData folder with real engine stores; both share one temp
// "cloud" folder that only the engines write. Covers the cases a cloud desktop client produces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SyncManager } = require('../main/sync');
const { createStore } = require('../main/store');
const { createSyncStore } = require('../main/sync-store');
const { openFileStore } = require('../main/files-store');
const { openSecrets, containsSecret, forgetSecrets } = require('../main/secrets');

const TODO = {
  defaults: { themeId: 'light', selectedListId: '', tasks: [] },
  sync: { name: 'todo', collections: { tasks: { id: 'id', local: ['snoozedUntil'] } }, shared: ['themeId'], copy: (v) => ({ ...v, id: `${v.id}-copy` }) },
};
// A reversible stand-in for DPAPI: the "ciphertext" must not reach the cloud folder either.
const fakeCrypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().slice(4) };

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-two-pc-'));
  t.after(() => {
    forgetSecrets();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  const pcs = [];
  function pc(label, deviceId, { now = Date.now, notesDir: notesAt = null } = {}) {
    const userData = path.join(root, label);
    const manager = new SyncManager({ localDir: path.join(userData, 'sync'), folder: cloud, deviceId, deviceName: label, now, secretGuard: containsSecret });
    const todo = createSyncStore({ createStore, manager, widgetId: 'todo', options: { ...TODO, file: path.join(userData, 'widgets', 'todo', 'settings.json') } });
    const calendar = createSyncStore({ createStore, manager, widgetId: 'calendar', options: {
      file: path.join(userData, 'widgets', 'calendar', 'settings.json'), defaults: { sources: [] },
      sync: { name: 'settings', collections: { sources: { id: 'id', filter: (s) => s.type === 'caldav', local: ['enabled'], localDefaults: { enabled: false } } } },
    } });
    const secrets = openSecrets({ file: path.join(userData, 'widgets', 'calendar', 'secrets.json'), crypto: fakeCrypto });
    let notesDir = notesAt || path.join(userData, 'Documents', 'notes');
    const files = openFileStore(manager, 'memo', {
      name: 'notes', dir: () => notesDir, include: (rel) => /^[^/]+\.md$/.test(rel) || /^[^/]+\.assets\/[^/]+$/.test(rel),
      idOf: (rel, text) => /^desk-widgets-memo:\s*(.+)$/im.exec(text)?.[1] || rel, maxFileBytes: 1024 * 1024,
    });
    t.after(files.close);
    // setNotesDir: the user picks another note folder in the widget settings (nothing is moved).
    const self = { label, manager, todo, calendar, secrets, notes: files.handle, notesDir, userData, setNotesDir: (dir) => { notesDir = dir; self.notesDir = dir; } };
    pcs.push(self);
    return self;
  }
  const tasks = (p) => p.todo.load().tasks.map(({ id, title }) => ({ id, title })).sort((a, b) => a.id.localeCompare(b.id));
  const cloudText = () => {
    const out = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else out.push(fs.readFileSync(file).toString('latin1') + fs.readFileSync(file, 'utf8'));
      }
    };
    visit(cloud);
    return out.join('\n');
  };
  return { cloud, pc, tasks, cloudText };
}

test('first connection: the second PC receives what it does not have and uploads its own', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  a.todo.save({ tasks: [{ id: 't1', title: 'From A', snoozedUntil: 5 }] });
  b.todo.save({ tasks: [{ id: 't2', title: 'From B' }] });
  await a.manager.sync();
  const plan = await b.manager.preview();
  assert.deepEqual(plan.imports.map((i) => i.key), ['todo/tasks/t1']);
  assert.equal(plan.conflicts.length, 0);
  await b.manager.sync();
  await a.manager.sync();
  assert.deepEqual(w.tasks(a), [{ id: 't1', title: 'From A' }, { id: 't2', title: 'From B' }]);
  assert.deepEqual(w.tasks(b), w.tasks(a));
  assert.equal(b.todo.load().tasks.find((x) => x.id === 't1').snoozedUntil, undefined, 'PC-only fields never travel');
  assert.equal(a.todo.load().tasks.find((x) => x.id === 't1').snoozedUntil, 5);
});

test('concurrent edits of different items merge without asking', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  a.todo.save({ tasks: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }] });
  await a.manager.sync();
  await b.manager.sync();
  a.todo.save({ tasks: [{ id: 't1', title: 'One (A)' }, { id: 't2', title: 'Two' }] });
  b.todo.save({ tasks: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two (B)' }] });
  await a.manager.sync();
  const result = await b.manager.sync();
  assert.equal(result.conflicts.length, 0);
  await a.manager.sync();
  assert.deepEqual(w.tasks(a), [{ id: 't1', title: 'One (A)' }, { id: 't2', title: 'Two (B)' }]);
  assert.deepEqual(w.tasks(b), w.tasks(a));
});

test('the same item changed on both PCs waits for the comparison screen; each choice converges', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  a.todo.save({ tasks: [{ id: 't1', title: 'Base' }] });
  await a.manager.sync();
  await b.manager.sync();
  a.todo.save({ tasks: [{ id: 't1', title: 'Edited on A' }] });
  b.todo.save({ tasks: [{ id: 't1', title: 'Edited on B' }] });
  await a.manager.sync();
  const held = await b.manager.sync();
  assert.deepEqual(held.conflicts.map((c) => c.key), ['todo/tasks/t1']);
  assert.equal(w.tasks(b)[0].title, 'Edited on B', 'a held conflict keeps this PC\'s value');
  await b.manager.sync({ resolutions: { 'todo/tasks/t1': 'both' } });
  await a.manager.sync();
  await b.manager.sync();
  assert.deepEqual(w.tasks(a), [{ id: 't1', title: 'Edited on B' }, { id: 't1-copy', title: 'Edited on A' }]);
  assert.deepEqual(w.tasks(b), w.tasks(a));
  assert.equal((await b.manager.listUndo()).length, 0, 'keeping both discards nothing');
});

test('deletes travel as tombstones; delete against an edit is a conflict', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  a.todo.save({ tasks: [{ id: 't1', title: 'Keep?' }, { id: 't2', title: 'Remove' }] });
  await a.manager.sync();
  await b.manager.sync();
  a.todo.save({ tasks: [{ id: 't1', title: 'Keep?' }] });
  await a.manager.sync();
  await b.manager.sync();
  assert.deepEqual(w.tasks(b), [{ id: 't1', title: 'Keep?' }], 'B deletes what A deleted and does not revive it');
  a.todo.save({ tasks: [] });
  b.todo.save({ tasks: [{ id: 't1', title: 'Edited on B' }] });
  await a.manager.sync();
  const held = await b.manager.sync();
  assert.equal(held.conflicts.length, 1);
  assert.equal(held.conflicts[0].remote.deleted, true);
  await b.manager.sync({ resolutions: { 'todo/tasks/t1': 'local' } });
  await a.manager.sync();
  assert.deepEqual(w.tasks(a), [{ id: 't1', title: 'Edited on B' }]);
  assert.equal((await b.manager.listUndo()).length, 1, 'the discarded delete can be restored for 30 days');
});

test('a half-downloaded state file is skipped and read again later', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  a.todo.save({ tasks: [{ id: 't1', title: 'One' }] });
  await a.manager.sync();
  const file = path.join(w.cloud, 'state', 'd-aaaaaaaa', 'todo-todo.json');
  const full = fs.readFileSync(file);
  fs.writeFileSync(file, full.subarray(0, Math.floor(full.length / 2)));
  const partial = await b.manager.sync();
  assert.ok(partial.warnings.some((x) => x.code === 'remote-not-ready' && x.device === 'd-aaaaaaaa'));
  assert.deepEqual(w.tasks(b), [], 'nothing is guessed from a broken file');
  fs.writeFileSync(file, full);
  await b.manager.sync();
  assert.deepEqual(w.tasks(b), [{ id: 't1', title: 'One' }]);
});

test('clock skew: a PC whose clock runs a day ahead does not win by time', async (t) => {
  const w = world(t);
  const day = 24 * 60 * 60 * 1000;
  const a = w.pc('a', 'd-aaaaaaaa', { now: () => Date.now() + day });
  const b = w.pc('b', 'd-bbbbbbbb', { now: () => Date.now() - day });
  a.todo.save({ tasks: [{ id: 't1', title: 'A, clock ahead' }] });
  await a.manager.sync();
  await b.manager.sync();
  b.todo.save({ tasks: [{ id: 't1', title: 'B edits later, clock behind' }] });
  const result = await b.manager.sync();
  assert.equal(result.conflicts.length, 0);
  await a.manager.sync();
  assert.equal(w.tasks(a)[0].title, 'B edits later, clock behind');
});

test('conflict copies made by cloud clients and stray files are ignored', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  a.todo.save({ tasks: [{ id: 't1', title: 'Real' }] });
  await a.manager.sync();
  const dir = path.join(w.cloud, 'state', 'd-aaaaaaaa');
  const bogus = JSON.stringify({ format: 2, device: 'd-aaaaaaaa', records: { 'todo/tasks/evil': { key: 'todo/tasks/evil' } } });
  // OneDrive, Dropbox and Google Drive name their copies like these.
  fs.writeFileSync(path.join(dir, 'todo-todo-DESKTOP-PC2.json'), bogus);
  fs.writeFileSync(path.join(dir, 'todo-todo (1).json'), bogus);
  fs.writeFileSync(path.join(dir, "todo-todo (B's conflicted copy 2026-10-26).json"), bogus);
  fs.mkdirSync(path.join(w.cloud, 'state', 'd-aaaaaaaa (1)'));
  fs.writeFileSync(path.join(w.cloud, 'state', 'd-aaaaaaaa (1)', 'todo-todo.json'), bogus);
  fs.writeFileSync(path.join(dir, '.todo-todo.json.tmp-0011223344556677'), bogus);
  fs.writeFileSync(path.join(w.cloud, 'devices', 'd-aaaaaaaa (1).json'), '{}');
  const result = await b.manager.sync();
  assert.deepEqual(w.tasks(b), [{ id: 't1', title: 'Real' }]);
  assert.equal(result.conflicts.length, 0);
  assert.ok(!result.warnings.some((x) => x.code === 'remote-not-ready'));
});

test('no secret ever reaches the sync folder: secret store, account list and the export guard', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  const password = 'Very-Secret-Pa55!';
  a.calendar.save({ sources: [
    { id: 'work', type: 'caldav', name: 'Work', server: 'https://dav.example', username: 'me', enabled: true },
    { id: 'ics', type: 'ics', name: 'Private', url: 'https://cal.example/private/token-abc123' },
  ] });
  a.secrets.set('work', password);
  a.todo.save({ tasks: [{ id: 't1', title: 'Fine' }] });
  await a.manager.sync();
  await b.manager.sync();
  const imported = b.calendar.load().sources;
  assert.deepEqual(imported.map((s) => [s.id, s.enabled]), [['work', false]], 'the CalDAV account arrives switched off; ICS stays on A');
  assert.equal(b.secrets.get('work'), '', 'B has to enter its own password');
  // A record that happens to contain a known secret is not exported at all.
  a.todo.save({ tasks: [{ id: 't1', title: 'Fine' }, { id: 't2', title: `pw is ${password}` }] });
  const blocked = await a.manager.sync();
  assert.ok(blocked.warnings.some((x) => x.code === 'secret-blocked' && x.source === 'todo-todo'));
  const text = w.cloudText();
  for (const secret of [password, fakeCrypto.encrypt(password), 'token-abc123']) assert.equal(text.includes(secret), false, secret);
  assert.equal(fs.existsSync(path.join(w.cloud, 'widgets')), false, 'no live widget data in the sync folder');
});

test('notes and attachments go through blobs; a missing blob defers only that note', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nPlan body\n');
  await a.notes.write('Plan.assets/pic.png', Buffer.from([1, 2, 3]));
  await a.notes.write('Later.md', '---\ndesk-widgets-memo: later\n---\nLater body\n');
  await a.manager.sync();
  // The cloud client has not brought down one blob yet.
  const laterHash = require('crypto').createHash('sha256').update('---\ndesk-widgets-memo: later\n---\nLater body\n').digest('hex');
  const blob = path.join(w.cloud, 'blobs', laterHash.slice(0, 2), laterHash);
  const saved = fs.readFileSync(blob);
  fs.unlinkSync(blob);
  const first = await b.manager.sync();
  assert.ok(first.warnings.some((x) => x.code === 'blob-not-ready'), JSON.stringify(first.warnings));
  assert.deepEqual((await b.notes.list()).sort(), ['Plan.assets/pic.png', 'Plan.md']);
  fs.writeFileSync(blob, saved);
  await b.manager.sync();
  assert.deepEqual((await b.notes.list()).sort(), ['Later.md', 'Plan.assets/pic.png', 'Plan.md']);
  assert.equal(path.dirname(b.notes.dir()), path.join(b.userData, 'Documents'), 'notes stay in the PC folder');
  // Edits on both PCs to the same note body become a comparison item, not an overwrite.
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nA version\n');
  await b.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nB version\n');
  await a.manager.sync();
  const held = await b.manager.sync();
  assert.equal(held.conflicts.length, 1);
  assert.match(await b.notes.read('Plan.md', 'utf8'), /B version/);
});

// Both orders of the two notes' sync keys: either PC 2's own note or the incoming one has to move to '(2)'.
for (const [idA, idB] of [['from-a', 'from-b'], ['x', 'y']]) test(`notes made on PC 1 appear on PC 2 that connects later, even with a OneDrive-backed folder and a name clash (${idA}/${idB})`, async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  await a.notes.write('새 노트.md', `---\ndesk-widgets-memo: ${idA}\n---\nA의 할 일\n`);
  await a.notes.write('회의.md', '---\ndesk-widgets-memo: meeting\n---\n회의록\n');
  await a.manager.sync();
  // PC 2 had its own notes before connecting; its Documents folder is backed up to OneDrive.
  const bNotes = path.join(path.dirname(w.cloud), 'b', 'OneDrive', 'Documents', 'Desk Widgets', '할 일 노트');
  fs.mkdirSync(bNotes, { recursive: true });
  fs.writeFileSync(path.join(bNotes, '새 노트.md'), `---\ndesk-widgets-memo: ${idB}\n---\nB의 할 일\n`);
  const b = w.pc('b', 'd-bbbbbbbb', { notesDir: bNotes });
  const plan = await b.manager.preview();
  assert.equal(plan.imports.filter((i) => i.source === 'memo-notes').length, 2);
  const result = await b.manager.sync();
  assert.ok(!result.warnings.some((x) => x.code === 'source-error'), JSON.stringify(result.warnings));
  assert.deepEqual((await b.notes.list()).sort(), ['새 노트 (2).md', '새 노트.md', '회의.md']);
  // Neither note is lost or merged: one keeps "새 노트.md", the other is "새 노트 (2).md".
  const clash = (await Promise.all(['새 노트.md', '새 노트 (2).md'].map((rel) => b.notes.read(rel, 'utf8')))).join('|');
  assert.match(clash, /A의 할 일/);
  assert.match(clash, /B의 할 일/);
  assert.equal(fs.existsSync(path.join(w.cloud, 'state', 'd-bbbbbbbb', 'memo-notes.json')), true, 'PC 2 exports its notes too');
  await a.manager.sync();
  assert.deepEqual((await a.notes.list()).sort(), ['새 노트 (2).md', '새 노트.md', '회의.md']);
  // The renamed copy travels as a rename and settles: after a few rounds there is nothing left to exchange.
  for (let round = 0; round < 3; round++) {
    await b.manager.sync();
    await a.manager.sync();
  }
  for (const p of [a, b]) {
    const left = await p.manager.preview();
    assert.deepEqual([left.imports.length, left.uploads.length, left.conflicts.length], [0, 0, 0], p.label);
  }
  const contents = async (p) => Promise.all((await p.notes.list()).sort().map((rel) => p.notes.read(rel, 'utf8')));
  assert.deepEqual(await contents(a), await contents(b));
  assert.equal((await a.notes.list()).length, 3);
});

test('one store failing does not stop the others from exchanging', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  a.todo.save({ tasks: [{ id: 't1', title: 'Still exchanged' }] });
  a.manager.register({ name: 'broken-store', widgetId: 'broken', read: async () => { throw new Error('locked'); }, apply: async () => {} });
  const result = await a.manager.sync();
  assert.ok(result.warnings.some((x) => x.code === 'source-error' && x.source === 'broken-store'));
  assert.equal(fs.existsSync(path.join(w.cloud, 'state', 'd-aaaaaaaa', 'todo-todo.json')), true);
});

test('first connect of two PCs with their own data asks only about real differences', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  // PC 1 changed the theme; PC 2 never touched it (default). Both made their own tasks; one shared id differs.
  a.todo.save({ themeId: 'dark', tasks: [{ id: 'same', title: 'Equal' }, { id: 'clash', title: 'A wrote this' }, { id: 'a-only', title: 'A' }] });
  b.todo.save({ tasks: [{ id: 'same', title: 'Equal' }, { id: 'clash', title: 'B wrote this' }, { id: 'b-only', title: 'B' }] });
  await a.manager.sync();
  const plan = await b.manager.preview();
  assert.deepEqual(plan.conflicts.map((c) => c.key), ['todo/tasks/clash'], 'equal values and an untouched default are not conflicts');
  assert.deepEqual(plan.imports.map((i) => i.key).sort(), ['todo/@settings/themeId', 'todo/tasks/a-only']);
  await b.manager.sync({ resolutions: { 'todo/tasks/clash': 'remote' } });
  assert.equal(b.todo.load().themeId, 'dark');
  // Setting it back to the default travels too.
  b.todo.save({ themeId: 'light' });
  await b.manager.sync();
  await a.manager.sync();
  assert.equal(a.todo.load().themeId, 'light');
});

test('"use the other PC\'s value" picks the other PC even when both published the same revision first', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-11111111');
  const b = w.pc('b', 'd-ffffffff'); // sorts after PC 1: the old tie-break picked this PC's own copy
  a.todo.save({ tasks: [{ id: 't1', title: 'Base' }] });
  await a.manager.sync();
  await b.manager.sync();
  // Both edit while offline from each other: each publishes revision 2 without seeing the other's.
  const offline = async (pc, other) => {
    const dir = path.join(w.cloud, 'state', other);
    fs.renameSync(dir, `${dir}.away`);
    try { await pc.manager.sync(); } finally { fs.renameSync(`${dir}.away`, dir); }
  };
  a.todo.save({ tasks: [{ id: 't1', title: 'A edit' }] });
  b.todo.save({ tasks: [{ id: 't1', title: 'B edit' }] });
  await offline(a, 'd-ffffffff');
  await offline(b, 'd-11111111');
  const onB = await b.manager.sync();
  assert.equal(onB.conflicts.length, 1);
  assert.equal(onB.conflicts[0].remote.value.title, 'A edit', 'the other PC value, not this PC own copy');
  await b.manager.sync({ resolutions: { 'todo/tasks/t1': 'remote' } });
  assert.equal(w.tasks(b)[0].title, 'A edit');
  await a.manager.sync({ resolutions: { 'todo/tasks/t1': 'local' } });
  await b.manager.sync();
  assert.equal(w.tasks(a)[0].title, 'A edit');
  assert.equal(w.tasks(b)[0].title, 'A edit');
});

// #108 (2026-10-27): changing the note folder without moving the notes must never delete them on other PCs.
async function folderWorld(t) {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  await a.notes.write('회의.md', '---\ndesk-widgets-memo: meeting\n---\n회의록\n');
  await a.notes.write('회의.assets/표.png', Buffer.from([1, 2, 3]));
  await a.notes.write('장보기.md', '---\ndesk-widgets-memo: shopping\n---\n우유\n');
  await a.manager.sync();
  await b.manager.sync();
  await a.manager.sync();
  const listB = async () => (await b.notes.list()).sort();
  const before = await listB();
  assert.deepEqual(before, ['장보기.md', '회의.assets/표.png', '회의.md']);
  const archivedOnB = () => fs.existsSync(path.join(b.notesDir, '.sync-removed'));
  return { w, a, b, listB, before, archivedOnB };
}

test('note folder changed to an empty folder: no deletions anywhere, the notes come back into the new folder', async (t) => {
  const { w, a, listB, before, archivedOnB } = await folderWorld(t);
  const oldDir = a.notesDir;
  a.setNotesDir(path.join(path.dirname(oldDir), 'empty-new'));
  fs.mkdirSync(a.notesDir);
  const result = await a.manager.sync();
  assert.ok(result.warnings.some((x) => x.code === 'store-relocated' && x.source === 'memo-notes'));
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual((await a.notes.list()).sort(), before, 'the notes arrived in the new folder');
  const state = JSON.parse(fs.readFileSync(path.join(w.cloud, 'state', 'd-aaaaaaaa', 'memo-notes.json'), 'utf8'));
  assert.ok(Object.values(state.records).every((r) => !r.deleted), 'no tombstone was published');
  assert.ok(fs.existsSync(path.join(oldDir, '회의.md')), 'the old folder is left as it was');
  await w.pc('c', 'd-cccccccc').manager.sync(); // a third PC joining later still sees every note
  assert.deepEqual(await listB(), before);
  assert.equal(archivedOnB(), false);
});

test('note folder changed: PC 2 keeps every note (empty folder, other notes, then back to the old folder)', async (t) => {
  const { w, a, b, listB, before, archivedOnB } = await folderWorld(t);
  const oldDir = a.notesDir;
  // 1. An empty folder.
  a.setNotesDir(path.join(path.dirname(oldDir), 'empty-new'));
  fs.mkdirSync(a.notesDir);
  await a.manager.sync();
  await b.manager.sync();
  assert.deepEqual(await listB(), before);
  assert.equal(archivedOnB(), false, 'nothing archived on PC 2');
  // 2. A folder that already has other notes (and one equal to a synced note).
  const other = path.join(path.dirname(oldDir), 'other-notes');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, '다른 노트.md'), '---\ndesk-widgets-memo: other\n---\n다른 폴더\n');
  fs.writeFileSync(path.join(other, '장보기.md'), '---\ndesk-widgets-memo: shopping\n---\n우유\n');
  a.setNotesDir(other);
  const second = await a.manager.sync();
  assert.equal(second.conflicts.length, 0, 'equal content is not a conflict');
  await b.manager.sync();
  assert.deepEqual(await listB(), ['다른 노트.md', ...before].sort());
  assert.equal(archivedOnB(), false);
  // 3. Back to the old folder, which still has the old notes but not the one made in between.
  a.setNotesDir(oldDir);
  const third = await a.manager.sync();
  assert.equal(third.conflicts.length, 0);
  assert.ok(fs.existsSync(path.join(oldDir, '다른 노트.md')), 'the note from the other folder arrives here too');
  await b.manager.sync();
  assert.deepEqual(await listB(), ['다른 노트.md', ...before].sort());
  assert.equal(archivedOnB(), false);
  for (const pc of [a, b]) {
    const left = await pc.manager.preview();
    assert.deepEqual([left.imports.length, left.uploads.length, left.conflicts.length], [0, 0, 0], pc.label);
  }
});

test('a note folder that is not available (removable drive) is skipped, not read as deletions', async (t) => {
  const { a, b, listB, before, archivedOnB } = await folderWorld(t);
  const gone = path.join(path.dirname(a.notesDir), 'E-drive', 'notes');
  a.setNotesDir(gone);
  const result = await a.manager.sync();
  assert.ok(result.warnings.some((x) => x.code === 'source-error' && x.reason === 'FOLDER_UNAVAILABLE'));
  assert.equal(fs.existsSync(gone), false, 'the missing folder is not created');
  await b.manager.sync();
  assert.deepEqual(await listB(), before);
  assert.equal(archivedOnB(), false);
});
