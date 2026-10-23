// Background opacity of the built-in themes (#55): every theme with a transparent window declares
// its default in theme.json and draws its background with --theme-bg-alpha, falling back to that default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateManifest } = require('../../../engine/main/theme-manifest');
const { sanitizeThemeOpacity, DEFAULTS } = require('../settings');

const themesDir = path.join(__dirname, '..', 'themes');
const ids = fs.readdirSync(themesDir).filter((id) => fs.existsSync(path.join(themesDir, id, 'theme.json')));
const manifestOf = (id) => validateManifest(JSON.parse(fs.readFileSync(path.join(themesDir, id, 'theme.json'), 'utf8')), id).manifest;

/** The stylesheet that holds a theme's own colors: glass keeps them in base.css, the others in style.css. */
const ownCss = (id) => fs.readFileSync(path.join(themesDir, id, id === 'glass' ? 'base.css' : 'style.css'), 'utf8');

test('every transparent built-in theme declares a background opacity default', () => {
  for (const id of ids) {
    const m = manifestOf(id);
    // An opaque window (paper) cannot show through, so it offers no slider.
    if (!m.window.transparent) {
      assert.equal(m.background, null, `${id}: opaque window must not declare background`);
      continue;
    }
    assert.ok(m.background, `${id}: theme.json needs "background": { "opacity": 0..1 }`);
  }
});

test('built-in themes use --theme-bg-alpha with their theme.json default as the fallback', () => {
  for (const id of ids) {
    const m = manifestOf(id);
    if (!m.background) continue;
    const css = ownCss(id);
    const fallback = /--bg-alpha:\s*var\(--theme-bg-alpha,\s*([\d.]+)\)/.exec(css);
    assert.ok(fallback, `${id}: --bg-alpha must come from var(--theme-bg-alpha, <default>)`);
    assert.equal(Number(fallback[1]), m.background.opacity, `${id}: CSS fallback must equal theme.json default`);
    // A color skin of glass (no page of its own) feeds glass's shell; a theme with its own page uses the alpha itself.
    const skin = m.extends === 'glass' && !fs.existsSync(path.join(themesDir, id, m.entry));
    if (skin) assert.ok(/--shell-rgb:|--shell-bg:[^;]*var\(--bg-alpha\)/.test(css), `${id}: set --shell-rgb or a --shell-bg with var(--bg-alpha)`);
    else assert.match(css, /rgba\((?:[^()]|\([^()]*\))*var\(--bg-alpha\)\)/, `${id}: background must use var(--bg-alpha)`);
  }
  // glass draws the shell from --shell-rgb and --bg-alpha, which every skin overrides.
  assert.match(ownCss('glass'), /--shell-bg:\s*rgba\(var\(--shell-rgb\),\s*var\(--bg-alpha\)\)/);
});

test('popups keep a fixed, readable background (not tied to the slider)', () => {
  for (const id of ids) {
    const css = ownCss(id);
    const pop = /--pop-bg:\s*([^;]+);/.exec(css);
    if (pop) assert.doesNotMatch(pop[1], /bg-alpha/, `${id}: --pop-bg must not follow the slider`);
  }
});

test('Dooray settings keep themeOpacity as { themeId: 0..100 }', () => {
  assert.deepEqual(DEFAULTS.themeOpacity, {});
  assert.deepEqual(sanitizeThemeOpacity({ glass: 40.4, bigsur: 120, mono: -1, 'Bad Id': 5, sunset: '50' }), { glass: 40, bigsur: 100, mono: 0 });
  assert.deepEqual(sanitizeThemeOpacity(null), {});
  assert.deepEqual(sanitizeThemeOpacity([3]), {});
});
