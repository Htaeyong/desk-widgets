const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WidgetHost, WidgetWatcher, discoverWidgets, validateWidgetManifest, checkEngineApi, purgeModules, ENGINE_API } = require('../main/widgets');

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
      handlers.set(channel, fn);
    },
    removeHandler: (channel) => handlers.delete(channel),
  };
}

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

// Writes <dir>/<id>/widget.json; engineApi defaults to the engine's.
function writeWidget(dir, id, extra = {}) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  const manifest = typeof extra === 'string' ? extra : JSON.stringify({ id, name: id.toUpperCase(), engineApi: ENGINE_API, version: '1.0.0', ...extra });
  fs.writeFileSync(path.join(dir, id, 'widget.json'), manifest);
}

// A widget module that logs its lifecycle and registers one IPC channel when started.
function fakeModule(log, id) {
  return {
    create(ctx) {
      log.push(`create:${id}`);
      return {
        start() {
          log.push(`start:${id}`);
          ctx.handle(`${id}:ping`, () => 'pong');
          ctx.onStop(() => log.push(`cleanup:${id}`));
        },
        stop: () => log.push(`stop:${id}`),
        focus: () => id === 'b',
        desktopWindows: () => [`win-${id}`],
        setPaused: (reason) => log.push(`paused:${id}:${reason}`),
        needsSetup: () => id === 'a',
        settings: { get: () => ({ id }), handlers: { echo: (x) => `${id}:${x}` } },
      };
    },
  };
}

function makeHost(dir, { enabled = {}, folders = [], load } = {}) {
  const log = [];
  const ipc = fakeIpc();
  const purged = [];
  const host = new WidgetHost({
    sources: () => ({ dirs: [dir], folders }),
    dataDir: (id) => `/data/${id}`,
    getEnabledMap: () => enabled,
    services: (ctx) => ({ engine: `services for ${ctx.id}` }),
    ipc,
    load: load || ((file) => fakeModule(log, path.basename(path.dirname(file)))),
    purge: (d) => purged.push(path.basename(d)),
    log: () => {},
  }).init();
  return { host, log, ipc, enabled, purged };
}

test('engine API: same major and an engine minor at least the widget\'s', () => {
  assert.equal(checkEngineApi('1.0', '1.0'), null);
  assert.equal(checkEngineApi('1.0', '1.3'), null);
  assert.match(checkEngineApi('1.4', '1.3'), /1\.4 이상.*Desk Widgets를 업데이트/);
  assert.match(checkEngineApi('2.0', '1.3'), /Desk Widgets를 업데이트/);
  assert.match(checkEngineApi('1.0', '2.0'), /위젯을 업데이트/);
  assert.match(checkEngineApi(undefined, '1.0'), /engineApi/);
  assert.match(checkEngineApi('1', '1.0'), /engineApi/);
});

test('widget manifest: id must match the folder, name required, files stay inside', () => {
  assert.ok(validateWidgetManifest({ id: 'clock', name: '시계' }, 'clock').manifest);
  assert.equal(validateWidgetManifest({ id: 'clock', name: '시계' }, 'other').manifest, null);
  assert.equal(validateWidgetManifest({ id: 'Clock', name: 'x' }).manifest, null);
  assert.equal(validateWidgetManifest({ id: 'clock' }).manifest, null);
  assert.equal(validateWidgetManifest({ id: 'clock', name: 'x', main: '../evil.js' }).manifest, null);
  assert.equal(validateWidgetManifest({ id: 'clock', name: 'x', settings: { html: 'a.html' } }).manifest, null);
  const m = validateWidgetManifest({ id: 'clock', name: 'x', engineApi: '1.0', settings: { html: 'p.html', script: 'p.js' } }).manifest;
  assert.deepEqual(m.settings, { html: 'p.html', script: 'p.js', style: null });
  assert.equal(m.defaultEnabled, true);
  assert.equal(m.engineApi, '1.0');
  assert.equal(m.main, 'index.js');
});

test('widget discovery: installed folder plus dev folders (dev wins), sorted, broken reported', () => {
  const dir = tmp('widgets');
  writeWidget(dir, 'b', { order: 20 });
  writeWidget(dir, 'a', { order: 10 });
  writeWidget(dir, 'bad', '{ not json');
  const dev = path.join(tmp('dev'), 'b');
  writeWidget(path.dirname(dev), 'b', { order: 20, version: '9.9.9' });
  const found = discoverWidgets({ dirs: [dir, path.join(dir, 'missing')], folders: [dev] });
  assert.deepEqual(found.map((f) => f.manifest?.id ?? 'broken'), ['a', 'b', 'broken']);
  assert.equal(found[1].source, 'dev');
  assert.equal(found[1].manifest.version, '9.9.9');
  assert.match(found[2].errors[0], /widget\.json/);
});

test('widget host: creates every widget, starts the enabled ones (new widgets default to on)', async () => {
  const dir = tmp('widgets');
  writeWidget(dir, 'a', { order: 1 });
  writeWidget(dir, 'b', { order: 2 });
  const { host, log } = makeHost(dir, { enabled: { b: { enabled: false } } });
  assert.deepEqual(log, ['create:a', 'create:b']);
  await host.sync();
  assert.deepEqual(log.slice(2), ['start:a']);
  assert.deepEqual(host.list().map((w) => [w.id, w.enabled, w.status]), [
    ['a', true, 'running'],
    ['b', false, 'off'],
  ]);
  assert.equal(host.get('a').ctx.engine, 'services for a');
  assert.equal(host.get('a').ctx.dataDir, '/data/a');
  assert.equal(host.needsSetup('a'), true);
  assert.equal(host.needsSetup('b'), false); // not running
});

test('widget host: an incompatible widget is listed with the reason and never loaded', async () => {
  const dir = tmp('widgets');
  writeWidget(dir, 'old', { engineApi: '0.9' });
  writeWidget(dir, 'future', { engineApi: '1.99' });
  writeWidget(dir, 'ok');
  const { host, log } = makeHost(dir);
  await host.sync();
  assert.deepEqual(log, ['create:ok', 'start:ok']);
  const byId = Object.fromEntries(host.list().map((w) => [w.id, w]));
  assert.equal(byId.old.status, 'incompatible');
  assert.match(byId.old.message, /위젯을 업데이트/);
  assert.equal(byId.future.status, 'incompatible');
  assert.match(byId.future.message, /Desk Widgets를 업데이트/);
  assert.equal(byId.future.enabled, false);
});

test('widget host: rescan picks up installed, removed and reinstalled widgets', async () => {
  const dir = tmp('widgets');
  writeWidget(dir, 'a');
  const { host, log, ipc, purged } = makeHost(dir);
  await host.sync();
  assert.ok(ipc.handlers.has('a:ping'));

  // Installed while running
  writeWidget(dir, 'b');
  assert.deepEqual(host.rescan(), { added: ['b'], removed: [], updated: [] });
  await host.sync();
  assert.ok(log.includes('start:b'));

  // Nothing changed
  assert.deepEqual(host.rescan(), { added: [], removed: [], updated: [] });

  // Reinstalled (widget.json rewritten): stopped, modules purged, created and started again
  const file = path.join(dir, 'a', 'widget.json');
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(file, JSON.stringify({ id: 'a', name: 'A', engineApi: ENGINE_API, version: '2.0.0' }));
  fs.utimesSync(file, later, later);
  assert.deepEqual(host.rescan(), { added: [], removed: [], updated: ['a'] });
  assert.ok(purged.includes('a'));
  assert.ok(!ipc.handlers.has('a:ping'));
  await host.sync();
  assert.ok(ipc.handlers.has('a:ping'));
  assert.equal(host.get('a').manifest.version, '2.0.0');

  // Uninstalled: stopped, handlers gone, no longer listed
  fs.rmSync(path.join(dir, 'b'), { recursive: true });
  assert.deepEqual(host.rescan(), { added: [], removed: ['b'], updated: [] });
  assert.ok(log.includes('stop:b') && log.includes('cleanup:b'));
  assert.ok(!ipc.handlers.has('b:ping'));
  assert.deepEqual(host.list().map((w) => w.id), ['a']);
});

test('widget host: turning widgets on/off removes the stopped one\'s IPC and re-registers on start', async () => {
  const dir = tmp('widgets');
  writeWidget(dir, 'a', { order: 1 });
  writeWidget(dir, 'b', { order: 2 });
  const { host, log, ipc, enabled } = makeHost(dir, { enabled: { b: { enabled: false } } });
  await host.sync();
  enabled.a = { enabled: false };
  enabled.b = { enabled: true };
  await host.sync();
  assert.deepEqual(log.slice(3), ['start:b', 'stop:a', 'cleanup:a']);
  assert.ok(!ipc.handlers.has('a:ping'));
  enabled.a = { enabled: true };
  await host.sync();
  assert.ok(ipc.handlers.has('a:ping'));
});

test('widget host: engine features reach only running widgets', async () => {
  const dir = tmp('widgets');
  writeWidget(dir, 'a', { order: 1 });
  writeWidget(dir, 'b', { order: 2 });
  const { host, log } = makeHost(dir, { enabled: { b: { enabled: false } } });
  await host.sync();
  assert.deepEqual(host.desktopWindows(), ['win-a']);
  host.setPaused('locked');
  assert.ok(log.includes('paused:a:locked'));
  assert.ok(!log.some((l) => l.startsWith('paused:b')));
  assert.equal(host.focusAny(), false);
  assert.equal(await host.callSettings('b', 'echo', ['hi']), 'b:hi'); // settings work while off
  await assert.rejects(host.callSettings('a', 'missing'), /Unknown settings call/);
});

test('widget integrations: only allowed running peers can exchange calls and events', async () => {
  const dir = tmp('integrations');
  for (const id of ['dooray', 'mail', 'todo', 'calendar', 'clock']) writeWidget(dir, id, {
    integrationCapabilities: id === 'todo' ? ['todo-receive-external', 'todo-calendar-share'] : [],
  });
  const contexts = {};
  const enabled = {};
  const { host } = makeHost(dir, {
    enabled,
    load: (file) => ({ create(ctx) {
      contexts[ctx.id] = ctx;
      return {
        start() {
          if (ctx.id === 'todo') {
            ctx.integrations.expose('tasks.addExternal', (payload, caller) => ({ ok: true, title: payload.title, caller: caller.sourceId }));
            ctx.integrations.expose('tasks.snapshot', () => ({ ok: true, tasks: [] }));
          }
        },
        stop() {},
      };
    } }),
  });
  await host.sync();
  const dooray = contexts.dooray.integrations;
  const todo = contexts.todo.integrations;
  const calendar = contexts.calendar.integrations;
  assert.equal(dooray.status('todo').running, true);
  assert.equal(dooray.status('todo').engineApi, ENGINE_API);
  assert.equal(dooray.status('todo').engineVersion, require('../../package.json').version);
  assert.ok(dooray.status('todo').capabilities.includes('todo-receive-external'));
  assert.equal(dooray.status('todo').peerEnabled, false);
  assert.equal(todo.setEnabled('dooray', true), true);
  assert.equal(dooray.status('todo').peerEnabled, true);
  assert.equal(calendar.status('todo').peerEnabled, false, 'consent is specific to the peer');
  assert.equal(todo.setEnabled('calendar', true), true);
  assert.equal(calendar.status('todo').peerEnabled, true);
  assert.equal(contexts.clock.integrations.setEnabled('todo', true), false, 'unrelated widgets cannot opt in');
  assert.deepEqual(await dooray.call('todo', 'tasks.addExternal', { title: 'A' }), { ok: true, title: 'A', caller: 'dooray' });
  assert.deepEqual(await calendar.call('todo', 'tasks.snapshot'), { ok: true, tasks: [] });
  assert.deepEqual(await dooray.call('todo', 'tasks.snapshot'), { ok: false, code: 'route-denied' });
  assert.deepEqual(await contexts.clock.integrations.call('todo', 'tasks.addExternal', {}), { ok: false, code: 'route-denied' });
  assert.equal(dooray.expose('tasks.updateDue', () => ({ ok: true })), false);

  const events = [];
  calendar.onEvent('todo', 'tasks.changed', (payload) => events.push(payload));
  const statuses = [];
  calendar.onStatus('todo', (status) => statuses.push(status.running));
  assert.equal(todo.publish('tasks.changed', { revision: 1 }), true);
  await Promise.resolve();
  assert.deepEqual(events, [{ revision: 1 }]);
  assert.equal(dooray.onEvent('todo', 'tasks.changed', () => events.push('wrong')) instanceof Function, true);
  todo.publish('tasks.changed', { revision: 2 });
  await Promise.resolve();
  assert.equal(events.length, 2);

  enabled.todo = { enabled: false };
  await host.sync();
  await Promise.resolve();
  assert.deepEqual(statuses, [false]);
  assert.equal(dooray.status('todo').running, false);
  assert.deepEqual(await dooray.call('todo', 'tasks.addExternal', {}), { ok: false, code: 'target-unavailable' });
  enabled.todo = { enabled: true };
  await host.sync();
  await Promise.resolve();
  assert.deepEqual(statuses, [false, true]);
  assert.deepEqual(await dooray.call('todo', 'tasks.addExternal', { title: 'B' }), { ok: true, title: 'B', caller: 'dooray' });
  enabled.calendar = { enabled: false };
  await host.sync();
  assert.equal(calendar.onStatus('todo', () => {} ) instanceof Function, true);
  todo.publish('tasks.changed', { revision: 3 });
  assert.equal(events.length, 2);
  assert.deepEqual(await calendar.call('todo', 'tasks.snapshot'), { ok: false, code: 'source-unavailable' });
});

test('widget host: a widget whose code fails to load is listed as an error, the others run', async () => {
  const dir = tmp('widgets');
  writeWidget(dir, 'a');
  writeWidget(dir, 'b');
  const log = [];
  const { host } = makeHost(dir, {
    load: (file) => {
      if (file.includes(`${path.sep}a${path.sep}`)) throw new Error('boom');
      return fakeModule(log, 'b');
    },
  });
  await host.sync();
  assert.deepEqual([...host.widgets.keys()], ['b']);
  const a = host.list().find((w) => w.id === 'a');
  assert.equal(a.status, 'error');
  assert.equal(a.message, 'boom');
});

test('purgeModules forgets only that widget folder', () => {
  const dir = path.resolve('/w/dooray');
  const cache = { [path.join(dir, 'index.js')]: 1, [path.join(dir, 'x', 'y.js')]: 1, [path.resolve('/w/dooray2/index.js')]: 1 };
  purgeModules(dir, cache);
  assert.deepEqual(Object.keys(cache), [path.resolve('/w/dooray2/index.js')]);
});

test('widget watcher: notices a widget folder added and removed (debounced), and a folder created later', async () => {
  const root = tmp('watch');
  const dir = path.join(root, 'widgets');
  let changes = 0;
  const watcher = new WidgetWatcher({ dirs: [dir], onChange: () => changes++, debounceMs: 100, pollMs: 100 });
  watcher.start();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await settle(150);
    assert.equal(changes, 0); // folder does not exist yet
    fs.mkdirSync(dir);
    await settle(400);
    assert.equal(changes, 1); // attached by the poller, one initial change
    writeWidget(dir, 'a');
    writeWidget(dir, 'b');
    await settle(400);
    assert.equal(changes, 2); // two installs inside the debounce window -> one change
    fs.rmSync(path.join(dir, 'a'), { recursive: true });
    await settle(400);
    assert.equal(changes, 3);
  } finally {
    watcher.stop();
  }
});

test('the widgets in this repository have valid, compatible manifests and package info', () => {
  const found = discoverWidgets({ dirs: [path.join(__dirname, '..', '..', 'widgets')] });
  const byId = Object.fromEntries(found.map((f) => [f.manifest?.id, f]));
  assert.ok(byId.dooray && byId.clock, JSON.stringify(found.map((f) => f.errors)));
  for (const f of found) {
    assert.equal(checkEngineApi(f.manifest.engineApi), null, f.manifest.id);
    assert.ok(fs.existsSync(path.join(f.dir, f.manifest.main)), f.manifest.id);
    if (f.manifest.settings) for (const k of ['html', 'script']) assert.ok(fs.existsSync(path.join(f.dir, f.manifest.settings[k])), `${f.manifest.id} ${k}`);
    const raw = JSON.parse(fs.readFileSync(path.join(f.dir, 'widget.json'), 'utf8'));
    assert.match(raw.package?.productName || '', /^[A-Za-z][A-Za-z0-9]*$/, `${f.manifest.id} package.productName`);
  }
  // Widget code must not reach into the engine: it is installed in another folder.
  for (const f of found) {
    for (const file of fs.readdirSync(f.dir, { recursive: true })) {
      if (!String(file).endsWith('.js') || String(file).startsWith(`test${path.sep}`) || String(file).startsWith(`scripts${path.sep}`)) continue;
      const src = fs.readFileSync(path.join(f.dir, file), 'utf8');
      assert.ok(!/require\(['"][./]*engine\//.test(src) && !src.includes("'../../engine"), `${f.manifest.id}/${file} requires engine files`);
    }
  }
});
