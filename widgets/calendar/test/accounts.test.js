// CalDAV accounts through the widget's main code (#47): "연결 확인", saving with an encrypted password,
// reading events, re-discovery with the stored password, removal, and the refusals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../index');
const { DEFAULTS, sanitize } = require('../lib/settings');
const { withThemeHost } = require('./theme-host');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const NAVER = 'https://caldav.calendar.naver.com/';
const NAVER_CAL = 'https://caldav.calendar.naver.com/caldav/user01/calendar/1234/';
const PASSWORD = 'right-app-pass';
// Stand-in for Electron safeStorage: reversible and visibly not the plain text.
const fakeCrypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };

/** A Naver-like server: only user01 with the app password gets in; calendar-query answers href/etag only. */
function naverServer() {
  const requests = [];
  const ok = 'Basic ' + Buffer.from(`user01:${PASSWORD}`).toString('base64');
  const query = fx('naver-query.xml').replace(/<D:response>\s*<D:href>[^<]*b2\.ics[\s\S]*?<\/D:response>/, '');
  const routes = {
    [`PROPFIND ${NAVER}`]: () => fx('principal.xml'),
    'PROPFIND https://caldav.calendar.naver.com/123456/principal/': () => fx('home.xml'),
    'PROPFIND https://caldav.calendar.naver.com/123456/calendars/': () => fx('naver-calendars.xml'),
    [`REPORT ${NAVER_CAL}`]: (body) => (/calendar-multiget/.test(body) ? fx('naver-multiget.xml') : query),
  };
  const fetch = async (url, opts) => {
    requests.push({ url, method: opts.method, auth: opts.headers.Authorization });
    const route = routes[`${opts.method} ${url}`];
    const status = opts.headers.Authorization !== ok ? 401 : route ? 207 : 404;
    const body = status === 207 ? route(opts.body) : '';
    return { status, headers: { get: () => null }, body: null, text: async () => body };
  };
  fetch.requests = requests;
  return fetch;
}

function setup({ crypto = fakeCrypto } = {}) {
  let state = sanitize({ ...DEFAULTS });
  const { ctx, th } = withThemeHost({
    dir: path.join(__dirname, '..'),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cal-acc-')),
    createStore: () => ({ load: () => state, save: (v) => { state = sanitize({ ...state, ...v }); } }),
    openExternal() {},
    sendToSettings() {},
  });
  const fetch = naverServer();
  const widget = create(ctx, { fetch, crypto });
  return { widget, ctx, fetch, th, getState: () => state };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
/** Every file under the widget's data folder, as one string. */
const allData = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, String(f)))
    .filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

test('connect, save with the encrypted password, read events; the password is never in plain text', async (t) => {
  const { widget, ctx, fetch, th, getState } = setup();
  widget.start();
  t.after(() => widget.stop());
  const values = widget.settings.get();
  assert.equal(values.secretAvailable, true);
  assert.deepEqual(values.providers.map((p) => p.id), ['icloud', 'naver', 'naverworks', 'dooray', 'other']);

  const wrong = await widget.settings.handlers.caldavDiscover({ provider: 'naver', username: 'user01', password: 'login-password' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'auth');
  assert.match(wrong.message, /애플리케이션 비밀번호/);

  const res = await widget.settings.handlers.caldavDiscover({ provider: 'naver', username: 'user01', password: PASSWORD, server: 'https://evil.example.net' });
  assert.equal(res.ok, true);
  assert.ok(res.token);
  assert.deepEqual(res.calendars.map((c) => [c.id, c.name, c.canWrite]), [[NAVER_CAL, '내 캘린더 & 일정', true]]);
  assert.ok(fetch.requests.every((r) => r.url.startsWith(NAVER)), 'a fixed provider ignores a typed server');

  const account = { type: 'caldav', provider: 'naver', username: 'user01', name: '네이버', enabled: true, calendars: res.calendars, draft: res.token };
  assert.deepEqual(widget.settings.save({ sources: [account] }), { ok: true });
  await settle();
  const saved = getState().sources[0];
  assert.equal(saved.type, 'caldav');
  assert.equal(saved.draft, undefined);
  assert.ok(!JSON.stringify(getState()).includes(PASSWORD), 'not in the settings');
  assert.ok(!allData(ctx.dataDir).includes(PASSWORD), 'not in plain text in any file');
  assert.ok(fs.existsSync(path.join(ctx.dataDir, 'secrets.json')));

  const oct = { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-11-01T00:00:00Z') };
  const events = (await th.call('events.list', [[oct]]))[0];
  assert.deepEqual(events.map((e) => [e.title, e.readOnly, e.sourceName]), [['팀 회의 & 점심', false, '네이버 · 내 캘린더 & 일정']]);
  assert.ok(fetch.requests.some((r) => r.method === 'REPORT'));
  assert.ok(fetch.requests.every((r) => r.url.startsWith(NAVER)), 'the password only went to the account server');

  // Re-discovery for a saved account uses the stored password; removing the account deletes password and cache.
  const again = await widget.settings.handlers.caldavDiscover({ provider: 'naver', username: 'user01', accountId: saved.id });
  assert.equal(again.ok, true);
  assert.equal(again.token, null);
  assert.ok(fs.existsSync(path.join(ctx.dataDir, 'cache', `${saved.id}.json`)));
  assert.deepEqual(widget.settings.save({ sources: [] }), { ok: true });
  assert.equal(fs.readFileSync(path.join(ctx.dataDir, 'secrets.json'), 'utf8'), '{}');
  assert.equal(fs.existsSync(path.join(ctx.dataDir, 'cache', `${saved.id}.json`)), false);
});

test('saving needs a fresh connection for a new login', async (t) => {
  const { widget, ctx } = setup();
  widget.start();
  t.after(() => widget.stop());
  const cal = [{ id: NAVER_CAL, name: 'c', enabled: true }];
  const noDraft = widget.settings.save({ sources: [{ type: 'caldav', provider: 'naver', username: 'user01', calendars: cal }] });
  assert.equal(noDraft.ok, false);
  assert.match(noDraft.message, /연결 확인/);

  const res = await widget.settings.handlers.caldavDiscover({ provider: 'naver', username: 'user01', password: PASSWORD });
  const other = widget.settings.save({ sources: [{ type: 'caldav', provider: 'naver', username: 'someone-else', calendars: cal, draft: res.token }] });
  assert.equal(other.ok, false, 'the draft belongs to another login');
  assert.match(other.message, /다시/);
  const noCalendars = widget.settings.save({ sources: [{ type: 'caldav', provider: 'naver', username: 'user01', calendars: [], draft: res.token }] });
  assert.equal(noCalendars.ok, false);
  assert.equal(fs.existsSync(path.join(ctx.dataDir, 'secrets.json')), false, 'nothing stored by refused saves');
  // The refused saves kept the draft: fixing the entry and saving again works.
  assert.deepEqual(widget.settings.save({ sources: [{ type: 'caldav', provider: 'naver', username: 'user01', calendars: cal, draft: res.token }] }), { ok: true });
});

test('without OS encryption no account can be added and nothing is written', async (t) => {
  const { widget, ctx } = setup({ crypto: { ...fakeCrypto, available: () => false } });
  widget.start();
  t.after(() => widget.stop());
  assert.equal(widget.settings.get().secretAvailable, false);
  const refused = await widget.settings.handlers.caldavDiscover({ provider: 'naver', username: 'user01', password: PASSWORD });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /평문/);
  assert.equal(fs.existsSync(path.join(ctx.dataDir, 'secrets.json')), false);
});

test('a saved account whose password went missing shows an error instead of an empty calendar', async (t) => {
  const { widget, ctx, getState } = setup();
  widget.start();
  t.after(() => widget.stop());
  const res = await widget.settings.handlers.caldavDiscover({ provider: 'naver', username: 'user01', password: PASSWORD });
  widget.settings.save({ sources: [{ type: 'caldav', provider: 'naver', username: 'user01', calendars: res.calendars, draft: res.token }] });
  await settle();
  fs.writeFileSync(path.join(ctx.dataDir, 'secrets.json'), '{}');
  await widget.settings.handlers.refresh();
  const st = widget.settings.get().status.find((s) => s.id === getState().sources[0].id);
  assert.equal(st.errorCode, 'no-secret');
  assert.match(st.error, /연결 확인/);
  assert.equal(st.count, 1, 'the last events stay');
});
