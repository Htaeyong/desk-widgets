// Guards for the installer scripts (they cannot run in tests): what an uninstall may delete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function installerScripts() {
  const files = ['build/installer.nsh', 'tools/widget-kit/installer.nsi'];
  for (const id of fs.readdirSync(path.join(root, 'widgets'))) {
    const dir = path.join('widgets', id, 'installer');
    if (fs.existsSync(path.join(root, dir))) for (const f of fs.readdirSync(path.join(root, dir))) files.push(path.join(dir, f).replace(/\\/g, '/'));
  }
  return files;
}

// NSIS lines that delete files or folders (comments excluded).
const deletions = (src) =>
  src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !l.startsWith(';') && /^(RMDir|Delete)\b/i.test(l));

test('no uninstall path deletes the old app folder %APPDATA%\\dooray-widget (migration backup, #36)', () => {
  for (const file of installerScripts()) {
    for (const line of deletions(read(file))) assert.ok(!/dooray-widget/i.test(line), `${file}: ${line}`);
  }
});

test('the old Dooray Widget app is uninstalled keeping its data', () => {
  const hooks = read('widgets/dooray/installer/hooks.nsh');
  const calls = hooks
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ExecWait'));
  assert.ok(calls.length > 0);
  for (const line of calls) {
    assert.match(line, /\/S\b/);
    assert.match(line, /\/KEEP_APP_DATA/);
    assert.ok(!/--delete-app-data/.test(line), line);
  }
});

test('"delete settings" removes only Desk Widgets data: the engine all of it, a widget only its own folder', () => {
  const engine = deletions(read('build/installer.nsh')).filter((l) => /APPDATA/.test(l));
  assert.deepEqual(engine, ['RMDir /r "$APPDATA\\chilgong88\\desk-widgets"', 'RMDir "$APPDATA\\chilgong88"']);
  const widget = deletions(read('tools/widget-kit/installer.nsi')).filter((l) => /APPDATA/.test(l));
  assert.deepEqual(widget, ['RMDir /r "$APPDATA\\chilgong88\\desk-widgets\\widgets\\${WIDGET_ID}"']);
});
