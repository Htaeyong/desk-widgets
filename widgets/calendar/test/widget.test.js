// The calendar widget's main code with a fake engine context (a stand-in theme host, #61), and its package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packageWidget } = require('../../../tools/widget-kit/build');
const { validateManifest } = require('../../../engine/main/theme-manifest');
const { create } = require('../index');
const { DEFAULTS, sanitize } = require('../lib/settings');
const { withThemeHost } = require('./theme-host');

const calendarDir = path.join(__dirname, '..');
const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', 'DTSTART:20261018T010000Z', 'SUMMARY:회의', 'URL:https://example.com/e/1', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:2', 'DTSTART:20261019T010000Z', 'SUMMARY:링크 없음', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
// Stand-in for Electron safeStorage: reversible and visibly not the plain text.
const fakeCrypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };
const SRC = { id: 'a1', type: 'ics', name: '팀', url: 'https://x.example.com/a.ics', color: '#123456', enabled: true };
const OCT = { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-11-01T00:00:00Z') };

function setup(initial = {}, { fetch: customFetch, crypto, flags, integrations } = {}) {
  const opened = [];
  const requests = [];
  let state = sanitize({ ...DEFAULTS, ...initial });
  const { ctx, th } = withThemeHost({
    dir: calendarDir,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cal-w-')),
    flags: flags || {},
    createStore: () => ({ load: () => state, save: (v) => { state = sanitize({ ...state, ...v }); } }),
    openExternal: (url) => opened.push(url),
    sendToSettings: () => {},
    integrations,
  });
  const fetch = async (url) => {
    requests.push(url);
    return { status: 200, ok: true, headers: { get: () => null }, body: null, text: async () => ICS };
  };
  const widget = create(ctx, { fetch: customFetch === null ? undefined : customFetch || fetch, crypto: crypto || fakeCrypto });
  return { widget, ctx, th, opened, requests, getState: () => state };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('the widget uses the theme host with the calendar contract; start opens it, stop closes it', (t) => {
  const { widget, th } = setup();
  assert.ok(th.host, 'the host exists before start (the settings window needs it)');
  assert.equal(th.opts.defaultTheme, 'default');
  assert.deepEqual(th.opts.contractVersions, [1]);
  assert.equal(th.opts.builtinDir, path.join(calendarDir, 'themes'));
  assert.match(th.opts.userDir, /themes$/);
  assert.equal(th.opts.kitDir, path.join(calendarDir, 'kit'), 'model.js for every theme');
  assert.deepEqual(Object.keys(th.opts.methods).sort(), ['events.create', 'events.list', 'events.openLink', 'events.remove', 'events.update', 'getState', 'refresh', 'tasks.updateDue']);
  assert.deepEqual(th.opts.events, ['changed', 'reveal', 'open-editor']);
  // Writes need a gesture and are refused in the preview; reading works there.
  for (const name of ['events.create', 'events.update', 'events.remove', 'events.openLink', 'tasks.updateDue']) {
    assert.equal(th.opts.methods[name].gesture, true, name);
    assert.equal(th.opts.methods[name].preview, undefined, `${name}: default = deny`);
  }
  for (const name of ['getState', 'events.list', 'refresh']) assert.equal(th.opts.methods[name].preview, 'allow', name);
  widget.start();
  assert.equal(th.opened, 1);
  widget.stop();
  assert.equal(th.closed, 1);
  void t;
});

test('start fetches enabled subscriptions and a theme gets their events (no URL, only hasUrl)', async (t) => {
  const { widget, th, requests } = setup({ sources: [SRC, { ...SRC, id: 'off', url: 'https://x.example.com/off.ics', enabled: false }] });
  widget.start();
  t.after(() => widget.stop());
  await settle();
  assert.deepEqual(requests, ['https://x.example.com/a.ics']);
  const view = await th.theme.get();
  assert.equal(view.weekStart, 0);
  assert.equal(view.sources.length, 3);
  assert.ok(view.lastUpdated > 0);
  assert.equal(view.errorCount, 0);
  for (const key of ['themeId', 'layout', 'opacity']) assert.equal(key in view, false, `${key} belongs to the host, not the contract`);
  const res = await th.theme.events({ grid: OCT, upcoming: { from: OCT.from, to: OCT.from + 3600000 } });
  assert.deepEqual(res.grid.map((e) => [e.title, e.color, e.hasUrl]), [['회의', '#123456', true], ['링크 없음', '#123456', false]]);
  assert.ok(res.grid.every((e) => !('url' in e)), 'a theme never sees an event URL');
  assert.deepEqual(res.upcoming, []);
  assert.deepEqual(await th.call('events.list', [[{ from: 'x', to: 1 }]]), [[]]);
  assert.equal((await th.call('events.list', [[OCT, OCT, OCT, OCT, OCT, OCT]])).length, 4, 'at most 4 ranges');
  await new Promise((r) => setTimeout(r, 200)); // "changed" is coalesced (150 ms)
  assert.ok(th.emitted.some(([name, v]) => name === 'changed' && v.sources.length === 3), 'changes reach the theme as "changed"');
});

test('only declared calls; links by event id only (http(s) of that event), never a URL from the theme', async (t) => {
  const { widget, th, opened } = setup({ sources: [SRC] });
  widget.start();
  t.after(() => widget.stop());
  await settle();
  assert.match((await th.call('openUrl', ['https://evil.example.net'])).message, /지원하지 않는 호출/);
  assert.match((await th.call('accounts.list')).message, /지원하지 않는 호출/);
  const one = { sourceId: 'a1', calendarId: 'default', uid: '1' };
  assert.equal(await th.theme.openLink({ ...one, url: 'https://evil.example.net' }), true);
  assert.deepEqual(opened, ['https://example.com/e/1'], 'the event\'s own link, not the one the theme sent');
  assert.equal(await th.theme.openLink({ ...one, uid: '2' }), false, 'no link');
  assert.equal(await th.theme.openLink({ sourceId: 'a1', calendarId: 'default', uid: 'nope' }), false);
  assert.match((await th.theme.openLink(one, { activated: false })).message, /클릭이나 키 입력/);
  assert.match((await th.theme.openLink(one, { preview: true })).message, /미리보기/);
  assert.deepEqual(opened, ['https://example.com/e/1']);
});

test('settings: a bad address is refused with its position; saving a new subscription fetches it', async (t) => {
  const { widget, requests, getState } = setup();
  widget.start();
  t.after(() => widget.stop());
  const bad = widget.settings.save({ sources: [SRC, { url: 'ftp://x' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /2번째 구독/);
  assert.deepEqual(widget.settings.save({ sources: [{ name: '', url: 'webcal://x.example.com/new.ics', enabled: true }], weekStart: 1, refreshMinutes: 30 }), { ok: true });
  await settle();
  assert.deepEqual(requests, ['https://x.example.com/new.ics']);
  assert.equal(getState().weekStart, 1);
  assert.equal(getState().refreshMinutes, 30);
  assert.equal(getState().upcomingDays, 7, 'values not sent are kept');
  const values = widget.settings.get();
  assert.equal(values.sources[0].name, 'x.example.com');
  assert.equal(values.status[0].count, 2);
});

test('settings: the engine theme section values are saved and applied through the host', async (t) => {
  const { widget, th, getState } = setup();
  widget.start();
  t.after(() => widget.stop());
  const values = widget.settings.get();
  assert.deepEqual([values.themeId, values.themeOpacity, values.mock], ['default', {}, false]);
  for (const name of ['themes', 'previewTheme', 'openThemeFolder', 'liveOpacity']) assert.equal(typeof widget.settings.handlers[name], 'function', name);
  widget.settings.handlers.liveOpacity('default', 30);
  assert.deepEqual(th.live, [['default', 30]], 'the slider preview is the host\'s');
  assert.deepEqual(widget.settings.save({ themeOpacity: { default: 30 } }), { ok: true });
  assert.deepEqual(getState().themeOpacity, { default: 30 });
  assert.equal(th.backgrounds, 1);
  assert.equal(th.reloads, 0);
  assert.deepEqual(widget.settings.save({ themeId: 'big' }), { ok: true });
  assert.equal(getState().themeId, 'big');
  assert.equal(th.reloads, 1, 'another theme = new theme windows');
  assert.deepEqual(widget.settings.save({ alwaysOnTop: true }), { ok: true });
  assert.equal(th.pinned, true);
});

test('away: no requests; back: refresh at once', async (t) => {
  const { widget, requests } = setup({ sources: [SRC] });
  widget.setPaused('locked');
  widget.start();
  t.after(() => widget.stop());
  await settle();
  assert.deepEqual(requests, []);
  widget.setPaused(null);
  await settle();
  assert.equal(requests.length, 1);
});

test('right-click menu items: refresh, always on top, theme, week start', async (t) => {
  const { widget, th, getState } = setup({ sources: [SRC] });
  widget.start();
  t.after(() => widget.stop());
  const [refresh, onTop, theme, week] = th.theme.menu();
  assert.equal(refresh.label, '지금 새로고침');
  assert.deepEqual(theme.submenu.map((x) => [x.label, x.checked]), [['기본', true], ['큰 달력', false]]);
  onTop.click({ checked: true });
  assert.equal(th.pinned, true);
  assert.equal(getState().alwaysOnTop, true);
  week.submenu[1].click();
  assert.equal(getState().weekStart, 1);
  theme.submenu[1].click();
  assert.equal(getState().themeId, 'big');
  assert.equal(th.reloads, 1);
});

test('--mock-data: example calendars on an in-memory server, readable and writable without accounts', async (t) => {
  const { widget, th, getState } = setup({}, { fetch: null, flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  for (let i = 0; i < 100 && !(await th.theme.get()).lastUpdated; i++) await new Promise((r) => setTimeout(r, 20));
  const view = await th.theme.get();
  assert.deepEqual(view.sources.map((s) => s.name), ['내 캘린더', '예시 계정', '예시 공휴일 (읽기 전용)']);
  assert.deepEqual(view.calendars.map((c) => c.name), ['내 캘린더', '업무 (예시 계정)', '개인 (예시 계정)']);
  assert.deepEqual(getState().sources, [], 'the user\'s settings are not touched');
  const now = Date.now();
  const res = await th.call('events.list', [[{ from: now - 20 * 86400000, to: now + 40 * 86400000 }]]);
  const titles = res[0].map((e) => e.title);
  for (const title of ['주간 스탠드업 (반복)', '디자인 검토', '부산 출장', '야간 배포', '고객사 통화', '예시 공휴일']) assert.ok(titles.includes(title), title);
  const byTitle = Object.fromEntries(res[0].map((e) => [e.title, e]));
  assert.match(byTitle['주간 스탠드업 (반복)'].readOnlyReason, /반복/);
  assert.match(byTitle['고객사 통화'].readOnlyReason, /초대/);
  assert.equal(byTitle['디자인 검토'].readOnly, false);
  assert.equal(byTitle['디자인 검토'].hasUrl, true);
  assert.equal(byTitle['부산 출장'].allDay, true);
  assert.equal(widget.settings.get().mock, true);
});

test('the package: theme packages (base + extends) valid for the calendar contract, every file inside, no tests', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-calendar-')), 'calendar');
  const pkg = packageWidget(calendarDir, out);
  const files = [
    'index.js',
    'lib/caldav.js', 'lib/caldav-source.js', 'lib/webdav.js', 'lib/providers.js', 'lib/secrets.js', 'lib/http.js', 'lib/ical.js', 'lib/ical-write.js',
    'lib/rrule.js', 'lib/tz.js', 'lib/sources.js', 'lib/ics-source.js', 'lib/settings.js', 'lib/mock.js', 'lib/optimistic.js', 'lib/writer.js', 'lib/editable.js', 'lib/event-fields.js', 'lib/local-events.js',
    'themes/default/theme.json', 'themes/default/index.html', 'themes/default/calendar.css', 'themes/default/default.css', 'themes/default/calendar.js', 'kit/model.js',
    'themes/big/theme.json', 'themes/big/index.html', 'themes/big/big.css',
    'settings/panel.html', 'settings/panel.js', 'settings/panel.css',
  ];
  for (const f of files) assert.ok(fs.existsSync(path.join(pkg, f)), `${f} missing from the package`);
  for (const gone of ['renderer', 'preload', 'themes.js', 'test', 'package.json']) assert.equal(fs.existsSync(path.join(pkg, gone)), false, `${gone} should not be in the package`);
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'widget.json'), 'utf8'));
  assert.deepEqual([manifest.id, manifest.version, manifest.engineApi], ['calendar', '1.0.3', '1.3']);
  assert.deepEqual(manifest.themes, { contract: 'calendar', contractVersions: [1], default: 'default' });
  for (const id of ['default', 'big']) {
    const raw = JSON.parse(fs.readFileSync(path.join(pkg, 'themes', id, 'theme.json'), 'utf8'));
    const { manifest: m, errors, compatible } = validateManifest(raw, id, { widgetId: 'calendar', contractVersions: [1], frames: { main: {} } });
    assert.deepEqual(errors, [], id);
    assert.equal(compatible, true, id);
    assert.deepEqual(m.features, ['edit']);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, 'themes', 'big', 'theme.json'), 'utf8')).extends, 'default');
  // Everything the widget code requires is Node built-ins, electron or its own files.
  for (const f of fs.readdirSync(pkg, { recursive: true }).map(String).filter((f) => f.endsWith('.js') && !f.startsWith('themes') && !f.startsWith('kit'))) {
    for (const m of fs.readFileSync(path.join(pkg, f), 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const name = m[1];
      if (name.startsWith('.')) assert.ok(fs.existsSync(path.resolve(pkg, path.dirname(f), name.endsWith('.js') ? name : `${name}.js`)), `${f}: ${name} not in the package`);
      else assert.ok(['fs', 'path', 'crypto', 'electron', 'url', 'events'].includes(name), `${f}: requires ${name}`);
    }
  }
  // Theme pages never reach for Node or the old widget bridge.
  for (const f of ['themes/default/calendar.js', 'kit/model.js']) {
    const src = fs.readFileSync(path.join(pkg, f), 'utf8');
    assert.doesNotMatch(src, /require\(|calendarApi|ipcRenderer/, f);
  }
});

test('refresh() (header 새로고침, #81): asks every source again and answers when done, with the error count', async (t) => {
  let fail = false;
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    if (fail && url.includes('b.ics')) return { status: 500, ok: false, headers: { get: () => null }, body: null, text: async () => '' };
    return { status: 200, ok: true, headers: { get: () => null }, body: null, text: async () => ICS };
  };
  const { widget, th } = setup({ sources: [SRC, { ...SRC, id: 'b1', url: 'https://x.example.com/b.ics' }] }, { fetch });
  widget.start();
  t.after(() => widget.stop());
  await settle();
  assert.equal(requests.length, 2);
  const res = await th.call('refresh');
  assert.equal(requests.length, 4, 'both sources asked again');
  assert.equal(res.ok, true);
  assert.equal(res.errorCount, 0);
  assert.ok(res.lastUpdated > 0);
  assert.equal((await th.theme.get()).refreshing, false, 'done when it answers');
  fail = true;
  const bad = await th.call('refresh');
  assert.equal(bad.errorCount, 1);
  assert.equal((await th.theme.get()).errorCount, 1);
  assert.equal((await th.call('refresh', [], { preview: true })).ok, true, 'allowed in the theme preview');
});

test('Todo due markers reconcile from the source and calendar edits write back to Todo', async (t) => {
  const dueAt = new Date(2026, 9, 21, 23, 59).getTime();
  const movedAt = new Date(2026, 9, 24, 23, 59).getTime();
  const tasks = [{ id: 't1', title: 'Deadline', dueAt, dateOnly: true, completedAt: null }];
  const calls = [];
  let changed = () => {};
  const integrations = {
    status: () => ({ installed: true, enabled: true, running: true, peerEnabled: true, capabilities: ['calendar-share'] }),
    onEvent: (_id, _event, fn) => { changed = fn; return () => {}; },
    onStatus: () => () => {},
    call: async (_id, method, payload) => {
      calls.push([method, payload]);
      if (method === 'tasks.snapshot') return { ok: true, result: { tasks: tasks.map((item) => ({ ...item })) } };
      if (method === 'tasks.updateDue') {
        tasks[0].dueAt = payload.dueAt;
        return { ok: true, result: { task: { ...tasks[0] } } };
      }
      throw new Error(method);
    },
  };
  const { widget, th } = setup({ todoIntegration: true }, { integrations });
  widget.start();
  t.after(() => widget.stop());
  await settle();
  const range = { from: new Date(2026, 9, 20).getTime(), to: new Date(2026, 9, 27).getTime() };
  const items = async () => (await th.call('events.list', [[range]]))[0].filter((e) => e.sourceId === 'todo');
  assert.deepEqual((await items()).map((e) => [e.uid, e.start]), [['todo:t1', '2026-10-21']]);
  assert.equal((await th.call('tasks.updateDue', [{ taskId: 't1', dueAt: movedAt, dateOnly: true }])).ok, true);
  assert.deepEqual((await items()).map((e) => e.start), ['2026-10-24']);
  assert.deepEqual(calls.find(([method]) => method === 'tasks.updateDue')[1], { taskId: 't1', dueAt: movedAt, dateOnly: true });
  tasks[0].completedAt = movedAt;
  changed();
  await settle();
  assert.deepEqual(await items(), [], 'completed tasks are hidden by the default option');
  widget.settings.save({ completedTodos: 'show' });
  await settle();
  assert.equal((await items())[0].completed, true);
  widget.settings.save({ todoIntegration: false });
  assert.deepEqual(await items(), [], 'disabling integration removes only the projection');
});
