// Google accounts (#114) against a fake Google (OAuth token/revoke endpoints and Calendar API v3): sign-in in
// the "browser" (a loopback GET standing in for the user's browser), PKCE and state, tokens kept only in the
// encrypted secret store, reading, conditional writes, 다시 로그인, removal with revocation. No real network.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { create } = require('../index');
const { DEFAULTS, sanitize, sanitizeSource } = require('../lib/settings');
const { withThemeHost } = require('./theme-host');
const { authorize, createTokens, authUrl, hasScopes, SCOPES, TOKEN_URL, REVOKE_URL } = require('../lib/google-oauth');
const { GoogleClient, calendarUrl, googleIdOf } = require('../lib/google-api');
const { componentOf, fetchGoogle } = require('../lib/google-source');
const { patchOf, resourceOf } = require('../lib/google-writer');
const { readOnlyReason } = require('../lib/editable');
const { occurrences } = require('../lib/ical');
const clientScript = require('../scripts/google-client');

const CONFIG = { clientId: '1234567890-abcdefg.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret' };
const EMAIL = 'me@example.com';
const PRIMARY = calendarUrl(EMAIL);
const HOLIDAYS = calendarUrl('ko.south_korea#holiday@group.v.calendar.google.com');
const fakeCrypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** GET of a loopback URL, as the user's browser would after Google's redirect. Resolves { status, body }. */
function browserGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

/**
 * A fake Google. Accounts: email -> { calendars: [{ id, summary, accessRole, primary }] }; events per calendar id.
 * browser(url): what the user's browser does with the consent page (default: approve as `login.email`).
 */
function fakeGoogle({ email = EMAIL, grantScope = SCOPES.join(' ') } = {}) {
  const g = {
    requests: [],
    refreshTokens: new Map(), // refresh token -> email
    accessTokens: new Map(), // access token -> email
    revoked: [],
    login: { email, scope: grantScope, deny: false },
    pending: new Map(), // code -> { challenge, redirect, email, scope }
    calendars: {
      [EMAIL]: [
        { id: EMAIL, summary: EMAIL, accessRole: 'owner', primary: true, backgroundColor: '#9fe1e7' },
        { id: 'ko.south_korea#holiday@group.v.calendar.google.com', summary: '대한민국의 휴일', accessRole: 'reader' },
      ],
      'other@example.com': [{ id: 'other@example.com', summary: 'other', accessRole: 'owner', primary: true }],
    },
    events: { [EMAIL]: new Map(), 'ko.south_korea#holiday@group.v.calendar.google.com': new Map() },
    version: 1,
    failNextPatch: null,
  };
  let seq = 0;
  const json = (status, body, headers = {}) => ({
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: null,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  const listEtag = (calId) => `"list-${calId.length}-${g.version}"`;
  g.addEvent = (calId, e) => {
    const id = e.id || `ev${++seq}`;
    g.events[calId].set(id, { kind: 'calendar#event', status: 'confirmed', htmlLink: `https://www.google.com/calendar/event?eid=${id}`, ...e, id, etag: `"e${++g.version}"` });
    return id;
  };

  g.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const auth = opts.headers?.Authorization || '';
    g.requests.push({ url, method, auth, headers: opts.headers, body: opts.body });
    if (url === TOKEN_URL) {
      const form = Object.fromEntries(new URLSearchParams(opts.body));
      if (form.client_id !== CONFIG.clientId || form.client_secret !== CONFIG.clientSecret) return json(401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        const p = g.pending.get(form.code);
        g.pending.delete(form.code);
        if (!p || p.redirect !== form.redirect_uri) return json(400, { error: 'invalid_grant' });
        if (b64url(crypto.createHash('sha256').update(form.code_verifier || '').digest()) !== p.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
        const rt = `1//rt-${crypto.randomBytes(6).toString('hex')}`;
        const at = `ya29.at-${crypto.randomBytes(6).toString('hex')}`;
        g.refreshTokens.set(rt, p.email);
        g.accessTokens.set(at, p.email);
        return json(200, { access_token: at, refresh_token: rt, expires_in: 3599, scope: p.scope, token_type: 'Bearer' });
      }
      if (form.grant_type === 'refresh_token') {
        const who = g.refreshTokens.get(form.refresh_token);
        if (!who) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const at = `ya29.at-${crypto.randomBytes(6).toString('hex')}`;
        g.accessTokens.set(at, who);
        return json(200, { access_token: at, expires_in: 3599, scope: SCOPES.join(' '), token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url === REVOKE_URL) {
      const { token } = Object.fromEntries(new URLSearchParams(opts.body));
      g.revoked.push(token);
      g.refreshTokens.delete(token);
      return json(200, {});
    }
    if (!url.startsWith('https://www.googleapis.com/calendar/v3/')) return json(404, {});
    const who = g.accessTokens.get(auth.replace(/^Bearer /, ''));
    if (!who) return json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    const u = new URL(url);
    if (u.pathname === '/calendar/v3/users/me/calendarList') return json(200, { items: g.calendars[who] || [] });
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return json(404, {});
    const calId = decodeURIComponent(m[1]);
    const store = g.events[calId];
    if (!store) return json(404, { error: { code: 404 } });
    const id = m[2] && decodeURIComponent(m[2]);
    if (!id && method === 'GET') {
      if (opts.headers['If-None-Match'] === listEtag(calId)) return json(304);
      const from = Date.parse(u.searchParams.get('timeMin'));
      const to = Date.parse(u.searchParams.get('timeMax'));
      const items = [...store.values()].filter((e) => {
        const s = Date.parse(e.start.dateTime || `${e.start.date}T00:00:00Z`);
        return s < to && s >= from - 86400000 * 400;
      });
      return json(200, { kind: 'calendar#events', etag: listEtag(calId), items });
    }
    if (!id && method === 'POST') {
      const body = JSON.parse(opts.body);
      g.version++;
      const newId = g.addEvent(calId, { ...body, organizer: { email: who, self: true }, creator: { email: who, self: true } });
      return json(200, store.get(newId));
    }
    const ev = store.get(id);
    if (!ev) return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
    if (method === 'GET') return json(200, ev);
    if (opts.headers['If-Match'] !== ev.etag) return json(412, { error: { code: 412, errors: [{ reason: 'conditionNotMet' }] } });
    if (method === 'PATCH') {
      const body = JSON.parse(opts.body);
      const next = { ...ev };
      for (const [k, v] of Object.entries(body)) {
        if (k === 'start' || k === 'end') next[k] = Object.fromEntries(Object.entries({ ...ev[k], ...v }).filter(([, x]) => x !== null));
        else next[k] = v;
      }
      g.version++;
      next.etag = `"e${++g.version}"`;
      store.set(id, next);
      return json(200, next);
    }
    if (method === 'DELETE') {
      store.delete(id);
      g.version++;
      return json(204);
    }
    return json(405, {});
  };

  /** The user's browser: approve (or deny) the consent page, follow the redirect to the loopback port. */
  g.browser = async (address) => {
    const u = new URL(address);
    g.consent = u;
    const redirect = u.searchParams.get('redirect_uri');
    const state = u.searchParams.get('state');
    if (g.login.deny) return browserGet(`${redirect}?error=access_denied&state=${state}`);
    const code = `4/code-${crypto.randomBytes(4).toString('hex')}`;
    g.pending.set(code, { challenge: u.searchParams.get('code_challenge'), redirect, email: g.login.email, scope: g.login.scope });
    g.browsing = browserGet(`${redirect}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}&scope=x`);
    g.page = await g.browsing;
    return g.page;
  };
  return g;
}

function setup({ config = CONFIG, google = fakeGoogle(), crypto: box = fakeCrypto } = {}) {
  let state = sanitize({ ...DEFAULTS, localEnabled: false });
  const opened = [];
  const { ctx, th } = withThemeHost({
    dir: path.join(__dirname, '..'),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cal-google-')),
    createStore: (opts) => {
      if (opts?.sync?.name === 'settings') setup.lastStoreOptions = opts;
      return { load: () => state, save: (v) => { state = sanitize({ ...state, ...v }); } };
    },
    openExternal(url) {
      opened.push(url);
      if (url.startsWith('https://accounts.google.com/')) google.browser(url).catch(() => {});
    },
    confirm: async () => 0,
    sendToSettings() {},
  });
  const widget = create(ctx, { fetch: google.fetch, crypto: box, googleConfig: config });
  return { widget, ctx, th, google, opened, getState: () => state };
}

const allData = (dir) =>
  fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** Logs in and saves the account; returns the saved source. */
async function addAccount(env) {
  const res = await env.widget.settings.handlers.googleLogin({});
  assert.equal(res.ok, true, res.message);
  const account = { type: 'google', email: res.email, name: '개인 Google', enabled: true, calendars: res.calendars, draft: res.token };
  assert.deepEqual(env.widget.settings.save({ sources: [account] }), { ok: true });
  await settle();
  return env.getState().sources.find((s) => s.type === 'google');
}

const OCT = { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-11-01T00:00:00Z') };
async function waitFor(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await settle(20);
  }
  throw new Error('timed out');
}

// ---- OAuth ----

test('authorize: system browser, loopback on 127.0.0.1, PKCE S256, state, minimal scopes, the closing page', async () => {
  const g = fakeGoogle();
  const tokens = await authorize({ config: CONFIG, openExternal: (url) => g.browser(url), fetch: g.fetch });
  const u = g.consent;
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.deepEqual(u.searchParams.get('scope').split(' '), SCOPES);
  assert.ok(!u.searchParams.has('client_secret'), 'the secret never goes to the browser');
  assert.match(tokens.refreshToken, /^1\/\/rt-/);
  assert.match(tokens.accessToken, /^ya29\./);
  await g.browsing;
  assert.match(g.page.body, /로그인이 끝났습니다/);
  assert.match(g.page.body, /이 창을 닫아도 됩니다/);
  // The loopback port is closed after the one answer.
  await assert.rejects(browserGet(u.searchParams.get('redirect_uri')));
});

test('authorize: a wrong state is ignored, a denial is "cancelled", missing scopes are refused and revoked', async () => {
  const g = fakeGoogle();
  let redirect;
  const pending = authorize({
    config: CONFIG,
    fetch: g.fetch,
    openExternal: async (url) => {
      redirect = new URL(url).searchParams.get('redirect_uri');
      const forged = await browserGet(`${redirect}?state=forged&code=stolen`);
      assert.equal(forged.status, 400);
      await g.browser(url);
    },
  });
  assert.ok((await pending).refreshToken, 'the real answer still went through');

  g.login.deny = true;
  await assert.rejects(authorize({ config: CONFIG, fetch: g.fetch, openExternal: (url) => g.browser(url) }), (err) => err.code === 'cancelled');

  g.login.deny = false;
  g.login.scope = SCOPES[0]; // the user unticked "일정 보기·수정"
  await assert.rejects(authorize({ config: CONFIG, fetch: g.fetch, openExternal: (url) => g.browser(url) }), (err) => err.code === 'scopes');
  assert.equal(g.revoked.length, 1, 'the partial grant is handed back');

  await assert.rejects(authorize({ config: CONFIG, fetch: g.fetch, openExternal: () => {}, timeoutMs: 50 }), (err) => err.code === 'timeout');
  await assert.rejects(authorize({ config: null, fetch: g.fetch, openExternal: () => {} }), (err) => err.code === 'no-client');
  const abort = new AbortController();
  const aborted = authorize({ config: CONFIG, fetch: g.fetch, openExternal: () => abort.abort(), signal: abort.signal });
  await assert.rejects(aborted, (err) => err.code === 'cancelled');
});

test('authUrl, hasScopes', () => {
  const u = new URL(authUrl({ clientId: CONFIG.clientId, redirectUri: 'http://127.0.0.1:1/callback', state: 's', challenge: 'c', loginHint: EMAIL }));
  assert.equal(u.searchParams.get('login_hint'), EMAIL);
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(hasScopes(`openid ${SCOPES.join(' ')}`), true);
  assert.equal(hasScopes(SCOPES[1]), false);
});

test('tokens: refreshed when needed, cached in memory, invalid_grant and no login are "reauth"', async () => {
  const g = fakeGoogle();
  const login = await authorize({ config: CONFIG, openExternal: (url) => g.browser(url), fetch: g.fetch });
  const store = { a: login.refreshToken };
  let now = 1000;
  const tokens = createTokens({ config: CONFIG, getRefreshToken: (id) => store[id] || '', fetch: g.fetch, now: () => now });
  const t1 = await tokens.get('a');
  const t2 = await tokens.get('a');
  assert.equal(t1, t2, 'cached');
  assert.equal(g.requests.filter((r) => r.url === TOKEN_URL).length, 2, 'code exchange + one refresh');
  now += 3600 * 1000;
  assert.notEqual(await tokens.get('a'), t1, 'expired -> refreshed');
  await assert.rejects(tokens.get('b'), (err) => err.code === 'reauth');
  g.refreshTokens.clear(); // revoked at Google (or 7 days in "testing")
  tokens.invalidate('a');
  await assert.rejects(tokens.get('a'), (err) => err.code === 'reauth' && /다시 로그인/.test(err.message));
});

test('client: a 401 gets one fresh token, other hosts are refused, 412 is a conflict', async () => {
  let n = 0;
  const seen = [];
  const tokens = { get: async () => `t${++n}`, invalidate: () => seen.push('invalidate') };
  const fetch = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    const status = opts.headers.Authorization === 'Bearer t1' ? 401 : opts.method === 'PATCH' ? 412 : 200;
    return { status, headers: { get: () => null }, body: null, text: async () => JSON.stringify({ items: [] }) };
  };
  const c = new GoogleClient({ tokens, accountId: 'a', fetch });
  assert.deepEqual(await c.listCalendars(), []);
  assert.deepEqual(seen, ['Bearer t1', 'invalidate', 'Bearer t2']);
  await assert.rejects(c.request('https://evil.example.com/calendar/v3/x'), (err) => err.code === 'untrusted');
  await assert.rejects(c.patchEvent(PRIMARY, 'x', {}, { ifMatch: '"1"' }), (err) => err.code === 'conflict');
  await assert.rejects(c.patchEvent(PRIMARY, 'x', {}, {}), (err) => err.code === 'unconditional');
  assert.equal(googleIdOf(HOLIDAYS), 'ko.south_korea#holiday@group.v.calendar.google.com');
  assert.equal(googleIdOf('https://www.googleapis.com/calendar/v3/calendars/a/events'), null);
});

// ---- mapping ----

test('Google events become components: times, all-day, series instances and special types read-only', () => {
  const timed = componentOf({ id: 'a1', etag: '"7"', summary: '회의', start: { dateTime: '2026-10-20T10:00:00+09:00' }, end: { dateTime: '2026-10-20T11:30:00+09:00' }, organizer: { email: EMAIL, self: true } }, PRIMARY, EMAIL);
  const [ev] = occurrences([timed], OCT.from, OCT.to, { sourceId: 's', calendarId: PRIMARY });
  assert.equal(ev.start, '2026-10-20T01:00:00Z');
  assert.equal(ev.end, '2026-10-20T02:30:00Z');
  assert.equal(timed.etag, '7');
  assert.equal(readOnlyReason({ writable: true, source: { email: EMAIL }, calendar: {}, components: [timed], uid: 'a1' }), null);

  const allDay = componentOf({ id: 'b', etag: '"1"', summary: '휴가', start: { date: '2026-10-21' }, end: { date: '2026-10-23' } }, PRIMARY, EMAIL);
  assert.deepEqual(occurrences([allDay], OCT.from, OCT.to, {}).map((e) => [e.allDay, e.start, e.end]), [[true, '2026-10-21', '2026-10-23']]);

  const inst = componentOf({ id: 'r_20261022', etag: '"1"', recurringEventId: 'r', originalStartTime: { date: '2026-10-22' }, start: { date: '2026-10-22' }, end: { date: '2026-10-23' } }, PRIMARY, EMAIL);
  assert.equal(occurrences([inst], OCT.from, OCT.to, {}).length, 1);
  assert.match(readOnlyReason({ writable: true, source: { email: EMAIL }, calendar: {}, components: [inst], uid: inst.uid }), /반복/);

  const meeting = componentOf({ id: 'm', etag: '"1"', start: { date: '2026-10-22' }, organizer: { email: 'boss@example.com' }, attendees: [{ email: EMAIL }, { email: 'boss@example.com' }] }, PRIMARY, EMAIL);
  assert.match(readOnlyReason({ writable: true, source: { email: EMAIL }, calendar: {}, components: [meeting], uid: 'm' }), /회의 초대/);
  const birthday = componentOf({ id: 'bd', etag: '"1"', eventType: 'birthday', start: { date: '2026-10-22' } }, PRIMARY, EMAIL);
  assert.match(readOnlyReason({ writable: true, source: { email: EMAIL }, calendar: {}, components: [birthday], uid: 'bd' }), /생일/);
  assert.equal(componentOf({ id: 'w', eventType: 'workingLocation', start: { date: '2026-10-22' } }, PRIMARY, EMAIL), null);
  assert.equal(componentOf({ id: 'c', status: 'cancelled', start: { date: '2026-10-22' } }, PRIMARY, EMAIL), null);
});

test('write resources: new events and patches carry only what the editor has', () => {
  const timed = { title: 't', allDay: false, start: Date.parse('2026-10-20T01:00:00Z'), end: Date.parse('2026-10-20T02:00:00Z'), location: '', description: '' };
  assert.deepEqual(resourceOf(timed, 'Asia/Seoul'), { summary: 't', location: undefined, description: undefined, start: { dateTime: '2026-10-20T01:00:00.000Z', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-20T02:00:00.000Z', timeZone: 'Asia/Seoul' } });
  assert.deepEqual(patchOf({ title: 'x' }, 'Asia/Seoul'), { summary: 'x' });
  assert.deepEqual(patchOf({ time: { allDay: true, start: '2026-10-20', end: '2026-10-21' } }).start, { date: '2026-10-20', dateTime: null, timeZone: null });
});

test('settings: a Google account keeps only email and calendars (Calendar API addresses)', () => {
  const clean = sanitizeSource({ type: 'google', email: ' Me@Example.com ', refreshToken: 'x', calendars: [{ id: PRIMARY, name: 'p' }, { id: 'https://evil.example.com/cal', name: 'e' }] });
  assert.equal(clean.email, EMAIL);
  assert.equal(clean.refreshToken, undefined);
  assert.deepEqual(clean.calendars.map((c) => c.id), [PRIMARY]);
  assert.equal(sanitizeSource({ type: 'google', email: 'not an email' }), null);
});

// ---- the widget ----

test('add a Google account: login in the browser, tokens only encrypted, events read, sync shares the entry only', async (t) => {
  const env = setup();
  const { widget, ctx, th, google, opened, getState } = env;
  google.addEvent(EMAIL, { summary: '치과', start: { dateTime: '2026-10-15T09:00:00+09:00' }, end: { dateTime: '2026-10-15T10:00:00+09:00' }, organizer: { email: EMAIL, self: true } });
  google.addEvent('ko.south_korea#holiday@group.v.calendar.google.com', { summary: '한글날', start: { date: '2026-10-09' }, end: { date: '2026-10-10' } });
  widget.start();
  t.after(() => widget.stop());
  const values = widget.settings.get();
  assert.equal(values.googleAvailable, true);

  const res = await widget.settings.handlers.googleLogin({});
  assert.equal(res.ok, true, res.message);
  assert.equal(res.email, EMAIL);
  assert.equal(opened.length, 1);
  assert.ok(opened[0].startsWith('https://accounts.google.com/'), 'the system browser, not a window of ours');
  assert.deepEqual(res.calendars.map((c) => [c.id, c.canWrite, c.enabled]), [[PRIMARY, true, true], [HOLIDAYS, false, false]]);
  res.calendars[1].enabled = true;
  assert.deepEqual(widget.settings.save({ sources: [{ type: 'google', email: res.email, name: '개인', enabled: true, calendars: res.calendars, draft: res.token }] }), { ok: true });

  const saved = getState().sources[0];
  const refreshToken = [...google.refreshTokens.keys()][0];
  assert.ok(!JSON.stringify(getState()).includes(refreshToken), 'not in settings.json');
  assert.ok(!allData(ctx.dataDir).includes(refreshToken), 'not in plain text in any file');
  assert.ok(!allData(ctx.dataDir).includes('ya29.'), 'no access token on disk');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'secrets.json'), 'utf8'))[saved.id] !== undefined, true);
  // Sync shares the account entry (no token field exists there) and keeps "enabled" per PC.
  const sync = setup.lastStoreOptions.sync.collections.sources;
  assert.equal(sync.filter(saved), true);
  assert.deepEqual(sync.local, ['enabled']);

  const events = await waitFor(async () => {
    const list = (await th.call('events.list', [[OCT]]))[0];
    return list.length === 2 ? list : null;
  });
  assert.deepEqual(events.map((e) => [e.title, e.readOnly, e.sourceName]).sort(), [['치과', false, '개인 · me@example.com'], ['한글날', true, '개인 · 대한민국의 휴일']]);
  assert.ok(google.requests.every((r) => /^https:\/\/(oauth2|www)\.googleapis\.com\//.test(r.url)), 'only Google was asked');
  assert.ok(google.requests.filter((r) => r.auth).every((r) => r.auth.startsWith('Bearer ya29.')), 'API calls carry the access token only');

  // Nothing changed: the next refresh is answered 304 for the same window.
  await widget.settings.handlers.refresh();
  const lists = google.requests.filter((r) => r.method === 'GET' && /\/events\?/.test(r.url));
  assert.ok(lists.slice(-2).every((r) => r.headers['If-None-Match']), 'conditional list');
  assert.equal(widget.settings.get().status[0].error, null);
});

test('create, edit and delete on a Google calendar: conditional, verified by reading back', async (t) => {
  const env = setup();
  const { widget, th, google } = env;
  widget.start();
  t.after(() => widget.stop());
  const saved = await addAccount(env);
  const fields = { title: '점심', allDay: false, start: Date.parse('2026-10-16T03:00:00Z'), end: Date.parse('2026-10-16T04:00:00Z'), location: '', description: '' };
  assert.deepEqual(await th.theme.save({ sourceId: saved.id, calendarId: PRIMARY, fields }), { ok: true, queued: true });
  const created = await waitFor(() => [...google.events[EMAIL].values()].find((e) => e.summary === '점심'));
  const idle = () => waitFor(async () => !(await th.call('getState')).pending.length && !(await th.call('getState')).refreshing);
  await idle();
  const inCache = await waitFor(async () => (await th.call('events.list', [[OCT]]))[0].find((e) => e.title === '점심' && !e.readOnly));
  assert.equal(inCache.uid, created.id);
  assert.deepEqual((await th.call('getState')).unconfirmed, {});

  assert.deepEqual(await th.theme.save({ sourceId: saved.id, calendarId: PRIMARY, uid: created.id, fields: { ...fields, title: '점심 약속', location: '을지로' } }), { ok: true, queued: true });
  await waitFor(() => google.events[EMAIL].get(created.id)?.summary === '점심 약속');
  const patch = google.requests.find((r) => r.method === 'PATCH');
  assert.equal(patch.headers['If-Match'], created.etag, 'If-Match with the ETag the user saw');
  assert.deepEqual(Object.keys(JSON.parse(patch.body)).sort(), ['location', 'summary'], 'only the changed properties');

  // Changed elsewhere since the last read -> conflict, nothing written.
  await idle();
  assert.deepEqual((await th.call('getState')).unconfirmed, {});
  const current = google.events[EMAIL].get(created.id);
  google.events[EMAIL].set(created.id, { ...current, summary: '다른 기기에서 바꿈', etag: '"elsewhere"' });
  const cards = [];
  env.ctx.notify = (list) => cards.push(...list);
  await th.theme.save({ sourceId: saved.id, calendarId: PRIMARY, uid: created.id, fields: { ...fields, title: '덮어쓰기' } });
  await waitFor(() => cards.length);
  assert.equal(cards[0].title, '일정 저장 실패');
  assert.equal(google.events[EMAIL].get(created.id).summary, '다른 기기에서 바꿈');

  await idle();
  google.version++; // the list changed: the next read is not a 304
  await env.widget.settings.handlers.refresh();
  await waitFor(async () => (await th.call('events.list', [[OCT]]))[0].find((e) => e.title === '다른 기기에서 바꿈'));
  assert.deepEqual(await th.theme.remove({ sourceId: saved.id, calendarId: PRIMARY, uid: created.id }), { ok: true, queued: true });
  await waitFor(() => !google.events[EMAIL].has(created.id));
  assert.equal(google.requests.find((r) => r.method === 'DELETE').headers['If-Match'], '"elsewhere"');
});

test('a revoked grant shows "다시 로그인"; logging in again (same account only) fixes it', async (t) => {
  const env = setup();
  const { widget, google, getState } = env;
  google.addEvent(EMAIL, { summary: '치과', start: { date: '2026-10-15' }, end: { date: '2026-10-16' } });
  widget.start();
  t.after(() => widget.stop());
  const saved = await addAccount(env);
  await widget.settings.handlers.refresh();
  google.refreshTokens.clear();
  google.accessTokens.clear();
  await widget.settings.handlers.refresh();
  const st = widget.settings.get().status.find((s) => s.id === saved.id);
  assert.equal(st.errorCode, 'reauth');
  assert.match(st.error, /다시 로그인/);
  assert.equal(st.count, 1, 'the last events stay');

  google.login.email = 'other@example.com';
  const wrong = await widget.settings.handlers.googleLogin({ accountId: saved.id });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /me@example\.com 계정으로/);
  assert.equal(google.consent.searchParams.get('login_hint'), EMAIL);

  google.login.email = EMAIL;
  const again = await widget.settings.handlers.googleLogin({ accountId: saved.id });
  assert.equal(again.ok, true);
  assert.deepEqual(widget.settings.save({ sources: [{ ...getState().sources[0], draft: again.token }] }), { ok: true });
  await widget.settings.handlers.refresh();
  assert.equal(widget.settings.get().status.find((s) => s.id === saved.id).error, null);
});

test('an account synced from another PC has no login here: saved as is, shown as needing login', async (t) => {
  const env = setup();
  const { widget } = env;
  widget.start();
  t.after(() => widget.stop());
  const synced = { id: 'sfromother', type: 'google', email: EMAIL, name: '다른 PC', enabled: true, calendars: [{ id: PRIMARY, name: EMAIL, enabled: true, canWrite: true }] };
  // As if the sync had brought it: in the settings already, no secret on this PC.
  env.widget.settings.save({ sources: [] });
  const values = widget.settings.get();
  assert.deepEqual(values.googleLoggedIn, {});
  // Saving the settings window with it unchanged works without a login.
  const st = env.getState();
  st.sources = [sanitizeSource(synced)];
  assert.deepEqual(widget.settings.save({ sources: [synced] }), { ok: true });
  assert.deepEqual(widget.settings.get().googleLoggedIn, { sfromother: false });
  await widget.settings.handlers.refresh();
  const status = widget.settings.get().status[0];
  assert.equal(status.errorCode, 'reauth');
  assert.match(status.error, /아직 이 Google 계정에 로그인하지 않았습니다/);
  // A new Google entry without a login is refused.
  const refused = widget.settings.save({ sources: [synced, { type: 'google', email: 'new@example.com', calendars: synced.calendars }] });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /로그인을 마친 뒤/);
});

test('removing a Google account revokes it at Google and deletes the token and cache', async (t) => {
  const env = setup();
  const { widget, ctx, google } = env;
  widget.start();
  t.after(() => widget.stop());
  const saved = await addAccount(env);
  const refreshToken = [...google.refreshTokens.keys()][0];
  await widget.settings.handlers.refresh();
  assert.ok(fs.existsSync(path.join(ctx.dataDir, 'cache', `${saved.id}.json`)));
  assert.deepEqual(widget.settings.save({ sources: [] }), { ok: true });
  await settle();
  assert.deepEqual(google.revoked, [refreshToken]);
  assert.equal(fs.readFileSync(path.join(ctx.dataDir, 'secrets.json'), 'utf8'), '{}');
  assert.equal(fs.existsSync(path.join(ctx.dataDir, 'cache', `${saved.id}.json`)), false);
});

test('the same Google account cannot be added twice', async (t) => {
  const env = setup();
  env.widget.start();
  t.after(() => env.widget.stop());
  await addAccount(env);
  const twice = await env.widget.settings.handlers.googleLogin({});
  assert.equal(twice.ok, false);
  assert.match(twice.message, /이미 추가되어/);
});

test('without a Google client in the build the option is off and nothing is opened', async (t) => {
  const env = setup({ config: null });
  env.widget.start();
  t.after(() => env.widget.stop());
  assert.equal(env.widget.settings.get().googleAvailable, false);
  const res = await env.widget.settings.handlers.googleLogin({});
  assert.equal(res.ok, false);
  assert.equal(env.opened.length, 0);
  const res2 = await fetchGoogle({ id: 'x', email: EMAIL, calendars: [] }, { window: OCT, tokens: null }).catch((e) => e);
  assert.equal(res2.code, 'no-client');
});

test('without OS encryption no Google login starts', async (t) => {
  const env = setup({ crypto: { ...fakeCrypto, available: () => false } });
  env.widget.start();
  t.after(() => env.widget.stop());
  const res = await env.widget.settings.handlers.googleLogin({});
  assert.equal(res.ok, false);
  assert.match(res.message, /평문/);
  assert.equal(env.opened.length, 0);
});

// ---- build-time client file ----

test('scripts/google-client.js writes the client from env or .env, never prints values, removes it when unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-gclient-'));
  const out = path.join(dir, 'google-client.json');
  const envFile = path.join(dir, '.env');
  const logs = [];
  const log = (m) => logs.push(m);
  fs.writeFileSync(envFile, `GOOGLE_OAUTH_CLIENT_ID=${CONFIG.clientId}\nGOOGLE_OAUTH_CLIENT_PW="${CONFIG.clientSecret}"\n`);
  assert.equal(clientScript.main({ env: {}, envFile, out, log, version: '1.1.2-test.1' }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), CONFIG);
  assert.ok(!logs.join('\n').includes(CONFIG.clientSecret) && !logs.join('\n').includes(CONFIG.clientId));
  const { loadGoogleConfig } = require('../lib/google-config');
  assert.deepEqual(loadGoogleConfig(out), CONFIG);
  assert.equal(clientScript.main({ env: { GOOGLE_OAUTH_CLIENT_ID: 'bad', GOOGLE_OAUTH_CLIENT_PW: 'x' }, envFile, out, log, version: '1.1.2-test.1' }), false, 'env wins and is checked');
  assert.equal(fs.existsSync(out), false);
  assert.equal(clientScript.main({ env: {}, envFile: path.join(dir, 'none'), out, log, version: '1.1.2-test.1' }), false);
  assert.equal(loadGoogleConfig(out), null);
});

test('scripts/google-client.js: Google sign-in only in test builds unless GOOGLE_OAUTH_RELEASE=1 (#114)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-gclient-rel-'));
  const out = path.join(dir, 'google-client.json');
  const envFile = path.join(dir, '.env');
  const logs = [];
  const log = (m) => logs.push(m);
  fs.writeFileSync(envFile, `GOOGLE_OAUTH_CLIENT_ID=${CONFIG.clientId}
GOOGLE_OAUTH_CLIENT_PW=${CONFIG.clientSecret}
`);
  // A public build removes a client file left from an earlier test build, even with the values present.
  fs.writeFileSync(out, JSON.stringify(CONFIG));
  assert.equal(clientScript.main({ env: {}, envFile, out, log, version: '1.1.1' }), false);
  assert.equal(fs.existsSync(out), false);
  assert.match(logs.at(-1), /without Google sign-in/);
  assert.equal(clientScript.main({ env: { GOOGLE_OAUTH_RELEASE: '0' }, envFile, out, log, version: '1.1.1' }), false);
  assert.equal(clientScript.main({ env: { GOOGLE_OAUTH_RELEASE: '1' }, envFile, out, log, version: '1.1.1' }), true, 'explicit opt-in after verification');
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), CONFIG);
  assert.equal(clientScript.main({ env: {}, envFile, out, log, version: '1.1.2-test.1' }), true, 'test builds keep it');
  // The version comes from the widget kit, else widget.json.
  assert.equal(clientScript.buildVersion({ WIDGET_KIT_VERSION: '1.1.2-test.3' }), '1.1.2-test.3');
  assert.equal(clientScript.buildVersion({}), JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'widget.json'), 'utf8')).version);
  assert.equal(clientScript.googleAllowed('1.1.1', {}), false);
  assert.equal(clientScript.googleAllowed('1.1.1-test.1', {}), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The export tool is internal (left out of the public copy, scripts/public-export.json).
const exportTool = path.join(__dirname, '..', '..', '..', 'scripts', 'publish-github.js');
test('the public export treats the Google client id like a secret', { skip: !fs.existsSync(exportTool) && 'public copy' }, () => {
  const { buildMatchers, findForbidden } = require('../../../scripts/publish-github');
  const matchers = buildMatchers([], { GOOGLE_OAUTH_CLIENT_ID: CONFIG.clientId, GOOGLE_OAUTH_CLIENT_PW: CONFIG.clientSecret });
  assert.equal(findForbidden('a.js', `x = "${CONFIG.clientId}"`, matchers).length, 1);
  assert.equal(findForbidden('a.js', `x = "${CONFIG.clientSecret}"`, matchers).length, 1);
});

test('the widget package does not ship the build script; google-client.json is git-ignored', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'widget.json'), 'utf8'));
  assert.equal(manifest.package.prebuild, 'scripts/google-client.js');
  assert.ok(manifest.package.exclude.includes('scripts'));
  const ignore = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.gitignore'), 'utf8');
  assert.match(ignore, /^widgets\/calendar\/google-client\.json$/m);
});
