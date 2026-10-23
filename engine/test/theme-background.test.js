// Per-theme background opacity, a theme host feature (theme contract v1.8, #55).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseBackground, sanitizeOpacityMap, effectiveOpacity, cssFor, CSS_VAR } = require('../main/theme-background');
const { validateManifest } = require('../main/theme-manifest');

// theme-host / windows / preview need Electron; a stub is enough for the parts tested here.
const ipcHandlers = new Map();
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: require.resolve('electron'),
  loaded: true,
  exports: {
    app: { getLocale: () => 'ko-KR' },
    ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
    shell: {},
    protocol: {},
    session: {},
    screen: {},
    BrowserWindow: class {},
    WebContentsView: class {},
  },
};
const { ThemeHost } = require('../main/theme-host');

const base = { id: 'skin', name: 'Skin', version: '1.0.0', contractVersion: 1 };

test('theme.json "background" (v1.8): optional, invalid values ignored without making the theme unusable', () => {
  assert.equal(validateManifest(base).manifest.background, null);
  assert.deepEqual(validateManifest({ ...base, background: { opacity: 0.82 } }).manifest.background, { opacity: 0.82 });
  assert.deepEqual(validateManifest({ ...base, background: { opacity: 0 } }).manifest.background, { opacity: 0 });
  assert.deepEqual(validateManifest({ ...base, background: { opacity: 1 } }).manifest.background, { opacity: 1 });
  for (const bad of [{ opacity: 1.2 }, { opacity: -0.1 }, { opacity: '0.5' }, { opacity: NaN }, {}, [], 0.5, 'x', null]) {
    const r = validateManifest({ ...base, background: bad });
    assert.equal(r.manifest.background, null, JSON.stringify(bad));
    assert.deepEqual(r.errors, []);
  }
  assert.deepEqual(parseBackground({ opacity: 0.123 }), { opacity: 0.12 });
});

test('stored values: valid theme ids and numbers only, clamped to 0..100', () => {
  assert.deepEqual(sanitizeOpacityMap({ glass: 40, bigsur: 140, mono: -3, sunset: 55.6, 'Bad Id': 10, midnight: '50', board: null, agenda: NaN }), {
    glass: 40,
    bigsur: 100,
    mono: 0,
    sunset: 56,
  });
  for (const junk of [null, undefined, 'x', 5, [1, 2]]) assert.deepEqual(sanitizeOpacityMap(junk), {});
});

test('effective opacity: live slider, then saved choice, then theme default; null when not supported', () => {
  const glass = { id: 'glass', background: { opacity: 0.62 } };
  const plain = { id: 'paper', background: null };
  assert.equal(effectiveOpacity(glass, {}), 0.62);
  assert.equal(effectiveOpacity(glass, undefined), 0.62);
  assert.equal(effectiveOpacity(glass, { glass: 30 }), 0.3);
  assert.equal(effectiveOpacity(glass, { glass: 'x' }), 0.62);
  assert.equal(effectiveOpacity(glass, { glass: 30 }, { themeId: 'glass', value: 80 }), 0.8);
  assert.equal(effectiveOpacity(glass, { glass: 30 }, { themeId: 'bigsur', value: 80 }), 0.3);
  assert.equal(effectiveOpacity(plain, { paper: 30 }), null);
  assert.equal(effectiveOpacity(plain, {}, { themeId: 'paper', value: 30 }), null);
  assert.equal(effectiveOpacity(null, {}), null);
});

test('the inserted stylesheet sets the variable on the root, above a theme\'s own :root', () => {
  assert.equal(CSS_VAR, '--theme-bg-alpha');
  assert.equal(cssFor(0.62), 'html:root { --theme-bg-alpha: 0.62; }');
  assert.equal(cssFor(1), 'html:root { --theme-bg-alpha: 1; }');
  assert.equal(cssFor(0), 'html:root { --theme-bg-alpha: 0; }');
  assert.equal(cssFor(0.5), 'html:root { --theme-bg-alpha: 0.5; }');
});

/** A theme page's webContents that records what the engine did to it. */
function fakePage() {
  let n = 0;
  return {
    id: Math.random(),
    css: new Map(),
    sent: [],
    isDestroyed: () => false,
    once() {},
    on() {},
    insertCSS(css) {
      const key = `k${++n}`;
      this.css.set(key, css);
      return Promise.resolve(key);
    },
    removeInsertedCSS(key) {
      this.css.delete(key);
      return Promise.resolve();
    },
    send(channel, payload) {
      this.sent.push([channel, payload]);
    },
  };
}

function makeHost(saved) {
  let settings = { themeId: 'glass', themeOpacity: saved, projectWidgets: [] };
  const store = { load: () => settings, save: (p) => (settings = { ...settings, ...p }) };
  const host = new ThemeHost({
    store,
    builtinDir: path.join(__dirname, '..', '..', 'widgets', 'dooray', 'themes'),
    userDir: null,
    api: {},
    openSettings() {},
    onQuitRequest() {},
  });
  return { host, store };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const pageCss = (page) => [...page.css.values()];

test('preview and widget pages show each theme with the user\'s value for that theme', async () => {
  const { host, store } = makeHost({ bigsur: 35 });
  const glass = { id: 'glass', name: 'Glass', background: { opacity: 0.62 } };
  const bigsur = { id: 'bigsur', name: 'Big Sur', background: { opacity: 0.78 } };
  const paper = { id: 'paper', name: 'Paper', background: null };
  const widget = fakePage();
  const preview = fakePage();
  const plain = fakePage();
  host.windows.theme = glass;
  host.windows.register(widget, { win: { webContents: widget, isDestroyed: () => false }, mode: 'overview' });
  host.windows.register(preview, { preview: true, webContents: preview, theme: bigsur, mode: 'overview' });
  host.windows.register(plain, { preview: true, webContents: plain, theme: paper, mode: 'overview' });

  host.applyBackground();
  await settle();
  assert.deepEqual(pageCss(widget), ['html:root { --theme-bg-alpha: 0.62; }']); // glass default
  assert.deepEqual(pageCss(preview), ['html:root { --theme-bg-alpha: 0.35; }']); // saved for bigsur
  assert.deepEqual(pageCss(plain), [], 'a theme without "background" is never touched');
  assert.deepEqual(plain.sent, []);
  assert.deepEqual(preview.sent.at(-1), ['theme:background', { opacity: 0.35 }]);

  // Slider moves for glass: only glass pages change, and the old stylesheet is replaced, not stacked.
  host.setLiveOpacity('glass', 20);
  await settle();
  assert.deepEqual(pageCss(widget), ['html:root { --theme-bg-alpha: 0.2; }']);
  assert.deepEqual(pageCss(preview), ['html:root { --theme-bg-alpha: 0.35; }']);

  // Closing the settings window without saving goes back to what is saved.
  host.setLiveOpacity(null, null);
  await settle();
  assert.deepEqual(pageCss(widget), ['html:root { --theme-bg-alpha: 0.62; }']);

  // Saving then re-applying uses the new stored value.
  store.save({ themeOpacity: { glass: 90, bigsur: 35 } });
  host.applyBackground();
  await settle();
  assert.deepEqual(pageCss(widget), ['html:root { --theme-bg-alpha: 0.9; }']);

  // The theme context carries the value too (null for a theme without "background").
  const context = ipcHandlers.get('theme:get-context');
  assert.deepEqual((await context({ sender: widget })).background, { opacity: 0.9 });
  assert.deepEqual((await context({ sender: preview })).background, { opacity: 0.35 });
  assert.equal((await context({ sender: plain })).background, null);
});

test('settings handlers expose the live slider call', () => {
  const { host } = makeHost({});
  const calls = host.settingsHandlers();
  assert.equal(typeof calls.liveOpacity, 'function');
  calls.liveOpacity('glass', 140);
  assert.deepEqual(host.liveOpacity, { themeId: 'glass', value: 100 });
  calls.liveOpacity('glass', null);
  assert.equal(host.liveOpacity, null);
});
