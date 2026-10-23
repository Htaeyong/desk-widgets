// Settings sanitizing, the ICS fetcher (fake server responses) and the source manager's cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, sanitize, normalizeUrl, sanitizeSources, PALETTE } = require('../lib/settings');
const { fetchIcs, MAX_BYTES } = require('../lib/ics-source');
const { SourceManager } = require('../lib/sources');

const ICS = ['BEGIN:VCALENDAR', 'X-WR-CALNAME:팀', 'BEGIN:VEVENT', 'UID:1', 'DTSTART:20261018T010000Z', 'DTEND:20261018T020000Z', 'SUMMARY:회의', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

/** A fetch stand-in answering from a list of { status, body, headers } and recording request headers. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      body: null,
      text: async () => r.body ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

test('subscription addresses: http(s) kept, webcal mapped to https, others refused', () => {
  assert.equal(normalizeUrl('webcal://calendar.example.com/a.ics'), 'https://calendar.example.com/a.ics');
  assert.equal(normalizeUrl('WEBCALS://x.example.com/b'), 'https://x.example.com/b');
  assert.equal(normalizeUrl(' https://x.example.com/c.ics '), 'https://x.example.com/c.ics');
  assert.equal(normalizeUrl('http://x.example.com/d.ics'), 'http://x.example.com/d.ics');
  assert.equal(normalizeUrl('file:///C:/a.ics'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(normalizeUrl(''), null);
});

test('settings: defaults and clamping', () => {
  assert.equal(DEFAULTS.weekStart, 0, 'Sunday first by default');
  assert.equal(DEFAULTS.refreshMinutes, 15);
  const s = sanitize({ ...DEFAULTS, weekStart: '1', refreshMinutes: 1, upcomingDays: 99, alwaysOnTop: 'yes', windowBounds: { x: 'a' } });
  assert.deepEqual([s.weekStart, s.refreshMinutes, s.upcomingDays, s.alwaysOnTop, s.windowBounds], [1, 5, 31, true, { compact: null, month: null }]);
  assert.equal(sanitize({ ...DEFAULTS, weekStart: 3 }).weekStart, 0);
  assert.equal(sanitize({ ...DEFAULTS, refreshMinutes: 'x' }).refreshMinutes, 15);
});

test('settings: sources get ids, names, colors; bad ones are dropped; ids stay unique', () => {
  const list = sanitizeSources([
    { url: 'webcal://a.example.com/x.ics' },
    { id: 'keep-me', name: '  회사  ', url: 'https://b.example.com/y.ics', color: '#ABCDEF', enabled: false },
    { id: 'keep-me', url: 'https://c.example.com/z.ics', color: 'red' },
    { url: 'ftp://nope' },
    null,
  ]);
  assert.equal(list.length, 3);
  assert.match(list[0].id, /^s[0-9a-f]{10}$/);
  assert.equal(list[0].name, 'a.example.com');
  assert.equal(list[0].url, 'https://a.example.com/x.ics');
  assert.equal(list[0].color, PALETTE[0]);
  assert.equal(list[0].enabled, true);
  assert.deepEqual([list[1].id, list[1].name, list[1].color, list[1].enabled, list[1].type], ['keep-me', '회사', '#abcdef', false, 'ics']);
  assert.notEqual(list[2].id, 'keep-me');
  assert.equal(list[2].color, PALETTE[2]);
});

test('ICS fetch: parses, sends validators, handles 304', async () => {
  const fetch = fakeFetch([{ body: ICS, headers: { ETag: '"v1"', 'Last-Modified': 'Sun, 18 Oct 2026 00:00:00 GMT' } }, { status: 304 }]);
  const first = await fetchIcs({ url: 'https://x.example.com/a.ics' }, { fetch });
  assert.deepEqual(first.validators, { etag: '"v1"', lastModified: 'Sun, 18 Oct 2026 00:00:00 GMT' });
  assert.equal(first.calendars[0].name, '팀');
  assert.equal(first.calendars[0].readOnly, true);
  assert.equal(first.calendars[0].components.length, 1);
  const second = await fetchIcs({ url: 'https://x.example.com/a.ics' }, { fetch, prev: first.validators });
  assert.deepEqual(second, { notModified: true });
  assert.equal(fetch.calls[1].headers['If-None-Match'], '"v1"');
  assert.equal(fetch.calls[1].headers['If-Modified-Since'], 'Sun, 18 Oct 2026 00:00:00 GMT');
});

test('ICS fetch: errors in words the user can act on', async () => {
  const run = (r) => fetchIcs({ url: 'https://x.example.com/a.ics' }, { fetch: fakeFetch([r]) });
  await assert.rejects(run({ status: 404 }), /찾을 수 없습니다/);
  await assert.rejects(run({ status: 401 }), /접근이 거부/);
  await assert.rejects(run({ status: 503 }), /HTTP 503/);
  await assert.rejects(run({ body: '<html>login</html>' }), /iCalendar\(\.ics\) 형식이 아닙니다/);
  await assert.rejects(run({ body: ICS, headers: { 'Content-Length': String(MAX_BYTES + 1) } }), /너무 큽니다/);
  await assert.rejects(run(Object.assign(new Error('fail'), { cause: { code: 'ENOTFOUND' } })), /연결하지 못했습니다: ENOTFOUND/);
});

test('ICS fetch: a server that does not answer times out', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(fetchIcs({ url: 'https://x.example.com/a.ics' }, { fetch: hang, timeoutMs: 30 }), /시간이 초과/);
});

test('manager: refresh, cache on disk, offline start, errors keep the last events, removal deletes the cache', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-'));
  const src = { id: 'a1', type: 'ics', name: '팀', url: 'https://x.example.com/a.ics', color: '#123456', enabled: true };
  const range = [Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-11-01T00:00:00Z')];
  let now = 1000;
  const m1 = new SourceManager({ dataDir, fetch: fakeFetch([{ body: ICS, headers: { ETag: '"v1"' } }]), now: () => now });
  m1.setSources([src]);
  await m1.refresh();
  const events = m1.events(...range);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].title, events[0].color, events[0].sourceId, events[0].readOnly, events[0].sourceName], ['회의', '#123456', 'a1', true, '팀']);
  assert.ok(fs.existsSync(path.join(dataDir, 'cache', 'a1.json')));
  assert.deepEqual(m1.status()[0], { id: 'a1', fetchedAt: 1000, lastAttempt: 1000, error: null, errorCode: null, calendarName: '팀', count: 1, refreshing: false });

  // A new start shows the cached events before any request; a failed refresh keeps them and reports the error.
  now = 2000;
  const fetch2 = fakeFetch([{ status: 500 }]);
  const m2 = new SourceManager({ dataDir, fetch: fetch2, now: () => now });
  m2.setSources([src]);
  assert.equal(m2.events(...range).length, 1);
  await m2.refresh();
  assert.equal(fetch2.calls[0].headers['If-None-Match'], '"v1"', 'the cached ETag is sent');
  assert.equal(m2.events(...range).length, 1);
  assert.match(m2.status()[0].error, /HTTP 500/);
  assert.equal(m2.status()[0].fetchedAt, 1000);
  assert.equal(m2.lastUpdated(), 1000);

  // Disabled sources are not fetched or shown; a changed URL drops the old cache; removal deletes the file.
  m2.setSources([{ ...src, enabled: false }]);
  assert.deepEqual(m2.events(...range), []);
  await m2.refresh();
  assert.equal(fetch2.calls.length, 1);
  m2.setSources([{ ...src, url: 'https://x.example.com/other.ics' }]);
  assert.deepEqual(m2.events(...range), []);
  m2.setSources([]);
  assert.equal(fs.existsSync(path.join(dataDir, 'cache', 'a1.json')), false);
});

test('manager: one request per source at a time; results for a removed source are dropped', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-'));
  let release;
  let count = 0;
  const slow = () => {
    count++;
    return new Promise((resolve) => {
      release = () => resolve({ status: 200, ok: true, headers: { get: () => null }, body: null, text: async () => ICS });
    });
  };
  const m = new SourceManager({ dataDir, fetch: slow });
  m.setSources([{ id: 'a', type: 'ics', name: 'a', url: 'https://x.example.com/a.ics', color: '#123456', enabled: true }]);
  const p1 = m.refresh();
  const p2 = m.refresh();
  assert.equal(m.refreshing, true);
  m.setSources([]);
  release();
  await Promise.all([p1, p2]);
  assert.equal(count, 1);
  assert.equal(m.refreshing, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'cache', 'a.json')), false);
});
