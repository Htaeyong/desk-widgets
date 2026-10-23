// CalDAV (#47): multistatus parsing, discovery, server quirks (iCloud redirect and quotes, Naver multiget,
// Dooray empty collection), credential safety, 401 hints, the change-tag skip and the password store.
// The XML in test/fixtures is written in the shape each server answers (my_calendar_sync's findings).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../lib/webdav');
const { CalDavClient, checkServer, sameService, MAX_REDIRECTS } = require('../lib/caldav');
const { fetchCalDav } = require('../lib/caldav-source');
const { PROVIDERS, serverOf } = require('../lib/providers');
const { createSecrets } = require('../lib/secrets');
const { sanitizeSources } = require('../lib/settings');
const { SourceManager, windowFor } = require('../lib/sources');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/**
 * A fake CalDAV server: routes[`${METHOD} ${url}`] = response or (req) => response, where a response is
 * { status, body, headers }. Requests are recorded with their headers and body.
 */
function server(routes) {
  const requests = [];
  const fetch = async (url, opts) => {
    const req = { url, method: opts.method, headers: opts.headers, body: opts.body, redirect: opts.redirect };
    requests.push(req);
    let r = routes[`${opts.method} ${url}`];
    if (typeof r === 'function') r = r(req);
    if (!r) r = { status: 404, body: '' };
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status ?? 207,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      body: null,
      text: async () => r.body ?? '',
    };
  };
  fetch.requests = requests;
  return fetch;
}

const client = (fetch, extra = {}) => new CalDavClient({ username: 'me@example.com', password: 'app-pass-1234', fetch, ...extra });
const basic = 'Basic ' + Buffer.from('me@example.com:app-pass-1234').toString('base64');

test('multistatus: calendars with VEVENT only, iCloud single quotes, colors, privileges, failed propstats ignored', () => {
  const list = W.parseMultiStatus(fx('icloud-calendars.xml'));
  const cals = list.filter((r) => r.isCalendar && r.supportsVEvent);
  assert.deepEqual(
    cals.map((c) => [c.href, c.displayName, W.normalizeColor(c.color), c.canWrite, c.ctag]),
    [
      ['/123456/calendars/home/', 'Home', '#1badf8', true, 'HwoQEgwAAA'],
      ['/123456/calendars/shared/', '가족 (공유)', null, false, null],
    ],
  );
  assert.equal(list.find((r) => r.href.endsWith('/tasks/')).supportsVEvent, false, "comp name='VTODO' only");
  assert.equal(list.find((r) => r.href.endsWith('/inbox/')).isCalendar, false, 'schedule-inbox is not a calendar');
});

test('multistatus: Naver CDATA names and bind privilege, Dooray character references', () => {
  const [naver] = W.parseMultiStatus(fx('naver-calendars.xml'));
  assert.equal(naver.displayName, '내 캘린더 & 일정');
  assert.equal(naver.canWrite, true, 'bind allows adding events');
  assert.equal(W.parseMultiStatus(fx('dooray-calendars.xml'))[1].displayName, '홍길동 추가');
  assert.equal(W.parseMultiStatus('<multistatus><response><href>/x/</href><propstat><prop><current-user-privilege-set><privilege><write-content/></privilege></current-user-privilege-set></prop></propstat></response></multistatus>')[0].canWrite, false, 'write-content alone is not bind');
  assert.equal(W.collectionTag(fx('ctag.xml')), 'CTAG-1');
  assert.equal(W.nestedHref('current-user-principal', fx('principal.xml')), '/123456/principal/');
  assert.equal(W.nestedHref('calendar-home-set', fx('home.xml')), '/123456/calendars/');
});

test('time-range query: UTC basic format, no server-side expand; multiget escapes hrefs', () => {
  const body = W.calendarQuery(Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-12-08T15:00:00Z'));
  assert.match(body, /<c:time-range start="20260901T000000Z" end="20261208T150000Z"\/>/);
  assert.match(body, /<c:comp-filter name="VEVENT">/);
  assert.doesNotMatch(body, /expand/);
  assert.match(W.calendarMultiget(['/a&b.ics']), /<d:href>\/a&amp;b\.ics<\/d:href>/);
});

test('iCloud: discovery follows the redirect to pNN-caldav keeping method, body, Depth and auth', async () => {
  const fetch = server({
    'PROPFIND https://caldav.icloud.com/': { status: 301, headers: { Location: 'https://p42-caldav.icloud.com/' } },
    'PROPFIND https://p42-caldav.icloud.com/': { body: fx('principal.xml') },
    'PROPFIND https://p42-caldav.icloud.com/123456/principal/': { body: fx('home.xml') },
    'PROPFIND https://p42-caldav.icloud.com/123456/calendars/': { body: fx('icloud-calendars.xml') },
  });
  const cals = await client(fetch).discover('https://caldav.icloud.com/');
  assert.deepEqual(
    cals.map((c) => [c.url, c.name, c.color, c.canWrite]),
    [
      ['https://p42-caldav.icloud.com/123456/calendars/home/', 'Home', '#1badf8', true],
      ['https://p42-caldav.icloud.com/123456/calendars/shared/', '가족 (공유)', null, false],
    ],
  );
  const [first, second] = fetch.requests;
  assert.equal(second.method, 'PROPFIND');
  assert.equal(second.body, first.body);
  assert.equal(second.headers.Depth, '0');
  assert.equal(second.headers.Authorization, basic);
  assert.ok(fetch.requests.every((r) => r.redirect === 'manual'), 'redirects are followed by hand, never by fetch');
  assert.equal(fetch.requests.find((r) => r.url.endsWith('/calendars/')).headers.Depth, '1');
});

test('the password never leaves the account server: foreign redirects, hrefs and http are refused', async () => {
  const redirect = server({ 'PROPFIND https://caldav.example.com/': { status: 302, headers: { Location: 'https://evil.example.net/' } } });
  await assert.rejects(client(redirect).discover('https://caldav.example.com/'), (e) => e.code === 'untrusted' && /evil\.example\.net/.test(e.message));
  assert.equal(redirect.requests.length, 1);

  const href = server({
    'PROPFIND https://caldav.example.com/': { body: fx('principal.xml').replace('/123456/principal/', 'https://evil.example.net/p/') },
  });
  await assert.rejects(client(href).discover('https://caldav.example.com/'), (e) => e.code === 'untrusted');
  assert.ok(href.requests.every((r) => r.url.startsWith('https://caldav.example.com/')));

  assert.equal(sameService('https://caldav.icloud.com/', 'https://p7-caldav.icloud.com/x'), true);
  assert.equal(sameService('https://caldav.icloud.com/', 'https://www.icloud.com/'), false);
  assert.equal(sameService('https://a.example.com/', 'http://a.example.com/'), false, 'no downgrade');
  assert.equal(sameService('https://a.example.com/', 'https://a.example.com:8443/'), false, 'same port only');
  assert.equal(sameService('https://a.example.com/', 'https://u:p@a.example.com/'), false);

  // Every answer is another redirect: the client stops after MAX_REDIRECTS hops.
  let n = 0;
  const looping = async () => ({ status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? `/r${n++}` : null) }, body: null, text: async () => '' });
  await assert.rejects(client(looping).discover('https://caldav.example.com/'), (e) => e.code === 'redirects');
  assert.equal(n, MAX_REDIRECTS + 1);
});

test('discovery falls back to /.well-known/caldav and says so when there is no calendar home', async () => {
  const wk = server({
    'PROPFIND https://cal.example.com/dav/': { status: 404 },
    'PROPFIND https://cal.example.com/.well-known/caldav': { status: 301, headers: { Location: '/remote.php/dav/' } },
    'PROPFIND https://cal.example.com/remote.php/dav/': { body: fx('principal.xml') },
    'PROPFIND https://cal.example.com/123456/principal/': { body: fx('home.xml') },
    'PROPFIND https://cal.example.com/123456/calendars/': { body: fx('naver-calendars.xml') },
  });
  const cals = await client(wk).discover('https://cal.example.com/dav/');
  assert.equal(cals[0].url, 'https://cal.example.com/caldav/user01/calendar/1234/');
  const none = server({ 'PROPFIND https://cal.example.com/': { body: '<multistatus xmlns="DAV:"><response><href>/</href></response></multistatus>' } });
  await assert.rejects(client(none).discover('https://cal.example.com/'), (e) => e.code === 'discovery' && /CalDAV가 켜져/.test(e.message));
});

test('Naver: a calendar-query with href/etag only is completed by calendar-multiget, then GET', async () => {
  const cal = 'https://caldav.calendar.naver.com/caldav/user01/calendar/1234/';
  const fetch = server({
    [`REPORT ${cal}`]: (req) => (/calendar-multiget/.test(req.body) ? { body: fx('naver-multiget.xml') } : { body: fx('naver-query.xml') }),
    [`GET ${cal}b2.ics`]: { status: 200, body: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b2\r\nDTSTART;VALUE=DATE:20261021\r\nSUMMARY:연차\r\nEND:VEVENT\r\nEND:VCALENDAR' },
  });
  const texts = await client(fetch).readEvents(cal, Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(texts.length, 2);
  assert.match(texts[0], /SUMMARY:팀 회의 & 점심/);
  assert.match(texts[1], /UID:b2/);
  const multiget = fetch.requests.find((r) => /calendar-multiget/.test(r.body || ''));
  assert.match(multiget.body, /a1\.ics/);
  assert.match(multiget.body, /b2\.ics/);
  assert.equal(fetch.requests.filter((r) => r.method === 'GET').length, 1, 'only the one multiget did not return');
});

test('Dooray: an empty calendar answering with its own href (no trailing slash) is empty, with no extra requests', async () => {
  const cal = 'https://caldav.dooray.com/caldav/calendars/user@example.com/3001';
  const fetch = server({ [`REPORT ${cal}`]: { body: fx('dooray-empty-query.xml') } });
  assert.deepEqual(await client(fetch).readEvents(cal, 0, 86400000), []);
  assert.equal(fetch.requests.length, 1);
  const withSlash = server({ [`REPORT ${cal}/`]: { body: fx('dooray-empty-query.xml') } });
  assert.deepEqual(await client(withSlash).readEvents(`${cal}/`, 0, 86400000), []);
});

test('a failed resource inside a REPORT is an error, not an empty calendar', async () => {
  const cal = 'https://cal.example.com/c/';
  const body = '<multistatus xmlns="DAV:"><response><href>/c/x.ics</href><status>HTTP/1.1 500 Internal Server Error</status></response></multistatus>';
  await assert.rejects(client(server({ [`REPORT ${cal}`]: { body } })).readEvents(cal, 0, 1), /HTTP 500/);
  await assert.rejects(client(server({ [`REPORT ${cal}`]: { status: 503, body: '' } })).readEvents(cal, 0, 1), /캘린더 서버 오류/);
});

test('401 gives the provider-specific hint (password / plan / admin)', async () => {
  for (const id of ['icloud', 'naver', 'naverworks', 'dooray', 'other']) {
    const fetch = server({ [`PROPFIND ${PROVIDERS[id].baseUrl || 'https://cal.example.com/'}`]: { status: 401 } });
    const c = client(fetch, { authHint: PROVIDERS[id].authHint });
    await assert.rejects(c.discover(PROVIDERS[id].baseUrl || 'https://cal.example.com/'), (e) => e.code === 'auth' && e.message === PROVIDERS[id].authHint);
  }
  assert.match(PROVIDERS.dooray.authHint, /Business/);
  assert.match(PROVIDERS.naverworks.authHint, /관리자/);
  assert.match(PROVIDERS.icloud.authHint, /앱 암호/);
});

test('server addresses: https only, no credentials in the URL, bare host gets https; fixed providers ignore input', () => {
  assert.deepEqual(checkServer('cal.example.com'), { url: 'https://cal.example.com/' });
  assert.deepEqual(checkServer('https://cal.example.com/dav'), { url: 'https://cal.example.com/dav/' });
  assert.match(checkServer('http://cal.example.com').error, /https/);
  assert.match(checkServer('https://u:p@cal.example.com').error, /아이디/);
  assert.match(checkServer('').error, /넣으세요/);
  assert.match(checkServer('https://bad host').error, /공백/);
  assert.deepEqual(serverOf('icloud', 'https://evil.example.net', checkServer), { url: 'https://caldav.icloud.com/' });
  assert.deepEqual(serverOf('dooray', '', checkServer), { url: 'https://caldav.dooray.com/' });
  assert.deepEqual(serverOf('dooray', 'caldav.mycompany.dooray.com', checkServer), { url: 'https://caldav.mycompany.dooray.com/' });
  assert.match(serverOf('other', '', checkServer).error, /넣으세요/);
});

test('CalDAV settings entries: no password field, server checked, calendars sanitized', () => {
  const [acc, other] = sanitizeSources([
    { type: 'caldav', provider: 'naver', username: ' me ', password: 'x', server: 'https://evil.example.net', calendars: [{ id: 'https://caldav.calendar.naver.com/c/1/', name: '내 캘린더', canWrite: true }, { id: 'http://x/' }] },
    { type: 'caldav', provider: 'other', username: 'u', server: 'cal.example.com' },
    { type: 'caldav', provider: 'other', username: 'u', server: 'http://cal.example.com' },
    { type: 'caldav', provider: 'nope', username: 'u' },
  ]);
  assert.equal(acc.password, undefined);
  assert.equal(acc.username, 'me');
  assert.equal(acc.server, 'https://caldav.calendar.naver.com/', 'fixed providers use their own server');
  assert.deepEqual(acc.calendars.map((c) => [c.id, c.enabled, c.canWrite]), [['https://caldav.calendar.naver.com/c/1/', true, true]]);
  assert.equal(other.server, 'https://cal.example.com/');
});

const cloudAccount = {
  id: 'acc1',
  type: 'caldav',
  name: 'iCloud',
  provider: 'icloud',
  server: 'https://caldav.icloud.com/',
  username: 'me@example.com',
  enabled: true,
  color: '#123456',
  calendars: [{ id: 'https://p42-caldav.icloud.com/123456/calendars/home/', name: 'Home', color: '#1badf8', enabled: true, canWrite: true }],
};
const home = cloudAccount.calendars[0].id;
const win = { from: Date.parse('2026-09-01T00:00:00Z'), to: Date.parse('2026-12-08T00:00:00Z') };

test('fetch: reads each enabled calendar; an unchanged ctag with a covering window skips the REPORT', async () => {
  let ctag = 'CTAG-1';
  const fetch = server({
    [`PROPFIND ${home}`]: () => ({ body: fx('ctag.xml').replace('CTAG-1', ctag) }),
    [`REPORT ${home}`]: { body: fx('query-with-data.xml') },
  });
  const first = await fetchCalDav(cloudAccount, { fetch, password: 'app-pass-1234', window: win });
  assert.equal(first.calendars[0].components[0].title, '주간 보고');
  assert.equal(first.validators.tags[home], 'CTAG-1');
  const reports = () => fetch.requests.filter((r) => r.method === 'REPORT').length;
  assert.equal(reports(), 1);

  const inner = { from: win.from + 86400000, to: win.to - 86400000 };
  const second = await fetchCalDav(cloudAccount, { fetch, password: 'app-pass-1234', window: inner, prev: first.validators, previous: first.calendars });
  assert.equal(reports(), 1, 'same tag, window inside the cached one: no REPORT');
  assert.equal(second.calendars[0].components.length, 1);
  assert.deepEqual(second.validators.windows[home], win);

  await fetchCalDav(cloudAccount, { fetch, password: 'app-pass-1234', window: { from: win.from - 86400000 * 40, to: win.to }, prev: first.validators, previous: first.calendars });
  assert.equal(reports(), 2, 'a wider window reads again');
  ctag = 'CTAG-2';
  await fetchCalDav(cloudAccount, { fetch, password: 'app-pass-1234', window: win, prev: first.validators, previous: first.calendars });
  assert.equal(reports(), 3, 'a new tag reads again');

  const off = { ...cloudAccount, calendars: [{ ...cloudAccount.calendars[0], enabled: false }] };
  assert.deepEqual((await fetchCalDav(off, { fetch, password: 'p', window: win })).calendars, []);
  await assert.rejects(fetchCalDav(cloudAccount, { fetch, password: '', window: win }), (e) => e.code === 'no-secret');
});

test('password store: only ciphertext on disk, refuses without encryption, delete and prune', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-sec-'));
  const file = path.join(dir, 'secrets.json');
  // Stand-in for safeStorage: reversible, and visibly not the plain text.
  const fake = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };
  const secrets = createSecrets({ file, crypto: fake });
  secrets.set('a', 'app-pass-1234');
  secrets.set('b', 'other-secret');
  assert.equal(secrets.get('a'), 'app-pass-1234');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('app-pass-1234'));
  secrets.delete('a');
  assert.equal(secrets.get('a'), '');
  secrets.prune([]);
  assert.equal(secrets.has('b'), false);

  const none = createSecrets({ file: path.join(dir, 'none.json'), crypto: { ...fake, available: () => false } });
  assert.equal(none.available(), false);
  assert.throws(() => none.set('a', 'app-pass-1234'), (e) => e.code === 'secret-unavailable' && /평문/.test(e.message));
  assert.equal(fs.existsSync(path.join(dir, 'none.json')), false);
  const broken = createSecrets({ file, crypto: { ...fake, decrypt: () => { throw new Error('other user'); } } });
  secrets.set('c', 'x');
  assert.equal(broken.get('c'), '', 'undecryptable reads as no password');
});

test('manager: a range past the CalDAV window asks once for a refresh of those accounts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-win-'));
  const asked = [];
  const m = new SourceManager({ dataDir: dir, now: () => Date.parse('2026-10-18T03:00:00Z'), onWindow: (ids) => asked.push(ids) });
  m.setSources([cloudAccount]);
  m.state.get('acc1').fetchedAt = 1;
  m.state.get('acc1').validators = { windows: { [home]: win } };
  m.ensureWindow([{ from: win.from + 1, to: win.to - 1 }]);
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(asked, [], 'inside the cached window');
  const far = { from: Date.parse('2027-06-01T00:00:00Z'), to: Date.parse('2027-07-01T00:00:00Z') };
  m.ensureWindow([far]);
  m.ensureWindow([far]);
  await new Promise((r) => setTimeout(r, 350));
  m.ensureWindow([far]);
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(asked, [['acc1']], 'asked once for the same window');
  assert.ok(m.window.from <= far.from && m.window.to >= far.to);
  assert.deepEqual(windowFor([{ from: 0, to: 10 }, { from: 5 * 366 * 86400000, to: 5 * 366 * 86400000 + 10 }]), { from: -31 * 86400000, to: 10 + 31 * 86400000 }, 'too long: the grid only');
  m.stop();
});
