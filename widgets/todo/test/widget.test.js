const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpec, sharedPart } = require('../../../engine/main/sync-store');
const { create } = require('../index');
const M = require('../lib/model');
const { normalizeMethods, dispatch } = require('../../../engine/main/theme-calls');
const { createRegistry } = require('../../../engine/main/theme-registry');
const fs = require('node:fs');
const path = require('node:path');

function setup(initial = {}, locale = 'ko-KR', integrations = null) {
  let state = M.sanitize({ ...M.DEFAULTS, ...initial });
  let spec;
  let storeSync;
  const events = [];
  const cards = [];
  const host = {
    open() {}, close() {}, focus: () => true, desktopWindows: () => [],
    emit: (...args) => events.push(args), setPinned(on) { state = M.sanitize({ ...state, alwaysOnTop: on }); },
    reload() {}, applyBackground() {}, setLiveOpacity() {},
    settingsHandlers: () => ({ themes: () => [], previewTheme() {}, openThemeFolder() {}, liveOpacity() {} }),
  };
  const ctx = {
    dir: `${__dirname}/..`, dataDir: '/unused', app: { locale: () => locale },
    createStore: (options) => {
      storeSync = options.sync;
      return { load: () => state, save: (patch) => { state = M.sanitize({ ...state, ...patch }); return state; } };
    },
    useThemes(options) { spec = options; return host; },
    notify: (items, options) => cards.push({ items, options }),
    integrations,
  };
  const widget = create(ctx);
  const call = (name, args = [], preview = false) => dispatch(normalizeMethods(spec.methods), name, args,
    { frame: 'main', instanceId: null, preview, theme: { id: 'default', features: ['lists'] } }, { activated: true });
  return { widget, call, cards, events, get: () => state, spec, storeSync };
}

test('sync shares tasks and lists but keeps integration consent and window state on this PC', () => {
  const { storeSync } = setup();
  assert.deepEqual(storeSync.collections.lists, { id: 'id' });
  assert.equal(storeSync.collections.tasks.id, 'id');
  const projected = sharedPart({ id: 'one', title: 'Task', remindedFor: 'today', snoozedUntil: 'later' }, normalizeSpec(storeSync).collections.tasks);
  assert.deepEqual(projected, { id: 'one', title: 'Task' });
  assert.ok(storeSync.shared.includes('snoozeMinutes'));
  for (const key of ['receiveDooray', 'receiveMail', 'shareCalendar', 'alwaysOnTop', 'selectedListId']) {
    assert.ok(!storeSync.shared.includes(key), key);
  }
});

test('theme calls add, sort, complete, and persist tasks in separate lists', async (t) => {
  const h = setup(); h.widget.start(); t.after(() => h.widget.stop());
  assert.equal(h.spec.contractVersions[0], 1);
  assert.equal((await h.call('tasks.add', ['첫째 내일 3시'])).ok, true);
  assert.equal((await h.call('lists.add', ['할 일'])).ok, false, 'default list has a localized visible name');
  assert.equal((await h.call('tasks.add', ['둘째'])).ok, true);
  const [first, second] = h.get().tasks;
  assert.equal(first.title, '첫째');
  await h.call('tasks.reorder', [second.id, first.id]);
  assert.deepEqual(h.get().tasks.map((item) => item.title), ['둘째', '첫째']);
  await h.call('tasks.toggle', [second.id]);
  assert.ok(h.get().tasks[0].completedAt);
  const list = await h.call('lists.add', ['별도']);
  assert.equal(list.ok, true);
  assert.equal((await h.call('tasks.add', ['세 번째'])).ok, true);
  assert.equal(h.get().tasks.at(-1).listId, h.get().selectedListId);
  assert.equal((await h.call('lists.remove', ['inbox'])).ok, true);
  assert.equal(h.get().tasks.length, 1, 'removing a list removes only its own tasks');
  assert.ok(h.events.some(([name]) => name === 'state'));
});

test('external sources require opt-in, preserve identity, and avoid duplicate tasks', async (t) => {
  const handlers = new Map();
  const published = [];
  const integrations = { expose: (name, fn) => handlers.set(name, fn), publish: (...args) => published.push(args),
    status: () => ({ installed: true, enabled: true, running: true, brokerAvailable: true,
      capabilities: ['todo-add-source'], engineVersion: '1.0.4', engineApi: '1.6' }), call() {} };
  const h = setup({}, 'ko-KR', integrations); h.widget.start(); t.after(() => h.widget.stop());
  const input = { title: '확인 내일', source: { widgetId: 'dooray', itemId: 'post-123', url: 'https://dooray.example/post/123' },
    dueAt: Date.now() + 60_000, dateOnly: false };
  assert.equal(handlers.get('tasks.addExternal')(input, { sourceId: 'dooray' }).ok, false);
  h.widget.settings.save({ receiveDooray: true });
  assert.equal(handlers.get('tasks.addExternal')(input, { sourceId: 'mail' }).ok, false);
  const created = handlers.get('tasks.addExternal')(input, { sourceId: 'dooray' });
  assert.equal(created.ok, true);
  assert.equal(created.result.existing, false);
  assert.equal(h.get().tasks[0].title, '확인 내일', 'source text is not parsed as a quick-entry date');
  assert.equal(h.get().tasks[0].source.itemId, 'post-123');
  const repeated = handlers.get('tasks.addExternal')(input, { sourceId: 'dooray' });
  assert.equal(repeated.result.existing, true);
  assert.equal(h.get().tasks.length, 1);
  assert.ok(published.some(([event]) => event === 'tasks.changed'));
});

test('calendar gets a snapshot and edits the Todo source only when sharing is on', async (t) => {
  const handlers = new Map();
  const published = [];
  const integrations = { expose: (name, fn) => handlers.set(name, fn), publish: (...args) => published.push(args),
    status: () => ({ installed: true, enabled: true, running: true, brokerAvailable: true,
      capabilities: ['todo-calendar-view'], engineVersion: '1.0.4', engineApi: '1.6' }), call() {} };
  const h = setup({}, 'ko-KR', integrations); h.widget.start(); t.after(() => h.widget.stop());
  await h.call('tasks.add', ['일정 내일']);
  const taskId = h.get().tasks[0].id;
  assert.equal(handlers.get('tasks.snapshot')({}, { sourceId: 'calendar' }).ok, false);
  h.widget.settings.save({ shareCalendar: true });
  const snapshot = handlers.get('tasks.snapshot')({}, { sourceId: 'calendar' });
  assert.equal(snapshot.result.tasks[0].id, taskId);
  const oldDue = snapshot.result.tasks[0].dueAt;
  const newDue = oldDue + 86_400_000;
  assert.equal(handlers.get('tasks.updateDue')({ taskId, dueAt: newDue, dateOnly: true }, { sourceId: 'mail' }).ok, false);
  assert.equal(handlers.get('tasks.updateDue')({ taskId, dueAt: newDue, dateOnly: true }, { sourceId: 'calendar' }).ok, true);
  assert.equal(h.get().tasks[0].dueAt, newDue);
  assert.equal(handlers.get('tasks.snapshot')({}, { sourceId: 'calendar' }).result.tasks[0].dueAt, newDue);
  assert.ok(published.some(([event]) => event === 'tasks.changed'));
  h.widget.settings.save({ shareCalendar: false });
  assert.equal(handlers.get('tasks.snapshot')({}, { sourceId: 'calendar' }).ok, false);
  assert.equal(h.get().tasks.length, 1, 'turning off sharing preserves the saved task');
});

test('due reminder is sent once, can snooze, and never runs in a preview', async (t) => {
  const dueAt = Date.now() - 2000;
  const task = { id: 'due-one', listId: 'inbox', title: '알림 확인', dueAt, dateOnly: false,
    repeatWeekday: null, completedAt: null, remindedFor: null, snoozedUntil: null, createdAt: dueAt - 1000 };
  const h = setup({ tasks: [task] }); h.widget.start(); t.after(() => h.widget.stop());
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].items[0].body, task.title);
  assert.equal(h.get().tasks[0].remindedFor, dueAt);
  assert.equal(await h.call('tasks.remove', [task.id], true), null, 'preview writes are no-ops');
  h.cards[0].options.onAction(null, 'snooze');
  assert.ok(h.get().tasks[0].snoozedUntil > Date.now());
  assert.equal(h.get().tasks[0].remindedFor, null);
  assert.equal(h.cards.length, 1, 'snoozed task waits for its new time');
});

test('packaged theme manifest and page assets resolve through the engine registry', async () => {
  const root = path.join(__dirname, '..');
  const reg = createRegistry({ widgetId: 'todo', builtinDir: path.join(root, 'themes'), userDir: path.join(root, '.no-user-themes'),
    kitDir: path.join(root, 'kit'), defaultTheme: 'default', contractVersions: [1], frames: { main: { width: 360, height: 480 } } });
  const theme = reg.listThemes()[0];
  assert.equal(theme.usable, true, theme.errors.join(', '));
  assert.equal(theme.widget, 'todo');
  const page = await reg.resolveFile('widget-theme://default.todo/index.html');
  assert.ok(page);
  const html = fs.readFileSync(page.file, 'utf8');
  for (const ref of [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1])) {
    assert.ok(await reg.resolveFile(`widget-theme://default.todo/${ref}`), ref);
  }
});
