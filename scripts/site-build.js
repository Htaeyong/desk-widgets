// Builds the static download site data (#99): site/public/products.json from package.json + widgets/*/widget.json,
// and copies the widget screenshots from docs/images into site/public/img.
// #106: also fills the SoftwareApplication JSON-LD in index.html and writes sitemap.xml/robots.txt (lastmod moves only when the page changes).
// hero.jpg is an optimized copy of docs/images/hero.png (made once with Electron nativeImage) and is kept as is.
// #104: each product also gets "download" (released installer: version, tag, file, url, size, sha256) from
// site/releases.json, which scripts/release.js writes after uploading. The engine's in-app update reads it.
const fs = require('fs');
const crypto = require('crypto');
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

const DOWNLOAD_KEYS = ['version', 'tag', 'file', 'url', 'size', 'sha256'];

/** The released-installer record of a product (site/releases.json), checked; null when missing. */
function downloadOf(records, id) {
  const r = records[id];
  if (!r) return null;
  const ok = /^\d+\.\d+\.\d+$/.test(r.version || '') && /^https:\/\/github\.com\//.test(r.url || '') && String(r.url).endsWith(`/${encodeURIComponent(r.file)}`) &&
    Number.isSafeInteger(r.size) && r.size > 0 && /^[0-9a-f]{64}$/.test(r.sha256 || '') && r.tag;
  if (!ok) throw new Error(`site/releases.json: bad record for ${id}`);
  return Object.fromEntries(DOWNLOAD_KEYS.map((k) => [k, r[k]]));
}

/** products.json content: the engine plus every widget, ordered by widget.json "order". */
function buildProducts(baseDir = root) {
  const pkg = readJson(path.join(baseDir, 'package.json'));
  const engineApi = fs.readFileSync(path.join(baseDir, 'engine', 'main', 'widgets.js'), 'utf8').match(/const ENGINE_API = '([\d.]+)'/)?.[1] || null;
  const releasesFile = path.join(baseDir, 'site', 'releases.json');
  const records = fs.existsSync(releasesFile) ? readJson(releasesFile) : {};
  const withDownload = (entry) => {
    const download = downloadOf(records, entry.id);
    return download ? { ...entry, download } : entry;
  };
  const widgetsDir = path.join(baseDir, 'widgets');
  const widgets = fs.readdirSync(widgetsDir)
    .filter((id) => fs.existsSync(path.join(widgetsDir, id, 'widget.json')))
    .map((id) => readJson(path.join(widgetsDir, id, 'widget.json')))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .map((m) => withDownload({
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
    engine: withDownload({ id: 'engine', name: 'Desk Widgets', description: 'Windows 바탕화면 위젯 엔진', version: pkg.version, engineApi }),
    widgets,
  };
}

const SITE_URL = 'https://widgets.chilgong88.com/';
const JSONLD_RE = /(<!-- seo:jsonld[^>]*-->\r?\n)[\s\S]*?(\r?\n\s*<!-- \/seo:jsonld -->)/;
// Files whose change counts as "the page changed" for the sitemap lastmod.
const PAGE_FILES = ['index.html', 'app.js', 'style.css', 'products.json', 'showcase.json'];

/** SoftwareApplication structured data for the engine (a plain data block: it is not executed, so the strict CSP does not matter). */
function buildJsonLd(products) {
  const engine = products.engine;
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Desk Widgets',
    description: '윈도우 바탕화면 위젯 엔진. 두레이, 캘린더, 메일, 할 일, 시계, 스티키 노트, 시스템 모니터 위젯을 골라 설치합니다.',
    url: SITE_URL,
    image: `${SITE_URL}img/hero.jpg`,
    operatingSystem: 'Windows 10, Windows 11',
    applicationCategory: 'UtilitiesApplication',
    softwareVersion: engine.version,
    inLanguage: 'ko',
    license: 'https://opensource.org/licenses/MIT',
    downloadUrl: engine.download ? engine.download.url : 'https://github.com/Htaeyong/desk-widgets/releases',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'KRW' },
  };
}

/** index.html with the JSON-LD block filled in. */
function renderIndex(html, products) {
  if (!JSONLD_RE.test(html)) throw new Error('index.html: seo:jsonld markers missing');
  const json = JSON.stringify(buildJsonLd(products), null, 2).replace(/</g, '\u003c');
  const block = `  <script type="application/ld+json">\n${json}\n  </script>`;
  return html.replace(JSONLD_RE, (m, a, b) => a + block + b);
}

/** Hash of the page files, line endings normalised so a CRLF checkout gives the same value. */
function pageHash(dir = siteDir) {
  const h = crypto.createHash('sha256');
  for (const f of PAGE_FILES) h.update(`${f}\n${fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')}\n`);
  return h.digest('hex');
}

function sitemapXml(lastmod) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${SITE_URL}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>\n</urlset>\n`;
}

function robotsTxt() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** site/sitemap-state.json keeps the page hash and the date it last changed; sitemap.xml lastmod follows it. */
function updateSitemap() {
  const stateFile = path.join(root, 'site', 'sitemap-state.json');
  const hash = pageHash();
  const old = fs.existsSync(stateFile) ? readJson(stateFile) : {};
  const state = old.hash === hash && old.lastmod ? old : { hash, lastmod: today() };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(path.join(siteDir, 'sitemap.xml'), sitemapXml(state.lastmod));
  fs.writeFileSync(path.join(siteDir, 'robots.txt'), robotsTxt());
}

function build() {
  const products = buildProducts();
  fs.mkdirSync(path.join(siteDir, 'img'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'products.json'), JSON.stringify(products, null, 2) + '\n');
  for (const file of new Set(Object.values(SCREENSHOTS))) {
    fs.copyFileSync(path.join(root, 'docs', 'images', file), path.join(siteDir, 'img', file));
  }
  const indexFile = path.join(siteDir, 'index.html');
  const html = fs.readFileSync(indexFile, 'utf8');
  const next = renderIndex(html, products);
  if (next !== html) fs.writeFileSync(indexFile, next);
  updateSitemap();
  console.log(`site: products.json (${products.widgets.length} widgets), ${Object.keys(SCREENSHOTS).length} images`);
}

if (require.main === module) build();
module.exports = { buildProducts, buildJsonLd, renderIndex, pageHash, sitemapXml, robotsTxt, SITE_URL, downloadOf, SCREENSHOTS, ENGINE_FOR_API };
