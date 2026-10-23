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
  assert.equal(ENGINE_FOR_API[ENGINE_API], products.engine.version, 'newest API level needs the current engine');
  for (const w of products.widgets) assert.match(w.engineMin || '', /^\d+\.\d+\.\d+$/, w.id);
  assert.equal(products.widgets.find((w) => w.id === 'calendar').engineMin, '1.0.1');
  assert.equal(products.widgets.find((w) => w.id === 'dooray').engineMin, '1.0.0');
  assert.equal(products.widgets.find((w) => w.id === 'system-monitor').engineMin, '1.0.4');
});

test('asset names match what scripts/release.js produces', () => {
  assert.equal(site.assetName(products.engine, '1.0.4'), path.basename(productInfo('engine').asset));
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
