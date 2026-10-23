// Every local file a widget's pages load must ship inside that widget's own package (#40):
// widgets are installed apart from the engine, so "../" or engine files are not there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packageWidget } = require('../../tools/widget-kit/build');

const widgetsRoot = path.join(__dirname, '..', '..', 'widgets');
const widgetIds = fs.readdirSync(widgetsRoot).filter((id) => fs.existsSync(path.join(widgetsRoot, id, 'widget.json')));

/** Local references in HTML: link href, script src, img src (not URLs, data:, anchors). */
function localRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<(link|script|img|source)\b[^>]*?\s(href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[3].trim();
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
    refs.push(ref.split(/[?#]/)[0]);
  }
  return refs;
}

const htmlFiles = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .map((f) => path.join(dir, f));

/** Folders a theme's files may come from: its own, then its "extends" bases (THEME_SPEC). */
function themeDirs(themesDir, id) {
  const dirs = [];
  for (let cur = id, n = 0; cur && n < 5; n++) {
    const dir = path.join(themesDir, cur);
    if (!fs.existsSync(dir)) break;
    dirs.push(dir);
    cur = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')).extends;
  }
  return dirs;
}

const packages = new Map();
function packaged(id) {
  if (!packages.has(id)) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `pkg-${id}-`)), id);
    packages.set(id, packageWidget(path.join(widgetsRoot, id), out));
  }
  return packages.get(id);
}

for (const id of widgetIds) {
  test(`${id}: every file its pages load is inside its own package`, () => {
    const pkg = packaged(id);
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'widget.json'), 'utf8'));
    const panel = manifest.settings ? path.resolve(pkg, manifest.settings.html) : null;
    const themesDir = path.join(pkg, 'themes');
    let checked = 0;
    for (const file of htmlFiles(pkg)) {
      const rel = path.relative(pkg, file);
      const refs = localRefs(fs.readFileSync(file, 'utf8'));
      if (file === panel) {
        // Inserted into the engine's settings window: relative paths would point at engine files.
        assert.deepEqual(refs, [], `${rel}: a settings panel must not load files itself (use settings.script / settings.style)`);
        continue;
      }
      // A theme page may take a file from its base theme ("extends"); other pages only from their own folder.
      const inTheme = path.relative(themesDir, file);
      const isThemePage = !inTheme.startsWith('..') && !path.isAbsolute(inTheme);
      const roots = isThemePage ? themeDirs(themesDir, inTheme.split(path.sep)[0]) : [path.dirname(file)];
      // The widget's shared kit (useThemes kitDir, by convention <package>/kit) is every theme's last base (#57).
      if (isThemePage && fs.existsSync(path.join(pkg, 'kit'))) roots.push(path.join(pkg, 'kit'));
      for (const ref of refs) {
        const found = roots.some((root) => {
          const target = path.resolve(root === path.dirname(file) ? root : path.join(root, path.relative(roots[0], path.dirname(file))), ref);
          return target.startsWith(pkg + path.sep) && fs.existsSync(target);
        });
        assert.ok(found, `${id}/${rel} loads "${ref}", which is not in the ${id} package`);
        checked++;
      }
    }
    // Files the manifest names exist too.
    for (const f of [manifest.main || 'index.js', manifest.settings?.html, manifest.settings?.script, manifest.settings?.style].filter(Boolean)) {
      assert.ok(fs.existsSync(path.join(pkg, f)), `${id}: ${f} missing from the package`);
    }
    assert.ok(checked > 0 || id === 'none');
  });
}

test('the check catches a page that loads an engine file (the #40 bug)', () => {
  assert.deepEqual(localRefs('<link rel="stylesheet" href="settings.css" /><script src="x.js"></script><img src="data:image/png;base64,AA" /><link href="https://a/b.css">'), ['settings.css', 'x.js']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
  fs.writeFileSync(path.join(dir, 'page.html'), '<link rel="stylesheet" href="settings.css" />');
  const missing = localRefs(fs.readFileSync(path.join(dir, 'page.html'), 'utf8')).filter((r) => !fs.existsSync(path.join(dir, r)));
  assert.deepEqual(missing, ['settings.css']);
});
