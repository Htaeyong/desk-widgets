// Per-product versions and tags (scripts/release.js): never the old "Dooray Widget" tags v1.0.0-v1.0.3.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { productInfo } = require('../../scripts/release');
const { productOrder } = require('../../scripts/release-all');
const { isFrozen, frozenOf, isGiteaOnly, isUnreleasedWidget } = require('../../scripts/version');

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

test('current versions per product (#38; only changed products advance)', () => {
  const expected = {
    engine: '1.1.2', // #116 z-order, #117 merged widgets, #118 tray items (engine API 1.9)
    dooray: '1.1.1',
    mail: '1.1.1',
    calendar: '1.1.1',
    todo: '1.1.1',
    'system-monitor': '1.1.0',
    memo: '1.1.1',
    clock: '1.1.1',
    todonote: '1.1.1', // #118: tray menu items
  };
  for (const [product, version] of Object.entries(expected)) assert.equal(productInfo(product).version, version, product);
});

test('products keep independent versions; 0.0.x widgets are Gitea only (#38, #111)', () => {
  const notes = productInfo('todonote');
  assert.equal(notes.giteaOnly, isGiteaOnly(notes.version), '할 일 노트 is public since 1.1.0; its -test.N builds stay on Gitea');
  assert.equal(notes.prerelease, notes.version.includes('-'));
  assert.equal(notes.frozen, null);
  assert.ok(productOrder().includes('todonote'));
  // #117: 할 일 목록 and 스티키 노트 were merged into 할 일 노트 and stay at 1.1.1 (still downloadable).
  for (const id of ['todo', 'memo']) {
    assert.ok(!productOrder().includes(id), `${id} is never released again`);
    assert.deepEqual(productInfo(id).frozen, { since: '1.1.1', successor: 'todonote' }, id);
  }
  for (const p of productOrder()) assert.equal(productInfo(p).frozen, null, `${p}: only todo and memo are frozen`);
  assert.equal(isGiteaOnly('0.0.1'), true);
  assert.equal(isGiteaOnly('0.0.12-test.1'), true);
  assert.equal(isGiteaOnly('1.1.1-test.1'), true);
  assert.equal(isGiteaOnly('0.1.0'), false);
  assert.equal(isGiteaOnly('1.1.0'), false);
  assert.equal(isUnreleasedWidget({ version: '0.0.1' }), true);
  assert.equal(isUnreleasedWidget({ version: '1.1.1-test.1' }), false);
});

test('frozenOf: checks the widget.json "frozen" block', () => {
  const m = (frozen, extra = {}) => ({ id: 'todo', version: '1.1.0', frozen, ...extra });
  assert.equal(frozenOf({ id: 'clock', version: '1.1.0' }), null);
  assert.equal(isFrozen({ id: 'clock' }), false);
  assert.equal(isFrozen(m({ since: '1.1.0', successor: 'memo' })), true);
  assert.deepEqual(frozenOf(m({ since: '1.1.0', successor: 'memo', extra: 1 })), { since: '1.1.0', successor: 'memo' });
  assert.throws(() => frozenOf(m(true)), /must be an object/);
  assert.throws(() => frozenOf(m([])), /must be an object/);
  assert.throws(() => frozenOf(m({ since: '1.1.0-test.1', successor: 'memo' }, { version: '1.1.0-test.1' })), /public/);
  assert.throws(() => frozenOf(m({ since: '1.0.0', successor: 'memo' })), /stays at frozen.since/);
  assert.throws(() => frozenOf(m({ since: '1.1.0', successor: 'todo' })), /another widget id/);
  assert.throws(() => frozenOf(m({ since: '1.1.0', successor: '../memo' })), /another widget id/);
});
