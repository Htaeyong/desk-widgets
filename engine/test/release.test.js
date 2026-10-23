// Per-product versions and tags (scripts/release.js): never the old "Dooray Widget" tags v1.0.0-v1.0.3.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { productInfo } = require('../../scripts/release');

const root = path.join(__dirname, '..', '..');

test('release: engine and each widget get their own tag, title and installer', () => {
  const engine = productInfo('engine');
  assert.equal(engine.version, require(path.join(root, 'package.json')).version);
  assert.equal(engine.tag, `engine-v${engine.version}`);
  assert.equal(path.basename(engine.asset), `DeskWidgets-Setup-${engine.version}.exe`);

  const dooray = productInfo('dooray');
  assert.equal(dooray.version, require(path.join(root, 'widgets', 'dooray', 'widget.json')).version);
  assert.equal(dooray.tag, `widget-dooray-v${dooray.version}`);
  assert.equal(dooray.title, `Desk Widgets-DoorayWidget ${dooray.version}`);
  assert.equal(path.basename(dooray.asset), `DeskWidgets-DoorayWidget-Setup-${dooray.version}.exe`);

  for (const info of [engine, dooray, productInfo('clock')]) assert.ok(!/^v\d/.test(info.tag), info.tag);
});

test('release: unknown products are refused', () => {
  assert.throws(() => productInfo('nope'), /Unknown product/);
  assert.throws(() => productInfo('../engine'), /Unknown product/);
});

test('official versions: engine 1.0.4, Dooray widget 1.0.2 (versions are per product, #38)', () => {
  assert.equal(productInfo('engine').version, '1.0.4'); // widget integration broker #94
  assert.equal(productInfo('dooray').version, '1.0.2'); // theme background opacity #55
});
