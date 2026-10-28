const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSyncController } = require('../main/sync-controller');
const { CLOUD_FOLDER } = require('../main/sync');

test('folder connection previews changes before writing, then imports on a second PC', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-controller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'cloud');
  fs.mkdirSync(folder);
  const make = (id) => {
    const items = {};
    const controller = createSyncController({ userData: path.join(root, id), widgetList: () => [{ id: 'todo', name: 'Tasks' }] });
    controller.manager.register({
      name: 'todo-settings', read: () => ({ ...items }),
      apply: (changes) => {
        for (const change of changes) {
          if (change.deleted) delete items[change.key];
          else items[change.key] = change.value;
        }
      },
    });
    t.after(() => controller.stop());
    return { controller, items };
  };
  const first = make('first');
  first.items['todo/tasks/task-1'] = { id: 'task-1', title: 'First' };
  const review = await first.controller.previewConnect({ folder, deviceName: 'First PC', widgets: { todo: true } });
  assert.equal(review.ok, true);
  assert.equal(review.pending.changes[0].kind, 'upload');
  assert.equal(fs.existsSync(path.join(folder, CLOUD_FOLDER)), false, 'preview must not write to the selected folder');
  assert.equal((await first.controller.applyConnect({ previewId: review.pending.previewId, resolutions: {} })).ok, true);
  const second = make('second');
  const incoming = await second.controller.previewConnect({ folder, deviceName: 'Second PC', widgets: { todo: true } });
  assert.equal(incoming.pending.changes[0].kind, 'import');
  assert.equal(second.items['todo/tasks/task-1'], undefined);
  assert.equal((await second.controller.applyConnect({ previewId: incoming.pending.previewId, resolutions: {} })).ok, true);
  assert.deepEqual(second.items['todo/tasks/task-1'], first.items['todo/tasks/task-1']);
  assert.equal((await second.controller.disable()).state.enabled, false);
  assert.deepEqual(second.items['todo/tasks/task-1'], first.items['todo/tasks/task-1']);
});

test('changing folders requires review acknowledgement before any write', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-reconnect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const controller = createSyncController({ userData: path.join(root, 'local') });
  const records = { 'engine/@settings/idleMinutes': 3 };
  controller.manager.register({ name: 'engine', read: () => records, apply: () => {} });
  t.after(() => controller.stop());
  const initial = await controller.previewConnect({ folder: first });
  assert.equal((await controller.applyConnect({ previewId: initial.pending.previewId })).ok, true);
  const review = await controller.previewConnect({ folder: second });
  assert.equal(review.pending.requiresReconnect, true);
  assert.equal(review.pending.reconnectReason, 'folder-changed');
  assert.equal((await controller.applyConnect({ previewId: review.pending.previewId })).ok, false);
  assert.equal(fs.existsSync(path.join(second, CLOUD_FOLDER)), false);
  assert.equal((await controller.applyConnect({ previewId: review.pending.previewId, acknowledgeReconnect: true })).ok, true);
  assert.equal(fs.existsSync(path.join(second, CLOUD_FOLDER)), true);
});

test('widget data never moves: connect, later registration and disconnect only exchange records', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-exchange-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  const controller = createSyncController({ userData: path.join(root, 'local') });
  t.after(() => controller.stop());
  assert.equal(controller.dataPath, undefined, 'the controller has no widget data path any more');
  const preview = await controller.previewConnect({ folder: cloud, widgets: { memo: true } });
  assert.equal((await controller.applyConnect({ previewId: preview.pending.previewId })).ok, true);
  // A widget started after connection simply registers; its next sync exports it.
  const items = { 'memo/memos/a': { color: 'yellow' } };
  controller.manager.register({ name: 'memo-settings', widgetId: 'memo', read: () => ({ ...items }), apply: () => {} });
  assert.equal((await controller.syncNow()).ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(cloud, 'state', controller.manager.deviceId, 'memo-settings.json'), 'utf8'));
  assert.deepEqual(state.records['memo/memos/a'].value, { color: 'yellow' });
  assert.equal(fs.existsSync(path.join(cloud, 'widgets')), false, 'nothing is stored as live widget data in the sync folder');
  assert.equal((await controller.disable()).ok, true);
  assert.deepEqual(items, { 'memo/memos/a': { color: 'yellow' } }, 'turning sync off leaves this PC\'s data as it is');
  assert.equal(fs.existsSync(path.join(cloud, 'state', controller.manager.deviceId, 'memo-settings.json')), true, 'the cloud folder is kept');
});

test('a store whose records hold a secret is not exported and the manager shows why', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-secret-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  const controller = createSyncController({ userData: path.join(root, 'local'), secretGuard: (text) => text.includes('hunter22') });
  t.after(() => controller.stop());
  controller.manager.register({ name: 'mail-categories', widgetId: 'mail', read: () => ({ 'mail/categories/c1': { id: 'c1', name: 'pw hunter22' } }), apply: () => {} });
  controller.manager.register({ name: 'todo-todo', widgetId: 'todo', read: () => ({ 'todo/tasks/t1': { id: 't1', title: 'ok' } }), apply: () => {} });
  const preview = await controller.previewConnect({ folder: cloud, widgets: { mail: true, todo: true } });
  assert.equal((await controller.applyConnect({ previewId: preview.pending.previewId })).ok, true);
  const dir = path.join(cloud, 'state', controller.manager.deviceId);
  assert.equal(fs.existsSync(path.join(dir, 'mail-categories.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'todo-todo.json')), true);
  assert.match(controller.state().notices.join(' '), /mail-categories/);
});

test('an older selected parent is shown as the existing format-1 data root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-legacy-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'cloud');
  const legacy = path.join(parent, CLOUD_FOLDER);
  const userData = path.join(root, 'local');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(path.join(userData, 'sync'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'format.json'), JSON.stringify({ format: 1 }));
  fs.writeFileSync(path.join(userData, 'sync', 'config.json'), JSON.stringify({ folder: parent }));
  const controller = createSyncController({ userData });
  t.after(() => controller.stop());
  assert.equal(controller.state().folder, legacy);
  assert.equal(controller.manager.folder, legacy);
});

test('a drive root is refused with a clear reason, and "create folder" makes and uses a subfolder only there', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = createSyncController({ userData: path.join(root, 'app'), widgetList: () => [{ id: 'todo', name: 'Tasks' }] });
  t.after(() => controller.stop());
  const driveRoot = path.parse(root).root;
  const refused = await controller.previewConnect({ folder: driveRoot, widgets: { todo: true } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'drive-root');
  assert.match(refused.message, /드라이브 맨 위|drive root/);
  // Only a root is accepted by the create action; a normal folder is not turned into a parent.
  const inner = path.join(root, 'cloud');
  fs.mkdirSync(inner);
  const notRoot = controller.createFolderInRoot(inner);
  assert.equal(notRoot.ok, false);
  assert.equal(fs.existsSync(path.join(inner, CLOUD_FOLDER)), false);
  assert.equal(controller.createFolderInRoot('relative\path').ok, false);
});

test('a sync folder watch error (e.g. UNKNOWN on a network share) is handled, not an uncaught exception', async (t) => {
  const { EventEmitter } = require('events');
  const realWatch = fs.watch;
  const watchers = [];
  fs.watch = () => { const w = new EventEmitter(); w.close = () => { w.closed = true; }; watchers.push(w); return w; };
  t.after(() => { fs.watch = realWatch; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'cloud');
  fs.mkdirSync(folder);
  const controller = createSyncController({ userData: path.join(root, 'app'), widgetList: () => [{ id: 'todo', name: 'Tasks' }] });
  t.after(() => controller.stop());
  controller.manager.register({ name: 'todo-settings', read: () => ({}), apply: () => {} });
  const review = await controller.previewConnect({ folder, widgets: { todo: true } });
  assert.equal((await controller.applyConnect({ previewId: review.pending.previewId, resolutions: {} })).ok, true);
  for (let i = 0; i < 50 && !watchers.length; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(watchers.length > 0, 'a watcher was started on the sync folder');
  for (const w of watchers) {
    assert.ok(w.listenerCount('error') > 0, 'every watcher has an error handler');
    assert.doesNotThrow(() => w.emit('error', Object.assign(new Error('UNKNOWN: unknown error, watch'), { code: 'UNKNOWN' })));
    assert.equal(w.closed, true);
  }
});

test('sync interval: chosen from 1/2/5/10/30 minutes (default 2), shown with last and next check, applied at once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-interval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  const states = [];
  const controller = createSyncController({ userData: path.join(root, 'local'), onChanged: (s) => states.push(s) });
  t.after(() => controller.stop());
  assert.equal(controller.state().intervalMinutes, 2);
  assert.deepEqual(controller.state().intervals, [1, 2, 5, 10, 30]);
  assert.equal(controller.state().schedule.watch, 'off');
  const preview = await controller.previewConnect({ folder: cloud, intervalMinutes: 5 });
  assert.equal((await controller.applyConnect({ previewId: preview.pending.previewId })).ok, true);
  assert.equal(controller.state().intervalMinutes, 5);
  await waitFor(() => controller.state().schedule.lastCheck && !controller.state().schedule.checking);
  const { schedule } = controller.state();
  assert.equal(schedule.nextCheck - schedule.lastCheck, 5 * 60000);
  assert.ok(states.some((s) => s.schedule.checking), 'a running check is shown live');
  assert.equal((await controller.configure({ intervalMinutes: 30 })).ok, true);
  await waitFor(() => !controller.state().schedule.checking && controller.state().schedule.nextCheck - controller.state().schedule.lastCheck === 30 * 60000);
  assert.equal((await controller.configure({ intervalMinutes: 7 })).state.intervalMinutes, 2, 'only the offered intervals; otherwise the default');
});

test('a watch error on a network share falls back to polling and says so', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  const realWatch = fs.watch;
  let emitError = null;
  fs.watch = (...args) => {
    const w = realWatch(...args);
    emitError = () => w.emit('error', Object.assign(new Error('UNKNOWN: unknown error, watch'), { code: 'UNKNOWN' }));
    return w;
  };
  t.after(() => { fs.watch = realWatch; });
  const controller = createSyncController({ userData: path.join(root, 'local') });
  t.after(() => controller.stop());
  const preview = await controller.previewConnect({ folder: cloud });
  assert.equal((await controller.applyConnect({ previewId: preview.pending.previewId })).ok, true);
  await waitFor(() => controller.state().schedule.watch === 'watching');
  emitError();
  assert.equal(controller.state().schedule.watch, 'polling');
  assert.ok(controller.state().schedule.nextCheck, 'polling continues');
});

test('comparison items carry their widget group and which side is newer for bulk choices', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-bulk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  const make = (id, items) => {
    const controller = createSyncController({ userData: path.join(root, id), widgetList: () => [{ id: 'todo', name: '할 일' }] });
    controller.manager.register({ name: 'todo-todo', widgetId: 'todo', read: () => ({ ...items }), apply: () => {} });
    t.after(() => controller.stop());
    return controller;
  };
  const first = make('first', {
    'todo/tasks/a': { id: 'a', title: 'A1', updatedAt: 2000 },
    'todo/tasks/b': { id: 'b', title: 'B1', updatedAt: 1000 },
  });
  const p1 = await first.previewConnect({ folder: cloud, widgets: { todo: true } });
  await first.applyConnect({ previewId: p1.pending.previewId });
  const second = make('second', {
    'todo/tasks/a': { id: 'a', title: 'A2', updatedAt: 1000 },
    'todo/tasks/b': { id: 'b', title: 'B2', updatedAt: 3000 },
  });
  const p2 = await second.previewConnect({ folder: cloud, widgets: { todo: true } });
  const byKey = Object.fromEntries(p2.pending.changes.map((c) => [c.key, c]));
  assert.equal(byKey['todo/tasks/a'].newer, 'remote');
  assert.equal(byKey['todo/tasks/b'].newer, 'local');
  assert.equal(byKey['todo/tasks/a'].group, 'todo');
  assert.equal(byKey['todo/tasks/a'].groupName, '할 일');
  // "All newest" is just one choice per key; the engine applies it like individual choices.
  const res = await second.applyConnect({ previewId: p2.pending.previewId, resolutions: { 'todo/tasks/a': 'remote', 'todo/tasks/b': 'local' } });
  assert.equal(res.ok, true);
});

test('a conflict waiting for review does not stop other items (and notes) from arriving', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-held-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  const make = (id) => {
    const items = {};
    const controller = createSyncController({ userData: path.join(root, id), widgetList: () => [{ id: 'todo', name: 'Tasks' }] });
    controller.manager.register({
      name: 'todo-todo', widgetId: 'todo', read: () => ({ ...items }),
      apply: (changes) => { for (const c of changes) { if (c.deleted) delete items[c.key]; else items[c.key] = c.value; } },
    });
    t.after(() => controller.stop());
    return { controller, items };
  };
  const a = make('a');
  const b = make('b');
  a.items['todo/tasks/same'] = { id: 'same', title: 'base' };
  for (const pc of [a, b]) {
    const p = await pc.controller.previewConnect({ folder: cloud, widgets: { todo: true } });
    assert.equal((await pc.controller.applyConnect({ previewId: p.pending.previewId, resolutions: {} })).ok, true);
  }
  a.items['todo/tasks/same'] = { id: 'same', title: 'A edit' };
  b.items['todo/tasks/same'] = { id: 'same', title: 'B edit' };
  a.items['todo/tasks/new'] = { id: 'new', title: 'Made on A' };
  await a.controller.syncNow();
  const first = await b.controller.syncNow();
  assert.deepEqual(first.pending.changes.filter((c) => c.kind === 'conflict').map((c) => c.key), ['todo/tasks/same']);
  assert.deepEqual(b.items['todo/tasks/new'], { id: 'new', title: 'Made on A' }, 'the other item arrived');
  // While the user has not answered, later changes keep arriving and the review stays the same.
  a.items['todo/tasks/later'] = { id: 'later', title: 'Later on A' };
  await a.controller.syncNow();
  const second = await b.controller.syncNow();
  assert.equal(second.pending.previewId, first.pending.previewId);
  assert.ok(b.items['todo/tasks/later']);
  assert.equal(b.items['todo/tasks/same'].title, 'B edit', 'the conflicting item is held');
  assert.equal((await b.controller.resolve({ previewId: first.pending.previewId, resolutions: { 'todo/tasks/same': 'remote' } })).ok, true);
  assert.equal(b.items['todo/tasks/same'].title, 'A edit');
});

async function waitFor(cond) {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a file store whose folder changed is reported in the sync tab notices', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sync-relocated-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  const controller = createSyncController({ userData: path.join(root, 'local'), widgetList: () => [{ id: 'memo', name: 'Notes' }] });
  t.after(() => controller.stop());
  let where = 'c:\notes-a';
  controller.manager.register({ name: 'memo-notes', widgetId: 'memo', read: () => ({}), apply: () => {}, location: () => where });
  const preview = await controller.previewConnect({ folder: cloud, widgets: { memo: true } });
  assert.equal((await controller.applyConnect({ previewId: preview.pending.previewId })).ok, true);
  assert.deepEqual(controller.state().notices, []);
  where = 'c:\notes-b';
  await controller.syncNow();
  assert.match(controller.state().notices.join(' '), /memo-notes/);
});
