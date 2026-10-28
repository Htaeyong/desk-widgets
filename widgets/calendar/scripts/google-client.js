// Writes widgets/calendar/google-client.json (git-ignored) from GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_PW (#114).
// Values come from the environment (CI secrets) or the repository's .env; they are never printed.
// Without both values the file is removed and the widget is built without Google sign-in.
// Google sign-in ships only in internal test builds (a version with a prerelease part, e.g. 1.1.2-test.1) while the
// Google OAuth app is unverified and only its test users can sign in: a public X.Y.Z build removes the file unless
// GOOGLE_OAUTH_RELEASE=1 is set (after Google's verification). The version is the one the widget kit builds
// (WIDGET_KIT_VERSION), else widget.json's. The widget kit runs this before packaging (widget.json package.prebuild);
// run it by hand for `npm start`:
//   node widgets/calendar/scripts/google-client.js
const fs = require('fs');
const path = require('path');

const WIDGET = path.join(__dirname, '..');
const ROOT = path.join(WIDGET, '..', '..');
const OUT = path.join(WIDGET, 'google-client.json');
const CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** KEY=value lines of a .env file (no expansion), or {} when there is none. */
function readEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    return require('dotenv').parse(text);
  } catch {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
  }
}

/** { clientId, clientSecret } from env first, then the .env file; or { error }. */
function resolveClient(env = process.env, file = path.join(ROOT, '.env')) {
  const fromFile = readEnvFile(file);
  const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID || fromFile.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_PW || fromFile.GOOGLE_OAUTH_CLIENT_PW || '').trim();
  if (!clientId && !clientSecret) return { error: 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_PW not set' };
  if (!CLIENT_ID.test(clientId)) return { error: 'GOOGLE_OAUTH_CLIENT_ID does not look like a Google OAuth client id (…apps.googleusercontent.com)' };
  if (!clientSecret) return { error: 'GOOGLE_OAUTH_CLIENT_PW is empty' };
  return { clientId, clientSecret };
}

/** The version being built: the widget kit's (WIDGET_KIT_VERSION), else widget.json's. */
function buildVersion(env = process.env, manifestFile = path.join(WIDGET, 'widget.json')) {
  if (env.WIDGET_KIT_VERSION) return String(env.WIDGET_KIT_VERSION).trim();
  return String(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version || '');
}

/** Whether this build may carry Google sign-in: a test build (prerelease version) or an explicit release opt-in. */
function googleAllowed(version, env = process.env) {
  return String(version).includes('-') || String(env.GOOGLE_OAUTH_RELEASE || '').trim() === '1';
}

function main({ env = process.env, envFile, out = OUT, log = console.log, version = buildVersion(env) } = {}) {
  if (!googleAllowed(version, env)) {
    fs.rmSync(out, { force: true });
    log(`calendar: building ${version} without Google sign-in (public builds leave it out until Google verification; GOOGLE_OAUTH_RELEASE=1 overrides).`);
    return false;
  }
  const client = resolveClient(env, envFile);
  if (client.error) {
    fs.rmSync(out, { force: true });
    log(`calendar: building without Google sign-in (${client.error}).`);
    return false;
  }
  fs.writeFileSync(out, JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret }, null, 2) + '\n');
  log('calendar: Google sign-in client written to google-client.json (values not shown).');
  return true;
}

if (require.main === module) main();

module.exports = { main, resolveClient, readEnvFile, buildVersion, googleAllowed };
