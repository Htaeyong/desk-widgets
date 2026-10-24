// Download site (#99): products.json stays in sync with the manifests, and release assets map to the right buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildProducts } = require('../../scripts/site-build');
const { productInfo } = require('../../scripts/release');
const site = require('../../site/public/app.js');

const root = path.join(__dirname, '..', '..');
const products = buildProducts();

function release(tag, assets, extra = {}) {
  return { tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}`, assets: assets.map((name) => ({ name, browser_download_url: `https://example.test/${tag}/${name}` })), ...extra };
}

test('products.json is up to date (run npm run site:build)', () => {
  const file = JSON.parse(fs.readFileSync(path.join(root, 'site', 'public', 'products.json'), 'utf8'));
  assert.deepEqual(file, products);
  for (const w of products.widgets) {
    assert.ok(w.name && w.description && w.productName && w.version && w.engineApi, w.id);
    if (w.image) assert.ok(fs.existsSync(path.join(root, 'site', 'public', w.image)), w.image);
  }
  assert.ok(fs.existsSync(path.join(root, 'site', 'public', 'img', 'hero.jpg')));
});

test('showcase.json: every widget has features and existing screenshots (#102)', () => {
  const showcase = JSON.parse(fs.readFileSync(path.join(root, 'site', 'public', 'showcase.json'), 'utf8'));
  assert.deepEqual(Object.keys(showcase).sort(), products.widgets.map((w) => w.id).sort());
  for (const [id, w] of Object.entries(showcase)) {
    assert.ok(w.features.length >= 3 && w.requires && w.images.length >= 1, id);
    for (const image of w.images) {
      assert.ok(image.caption, `${id} ${image.src}`);
      assert.ok(fs.existsSync(path.join(root, 'site', 'public', image.src)), image.src);
      assert.ok(fs.existsSync(path.join(root, 'docs', 'images', path.basename(image.src))), image.src);
    }
  }
});

test('engine requirement: each widget maps its API level to a released engine version', () => {
  const { ENGINE_FOR_API } = require('../../scripts/site-build');
  const { ENGINE_API } = require('../main/widgets');
  // The newest API level maps to a released engine no newer than this one (1.1.0 added no API level, #104).
  assert.ok(site.compareVersions(ENGINE_FOR_API[ENGINE_API], products.engine.version) <= 0, 'newest API level is in the current engine');
  for (const w of products.widgets) assert.match(w.engineMin || '', /^\d+\.\d+\.\d+$/, w.id);
  assert.equal(products.widgets.find((w) => w.id === 'calendar').engineMin, '1.0.1');
  assert.equal(products.widgets.find((w) => w.id === 'dooray').engineMin, '1.0.0');
  assert.equal(products.widgets.find((w) => w.id === 'system-monitor').engineMin, '1.0.4');
});

test('asset names match what scripts/release.js produces', () => {
  assert.equal(site.assetName(products.engine, products.engine.version), path.basename(productInfo('engine').asset));
  for (const w of products.widgets) {
    assert.equal(site.assetName(w, w.version), path.basename(productInfo(w.id).asset), w.id);
  }
});

test('pickLatest: newest release per product, correct installer, junk ignored', () => {
  const clock = products.widgets.find((w) => w.id === 'clock');
  const sm = products.widgets.find((w) => w.id === 'system-monitor');
  const releases = [
    release('engine-v1.0.4', ['DeskWidgets-Setup-1.0.4.exe']),
    release('engine-v1.0.10', ['DeskWidgets-Setup-1.0.10.exe']),
    release('engine-v2.0.0', ['DeskWidgets-Setup-2.0.0.exe'], { draft: true }),
    release('engine-v3.0.0', ['DeskWidgets-Setup-3.0.0.exe'], { prerelease: true }),
    release('widget-clock-v1.0.0', [`DeskWidgets-${clock.productName}-Setup-1.0.0.exe`]),
    release('widget-system-monitor-v0.0.1', [`DeskWidgets-${sm.productName}-Setup-0.0.1.exe`]),
    release('widget-mail-v9.9.9', ['wrong-name.exe']),
    release('widget-unknown-v1.0.0', ['DeskWidgets-X-Setup-1.0.0.exe']),
    release('v1.0.3', ['DoorayWidget-Setup-1.0.3.exe']),
  ];
  const latest = site.pickLatest(releases, products);
  assert.equal(latest.engine.version, '1.0.10');
  assert.equal(latest.engine.url, 'https://example.test/engine-v1.0.10/DeskWidgets-Setup-1.0.10.exe');
  assert.deepEqual(Object.keys(latest.widgets).sort(), ['clock', 'system-monitor']);
  assert.equal(latest.widgets['system-monitor'].version, '0.0.1');
});

test('pickLatest: zero releases or bad data give nothing to download', () => {
  for (const input of [[], null, undefined, { message: 'rate limited' }]) {
    assert.deepEqual(site.pickLatest(input, products), { engine: null, widgets: {} });
  }
});

test('loadReleases: caches in sessionStorage and fails on API errors', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => [{ tag_name: 'engine-v1.0.0' }] }; };
  assert.equal((await site.loadReleases(ok, storage, 1000)).length, 1);
  assert.equal((await site.loadReleases(ok, storage, 2000)).length, 1);
  assert.equal(calls, 1);
  await assert.rejects(site.loadReleases(async () => ({ ok: false, status: 403 }), { getItem: () => null, setItem() {} }, 1));
});

test('firebase.json: strict CSP, only GitHub API allowed for connect', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  assert.equal(cfg.hosting.public, 'site/public');
  const headers = Object.fromEntries(cfg.hosting.headers[0].headers.map((h) => [h.key, h.value]));
  assert.match(headers['Content-Security-Policy'], /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /unsafe-|\*/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects.default, 'desk-widgets-chilgong88');
});

/** Just enough DOM for applyLatest: elements by id and by one data attribute. */
function fakeDoc(ids, widgetIds) {
  const node = () => {
    const attrs = {};
    const classes = new Set();
    return {
      attrs, textContent: '',
      setAttribute(k, v) { attrs[k] = String(v); },
      removeAttribute(k) { delete attrs[k]; },
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    };
  };
  const byId = Object.fromEntries(ids.map((id) => [id, node()]));
  const bySel = {};
  for (const id of widgetIds) {
    bySel[`[data-download="${id}"]`] = node();
    bySel[`[data-version-for="${id}"]`] = node();
  }
  return { getElementById: (id) => byId[id], querySelector: (s) => bySel[s], byId, bySel };
}

test('download page: newest version per product whatever the API order, version shown from the release (#100)', () => {
  const dooray = products.widgets.find((w) => w.id === 'dooray');
  const name = (v) => `DeskWidgets-${dooray.productName}-Setup-${v}.exe`;
  // The API lists by creation date; a re-uploaded old release can come first.
  const releases = [
    release('widget-dooray-v1.0.2', [name('1.0.2')]),
    release('widget-dooray-v1.0.10', [name('1.0.10')]),
    release('widget-dooray-v1.0.9', [name('1.0.9')]),
    release('widget-dooray-v2.0.0', [name('2.0.0')], { draft: true }),
    release('widget-dooray-v1.1.0', [name('1.1.0')], { prerelease: true }),
    release('widget-dooray-v1.0.11', []), // upload not finished yet: keep offering the previous one
    release('engine-v1.0.4', ['DeskWidgets-Setup-1.0.4.exe']),
    release('engine-v1.0.5', ['DeskWidgets-Setup-1.0.5.exe']),
  ];
  for (const list of [releases, [...releases].reverse()]) {
    const latest = site.pickLatest(list, products);
    assert.equal(latest.widgets.dooray.version, '1.0.10');
    assert.equal(latest.engine.version, '1.0.5');
    const doc = fakeDoc(['download-engine', 'engine-version', 'release-note'], products.widgets.map((w) => w.id));
    site.applyLatest(doc, products, latest);
    assert.equal(doc.byId['engine-version'].textContent, 'v1.0.5');
    assert.equal(doc.byId['download-engine'].attrs.href, 'https://example.test/engine-v1.0.5/DeskWidgets-Setup-1.0.5.exe');
    assert.equal(doc.bySel['[data-version-for="dooray"]'].textContent, 'v1.0.10');
    assert.equal(doc.bySel['[data-download="dooray"]'].attrs.href, `https://example.test/widget-dooray-v1.0.10/${name('1.0.10')}`);
    assert.equal(doc.bySel['[data-download="mail"]'].attrs['aria-disabled'], 'true');
    assert.equal(doc.bySel['[data-download="mail"]'].textContent, '준비 중');
    assert.equal(doc.byId['release-note'].textContent, '');
  }
});

// ---------- #104: released installers in products.json for the in-app update ----------

const crypto = require('crypto');
const os = require('os');
const { recordRelease, githubAssetMatches, githubDownloadUrl, sha256File } = require('../../scripts/release');
const { buildProducts: build, downloadOf } = require('../../scripts/site-build');
const updates = require('../main/updates');

/** A minimal repository: package.json, ENGINE_API, one widget, and site/releases.json. */
function fakeRepo(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-site-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.1.0' }));
  fs.mkdirSync(path.join(dir, 'engine', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engine', 'main', 'widgets.js'), "const ENGINE_API = '1.6';\n");
  fs.mkdirSync(path.join(dir, 'widgets', 'clock'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'widgets', 'clock', 'widget.json'), JSON.stringify({ id: 'clock', name: '시계', version: '1.0.2', engineApi: '1.3', package: { productName: 'ClockWidget' } }));
  if (records) {
    fs.mkdirSync(path.join(dir, 'site'), { recursive: true });
    for (const [id, r] of Object.entries(records)) recordRelease(id, r, path.join(dir, 'site', 'releases.json'));
  }
  return dir;
}

const gh = { owner: 'Htaeyong', repo: 'desk-widgets' };
const rec = (tag, file, version, sha256 = 'a'.repeat(64), size = 1234) => ({ version, tag, file, url: githubDownloadUrl(gh, tag, file), size, sha256 });

test('site-build: products get the released installer from site/releases.json, which the engine accepts', () => {
  const dir = fakeRepo({
    engine: rec('engine-v1.1.0', 'DeskWidgets-Setup-1.1.0.exe', '1.1.0'),
    clock: rec('widget-clock-v1.0.1', 'DeskWidgets-ClockWidget-Setup-1.0.1.exe', '1.0.1'), // 1.0.2 not released yet
  });
  const p = build(dir);
  assert.equal(p.engine.download.url, 'https://github.com/Htaeyong/desk-widgets/releases/download/engine-v1.1.0/DeskWidgets-Setup-1.1.0.exe');
  assert.equal(p.widgets[0].version, '1.0.2');
  assert.equal(p.widgets[0].download.version, '1.0.1');
  const parsed = updates.parseProducts(JSON.parse(JSON.stringify(p)));
  assert.equal(parsed.engine.download.size, 1234);
  assert.equal(parsed.widgets.get('clock').version, '1.0.1', 'the engine offers what is released, not the manifest version');
  // No records: same products as before #104 (no download key).
  assert.equal('download' in build(fakeRepo()).engine, false);
});

test('site-build: a broken release record fails the build', () => {
  for (const bad of [{ sha256: 'xyz' }, { url: 'https://evil.test/DeskWidgets-Setup-1.1.0.exe' }, { size: -1 }, { file: 'Other.exe' }]) {
    assert.throws(() => downloadOf({ engine: { ...rec('engine-v1.1.0', 'DeskWidgets-Setup-1.1.0.exe', '1.1.0'), ...bad } }, 'engine'), /bad record/);
  }
  assert.equal(downloadOf({}, 'engine'), null);
});

test('release: recordRelease keeps the newest version per product', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-rel-')), 'site', 'releases.json');
  assert.equal(recordRelease('clock', rec('widget-clock-v1.0.1', 'DeskWidgets-ClockWidget-Setup-1.0.1.exe', '1.0.1'), file), true);
  assert.equal(recordRelease('engine', rec('engine-v1.1.0', 'DeskWidgets-Setup-1.1.0.exe', '1.1.0'), file), true);
  assert.equal(recordRelease('clock', rec('widget-clock-v1.0.0', 'DeskWidgets-ClockWidget-Setup-1.0.0.exe', '1.0.0'), file), false, 'an old re-run');
  assert.equal(recordRelease('clock', rec('widget-clock-v1.0.1', 'DeskWidgets-ClockWidget-Setup-1.0.1.exe', '1.0.1', 'b'.repeat(64)), file), true, 'same version (replace)');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(all), ['engine', 'clock']);
  assert.equal(all.clock.sha256, 'b'.repeat(64));
});

test('release: the recorded hash is the uploaded file; an existing GitHub asset must match by digest', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-rel-')), 'a.exe');
  fs.writeFileSync(file, 'installer bytes');
  const hex = await sha256File(file);
  assert.equal(hex, crypto.createHash('sha256').update('installer bytes').digest('hex'));
  const local = { size: 15, sha256: hex };
  assert.equal(githubAssetMatches({ size: 15 }, local, 'created').ok, true, 'just uploaded');
  assert.equal(githubAssetMatches({ size: 15, digest: `sha256:${hex}` }, local, 'complete').ok, true);
  assert.equal(githubAssetMatches({ size: 15 }, local, 'complete').ok, false, 'old release without digest');
  assert.equal(githubAssetMatches({ size: 15, digest: `sha256:${'0'.repeat(64)}` }, local, 'created').ok, false);
  assert.equal(githubAssetMatches({ size: 16 }, local, 'created').ok, false);
  assert.equal(githubAssetMatches(null, local, 'created').ok, false);
});

test('search visibility (#106): robots.txt, sitemap.xml, canonical, JSON-LD are in sync with the build', () => {
  const b = require('../../scripts/site-build');
  const pub = path.join(root, 'site', 'public');
  // Checkouts with core.autocrlf write CRLF; the build output is compared without it.
  const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8').replace(/\r\n/g, '\n');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'site', 'sitemap-state.json'), 'utf8'));
  assert.equal(read('robots.txt'), b.robotsTxt());
  assert.match(read('robots.txt'), /^Sitemap: https:\/\/widgets\.chilgong88\.com\/sitemap\.xml$/m);
  assert.match(state.lastmod, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(read('sitemap.xml'), b.sitemapXml(state.lastmod));
  assert.equal(state.hash, b.pageHash(), 'site changed since the last build: run npm run site:build');
  assert.equal(b.sitemapXml('2026-01-02'), b.sitemapXml('2026-01-02'));
  assert.deepEqual(read('sitemap.xml').match(/<loc>[^<]+<\/loc>/g), ['<loc>https://widgets.chilgong88.com/</loc>']);

  const html = read('index.html');
  assert.equal(b.renderIndex(html, products), html, 'index.html JSON-LD is up to date (run npm run site:build)');
  assert.match(html, /<link rel="canonical" href="https:\/\/widgets\.chilgong88\.com\/">/);
  for (const m of html.match(/<meta (?:property|name)="(?:og|twitter):image" content="[^"]+"/g)) assert.match(m, /content="https:\/\//);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'SoftwareApplication');
  assert.equal(ld.softwareVersion, products.engine.version);
  assert.equal(ld.offers.price, '0');
  assert.match(ld.operatingSystem, /Windows 10/);
  assert.match(ld.downloadUrl, /^https:\/\//);

  // The JSON-LD block is data: the only <script> that runs must stay the external app.js, so script-src 'self' needs no loosening.
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(scripts.filter((a) => !/type="application\/ld\+json"/.test(a)), [' src="app.js" defer']);
  const csp = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')).hosting.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});
