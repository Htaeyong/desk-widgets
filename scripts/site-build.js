// Builds the static download site data (#99): site/public/products.json from package.json + widgets/*/widget.json,
// and copies the widget screenshots from docs/images into site/public/img.
// hero.jpg is an optimized copy of docs/images/hero.png (made once with Electron nativeImage) and is kept as is.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const siteDir = path.join(root, 'site', 'public');

// widget id -> screenshot in docs/images
const SCREENSHOTS = {
  dooray: 'dooray.png',
  clock: 'clock.png',
  calendar: 'calendar-big.png',
  mail: 'mail.png',
  todo: 'todo.png',
  memo: 'memo-meeting.png',
  'system-monitor': 'system-monitor.png',
};

// First engine version that provides each engine API level, among RELEASED engines (release-notes/engine-v*.md).
// Engine 1.0.3 (API 1.5) was never released, so API 1.5 maps to 1.0.4, the first release that has it.
const ENGINE_FOR_API = { '1.0': '1.0.0', '1.1': '1.0.0', '1.2': '1.0.1', '1.3': '1.0.1', '1.4': '1.0.2', '1.5': '1.0.4', '1.6': '1.0.4' };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** products.json content: the engine plus every widget, ordered by widget.json "order". */
function buildProducts(baseDir = root) {
  const pkg = readJson(path.join(baseDir, 'package.json'));
  const engineApi = fs.readFileSync(path.join(baseDir, 'engine', 'main', 'widgets.js'), 'utf8').match(/const ENGINE_API = '([\d.]+)'/)?.[1] || null;
  const widgetsDir = path.join(baseDir, 'widgets');
  const widgets = fs.readdirSync(widgetsDir)
    .filter((id) => fs.existsSync(path.join(widgetsDir, id, 'widget.json')))
    .map((id) => readJson(path.join(widgetsDir, id, 'widget.json')))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      productName: m.package?.productName,
      version: m.version,
      engineApi: m.engineApi,
      engineMin: ENGINE_FOR_API[m.engineApi] || null,
      image: SCREENSHOTS[m.id] ? `img/${SCREENSHOTS[m.id]}` : null,
    }));
  return {
    engine: { id: 'engine', name: 'Desk Widgets', description: 'Windows 바탕화면 위젯 엔진', version: pkg.version, engineApi },
    widgets,
  };
}

function build() {
  const products = buildProducts();
  fs.mkdirSync(path.join(siteDir, 'img'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'products.json'), JSON.stringify(products, null, 2) + '\n');
  for (const file of new Set(Object.values(SCREENSHOTS))) {
    fs.copyFileSync(path.join(root, 'docs', 'images', file), path.join(siteDir, 'img', file));
  }
  console.log(`site: products.json (${products.widgets.length} widgets), ${Object.keys(SCREENSHOTS).length} images`);
}

if (require.main === module) build();
module.exports = { buildProducts, SCREENSHOTS, ENGINE_FOR_API };
