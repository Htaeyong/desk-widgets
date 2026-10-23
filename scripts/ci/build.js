// Builds one product's installer on CI (#101), unsigned or as one pass of the signed build.
// Usage: node scripts/ci/build.js <engine | widget id>
//   DW_SIGN_MODE unset    one normal build (npm run dist / npm run widget)
//   DW_SIGN_MODE=collect  pass 1: build and collect the app exe and uninstaller (see sign-hook.js)
//   DW_SIGN_MODE=apply    pass 2: rebuild the installer around the signed app exe and uninstaller
// The engine's pass 2 repackages dist/win-unpacked from pass 1 (--prepackaged), so only the signed
// exe changes. The installer itself is signed afterwards by the workflow.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { APP_EXE } = require('./sign-hook');

const root = path.join(__dirname, '..', '..');
const hook = path.join(__dirname, 'sign-hook.js');
const mode = process.env.DW_SIGN_MODE || '';

function buildEngine() {
  const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
  const args = [cli, '--win', '--publish', 'never'];
  if (mode) {
    // Called once per hash (sha1, sha256) for each file: harmless, the hook only copies.
    args.push(`-c.win.signtoolOptions.sign=${path.relative(root, hook)}`);
  }
  if (mode === 'apply') {
    const unpacked = path.join(root, 'dist', 'win-unpacked');
    const signed = path.join(process.env.DW_SIGN_DIR || path.join(root, 'dist', 'sign'), 'signed', APP_EXE);
    if (!fs.existsSync(signed)) throw new Error(`signed ${APP_EXE} missing: ${signed}`);
    fs.copyFileSync(signed, path.join(unpacked, APP_EXE));
    args.push('--prepackaged', unpacked);
  }
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
}

function buildWidget(id) {
  const env = { ...process.env };
  if (mode) env.WIDGET_KIT_SIGN_HOOK = hook;
  execFileSync(process.execPath, [path.join(root, 'tools', 'widget-kit', 'build.js'), path.join('widgets', id)], { cwd: root, stdio: 'inherit', env });
}

const product = process.argv[2];
if (!product) {
  console.error('Usage: node scripts/ci/build.js <engine | widget id>');
  process.exit(1);
}
if (mode && !['collect', 'apply'].includes(mode)) {
  console.error(`unknown DW_SIGN_MODE "${mode}" (collect | apply)`);
  process.exit(1);
}
try {
  if (product === 'engine') buildEngine();
  else buildWidget(product);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
