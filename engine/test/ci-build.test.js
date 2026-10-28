// CI build helpers (scripts/ci, #101): tag -> product, version check, sign-hook collect/apply. No build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { productFromRef, resolve } = require('../../scripts/ci/product');
const signHook = require('../../scripts/ci/sign-hook');

const root = path.join(__dirname, '..', '..');

test('tags and product names map to a product', () => {
  assert.deepEqual(productFromRef('engine-v1.2.3'), { product: 'engine', tag: 'engine-v1.2.3' });
  assert.deepEqual(productFromRef('widget-clock-v1.0.0'), { product: 'clock', tag: 'widget-clock-v1.0.0' });
  assert.deepEqual(productFromRef('widget-system-monitor-v0.1.0'), { product: 'system-monitor', tag: 'widget-system-monitor-v0.1.0' });
  assert.deepEqual(productFromRef('memo'), { product: 'memo', tag: null });
});

test('resolve: facts come from the source version; a tag for another version fails', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const engine = resolve('engine');
  assert.equal(engine.kind, 'engine');
  assert.equal(engine.tag, `engine-v${version}`);
  assert.equal(engine.asset, `dist/DeskWidgets-Setup-${version}.exe`);
  assert.deepEqual(resolve(engine.tag), engine);
  assert.throws(() => resolve('engine-v0.0.0-not-this'), /does not match/);
  const clock = resolve('clock');
  assert.equal(clock.kind, 'widget');
  assert.match(clock.asset, /^dist\/DeskWidgets-\w+-Setup-.+\.exe$/);
  assert.throws(() => resolve('no-such-widget'), /Unknown product/);
});

test('sign-hook signs only our app exe and uninstallers', () => {
  assert.equal(signHook.isOurs('dist/win-unpacked/Desk Widgets.exe'), true);
  assert.equal(signHook.isOurs('dist/DeskWidgets-Setup-1.0.0.__uninstaller.exe'), true);
  assert.equal(signHook.isOurs('dist/DeskWidgets-Setup-1.0.0.exe'), false);
  assert.equal(signHook.isOurs('dist/win-unpacked/resources/elevate.exe'), false);
});

test('sign-hook collect copies out, apply copies the signed file back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sign-'));
  try {
    const file = path.join(dir, 'Setup-1.0.0.__uninstaller.exe');
    fs.writeFileSync(file, 'unsigned');
    const run = (mode) => execFileSync(process.execPath, [path.join(root, 'scripts', 'ci', 'sign-hook.js'), file], { env: { ...process.env, DW_SIGN_MODE: mode, DW_SIGN_DIR: path.join(dir, 'sign') } });
    run('collect');
    assert.equal(fs.readFileSync(path.join(dir, 'sign', 'unsigned', path.basename(file)), 'utf8'), 'unsigned');
    assert.throws(() => run('apply'), /signed copy missing/);
    fs.mkdirSync(path.join(dir, 'sign', 'signed'));
    fs.writeFileSync(path.join(dir, 'sign', 'signed', path.basename(file)), 'signed');
    run('apply');
    assert.equal(fs.readFileSync(file, 'utf8'), 'signed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI product list: the workflow offers every product release:all builds; frozen and 0.0.x widgets left out (#111)', () => {
  const { productOrder } = require('../../scripts/release-all');
  const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  const listed = /description: 'engine or a widget id \(([^)]*)\)/.exec(yml)[1].split(',').map((s) => s.trim()).sort();
  assert.deepEqual(listed, productOrder().slice(1).sort());
  assert.ok(listed.includes('todonote'), '할 일 노트 is built by the public CI from its official 1.1.0');
});
