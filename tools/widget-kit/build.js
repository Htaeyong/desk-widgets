// Builds a Desk Widgets widget: the widget package folder and its own Windows installer.
// Usage: node tools/widget-kit/build.js <widget folder> [--version <v>] [--out <folder>]
//   -> <out>/widgets/<id>/                                   the package (what the installer copies)
//   -> <out>/DeskWidgets-<package.productName>-Setup-<v>.exe  the installer
// The widget folder needs widget.json with "package": { productName, exclude?, installerHooks? }.
// Needs NSIS (makensis): electron-builder's cached copy is used, or set MAKENSIS / NSIS_DIR.
// Kept free of engine code so a widget can move to its own repository with this kit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ENGINE_APP_ID = 'com.chilgong88.desk-widgets';
// electron-builder names the engine's registry keys after UUIDv5(appId, this namespace).
const ELECTRON_BUILDER_NS = '50e065bc-3134-11e6-9bab-38c9862bdaf3';
const ALWAYS_EXCLUDED = ['node_modules', '.git', 'dist'];

function uuidV5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** First match of a folder pattern under electron-builder's cache, newest version last. */
function fromBuilderCache(prefix, ...rest) {
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'nsis');
  if (!fs.existsSync(cache)) return null;
  const dirs = fs.readdirSync(cache).filter((d) => d.startsWith(prefix)).sort();
  for (const d of dirs.reverse()) {
    const p = path.join(cache, d, ...rest);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findMakensis() {
  const candidates = [
    process.env.MAKENSIS,
    process.env.NSIS_DIR && path.join(process.env.NSIS_DIR, 'makensis.exe'),
    fromBuilderCache('nsis-3', 'Bin', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('makensis.exe not found: run "npm run dist" once (electron-builder downloads NSIS) or set MAKENSIS');
  return found;
}

function findStdUtils() {
  // StdUtils.nsh (header) ships with app-builder-lib; StdUtils.dll (plugin) with the NSIS resources.
  let include = process.env.STDUTILS_INCLUDE;
  if (!include) {
    try {
      include = path.join(path.dirname(require.resolve('app-builder-lib/package.json', { paths: [process.cwd(), __dirname] })), 'templates', 'nsis', 'include');
    } catch {
      include = null;
    }
  }
  const plugins = process.env.STDUTILS_PLUGINS || fromBuilderCache('nsis-resources', 'plugins', 'x86-unicode');
  if (!include || !fs.existsSync(path.join(include, 'StdUtils.nsh')) || !plugins) {
    throw new Error('StdUtils for NSIS not found (app-builder-lib and electron-builder NSIS resources); set STDUTILS_INCLUDE / STDUTILS_PLUGINS');
  }
  return { include, plugins };
}

function copyPackage(src, dest, exclude) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (exclude.includes(entry)) continue;
    fs.cpSync(path.join(src, entry), path.join(dest, entry), { recursive: true });
  }
}

/**
 * Writes the package: the widget folder without excluded entries, and widget.json with the
 * version and without the build-only "package" section. Used by build() and by tests.
 */
function packageWidget(widgetDir, pkgDir, version) {
  const dir = path.resolve(widgetDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'widget.json'), 'utf8'));
  copyPackage(dir, pkgDir, [...ALWAYS_EXCLUDED, ...(manifest.package?.exclude || [])]);
  const { package: _p, ...shipped } = manifest;
  fs.writeFileSync(path.join(pkgDir, 'widget.json'), JSON.stringify({ ...shipped, version: version || manifest.version }, null, 2) + '\n');
  return pkgDir;
}

function build(widgetDir, { version: versionArg, out = 'dist' } = {}) {
  const dir = path.resolve(widgetDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'widget.json'), 'utf8'));
  const pkg = manifest.package || {};
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.id || '')) throw new Error('widget.json: invalid id');
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(pkg.productName || '')) throw new Error('widget.json: package.productName (letters and digits, e.g. DoorayWidget) is required');
  if (!manifest.engineApi) throw new Error('widget.json: engineApi is required');
  const version = versionArg || manifest.version || '0.0.0';
  const outDir = path.resolve(out);
  const pkgDir = path.join(outDir, 'widgets', manifest.id);

  // 1. Package folder
  packageWidget(dir, pkgDir, version);

  // 2. Installer
  const makensis = findMakensis();
  const stdUtils = findStdUtils();
  const outFile = path.join(outDir, `DeskWidgets-${pkg.productName}-Setup-${version}.exe`);
  const numeric = (version.match(/^\d+(\.\d+){0,3}/)?.[0] || '0').split('.');
  while (numeric.length < 4) numeric.push('0');
  const defines = {
    WIDGET_ID: manifest.id,
    WIDGET_NAME: manifest.name,
    PRODUCT_NAME: pkg.productName,
    VERSION: version,
    VI_VERSION: numeric.join('.'),
    PKG_DIR: pkgDir,
    OUT_FILE: outFile,
    ENGINE_GUID: uuidV5(ENGINE_APP_ID, ELECTRON_BUILDER_NS),
    ...(pkg.installerHooks ? { HOOKS: path.join(dir, pkg.installerHooks) } : {}),
  };
  const args = [
    '-INPUTCHARSET', 'UTF8',
    `-X!addincludedir "${stdUtils.include}"`,
    `-X!addplugindir /x86-unicode "${stdUtils.plugins}"`,
    ...Object.entries(defines).map(([k, v]) => `-D${k}=${v}`),
    path.join(__dirname, 'installer.nsi'),
  ];
  if (process.env.WIDGET_KIT_VERBOSE) args.unshift('-V4');
  execFileSync(makensis, args, { stdio: process.env.WIDGET_KIT_VERBOSE ? 'inherit' : 'pipe' });
  return { id: manifest.id, version, pkgDir, installer: outFile };
}

if (require.main === module) {
  const widgetDir = process.argv[2];
  if (!widgetDir || widgetDir.startsWith('--')) {
    console.error('Usage: node tools/widget-kit/build.js <widget folder> [--version <v>] [--out <folder>]');
    process.exit(1);
  }
  try {
    const r = build(widgetDir, { version: arg('--version'), out: arg('--out') });
    console.log(`${r.id} ${r.version}\n  package:   ${r.pkgDir}\n  installer: ${r.installer}`);
  } catch (err) {
    console.error(err.stderr ? String(err.stdout || '') + String(err.stderr) : err.message);
    process.exit(1);
  }
}

module.exports = { build, packageWidget, uuidV5, ENGINE_APP_ID };
