// The isolated runtime of theme pages: the theme URL schemes and one session per themed widget (#57).
// Themes may be third-party code, so they run with no network access, no permissions and no downloads.
// "dooray-theme" keeps its original name and session: theme URLs are part of the Dooray theme contract (THEME_SPEC.md).
// Which themes exist is theme-registry.js; this file only serves them.
const fs = require('fs');
const { protocol, session } = require('electron');
const { LEGACY_SCHEME, SCHEME } = require('./theme-registry');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "media-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Both names are registered before app "ready": a widget installed while the engine runs needs no new scheme.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: LEGACY_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

// partition -> the registry its session serves now (a widget reloaded with a new registry keeps its session).
const served = new Map();

async function serve(partition, request) {
  const registry = served.get(partition);
  const found = registry && (await registry.resolveFile(request.url));
  if (!found) return notFound();
  try {
    const body = await fs.promises.readFile(found.file);
    return new Response(body, {
      headers: {
        'content-type': found.contentType,
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return notFound();
  }
}

/**
 * The session of a widget's theme pages (after app "ready"): serves only that registry's themes and blocks every
 * remote request, permission and download. Safe to call again; the latest registry of a partition is served.
 */
function ensureSession(registry) {
  const { partition, scheme } = registry;
  const known = served.has(partition);
  served.set(partition, registry);
  const ses = session.fromPartition(partition);
  if (known) return ses;
  ses.protocol.handle(scheme, (request) => serve(partition, request));
  // No network for themes: block every remote request at the session level.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_details, callback) =>
    callback({ cancel: true })
  );
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  return ses;
}

module.exports = { CSP, registerScheme, ensureSession };
