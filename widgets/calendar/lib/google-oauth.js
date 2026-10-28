// Google sign-in for the calendar widget (#114): OAuth 2.0 for installed apps in the system browser.
//   - the login page opens in the user's own browser (shell.openExternal), never in a window of ours;
//   - the answer comes back to a one-shot loopback server on 127.0.0.1 and a random port;
//   - PKCE (S256) and a random state; the server closes after one answer or the timeout;
//   - the refresh token goes to the caller (stored only in the encrypted secret store), access tokens stay in
//     memory (createTokens) and are renewed when they expire or the API answers 401;
//   - an expired or revoked grant is a SourceError 'reauth' ("다시 로그인"), never a silent failure.
// The OAuth client (id and secret) comes from lib/google-config.js: Google treats a desktop client's secret as
// not confidential, but it is still never committed (docs/google-oauth-setup.md).
const http = require('http');
const crypto = require('crypto');
const { SourceError, readCapped } = require('./http');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
// The narrowest pair that reads the calendar list and reads/writes events (docs/calendar.md, Google 계정).
const SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'];
const LOGIN_TIMEOUT_MS = 5 * 60000;
const REQUEST_TIMEOUT_MS = 30000;
const EXPIRY_MARGIN_MS = 60000;

const REAUTH = 'Google 로그인이 만료되었거나 취소되었습니다. 설정에서 이 계정의 "다시 로그인"을 누르세요.';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier and its S256 challenge (RFC 7636). */
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

/** The consent page address. */
function authUrl({ clientId, redirectUri, state, challenge, loginHint }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // consent: Google gives a refresh token again on a second login (a 다시 로그인 needs one).
    prompt: 'consent',
    include_granted_scopes: 'false',
  });
  if (loginHint) q.set('login_hint', loginHint);
  return `${AUTH_URL}?${q}`;
}

/** Whether a token answer's scope holds everything the widget needs (the user can untick some, granular consent). */
const hasScopes = (scope) => {
  const granted = new Set(String(scope || '').split(/\s+/));
  return SCOPES.every((s) => granted.has(s));
};

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (title, text) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Desk Widgets</title>` +
  `<style>body{font-family:"Segoe UI","Malgun Gothic",sans-serif;margin:15vh auto;max-width:32em;padding:0 1em;color:#222}h1{font-size:1.3em}</style>` +
  `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;

/** One form POST to a Google OAuth endpoint: { status, json }. Network problems are SourceError 'network'/'timeout'. */
async function postForm(fetch, url, form, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'DeskWidgets-Calendar' },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new SourceError('Google 응답 시간이 초과되었습니다.', 'timeout');
      throw new SourceError(`Google에 연결하지 못했습니다: ${err.cause?.code || err.message}`, 'network');
    }
    const text = await readCapped(res, controller, 1024 * 1024).catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the token answer of an authorization-code or refresh request; throws SourceError on refusal. */
function tokenAnswer({ status, json }, what) {
  if (status === 400 || status === 401) {
    const error = json?.error || '';
    // invalid_grant: the refresh token was revoked, expired (7 days for apps in "testing") or the password changed.
    if (error === 'invalid_grant') throw new SourceError(REAUTH, 'reauth', status);
    if (error === 'invalid_client' || error === 'unauthorized_client') throw new SourceError('이 프로그램의 Google OAuth 클라이언트 설정이 거절되었습니다. 개발자에게 알려 주세요.', 'oauth-client', status);
    throw new SourceError(`Google이 ${what}을 거절했습니다 (${error || `HTTP ${status}`}).`, 'oauth', status);
  }
  if (status < 200 || status >= 300 || !json?.access_token) throw new SourceError(`Google ${what}에 실패했습니다 (HTTP ${status}).`, `http-${status}`, status);
  return json;
}

/**
 * Signs in once: opens the consent page in the system browser and waits for the loopback answer.
 * Resolves { refreshToken, accessToken, expiresAt, scope }. Rejects with SourceError: 'cancelled' (the user said
 * no), 'scopes' (not every permission ticked), 'timeout', 'state', 'no-refresh', ...
 * opts: { config: { clientId, clientSecret }, openExternal(url), fetch, loginHint?, timeoutMs?, now?, signal? }.
 */
function authorize({ config, openExternal, fetch = globalThis.fetch, loginHint = '', timeoutMs = LOGIN_TIMEOUT_MS, now = Date.now, signal = null }) {
  if (!config?.clientId) return Promise.reject(new SourceError('이 빌드에는 Google 로그인 설정이 없습니다.', 'no-client'));
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(16));
  return new Promise((resolve, reject) => {
    let redirectUri = null;
    let settled = false;
    let timer = null;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      const reply = (ok, text) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
        res.end(page(ok ? '로그인이 끝났습니다' : '로그인하지 못했습니다', text));
      };
      // Another page (or a stale tab) calling the port without our state is ignored, not taken as an answer.
      if (url.searchParams.get('state') !== state) {
        reply(false, '요청이 이 로그인과 맞지 않습니다. 설정 창에서 다시 시도하세요.');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        reply(false, '로그인을 취소했거나 Google이 거절했습니다. 이 창을 닫고 설정 창에서 다시 시도하세요.');
        finish(new SourceError(error === 'access_denied' ? 'Google 로그인을 취소했습니다.' : `Google 로그인이 거절되었습니다 (${error || '코드 없음'}).`, error === 'access_denied' ? 'cancelled' : 'oauth'));
        return;
      }
      reply(true, '이 창을 닫아도 됩니다. Desk Widgets 설정 창으로 돌아가세요.');
      exchange(code).then((tokens) => finish(null, tokens), (err) => finish(err));
    });

    async function exchange(code) {
      const answer = tokenAnswer(
        await postForm(fetch, TOKEN_URL, { code, client_id: config.clientId, client_secret: config.clientSecret || '', redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
        '로그인',
      );
      if (!hasScopes(answer.scope)) {
        await revoke(fetch, answer.refresh_token || answer.access_token).catch(() => {});
        throw new SourceError('캘린더 목록 보기와 일정 보기·수정 권한을 모두 허용해야 연결할 수 있습니다. 다시 로그인하면서 두 항목을 모두 체크하세요.', 'scopes');
      }
      if (!answer.refresh_token) throw new SourceError('Google이 오래 쓰는 로그인 토큰을 주지 않았습니다. 다시 시도하세요.', 'no-refresh');
      return { refreshToken: answer.refresh_token, accessToken: answer.access_token, expiresAt: now() + Number(answer.expires_in || 3600) * 1000, scope: answer.scope };
    }

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      server.close();
      // Keep-alive sockets of the browser would hold the server open.
      server.closeAllConnections?.();
      if (err) reject(err);
      else resolve(value);
    }
    const onAbort = () => finish(new SourceError('Google 로그인을 그만두었습니다.', 'cancelled'));
    signal?.addEventListener?.('abort', onAbort);
    if (signal?.aborted) return onAbort();

    server.on('error', (err) => finish(new SourceError(`로그인 응답을 받을 준비를 하지 못했습니다: ${err.message}`, 'loopback')));
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      timer = setTimeout(() => finish(new SourceError('Google 로그인을 기다리다 시간이 지났습니다. 다시 시도하세요.', 'timeout')), timeoutMs);
      Promise.resolve()
        .then(() => openExternal(authUrl({ clientId: config.clientId, redirectUri, state, challenge, loginHint })))
        .catch((err) => finish(new SourceError(`브라우저를 열지 못했습니다: ${err?.message || err}`, 'browser')));
    });
  });
}

/** Revokes a token at Google (a refresh token ends the whole grant). Resolves true when Google accepted it. */
async function revoke(fetch, token) {
  if (!token) return false;
  const res = await postForm(fetch, REVOKE_URL, { token });
  return res.status === 200;
}

/**
 * Access tokens of Google accounts, in memory only. The refresh token of an account is read from the secret
 * store each time one is needed, so a 다시 로그인 or a removal takes effect at once.
 * opts: { config, getRefreshToken(id), fetch, now }.
 */
function createTokens({ config, getRefreshToken, fetch = globalThis.fetch, now = Date.now }) {
  const cache = new Map(); // account id -> { token, expiresAt, refreshToken }
  const inFlight = new Map();

  async function refresh(id, refreshToken) {
    if (!config?.clientId) throw new SourceError('이 빌드에는 Google 로그인 설정이 없어 Google 계정을 읽을 수 없습니다.', 'no-client');
    const answer = tokenAnswer(
      await postForm(fetch, TOKEN_URL, { client_id: config.clientId, client_secret: config.clientSecret || '', refresh_token: refreshToken, grant_type: 'refresh_token' }),
      '로그인 갱신',
    );
    const entry = { token: answer.access_token, expiresAt: now() + Number(answer.expires_in || 3600) * 1000, refreshToken };
    cache.set(id, entry);
    return entry.token;
  }

  return {
    /** A valid access token of the account; SourceError 'reauth' when this PC has no login or Google refused it. */
    async get(id) {
      const refreshToken = getRefreshToken(id);
      if (!refreshToken) throw new SourceError('이 PC에서는 아직 이 Google 계정에 로그인하지 않았습니다. 설정에서 "다시 로그인"을 누르세요.', 'reauth');
      const hit = cache.get(id);
      if (hit && hit.refreshToken === refreshToken && hit.expiresAt - EXPIRY_MARGIN_MS > now()) return hit.token;
      if (!inFlight.has(id)) inFlight.set(id, refresh(id, refreshToken).finally(() => inFlight.delete(id)));
      return inFlight.get(id);
    },
    /** Seeds the cache with the access token a login just gave. */
    remember(id, { accessToken, expiresAt, refreshToken }) {
      cache.set(id, { token: accessToken, expiresAt, refreshToken });
    },
    /** Drops the cached access token (the API answered 401): the next get() refreshes. */
    invalidate(id) {
      cache.delete(id);
    },
    forget(id) {
      cache.delete(id);
    },
  };
}

module.exports = { SCOPES, AUTH_URL, TOKEN_URL, REVOKE_URL, REAUTH, authorize, authUrl, createTokens, revoke, pkce, hasScopes };
