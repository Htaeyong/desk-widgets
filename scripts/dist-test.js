// Test builds (not a release): engine installer + every widget's package and installer in dist/test.
// Usage: npm run dist:test -- <version>     e.g. 1.1.0-test.2
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { build } = require('../tools/widget-kit/build');
const { isFrozen, isUnreleasedWidget } = require('./version');

const version = process.argv[2];
if (!version) {
  console.error('Usage: npm run dist:test -- <version>   (e.g. 1.1.0-test.2)');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'test');
fs.rmSync(out, { recursive: true, force: true });

execSync(`npx electron-builder --win -c.extraMetadata.version=${version} -c.directories.output=dist/test`, { cwd: root, stdio: 'inherit' });

const widgetsRoot = path.join(root, 'widgets');
for (const id of fs.readdirSync(widgetsRoot)) {
  if (!fs.existsSync(path.join(widgetsRoot, id, 'widget.json'))) continue;
  // A frozen widget (#111) keeps its last release; it is never rebuilt under a test version.
  const manifest = JSON.parse(fs.readFileSync(path.join(widgetsRoot, id, 'widget.json'), 'utf8'));
  if (isFrozen(manifest)) continue;
  // A widget before its official release (0.0.x, #111) is built at its own version, not the suite's test version.
  const r = build(path.join(widgetsRoot, id), isUnreleasedWidget(manifest) ? { out } : { version, out });
  console.log(`${r.id}: ${path.relative(root, r.installer)}`);
}
