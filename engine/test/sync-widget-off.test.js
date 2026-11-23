// #134: a widget whose sync checkbox is off on a PC exchanges nothing there: not its settings (theme choice),
// not its items, not its note files; in neither direction, also when another PC still has it on. Two simulated
// PCs with real engine stores and controllers, every widget of the sync tab.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSyncController, DEFAULT_WIDGETS } = require('../main/sync-controller');
const { createStore } = require('../main/store');
const { createSyncStore } = require('../main/sync-store');
const { openFileStore } = require('../main/files-store');

const WIDGETS = Object.keys(DEFAULT_WIDGETS).filter((id) => id !== 'engine');
const ALL_ON = Object.fromEntries(WIDGETS.map((id) => [id, true]));

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-widget-off-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'cloud');
  fs.mkdirSync(cloud);
  function pc(label) {
    const userData = path.join(root, label);
    const controller = createSyncController({ userData, widgetList: () => WIDGETS.map((id) => ({ id, name: id })) });
    t.after(() => controller.stop());
    const stores = {};
    const notes = {};
    for (const id of WIDGETS) {
      // Like the calendar: shared settings (the theme choice) and a shared collection.
      stores[id] = createSyncStore({ createStore, manager: controller.manager, widgetId: id, options: {
        file: path.join(userData, 'widgets', id, 'settings.json'), defaults: { themeId: 'default', themeOpacity: {}, items: [] },
        sync: { name: 'settings', shared: ['themeId', 'themeOpacity'], collections: { items: { id: 'id' } } },
      } });
      const dir = path.join(userData, 'notes', id);
      const files = openFileStore(controller.manager, id, { name: 'notes', dir: () => dir, include: (rel) => /^[^/]+\.md$/.test(rel), idOf: (rel) => rel, maxFileBytes: 1024 * 1024 });
      t.after(files.close);
      notes[id] = files.handle;
    }
    return { label, controller, stores, notes };
  }
  async function connect(p, widgets = ALL_ON) {
    const review = await p.controller.previewConnect({ folder: cloud, deviceName: p.label, widgets });
    assert.equal(review.ok, true, review.message);
    const applied = await p.controller.applyConnect({ previewId: review.pending.previewId, resolutions: {} });
    assert.equal(applied.ok, true, applied.message);
  }
  async function edit(p, id, tag) {
    p.stores[id].save({ themeId: `theme-${tag}`, themeOpacity: { [`theme-${tag}`]: 40 }, items: [...p.stores[id].load().items, { id: `item-${tag}`, title: tag }] });
    await p.notes[id].write(`${tag}.md`, `note ${tag}\n`);
  }
  async function has(p, id, tag) {
    const s = p.stores[id].load();
    return {
      theme: s.themeId === `theme-${tag}`,
      opacity: Object.hasOwn(s.themeOpacity, `theme-${tag}`),
      item: s.items.some((item) => item.id === `item-${tag}`),
      note: (await p.notes[id].list()).includes(`${tag}.md`),
    };
  }
  const nothing = { theme: false, opacity: false, item: false, note: false };
  const everything = { theme: true, opacity: true, item: true, note: true };
  return { cloud, pc, connect, edit, has, nothing, everything };
}

for (const off of WIDGETS) {
  test(`${off}: turned off on one PC, nothing of it crosses in either direction; the other widgets keep syncing`, async (t) => {
    const w = world(t);
    const a = w.pc('a');
    const b = w.pc('b');
    await w.connect(a);
    await w.connect(b);
    const other = WIDGETS.find((id) => id !== off);
    // Before: the widget syncs.
    await w.edit(a, off, 'before');
    await a.controller.syncNow();
    await b.controller.syncNow();
    assert.deepEqual(await w.has(b, off, 'before'), w.everything);

    // A turns the widget off (only A; B keeps it on and keeps publishing).
    const saved = await a.controller.configure({ widgets: { ...ALL_ON, [off]: false } });
    assert.equal(saved.ok, true, saved.message);
    assert.equal(saved.state.widgets.find((item) => item.id === off).enabled, false);

    await w.edit(b, off, 'from-b');
    await w.edit(a, off, 'from-a');
    await w.edit(b, other, 'other-b');
    for (let round = 0; round < 2; round++) {
      await b.controller.syncNow();
      await a.controller.syncNow();
    }
    assert.deepEqual(await w.has(a, off, 'from-b'), w.nothing, 'B\'s theme choice, items and notes do not reach A');
    assert.deepEqual(await w.has(b, off, 'from-a'), w.nothing, 'A\'s theme choice, items and notes do not reach B');
    assert.deepEqual(await w.has(a, other, 'other-b'), w.everything, 'other widgets keep syncing');
    // A's published state of the widget stays as it was when it was turned off.
    const published = JSON.stringify(fs.readdirSync(path.join(w.cloud, 'state')).map((device) => fs.readdirSync(path.join(w.cloud, 'state', device))
      .filter((file) => file.startsWith(`${off}-`)).map((file) => fs.readFileSync(path.join(w.cloud, 'state', device, file), 'utf8'))));
    assert.doesNotMatch(published, /from-a/);
  });
}

test('a conflict answered before turning the widget off cannot be undone afterward, and is not listed', async (t) => {
  const w = world(t);
  const a = w.pc('a');
  const b = w.pc('b');
  await w.connect(a);
  await w.connect(b);
  a.stores.calendar.save({ themeId: 'paper' });
  await a.controller.syncNow();
  await b.controller.syncNow();
  a.stores.calendar.save({ themeId: 'dark' });
  b.stores.calendar.save({ themeId: 'light' });
  await a.controller.syncNow();
  const review = await b.controller.syncNow();
  const key = 'calendar/@settings/themeId';
  assert.ok(review.pending.changes.some((change) => change.key === key && change.kind === 'conflict'));
  assert.equal((await b.controller.resolve({ previewId: review.pending.previewId, resolutions: { [key]: 'remote' } })).ok, true);
  assert.equal(b.stores.calendar.load().themeId, 'dark');
  const listed = await b.controller.listUndo();
  const entry = listed.items.find((item) => item.key === key);
  assert.ok(entry);

  assert.equal((await b.controller.configure({ widgets: { ...ALL_ON, calendar: false } })).ok, true);
  assert.equal((await b.controller.listUndo()).items.some((item) => item.key === key), false, 'not offered while off');
  const undone = await b.controller.undo({ id: entry.id });
  assert.equal(undone.ok, false);
  assert.equal(b.stores.calendar.load().themeId, 'dark', 'the old value is not restored');
  await assert.rejects(b.controller.manager.undo(entry.id), /turned off/);
});

test('an engine-only setting is grouped as the engine, not as a widget', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-widget-off-group-'));
  try {
    const controller = createSyncController({ userData: root, widgetList: () => [{ id: 'calendar', name: 'calendar' }] });
    controller.manager.register({ name: 'engine', read: () => ({}), apply: () => {} });
    controller.manager.register({ name: 'calendar-settings', widgetId: 'calendar', read: () => ({}), apply: () => {} });
    const widgets = controller.state().widgets;
    assert.deepEqual(widgets.map(({ id, available }) => [id, available]), [['engine', true], ['calendar', true]]);
    controller.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
