// First-run widget picker (#96): what is offered, one-by-one installs, failures, an unreachable site, local installers.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('../main/updates');
const { WidgetPicker, DEFAULT_CHECKED } = require('../main/widget-picker');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dw-picker-test-'));
const PRODUCTS_URL = 'https://widgets.chilgong88.com/products.json';
const bodyOf = (id, version) => Buffer.from(`installer ${id} ${version}`);

function entry(id, version, extra = {}) {
  const body = bodyOf(id, version);
  const product = `${id[0].toUpperCase()}${id.slice(1)}Widget`;
  const file = `DeskWidgets-${product}-Setup-${version}.exe`;
  const tag = `widget-${id}-v${version}`;
  return {
    id, name: extra.name || id, description: `${id} description`, version, engineApi: '1.3', engineMin: '1.0.1',
    download: { version, tag, file, url: `https://github.com/Htaeyong/desk-widgets/releases/download/${tag}/${file}`, size: body.length, sha256: sha(body) },
    ...extra.raw,
  };
}

function productsJson(widgets) {
  const body = bodyOf('engine', '1.1.0');
  return {
    engine: { id: 'engine', name: 'Desk Widgets', version: '1.1.0', engineApi: '1.6', download: { version: '1.1.0', tag: 'engine-v1.1.0', file: 'DeskWidgets-Setup-1.1.0.exe', url: 'https://github.com/Htaeyong/desk-widgets/releases/download/engine-v1.1.0/DeskWidgets-Setup-1.1.0.exe', size: body.length, sha256: sha(body) } },
    widgets,
  };
}

function setup({ widgets, installed = [], fail = {}, siteDown = false, pickFile, confirmUnverified, waitTimeoutMs = 3 }) {
  const dir = tmpDir();
  const present = [...installed];
  const launched = [];
  const routes = { [PRODUCTS_URL]: siteDown ? { error: 'offline' } : { body: JSON.stringify(productsJson(widgets)) } };
  for (const w of widgets) routes[w.download.url] = fail[w.id] ? { status: 500 } : { body: bodyOf(w.id, w.download.version) };
  const fetchFn = async (url) => {
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404 });
    if (r.error) throw new Error(r.error);
    return new Response(r.body ?? null, { status: r.status || 200 });
  };
  const updates = new u.UpdateManager({
    engineVersion: '1.1.0', engineApi: '1.6', listWidgets: () => present.map((id) => ({ id, name: id, version: '1.1.0', source: 'installed' })),
    fetchFn, stateFile: path.join(dir, 'updates.json'), tempRoot: path.join(dir, 'tmp'), log: () => {},
    launch: async (file, item) => {
      launched.push(item.id);
      return '';
    },
  });
  const picker = new WidgetPicker({
    updates, listWidgets: () => present.map((id) => ({ id })), pickFile, confirmUnverified, waitTimeoutMs, pollMs: 1, log: () => {},
    // The installer "finishes" while the picker waits: the widget appears in the engine's list.
    sleep: async () => {
      const next = launched.find((id) => !present.includes(id) && !(setup.noFinish || []).includes(id));
      if (next) present.push(next);
    },
  });
  return { picker, updates, launched, present, dir };
}

const ALL = () => [entry('clock', '1.1.0'), entry('calendar', '1.1.0'), entry('memo', '1.1.0'), entry('mail', '1.1.0')];

test('catalogRows: unreleased (0.0.x), prerelease, frozen and download-less widgets are never offered', () => {
  const raw = productsJson([
    entry('clock', '1.1.0'),
    entry('todonote', '0.0.3'),
    entry('beta', '1.2.0-test.1'),
    entry('todo', '1.1.0', { raw: { frozen: { since: '1.1.0', successor: 'todonote' } } }),
    { id: 'nodl', name: 'nodl', version: '1.0.0' },
    entry('newapi', '1.1.0', { raw: { engineMin: '1.5.0' } }),
    entry('calendar', '1.1.0'),
  ]);
  const products = u.parseProducts(raw);
  assert.deepEqual([...products.widgets.keys()], ['clock', 'todo', 'newapi', 'calendar'], 'todonote 0.0.3 and the test build are dropped when parsing');
  const rows = u.catalogRows(products, { engineVersion: '1.1.0', engineApi: '1.6', installedIds: new Set(['calendar']) });
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [['clock', 'available'], ['newapi', 'needs-engine'], ['calendar', 'installed']]);
  // Even a hand-built entry with an unreleased version is filtered at this level too.
  products.widgets.set('sneaky', { ...products.widgets.get('clock'), id: 'sneaky', version: '0.0.9' });
  assert.ok(!u.catalogRows(products, { engineVersion: '1.1.0', engineApi: '1.6' }).some((r) => r.id === 'sneaky'));
  assert.equal(u.isUnreleasedVersion('0.0.1'), true);
  assert.equal(u.isUnreleasedVersion('0.1.0'), false);
  assert.equal(u.isUnreleasedVersion('1.0.0'), false);
});

test('picker: loads the list, checks clock, calendar and sticky notes by default', async () => {
  const { picker } = setup({ widgets: ALL() });
  assert.equal(picker.snapshot().rows.length, 0, 'nothing before the list is loaded');
  const snap = await picker.load();
  assert.equal(snap.error, null);
  assert.deepEqual(snap.rows.map((r) => [r.id, r.checked]), [['clock', true], ['calendar', true], ['memo', true], ['mail', false]]);
  assert.deepEqual(DEFAULT_CHECKED, ['clock', 'calendar', 'memo']);
  assert.equal(snap.rows[0].description, 'clock description');
});

test('picker: installs one widget at a time and waits for each to appear before the next installer opens', async () => {
  const { picker, launched, present } = setup({ widgets: ALL() });
  await picker.load();
  const seen = [];
  picker.on('change', (s) => seen.push(s.queue.map((q) => `${q.id}:${q.state}`).join(',')));
  await picker.start(['clock', 'memo']);
  assert.deepEqual(launched, ['clock', 'memo']);
  assert.deepEqual(present, ['clock', 'memo']);
  assert.deepEqual(picker.snapshot().queue.map((q) => q.state), ['done', 'done']);
  // memo's installer was never opened while clock was still "waiting".
  assert.ok(seen.some((s) => s.startsWith('clock:waiting,memo:queued')));
  assert.ok(!seen.some((s) => s.includes('clock:waiting') && s.includes('memo:working')));
});

test('picker: ids that are not on offer are ignored (unreleased, installed, unknown)', async () => {
  const { picker, launched } = setup({ widgets: [...ALL(), entry('todonote', '0.0.3')], installed: ['mail'] });
  await picker.load();
  await picker.start(['todonote', 'mail', 'nope', '../x']);
  assert.deepEqual(launched, []);
  assert.deepEqual(picker.snapshot().queue, []);
  assert.deepEqual(picker.snapshot().rows.map((r) => r.id), ['clock', 'calendar', 'memo', 'mail']);
});

test('picker: a failed download is reported and the next widget still installs; retry works', async () => {
  const { picker, launched } = setup({ widgets: ALL(), fail: { clock: true } });
  await picker.load();
  await picker.start(['clock', 'calendar']);
  const q = picker.snapshot().queue;
  assert.equal(q[0].state, 'failed');
  assert.match(q[0].message, /HTTP 500/);
  assert.equal(q[1].state, 'done');
  assert.deepEqual(launched, ['calendar']);
  await picker.retry('clock'); // still failing: back to failed, no crash
  assert.equal(picker.snapshot().queue[0].state, 'failed');
});

test('picker: an installer that never finishes (UAC cancelled) ends as stalled and can be skipped', async () => {
  setup.noFinish = ['clock'];
  try {
    const { picker, launched } = setup({ widgets: ALL() });
    await picker.load();
    await picker.start(['clock', 'calendar']);
    assert.deepEqual(picker.snapshot().queue.map((q) => q.state), ['stalled', 'done']);
    assert.deepEqual(launched, ['clock', 'calendar']);

    const skipper = setup({ widgets: ALL(), waitTimeoutMs: 60 * 1000 });
    await skipper.picker.load();
    skipper.picker.sleep = async () => skipper.picker.skip('clock'); // the user presses "skip" while it waits
    await skipper.picker.start(['clock']);
    assert.equal(skipper.picker.snapshot().queue[0].state, 'skipped');
  } finally {
    setup.noFinish = [];
  }
});

test('picker: site unreachable shows a message, offers nothing and installs nothing', async () => {
  const { picker, launched } = setup({ widgets: ALL(), siteDown: true });
  const snap = await picker.load();
  assert.match(snap.error, /네트워크 오류/);
  assert.deepEqual(snap.rows, []);
  await picker.start(['clock']);
  assert.deepEqual(launched, []);
  assert.equal(picker.snapshot().queue.length, 0);
});

test('picker: the first-run flag comes from the engine', async () => {
  const dir = tmpDir();
  let first = true;
  const updates = new u.UpdateManager({ engineVersion: '1.1.0', engineApi: '1.6', listWidgets: () => [], stateFile: path.join(dir, 'u.json'), tempRoot: path.join(dir, 't'), launch: async () => '', log: () => {} });
  const picker = new WidgetPicker({ updates, listWidgets: () => [], isFirstRun: () => first });
  assert.equal(picker.snapshot().firstRun, true);
  first = false;
  assert.equal(picker.snapshot().firstRun, false);
});

// ---------- an installer file from disk ----------

function localFile(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

test('local installer: only the published widget file runs (a copy of it), other files are refused', async () => {
  const widgets = ALL();
  const ctx = setup({ widgets, pickFile: async () => ctx.next });
  await ctx.picker.load();
  const dl = tmpDir();

  ctx.next = localFile(dl, 'notes.txt', 'x');
  assert.match((await ctx.picker.openLocalInstaller()).message, /위젯 설치 파일/);
  ctx.next = localFile(dl, 'DeskWidgets-Setup-1.1.0.exe', bodyOf('engine', '1.1.0'));
  assert.match((await ctx.picker.openLocalInstaller()).message, /위젯 설치 파일/, 'the engine installer is not a widget installer');
  ctx.next = localFile(dl, 'DeskWidgets-ClockWidget-Setup-1.1.0.exe', 'tampered bytes!!');
  assert.match((await ctx.picker.openLocalInstaller()).message, /다릅니다/);
  assert.deepEqual(ctx.launched, []);

  ctx.next = localFile(dl, 'DeskWidgets-ClockWidget-Setup-1.1.0.exe', bodyOf('clock', '1.1.0'));
  const res = await ctx.picker.openLocalInstaller();
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(ctx.launched, ['local']);
  assert.match(ctx.picker.snapshot().localMessage, /실행했습니다/);
});

test('local installer: without a products.json it runs only after the user confirms it cannot be checked', async () => {
  let confirmed = false;
  const dl = tmpDir();
  const file = localFile(dl, 'DeskWidgets-ClockWidget-Setup-1.1.0.exe', bodyOf('clock', '1.1.0'));
  const ctx = setup({ widgets: ALL(), siteDown: true, pickFile: async () => file, confirmUnverified: async () => confirmed });
  await ctx.picker.load();
  assert.match((await ctx.picker.openLocalInstaller()).message, /비교할 수 없어/);
  assert.deepEqual(ctx.launched, []);
  assert.deepEqual(fs.readdirSync(path.join(ctx.dir, 'tmp')).flatMap((d) => fs.readdirSync(path.join(ctx.dir, 'tmp', d))), [], 'the checked copy is removed again');
  confirmed = true;
  assert.equal((await ctx.picker.openLocalInstaller()).ok, true);
  assert.deepEqual(ctx.launched, ['local']);
  // Cancelling the file dialog is not an error.
  const cancelled = setup({ widgets: ALL(), pickFile: async () => null });
  assert.equal((await cancelled.picker.openLocalInstaller()).cancelled, true);
});
