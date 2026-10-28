const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SyncManager, CLOUD_FOLDER, FORMAT } = require('../main/sync');

const KEY = 'todo/tasks/t-1';
const OTHER = 'todo/tasks/t-2';
const deepCopy = (value) => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'cloud');
  const make = (label, now = Date.now) => {
    const items = {};
    const manager = new SyncManager({
      localDir: path.join(root, label), folder,
      deviceId: `d-${label === 'a' ? 'aaaaaaaa' : 'bbbbbbbb'}`, deviceName: label, now,
    });
    manager.register({
      name: 'todo',
      read: () => deepCopy(items),
      apply: (changes) => {
        for (const change of changes) {
          if (change.deleted) delete items[change.key];
          else items[change.key] = deepCopy(change.value);
        }
      },
      copy: (key, value) => {
        const copiedKey = key === KEY ? OTHER : `${key}-copy`;
        items[copiedKey] = deepCopy(value);
        return { key: copiedKey, value: items[copiedKey] };
      },
    });
    return { manager, items };
  };
  return { root, folder, make };
}

test('preview is read-only; a second PC imports a missing item', async (t) => {
  const { root, folder, make } = fixture(t);
  const a = make('a');
  const b = make('b');
  a.items[KEY] = { title: 'From A' };
  await a.manager.sync();
  assert.equal(FORMAT, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'format.json'), 'utf8')).format, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, CLOUD_FOLDER, 'format.json'), 'utf8')).format, 2);
  assert.equal(fs.existsSync(path.join(folder, CLOUD_FOLDER, 'state')), false);
  const preview = await b.manager.preview(folder);
  assert.deepEqual(preview.imports.map((item) => item.key), [KEY]);
  assert.deepEqual(b.items, {});
  assert.equal(fs.existsSync(path.join(root, 'b', 'state.json')), false);
  const result = await b.manager.sync();
  assert.equal(result.applied, 1);
  assert.deepEqual(b.items[KEY], a.items[KEY]);
});

test('an existing format-1 nested folder keeps its records and envelope format', async (t) => {
  const { folder, make } = fixture(t);
  const legacyRoot = path.join(folder, CLOUD_FOLDER);
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'format.json'), JSON.stringify({ format: 1 }));
  const a = make('a');
  const b = make('b');
  a.items[KEY] = { title: 'Legacy' };
  await a.manager.sync();
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyRoot, 'state', 'd-aaaaaaaa', 'todo.json'), 'utf8')).format, 1);
  assert.equal(fs.existsSync(path.join(folder, 'format.json')), false);
  await b.manager.sync();
  assert.equal(b.items[KEY].title, 'Legacy');
});

test('a version-2 nested marker keeps an old-style parent selection read-only', async (t) => {
  const { folder, make } = fixture(t);
  fs.mkdirSync(path.join(folder, CLOUD_FOLDER), { recursive: true });
  fs.writeFileSync(path.join(folder, CLOUD_FOLDER, 'format.json'), JSON.stringify({ format: 2 }));
  const a = make('a');
  a.items[KEY] = { title: 'Do not publish' };
  const result = await a.manager.sync();
  assert.equal(result.readOnly, true);
  assert.equal(fs.existsSync(path.join(folder, 'state')), false);
});

test('different simultaneous edits need a choice; remote choice preserves the selected value', async (t) => {
  const { folder, make } = fixture(t);
  const a = make('a');
  const b = make('b');
  a.items[KEY] = { title: 'Original' };
  await a.manager.sync();
  await b.manager.sync();
  a.items[KEY] = { title: 'A edit' };
  b.items[KEY] = { title: 'B edit' };
  await a.manager.sync();
  const preview = await b.manager.preview();
  assert.deepEqual(preview.conflicts.map((item) => item.key), [KEY]);
  const pending = await b.manager.sync();
  assert.equal(pending.conflicts.length, 1);
  assert.equal(b.items[KEY].title, 'B edit');
  const published = JSON.parse(fs.readFileSync(path.join(folder, 'state', 'd-bbbbbbbb', 'todo.json'), 'utf8'));
  assert.equal(published.records[KEY].value.title, 'Original', 'an unresolved edit must stay local until chosen');
  await b.manager.resolve({ key: KEY, choice: 'remote' });
  assert.equal(b.items[KEY].title, 'A edit');
  assert.equal(b.manager.status().conflicts.length, 0);
  assert.equal((await a.manager.sync()).conflicts.length, 0);
});

test('a discarded conflict value can be restored for 30 days unless the item changed again', async (t) => {
  const { make } = fixture(t);
  const a = make('a');
  const b = make('b');
  a.items[KEY] = { title: 'Original' };
  await a.manager.sync();
  await b.manager.sync();
  a.items[KEY] = { title: 'Remote' };
  b.items[KEY] = { title: 'Local' };
  await a.manager.sync();
  await b.manager.sync({ resolutions: { [KEY]: 'remote' } });
  assert.equal(b.items[KEY].title, 'Remote');
  const [entry] = await b.manager.listUndo();
  assert.equal(entry.discarded.value.title, 'Local');
  await b.manager.undo(entry.id);
  assert.equal(b.items[KEY].title, 'Local');
  assert.equal((await b.manager.listUndo()).length, 0);
  await a.manager.sync();
  assert.equal(a.items[KEY].title, 'Local');
});

test('both choice preserves the local item and makes a copy of the remote item', async (t) => {
  const { make } = fixture(t);
  const a = make('a');
  const b = make('b');
  a.items[KEY] = { title: 'Original' };
  await a.manager.sync();
  await b.manager.sync();
  a.items[KEY] = { title: 'A edit' };
  b.items[KEY] = { title: 'B edit' };
  await a.manager.sync();
  const result = await b.manager.sync({ resolutions: { [KEY]: 'both' } });
  assert.equal(result.resolved, 1);
  assert.equal(result.conflicts.length, 0);
  assert.equal(b.items[KEY].title, 'B edit');
  assert.equal(b.items[OTHER].title, 'A edit');
  await a.manager.sync();
  assert.equal(a.items[KEY].title, 'B edit');
  assert.equal(a.items[OTHER].title, 'A edit');
});

test('deletion travels as a tombstone instead of restoring a stale item', async (t) => {
  const { folder, make } = fixture(t);
  const a = make('a');
  const b = make('b');
  a.items[KEY] = { title: 'Delete me' };
  await a.manager.sync();
  await b.manager.sync();
  delete a.items[KEY];
  await a.manager.sync();
  await b.manager.sync();
  assert.equal(Object.hasOwn(b.items, KEY), false);
  const state = JSON.parse(fs.readFileSync(path.join(folder, 'state', 'd-aaaaaaaa', 'todo.json'), 'utf8'));
  assert.equal(state.records[KEY].deleted, true);
  assert.equal(Object.hasOwn(state.records[KEY], 'value'), false);
  assert.equal((await b.manager.sync()).conflicts.length, 0);
});

test('a damaged or half-downloaded remote state uses the last valid copy', async (t) => {
  const { folder, make } = fixture(t);
  const a = make('a');
  const b = make('b');
  a.items[KEY] = { title: 'Good' };
  await a.manager.sync();
  await b.manager.sync();
  const remote = path.join(folder, 'state', 'd-aaaaaaaa', 'todo.json');
  fs.writeFileSync(remote, '{"format":1,"records":', 'utf8');
  const result = await b.manager.sync();
  assert.deepEqual(b.items[KEY], { title: 'Good' });
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['remote-not-ready']);
  assert.equal(result.conflicts.length, 0);
});

test('an unavailable attachment defers only its note while other items import', async (t) => {
  const { make } = fixture(t);
  const a = make('a');
  const b = make('b');
  a.items[KEY] = { title: 'Waiting for blob' };
  a.items[OTHER] = { title: 'Ready' };
  await a.manager.sync();
  let blobReady = false;
  b.manager.register({
    name: 'todo',
    read: () => deepCopy(b.items),
    available: (item) => item.key !== KEY || blobReady,
    apply: (changes) => { for (const change of changes) b.items[change.key] = deepCopy(change.value); },
  });
  const first = await b.manager.sync();
  assert.equal(b.items[KEY], undefined);
  assert.equal(b.items[OTHER].title, 'Ready');
  assert.deepEqual(first.warnings.map((item) => item.code), ['blob-not-ready']);
  blobReady = true;
  const second = await b.manager.sync();
  assert.equal(second.applied, 1);
  assert.equal(b.items[KEY].title, 'Waiting for blob');
});

test('clock skew does not decide which revision wins', async (t) => {
  const { make } = fixture(t);
  const a = make('a', () => 2_000_000_000_000);
  const b = make('b', () => 1_000_000_000_000);
  b.items[KEY] = { title: 'First' };
  await b.manager.sync();
  await a.manager.sync();
  a.items[KEY] = { title: 'Later edit from older clock' };
  await a.manager.sync();
  await b.manager.sync();
  assert.equal(b.items[KEY].title, 'Later edit from older clock');
});

test('adapter replacement on widget reload keeps the newer adapter registered', (t) => {
  const { make } = fixture(t);
  const { manager } = make('a');
  const old = { name: 'clock', read: () => ({}), apply: () => {} };
  const fresh = { name: 'clock', read: () => ({}), apply: () => {} };
  const oldCleanup = manager.register(old);
  const freshCleanup = manager.register(fresh);
  oldCleanup();
  assert.equal(manager.adapters.get('clock'), fresh);
  freshCleanup();
  assert.equal(manager.adapters.has('clock'), false);
});

test('an already cloud-managed source is skipped without publishing inferred deletions', async (t) => {
  const { folder, make } = fixture(t);
  const a = make('a');
  a.items[KEY] = { title: 'Shared by provider' };
  await a.manager.sync();
  a.manager.register({ name: 'todo', read: () => null, apply: () => { throw new Error('must not apply'); } });
  const result = await a.manager.sync();
  assert.deepEqual(result.warnings.map((item) => item.code), ['already-cloud-managed']);
  const state = JSON.parse(fs.readFileSync(path.join(folder, 'state', 'd-aaaaaaaa', 'todo.json'), 'utf8'));
  assert.equal(state.records[KEY].value.title, 'Shared by provider');
});

test('an offline PC cannot silently restore an item after 180-day tombstone expiry', async (t) => {
  const { folder, make } = fixture(t);
  const DAY = 24 * 60 * 60 * 1000;
  let clock = 1_000_000;
  const now = () => clock;
  const a = make('a', now);
  const b = make('b', now);
  a.manager.tombstoneDays = 1;
  b.manager.tombstoneDays = 1;
  a.items[KEY] = { title: 'Old item' };
  await a.manager.sync();
  await b.manager.sync();
  // A third PC connected once, then its cloud client went offline before its own state arrived elsewhere.
  const c = new SyncManager({ localDir: path.join(folder, 'offline-local'), folder, deviceId: 'd-cccccccc', now, tombstoneDays: 1 });
  const cItems = {};
  c.register({ name: 'todo', read: () => deepCopy(cItems), apply: (changes) => {
    for (const change of changes) if (change.deleted) delete cItems[change.key]; else cItems[change.key] = deepCopy(change.value);
  } });
  await c.sync();
  assert.equal(cItems[KEY].title, 'Old item');
  const offlineState = path.join(folder, 'state', 'd-cccccccc', 'todo.json');
  const staleCopy = fs.readFileSync(offlineState);
  fs.unlinkSync(offlineState);
  clock += 1000;
  delete a.items[KEY];
  await a.manager.sync();
  await b.manager.sync();
  clock += DAY / 2;
  await a.manager.sync();
  await b.manager.sync();
  clock += DAY * 0.6;
  await a.manager.sync();
  await b.manager.sync();
  const aState = JSON.parse(fs.readFileSync(path.join(folder, 'state', 'd-aaaaaaaa', 'todo.json'), 'utf8'));
  assert.equal(Object.hasOwn(aState.records, KEY), false, 'aged tombstone was retired from publication');
  const preview = await c.preview();
  assert.equal(preview.requiresReconnect, true);
  assert.equal(preview.reconnectReason, 'stale-device');
  assert.deepEqual(preview.uploads.map((item) => item.key), [KEY]);
  const refused = await c.sync();
  assert.equal(refused.requiresReconnect, true);
  assert.equal(refused.published, 0);
  assert.equal(a.items[KEY], undefined);
  fs.writeFileSync(offlineState, staleCopy);
  const activePreview = await a.manager.preview();
  assert.deepEqual(activePreview.conflicts.map((item) => item.key), [KEY], 'a retired key rejects a late stale cloud state');
  await a.manager.sync();
  assert.equal(a.items[KEY], undefined);
});

test('changing sync folders requires a fresh comparison and explicit reconnect approval', async (t) => {
  const { root, folder, make } = fixture(t);
  const a = make('a');
  a.items[KEY] = { title: 'Folder one' };
  await a.manager.sync();
  const second = path.join(root, 'second-cloud');
  const other = new SyncManager({ localDir: path.join(root, 'other'), folder: second, deviceId: 'd-dddddddd' });
  const otherItems = { [KEY]: { title: 'Folder two' } };
  other.register({ name: 'todo', read: () => deepCopy(otherItems), apply: () => {} });
  await other.sync();
  const preview = await a.manager.preview(second);
  assert.equal(preview.requiresReconnect, true);
  assert.equal(preview.reconnectReason, 'folder-changed');
  assert.deepEqual(preview.conflicts.map((item) => item.key), [KEY]);
  a.manager.connect(second);
  const refused = await a.manager.sync();
  assert.equal(refused.published, 0);
  assert.equal(a.items[KEY].title, 'Folder one');
  const accepted = await a.manager.sync({ approveReconnect: true, resolutions: { [KEY]: 'remote' } });
  assert.equal(accepted.requiresReconnect, false);
  assert.equal(a.items[KEY].title, 'Folder two');
});
