// 계정 대시보드 (#72): the kit's view logic (quick filters, card numbers, totals) and the theme package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const D = require('../kit/dash-model');
const { validateManifest } = require('../../../engine/main/theme-manifest');

const themesDir = path.join(__dirname, '..', 'themes');

test('quick filters <-> widget filter', () => {
  assert.deepEqual(D.filterFor('a1', 'all'), { accountId: 'a1', unread: false, flagged: false, category: '' });
  assert.deepEqual(D.filterFor('a1', 'unread'), { accountId: 'a1', unread: true, flagged: false, category: '' });
  assert.deepEqual(D.filterFor('a1', 'flagged'), { accountId: 'a1', unread: false, flagged: true, category: '' });
  assert.deepEqual(D.filterFor('a1', 'cat:c9'), { accountId: 'a1', unread: false, flagged: false, category: 'c9' });
  assert.deepEqual(D.filterFor('a1', 'cat:__none__').category, '__none__');
  for (const q of ['all', 'unread', 'flagged', 'cat:c9']) assert.equal(D.quickOf(D.filterFor('a1', q)), q, q);
  assert.equal(D.quickOf(null), 'all');
});

test('card numbers: categories with mail only, in category order; quick chips; totals; scope note', () => {
  const cats = [{ id: 'c1', name: '중요', color: '#f00' }, { id: 'c2', name: '결재', color: '#0f0' }, { id: 'c3', name: '빈 분류', color: '#00f' }];
  const a = { id: 'a1', unread: 4, flagged: 2, loaded: 30, categories: { c2: 3, c1: 1, c3: 0 } };
  assert.deepEqual(D.cardCategories(a, cats).map((c) => [c.name, c.count]), [['중요', 1], ['결재', 3]]);
  assert.deepEqual(D.quickChips(a, cats).map((q) => [q.quick, q.count]), [['all', null], ['unread', 4], ['flagged', 2], ['cat:c1', 1], ['cat:c2', 3]]);
  assert.deepEqual(D.totals([a, { unread: 3, flagged: 1, state: 'error' }, { unread: 99, enabled: false }]), { accounts: 2, unread: 7, flagged: 3, errors: 1 });
  assert.equal(D.scopeNote('all', 30), '');
  // #83: 안 읽음 / 중요 are the server's lists; only categories say they look at loaded mail.
  assert.equal(D.scopeNote('flagged', 30), '');
  assert.equal(D.scopeNote('unread', 30), '');
  assert.match(D.scopeNote('cat:c1', 30), /불러온 메일 30통 중/);
});

test('theme package: valid for the mail contract, bigger window, own opacity default, loads only theme / base / kit files', () => {
  const m = JSON.parse(fs.readFileSync(path.join(themesDir, 'dashboard', 'theme.json'), 'utf8'));
  assert.deepEqual([m.id, m.widget, m.contractVersion, m.extends, m.background.opacity], ['dashboard', 'mail', 1, 'default', 0.85]);
  assert.deepEqual(m.window.main, { width: 720, height: 520, minWidth: 420, minHeight: 320 });
  const { errors, compatible } = validateManifest(m, 'dashboard', { widgetId: 'mail', contractVersions: [1], frames: { main: {} } });
  assert.deepEqual(errors, []);
  assert.ok(compatible);
  const page = fs.readFileSync(path.join(themesDir, 'dashboard', 'index.html'), 'utf8');
  for (const ref of [...page.matchAll(/(?:href|src)="([^"]+)"/g)].map((x) => x[1])) {
    const found = [path.join(themesDir, 'dashboard', ref), path.join(themesDir, 'default', ref), path.join(__dirname, '..', 'kit', ref)].some((f) => fs.existsSync(f));
    assert.ok(found, ref);
  }
  assert.match(fs.readFileSync(path.join(themesDir, 'dashboard', 'dashboard.css'), 'utf8'), /--card-alpha: var\(--theme-bg-alpha, 0\.85\);/);
  const js = fs.readFileSync(path.join(themesDir, 'dashboard', 'dashboard.js'), 'utf8');
  assert.doesNotMatch(js, /window\.dooray|require\(|innerHTML|insertAdjacentHTML|eval\(/);
  assert.match(js, /MailNav\.bindInputs/, 'mouse side buttons / Alt+arrows');
});
