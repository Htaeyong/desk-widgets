const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { openFileStore, relativeName, validValue } = require('../main/files-store');
const { createLegacyMigrator } = require('../main/sync-legacy');
const { SyncManager } = require('../main/sync');

const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');

function fixture(t, { maxFileBytes = 1024 * 1024, noteFolder } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-folder-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const provider = path.join(temp, 'provider');
  const notes = noteFolder || path.join(temp, 'notes');
  const cloudRoot = path.join(provider, 'Desk Widgets Sync');
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(cloudRoot, { recursive: true });
  const manager = { folder: provider, register(adapter) { this.adapter = adapter; return () => { this.adapter = null; }; } };
  const changed = [];
  const descriptor = {
    name: 'notes', dir: () => notes,
    include: (rel) => /^(?:Archive\/)?[^/]+\.(?:md|txt)$/i.test(rel) || /^(?:Archive\/)?[^/]+\.assets\/[^/]+$/i.test(rel),
    idOf: (_rel, text) => /^desk-widgets-memo:\s*(.+)$/im.exec(text)?.[1] || _rel,
    beforeSync: () => {}, onRemoteChange: (items) => changed.push(...items),
    maxFileBytes,
  };
  const { handle, close } = openFileStore(manager, 'memo', descriptor);
  t.after(close);
  return { temp, provider, notes, cloudRoot, manager, changed, handle };
}

test('note and attachment become one stable record with immutable hashed blobs', async (t) => {
  const x = fixture(t);
  const body = '---\ndesk-widgets-memo: note-a\n---\nHello\n';
  fs.writeFileSync(path.join(x.notes, 'First.md'), body);
  fs.mkdirSync(path.join(x.notes, 'First.assets'));
  fs.writeFileSync(path.join(x.notes, 'First.assets', 'image.png'), Buffer.from([1, 2, 3]));
  const first = await x.manager.adapter.read();
  const [key] = Object.keys(first);
  assert.match(key, /^memo\/notes\/[a-f0-9]{64}$/);
  assert.equal(first[key].path, 'First.md');
  assert.equal(first[key].blob, digest(body));
  assert.equal(first[key].assets['First.assets/image.png'], digest(Buffer.from([1, 2, 3])));
  await x.manager.adapter.prepare({ [key]: { value: first[key], deleted: false } }, x.cloudRoot);
  assert.equal(fs.readFileSync(path.join(x.cloudRoot, 'blobs', digest(body).slice(0, 2), digest(body)), 'utf8'), body);
  fs.renameSync(path.join(x.notes, 'First.md'), path.join(x.notes, 'Renamed.md'));
  const renamed = await x.manager.adapter.read();
  assert.equal(Object.keys(renamed)[0], key, 'the front-matter id follows a rename');
});

test('remote apply verifies blobs, preserves previous files, and notifies the widget', async (t) => {
  const x = fixture(t);
  const original = '---\ndesk-widgets-memo: note-a\n---\nOld\n';
  fs.writeFileSync(path.join(x.notes, 'First.md'), original);
  const current = await x.manager.adapter.read();
  const [key] = Object.keys(current);
  const next = Buffer.from('---\ndesk-widgets-memo: note-a\n---\nNew\n');
  const hash = digest(next);
  const blobDir = path.join(x.cloudRoot, 'blobs', hash.slice(0, 2));
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, hash), next);
  await x.manager.adapter.apply([{ key, value: { path: 'First.md', blob: hash, assets: {} }, deleted: false }], { cloudRoot: x.cloudRoot });
  assert.equal(fs.readFileSync(path.join(x.notes, 'First.md'), 'utf8'), next.toString());
  assert.deepEqual(x.changed, ['First.md']);
  const removed = path.join(x.notes, '.sync-removed');
  assert.ok(fs.readdirSync(removed).some((name) => fs.existsSync(path.join(removed, name, 'First.md'))));
  await assert.rejects(x.manager.adapter.apply([{ key, value: { path: 'First.md', blob: 'a'.repeat(64), assets: {} }, deleted: false }], { cloudRoot: x.cloudRoot }));
  assert.equal(fs.readFileSync(path.join(x.notes, 'First.md'), 'utf8'), next.toString(), 'missing blob leaves the note intact');
});

test('availability defers a missing blob without blocking another note', async (t) => {
  const x = fixture(t);
  const present = Buffer.from('---\ndesk-widgets-memo: ready\n---\nReady\n');
  const presentHash = digest(present);
  const blobDir = path.join(x.cloudRoot, 'blobs', presentHash.slice(0, 2));
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, presentHash), present);
  const ready = { key: 'memo/notes/ready', record: { value: { path: 'Ready.md', blob: presentHash, assets: {} } } };
  const waiting = { key: 'memo/notes/waiting', record: { value: { path: 'Waiting.md', blob: 'a'.repeat(64), assets: {} } } };
  assert.equal(await x.manager.adapter.available(ready, { cloudRoot: x.cloudRoot }), true);
  assert.equal(await x.manager.adapter.available(waiting, { cloudRoot: x.cloudRoot }), false);
  assert.equal(await x.manager.adapter.available({ key: waiting.key, record: { deleted: true } }, { cloudRoot: x.cloudRoot }), true);
  await x.manager.adapter.apply([{ key: ready.key, value: ready.record.value, deleted: false }], { cloudRoot: x.cloudRoot });
  assert.equal(fs.readFileSync(path.join(x.notes, 'Ready.md'), 'utf8'), present.toString());
});

test('expired sync backups are pruned but recent and unrelated folders remain', async (t) => {
  const x = fixture(t);
  const backup = path.join(x.notes, '.sync-removed');
  fs.mkdirSync(backup);
  const old = `${Date.now() - 31 * 24 * 60 * 60 * 1000}-abcdef12`;
  const recent = `${Date.now()}-abcdef12`;
  for (const name of [old, recent, 'manual']) {
    fs.mkdirSync(path.join(backup, name));
    fs.writeFileSync(path.join(backup, name, 'note.md'), name);
  }
  await x.manager.adapter.apply([], { cloudRoot: x.cloudRoot });
  assert.equal(fs.existsSync(path.join(backup, old)), false);
  assert.equal(fs.existsSync(path.join(backup, recent)), true);
  assert.equal(fs.existsSync(path.join(backup, 'manual')), true);
});

test('copy keeps both versions with a new filename and front-matter id', async (t) => {
  const x = fixture(t);
  const original = Buffer.from('---\ndesk-widgets-memo: note-a\n---\nHello\n');
  fs.writeFileSync(path.join(x.notes, 'First.md'), original);
  const current = await x.manager.adapter.read();
  const [key] = Object.keys(current);
  await x.manager.adapter.prepare({ [key]: { value: current[key], deleted: false } }, x.cloudRoot);
  const copied = await x.manager.adapter.copy(key, current[key], { cloudRoot: x.cloudRoot });
  assert.notEqual(copied.key, key);
  assert.equal(copied.value.path, 'First (2).md');
  assert.match(fs.readFileSync(path.join(x.notes, 'First (2).md'), 'utf8'), /desk-widgets-memo: [a-f0-9]{24}/);
  assert.equal(Object.keys(await x.manager.adapter.read()).length, 2);
});

test('unsafe paths, oversize files, and provider overlap cannot enter the file store', async (t) => {
  assert.throws(() => relativeName('../outside.md'));
  assert.throws(() => relativeName('C:\\outside.md'));
  assert.throws(() => validValue({ path: '../outside.md', blob: 'a'.repeat(64), assets: {} }));
  const x = fixture(t, { maxFileBytes: 5 });
  fs.writeFileSync(path.join(x.notes, 'Big.md'), 'More than five bytes');
  await assert.rejects(x.manager.adapter.read(), /too large/);
  const nested = path.join(x.provider, 'Notes');
  fs.mkdirSync(nested);
  const y = fixture(t, { noteFolder: nested });
  y.manager.folder = null;
  assert.equal(await y.manager.adapter.read({ folder: x.provider }), null, 'the candidate provider is checked before first connection');
});

test('symbolic links are rejected rather than followed', async (t) => {
  const x = fixture(t);
  const outside = path.join(x.temp, 'outside.md');
  fs.writeFileSync(outside, 'outside');
  try { fs.symlinkSync(outside, path.join(x.notes, 'Linked.md')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlink creation is unavailable'); throw error; }
  await assert.rejects(x.manager.adapter.read(), /Symbolic link/);
});

test('two PCs exchange a note through the core state and blob folder', async (t) => {
  const x = fixture(t);
  const body = '---\ndesk-widgets-memo: shared-note\n---\nShared content\n';
  fs.writeFileSync(path.join(x.notes, 'Shared.md'), body);
  const second = path.join(x.temp, 'second-notes');
  fs.mkdirSync(second);
  const one = new SyncManager({ localDir: path.join(x.temp, 'state-one'), folder: x.provider, deviceId: 'd-11111111' });
  const two = new SyncManager({ localDir: path.join(x.temp, 'state-two'), folder: x.provider, deviceId: 'd-22222222' });
  const descriptor = (dir) => ({
    name: 'notes', dir: () => dir, include: (rel) => /^[^/]+\.md$/.test(rel),
    idOf: (rel, text) => /^desk-widgets-memo:\s*(.+)$/im.exec(text)?.[1] || rel,
    maxFileBytes: 1024 * 1024,
  });
  t.after(openFileStore(one, 'memo', descriptor(x.notes)).close);
  t.after(openFileStore(two, 'memo', descriptor(second)).close);
  await one.sync();
  const preview = await two.preview();
  assert.equal(preview.imports.length, 1);
  await two.sync();
  assert.equal(fs.readFileSync(path.join(second, 'Shared.md'), 'utf8'), body);
});

test('a name clash with a note from another PC renames only the file: the front matter title stays (#113)', async (t) => {
  // Either note may be the one that moves to "회의 (2).md" (the smaller key keeps the name); both cases.
  for (const incomingKey of [`memo/notes/${'0'.repeat(64)}`, `memo/notes/${'f'.repeat(64)}`]) {
    const x = fixture(t);
    const local = '---\ntitle: 회의\ndesk-widgets-memo: local-note\n---\n이 PC\n';
    const remote = Buffer.from('---\ntitle: 회의\ndesk-widgets-memo: remote-note\n---\n다른 PC\n');
    fs.writeFileSync(path.join(x.notes, '회의.md'), local);
    const hash = digest(remote);
    fs.mkdirSync(path.join(x.cloudRoot, 'blobs', hash.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(x.cloudRoot, 'blobs', hash.slice(0, 2), hash), remote);
    await x.manager.adapter.apply([{ key: incomingKey, value: { path: '회의.md', blob: hash, assets: {} }, deleted: false }], { cloudRoot: x.cloudRoot });
    const texts = ['회의.md', '회의 (2).md'].map((name) => fs.readFileSync(path.join(x.notes, name), 'utf8')).sort();
    assert.deepEqual(texts, [local, remote.toString()].sort(), 'both files keep their bytes, title line included');
  }
});

test('the widget handle lists, reads, writes and deletes only inside its own folder', async (t) => {
  const x = fixture(t);
  let local = 0;
  const { handle, close } = openFileStore(null, 'todonote', {
    name: 'notes', dir: () => x.notes, include: (rel) => /^[^/]+\.md$/.test(rel), idOf: (rel) => rel,
  }, { onLocalChange: () => local++ });
  t.after(close);
  await handle.write('A.md', 'hello');
  assert.deepEqual(await handle.list(), ['A.md']);
  assert.equal(await handle.read('A.md', 'utf8'), 'hello');
  await assert.rejects(handle.write('../escape.md', 'x'), /Invalid note path/);
  await assert.rejects(handle.write('A.exe', 'x'), /outside this store/);
  await handle.remove('A.md');
  assert.deepEqual(await handle.list(), []);
  assert.equal(local, 2, 'each write and delete schedules an export');
  assert.equal(handle.dir(), path.resolve(x.notes));
});

test('notes received from another PC reach the widget through onChange', async (t) => {
  const x = fixture(t);
  const events = [];
  const off = x.handle.onChange((event) => events.push(event));
  t.after(off);
  const next = Buffer.from('---\ndesk-widgets-memo: n\n---\nNew\n');
  const hash = digest(next);
  fs.mkdirSync(path.join(x.cloudRoot, 'blobs', hash.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(x.cloudRoot, 'blobs', hash.slice(0, 2), hash), next);
  await x.manager.adapter.apply([{ key: 'memo/notes/n', value: { path: 'N.md', blob: hash, assets: {} }, deleted: false }], { cloudRoot: x.cloudRoot });
  assert.deepEqual(events.filter((event) => event.remote), [{ paths: ['N.md'], remote: true }]);
});

test('a note folder in OneDrive is exchanged; only one overlapping the sync folder is skipped (#108 field test)', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-files-cloud-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sync = path.join(temp, 'sync');
  const inOneDrive = path.join(temp, 'OneDrive', 'Documents', 'Desk Widgets', 'notes');
  const inSync = path.join(sync, 'notes');
  for (const dir of [inOneDrive, inSync]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(inOneDrive, 'A.md'), 'a');
  const open = (dir) => {
    const manager = { folder: sync, register(adapter) { this.adapter = adapter; return () => {}; } };
    const { handle, close } = openFileStore(manager, 'memo', { name: 'notes', dir: () => dir, include: (rel) => /\.md$/.test(rel), idOf: (rel) => rel });
    t.after(close);
    return { handle, manager };
  };
  const oneDrive = open(inOneDrive);
  assert.equal(oneDrive.handle.cloudManaged(), false);
  assert.equal(Object.keys(await oneDrive.manager.adapter.read()).length, 1);
  const overlapping = open(inSync);
  assert.equal(overlapping.handle.cloudManaged(), true);
  assert.equal(await overlapping.manager.adapter.read(), null);
});

test('1.1.3-test notes in the sync folder come back to the note folder; older local copies are backed up', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-files-legacy-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cloud = path.join(temp, 'cloud');
  const syncDir = path.join(temp, 'userData', 'sync');
  const notes = path.join(temp, 'Documents', 'notes');
  const deviceId = 'd-0123456789abcdef';
  const legacy = path.join(cloud, 'widgets', 'memo', deviceId, 'notes');
  fs.mkdirSync(path.join(legacy, 'Pic.assets'), { recursive: true });
  fs.mkdirSync(path.join(legacy, '.sync-removed', '1-aa'), { recursive: true });
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, 'config.json'), JSON.stringify({ folder: cloud, deviceId, activeSources: { 'memo-notes': true } }));
  fs.writeFileSync(path.join(legacy, 'Edited.md'), 'edited in the sync folder');
  fs.writeFileSync(path.join(legacy, 'New.md'), 'made in the sync folder');
  fs.writeFileSync(path.join(legacy, 'Same.md'), 'same');
  fs.writeFileSync(path.join(legacy, 'Pic.assets', 'a.png'), Buffer.from([9, 9]));
  fs.writeFileSync(path.join(legacy, '.sync-removed', '1-aa', 'Old.md'), 'removed');
  fs.writeFileSync(path.join(notes, 'Edited.md'), 'stale copy from before the switch');
  fs.writeFileSync(path.join(notes, 'Same.md'), 'same');
  fs.writeFileSync(path.join(notes, 'LocalOnly.md'), 'kept');
  const migrator = createLegacyMigrator({ syncDir, log: () => {} });
  const descriptor = { name: 'notes', dir: () => notes, include: (rel) => /\.md$/.test(rel) || /\.assets\//.test(rel), idOf: (rel) => rel };
  const { close } = openFileStore(null, 'memo', descriptor, { migrate: (info) => migrator.migrateFiles(info) });
  t.after(close);
  assert.equal(fs.readFileSync(path.join(notes, 'Edited.md'), 'utf8'), 'edited in the sync folder');
  assert.equal(fs.readFileSync(path.join(notes, 'New.md'), 'utf8'), 'made in the sync folder');
  assert.deepEqual([...fs.readFileSync(path.join(notes, 'Pic.assets', 'a.png'))], [9, 9]);
  assert.equal(fs.readFileSync(path.join(notes, 'LocalOnly.md'), 'utf8'), 'kept');
  assert.equal(fs.existsSync(path.join(notes, 'Old.md')), false, 'removed-files backups are not restored');
  const [backup] = fs.readdirSync(path.join(syncDir, 'migration-backup'));
  assert.equal(fs.readFileSync(path.join(syncDir, 'migration-backup', backup, 'Edited.md'), 'utf8'), 'stale copy from before the switch');
  assert.equal(fs.existsSync(path.join(legacy, 'Edited.md')), true, 'the sync-folder original is kept');
  assert.deepEqual(migrator.pending(), []);
});

test('notes migration copies nothing when one sync-folder file is unreadable', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-files-legacy-big-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cloud = path.join(temp, 'cloud');
  const syncDir = path.join(temp, 'sync');
  const notes = path.join(temp, 'notes');
  const deviceId = 'd-0123456789abcdef';
  const legacy = path.join(cloud, 'widgets', 'todonote', deviceId, 'notes');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, 'config.json'), JSON.stringify({ folder: cloud, deviceId, activeSources: { 'todonote-notes': true } }));
  fs.writeFileSync(path.join(legacy, 'A.md'), 'a');
  fs.writeFileSync(path.join(legacy, 'B.md'), 'x'.repeat(50));
  const migrator = createLegacyMigrator({ syncDir, log: () => {} });
  const { close } = openFileStore(null, 'todonote', { name: 'notes', dir: () => notes, include: (rel) => /\.md$/.test(rel), idOf: (rel) => rel, maxFileBytes: 10 },
    { migrate: (info) => migrator.migrateFiles(info) });
  t.after(close);
  assert.equal(fs.existsSync(path.join(notes, 'A.md')), false);
  assert.deepEqual(migrator.pending(), ['todonote-notes']);
});
