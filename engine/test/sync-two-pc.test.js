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

test('old blobs: a note later locked leaves no plain version in the sync folder once no PC refers to it (#124)', async (t) => {
  const later = { offset: 0 };
  const w = world(t);
  const clock = () => Date.now() + later.offset;
  const a = w.pc('A', 'd-aaaaaaaa', { now: clock });
  const b = w.pc('B', 'd-bbbbbbbb', { now: clock });
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nplain-secret-words\n');
  await a.notes.write('Plan.assets/pic.png', Buffer.from('plain-asset-words'));
  await a.manager.sync();
  await b.manager.sync();
  // Locked on A: the note's bytes change and the attachment gets another name.
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nciphertext\n');
  await a.notes.remove('Plan.assets/pic.png');
  await a.notes.write('Plan.assets/0000.dwenc', Buffer.from('encrypted'));
  await a.manager.sync();
  // B has not synced: its state still refers to the plain version, so it stays even when old.
  later.offset = 2 * 24 * 60 * 60 * 1000;
  await a.manager.sync();
  assert.ok(w.cloudText().includes('plain-secret-words'));
  // B catches up: nobody refers to it any more; A removes it a day after first seeing that.
  await b.manager.sync();
  later.offset += 2 * 60 * 60 * 1000;
  await a.manager.sync();
  assert.ok(w.cloudText().includes('plain-secret-words'));
  later.offset += 25 * 60 * 60 * 1000;
  await a.manager.sync();
  const cloud = w.cloudText();
  assert.ok(!cloud.includes('plain-secret-words'));
  assert.ok(!cloud.includes('plain-asset-words'));
  assert.ok(cloud.includes('ciphertext'));
  // The current version still reaches a PC that connects now.
  const c = w.pc('C', 'd-cccccccc', { now: clock });
  await c.manager.sync();
  assert.ok((await c.notes.read('Plan.md', 'utf8')).includes('ciphertext'));
  assert.equal((await c.notes.read('Plan.assets/0000.dwenc')).toString(), 'encrypted');
});

test('old blobs: nothing is removed while a state cannot be read, a known PC has no state, or within a day of first seeing it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sweep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  const manager = new SyncManager({ localDir: path.join(root, 'local'), folder: cloud, deviceId: 'd-aaaaaaaa', deviceName: 'A', now: () => Date.now() });
  const blob = (seed, ageMs) => {
    const digest = require('crypto').createHash('sha256').update(seed).digest('hex');
    const file = path.join(cloud, 'blobs', digest.slice(0, 2), digest);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, seed);
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    return { digest, file };
  };
  const DAY = 24 * 60 * 60 * 1000;
  const old = blob('old', 0);
  const young = blob('young', 3 * DAY); // an old file time means nothing: first seen just now
  const referenced = blob('referenced', 3 * DAY);
  const undo = blob('undo', 3 * DAY);
  const stranger = path.join(cloud, 'blobs', 'zz', 'not-a-blob');
  fs.mkdirSync(path.dirname(stranger), { recursive: true });
  fs.writeFileSync(stranger, 'x');
  fs.mkdirSync(path.join(cloud, 'state', 'd-aaaaaaaa'), { recursive: true });
  fs.mkdirSync(path.join(cloud, 'devices'), { recursive: true });
  const state = path.join(cloud, 'state', 'd-aaaaaaaa', 'x.json');
  fs.writeFileSync(state, JSON.stringify({ records: { k: { value: { blob: referenced.digest, assets: {} } } } }));
  const meta = () => ({ undoLog: [{ discarded: { value: { blob: undo.digest } } }], blobOrphans: { [old.digest]: Date.now() - 2 * DAY, [referenced.digest]: Date.now() - 2 * DAY, [undo.digest]: Date.now() - 2 * DAY } });
  // A half-downloaded state: stop.
  fs.writeFileSync(path.join(cloud, 'state', 'd-aaaaaaaa', 'broken.json'), '{ half');
  await assert.rejects(manager.sweepBlobs(cloud, meta()));
  assert.ok(fs.existsSync(old.file));
  fs.rmSync(path.join(cloud, 'state', 'd-aaaaaaaa', 'broken.json'));
  // A known PC without a state here yet: stop.
  fs.writeFileSync(path.join(cloud, 'devices', 'd-bbbbbbbb.json'), '{}');
  assert.equal(await manager.sweepBlobs(cloud, meta()), 0);
  assert.ok(fs.existsSync(old.file));
  fs.rmSync(path.join(cloud, 'devices', 'd-bbbbbbbb.json'));
  const m = meta();
  assert.equal(await manager.sweepBlobs(cloud, m), 1);
  assert.equal(fs.existsSync(old.file), false);
  for (const kept of [young.file, referenced.file, undo.file, stranger]) assert.ok(fs.existsSync(kept), kept);
  assert.equal(m.blobOrphans[young.digest] > Date.now() - DAY, true);
  assert.equal(m.blobOrphans[referenced.digest], undefined);
  // Checked at most once an hour.
  m.blobOrphans[young.digest] = Date.now() - 2 * DAY;
  assert.equal(await manager.sweepBlobs(cloud, m), 0);
  assert.ok(fs.existsSync(young.file));
});

const DAY_MS = 24 * 60 * 60 * 1000;
const blobFile = (cloud, bytes) => {
  const digest = require('crypto').createHash('sha256').update(bytes).digest('hex');
  return path.join(cloud, 'blobs', digest.slice(0, 2), digest);
};

test('old blobs: a new blob arriving before its state, with the old time the cloud client kept, is not removed (#124)', async (t) => {
  const later = { offset: 0 };
  const clock = () => Date.now() + later.offset;
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa', { now: clock });
  const c = w.pc('C', 'd-cccccccc', { now: clock });
  await c.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nfirst\n');
  await c.manager.sync();
  await a.manager.sync();
  // A is off for days. C edits; OneDrive brings A the new blob before C's state, keeping the blob's old time.
  const stateFile = path.join(w.cloud, 'state', 'd-cccccccc', 'memo-notes.json');
  const oldState = fs.readFileSync(stateFile);
  const newBytes = '---\ndesk-widgets-memo: plan\n---\nnewest from C\n';
  await c.notes.write('Plan.md', newBytes);
  await c.manager.sync();
  const newState = fs.readFileSync(stateFile);
  fs.writeFileSync(stateFile, oldState);
  const blob = blobFile(w.cloud, newBytes);
  const old = new Date(Date.now() - 3 * DAY_MS);
  fs.utimesSync(blob, old, old);
  later.offset = 3 * DAY_MS;
  await a.manager.sync();
  assert.ok(fs.existsSync(blob), 'the newest blob of C must survive A coming back');
  // C's state arrives within a day: A gets the note.
  fs.writeFileSync(stateFile, newState);
  later.offset += 60 * 60 * 1000;
  await a.manager.sync();
  assert.match(await a.notes.read('Plan.md', 'utf8'), /newest from C/);
});

test('old blobs: removed only a day after this PC first saw them unreferenced, whatever their file time', async (t) => {
  const later = { offset: 0 };
  const clock = () => Date.now() + later.offset;
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa', { now: clock });
  const first = '---\ndesk-widgets-memo: plan\n---\nfirst\n';
  await a.notes.write('Plan.md', first);
  await a.manager.sync();
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nsecond\n');
  later.offset = 2 * 60 * 60 * 1000;
  await a.manager.sync(); // first seen without a reference now
  const blob = blobFile(w.cloud, first);
  const old = new Date(Date.now() - 30 * DAY_MS);
  fs.utimesSync(blob, old, old);
  later.offset += 23 * 60 * 60 * 1000;
  await a.manager.sync();
  assert.ok(fs.existsSync(blob), 'not yet a day');
  later.offset += 2 * 60 * 60 * 1000;
  await a.manager.sync();
  assert.equal(fs.existsSync(blob), false);
});

test('old blobs: a blob referenced again starts its day over', async (t) => {
  const later = { offset: 0 };
  const clock = () => Date.now() + later.offset;
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa', { now: clock });
  const first = '---\ndesk-widgets-memo: plan\n---\nfirst\n';
  await a.notes.write('Plan.md', first);
  await a.manager.sync();
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nsecond\n');
  later.offset = 2 * 60 * 60 * 1000;
  await a.manager.sync();
  await a.notes.write('Plan.md', first); // the same bytes again
  later.offset += 2 * 60 * 60 * 1000;
  await a.manager.sync();
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nthird\n');
  later.offset += 2 * 60 * 60 * 1000;
  await a.manager.sync();
  later.offset += 23 * 60 * 60 * 1000;
  await a.manager.sync();
  assert.ok(fs.existsSync(blobFile(w.cloud, first)), 'counted from the last time it lost its reference');
});

test('old blobs: a referenced blob lost from the cloud is written again by a PC that has the note', async (t) => {
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa');
  const bytes = '---\ndesk-widgets-memo: plan\n---\nunchanged body\n';
  await a.notes.write('Plan.md', bytes);
  await a.notes.write('Plan.assets/pic.png', Buffer.from('picture'));
  await a.manager.sync();
  fs.rmSync(blobFile(w.cloud, bytes));
  fs.rmSync(blobFile(w.cloud, Buffer.from('picture')));
  await a.manager.sync(); // nothing changed on A
  const c = w.pc('C', 'd-cccccccc');
  const status = await c.manager.sync();
  assert.deepEqual(status.warnings.filter((x) => x.code === 'blob-not-ready'), []);
  assert.equal(await c.notes.read('Plan.md', 'utf8'), bytes);
  assert.equal((await c.notes.read('Plan.assets/pic.png')).toString(), 'picture');
});

const HOUR = 60 * 60 * 1000;
const undoList = (cloud, device) => path.join(cloud, 'state', device, '_undo-blobs.json');

/** B keeps its version in a conflict: A's version is what B's undo goes back to, and A's state soon stops referring to it. */
async function keptMineOnB(t) {
  const later = { offset: 0 };
  const clock = () => Date.now() + later.offset;
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa', { now: clock });
  const b = w.pc('B', 'd-bbbbbbbb', { now: clock });
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nbase\n');
  await a.manager.sync();
  await b.manager.sync();
  const theirs = '---\ndesk-widgets-memo: plan\n---\nA version\n';
  await a.notes.write('Plan.md', theirs);
  await b.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nB version\n');
  await a.manager.sync();
  const held = await b.manager.sync();
  assert.equal(held.conflicts.length, 1);
  await b.manager.sync({ resolutions: { [held.conflicts[0].key]: 'local' } });
  const [entry] = await b.manager.listUndo();
  assert.ok(entry);
  const blob = blobFile(w.cloud, theirs);
  assert.ok(fs.existsSync(blob));
  return { w, a, b, later, theirs, entry, blob };
}

test('old blobs: another PC keeps a version this PC can still undo to, past its own day of grace', async (t) => {
  const { w, a, b, later, theirs, entry, blob } = await keptMineOnB(t);
  await a.manager.sync();
  assert.match(await a.notes.read('Plan.md', 'utf8'), /B version/);
  later.offset = 2 * HOUR;
  await a.manager.sync();
  later.offset += 25 * HOUR;
  await a.manager.sync();
  later.offset += 25 * HOUR;
  await a.manager.sync();
  assert.ok(fs.existsSync(blob), "A's sweep respects B's undo");
  await b.manager.undo(entry.id);
  assert.equal(await b.notes.read('Plan.md', 'utf8'), theirs);
  assert.equal(fs.existsSync(undoList(w.cloud, 'd-bbbbbbbb')), false, 'nothing left to protect');
  await a.manager.sync();
  assert.equal(await a.notes.read('Plan.md', 'utf8'), theirs);
});

test('old blobs: a version undone to or no longer undoable is removed again', async (t) => {
  const { w, a, b, later, entry, blob } = await keptMineOnB(t);
  await a.manager.sync();
  assert.ok((await b.manager.listUndo()).some((x) => x.id === entry.id));
  // Past the 30 days, with B switched off: its published list says when each entry ends, so A does not wait for B.
  later.offset = 31 * 24 * HOUR;
  await a.manager.sync();
  assert.ok(fs.existsSync(blob), 'a day of grace from first seeing that');
  later.offset += 25 * HOUR;
  await a.manager.sync();
  assert.equal(fs.existsSync(blob), false);
  // B comes back: the entry is gone from its log and from its list, and nothing complains.
  assert.equal((await b.manager.listUndo()).length, 0);
  const onB = await b.manager.sync();
  assert.deepEqual(onB.warnings.filter((x) => x.code === 'source-error'), []);
  assert.equal(fs.existsSync(undoList(w.cloud, 'd-bbbbbbbb')), false);
});

test('old blobs: of a note locked later only the version an undo refers to stays, and only until that ends', async (t) => {
  const later = { offset: 0 };
  const clock = () => Date.now() + later.offset;
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa', { now: clock });
  const b = w.pc('B', 'd-bbbbbbbb', { now: clock });
  const text = (body) => `---\ndesk-widgets-memo: plan\n---\n${body}\n`;
  await a.notes.write('Plan.md', text('plain-first'));
  await a.manager.sync();
  await b.manager.sync();
  await a.notes.write('Plan.md', text('plain-second'));
  await a.notes.write('Plan.assets/pic.png', Buffer.from('plain-second-asset'));
  await a.manager.sync();
  await b.manager.sync();
  // A edits once more while B locks: B keeps its locked version and discards A's last plain one.
  await a.notes.write('Plan.md', text('plain-discarded'));
  await a.notes.remove('Plan.assets/pic.png');
  await b.notes.remove('Plan.assets/pic.png');
  await b.notes.write('Plan.md', text('ciphertext'));
  await a.manager.sync();
  const held = await b.manager.sync();
  assert.equal(held.conflicts.length, 1);
  await b.manager.sync({ resolutions: { [held.conflicts[0].key]: 'local' } });
  await a.manager.sync();
  const sweep = async () => {
    later.offset += 25 * HOUR;
    await a.manager.sync();
    await b.manager.sync();
    await a.manager.sync();
  };
  await sweep();
  await sweep();
  await sweep();
  const during = w.cloudText();
  assert.ok(during.includes('ciphertext'));
  assert.ok(!during.includes('plain-first'), 'versions no undo refers to are removed');
  assert.ok(!during.includes('plain-second'));
  assert.ok(!during.includes('plain-second-asset'));
  assert.ok(during.includes('plain-discarded'), 'the one version B can still undo to');
  later.offset = 31 * 24 * HOUR;
  await sweep();
  await sweep();
  await sweep();
  const after = w.cloudText();
  assert.ok(!after.includes('plain-discarded'), 'gone once the undo has ended');
  assert.ok(after.includes('ciphertext'));
});

test('undo list: only hashes of what can be undone, no rewrite without a change, not read as a store', async (t) => {
  const { w, a, b, later, theirs, blob } = await keptMineOnB(t);
  const list = undoList(w.cloud, 'd-bbbbbbbb');
  const saved = fs.readFileSync(list, 'utf8');
  const { items, device } = JSON.parse(saved);
  assert.equal(device, 'd-bbbbbbbb');
  assert.deepEqual(items.map((x) => x.blob), [path.basename(blob)]);
  assert.ok(items[0].expiresAt > Date.now() + 29 * 24 * HOUR);
  assert.ok(!saved.includes('A version'));
  later.offset = HOUR;
  await b.manager.sync();
  assert.equal(fs.readFileSync(list, 'utf8'), saved, 'a cloud client must not see a change every minute');
  const onA = await a.manager.sync();
  assert.deepEqual(onA.warnings.filter((x) => ['remote-not-ready', 'source-error'].includes(x.code)), []);
  assert.throws(() => a.manager.register({ name: '_undo-blobs', read() {}, apply() {} }), /Invalid sync adapter/);
  assert.match(await a.notes.read('Plan.md', 'utf8'), /B version/);
  assert.ok(theirs);
  // A half-downloaded list stops the sweep, as any state that cannot be read does.
  fs.writeFileSync(list, '{"items":[');
  later.offset += 2 * HOUR;
  await a.manager.sync();
  later.offset += 25 * HOUR;
  await a.manager.sync();
  assert.ok(fs.existsSync(blob));
});

test('undo list: a store without blobs publishes none', async (t) => {
  const w = world(t);
  const a = w.pc('a', 'd-aaaaaaaa');
  const b = w.pc('b', 'd-bbbbbbbb');
  a.todo.save({ tasks: [{ id: 't1', title: 'Base' }] });
  await a.manager.sync();
  await b.manager.sync();
  a.todo.save({ tasks: [{ id: 't1', title: 'A' }] });
  b.todo.save({ tasks: [{ id: 't1', title: 'B' }] });
  await a.manager.sync();
  const held = await b.manager.sync();
  await b.manager.sync({ resolutions: { [held.conflicts[0].key]: 'local' } });
  assert.equal((await b.manager.listUndo()).length, 1);
  assert.equal(fs.existsSync(undoList(w.cloud, 'd-bbbbbbbb')), false);
});

test('old blobs: an undo on a PC that publishes no list (old engine) can still lose its version: it fails cleanly, nothing changes', async (t) => {
  const { w, a, b, later, theirs, entry, blob } = await keptMineOnB(t);
  const oldEngine = () => fs.rmSync(undoList(w.cloud, 'd-bbbbbbbb'), { force: true });
  oldEngine();
  await a.manager.sync();
  assert.match(await a.notes.read('Plan.md', 'utf8'), /B version/);
  // B's own sweeps keep it for B's undo; A's do not know about that undo.
  later.offset = 2 * HOUR;
  await a.manager.sync();
  await b.manager.sync();
  oldEngine();
  assert.ok(fs.existsSync(blob));
  later.offset += 25 * HOUR;
  await b.manager.sync();
  oldEngine();
  assert.ok(fs.existsSync(blob), "B's own undo protects it on B");
  await a.manager.sync();
  assert.equal(fs.existsSync(blob), false, 'removed by the other PC');
  const before = await b.notes.read('Plan.md', 'utf8');
  await assert.rejects(b.manager.undo(entry.id), /no longer kept/);
  assert.equal(await b.notes.read('Plan.md', 'utf8'), before, 'a failed undo changes nothing');
  assert.equal((await b.manager.listUndo()).length, 1, 'the entry stays');
  // The version itself is not gone: A kept it in its own backups (30 days).
  const backups = path.join(a.notes.dir(), '.sync-removed');
  const kept = fs.readdirSync(backups).map((d) => path.join(backups, d, 'Plan.md')).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'));
  assert.ok(kept.includes(theirs));
});

test('old blobs: a PC that only received a note also writes its lost blob again', async (t) => {
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa');
  const b = w.pc('B', 'd-bbbbbbbb');
  const bytes = '---\ndesk-widgets-memo: plan\n---\nunchanged body\n';
  await a.notes.write('Plan.md', bytes);
  await a.manager.sync();
  await b.manager.sync();
  fs.rmSync(blobFile(w.cloud, bytes));
  await b.manager.sync();
  const c = w.pc('C', 'd-cccccccc');
  const status = await c.manager.sync();
  assert.deepEqual(status.warnings.filter((x) => x.code === 'blob-not-ready'), []);
  assert.equal(await c.notes.read('Plan.md', 'utf8'), bytes);
});

// #125: "use the other PC's value" discards this PC's own edit, whose bytes never reached the sync folder (a pending
// conflict keeps publishing the previous version). Undo reads them from this PC's ".sync-removed".
async function conflictOnB(t, { aDeletes = false } = {}) {
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa');
  const b = w.pc('B', 'd-bbbbbbbb');
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nbase\n');
  await a.notes.write('Plan.assets/pic.png', Buffer.from([1, 2, 3]));
  await a.manager.sync();
  await b.manager.sync();
  const mine = '---\ndesk-widgets-memo: plan\n---\nB edit never uploaded\n';
  const myPicture = Buffer.from([7, 8, 9]);
  await b.notes.write('Plan.md', mine);
  await b.notes.write('Plan.assets/pic.png', myPicture);
  if (aDeletes) {
    await a.notes.remove('Plan.assets/pic.png');
    await a.notes.remove('Plan.md');
  } else await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nA edit\n');
  await a.manager.sync();
  const held = await b.manager.sync();
  assert.equal(held.conflicts.length, 1);
  assert.equal(fs.existsSync(blobFile(w.cloud, mine)), false, 'a waiting edit is not uploaded');
  await b.manager.sync({ resolutions: { [held.conflicts[0].key]: 'remote' } });
  const [entry] = await b.manager.listUndo();
  assert.ok(entry);
  assert.equal(fs.existsSync(blobFile(w.cloud, mine)), false, 'choosing the other value uploads nothing of this edit');
  return { w, a, b, mine, myPicture, entry };
}

test('undo of "use the other PC\'s value" restores this PC\'s edit from its backups and the other PC receives it', async (t) => {
  const { w, a, b, mine, myPicture, entry } = await conflictOnB(t);
  assert.match(await b.notes.read('Plan.md', 'utf8'), /A edit/);
  await b.manager.undo(entry.id);
  assert.equal(await b.notes.read('Plan.md', 'utf8'), mine);
  assert.deepEqual(await b.notes.read('Plan.assets/pic.png'), myPicture);
  assert.equal((await b.manager.listUndo()).length, 0);
  assert.ok(fs.existsSync(blobFile(w.cloud, mine)), 'it is the current note now, so other PCs need its bytes');
  const onA = await a.manager.sync();
  assert.deepEqual(onA.conflicts, []);
  assert.equal(await a.notes.read('Plan.md', 'utf8'), mine);
  assert.deepEqual(await a.notes.read('Plan.assets/pic.png'), myPicture);
  const onB = await b.manager.sync();
  assert.deepEqual(onB.conflicts, []);
  assert.deepEqual(onB.warnings.filter((x) => x.code === 'source-error'), []);
  assert.equal(await b.notes.read('Plan.md', 'utf8'), mine);
});

test('undo restores an edit discarded for the other PC\'s deletion', async (t) => {
  const { a, b, mine, myPicture, entry } = await conflictOnB(t, { aDeletes: true });
  assert.deepEqual(await b.notes.list(), []);
  await b.manager.undo(entry.id);
  assert.equal(await b.notes.read('Plan.md', 'utf8'), mine);
  assert.deepEqual(await b.notes.read('Plan.assets/pic.png'), myPicture);
  await a.manager.sync();
  assert.equal(await a.notes.read('Plan.md', 'utf8'), mine);
});

test('undo whose backup is gone fails cleanly: nothing changes and nothing is uploaded', async (t) => {
  const { w, b, mine, entry } = await conflictOnB(t);
  const before = await b.notes.read('Plan.md', 'utf8');
  fs.rmSync(path.join(b.notes.dir(), '.sync-removed'), { recursive: true });
  await assert.rejects(b.manager.undo(entry.id), /no longer kept/);
  assert.equal(await b.notes.read('Plan.md', 'utf8'), before);
  assert.equal((await b.manager.listUndo()).length, 1, 'the entry stays');
  assert.equal(fs.existsSync(blobFile(w.cloud, mine)), false);
  assert.ok(!w.cloudText().includes('B edit never uploaded'));
});

test('undo ignores a backup with other bytes under the same name', async (t) => {
  const { b, mine, entry } = await conflictOnB(t);
  const backups = path.join(b.notes.dir(), '.sync-removed');
  const newest = path.join(backups, `${Date.now() + 1000}-ffffffff`);
  fs.mkdirSync(newest, { recursive: true });
  fs.writeFileSync(path.join(newest, 'Plan.md'), 'other bytes');
  await b.manager.undo(entry.id);
  assert.equal(await b.notes.read('Plan.md', 'utf8'), mine);
});

test('undo of "keep mine" still restores the other PC\'s version from the sync folder', async (t) => {
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa');
  const b = w.pc('B', 'd-bbbbbbbb');
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nbase\n');
  await a.manager.sync();
  await b.manager.sync();
  const theirs = '---\ndesk-widgets-memo: plan\n---\nA version\n';
  await a.notes.write('Plan.md', theirs);
  await b.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nB version\n');
  await a.manager.sync();
  const held = await b.manager.sync();
  await b.manager.sync({ resolutions: { [held.conflicts[0].key]: 'local' } });
  const [entry] = await b.manager.listUndo();
  await b.manager.undo(entry.id);
  assert.equal(await b.notes.read('Plan.md', 'utf8'), theirs);
});

test('undo finds the backup under the old names when another note has taken the name meanwhile', async (t) => {
  const w = world(t);
  const a = w.pc('A', 'd-aaaaaaaa');
  const b = w.pc('B', 'd-bbbbbbbb');
  await a.notes.write('Plan.md', '---\ndesk-widgets-memo: plan\n---\nbase\n');
  await a.manager.sync();
  await b.manager.sync();
  const mine = '---\ndesk-widgets-memo: plan\n---\nB edit\n';
  const picture = Buffer.from([4, 5, 6]);
  await b.notes.write('Plan.md', mine);
  await b.notes.write('Plan.assets/pic.png', picture);
  await a.notes.remove('Plan.md');
  await a.notes.write('Moved.md', '---\ndesk-widgets-memo: plan\n---\nA moved it\n');
  await a.manager.sync();
  const held = await b.manager.sync();
  await b.manager.sync({ resolutions: { [held.conflicts[0].key]: 'remote' } });
  assert.deepEqual(await b.notes.list(), ['Moved.md']);
  const other = '---\ndesk-widgets-memo: other\n---\nanother note\n';
  await b.notes.write('Plan.md', other);
  await b.manager.sync();
  const [entry] = await b.manager.listUndo();
  await b.manager.undo(entry.id);
  const texts = await Promise.all((await b.notes.list()).filter((f) => f.endsWith('.md')).map((f) => b.notes.read(f, 'utf8')));
  assert.deepEqual(texts.sort(), [mine, other].sort());
  const pictures = (await b.notes.list()).filter((f) => f.endsWith('.png'));
  assert.equal(pictures.length, 1);
  assert.deepEqual(await b.notes.read(pictures[0]), picture);
  const onB = await b.manager.sync();
  assert.deepEqual(onB.warnings.filter((x) => x.code === 'source-error'), []);
  const onA = await a.manager.sync();
  assert.deepEqual(onA.conflicts, []);
  const onAtexts = await Promise.all((await a.notes.list()).filter((f) => f.endsWith('.md')).map((f) => a.notes.read(f, 'utf8')));
  assert.deepEqual(onAtexts.sort(), [mine, other].sort());
});
