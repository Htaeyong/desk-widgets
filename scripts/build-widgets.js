// Build every widget with a manifest so newly added widgets join dist:widgets automatically.
const fs = require('fs');
const path = require('path');
const { build } = require('../tools/widget-kit/build');

const root = path.join(__dirname, '..');
const widgets = path.join(root, 'widgets');

for (const id of fs.readdirSync(widgets).sort()) {
  const folder = path.join(widgets, id);
  if (!fs.statSync(folder).isDirectory() || !fs.existsSync(path.join(folder, 'widget.json'))) continue;
  const result = build(folder, { out: path.join(root, 'dist') });
  console.log(`${result.id} ${result.version}: ${path.relative(root, result.installer)}`);
}
