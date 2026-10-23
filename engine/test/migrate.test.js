const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLegacy, splitLegacySettings } = require('../main/migrate');
const { createStore } = require('../main/store');
const { createDooraySettings } = require('../../widgets/dooray/settings');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// Reversible stand-in for safeStorage so the encrypted token can be checked end to end.
const fakeCrypto = {
  available: () => true,
  encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'),
  decrypt: (b64) => Buffer.from(b64, 'base64').toString().replace(/^enc:/, ''),
};

// An old %APPDATA%\dooray-widget folder as v1.0.x left it.
function legacyFolder() {
  const dir = tmp('dooray-widget');
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      doorayDomain: 'acme.dooray.com',
      apiBase: 'https://api.dooray.com',
      pollIntervalSec: 60,
      alwaysOnTop: true,
      stayOnDesktop: false,
      launchAtStartup: true,
      themeId: 'midnight',
      idleMinutes: 10,
      notifyEnabled: true,
      notifyDurationSec: 30,
      notifyMaxVisible: 5,
      notifyTypes: { mention: true, created: false },
      windowBounds: { overview: { x: 10, y: 20, width: 400, height: 600 } },
      projectWidgets: [{ projectId: 'p1', pinned: true }],
      projectOrder: ['p2', 'p1'],
      tokenEnc: fakeCrypto.encrypt('secret-token'),
      tokenPlain: '',
    })
  );
  fs.writeFileSync(path.join(dir, 'categories.json'), '{"categories":[{"id":"c1"}]}');
  fs.writeFileSync(path.join(dir, 'rules.json'), '{"rules":[]}');
  fs.writeFileSync(path.join(dir, 'Local State'), '{"os_crypt":{"encrypted_key":"KEY"}}');
  fs.mkdirSync(path.join(dir, 'themes', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'themes', 'mine', 'theme.json'), '{"id":"mine"}');
  return dir;
}

test('migration: splits settings into engine and Dooray parts', () => {
  const { engine, dooray } = splitLegacySettings({ stayOnDesktop: true, launchAtStartup: true, idleMinutes: 3, doorayDomain: 'x', notifyTypes: {}, tokenEnc: 'e' });
  assert.deepEqual(engine, { launchAtStartup: true, idleMinutes: 3, desktopMode: 'anchor' });
  assert.deepEqual(dooray, { doorayDomain: 'x', notifyTypes: {}, tokenEnc: 'e' });
});

test('migration: copies the old folder into the new layout and keeps the token readable', () => {
  const legacyDir = legacyFolder();
  const userData = path.join(tmp('desk'), 'chilgong88', 'desk-widgets');
  const result = migrateLegacy({ legacyDir, userData });
  assert.equal(result.migrated, true);
  assert.deepEqual(result.copied.sort(), ['Local State', 'categories.json', 'rules.json', 'settings.json', 'themes']);

  const engine = readJson(path.join(userData, 'settings.json'));
  assert.equal(engine.desktopMode, 'off');
  assert.equal(engine.launchAtStartup, true);
  assert.equal(engine.idleMinutes, 10);
  assert.equal(engine.notifyDurationSec, 30);
  assert.equal(engine.notifyMaxVisible, 5);
  assert.deepEqual(engine.widgets, { dooray: { enabled: true } });
  assert.equal(engine.migratedFrom, legacyDir);

  const dir = path.join(userData, 'widgets', 'dooray');
  assert.equal(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'), '{"os_crypt":{"encrypted_key":"KEY"}}');
  assert.equal(readJson(path.join(dir, 'categories.json')).categories[0].id, 'c1');
  assert.ok(fs.existsSync(path.join(dir, 'rules.json')));
  assert.ok(fs.existsSync(path.join(dir, 'themes', 'mine', 'theme.json')));

  // The Dooray widget reads the moved settings, token included.
  const dooray = createDooraySettings({ dir, createStore, crypto: fakeCrypto }).load();
  assert.equal(dooray.apiToken, 'secret-token');
  assert.equal(dooray.doorayDomain, 'acme.dooray.com');
  assert.equal(dooray.themeId, 'midnight');
  assert.equal(dooray.alwaysOnTop, true);
  assert.deepEqual(dooray.windowBounds.overview, { x: 10, y: 20, width: 400, height: 600 });
  assert.deepEqual(dooray.projectOrder, ['p2', 'p1']);
  assert.equal(dooray.notifyTypes.created, false);
  assert.equal(dooray.notifyTypes.comment, true); // new keys keep their default
  assert.equal(dooray.desktopMode, undefined);

  // The old folder is untouched (backup).
  assert.ok(fs.existsSync(path.join(legacyDir, 'settings.json')));
});

test('migration: runs once and never overwrites a set-up folder', () => {
  const legacyDir = legacyFolder();
  const userData = tmp('desk');
  assert.equal(migrateLegacy({ legacyDir, userData }).migrated, true);
  fs.writeFileSync(path.join(userData, 'widgets', 'dooray', 'categories.json'), '{"categories":[]}');
  assert.deepEqual(migrateLegacy({ legacyDir, userData }), { migrated: false, reason: 'already-set-up' });
  assert.equal(readJson(path.join(userData, 'widgets', 'dooray', 'categories.json')).categories.length, 0);

  const fresh = tmp('desk');
  fs.writeFileSync(path.join(fresh, 'settings.json'), '{}');
  assert.equal(migrateLegacy({ legacyDir, userData: fresh }).reason, 'already-set-up');
});

test('migration: nothing to do without old data', () => {
  assert.equal(migrateLegacy({ legacyDir: path.join(os.tmpdir(), 'no-such-dooray-widget'), userData: tmp('desk') }).reason, 'no-legacy-data');
  assert.equal(migrateLegacy({ legacyDir: tmp('empty-legacy'), userData: tmp('desk') }).reason, 'no-legacy-data');
  const same = tmp('same');
  assert.equal(migrateLegacy({ legacyDir: same, userData: same }).reason, 'same-folder');
});

test('store: defaults, nested defaults, sanitize and encrypted secret', () => {
  const file = path.join(tmp('store'), 'nested', 's.json');
  const store = createStore({
    file,
    defaults: { n: 1, flags: { a: true, b: true } },
    sanitize: (v) => ({ ...v, n: Math.min(10, v.n) }),
    secret: { field: 'token', enc: 'tokenEnc', plain: 'tokenPlain' },
    crypto: fakeCrypto,
  });
  assert.deepEqual(store.load(), { n: 1, flags: { a: true, b: true }, token: '' });
  store.save({ n: 50, flags: { a: false }, token: 'abc' });
  const raw = readJson(file);
  assert.equal(raw.n, 10);
  assert.equal(raw.token, undefined);
  assert.equal(fakeCrypto.decrypt(raw.tokenEnc), 'abc');
  store.reset();
  assert.deepEqual(store.load(), { n: 10, flags: { a: false, b: true }, token: 'abc' });
});
