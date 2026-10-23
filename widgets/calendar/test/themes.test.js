// Calendar themes as theme packages (#61; #52 looks, #54 opacity): the built-in packages and their CSS, the
// settings migration to the theme host's keys (theme-host-design 6.3), and the big calendar's week layout
// (bar lanes, week split, +N overflow) in the kit's model.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateManifest } = require('../../../engine/main/theme-manifest');
const { DEFAULTS, BUILTIN_THEMES, sanitize, sanitizeBounds, sanitizeOpacity, opacityOf, upgrade } = require('../lib/settings');
const M = require('../kit/model');

const themesDir = path.join(__dirname, '..', 'themes');
const bounds = { x: 10, y: 20, width: 300, height: 460 };
const big = { x: 5, y: 6, width: 900, height: 700 };
const read = (id, file) => fs.readFileSync(path.join(themesDir, id, file), 'utf8');
const manifestOf = (id) => JSON.parse(read(id, 'theme.json'));

test('built-in theme packages: 기본 (default page) and 큰 달력 (extends it, its own page = its own window size)', () => {
  const def = manifestOf('default');
  const bigTheme = manifestOf('big');
  assert.deepEqual([def.id, def.name, def.widget, def.contractVersion, def.extends], ['default', '기본', 'calendar', 1, undefined]);
  assert.deepEqual([bigTheme.id, bigTheme.name, bigTheme.widget, bigTheme.extends], ['big', '큰 달력', 'calendar', 'default']);
  assert.deepEqual(def.window.main, { width: 300, height: 460, minWidth: 240, minHeight: 320 });
  assert.deepEqual(bigTheme.window.main, { width: 800, height: 640, minWidth: 480, minHeight: 380 });
  for (const t of BUILTIN_THEMES) {
    const m = manifestOf(t.id);
    assert.equal(m.background.opacity, t.opacity / 100, `${t.id}: theme.json default = the #54 default`);
    const { errors, compatible } = validateManifest(m, t.id, { widgetId: 'calendar', contractVersions: [1], frames: { main: {} } });
    assert.deepEqual(errors, [], t.id);
    assert.ok(compatible, t.id);
    assert.ok(fs.existsSync(path.join(themesDir, t.id, 'index.html')), `${t.id}: own page`);
  }
  // Another widget's host sees these as "another widget's theme".
  assert.match(validateManifest(def, 'default', { widgetId: 'clock', contractVersions: [1], frames: { main: {} } }).errors.join(), /another widget/);
});

test('pages load only theme files (theirs or the base theme\'s) and set the layout themselves', () => {
  const page = read('default', 'index.html');
  const bigPage = read('big', 'index.html');
  assert.match(page, /<body data-theme="default" data-layout="compact">/);
  assert.match(bigPage, /<body data-theme="big" data-layout="month">/);
  for (const [id, html, own] of [['default', page, ['calendar.css', 'default.css', 'model.js', 'calendar.js']], ['big', bigPage, ['big.css', 'model.js']]]) {
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      const here = fs.existsSync(path.join(themesDir, id, ref));
      const base = fs.existsSync(path.join(themesDir, 'default', ref));
      const kit = fs.existsSync(path.join(themesDir, '..', 'kit', ref));
      assert.ok(here || base || kit, `${id}: ${ref} is not in the theme, its base or the kit`);
    }
    for (const f of own) assert.ok(refs.includes(f), `${id}: links ${f}`);
  }
});

test('theme CSS: the card alpha follows the host (--theme-bg-alpha) with the theme default as fallback', () => {
  for (const [id, file, def] of [['default', 'default.css', 0.8], ['big', 'big.css', 0.84], ['default', 'calendar.css', 0.8]]) {
    const css = read(id, file);
    assert.match(css, new RegExp(`--card-alpha: var\\(--theme-bg-alpha, ${def}\\);`), `${id}/${file}`);
  }
  assert.match(read('default', 'default.css'), /--card-bg: rgba\(var\(--card-rgb\), var\(--card-alpha\)\);/);
  // No widget bridge in theme code: window.widget only.
  const js = read('default', 'calendar.js');
  assert.match(js, /window\.widget/);
  assert.doesNotMatch(js, /calendarApi|\.url\b/);
});

test('migration (6.3): opacity -> themeOpacity, windowBounds -> themeBounds; themeId and old keys kept', () => {
  const raw = { themeId: 'big', opacity: { big: 40, default: 70 }, windowBounds: { compact: bounds, month: big }, alwaysOnTop: true, sources: [{ id: 'x' }] };
  const up = upgrade(raw);
  assert.equal(up.themeId, 'big');
  assert.deepEqual(up.themeOpacity, { default: 70, big: 40 });
  assert.deepEqual(up.themeBounds, { main: bounds, 'big/main': big });
  assert.deepEqual(up.opacity, raw.opacity, 'old key kept (an older version still finds it)');
  assert.deepEqual(up.windowBounds, { compact: bounds, month: big });
  assert.equal(up.alwaysOnTop, true);
  assert.deepEqual(up.sources, raw.sources);
  // Only once: values the host already keeps win.
  assert.deepEqual(upgrade({ ...raw, themeOpacity: { big: 10 }, themeBounds: { main: big } }).themeOpacity, { big: 10 });
  assert.deepEqual(upgrade({ ...raw, themeOpacity: { big: 10 }, themeBounds: { main: big } }).themeBounds, { main: big });
  // The single bounds of before #52 = the compact layout = the host's "main".
  assert.deepEqual(upgrade({ windowBounds: bounds }).themeBounds, { main: bounds });
  assert.deepEqual(upgrade({ weekStart: 1 }), { weekStart: 1 }, 'nothing to move');
  // A user theme id is kept; a malformed one falls back to the default theme.
  assert.equal(sanitize({ ...DEFAULTS, themeId: 'my-theme' }).themeId, 'my-theme');
  assert.equal(sanitize({ ...DEFAULTS, themeId: '../x' }).themeId, 'default');
  assert.deepEqual([DEFAULTS.themeId, DEFAULTS.themeOpacity, DEFAULTS.themeBounds], ['default', {}, {}]);
});

test('old keys still sanitize the same way (for going back to an older version)', () => {
  assert.deepEqual(sanitizeBounds({ compact: bounds, month: { x: 'a' } }), { compact: bounds, month: null });
  assert.deepEqual(sanitizeBounds(null), { compact: null, month: null });
  assert.deepEqual(sanitizeOpacity({ default: '55.4', big: 140, nope: 30, x: null }), { default: 55, big: 100 });
  assert.deepEqual(sanitizeOpacity('80'), {});
  assert.equal(opacityOf({ opacity: {} }, 'big'), 84);
  assert.equal(opacityOf({ opacity: { default: 0 } }, 'default'), 0);
});

// ---- week layout ----
const WEEK = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];
const allDay = (title, start, end) => ({ title, allDay: true, start, end });
const timed = (title, start, end) => ({ title, allDay: false, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
const describe = (day) => day.rows.map((r) => (r ? `${r.type}:${r.event.title}${r.type === 'bar' ? `@${r.lane}${r.head ? 'H' : ''}${r.first ? '<' : ''}${r.last ? '>' : ''}` : ''}` : '-'));

test('bars: overlapping events take separate lanes, the same row on every day, longer first', () => {
  const events = [allDay('짧은', '2026-10-20', '2026-10-21'), allDay('긴', '2026-10-19', '2026-10-23'), allDay('뒤', '2026-10-23', '2026-10-24')];
  const laid = M.weekLayout(WEEK, events, 5);
  assert.deepEqual(describe(laid[1]), ['bar:긴@0H<']);
  assert.deepEqual(describe(laid[2]), ['bar:긴@0', 'bar:짧은@1H<>']);
  assert.deepEqual(describe(laid[4]), ['bar:긴@0>']);
  assert.deepEqual(describe(laid[5]), ['bar:뒤@0H<>'], 'a free lane is reused');
});

test('bars are split at week edges: continuing events have no rounded end and a title at the week start', () => {
  const laid = M.weekLayout(WEEK, [allDay('출장', '2026-10-15', '2026-10-27')], 3);
  assert.deepEqual(describe(laid[0]), ['bar:출장@0H'], 'starts before this week: title shown, no left end');
  assert.deepEqual(describe(laid[6]), ['bar:출장@0'], 'continues after: no right end');
  assert.ok(laid.every((d) => d.rows.length === 1));
});

test('multi-day timed events are bars, single-day timed events are lines below the bars in time order', () => {
  const events = [
    timed('밤샘', '2026-10-19T22:00', '2026-10-20T02:00'),
    timed('오후', '2026-10-20T15:00', '2026-10-20T16:00'),
    timed('아침', '2026-10-20T09:00', '2026-10-20T10:00'),
    timed('자정까지', '2026-10-21T22:00', '2026-10-22T00:00'),
    allDay('휴가', '2026-10-21', '2026-10-22'),
  ];
  const laid = M.weekLayout(WEEK, events, 6);
  assert.deepEqual(describe(laid[1]), ['bar:밤샘@0H<']);
  assert.deepEqual(describe(laid[2]), ['bar:밤샘@0>', 'item:아침', 'item:오후']);
  assert.deepEqual(describe(laid[3]), ['bar:휴가@0H<>', 'item:자정까지'], 'ending at midnight stays one day');
});

test('items fill rows left free between bars, so bar rows stay aligned across days', () => {
  const events = [allDay('A', '2026-10-19', '2026-10-21'), allDay('B', '2026-10-20', '2026-10-22'), timed('회의', '2026-10-21T10:00', '2026-10-21T11:00')];
  const laid = M.weekLayout(WEEK, events, 5);
  assert.deepEqual(describe(laid[2]), ['bar:A@0>', 'bar:B@1H<']);
  assert.deepEqual(describe(laid[3]), ['item:회의', 'bar:B@1>'], 'lane 0 is free on the 21st');
});

test('+N: more than fits shows capacity - 1 rows and counts the rest', () => {
  const events = ['1', '2', '3', '4', '5'].map((n) => timed(`일정${n}`, `2026-10-20T0${n}:00`, `2026-10-20T0${n}:30`));
  const fits = M.weekLayout(WEEK, events, 5)[2];
  assert.equal(fits.rows.length, 5);
  assert.equal(fits.more, 0);
  const over = M.weekLayout(WEEK, events, 3)[2];
  assert.deepEqual(describe(over), ['item:일정1', 'item:일정2']);
  assert.equal(over.more, 3);
  const one = M.weekLayout(WEEK, events, 1)[2];
  assert.deepEqual(one.rows, []);
  assert.equal(one.more, 5);
  // A bar in a high lane that does not fit counts too, and empty trailing rows are not drawn.
  const bars = [allDay('a', '2026-10-19', '2026-10-21'), allDay('b', '2026-10-19', '2026-10-21'), allDay('c', '2026-10-20', '2026-10-21')];
  const d = M.weekLayout(WEEK, bars, 2)[2];
  assert.deepEqual(describe(d), ['bar:a@0>']);
  assert.equal(d.more, 2);
  assert.deepEqual(M.weekLayout(WEEK, [], 3)[0], { key: WEEK[0], rows: [], more: 0 });
  assert.equal(M.weeks(M.monthGrid(2026, 10, 0).days).length, 6);
});


test('새로고침 button (#81): in the header of both themes, only its icon turns, around the icon\'s center', () => {
  for (const id of ['default', 'big']) {
    const html = read(id, 'index.html');
    const head = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(head, /<button type="button" id="refresh" class="nav sync"[^>]*><svg class="sync-icon" viewBox="0 0 16 16"/, `${id}: header button with an SVG icon`);
    assert.doesNotMatch(head, /⟳/, `${id}: no text glyph (it sits off-center and swings)`);
    const foot = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    assert.doesNotMatch(foot, /id="refresh"/, `${id}: no second button in the footer`);
  }
  const css = read('default', 'calendar.css');
  const animated = [...css.matchAll(/([^{}]+)\{[^}]*animation:\s*spin/g)].map((m) => m[1].trim());
  assert.deepEqual(animated, ['.nav.sync.spin .sync-icon'], 'only the icon is animated');
  assert.match(css, /\.nav\.sync \.sync-icon \{[^}]*transform-origin: 50% 50%;/);
});
