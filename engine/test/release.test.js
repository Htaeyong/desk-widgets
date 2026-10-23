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

test('official versions of the first public release (versions are per product, #38, #100)', () => {
  const expected = {
    engine: '1.0.4', // widget integration broker #94
    dooray: '1.0.3', // add to to-do #94, token never stored as plain text #97
    mail: '1.0.2', // add to to-do #94
    calendar: '1.0.2', // my calendar and to-do deadlines #94
    todo: '1.0.0',
    'system-monitor': '1.0.0',
    memo: '1.0.0', // sticky notes
    clock: '1.0.0', // first official release (was an example until #100)
  };
  for (const [product, version] of Object.entries(expected)) assert.equal(productInfo(product).version, version, product);
});
