// Dev-only: starts screenshots.electron.js in this repository's Electron, with this Node for the scripted demo `claude`.
//   node widgets/ai-chat/test/screenshots.js [--out <folder>]
// Named without .test so npm test never runs it.
const cp = require('child_process');
const path = require('path');

const electron = path.join(__dirname, '..', '..', '..', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const at = process.argv.indexOf('--out');
const env = { ...process.env, AI_CHAT_NODE: process.execPath, ...(at > 0 ? { AI_CHAT_SHOTS_OUT: path.resolve(process.argv[at + 1]) } : {}) };
delete env.ELECTRON_RUN_AS_NODE;
const run = cp.spawnSync(electron, [path.join(__dirname, 'screenshots.electron.js')], { env, stdio: 'inherit', windowsHide: true, timeout: 180000, killSignal: 'SIGKILL' });
process.exit(run.status ?? 1);
