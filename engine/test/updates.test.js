// In-app updates (#104): versions, products.json, host allow-list, download checks, engine gating, schedule.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('../main/updates');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dw-update-test-'));
const URL_OF = (tag, file) => `https://github.com/Htaeyong/desk-widgets/releases/download/${tag}/${file}`;

function download(id, version, body = Buffer.from(`installer ${id} ${version}`), productName = 'X') {
  const file = id === 'engine' ? `DeskWidgets-Setup-${version}.exe` : `DeskWidgets-${productName}-Setup-${version}.exe`;
  const tag = id === 'engine' ? `engine-v${version}` : `widget-${id}-v${version}`;
  return { version, tag, file, url: URL_OF(tag, file), size: body.length, sha256: sha(body) };
}

function products({ engine = '1.1.0', widgets = {} } = {}) {
  return {
    engine: { id: 'engine', name: 'Desk Widgets', version: engine, engineApi: '1.6', download: download('engine', engine) },
    widgets: Object.entries(widgets).map(([id, w]) => ({ id, name: w.name || id, version: w.version, engineApi: w.engineApi || '1.3', engineMin: w.engineMin || '1.0.1', download: download(id, w.version, undefined, w.productName || 'Y') })),
  };
}

// ---------- versions ----------

test('compareVersions: numeric major.minor.patch, invalid gives NaN', () => {
  assert.ok(u.compareVersions('1.0.10', '1.0.9') > 0);
  assert.ok(u.compareVersions('1.1.0', '1.0.99') > 0);
  assert.ok(u.compareVersions('2.0.0', '10.0.0') < 0);
  assert.equal(u.compareVersions('1.0.4', '1.0.4'), 0);
  for (const bad of ['', '1.0', '1.0.0-beta', 'v1.0.0', null, undefined, '1.0.0.0']) assert.ok(Number.isNaN(u.compareVersions(bad, '1.0.0')), String(bad));
  assert.equal(u.isNewer('1.0.4', '1.0.4'), false);
  assert.equal(u.isNewer('1.1.0', '1.0.4'), true);
  assert.equal(u.isNewer('1.1.0', ''), false);
});

// ---------- hosts ----------

test('host allow-list: installers only from this repository release downloads and GitHub redirect hosts', () => {
  const first = (url, dev) => u.isAllowedDownloadUrl(url, { first: true, dev });
  const hop = (url, dev) => u.isAllowedDownloadUrl(url, { dev });
  assert.equal(first(URL_OF('engine-v1.1.0', 'DeskWidgets-Setup-1.1.0.exe')), true);
  assert.equal(first('http://github.com/Htaeyong/desk-widgets/releases/download/a/b.exe'), false, 'http');
  assert.equal(first('https://github.com/someone/else/releases/download/a/b.exe'), false, 'other repo');
  assert.equal(first('https://github.com:8443/Htaeyong/desk-widgets/releases/download/a/b.exe'), false, 'port');
  assert.equal(first('https://user:pw@github.com/Htaeyong/desk-widgets/releases/download/a/b.exe'), false, 'credentials');
  assert.equal(first('https://github.com.evil.test/Htaeyong/desk-widgets/releases/download/a/b.exe'), false);
  assert.equal(first('https://objects.githubusercontent.com/x'), false, 'redirect host is not a valid start');
  assert.equal(hop('https://objects.githubusercontent.com/github-production-release-asset/1?x=1'), true);
  assert.equal(hop('https://release-assets.githubusercontent.com/github-production-release-asset/1'), true);
  assert.equal(hop('https://github.com/Htaeyong/desk-widgets/releases/download/a/b.exe'), true);
  assert.equal(hop('https://evil.test/x.exe'), false);
  assert.equal(hop('http://objects.githubusercontent.com/x'), false);
  assert.equal(hop('not a url'), false);
  // Local test server only in dev mode.
  assert.equal(first('http://127.0.0.1:5077/x.exe'), false);
  assert.equal(first('http://127.0.0.1:5077/x.exe', true), true);
  assert.equal(hop('http://localhost:5077/x.exe', true), true);
  assert.equal(u.isAllowedProductsUrl(u.PRODUCTS_URL), true);
  assert.equal(u.isAllowedProductsUrl('https://evil.test/products.json'), false);
  assert.equal(u.isAllowedProductsUrl('http://127.0.0.1:5077/products.json'), false);
  assert.equal(u.isAllowedProductsUrl('http://127.0.0.1:5077/products.json', { dev: true }), true);
});

// ---------- products.json ----------

test('parseProducts: keeps entries with a valid download, drops the rest', () => {
  const p = products({ widgets: { dooray: { version: '1.0.4' }, clock: { version: '1.0.1' } } });
  p.widgets.push({ id: 'mail', version: '1.0.2', engineApi: '1.3' }); // released before #104: no download
  p.widgets.push({ id: 'bad', version: '1.0.0', download: { ...download('bad', '1.0.0'), url: 'https://evil.test/DeskWidgets-Y-Setup-1.0.0.exe' } });
  p.widgets.push({ id: 'bad2', version: '1.0.0', download: { ...download('bad2', '1.0.0'), sha256: 'abc' } });
  p.widgets.push({ id: 'bad3', version: '1.0.0', download: { ...download('bad3', '1.0.0'), file: 'other.exe' } });
  p.widgets.push({ id: 'bad4', version: '1.0.0', download: { ...download('bad4', '1.0.0'), url: URL_OF('t', 'DeskWidgets-Z-Setup-1.0.0.exe') } });
  p.widgets.push({ id: 'bad5', version: '1.0.0', download: { ...download('bad5', '1.0.0'), size: 0 } });
  p.widgets.push({ id: '../x', version: '1.0.0', download: download('x', '1.0.0') });
  const parsed = u.parseProducts(p);
  assert.equal(parsed.engine.version, '1.1.0');
  assert.equal(parsed.engine.download.file, 'DeskWidgets-Setup-1.1.0.exe');
  assert.deepEqual([...parsed.widgets.keys()], ['dooray', 'clock']);
  assert.equal(parsed.widgets.get('dooray').engineMin, '1.0.1');
  for (const broken of [null, {}, { engine: {} }, { engine: {}, widgets: {} }, 'x']) assert.throws(() => u.parseProducts(broken), /형식/);
});

test('parseProducts: the real products.json parses (entries without download are skipped)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'public', 'products.json'), 'utf8'));
  const parsed = u.parseProducts(real);
  for (const w of real.widgets) assert.equal(parsed.widgets.has(w.id), Boolean(w.download), w.id);
  assert.equal(Boolean(parsed.engine), Boolean(real.engine.download));
});

// ---------- what to offer, engineMin gating ----------

test('computeUpdates: available, current, unknown, dev widgets skipped', () => {
  const parsed = u.parseProducts(products({ engine: '1.1.0', widgets: { dooray: { version: '1.0.4' }, clock: { version: '1.0.0' } } }));
  const items = u.computeUpdates({
    products: parsed,
    engineVersion: '1.0.4',
    engineApi: '1.6',
    widgets: [
      { id: 'dooray', name: '두레이', version: '1.0.3', source: 'installed' },
      { id: 'clock', name: '시계', version: '1.0.0', source: 'installed' },
      { id: 'memo', name: '노트', version: '1.0.0', source: 'installed' },
      { id: 'mine', name: '개발', version: '0.0.1', source: 'dev' },
      { dir: 'C:/broken', status: 'error' },
    ],
  });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(by), ['engine', 'dooray', 'clock', 'memo']);
  assert.equal(by.engine.status, 'available');
  assert.equal(by.engine.download.file, 'DeskWidgets-Setup-1.1.0.exe');
  assert.equal(by.dooray.status, 'available');
  assert.equal(by.dooray.current, '1.0.3');
  assert.equal(by.dooray.latest, '1.0.4');
  assert.equal(by.clock.status, 'current');
  assert.equal(by.clock.download, null);
  assert.equal(by.memo.status, 'unknown');
  // A newer installed version than the site (local build) is not a downgrade offer.
  const newer = u.computeUpdates({ products: parsed, engineVersion: '1.2.0', engineApi: '1.6', widgets: [] });
  assert.equal(newer[0].status, 'current');
});

test('computeUpdates: a widget update that needs a newer engine says so instead of installing', () => {
  const parsed = u.parseProducts(products({
    engine: '1.2.0',
    widgets: {
      dooray: { version: '1.1.0', engineMin: '1.2.0', engineApi: '1.6' }, // engine version too old
      mail: { version: '1.1.0', engineMin: '1.0.1', engineApi: '1.7' }, // API level not supported
      clock: { version: '1.1.0', engineMin: '1.1.0', engineApi: '1.6' }, // fine
    },
  }));
  const widgets = ['dooray', 'mail', 'clock'].map((id) => ({ id, name: id, version: '1.0.0', source: 'installed' }));
  const by = Object.fromEntries(u.computeUpdates({ products: parsed, engineVersion: '1.1.0', engineApi: '1.6', widgets }).map((i) => [i.id, i]));
  assert.equal(by.dooray.status, 'needs-engine');
  assert.equal(by.dooray.engineMin, '1.2.0');
  assert.equal(by.dooray.download, null, 'no install button');
  assert.equal(by.mail.status, 'needs-engine');
  assert.equal(by.clock.status, 'available');
  assert.equal(by.engine.status, 'available');
});

// ---------- verify ----------

test('verifyFile: size and SHA-256 must match; a mismatch deletes the file', async () => {
  const dir = tmpDir();
  const data = Buffer.from('the real installer');
  const file = path.join(dir, 'a.exe');
  fs.writeFileSync(file, data);
  assert.deepEqual(await u.verifyFile(file, { size: data.length, sha256: sha(data) }), { size: data.length, sha256: sha(data) });
  await assert.rejects(u.verifyFile(file, { size: data.length, sha256: sha(Buffer.from('other')) }), (e) => e.code === 'hash');
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, data);
  await assert.rejects(u.verifyFile(file, { size: data.length + 1, sha256: sha(data) }), (e) => e.code === 'size');
  assert.equal(fs.existsSync(file), false);
});

test('verifyPublisher: off by default; when required and not implemented it refuses', async () => {
  assert.equal(u.REQUIRE_SIGNATURE, false);
  assert.deepEqual(await u.verifyPublisher('x.exe'), { checked: false });
  await assert.rejects(u.verifyPublisher('x.exe', { required: true }), (e) => e.code === 'signature');
});

// ---------- download ----------

/** fetch stand-in: url -> { status, headers, body (Buffer) }. Records the URLs asked for. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, redirect: opts?.redirect });
    const r = typeof routes[url] === 'function' ? routes[url]() : routes[url];
    if (!r) return new Response('not found', { status: 404 });
    if (r.error) throw new Error(r.error);
    return new Response(r.body ?? null, { status: r.status || 200, headers: r.headers || {} });
  };
  fn.calls = calls;
  return fn;
}

test('downloadFile: follows allowed redirects itself and saves the file', async () => {
  const body = Buffer.alloc(100000, 7);
  const start = URL_OF('widget-x-v1.0.1', 'DeskWidgets-X-Setup-1.0.1.exe');
  const asset = 'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=abc';
  const fetchFn = fakeFetch({ [start]: { status: 302, headers: { location: asset } }, [asset]: { body, headers: { 'content-length': String(body.length) } } });
  const dest = path.join(tmpDir(), 'DeskWidgets-X-Setup-1.0.1.exe');
  const progress = [];
  await u.downloadFile({ url: start, dest, expected: { size: body.length }, fetchFn, onProgress: (n) => progress.push(n) });
  assert.deepEqual(fs.readFileSync(dest), body);
  assert.deepEqual(fetchFn.calls.map((c) => c.url), [start, asset]);
  assert.ok(fetchFn.calls.every((c) => c.redirect === 'manual'));
  assert.equal(progress.at(-1), body.length);
});

test('downloadFile: a redirect to another host, http or too many hops stops before anything is saved', async () => {
  const start = URL_OF('t', 'DeskWidgets-X-Setup-1.0.1.exe');
  for (const location of ['https://evil.test/x.exe', 'http://objects.githubusercontent.com/x']) {
    const fetchFn = fakeFetch({ [start]: { status: 302, headers: { location } }, [location]: { body: 'x' } });
    const dest = path.join(tmpDir(), 'a.exe');
    await assert.rejects(u.downloadFile({ url: start, dest, expected: { size: 1 }, fetchFn }), (e) => e.code === 'host');
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fetchFn.calls.length, 1, 'the bad host is never contacted');
  }
  const loop = fakeFetch({ [start]: { status: 302, headers: { location: start } } });
  await assert.rejects(u.downloadFile({ url: start, dest: path.join(tmpDir(), 'a.exe'), expected: { size: 1 }, fetchFn: loop }), (e) => e.code === 'http');
  await assert.rejects(u.downloadFile({ url: 'https://evil.test/a.exe', dest: path.join(tmpDir(), 'a.exe'), expected: { size: 1 }, fetchFn: loop }), (e) => e.code === 'host');
});

test('downloadFile: larger than published, HTTP and network errors remove the partial file', async () => {
  const start = URL_OF('t', 'DeskWidgets-X-Setup-1.0.1.exe');
  const cases = [
    [{ body: Buffer.alloc(50) }, 'size'], // no content-length, body too long
    [{ body: Buffer.alloc(50), headers: { 'content-length': '50' } }, 'size'],
    [{ status: 500, body: 'x' }, 'http'],
    [{ error: 'ECONNRESET' }, 'network'],
  ];
  for (const [route, code] of cases) {
    const dest = path.join(tmpDir(), 'a.exe');
    await assert.rejects(u.downloadFile({ url: start, dest, expected: { size: 10 }, fetchFn: fakeFetch({ [start]: route }) }), (e) => e.code === code, code);
    assert.equal(fs.existsSync(dest), false, code);
  }
});

// ---------- schedule ----------

function fakeTimers() {
  const t = { timeouts: [], intervals: [] };
  t.setTimeout = (fn, ms) => (t.timeouts.push({ fn, ms }), t.timeouts.at(-1));
  t.setInterval = (fn, ms) => (t.intervals.push({ fn, ms }), t.intervals.at(-1));
  t.clearTimeout = (h) => (t.timeouts = t.timeouts.filter((x) => x !== h));
  t.clearInterval = (h) => (t.intervals = t.intervals.filter((x) => x !== h));
  return t;
}

test('scheduler: delayed check at startup, then once a day, nothing when turned off', async () => {
  const timers = fakeTimers();
  let now = 1000;
  let last = 0;
  let enabled = true;
  const checks = [];
  const s = new u.UpdateScheduler({
    check: (o) => {
      checks.push(o);
      last = now;
    },
    isEnabled: () => enabled,
    getLastCheck: () => last,
    now: () => now,
    timers,
  });
  s.start();
  assert.equal(timers.timeouts[0].ms, 2 * 60 * 1000);
  assert.equal(timers.intervals[0].ms, 60 * 60 * 1000);
  await timers.timeouts[0].fn();
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0], { manual: false });
  now += 23 * 3600 * 1000;
  await timers.intervals[0].fn();
  assert.equal(checks.length, 1, 'not yet a day');
  now += 3600 * 1000;
  await timers.intervals[0].fn();
  assert.equal(checks.length, 2, 'a day later');
  enabled = false;
  now += 48 * 3600 * 1000;
  await timers.intervals[0].fn();
  assert.equal(checks.length, 2, 'turned off');
  assert.equal(s.due({ startup: true }), false);
  s.stop();
  assert.equal(timers.timeouts.length + timers.intervals.length, 0);
});

test('scheduler: a failing check does not throw out of the timer', async () => {
  const s = new u.UpdateScheduler({ check: async () => { throw new Error('offline'); }, isEnabled: () => true, getLastCheck: () => 0, timers: fakeTimers() });
  await s.tick();
});

// ---------- manager ----------

function manager({ productsJson, routes = {}, widgets = [], engineVersion = '1.0.4', launch = async () => '', onNew = () => {} }) {
  const dir = tmpDir();
  const url = 'http://127.0.0.1:5077/products.json';
  const fetchFn = fakeFetch({ [url]: { body: JSON.stringify(productsJson) }, ...routes });
  const m = new u.UpdateManager({ engineVersion, engineApi: '1.6', listWidgets: () => widgets, fetchFn, productsUrl: url, dev: true, stateFile: path.join(dir, 'updates.json'), tempRoot: path.join(dir, 'tmp'), launch, onNew, log: () => {} });
  return { m, dir, fetchFn };
}

test('manager: refuses a products URL outside the allow-list', () => {
  assert.throws(() => new u.UpdateManager({ productsUrl: 'https://evil.test/products.json', stateFile: path.join(tmpDir(), 's.json') }), /not allowed/);
  assert.throws(() => new u.UpdateManager({ productsUrl: 'http://127.0.0.1/products.json', stateFile: path.join(tmpDir(), 's.json') }), /not allowed/);
});

test('manager: check notifies a new version once, manual checks never show a card', async () => {
  const seen = [];
  const { m } = manager({ productsJson: products({ engine: '1.1.0' }), onNew: (items) => seen.push(items.map((i) => `${i.id}@${i.latest}`)) });
  const snap = await m.check();
  assert.equal(snap.error, null);
  assert.equal(snap.items[0].status, 'available');
  assert.equal(snap.items[0].download.url, undefined, 'the renderer gets no URL');
  assert.ok(snap.lastCheck);
  await m.check();
  assert.deepEqual(seen, [['engine@1.1.0']]);
  const second = manager({ productsJson: products({ engine: '1.1.0' }), onNew: () => seen.push('manual') });
  await second.m.check({ manual: true });
  assert.equal(seen.length, 1);
});

test('manager: network and format errors are shown, not thrown', async () => {
  const { m } = manager({ productsJson: { nope: true } });
  assert.match((await m.check()).error, /형식/);
  m.fetchFn = fakeFetch({});
  assert.match((await m.check()).error, /HTTP 404/);
});

test('manager: install downloads, verifies and launches; a wrong hash never launches', async () => {
  const body = Buffer.from('real widget installer bytes');
  const p = products({ widgets: { clock: { version: '1.0.1', productName: 'ClockWidget' } } });
  p.widgets[0].download = { ...p.widgets[0].download, url: 'http://127.0.0.1:5077/DeskWidgets-ClockWidget-Setup-1.0.1.exe', size: body.length, sha256: sha(body) };
  const launched = [];
  const routes = { 'http://127.0.0.1:5077/DeskWidgets-ClockWidget-Setup-1.0.1.exe': { body } };
  const { m } = manager({ productsJson: p, routes, widgets: [{ id: 'clock', name: '시계', version: '1.0.0', source: 'installed' }], launch: async (file, item) => (launched.push([file, item.id]), '') });
  await m.check();
  assert.equal((await m.install('engine')).ok, false, 'engine download not routed: error');
  assert.equal(m.snapshot().items[0].job.phase, 'error');
  const res = await m.install('clock');
  assert.equal(res.ok, true, res.message);
  assert.equal(launched.length, 1);
  assert.equal(path.basename(launched[0][0]), 'DeskWidgets-ClockWidget-Setup-1.0.1.exe');
  assert.deepEqual(fs.readFileSync(launched[0][0]), body);
  assert.equal(m.snapshot().items.find((i) => i.id === 'clock').job.phase, 'launched');

  // Same size, other bytes: refused and deleted.
  const tampered = Buffer.from(body).fill(0x41, 0, 4);
  const bad = manager({ productsJson: p, routes: { 'http://127.0.0.1:5077/DeskWidgets-ClockWidget-Setup-1.0.1.exe': { body: tampered } }, widgets: [{ id: 'clock', name: '시계', version: '1.0.0', source: 'installed' }], launch: async () => assert.fail('must not launch') });
  await bad.m.check();
  const r = await bad.m.install('clock');
  assert.equal(r.ok, false);
  assert.match(r.message, /SHA-256/);
  const left = fs.readdirSync(path.join(bad.dir, 'tmp')).flatMap((d) => fs.readdirSync(path.join(bad.dir, 'tmp', d)));
  assert.deepEqual(left, []);

  // A cancelled UAC prompt is an error the user can retry.
  const cancel = manager({ productsJson: p, routes, widgets: [{ id: 'clock', name: '시계', version: '1.0.0', source: 'installed' }], launch: async () => '취소됨' });
  await cancel.m.check();
  assert.equal((await cancel.m.install('clock')).message, '취소됨');
  assert.equal((await cancel.m.install('nope')).ok, false);
});

test('manager: after the widget installer finished, recompute marks it current and clears the job', async () => {
  const body = Buffer.from('x');
  const p = products({ widgets: { clock: { version: '1.0.1', productName: 'ClockWidget' } } });
  p.widgets[0].download = { ...p.widgets[0].download, url: 'http://127.0.0.1:5077/DeskWidgets-ClockWidget-Setup-1.0.1.exe', size: 1, sha256: sha(body) };
  const widgets = [{ id: 'clock', name: '시계', version: '1.0.0', source: 'installed' }];
  const { m } = manager({ productsJson: p, routes: { 'http://127.0.0.1:5077/DeskWidgets-ClockWidget-Setup-1.0.1.exe': { body } }, widgets });
  await m.check();
  await m.install('clock');
  widgets[0].version = '1.0.1';
  m.recompute();
  const clock = m.snapshot().items.find((i) => i.id === 'clock');
  assert.equal(clock.status, 'current');
  assert.equal(clock.job, null);
  assert.deepEqual(m.pending().map((i) => i.id), ['engine']);
});

test('manager: cleanupTemp removes earlier downloads', () => {
  const { m, dir } = manager({ productsJson: products() });
  fs.mkdirSync(path.join(dir, 'tmp', 'old'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tmp', 'old', 'a.exe'), 'x');
  m.cleanupTemp();
  assert.equal(fs.existsSync(path.join(dir, 'tmp')), false);
});

test('manager: the snapshot a check resolves with is no longer "checking"', async () => {
  const { m } = manager({ productsJson: products() });
  const pending = m.check({ manual: true });
  assert.equal(m.snapshot().checking, true);
  assert.equal(m.check(), pending, 'one check at a time');
  assert.equal((await pending).checking, false);
});
