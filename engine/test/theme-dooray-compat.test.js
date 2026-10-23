// Dooray themes on the per-widget theme host (#58): what a Dooray theme (built-in or third-party) sees must be
// exactly what it saw before #57 — window.dooray, its channels, dooray-theme://, the session, the window save keys
// and the theme list.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const stub = require('./helpers/theme-electron');

stub.install();
const { createRegistry } = require('../main/theme-registry');
const { ThemeHost, LEGACY_CHANNELS } = require('../main/theme-host');

const DOORAY_THEMES = path.join(__dirname, '..', '..', 'widgets', 'dooray', 'themes');
const PRELOAD = path.join(__dirname, '..', 'preload', 'theme.js');
// Recorded with the engine before #57 (commit 563ffe2): themes.listThemes() on the built-in Dooray themes.
const BEFORE = require('./fixtures/dooray-themes-before-57.json');

/** The shape of an exposed API: function names, nested objects, constant values. */
function shape(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'function' ? 'function' : v && typeof v === 'object' ? shape(v) : v]));
}

test('window.dooray: existing names and channels plus the opt-in Todo action', async () => {
  const page = stub.runPreload(PRELOAD);
  assert.deepEqual(Object.keys(page.exposed), ['dooray']);
  const api = page.exposed.dooray;
  assert.deepEqual(shape(api), {
    apiVersion: 1,
    getContext: 'function',
    getSnapshot: 'function',
    onSnapshot: 'function',
    onBackground: 'function',
    refresh: 'function',
    openUrl: 'function',
    openSettings: 'function',
    openProjectWidget: 'function',
    setProjectOrder: 'function',
    openCategoryManager: 'function',
    addToTodo: 'function',
    categories: { create: 'function', update: 'function', move: 'function', remove: 'function', setTaskCategories: 'function', removeClosed: 'function' },
    window: { close: 'function', togglePin: 'function', getState: 'function', setSize: 'function' },
  });

  const channels = [];
  const record = async (fn) => {
    await fn();
    channels.push(page.invoked.at(-1)[0]);
  };
  page.setActive(true);
  for (const fn of [
    () => api.getContext(),
    () => api.getSnapshot(),
    () => api.refresh(),
    () => api.openUrl('https://x.dooray.com/'),
    () => api.openSettings(),
    () => api.openProjectWidget('1'),
    () => api.setProjectOrder(['1']),
    () => api.openCategoryManager('c'),
    () => api.addToTodo('task-1'),
    () => api.categories.create({ name: 'a' }),
    () => api.window.close(),
    () => api.window.togglePin(),
    () => api.window.getState(),
    () => api.window.setSize(10, 10),
  ]) {
    await record(fn);
  }
  page.setActive(false);
  const count = page.invoked.length;
  assert.equal((await api.addToTodo('task-2')).ok, false);
  assert.equal(page.invoked.length, count, 'a theme cannot request an import without a user gesture');
  assert.deepEqual(channels, [
    'theme:get-context',
    'theme:get-snapshot',
    'theme:refresh',
    'theme:open-url',
    'theme:open-settings',
    'theme:open-project',
    'theme:set-project-order',
    'theme:open-category-manager',
    'theme:add-to-todo',
    'theme:categories',
    'theme:window-close',
    'theme:window-toggle-pin',
    'theme:window-state',
    'theme:window-set-size',
  ]);
  // Every channel the page uses is answered by the engine (registered once the host exists).
  new ThemeHost({ store: { load: () => ({ projectWidgets: [] }), save() {} }, builtinDir: DOORAY_THEMES, userDir: null, api: {}, openSettings() {}, onQuitRequest() {} });
  for (const c of channels) assert.ok(stub.ipcHandlers.has(c), c);
  assert.deepEqual([...channels].sort(), [...LEGACY_CHANNELS].sort());
  // Events the page listens to keep their names.
  api.onSnapshot(() => {});
  api.onBackground(() => {});
  assert.deepEqual(page.listeners.map(([c]) => c), ['theme:snapshot', 'theme:background']);
});

test('the Dooray theme list is the same as before #57 (ids, layouts, sizes, background, errors)', () => {
  const registry = createRegistry({ legacy: true, builtinDir: DOORAY_THEMES, userDir: null });
  const now = registry.listThemes().map(({ source, ...t }) => t);
  assert.deepEqual(now, BEFORE);
  assert.equal(now.length, 10);
  assert.ok(now.every((t) => t.usable));
  assert.deepEqual(Object.fromEntries(now.map((t) => [t.id, t.layout])), {
    glass: 'glass',
    mono: 'glass',
    agenda: 'agenda',
    board: 'board',
    bigsur: 'glass',
    minibar: 'minibar',
    midnight: 'glass',
    sunset: 'glass',
    sidebar: 'sidebar',
    paper: 'paper',
  });
});

test('dooray-theme://<id>/ and the "dooray-theme" session', async () => {
  const registry = createRegistry({ legacy: true, builtinDir: DOORAY_THEMES, userDir: null });
  assert.equal(registry.scheme, 'dooray-theme');
  assert.equal(registry.partition, 'dooray-theme');
  assert.equal(registry.defaultTheme, 'glass');
  for (const t of registry.listThemes()) assert.equal(registry.themeUrl(registry.getTheme(t.id)), `dooray-theme://${t.id}/index.html`);
  assert.equal(registry.resolveTheme('missing').id, 'glass');
  // A color skin still reads glass's files (extends), and nothing outside the theme folders.
  assert.ok((await registry.resolveFile('dooray-theme://midnight/app.js')).file.endsWith(path.join('glass', 'app.js')));
  assert.ok((await registry.resolveFile('dooray-theme://midnight/style.css')).file.endsWith(path.join('midnight', 'style.css')));
  assert.equal(await registry.resolveFile('dooray-theme://midnight/%2e%2e/%2e%2e/widget.json'), null);
});

function storeOf(initial) {
  let s = { themeId: 'glass', alwaysOnTop: false, windowBounds: {}, projectWidgets: [], themeOpacity: {}, ...initial };
  return { load: () => s, save: (p) => (s = { ...s, ...p }) };
}

function doorayHost(initial, api = {}) {
  const store = storeOf(initial);
  const calls = [];
  const host = new ThemeHost({
    store,
    builtinDir: DOORAY_THEMES,
    userDir: null,
    api,
    openSettings: () => calls.push('settings'),
    onQuitRequest: () => calls.push('quit'),
  });
  return { host, store, calls };
}

test('Dooray windows: same URL, session, preload, sizes and save keys', async () => {
  for (const [themeId, prefix, width] of [
    ['glass', '', 380],
    ['bigsur', '', 380],
    ['board', 'board/', 940],
    ['minibar', 'minibar/', 560],
  ]) {
    const { host, store } = doorayHost({ themeId, projectWidgets: [{ projectId: '123', pinned: true }] });
    const before = stub.windows.length;
    host.open();
    const [overview, project] = stub.windows.slice(before);
    assert.equal(stub.windows.length - before, 2);
    assert.equal(overview.webContents.url, `dooray-theme://${themeId}/index.html`);
    assert.equal(project.webContents.url, `dooray-theme://${themeId}/index.html`);
    const prefs = overview.options.webPreferences;
    assert.equal(prefs.partition, 'dooray-theme');
    assert.ok(prefs.preload.endsWith(path.join('preload', 'theme.js')));
    assert.equal(prefs.additionalArguments, undefined);
    assert.equal(overview.options.width, width);
    assert.equal(project.options.alwaysOnTop, true, 'a pinned project widget');

    // Moving a window saves under the original keys.
    overview.setBounds({ x: 5, y: 6 });
    project.setBounds({ x: 7, y: 8 });
    overview.emit('moved');
    project.emit('moved');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(Object.keys(store.load().windowBounds).sort(), [`${prefix}overview`, `${prefix}project:123`].sort());
    assert.equal(store.load().themeBounds, undefined, 'no keys of the new kind');
    host.close();
    assert.deepEqual(store.load().projectWidgets, [{ projectId: '123', pinned: true }], 'closing the widget keeps project widgets');
  }
});

test('Dooray calls: context, data calls, project widgets, pin and close behave as before', async () => {
  const seen = [];
  const { host, store, calls } = doorayHost(
    {},
    {
      getSnapshot: (entry) => ({ mode: entry.mode, preview: Boolean(entry.preview) }),
      categories: (entry, action, payload) => seen.push([action, payload]) && { ok: true },
    }
  );
  host.open();
  const overview = stub.windows.at(-1).webContents;
  assert.deepEqual(await stub.invoke('theme:get-context', overview), {
    mode: 'overview',
    projectId: null,
    theme: { id: 'glass', name: '다크 글래스', version: '1.0.0' },
    background: { opacity: 0.62 },
    locale: 'ko-KR',
  });
  assert.deepEqual(await stub.invoke('theme:get-snapshot', overview), { mode: 'overview', preview: false });
  assert.equal(await stub.invoke('theme:refresh', overview), null, 'a call the widget does not provide resolves to null');
  assert.deepEqual(await stub.invoke('theme:categories', overview, 'create', { name: 'a' }), { ok: true });
  assert.deepEqual(seen, [['create', { name: 'a' }]]);
  // Dooray pages cannot reach the new API.
  await assert.rejects(async () => stub.invoke('widget-theme:call', overview, 'getSnapshot', []), /Not a widget theme window/);

  await stub.invoke('theme:open-project', overview, '../bad');
  await stub.invoke('theme:open-project', overview, '42');
  assert.deepEqual(store.load().projectWidgets, [{ projectId: '42', pinned: false }]);
  const project = stub.windows.at(-1).webContents;
  assert.deepEqual((await stub.invoke('theme:get-context', project)).projectId, '42');
  assert.equal(await stub.invoke('theme:window-toggle-pin', project), true);
  assert.deepEqual(store.load().projectWidgets, [{ projectId: '42', pinned: true }]);
  assert.deepEqual(await stub.invoke('theme:window-state', project), { pinned: true });
  await stub.invoke('theme:window-close', project);
  assert.deepEqual(store.load().projectWidgets, [], 'closing a project widget forgets it');
  await stub.invoke('theme:window-close', overview);
  await stub.invoke('theme:open-settings', overview);
  assert.deepEqual(calls, ['quit', 'settings']);
  host.close();
});

test('Dooray and another widget\'s host side by side do not mix', async () => {
  const { host: dooray } = doorayHost({}, { getSnapshot: () => 'dooray data' });
  const clockCalls = [];
  const clock = new ThemeHost({
    widgetId: 'clock',
    store: { load: () => ({ themeFrames: [] }), save() {} },
    builtinDir: path.join(__dirname, 'no-such-dir'),
    userDir: null,
    methods: { getState: () => clockCalls.push('clock') },
    events: [],
    openSettings() {},
    onQuitRequest() {},
  });
  dooray.open();
  const page = stub.windows.at(-1).webContents;
  assert.equal(await stub.invoke('theme:get-snapshot', page), 'dooray data');
  assert.deepEqual(clockCalls, []);
  assert.deepEqual(dooray.settingsHandlers().themes().length, 10);
  assert.deepEqual(clock.settingsHandlers().themes(), []);
  assert.equal(clock.registry.partition, 'widget-theme-clock');
  assert.equal(dooray.registry.partition, 'dooray-theme');
  // broadcast (Dooray) keeps its channel and payload.
  dooray.broadcast('theme:snapshot', { n: 1 });
  assert.deepEqual(page.sent.filter(([c]) => c === 'theme:snapshot'), [['theme:snapshot', { n: 1 }]]);
  dooray.close();
});

test('Dooray preview: kinds named after glass, theme size from "overview"', () => {
  const { host } = doorayHost({});
  const preview = host.preview;
  preview.list = host.registry.listThemes().filter((t) => t.usable);
  const kindOf = (id) => {
    preview.index = preview.list.findIndex((t) => t.id === id);
    return preview.state().theme.kind;
  };
  assert.equal(kindOf('glass'), '기본 테마');
  assert.equal(kindOf('midnight'), '기본 구성 · 색만 다름');
  assert.equal(kindOf('board'), '화면 구성이 다른 테마');
  assert.deepEqual(preview.frameSize(host.registry.getTheme('board')), { width: 940, height: 580, minWidth: 600, minHeight: 360 });
});
