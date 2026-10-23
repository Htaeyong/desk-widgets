// Signing hook for CI builds (#101). SignPath signs asynchronously in a separate workflow step, so a
// build cannot sign "in place": instead the build runs twice and this hook moves files in and out.
//   DW_SIGN_MODE=collect  copy each file we sign to <DW_SIGN_DIR>/unsigned/<name>   (pass 1)
//   DW_SIGN_MODE=apply    replace each file we sign with <DW_SIGN_DIR>/signed/<name> (pass 2)
//   (unset)               do nothing
// Files we sign: the engine app exe ("Desk Widgets.exe") and every uninstaller ("*__uninstaller.exe").
// Installers are signed after pass 2; third-party files (electron-builder's elevate.exe) stay as shipped.
//
// Used as electron-builder's win.signtoolOptions.sign (module: export function(configuration)) and
// as widget-kit's WIDGET_KIT_SIGN_HOOK (command line: node sign-hook.js <file>).
const fs = require('fs');
const path = require('path');

const APP_EXE = 'Desk Widgets.exe';

function isOurs(file) {
  const name = path.basename(file);
  return name === APP_EXE || name.endsWith('__uninstaller.exe');
}

function signDir() {
  return path.resolve(process.env.DW_SIGN_DIR || path.join('dist', 'sign'));
}

function handle(file) {
  const mode = process.env.DW_SIGN_MODE || '';
  const name = path.basename(file);
  if (!mode) return;
  if (!isOurs(file)) {
    console.log(`  sign-hook: ${name} left unsigned here (installer: signed later; others: third-party)`);
    return;
  }
  if (mode === 'collect') {
    const dest = path.join(signDir(), 'unsigned', name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    console.log(`  sign-hook: collected ${name}`);
  } else if (mode === 'apply') {
    const signed = path.join(signDir(), 'signed', name);
    if (!fs.existsSync(signed)) throw new Error(`sign-hook: signed copy missing: ${signed}`);
    fs.copyFileSync(signed, file);
    console.log(`  sign-hook: applied signed ${name}`);
  } else {
    throw new Error(`sign-hook: unknown DW_SIGN_MODE "${mode}" (collect | apply)`);
  }
}

module.exports = async function sign(configuration) {
  handle(configuration.path);
};
module.exports.isOurs = isOurs;
module.exports.APP_EXE = APP_EXE;

if (require.main === module) {
  try {
    handle(process.argv[2]);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
