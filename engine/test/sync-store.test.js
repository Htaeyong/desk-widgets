const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSyncStore, normalizeSpec } = require('../main/sync-store');
const { createStore } = require('../main/store');
const { createLegacyMigrator } = require('../main/sync-legacy');
const { hashValue } = require('../main/sync');

function setup(initial, sync, secret = null) {
  let state = structuredClone(initial);
  let adapter;
  let localChanges = 0;
  const store = createSyncStore({
    createStore: () => ({ load: () => state, save: (next) => (state = structuredClone({ ...state, ...next })) }),
    manager: { register: (value) => { adapter = value; return () => {}; } },
    widgetId: 'calendar',
    options: { sync, secret },
    onLocalChange: () => { localChanges += 1; },
  });
  return { store, adapter: () => adapter, state: () => state, localChanges: () => localChanges };
}

test('item store shares only declared settings and filtered records', async () => {
  const t = setup({
    themeId: 'glass', windowBounds: { x: 1 },
    sources: [{ id: 'caldav', type: 'caldav', name: 'Work' }, { id: 'ics', type: 'ics', url: 'https://private.example/?token=secret' }],
  }, {
    name: 'settings', collections: { sources: { id: 'id', filter: (item) => item.type === 'caldav' } }, shared: ['themeId'],
  });
  const records = await t.adapter().read();
  assert.deepEqual(Object.keys(records).sort(), ['calendar/@settings/themeId', 'calendar/sources/caldav']);
  assert.equal(JSON.stringify(records).includes('private.example'), false);
  assert.equal(JSON.stringify(records).includes('windowBounds'), false);
  await t.adapter().apply([{ key: 'calendar/sources/caldav', value: { id: 'caldav', type: 'caldav', name: 'New' } }]);
  assert.equal(t.state().sources.find((item) => item.id === 'ics').url.includes('token='), true);
  assert.equal(t.state().sources.find((item) => item.id === 'caldav').name, 'New');
  assert.equal(t.localChanges(), 0, 'remote application must not queue an upload');
});

test('a store with a secret cannot declare sync, and declarations are validated', () => {
  assert.throws(() => setup({ token: 'secret' }, { shared: [] }, { field: 'token', enc: 'tokenEnc', plain: 'tokenPlain' }), /secret/);
  assert.throws(() => normalizeSpec({ collections: { a: { id: 'id', shared: ['x'], local: ['y'] } } }), /both/);
  assert.throws(() => normalizeSpec({ collections: { a: { id: 'id', local: ['id'] } } }), /id field/);
  assert.throws(() => normalizeSpec({ name: '../x' }), /name/);
  assert.deepEqual(normalizeSpec({ collections: { a: { shared: ['title'] } } }).collections.a.shared, ['id', 'title']);
});

test('PC-only fields (local marks) stay on this PC and survive another PC\'s version', async () => {
  const t = setup({ alarms: [{ id: 'a', title: 'Wake', snoozeUntil: 123 }] }, {
    collections: { alarms: { id: 'id', local: ['snoozeUntil'] } }, shared: [],
  });
  assert.deepEqual((await t.adapter().read())['calendar/alarms/a'], { id: 'a', title: 'Wake' });
  // A remote value cannot set this PC's snooze even if it carries the field.
  await t.adapter().apply([{ key: 'calendar/alarms/a', value: { id: 'a', title: 'Morning', snoozeUntil: 999 } }]);
  assert.equal(t.state().alarms[0].snoozeUntil, 123);
  assert.equal(t.state().alarms[0].title, 'Morning');
  t.store.save({ themeId: 'new' });
  assert.equal(t.localChanges(), 1);
});

test('shared marks on a map collection keep window state local', async () => {
  const t = setup({ memos: { note1: { color: 'yellow', open: true, bounds: { x: 1, y: 2 } } } }, {
    collections: { memos: { map: true, shared: ['color'] } }, shared: [],
  });
  assert.deepEqual((await t.adapter().read())['calendar/memos/note1'], { color: 'yellow' });
  await t.adapter().apply([{ key: 'calendar/memos/note1', value: { color: 'midnight', open: false } }]);
  assert.deepEqual(t.state().memos.note1, { color: 'midnight', open: true, bounds: { x: 1, y: 2 } });
  await t.adapter().apply([{ key: 'calendar/memos/note1', deleted: true }]);
  assert.equal(Object.hasOwn(t.state().memos, 'note1'), false);
  await t.adapter().apply([{ key: 'calendar/memos/__proto__', value: { color: 'x' } }]);
  assert.equal(Object.getPrototypeOf(t.state().memos), Object.prototype);
});

test('imported CalDAV account stays disabled until this PC enables it', async () => {
  const t = setup({ sources: [{ id: 'old', type: 'caldav', enabled: true, name: 'Existing' }] }, {
    collections: { sources: { id: 'id', filter: (source) => source.type === 'caldav', local: ['enabled'], localDefaults: { enabled: false } } },
    shared: [],
  });
  const records = await t.adapter().read();
  assert.equal(Object.hasOwn(records['calendar/sources/old'], 'enabled'), false);
  await t.adapter().apply([
    { key: 'calendar/sources/old', value: { id: 'old', type: 'caldav', name: 'Renamed' } },
    { key: 'calendar/sources/new', value: { id: 'new', type: 'caldav', name: 'Imported', enabled: true } },
  ]);
  assert.equal(t.state().sources.find((source) => source.id === 'old').enabled, true);
  assert.equal(t.state().sources.find((source) => source.id === 'new').enabled, false);
});

test('keeping both versions persists the copied record in the widget store', async () => {
  const t = setup({ tasks: [{ id: 'a', title: 'Mine' }] }, {
    name: 'settings', collections: { tasks: { id: 'id' } },
    copy: (value) => ({ ...value, id: 'b' }),
  });
  const copied = await t.adapter().copy('calendar/tasks/a', { id: 'a', title: 'Theirs' });
  assert.equal(copied.key, 'calendar/tasks/b');
  assert.deepEqual(t.store.load().tasks.map((item) => item.title), ['Mine', 'Theirs']);
});

test('real file store: widget writes only its own file, applied changes are atomic and re-readable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-item-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let adapter;
  let remote = 0;
  const file = path.join(dir, 'settings.json');
  const store = createSyncStore({
    createStore, manager: { register: (value) => { adapter = value; return () => {}; } }, widgetId: 'todo',
    options: { file, defaults: { themeId: 'light', tasks: [] }, sync: { name: 'todo', collections: { tasks: { id: 'id', local: ['snoozedUntil'] } }, shared: ['themeId'] } },
  });
  store.onRemoteChange(() => remote++);
  store.save({ tasks: [{ id: 'a', title: 'Mine', snoozedUntil: 5 }] });
  await adapter.apply([{ key: 'todo/tasks/b', value: { id: 'b', title: 'Theirs' } }, { key: 'todo/@settings/themeId', value: 'dark' }]);
  assert.equal(remote, 1);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.tasks.map((task) => task.id), ['a', 'b']);
  assert.equal(disk.themeId, 'dark');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'no temp file is left behind');
});

test('1.1.3-test data in the sync folder comes back into the local file once, with a backup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-legacy-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  const syncDir = path.join(root, 'userData', 'sync');
  const file = path.join(root, 'userData', 'widgets', 'todo', 'settings.json');
  const deviceId = 'd-aabbccdd11223344';
  fs.mkdirSync(syncDir, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(syncDir, 'config.json'), JSON.stringify({ folder: cloud, deviceId, activeSources: { 'todo-todo': true } }));
  // What the 1.1.3-test store left on this PC: the PC-only part only.
  fs.writeFileSync(file, JSON.stringify({ selectedListId: 'a', tasks: [{ id: 'a', snoozedUntil: 9 }, { id: 'gone', snoozedUntil: 1 }] }));
  const records = { 'todo/tasks/a': { id: 'a', title: 'Live title' }, 'todo/tasks/b': { id: 'b', title: 'Made in sync folder' }, 'todo/@settings/themeId': 'dark' };
  const legacyFile = path.join(cloud, 'widgets', 'todo', deviceId, 'todo.json');
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({ format: 1, widget: 'todo', source: 'todo', device: deviceId, sha256: hashValue(records), records }));
  const options = { file, defaults: { themeId: 'light', selectedListId: '', tasks: [] }, sync: { name: 'todo', collections: { tasks: { id: 'id', local: ['snoozedUntil'] } }, shared: ['themeId'] } };
  const open = () => {
    const migrator = createLegacyMigrator({ syncDir, log: () => {} });
    const store = createSyncStore({ createStore, widgetId: 'todo', options, migrate: (info) => migrator.migrateStore(info) });
    return { store, migrator };
  };
  const first = open();
  const value = first.store.load();
  assert.equal(value.themeId, 'dark');
  assert.equal(value.selectedListId, 'a');
  assert.deepEqual(value.tasks, [{ id: 'a', snoozedUntil: 9, title: 'Live title' }, { id: 'b', title: 'Made in sync folder' }]);
  assert.equal(first.migrator.pending().length, 0);
  const backups = fs.readdirSync(path.join(syncDir, 'migration-backup'));
  assert.equal(backups.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(syncDir, 'migration-backup', backups[0], 'settings.json'), 'utf8')).tasks.length, 2);
  assert.equal(fs.existsSync(legacyFile), true, 'the sync-folder original is kept');
  // Once switched, later edits are never overwritten by the old sync-folder copy.
  first.store.save({ themeId: 'mine' });
  assert.equal(open().store.load().themeId, 'mine');
  assert.equal(fs.readdirSync(path.join(syncDir, 'migration-backup')).length, 1);
});

test('a damaged sync-folder copy is not migrated and is retried later', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-legacy-bad-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  const syncDir = path.join(root, 'sync');
  const file = path.join(root, 'settings.json');
  const deviceId = 'd-aabbccdd11223344';
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, 'config.json'), JSON.stringify({ folder: cloud, deviceId, activeSources: { 'clock-clock': true } }));
  const legacyFile = path.join(cloud, 'widgets', 'clock', deviceId, 'clock.json');
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, '{"format":1,"widget":"clock","source":"clock","rec'); // half downloaded
  fs.writeFileSync(file, JSON.stringify({ alarms: [{ id: 'x', since: 3 }] }));
  const migrator = createLegacyMigrator({ syncDir, log: () => {} });
  const store = createSyncStore({ createStore, widgetId: 'clock', migrate: (info) => migrator.migrateStore(info),
    options: { file, defaults: { alarms: [] }, sync: { name: 'clock', collections: { alarms: { id: 'id', local: ['since'] } } } } });
  assert.deepEqual(store.load().alarms, [{ id: 'x', since: 3 }], 'the local file is untouched');
  assert.deepEqual(migrator.pending(), ['clock-clock']);
  assert.equal(migrator.warnings()[0].code, 'legacy-migration');
  // The config snapshot survives the controller rewriting config.json.
  fs.writeFileSync(path.join(syncDir, 'config.json'), JSON.stringify({ folder: cloud, deviceId }));
  assert.deepEqual(createLegacyMigrator({ syncDir, log: () => {} }).pending(), ['clock-clock']);
});
