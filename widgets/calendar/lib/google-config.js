// The Google OAuth client of this build (#114). Never committed: scripts/google-client.js writes
// google-client.json (git-ignored) from GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_PW in the repository's .env or
// the build's environment, and the widget kit runs it before packaging. Without it the settings window hides
// the Google option behind a hint and Google accounts show an error instead of signing in.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'google-client.json');
const CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** { clientId, clientSecret } or null. file: a seam for tests. */
function loadGoogleConfig(file = FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const clientId = String(raw?.clientId || '').trim();
    if (!CLIENT_ID.test(clientId)) return null;
    return { clientId, clientSecret: String(raw.clientSecret || '').trim() };
  } catch {
    return null;
  }
}

module.exports = { loadGoogleConfig, CLIENT_ID, FILE };
