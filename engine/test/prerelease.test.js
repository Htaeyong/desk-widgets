// Internal test builds (#109): X.Y.Z-test.N versions are released on Gitea only, as prereleases. GitHub, the
// download site and the in-app update only ever see public X.Y.Z versions.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const version = require('../../scripts/version');
const { giteaSide, githubSide, ensureRelease } = require('../../scripts/release-api');
const release = require('../../scripts/release');
const { planRun } = require('../../scripts/release-all');
const { buildProducts, publicVersion } = require('../../scripts/site-build');
const { productFromRef } = require('../../scripts/ci/product');
const { viVersion } = require('../../tools/widget-kit/build');
const u = require('../main/updates');

const root = path.join(__dirname, '..', '..');

// ---------- versions and tags ----------

test('versions: X.Y.Z and X.Y.Z-test.N parse; semver order puts the release after its test builds', () => {
  for (const compare of [version.compareVersions, u.compareVersions]) {
    assert.ok(compare('1.1.1', '1.1.1-test.1') > 0, 'release is newer than its test build');
    assert.ok(compare('1.1.1-test.1', '1.1.1') < 0);
    assert.ok(compare('1.1.1-test.2', '1.1.1-test.1') > 0);
    assert.ok(compare('1.1.1-test.10', '1.1.1-test.9') > 0, 'numeric identifiers compare as numbers');
    assert.ok(compare('1.1.1-test.1', '1.1.0') > 0, 'a test build of the next version is newer than the last release');
    assert.ok(compare('1.1.2-test.1', '1.1.1') > 0);
    assert.ok(compare('1.1.1-test', '1.1.1-test.1') < 0, 'fewer identifiers sort first');
    assert.ok(compare('1.1.1-1', '1.1.1-test') < 0, 'numeric before alphanumeric');
    assert.equal(compare('1.1.1-test.1', '1.1.1-test.1'), 0);
    assert.equal(compare('1.1.0', '1.1.0'), 0);
    for (const bad of ['1.1', '1.1.1-', '1.1.1-test..1', 'v1.1.1', '1.1.1.1', '']) assert.ok(Number.isNaN(compare(bad, '1.0.0')), bad);
  }
  assert.equal(version.isPrerelease('1.1.1-test.1'), true);
  assert.equal(version.isPrerelease('1.1.1'), false);
  assert.equal(version.isPrerelease('junk'), false);
  assert.equal(u.isPublicVersion('1.1.1'), true);
  assert.equal(u.isPublicVersion('1.1.1-test.1'), false);
});

test('tags: engine-v1.1.1-test.1 and widget-<id>-v1.1.1-test.1 parse to the product and its test version', () => {
  assert.deepEqual(version.parseTag('engine-v1.1.1-test.1'), { product: 'engine', version: '1.1.1-test.1' });
  assert.deepEqual(version.parseTag('widget-system-monitor-v1.1.1-test.1'), { product: 'system-monitor', version: '1.1.1-test.1' });
  assert.deepEqual(version.parseTag('widget-clock-v1.1.0'), { product: 'clock', version: '1.1.0' });
  assert.equal(version.parseTag('v1.0.3'), null);
  assert.equal(version.isPrereleaseTag('widget-clock-v1.1.1-test.1'), true);
  assert.equal(version.isPrereleaseTag('engine-v1.1.1'), false);
  // CI resolves test tags to the right product too (the workflow itself never runs for them).
  assert.deepEqual(productFromRef('engine-v1.1.1-test.1'), { product: 'engine', tag: 'engine-v1.1.1-test.1' });
  assert.deepEqual(productFromRef('widget-system-monitor-v1.1.1-test.1'), { product: 'system-monitor', tag: 'widget-system-monitor-v1.1.1-test.1' });
});

test('productInfo: source versions are X.Y.Z or a test version, and say which', () => {
  for (const product of ['engine', 'clock', 'system-monitor']) {
    const info = release.productInfo(product);
    assert.match(info.version, /^\d+\.\d+\.\d+(-test\.\d+)?$/, product);
    assert.equal(info.prerelease, info.version.includes('-'), product);
    assert.ok(info.tag.endsWith(`-v${info.version}`) && path.basename(info.asset).endsWith(`-Setup-${info.version}.exe`), product);
  }
});

// ---------- Gitea prerelease, GitHub refused ----------

/** Records the release API calls; answers like an empty host. */
function recorder() {
  const calls = [];
  let id = 1;
  const fetchFn = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    const json = (status, b) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
    if (method === 'GET') return json(404, {});
    if (method === 'POST' && /\/releases$/.test(url)) return json(201, { id: id++, tag_name: body.tag_name, assets: [], upload_url: 'https://uploads.github.com/x/assets{?name}' });
    if (method === 'PATCH') return json(200, { ...body });
    return json(201, { id: id++, name: new URL(url).searchParams.get('name'), size: 4 });
  };
  return { calls, fetchFn };
}

function asset() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pre-')), 'DeskWidgets-Setup-1.1.1-test.1.exe');
  fs.writeFileSync(file, 'test');
  return { file, name: path.basename(file), size: 4 };
}

test('Gitea: a test version is created as a prerelease, a public version is not', async () => {
  for (const [tag, prerelease] of [['engine-v1.1.1-test.1', true], ['engine-v1.1.1', false]]) {
    const r = recorder();
    const side = giteaSide({ baseUrl: 'https://gitea.test', owner: 'o', repo: 'r', token: 't', fetchFn: r.fetchFn });
    assert.equal(await ensureRelease(side, { tag, title: 't', body: 'b', asset: asset(), target: 'a'.repeat(40), prerelease, log: () => {} }), 'created');
    const create = r.calls.find((c) => c.method === 'POST' && c.url.endsWith('/releases'));
    assert.equal(create.body.prerelease, prerelease, tag);
    assert.equal(create.body.draft, false);
  }
  // --replace keeps the flag.
  const r = recorder();
  const side = giteaSide({ baseUrl: 'https://gitea.test', owner: 'o', repo: 'r', token: 't', fetchFn: r.fetchFn });
  await side.update({ id: 5 }, { title: 't', body: 'b', prerelease: true });
  assert.equal(r.calls[0].body.prerelease, true);
});

test('GitHub: test tags and prerelease runs are refused before any request, also in a dry run', async () => {
  const r = recorder();
  const side = githubSide({ owner: 'o', repo: 'r', token: 't', fetchFn: r.fetchFn });
  const opts = { title: 't', body: 'b', asset: asset(), target: 'a'.repeat(40), log: () => {} };
  await assert.rejects(ensureRelease(side, { ...opts, tag: 'engine-v1.1.1-test.1' }), /internal test version/);
  await assert.rejects(ensureRelease(side, { ...opts, tag: 'widget-clock-v1.1.1-test.1', dryRun: true }), /internal test version/);
  await assert.rejects(ensureRelease(side, { ...opts, tag: 'engine-v1.1.1', prerelease: true }), /internal test version/);
  await assert.rejects(side.create({ tag: 'engine-v1.1.1-test.1', title: 't', body: 'b', target: 'x' }), /internal test version/);
  await assert.rejects(side.update({ id: 1, tag_name: 'engine-v1.1.1-test.1' }, { title: 't', body: 'b' }), /internal test version/);
  assert.equal(r.calls.length, 0);
});

test('release:all: any test version makes a Gitea-only run without site; --github is refused', () => {
  const info = (product, v) => ({ product, tag: `${product === 'engine' ? 'engine' : `widget-${product}`}-v${v}`, prerelease: version.isPrerelease(v) });
  const test1 = [info('engine', '1.1.1-test.1'), info('clock', '1.1.1-test.1')];
  assert.deepEqual(planRun(test1, { github: undefined, site: true }, true), { github: false, site: false, testTags: ['engine-v1.1.1-test.1', 'widget-clock-v1.1.1-test.1'] });
  assert.equal(planRun([info('engine', '1.1.1'), info('clock', '1.1.1-test.1')], { site: true }, true).site, false, 'one test version is enough');
  assert.throws(() => planRun(test1, { github: true, site: true }, true), /drop --github/);
  assert.deepEqual(planRun([info('engine', '1.1.1')], { github: undefined, site: true }, true), { github: true, site: true, testTags: [] });
  assert.equal(planRun([info('engine', '1.1.1')], { github: false, site: false }, true).site, false);
});

test('release: --github with a test version stops; site/releases.json never takes a test version', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pre-')), 'releases.json');
  const rec = (v) => ({ version: v, tag: `engine-v${v}`, file: `DeskWidgets-Setup-${v}.exe`, url: `https://github.com/o/r/releases/download/engine-v${v}/DeskWidgets-Setup-${v}.exe`, size: 1, sha256: 'a'.repeat(64) });
  assert.throws(() => release.recordRelease('engine', rec('1.1.1-test.1'), file), /public versions/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(release.recordRelease('engine', rec('1.1.0'), file), true);
  assert.equal(release.recordRelease('engine', rec('1.1.1'), file), true);
  assert.equal(release.recordRelease('engine', rec('1.0.9'), file), false, 'older record kept out');
  // The real tool: a test version with --github never gets to the network.
  if (release.productInfo('engine').prerelease) {
    const notes = path.join(path.dirname(file), 'n.md');
    fs.writeFileSync(notes, 'notes');
    await assert.rejects(release.releaseProduct('engine', { notesFile: notes, dryRun: true, github: true, envFile: path.join(path.dirname(file), 'none.env'), log: () => {}, fetchFn: () => assert.fail('no request') }), /drop --github/);
  }
});

// ---------- site ----------

/** A minimal repository at a test version with site/releases.json from the last public release. */
function testPhaseRepo(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pre-site-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.1.1-test.1' }));
  fs.mkdirSync(path.join(dir, 'engine', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engine', 'main', 'widgets.js'), "const ENGINE_API = '1.6';\n");
  for (const id of ['clock', 'memo']) {
    fs.mkdirSync(path.join(dir, 'widgets', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'widgets', id, 'widget.json'), JSON.stringify({ id, name: id, version: '1.1.1-test.1', engineApi: '1.3', package: { productName: 'X' } }));
  }
  fs.mkdirSync(path.join(dir, 'site'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'site', 'releases.json'), JSON.stringify(records));
  return dir;
}

test('site-build: a test version in the source keeps the last public version on the site', () => {
  const rec = (tag, file, v) => ({ version: v, tag, file, url: `https://github.com/o/r/releases/download/${tag}/${file}`, size: 10, sha256: 'b'.repeat(64) });
  const dir = testPhaseRepo({ engine: rec('engine-v1.1.0', 'DeskWidgets-Setup-1.1.0.exe', '1.1.0'), clock: rec('widget-clock-v1.1.0', 'DeskWidgets-X-Setup-1.1.0.exe', '1.1.0') });
  const p = buildProducts(dir);
  assert.equal(p.engine.version, '1.1.0');
  assert.equal(p.engine.download.version, '1.1.0');
  assert.equal(p.widgets.find((w) => w.id === 'clock').version, '1.1.0');
  assert.equal(p.widgets.find((w) => w.id === 'memo').version, '1.1.1', 'never released: the X.Y.Z part, never the test suffix');
  assert.doesNotMatch(JSON.stringify(p), /-test/);
  assert.equal(publicVersion('1.2.0', {}, 'engine'), '1.2.0', 'public source versions are used as before');
  // The real site: nothing in products.json is a test version.
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'site', 'public', 'products.json'), 'utf8'), /-test/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'site', 'releases.json'), 'utf8'), /-test/);
});

// ---------- in-app update ----------

function entry(id, v) {
  const body = Buffer.from(`installer ${id} ${v}`);
  const file = id === 'engine' ? `DeskWidgets-Setup-${v}.exe` : `DeskWidgets-X-Setup-${v}.exe`;
  const tag = id === 'engine' ? `engine-v${v}` : `widget-${id}-v${v}`;
  return { id, name: id, version: v, engineApi: '1.3', engineMin: '1.0.1', download: { version: v, tag, file, url: `https://github.com/Htaeyong/desk-widgets/releases/download/${tag}/${file}`, size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') } };
}

test('updates: a prerelease in products.json is never offered', () => {
  const parsed = u.parseProducts({ engine: entry('engine', '1.1.1-test.2'), widgets: [entry('clock', '1.1.1-test.2'), entry('memo', '1.1.1')] });
  assert.equal(parsed.engine, null);
  assert.equal(parsed.widgets.has('clock'), false);
  assert.equal(parsed.widgets.get('memo').version, '1.1.1');
  assert.equal(u.productEntry({ ...entry('memo', '1.1.1'), engineMin: '1.1.1-test.1' }).engineMin, null, 'a test engineMin is ignored');
});

test('updates: a test build is up to date against the last release and offered the real release later', () => {
  const widgets = [{ id: 'clock', name: 'clock', version: '1.1.1-test.1', source: 'installed' }];
  const rows = (engine, clock) => u.computeUpdates({ products: u.parseProducts({ engine: entry('engine', engine), widgets: [entry('clock', clock)] }), engineVersion: '1.1.1-test.1', engineApi: '1.6', widgets });
  // 1.1.1-test.1 installed over 1.1.0; the site still says 1.1.0: nothing to install (no downgrade offer).
  assert.deepEqual(rows('1.1.0', '1.1.0').map((r) => r.status), ['current', 'current']);
  // 1.1.1 released: offered over the test build.
  const later = rows('1.1.1', '1.1.1');
  assert.deepEqual(later.map((r) => [r.status, r.current, r.latest]), [['available', '1.1.1-test.1', '1.1.1'], ['available', '1.1.1-test.1', '1.1.1']]);
  assert.ok(later[0].download.url.endsWith('/engine-v1.1.1/DeskWidgets-Setup-1.1.1.exe'));
});

// ---------- installers and CI ----------

test('widget installer: NSIS VIProductVersion gets a valid X.X.X.X for test versions', () => {
  assert.equal(viVersion('1.1.1-test.1'), '1.1.1.0');
  assert.equal(viVersion('1.1.1'), '1.1.1.0');
  assert.equal(viVersion('1.2'), '1.2.0.0');
  // The full version stays in the strings (file name, Control Panel DisplayVersion, captions).
  const nsi = fs.readFileSync(path.join(root, 'tools', 'widget-kit', 'installer.nsi'), 'utf8');
  assert.match(nsi, /VIProductVersion "\$\{VI_VERSION\}"/);
  assert.match(nsi, /"DisplayVersion" "\$\{VERSION\}"/);
});

test('CI: test tags never trigger the build, and a test version is never attached to a GitHub Release', () => {
  const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');
  const tags = /\n {4}tags:\n((?: {6}- .+\n)+)/.exec(yml)[1].split('\n').filter(Boolean).map((l) => l.trim().slice(2).replace(/'/g, ''));
  assert.deepEqual(tags, ['engine-v*', 'widget-*-v*', '!*-test.*']);
  // GitHub's tag filters: "*" matches any characters except "/", the last matching pattern wins.
  const glob = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  const runs = (tag) => tags.reduce((on, p) => (p.startsWith('!') ? (glob(p.slice(1)).test(tag) ? false : on) : glob(p).test(tag) ? true : on), false);
  assert.equal(runs('engine-v1.1.1'), true);
  assert.equal(runs('widget-system-monitor-v1.1.1'), true);
  assert.equal(runs('engine-v1.1.1-test.1'), false);
  assert.equal(runs('widget-clock-v1.1.1-test.2'), false);
  assert.match(yml, /- name: Attach to GitHub Release\n\s+if: .*steps\.p\.outputs\.prerelease != 'true'/);
});
