// Deploys site/public to Firebase Hosting (#99). The Firebase account is private: it comes from .env
// (FIREBASE_ACCOUNT, optional FIREBASE_PROJECT) and is never printed.
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const project = process.env.FIREBASE_PROJECT || 'desk-widgets-chilgong88';
const account = process.env.FIREBASE_ACCOUNT || '';
if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error('FIREBASE_PROJECT: invalid project id');
if (account && !/^[^\s@"'&|<>^%]+@[^\s@"'&|<>^%]+$/.test(account)) throw new Error('FIREBASE_ACCOUNT: invalid value');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: path.join(__dirname, '..') });
  if (r.status !== 0) process.exit(r.status || 1);
}

run('node', ['scripts/site-build.js']);
const args = ['deploy', '--only', 'hosting', '--project', project];
if (account) args.push('--account', account);
console.log(`firebase ${args.slice(0, 5).join(' ')}${account ? ' --account <from .env>' : ''}`);
run('firebase', args);
