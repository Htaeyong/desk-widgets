// Theme host per widget (#57): theme.json for a widget's own contract, per-widget registries and URLs,
// the declared-calls-only theme API (window.widget) and the window save keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stub = require('./helpers/theme-electron');

stub.install();
const { validateManifest } = require('../main/theme-manifest');
const { createRegistry, partitionFor } = require('../main/theme-registry');
const { normalizeMethods, normalizeEvents, dispatch, MAX_ARGS_BYTES } = require('../main/theme-calls');
const { boundsKeyOf } = require('../main/windows');
const { ThemeHost } = require('../main/theme-host');

const DOORAY_THEMES = path.join(__dirname, '..', '..', 'widgets', 'dooray', 'themes');
const PRELOAD = path.join(__dirname, '..', 'preload', 'widget-theme.js');

const CLOCK_FRAMES = { main: { width: 220, height: 96, minWidth: 140, minHeight: 64, variants: { tools: { width: 260, height: 200, minWidth: 220, minHeight: 180 } } } };
const clockOpts = { widgetId: 'clock', contractVersions: [1], frames: CLOCK_FRAMES };
const base = { id: 'face', name: 'Face', version: '1.0.0', contractVersion: 1 };

// --- a temporary widget package with themes ---
function writeTheme(root, id, json, files = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ id, name: id, version: '1.0.0', contractVersion: 1, ...json }));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function clockPackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-theme-'));
  const builtin = path.join(root, 'themes');
  const user = path.join(root, 'user');
  const kit = path.join(root, 'kit');
  fs.mkdirSync(kit, { recursive: true });
  fs.writeFileSync(path.join(kit, 'timer-model.js'), '// kit');
  fs.writeFileSync(path.join(kit, 'style.css'), '/* kit style */');
  writeTheme(builtin, 'dark-glass', { widget: 'clock', window: { main: { width: 230 } }, features: ['tools', 'Bad Name', 'tools'] }, { 'index.html': '<p>clock</p>', 'style.css': 'x' });
  writeTheme(builtin, 'light', { widget: 'clock', extends: 'dark-glass' }, { 'style.css': 'light' });
  writeTheme(builtin, 'analog', { widget: 'clock', extends: 'dark-glass' }, { 'index.html': '<p>analog</p>' });
  writeTheme(builtin, 'glass-copy', {}, { 'index.html': 'dooray theme in the clock folder' });
  writeTheme(user, 'light', { widget: 'clock', extends: 'dark-glass', name: 'My light' }, { 'style.css': 'mine' });
  return { root, builtin, user, kit };
}

test('theme.json for a widget contract: widget field, versions, frames with variants, features', () => {
  const r = validateManifest({ ...base, widget: 'clock', window: { main: { width: 200 }, 'main+tools': { height: 300 } }, features: ['tools', 'x y', 'tools', 3] }, 'face', clockOpts);
  assert.deepEqual(r.errors, []);
  assert.equal(r.compatible, true);
  assert.equal(r.manifest.widget, 'clock');
  assert.deepEqual(r.manifest.features, ['tools']);
  assert.deepEqual(r.manifest.window.main, { width: 200, height: 96, minWidth: 140, minHeight: 64 });
  // A variant the theme sizes partly takes the rest from the widget's default for that variant.
  assert.deepEqual(r.manifest.window['main+tools'], { width: 260, height: 300, minWidth: 220, minHeight: 180 });
  assert.equal(r.manifest.window.overview, undefined);

  // Another widget's theme, a missing widget field (= Dooray), an unsupported version.
  assert.deepEqual(validateManifest({ ...base, widget: 'calendar' }, undefined, clockOpts).errors, ['theme for another widget ("calendar")']);
  assert.deepEqual(validateManifest(base, undefined, clockOpts).errors, ['theme for another widget ("dooray")']);
  const v2 = validateManifest({ ...base, widget: 'clock', contractVersion: 2 }, undefined, clockOpts);
  assert.equal(v2.compatible, false);
  assert.match(v2.errors[0], /contractVersion 2 is not supported/);
  assert.equal(validateManifest({ ...base, widget: 'clock', contractVersion: 2 }, undefined, { ...clockOpts, contractVersions: [1, 2] }).compatible, true);
  assert.deepEqual(validateManifest({ ...base, widget: 'Clock!' }, undefined, clockOpts).errors[0], 'widget must be a widget id');
});

test('Dooray theme.json is read exactly as before: no new fields, a clock theme is not usable there', () => {
  const r = validateManifest({ ...base, window: { overview: { width: 400 } } }, 'face');
  assert.deepEqual(Object.keys(r.manifest), ['id', 'name', 'version', 'author', 'description', 'contractVersion', 'entry', 'extends', 'background', 'window']);
  assert.deepEqual(Object.keys(r.manifest.window), ['transparent', 'material', 'overview', 'project']);
  assert.equal(r.compatible, true);
  assert.equal(validateManifest({ ...base, widget: 'dooray' }).compatible, true);
  const clockTheme = validateManifest({ ...base, widget: 'clock' });
  assert.equal(clockTheme.compatible, false);
  assert.deepEqual(clockTheme.errors, ['theme for another widget ("clock")']);
});

test('registries: one per widget, user folder wins, kit is the last base, other widgets\' themes are not usable', () => {
  const pkg = clockPackage();
  const clock = createRegistry({ widgetId: 'clock', builtinDir: pkg.builtin, userDir: pkg.user, kitDir: pkg.kit, defaultTheme: 'dark-glass', frames: CLOCK_FRAMES });
  const dooray = createRegistry({ legacy: true, builtinDir: DOORAY_THEMES, userDir: null });
  const list = clock.listThemes();
  assert.deepEqual(list.map((t) => t.id), ['dark-glass', 'analog', 'glass-copy', 'light'], 'default first, then by name');
  const byId = Object.fromEntries(list.map((t) => [t.id, t]));
  assert.equal(byId.light.name, 'My light');
  assert.equal(byId.light.source, 'user');
  assert.equal(byId.light.layout, 'dark-glass', 'a color skin shares its base layout');
  assert.equal(byId.analog.layout, 'analog', 'a theme with its own page has its own layout');
  assert.deepEqual(byId['dark-glass'].features, ['tools']);
  assert.equal(byId['glass-copy'].usable, false);
  assert.deepEqual(byId['glass-copy'].errors, ['theme for another widget ("dooray")']);
  // The registries never see each other's themes.
  assert.ok(!dooray.listThemes().some((t) => ['dark-glass', 'analog', 'light'].includes(t.id)));
  assert.equal(clock.getTheme('glass'), null);
  assert.equal(clock.resolveTheme('nope').id, 'dark-glass');
  assert.equal(clock.resolveTheme('glass-copy').id, 'dark-glass', 'an unusable theme falls back to the default');
  assert.equal(clock.partition, 'widget-theme-clock');
  assert.equal(partitionFor('calendar'), 'widget-theme-calendar');
  assert.equal(dooray.partition, 'dooray-theme');
});

test('theme URLs: widget-theme://<theme>.<widget>/ for widgets, dooray-theme://<theme>/ for Dooray', async () => {
  const pkg = clockPackage();
  const clock = createRegistry({ widgetId: 'clock', builtinDir: pkg.builtin, userDir: pkg.user, kitDir: pkg.kit, defaultTheme: 'dark-glass', frames: CLOCK_FRAMES });
  const light = clock.getTheme('light');
  assert.equal(clock.themeUrl(light), 'widget-theme://light.clock/index.html');
  assert.equal(clock.isThemeUrl(light, 'widget-theme://light.clock/index.html?x'), true);
  assert.equal(clock.isThemeUrl(light, 'widget-theme://light.calendar/index.html'), false);
  assert.equal(clock.themeIdOf('widget-theme://light.clock/a.css'), 'light');
  assert.equal(clock.themeIdOf('widget-theme://light.calendar/a.css'), null, "another widget's theme");
  assert.equal(clock.themeIdOf('dooray-theme://glass/index.html'), null);
  assert.equal(clock.themeIdOf('widget-theme://light/index.html'), null);

  const file = async (url) => {
    const r = await clock.resolveFile(url);
    return r && path.relative(pkg.root, r.file).split(path.sep).join('/');
  };
  assert.equal(await file('widget-theme://light.clock/style.css'), 'user/light/style.css', "the theme's own file");
  assert.equal(await file('widget-theme://light.clock/index.html'), 'themes/dark-glass/index.html', 'from its base');
  assert.equal(await file('widget-theme://light.clock/timer-model.js'), 'kit/timer-model.js', 'from the kit');
  assert.equal(await file('widget-theme://dark-glass.clock/style.css'), 'themes/dark-glass/style.css', 'a theme file wins over the kit');
  assert.equal(await file('widget-theme://light.clock/../../kit/timer-model.js'), null, 'URL dots stay inside the origin');
  assert.equal(await file('widget-theme://light.clock/%2e%2e/%2e%2e/secret.txt'), null, 'no path traversal');
  assert.equal(await file('widget-theme://light.clock/..%5C..%5Csecret.txt'), null, 'no path traversal with backslashes');
  assert.equal(await file('widget-theme://light.calendar/style.css'), null);
  assert.equal(await file('widget-theme://nope.clock/style.css'), null);
  assert.equal((await clock.resolveFile('widget-theme://analog.clock/index.html')).contentType, 'text/html; charset=utf-8');

  const dooray = createRegistry({ legacy: true, builtinDir: DOORAY_THEMES, userDir: null });
  assert.equal(dooray.themeUrl(dooray.getTheme('bigsur')), 'dooray-theme://bigsur/index.html');
  assert.ok((await dooray.resolveFile('dooray-theme://bigsur/kit.js')).file.endsWith(path.join('glass', 'kit.js')));
  assert.equal(await dooray.resolveFile('widget-theme://bigsur.dooray/kit.js'), null);
});

test('a theme under development goes only to the widget named in its theme.json', () => {
  const pkg = clockPackage();
  const dev = writeTheme(pkg.root, 'dev-face', { widget: 'clock', extends: 'dark-glass' }, { 'style.css': 'dev' });
  const clock = createRegistry({ widgetId: 'clock', builtinDir: pkg.builtin, userDir: pkg.user, defaultTheme: 'dark-glass', frames: CLOCK_FRAMES });
  const dooray = createRegistry({ legacy: true, builtinDir: DOORAY_THEMES, userDir: null });
  clock.setDevThemeDir(dev);
  dooray.setDevThemeDir(dev);
  assert.equal(clock.resolveTheme('light').id, 'dev-face');
  assert.equal(dooray.resolveTheme('bigsur').id, 'bigsur');
});

test('declared calls only: unknown names, size limit, preview rules, gestures, errors', async () => {
  const seen = [];
  const table = normalizeMethods({
    getState: { run: (entry) => ({ frame: entry.frame }), preview: 'allow' },
    'timer.start': { run: (entry, ...args) => seen.push(['start', ...args]), preview: 'noop' },
    'events.remove': { run: () => ({ ok: true }), gesture: true },
    broken: () => {
      throw new Error('망가짐');
    },
  });
  const page = { frame: 'main', instanceId: null, preview: false, theme: null };
  const preview = { ...page, preview: true };
  assert.deepEqual(await dispatch(table, 'getState', [], page), { frame: 'main' });
  assert.deepEqual(await dispatch(table, 'nope', [], page), { ok: false, message: '지원하지 않는 호출입니다: nope' });
  assert.deepEqual(await dispatch(table, 'constructor', [], page), { ok: false, message: '지원하지 않는 호출입니다: constructor' });
  assert.equal(await dispatch(table, 'timer.start', [5], page), 1);
  assert.deepEqual(seen, [['start', 5]]);
  assert.deepEqual(await dispatch(table, 'timer.start', ['x'.repeat(MAX_ARGS_BYTES)], page), { ok: false, message: '보낸 값이 너무 큽니다.' });
  // Preview: allow runs, noop answers null without running, deny (the default) refuses.
  assert.deepEqual(await dispatch(table, 'getState', [], preview), { frame: 'main' });
  assert.equal(await dispatch(table, 'timer.start', [1], preview), null);
  assert.equal(seen.length, 1);
  assert.deepEqual(await dispatch(table, 'broken', [], preview), { ok: false, message: '미리보기에서는 쓸 수 없습니다.' });
  // Gesture: only when the preload saw a click or key press.
  assert.deepEqual(await dispatch(table, 'events.remove', [], page), { ok: false, message: '클릭이나 키 입력으로만 할 수 있습니다.' });
  assert.deepEqual(await dispatch(table, 'events.remove', [], page, { activated: true }), { ok: true });
  assert.deepEqual(await dispatch(table, 'broken', [], page), { ok: false, message: '망가짐' });

  assert.throws(() => normalizeMethods({ 'bad name': () => {} }), /not valid/);
  assert.throws(() => normalizeMethods({ x: 1 }), /needs a function/);
  assert.throws(() => normalizeMethods({ x: { run() {}, preview: 'maybe' } }), /preview must be/);
  assert.throws(() => normalizeMethods({ timer: () => {}, 'timer.start': () => {} }), /inside method "timer"/);
  assert.deepEqual(normalizeEvents(['settings', 'timers', 'settings']), ['settings', 'timers']);
  assert.throws(() => normalizeEvents(['bad event']), /not valid/);
});

test('window save keys: layout prefix unless default, frame, instance, size variant', () => {
  const key = (o) => boundsKeyOf({ legacy: false, defaultLayout: 'dark-glass', ...o });
  assert.equal(key({ layout: 'dark-glass', frame: 'main' }), 'main');
  assert.equal(key({ layout: null, frame: 'main' }), 'main');
  assert.equal(key({ layout: 'dark-glass', frame: 'main', variant: 'tools' }), 'main+tools');
  assert.equal(key({ layout: 'analog', frame: 'main' }), 'analog/main');
  assert.equal(key({ layout: 'analog', frame: 'main', variant: 'tools' }), 'analog/main+tools');
  assert.equal(key({ layout: 'big', frame: 'day', instanceId: '2026-10-19' }), 'big/day:2026-10-19');
});

// --- the host itself, with the Electron stand-in ---

function storeOf(initial) {
  let s = { themeId: null, alwaysOnTop: false, themeBounds: {}, themeFrames: [], ...initial };
  return { load: () => s, save: (p) => (s = { ...s, ...p }) };
}

function clockHost(extra = {}) {
  const pkg = clockPackage();
  const calls = [];
  const menus = [];
  const store = storeOf({ themeId: 'light' });
  let variant = null;
  const host = new ThemeHost({
    widgetId: 'clock',
    widgetName: '시계',
    store,
    builtinDir: pkg.builtin,
    userDir: pkg.user,
    kitDir: pkg.kit,
    defaultTheme: 'dark-glass',
    frames: CLOCK_FRAMES,
    variant: () => variant,
    methods: {
      getState: { run: (entry) => ({ state: 1, entry }), preview: 'allow' },
      'timer.start': { run: (entry, seconds) => calls.push(['timer.start', seconds]), preview: 'noop' },
    },
    events: ['settings', 'timers'],
    menuItems: (entry) => [{ label: `항상 위 (${entry.frame})` }],
    popupMenu: (win, items) => menus.push(items),
    openSettings: () => calls.push(['settings']),
    onQuitRequest: () => calls.push(['quit']),
    ...extra,
  });
  return { host, store, calls, menus, pkg, setVariant: (v) => (variant = v) };
}

test('a widget host: isolated session, preload with the declared API, its own URL', () => {
  const { host } = clockHost();
  host.open();
  const win = stub.windows.at(-1);
  assert.equal(win.webContents.url, 'widget-theme://light.clock/index.html');
  const prefs = win.options.webPreferences;
  assert.equal(prefs.partition, 'widget-theme-clock');
  assert.ok(prefs.preload.endsWith(path.join('preload', 'widget-theme.js')));
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  const arg = prefs.additionalArguments.find((a) => a.startsWith('--widget-theme-api='));
  assert.deepEqual(JSON.parse(decodeURIComponent(arg.split('=')[1])), {
    methods: [
      { name: 'getState', gesture: false },
      { name: 'timer.start', gesture: false },
    ],
    events: ['settings', 'timers'],
  });
  // The session serves this widget's themes only.
  const ses = stub.sessions.get('widget-theme-clock');
  assert.ok(ses.handlers.has('widget-theme'));
  assert.equal(win.options.width, 220, "a theme without window.main gets the widget's size");
  host.close();
});

test('IPC: window.widget calls reach only the declared methods; Dooray channels refuse widget pages', async () => {
  const { host, calls, menus } = clockHost();
  host.open();
  const wc = stub.windows.at(-1).webContents;
  const ctx = await stub.invoke('widget-theme:context', wc);
  assert.deepEqual(ctx, {
    widget: { id: 'clock', name: '시계' },
    contract: { name: 'clock', version: 1 },
    frame: 'main',
    instanceId: null,
    preview: false,
    theme: { id: 'light', name: 'My light', version: '1.0.0' },
    background: null,
    locale: 'ko-KR',
  });
  const state = await stub.invoke('widget-theme:call', wc, 'getState', []);
  assert.deepEqual(state.entry, { frame: 'main', instanceId: null, preview: false, theme: { id: 'light', name: 'My light', version: '1.0.0', features: [] } });
  await stub.invoke('widget-theme:call', wc, 'timer.start', [60]);
  assert.deepEqual(calls.at(-1), ['timer.start', 60]);
  assert.equal((await stub.invoke('widget-theme:call', wc, 'alarms.add', [])).ok, false);
  await assert.rejects(async () => stub.invoke('theme:get-snapshot', wc), /Not a theme window/);
  await assert.rejects(async () => stub.invoke('widget-theme:call', { id: -1 }, 'getState', []), /Not a widget theme window/);

  // Events: only declared names go out.
  assert.equal(host.emit('timers', { a: 1 }), true);
  assert.equal(host.emit('secret', { a: 1 }), false);
  assert.deepEqual(wc.sent.filter(([c]) => c === 'widget-theme:event'), [['widget-theme:event', 'timers', { a: 1 }]]);

  // Window calls: pin, size, menu (one per right click), settings, close = turn the widget off.
  assert.equal(await stub.invoke('widget-theme:window', wc, 'toggle-pin'), true);
  assert.deepEqual(await stub.invoke('widget-theme:window', wc, 'state'), { pinned: true });
  assert.equal(await stub.invoke('widget-theme:window', wc, 'menu'), true);
  assert.equal(await stub.invoke('widget-theme:window', wc, 'menu'), false, 'the second event of the same click');
  assert.deepEqual(menus, [[{ label: '항상 위 (main)' }]]);
  await stub.invoke('widget-theme:open-settings', wc);
  await stub.invoke('widget-theme:window', wc, 'close');
  assert.deepEqual(calls.slice(-2), [['settings'], ['quit']]);
  host.close();
});

test('size variants: each variant keeps its own saved bounds', () => {
  const { host, store, setVariant } = clockHost();
  host.open();
  const win = stub.windows.at(-1);
  assert.deepEqual([win.bounds.width, win.bounds.height], [220, 96]);
  win.setBounds({ x: 100, y: 100, width: 250, height: 100 });
  setVariant('tools');
  host.applyVariant();
  assert.deepEqual(store.load().themeBounds.main, { x: 100, y: 100, width: 250, height: 100 });
  assert.deepEqual([win.bounds.width, win.bounds.height], [260, 200], "the variant's default size");
  assert.deepEqual(win.minimum, [220, 180]);
  setVariant(null);
  host.applyVariant();
  assert.deepEqual(win.bounds, { x: 100, y: 100, width: 250, height: 100 }, 'back to the saved size');
  host.close();
});

test('extra frames are remembered and reopened; undeclared frames are refused', () => {
  const frames = { main: { width: 300, height: 400 }, day: { width: 280, height: 300 } };
  const { host, store } = clockHost({ frames });
  host.open();
  assert.equal(host.openFrame('day', '2026-10-19'), true);
  assert.equal(host.openFrame('nope', 'x'), false);
  assert.equal(host.openFrame('day', '../x'), false);
  assert.deepEqual(store.load().themeFrames, [{ frame: 'day', instanceId: '2026-10-19', pinned: false }]);
  const day = stub.windows.at(-1);
  assert.equal(day.webContents.url, 'widget-theme://light.clock/index.html');
  host.close();
  assert.deepEqual(store.load().themeFrames.length, 1, 'closing the widget keeps the remembered windows');
  const before = stub.windows.length;
  host.open();
  assert.equal(stub.windows.length - before, 2);
  host.close();
});

// Values made inside the preload's sandbox come from another realm: compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('the preload builds window.widget from the declared list and checks gestures', async () => {
  const spec = { methods: [{ name: 'getState', gesture: false }, { name: 'events.remove', gesture: true }, { name: 'timer.start', gesture: false }], events: ['changed'] };
  const page = stub.runPreload(PRELOAD, { argv: ['x', `--widget-theme-api=${encodeURIComponent(JSON.stringify(spec))}`] });
  const w = page.exposed.widget;
  assert.deepEqual(Object.keys(w), ['apiVersion', 'getContext', 'api', 'call', 'on', 'onBackground', 'openSettings', 'window']);
  assert.deepEqual(Object.keys(w.api), ['getState', 'events', 'timer']);
  assert.deepEqual(Object.keys(w.window), ['close', 'togglePin', 'getState', 'setSize', 'openMenu']);

  await w.api.timer.start(30);
  assert.deepEqual(plain(page.invoked.at(-1)), ['widget-theme:call', 'timer.start', [30], false]);
  // A gesture method without a click never leaves the page; with one, the engine is told.
  assert.deepEqual(plain(await w.api.events.remove({ uid: 'a' })), { ok: false, message: '클릭이나 키 입력으로만 할 수 있습니다.' });
  assert.equal(page.invoked.length, 1);
  page.setActive(true);
  await w.api.events.remove({ uid: 'a' });
  assert.deepEqual(plain(page.invoked.at(-1)), ['widget-theme:call', 'events.remove', [{ uid: 'a' }], true]);
  assert.equal((await w.call('nope')).ok, false);

  const got = [];
  const off = w.on('changed', (p) => got.push(p));
  assert.throws(() => w.on('secret', () => {}), /unknown event/);
  page.emit('widget-theme:event', 'changed', 1);
  page.emit('widget-theme:event', 'other', 2);
  off();
  page.emit('widget-theme:event', 'changed', 3);
  assert.deepEqual(got, [1]);

  await w.window.setSize('300', 200);
  assert.deepEqual(plain(page.invoked.at(-1)), ['widget-theme:window', 'set-size', 300, 200]);

  // Without the engine's argument the API is empty, not broken.
  const bare = stub.runPreload(PRELOAD).exposed.widget;
  assert.deepEqual(Object.keys(bare.api), []);
});
