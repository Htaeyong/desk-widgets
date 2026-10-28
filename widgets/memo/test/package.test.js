// The memo package and uninstall safety (#75): uninstallers delete the widget's install folder and (when the user
// asks) its data folder or the engine's whole data folder; memos live in Documents, which none of them touches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packageWidget } = require('../../../tools/widget-kit/build');
const S = require('../lib/settings');

const root = path.join(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'widget.json'), 'utf8'));

test('widget.json: id, official version, engine API 1.8, no installer hooks', () => {
  assert.equal(manifest.id, 'memo');
  assert.equal(manifest.version, '1.1.1');
  assert.equal(manifest.engineApi, '1.8');
  assert.equal(manifest.name, '스티키 노트');
  assert.equal(manifest.package.productName, 'StickyNoteWidget');
  assert.equal(manifest.package.installerHooks, undefined, 'no extra uninstall steps');
});

// #95: the 0.0.1 build was "Desk Widgets-MemoWidget". The installer template keys everything on the widget id
// (registry key DeskWidgets-<id>, install folder widgets\<id>, its uninstall.exe), never on the product name, so
// StickyNoteWidget over MemoWidget rewrites the same Control Panel entry and uninstaller: no second entry is left
// behind that could later remove the new install.
test('the product name is only a label: the Control Panel entry, folder and uninstaller follow the widget id', () => {
  const nsi = fs.readFileSync(path.join(root, 'tools', 'widget-kit', 'installer.nsi'), 'utf8');
  const code = nsi
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith(';'))
    .join('\n');
  assert.match(code, /!define UNINSTALL_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeskWidgets-\$\{WIDGET_ID\}"/);
  assert.match(code, /InstallDir "\$PROGRAMFILES64\\chilgong88\\widgets\\\$\{WIDGET_ID\}"/);
  assert.match(code, /StrCpy \$INSTDIR "\$0\\widgets\\\$\{WIDGET_ID\}"/);
  assert.match(code, /WriteUninstaller "\$INSTDIR\\uninstall\.exe"/);
  // PRODUCT_NAME appears only in shown names (DISPLAY_NAME), never in a key, a path or a deletion.
  const uses = code.split(/\r?\n/).filter((l) => l.includes('PRODUCT_NAME'));
  assert.deepEqual(uses.map((l) => l.trim()), ['!define DISPLAY_NAME "Desk Widgets-${PRODUCT_NAME}"']);
  for (const l of code.split(/\r?\n/).filter((x) => x.includes('DISPLAY_NAME'))) assert.doesNotMatch(l.trim(), /^(RMDir|Delete|DeleteRegKey|InstallDir|WriteUninstaller)\b/);
  assert.match(code, /WriteRegStr HKLM "\$\{UNINSTALL_KEY\}" "DisplayName" "\$\{DISPLAY_NAME\}"/);
  // The build passes the id from widget.json, which stays "memo".
  const build = fs.readFileSync(path.join(root, 'tools', 'widget-kit', 'build.js'), 'utf8');
  assert.match(build, /WIDGET_ID: manifest\.id,/);
  assert.match(build, /DeskWidgets-\$\{pkg\.productName\}-Setup-\$\{version\}\.exe/);
});

test('the package has the pages, scripts and libraries and no tests', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-memo-')), 'memo');
  packageWidget(path.join(root, 'widgets', 'memo'), out);
  for (const f of ['widget.json', 'index.js', 'preload.js', 'lib/markdown.js', 'lib/html.js', 'lib/library.js', 'lib/session.js', 'lib/files.js', 'lib/settings.js', 'lib/migrate.js', 'memo/memo.html', 'memo/memo.js', 'memo/memo.css', 'list/list.html', 'list/list.js', 'list/list.css', 'settings/panel.html', 'settings/panel.js', 'settings/panel.css']) {
    assert.ok(fs.existsSync(path.join(out, f)), f);
  }
  assert.ok(!fs.existsSync(path.join(out, 'test')));
  assert.ok(!fs.existsSync(path.join(out, 'package.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'widget.json'), 'utf8')).package, undefined);
  // The pages load nothing from outside the package and no remote content (CSP).
  for (const page of ['memo/memo.html', 'list/list.html']) {
    const html = fs.readFileSync(path.join(out, page), 'utf8');
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'/);
    assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//);
  }
});

test('the uninstallers only delete the install folder and %APPDATA%\\chilgong88\\desk-widgets(\\widgets\\<id>)', () => {
  const widgetNsi = fs.readFileSync(path.join(root, 'tools', 'widget-kit', 'installer.nsi'), 'utf8');
  const engineNsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  const removed = [...`${widgetNsi}\n${engineNsh}`.matchAll(/^\s*(?:RMDir(?:\s+\/r)?|Delete)\s+"([^"]+)"/gim)].map((m) => m[1]);
  assert.ok(removed.length > 0);
  for (const target of removed) {
    assert.doesNotMatch(target, /DOCUMENTS|PERSONAL|PROFILE|Desk Widgets\\노트/i, `${target} must not be a user documents path`);
    assert.match(target, /^\$(INSTDIR|APPDATA\\chilgong88|0|R\d|1)/, `${target} is an install or app data path`);
  }
});

test('the default notes folder is in Documents, outside every folder an uninstaller deletes', () => {
  const user = 'C:\\Users\\홍길동';
  const where = { widgetDir: 'C:\\Program Files\\chilgong88\\widgets\\memo', dataDir: `${user}\\AppData\\Roaming\\chilgong88\\desk-widgets\\widgets\\memo` };
  const notes = S.defaultNotesDir(`${user}\\Documents`);
  assert.equal(notes, `${user}\\Documents\\Desk Widgets\\스티키 노트`);
  assert.equal(S.checkNotesDir(notes, where), null);
  assert.deepEqual(S.protectedDirs(where), [
    'C:\\Program Files\\chilgong88\\widgets\\memo',
    'C:\\Program Files\\chilgong88',
    `${user}\\AppData\\Roaming\\chilgong88\\desk-widgets\\widgets\\memo`,
    `${user}\\AppData\\Roaming\\chilgong88\\desk-widgets`,
  ]);
  // A notes folder the user picks inside those folders is refused (it could be deleted with the program).
  for (const bad of [
    `${user}\\AppData\\Roaming\\chilgong88\\desk-widgets\\widgets\\memo\\notes`,
    `${user}\\AppData\\Roaming\\chilgong88\\desk-widgets`,
    'C:\\Program Files\\chilgong88\\widgets\\memo',
    'C:\\Program Files\\chilgong88\\Desk Widgets\\notes',
    'relative\\folder',
  ]) {
    assert.ok(S.checkNotesDir(bad, where), bad);
  }
  // Elsewhere is fine (e.g. OneDrive, another drive, a parent of AppData).
  for (const ok of [`${user}\\OneDrive\\문서\\노트`, 'D:\\노트', user]) assert.equal(S.checkNotesDir(ok, where), null, ok);
});

test('the widget code never deletes a whole folder in the notes folder (only trash, moves and its own temp files)', () => {
  const lib = ['index.js', 'lib/library.js', 'lib/session.js', 'lib/files.js', 'lib/migrate.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.doesNotMatch(lib, /\brmSync\b|\brm\(|recursive:\s*true\s*,\s*force/);
  // rmdir only in the folder rename of #95, and only non-recursive (Windows refuses a folder that is not empty).
  const rmdirs = lib.match(/[\w.]*rmdir\w*\([^)]*\)/gi) || [];
  assert.deepEqual(rmdirs, ['f.rmdirSync(newDir)', 'f.rmdirSync(newDir)']);
  // unlink only for: the temp file of an atomic write, and an untouched empty new memo.
  const unlinks = lib.match(/unlink(Sync)?\(/g) || [];
  assert.ok(unlinks.length <= 3, `unexpected unlink calls: ${unlinks.length}`);
});
