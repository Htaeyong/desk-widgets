// The clock's built-in theme packages (#60): checked with the engine's own theme registry on the packaged widget,
// the way the installed clock reads them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packageWidget } = require('../../../tools/widget-kit/build');
const { createRegistry } = require('../../../engine/main/theme-registry');

const clockDir = path.join(__dirname, '..');
const BUILT_IN = ['dark-glass', 'light', 'minimal', 'neon', 'analog'];

let pkgDir = null;
function packaged() {
  if (!pkgDir) pkgDir = packageWidget(clockDir, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-clock-')), 'clock'));
  return pkgDir;
}

function registry(dir = packaged()) {
  return createRegistry({
    widgetId: 'clock',
    builtinDir: path.join(dir, 'themes'),
    userDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clock-user-')), 'themes'),
    kitDir: path.join(dir, 'kit'),
    defaultTheme: 'dark-glass',
    contractVersions: [1],
    frames: { main: { width: 220, height: 96, minWidth: 140, minHeight: 64, variants: { tools: {} } } },
  });
}

test('the five built-in themes are usable clock themes, dark glass first', () => {
  const list = registry().listThemes();
  assert.deepEqual(list.map((t) => t.id).sort(), [...BUILT_IN].sort());
  assert.equal(list[0].id, 'dark-glass');
  for (const t of list) {
    assert.ok(t.usable, `${t.id}: ${t.errors.join(', ')}`);
    assert.equal(t.widget, 'clock');
    assert.equal(t.contractVersion, 1);
    assert.ok(t.features.includes('tools'), `${t.id} draws the stopwatch/timer/alarm tabs`);
  }
});

test('color themes share dark glass (same window sizes), analog has its own page and sizes', () => {
  const list = Object.fromEntries(registry().listThemes().map((t) => [t.id, t]));
  for (const id of ['light', 'minimal', 'neon']) {
    assert.equal(list[id].extends, 'dark-glass');
    assert.equal(list[id].layout, 'dark-glass', `${id} uses the dark glass page`);
  }
  assert.equal(list.analog.layout, 'analog');
  assert.deepEqual(list['dark-glass'].window.main, { width: 220, height: 96, minWidth: 140, minHeight: 64 });
  assert.deepEqual(list['dark-glass'].window['main+tools'], { width: 260, height: 200, minWidth: 220, minHeight: 180 });
  assert.deepEqual(list.analog.window.main, { width: 170, height: 170, minWidth: 100, minHeight: 100 });
  assert.deepEqual(list.analog.window['main+tools'], { width: 230, height: 250, minWidth: 210, minHeight: 230 });
});

test('background opacity defaults (theme.json) match the theme stylesheets and the #53 values', () => {
  const expected = { 'dark-glass': 0.78, light: 0.88, minimal: 0, neon: 0.9, analog: 0.85 };
  for (const t of registry().listThemes()) {
    assert.deepEqual(t.background, { opacity: expected[t.id] }, t.id);
    const css = fs.readFileSync(path.join(clockDir, 'themes', t.id, 'style.css'), 'utf8');
    assert.equal(Number(/--card-alpha:\s*([\d.]+)/.exec(css)?.[1]), expected[t.id], `${t.id}: fallback --card-alpha`);
  }
  // The card and the analog dial follow the engine's --theme-bg-alpha.
  assert.match(fs.readFileSync(path.join(clockDir, 'themes', 'dark-glass', 'clock.css'), 'utf8'), /var\(--theme-bg-alpha/);
  assert.match(fs.readFileSync(path.join(clockDir, 'themes', 'analog', 'style.css'), 'utf8'), /var\(--theme-bg-alpha/);
});

test('every file a theme page loads is found in the theme, its bases or the kit (as the engine serves it)', async () => {
  const reg = registry();
  for (const t of reg.listThemes()) {
    reg.getTheme(t.id);
    const page = await reg.resolveFile(`widget-theme://${t.id}.clock/index.html`);
    assert.ok(page, `${t.id}: index.html`);
    const html = fs.readFileSync(page.file, 'utf8');
    const refs = [...html.matchAll(/<(?:link|script)\b[^>]*?\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.includes('timer-model.js') && refs.includes('alarm-model.js'), 'the shared models come from the kit');
    for (const ref of refs) assert.ok(await reg.resolveFile(`widget-theme://${t.id}.clock/${ref}`), `${t.id}: ${ref}`);
    // A theme's own style.css wins over its base's.
    const style = await reg.resolveFile(`widget-theme://${t.id}.clock/style.css`);
    assert.equal(path.basename(path.dirname(style.file)), t.id);
  }
});

test('the package has the themes and the kit, and no old renderer, preview or test files', () => {
  const dir = packaged();
  for (const id of BUILT_IN) assert.ok(fs.existsSync(path.join(dir, 'themes', id, 'theme.json')), id);
  assert.ok(fs.existsSync(path.join(dir, 'kit', 'timer-model.js')));
  assert.ok(fs.existsSync(path.join(dir, 'kit', 'alarm-model.js')));
  for (const gone of ['renderer', 'preload', 'preview-model.js', 'themes.js', 'test']) assert.equal(fs.existsSync(path.join(dir, gone)), false, gone);
});

test('a user theme for the clock is listed; a Dooray theme in the clock folder is not usable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-themes-'));
  const userDir = path.join(dir, 'themes');
  const write = (id, json) => {
    fs.mkdirSync(path.join(userDir, id), { recursive: true });
    fs.writeFileSync(path.join(userDir, id, 'theme.json'), JSON.stringify({ id, name: id, version: '1.0.0', contractVersion: 1, ...json }));
  };
  write('my-clock', { widget: 'clock', extends: 'dark-glass' });
  write('glassy', {}); // no "widget": a Dooray theme
  const reg = createRegistry({
    widgetId: 'clock',
    builtinDir: path.join(packaged(), 'themes'),
    userDir,
    kitDir: path.join(packaged(), 'kit'),
    defaultTheme: 'dark-glass',
    contractVersions: [1],
    frames: { main: {} },
  });
  const list = Object.fromEntries(reg.listThemes().map((t) => [t.id, t]));
  assert.equal(list['my-clock'].usable, true);
  assert.equal(list['my-clock'].source, 'user');
  assert.equal(list.glassy.usable, false);
});
