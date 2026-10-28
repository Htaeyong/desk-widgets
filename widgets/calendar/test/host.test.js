// The calendar on the engine's real theme host (#61), with the engine's Electron stand-in: theme list, URLs and
// window sizes per theme, extends + kit files, settings migrated from the widget's own keys, the theme page's
// window.widget, and the write rules (gesture, preview, declared calls only) over the real IPC. --mock-data
// gives a writable calendar without accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stub = require('../../../engine/test/helpers/theme-electron');

stub.install();
const { ThemeHost } = require('../../../engine/main/theme-host');
const { create } = require('../index');
const { DEFAULTS, sanitize, upgrade } = require('../lib/settings');

const calendarDir = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(calendarDir, 'widget.json'), 'utf8'));
const PRELOAD = path.join(__dirname, '..', '..', '..', 'engine', 'preload', 'widget-theme.js');

/** The widget with ctx.useThemes building a real ThemeHost the way engine/main/main.js does. */
function setup(raw = {}, { mock = true } = {}) {
  let state = sanitize({ ...DEFAULTS, ...upgrade(raw) });
  const calls = [];
  const menus = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-host-'));
  let host = null;
  const ctx = {
    id: 'calendar',
    manifest,
    dir: calendarDir,
    dataDir,
    flags: { mockData: mock },
    createStore: () => ({ load: () => state, save: (v) => (state = sanitize({ ...state, ...v })) }),
    sendToSettings: () => {},
    openExternal: (url) => calls.push(['openExternal', url]),
    confirm: async () => 0,
    useThemes: (opts) => {
      const declared = manifest.themes || {};
      host = new ThemeHost({
        contract: declared.contract,
        contractVersions: declared.contractVersions,
        defaultTheme: declared.default,
        ...opts,
        widgetId: 'calendar',
        widgetName: manifest.name,
        popupMenu: (_win, items) => menus.push(items),
        openSettings: () => calls.push(['settings']),
        onQuitRequest: () => calls.push(['quit']),
      });
      return host;
    },
  };
  const widget = create(ctx);
  return { widget, host: () => host, calls, menus, getState: () => state };
}

const lastWindow = () => stub.windows.at(-1);
const relFile = async (host, url) => {
  const r = await host.registry.resolveFile(url);
  return r && path.relative(calendarDir, r.file).split(path.sep).join('/');
};

test('the built-in themes on the host: list, URL, window size from theme.json, file lookup through extends and the kit', async (t) => {
  const s = setup();
  t.after(() => s.widget.stop());
  const host = s.host();
  const list = host.settingsHandlers().themes();
  assert.deepEqual(list.map((x) => [x.id, x.name, x.usable, x.layout]), [['default', '기본', true, 'default'], ['big', '큰 달력', true, 'big']]);
  s.widget.start();
  let win = lastWindow();
  assert.equal(win.webContents.url, 'widget-theme://default.calendar/index.html');
  assert.equal(win.options.webPreferences.partition, 'widget-theme-calendar');
  assert.deepEqual([win.options.width, win.options.height, win.options.minWidth], [300, 460, 240]);
  // 큰 달력: its own page (from its folder), the base theme's files, and model.js from the kit; nothing else.
  assert.equal(await relFile(host, 'widget-theme://big.calendar/index.html'), 'themes/big/index.html');
  assert.equal(await relFile(host, 'widget-theme://big.calendar/big.css'), 'themes/big/big.css');
  assert.equal(await relFile(host, 'widget-theme://big.calendar/calendar.js'), 'themes/default/calendar.js');
  assert.equal(await relFile(host, 'widget-theme://big.calendar/model.js'), 'kit/model.js');
  assert.equal(await relFile(host, 'widget-theme://default.calendar/model.js'), 'kit/model.js');
  assert.equal(await relFile(host, 'widget-theme://big.calendar/index.js'), null, 'the widget\'s main code is not a theme file');
  assert.equal(await relFile(host, 'widget-theme://big.calendar/lib/secrets.js'), null);
  assert.equal(await relFile(host, 'widget-theme://default.clock/index.html'), null, 'not another widget\'s address');
  // Switching the theme from settings opens the new theme's window with its size.
  assert.deepEqual(s.widget.settings.save({ themeId: 'big' }), { ok: true });
  win = lastWindow();
  assert.equal(win.webContents.url, 'widget-theme://big.calendar/index.html');
  assert.deepEqual([win.options.width, win.options.height, win.options.minWidth], [800, 640, 480]);
});

test('after updating: the theme, its window bounds and opacity carry over from the widget\'s own keys (6.3)', (t) => {
  const compact = { x: 40, y: 50, width: 320, height: 480 };
  const month = { x: 100, y: 80, width: 900, height: 700 };
  const s = setup({ themeId: 'big', opacity: { big: 40 }, windowBounds: { compact, month }, alwaysOnTop: true });
  t.after(() => s.widget.stop());
  s.widget.start();
  const win = lastWindow();
  assert.equal(win.webContents.url, 'widget-theme://big.calendar/index.html');
  assert.deepEqual([win.options.x, win.options.y, win.options.width, win.options.height], [100, 80, 900, 700], 'the big calendar where it was');
  assert.equal(win.options.alwaysOnTop, true);
  assert.equal(s.host().backgroundOf(s.host().registry.resolveTheme('big')), 0.4, 'the same opacity');
  assert.deepEqual(s.getState().themeBounds['big/main'], month);
  assert.deepEqual(s.getState().windowBounds.month, month, 'old key kept');
});

test('window.widget: the calendar API with the gesture rule on writes; calls go only to declared methods', async (t) => {
  const s = setup();
  t.after(() => s.widget.stop());
  s.widget.start();
  const win = lastWindow();
  const page = stub.runPreload(PRELOAD, { argv: win.options.webPreferences.additionalArguments });
  const api = page.exposed.widget.api;
  assert.deepEqual(Object.keys(api).sort(), ['ddays', 'events', 'getState', 'refresh', 'tasks']);
  assert.deepEqual(Object.keys(api.ddays).sort(), ['archive', 'remove', 'save']);
  assert.deepEqual(Object.keys(api.events).sort(), ['create', 'list', 'openLink', 'remove', 'update']);
  // Without a click / key press the preload does not even send a write.
  const before = page.invoked.length;
  assert.match((await api.events.create({ sourceId: 'mock-account', calendarId: 'x' }, {})).message, /클릭이나 키 입력/);
  assert.match((await api.events.remove({ sourceId: 'mock-account', calendarId: 'x', uid: 'u' })).message, /클릭이나 키 입력/);
  assert.equal(page.invoked.length, before);
  await api.getState();
  const [channel, name, args] = page.invoked.at(-1); // values from the preload's sandbox (another realm)
  assert.deepEqual([channel, name, args.length], ['widget-theme:call', 'getState', 0]);
  assert.match((await page.exposed.widget.call('accounts.list')).message, /지원하지 않는 호출/);
  assert.throws(() => page.exposed.widget.on('secrets', () => {}), /unknown event/);
});

test('real IPC with --mock-data: read, write after a gesture (background), refused without one or from the preview', async (t) => {
  const s = setup();
  t.after(() => s.widget.stop());
  s.widget.start();
  const wc = lastWindow().webContents;
  const call = (name, args, activated = true) => stub.invoke('widget-theme:call', wc, name, args, activated);
  for (let i = 0; i < 100 && !(await call('getState', [])).lastUpdated; i++) await new Promise((r) => setTimeout(r, 20));
  const state = await call('getState', []);
  assert.deepEqual(state.calendars.map((c) => c.name), ['내 캘린더', '업무 (예시 계정)', '개인 (예시 계정)']);
  const now = Date.now();
  const range = { from: now - 86400000, to: now + 30 * 86400000 };
  const [events] = await call('events.list', [[range]]);
  assert.ok(events.some((e) => e.title === '디자인 검토' && e.hasUrl && !('url' in e)));
  const cal = state.calendars.find((c) => c.sourceId === 'mock-account');
  const fields = { title: '테마에서 만든 일정', allDay: true, start: '2030-01-02', end: '2030-01-03', location: '', description: '' };
  assert.match((await call('events.create', [cal, fields], false)).message, /클릭이나 키 입력/);
  assert.deepEqual(await call('events.create', [cal, fields]), { ok: true, queued: true });
  const far = { from: Date.UTC(2030, 0, 1), to: Date.UTC(2030, 0, 5) };
  assert.ok((await call('events.list', [[far]]))[0].some((e) => e.title === fields.title && e.pending), 'pending at once');
  for (let i = 0; i < 200 && (await call('getState', [])).pending.length; i++) await new Promise((r) => setTimeout(r, 20));
  const done = (await call('events.list', [[far]]))[0].find((e) => e.title === fields.title);
  assert.ok(done && !done.pending && /@desk-widgets$/.test(done.uid), 'written to the (mock) server and read back');
  // A link by event id only.
  const review = events.find((e) => e.title === '디자인 검토');
  assert.equal(await call('events.openLink', [{ sourceId: review.sourceId, calendarId: review.calendarId, uid: review.uid, url: 'https://evil.example.net' }]), true);
  assert.deepEqual(s.calls.filter(([c]) => c === 'openExternal'), [['openExternal', 'https://example.com/meetings/review']]);
  // The right-click menu has the widget's items.
  assert.equal(await stub.invoke('widget-theme:window', wc, 'menu'), true);
  assert.deepEqual(s.menus[0].map((m) => m.label), ['지금 새로고침', '항상 위에 표시', '테마', '한 주의 시작']);
});
