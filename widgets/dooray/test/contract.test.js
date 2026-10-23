const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const mock = require('../backend/mock');
const { DEFAULT_RULES, buildProjectDashboard, buildSnapshot } = require('../backend/aggregate');
const { validateManifest } = require('../../../engine/main/theme-manifest');

const root = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'contract/dashboard.v1.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function assertValid(data) {
  const ok = validate(data);
  assert.ok(ok, JSON.stringify(validate.errors, null, 2));
}

test('sample snapshot matches the v1 schema', () => {
  assertValid(JSON.parse(fs.readFileSync(path.join(root, 'contract/sample-snapshot.json'), 'utf8')));
});

test('snapshots for every status state match the schema', () => {
  const now = new Date();
  const data = mock.build(now);
  const projects = data.projects.map((p) =>
    buildProjectDashboard(p, data.posts[p.id], { meId: data.me.id, now, rules: DEFAULT_RULES, webUrl: 'https://a.dooray.com' })
  );
  for (const state of ['unconfigured', 'loading', 'ok', 'error']) {
    assertValid(buildSnapshot({ status: { state }, me: state === 'ok' ? data.me : null, domain: '', rules: DEFAULT_RULES, projects }));
  }
});

test('bundled themes have valid manifests', () => {
  const themesDir = path.join(root, 'themes');
  const ids = fs.readdirSync(themesDir).filter((d) => fs.existsSync(path.join(themesDir, d, 'theme.json')));
  assert.ok(ids.length >= 1);
  for (const id of ids) {
    const manifest = JSON.parse(fs.readFileSync(path.join(themesDir, id, 'theme.json'), 'utf8'));
    const result = validateManifest(manifest, id);
    assert.deepEqual(result.errors, [], `${id}: ${result.errors.join(', ')}`);
    // A theme that extends another one may borrow its entry file.
    const owner = result.manifest.extends || id;
    assert.ok(ids.includes(owner), `${id}: base theme "${owner}" is not bundled`);
    assert.ok(
      fs.existsSync(path.join(themesDir, id, result.manifest.entry)) || fs.existsSync(path.join(themesDir, owner, result.manifest.entry)),
      `${id}: entry file missing`
    );
  }
});

test('theme manifest "extends" (v1.6)', () => {
  const base = { id: 'skin', name: 'Skin', version: '1.0.0', contractVersion: 1 };
  assert.equal(validateManifest(base).manifest.extends, null);
  assert.equal(validateManifest({ ...base, extends: 'glass' }).manifest.extends, 'glass');
  assert.equal(validateManifest({ ...base, extends: 'glass' }).errors.length, 0);
  assert.equal(validateManifest({ ...base, extends: 'skin' }).errors.length, 1);
  assert.equal(validateManifest({ ...base, extends: '../glass' }).errors.length, 1);
});
