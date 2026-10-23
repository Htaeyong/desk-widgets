// Event writes (#48): serialization, the merge into the server's document, read-only rules, field checks,
// conditional requests, conflicts and the verification that a write really landed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeNew, mergeEdit, fingerprint, escapeText, fold, PRODID } = require('../lib/ical-write');
const { parseIcs, componentFields } = require('../lib/ical');
const { readOnlyReason, isMe } = require('../lib/editable');
const { validateFields, diffFields } = require('../lib/event-fields');
const { writeEvent } = require('../lib/writer');
const { componentsOf } = require('../lib/caldav-source');
const { CalDavClient } = require('../lib/caldav');

const NOW = Date.UTC(2026, 9, 18, 3, 0, 0);
const CAL = 'https://caldav.example.com/cal/home/';

test('new events: all-day as DATE (end exclusive), timed in UTC, escaped and folded, our PRODID', () => {
  const allDay = serializeNew('u1@desk-widgets', { title: '휴가; 제주, 2박', allDay: true, start: '2026-10-20', end: '2026-10-23', location: '', description: '첫 줄\n둘째 줄' }, NOW);
  assert.match(allDay, /\r\nDTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261023\r\n/);
  assert.match(allDay, /SUMMARY:휴가\\; 제주\\, 2박/);
  assert.match(allDay, /DESCRIPTION:첫 줄\\n둘째 줄/);
  assert.doesNotMatch(allDay, /LOCATION/, 'empty fields are left out');
  assert.match(allDay, new RegExp(`PRODID:${PRODID.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.doesNotMatch(allDay, /METHOD/);
  const timed = serializeNew('u2@desk-widgets', { title: '회의', allDay: false, start: Date.UTC(2026, 9, 20, 1, 0), end: Date.UTC(2026, 9, 20, 2, 30), location: '3층', description: '' }, NOW);
  assert.match(timed, /DTSTART:20261020T010000Z\r\nDTEND:20261020T023000Z/);
  assert.match(timed, /DTSTAMP:20261018T030000Z/);
  assert.match(timed, /SEQUENCE:0/);
  // Folding: no physical line over 75 octets, and unfolding gives the text back.
  const long = serializeNew('u3', { title: '가'.repeat(100), allDay: true, start: '2026-10-20', end: '2026-10-21', location: '', description: '' }, NOW);
  assert.ok(long.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  assert.equal(parseIcs(long).events[0].title, '가'.repeat(100));
  assert.equal(escapeText('a\\b\r\nc\u0001'), 'a\\\\b\\nc');
  assert.equal(fold('x'.repeat(80)), `${'x'.repeat(75)}\r\n ${'x'.repeat(5)}`);
});

test('what is written reads back as the same fields (the verification fingerprint)', () => {
  for (const f of [
    { title: '휴가', allDay: true, start: '2026-10-20', end: '2026-10-23', location: '제주', description: '메모, 하나' },
    { title: '회의', allDay: false, start: Date.UTC(2026, 9, 20, 1, 0), end: Date.UTC(2026, 9, 20, 2, 30), location: '', description: '' },
  ]) {
    const [c] = parseIcs(serializeNew('x', f, NOW)).events;
    assert.equal(fingerprint(componentFields(c)), fingerprint(f));
  }
  assert.notEqual(fingerprint({ title: 'a', allDay: true, start: '2026-10-20', end: '2026-10-21' }), fingerprint({ title: 'b', allDay: true, start: '2026-10-20', end: '2026-10-21' }));
});

// A server document with things the widget does not model.
const SERVER_DOC = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//NHN Corp//Dooray Calendar//KO',
  'METHOD:PUBLISH',
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Seoul',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0900',
  'TZOFFSETTO:+0900',
  'DTSTART:19700101T000000',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:evt-1',
  'DTSTAMP:20261001T000000Z',
  'DTSTART;TZID=Asia/Seoul:20261020T100000',
  'DTEND;TZID=Asia/Seoul:20261020T110000',
  'SUMMARY:주간 회의',
  'LOCATION:3층',
  'DESCRIPTION:안건',
  'X-ALT-DESC;FMTTYPE=text/html:<p>안건</p>',
  'X-DOORAY-ID:123',
  'SEQUENCE:2',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:알림 문구',
  'TRIGGER:-PT10M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

test('edit merge: only changed properties, VALARM / X- / VTIMEZONE kept, METHOD dropped, PRODID ours, SEQUENCE + 1', () => {
  const out = mergeEdit(SERVER_DOC, 'evt-1', { title: '주간 회의 (변경)' }, NOW);
  assert.match(out, /SUMMARY:주간 회의 \(변경\)/);
  assert.doesNotMatch(out, /SUMMARY:주간 회의\r\n/);
  assert.doesNotMatch(out, /METHOD/);
  assert.match(out, new RegExp(`PRODID:${PRODID.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.doesNotMatch(out, /Dooray Calendar/);
  assert.match(out, /DTSTART;TZID=Asia\/Seoul:20261020T100000/, 'times untouched keep their original form');
  assert.match(out, /X-DOORAY-ID:123/);
  assert.match(out, /X-ALT-DESC/, 'description not edited: its HTML copy stays');
  assert.match(out, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:알림 문구/);
  assert.match(out, /BEGIN:VTIMEZONE/);
  assert.match(out, /SEQUENCE:3/);
  assert.equal((out.match(/SEQUENCE:/g) || []).length, 1);
  assert.match(out, /DTSTAMP:20261018T030000Z/);
  const [c] = parseIcs(out).events;
  assert.deepEqual([c.title, c.location, c.description], ['주간 회의 (변경)', '3층', '안건']);
});

test('edit merge: time, description and clearing a field; attendees keep SEQUENCE; overrides untouched', () => {
  const t = mergeEdit(SERVER_DOC, 'evt-1', { time: { allDay: true, start: '2026-10-21', end: '2026-10-22' }, description: '새 안건', location: '' }, NOW);
  assert.match(t, /DTSTART;VALUE=DATE:20261021\r\nDTEND;VALUE=DATE:20261022/);
  assert.doesNotMatch(t, /DTSTART;TZID/);
  assert.doesNotMatch(t, /X-ALT-DESC/, 'an edited description drops the old HTML copy');
  assert.doesNotMatch(t, /LOCATION/);
  assert.match(t, /DESCRIPTION:알림 문구/, "the alarm's DESCRIPTION is not the event's");

  const meeting = SERVER_DOC.replace('SEQUENCE:2', 'SEQUENCE:2\r\nORGANIZER:mailto:me@example.com\r\nATTENDEE;CN=Kim:mailto:kim@example.com');
  const m = mergeEdit(meeting, 'evt-1', { title: 'x' }, NOW);
  assert.match(m, /SEQUENCE:2/, 'no SEQUENCE bump with attendees');
  assert.match(m, /ATTENDEE;CN=Kim:mailto:kim@example.com/);

  const withOverride = SERVER_DOC.replace(
    'END:VCALENDAR',
    'BEGIN:VEVENT\r\nUID:evt-1\r\nRECURRENCE-ID:20261027T010000Z\r\nDTSTART:20261027T050000Z\r\nSUMMARY:예외\r\nEND:VEVENT\r\nEND:VCALENDAR',
  );
  assert.match(mergeEdit(withOverride, 'evt-1', { title: '바뀜' }, NOW), /SUMMARY:예외/);
  assert.equal(mergeEdit(SERVER_DOC, 'other-uid', { title: 'x' }, NOW), null, 'no such event: nothing to write');
  const noProdid = mergeEdit(SERVER_DOC.replace('PRODID:-//NHN Corp//Dooray Calendar//KO\r\n', ''), 'evt-1', { title: 'x' }, NOW);
  assert.match(noProdid, /^BEGIN:VCALENDAR\r\nPRODID:/);
});

test('read-only rules: ICS, read-only calendar, recurring, someone else\'s meeting, shared resource, no ETag', () => {
  const base = { uid: 'a', href: `${CAL}a.ics`, etag: 'e1', rrule: null, rdates: [], recurrenceId: null, organizer: '', attendees: 0, shared: false };
  const src = { username: 'me@example.com' };
  const reason = (comps, extra = {}) => readOnlyReason({ writable: true, source: src, calendar: { canWrite: true }, components: comps, uid: 'a', ...extra });
  assert.equal(reason([base]), null);
  assert.match(reason([base], { writable: false }), /ICS/);
  assert.match(reason([base], { calendar: { canWrite: false } }), /쓰기 권한/);
  assert.equal(reason([base], { calendar: { canWrite: null } }), null, 'unreported privileges: writable, the write itself decides');
  assert.match(reason([{ ...base, rrule: { freq: 'WEEKLY' } }]), /반복/);
  assert.match(reason([base, { ...base, recurrenceId: { allDay: true, date: '2026-10-20' } }]), /반복/);
  assert.match(reason([{ ...base, organizer: 'mailto:boss@example.com', attendees: 2 }]), /초대/);
  assert.equal(reason([{ ...base, organizer: 'mailto:ME@example.com', attendees: 2 }]), null, 'my own meeting');
  assert.equal(reason([{ ...base, organizer: 'mailto:boss@example.com', attendees: 0 }]), null, 'an organizer without attendees is not an invitation');
  assert.match(reason([{ ...base, shared: true }]), /한 파일/);
  assert.match(reason([{ ...base, etag: null }]), /ETag/);
  assert.equal(isMe('mailto:user01@naver.com', 'user01'), true);
  assert.equal(isMe('mailto:user02@naver.com', 'user01'), false);
});

test('editor values: checks in Korean, and the diff names only what changed', () => {
  assert.match(validateFields({ title: ' ', allDay: true, start: '2026-10-20', end: '2026-10-21' }).error, /제목/);
  assert.match(validateFields({ title: 'a', allDay: true, start: '2026-10-21', end: '2026-10-21' }).error, /끝 날짜/);
  assert.match(validateFields({ title: 'a', allDay: true, start: '2026-02-30', end: '2026-03-01' }).error, /날짜/);
  assert.match(validateFields({ title: 'a', allDay: false, start: 2000, end: 1000 }).error, /끝 시간/);
  assert.match(validateFields({ title: 'a', allDay: false, start: 0, end: 400 * 86400000 }).error, /1년/);
  assert.match(validateFields({ title: 'x'.repeat(301), allDay: false, start: 0, end: 60000 }).error, /300자/);
  const ok = validateFields({ title: ' 회의\n ', allDay: false, start: 60000 * 10 + 1234, end: 60000 * 70, location: ' 3층 ', description: '메모\n\n' });
  assert.deepEqual(ok.fields, { title: '회의', allDay: false, start: 600000, end: 4200000, location: '3층', description: '메모' });
  const original = { title: '회의', allDay: false, start: 600000, end: 4200000, location: '3층', description: '메모' };
  assert.deepEqual(diffFields(original, ok.fields), {});
  assert.deepEqual(diffFields(original, { ...ok.fields, title: '새 회의', end: 7800000 }), { title: '새 회의', time: { allDay: false, start: 600000, end: 7800000 } });
});

/**
 * An in-memory CalDAV calendar: PUT/GET/DELETE with ETags and preconditions, REPORT listing everything.
 * dropWrites: answers 2xx to PUT/DELETE but keeps nothing (what Dooray did in my_calendar_sync #100/#106).
 */
function memServer({ dropWrites = false, initial = {} } = {}) {
  const store = new Map(Object.entries(initial));
  let version = 10;
  const requests = [];
  const reply = (status, body = '', headers = {}) => {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, body: null, text: async () => body };
  };
  const fetch = async (url, opts) => {
    const headers = opts.headers || {};
    requests.push({ url, method: opts.method, ifMatch: headers['If-Match'], ifNoneMatch: headers['If-None-Match'], body: opts.body, contentType: headers['Content-Type'] });
    const res = store.get(url);
    if (opts.method === 'REPORT') {
      const items = [...store].map(([href, r]) => `<d:response><d:href>${new URL(href).pathname}</d:href><d:propstat><d:prop><d:getetag>"${r.etag}"</d:getetag><c:calendar-data><![CDATA[${r.ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
      return reply(207, `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${items.join('')}</d:multistatus>`);
    }
    if (opts.method === 'PROPFIND') return reply(404);
    if (opts.method === 'GET') return res ? reply(200, res.ics, { ETag: `"${res.etag}"` }) : reply(404);
    if (opts.method === 'PUT') {
      if (headers['If-None-Match'] === '*' && res) return reply(412);
      if (headers['If-Match'] && (!res || headers['If-Match'] !== `"${res.etag}"`)) return reply(412);
      const etag = `v${++version}`;
      if (!dropWrites) store.set(url, { etag, ics: opts.body });
      return reply(res ? 204 : 201, '', { ETag: `"${etag}"` });
    }
    if (opts.method === 'DELETE') {
      if (!res) return reply(404);
      if (headers['If-Match'] !== `"${res.etag}"`) return reply(412);
      if (!dropWrites) store.delete(url);
      return reply(204);
    }
    return reply(405);
  };
  return { fetch, store, requests };
}

const account = { id: 'acc', type: 'caldav', provider: 'other', username: 'me@example.com', server: 'https://caldav.example.com/' };
const fields = { title: '새 일정', allDay: false, start: Date.UTC(2026, 9, 20, 1), end: Date.UTC(2026, 9, 20, 2), location: '', description: '' };
const run = (srv, opts) => writeEvent({ source: account, calendarId: CAL, password: 'pw', fetch: srv.fetch, now: NOW, ...opts });
/** The calendar's components as the widget caches them (with href/etag). */
const cached = async (srv) => componentsOf(await new CalDavClient({ username: 'u', password: 'p', fetch: srv.fetch }).readResources(CAL, 0, 1e13));

test('create: If-None-Match: *, a resource named by the encoded UID, text/calendar, and confirmed by listing', async () => {
  const srv = memServer();
  const res = await run(srv, { op: 'create', fields });
  assert.equal(res.applied, true);
  assert.match(res.uid, /^[0-9a-f-]{36}@desk-widgets$/);
  const put = srv.requests.find((r) => r.method === 'PUT');
  assert.equal(put.url, `${CAL}${encodeURIComponent(res.uid)}.ics`);
  assert.equal(put.ifNoneMatch, '*');
  assert.equal(put.ifMatch, undefined);
  assert.match(put.contentType, /^text\/calendar/);
  assert.ok(srv.requests.some((r) => r.method === 'REPORT'), 'verified by listing the collection');
  assert.ok(!srv.requests.some((r) => r.method === 'GET'), 'not by reading the resource back');
});

test('a server that answers 2xx and keeps nothing: "not applied", and nothing is retried or forced', async () => {
  const srv = memServer({ dropWrites: true });
  const res = await run(srv, { op: 'create', fields });
  assert.equal(res.applied, false);
  assert.equal(srv.requests.filter((r) => r.method === 'PUT').length, 1);
  assert.ok(!srv.requests.some((r) => r.method === 'DELETE'));
});

test('edit: fresh GET, If-Match with the ETag the user saw, merged body, confirmed', async () => {
  const srv = memServer({ initial: { [`${CAL}evt-1.ics`]: { etag: 'e1', ics: SERVER_DOC } } });
  const comps = await cached(srv);
  const original = componentFields(comps[0]);
  const res = await run(srv, { op: 'edit', uid: 'evt-1', components: comps, fields: { ...original, title: '주간 회의 (변경)' } });
  assert.equal(res.applied, true);
  const put = srv.requests.find((r) => r.method === 'PUT');
  assert.equal(put.ifMatch, '"e1"');
  assert.match(put.body, /BEGIN:VALARM/);
  assert.match(put.body, /X-DOORAY-ID:123/);
  assert.doesNotMatch(put.body, /METHOD/);

  const same = await run(srv, { op: 'edit', uid: 'evt-1', components: await cached(srv), fields: { ...original, title: '주간 회의 (변경)' } });
  assert.equal(same.unchanged, true, 'nothing changed: nothing is sent');
  assert.equal(srv.requests.filter((r) => r.method === 'PUT').length, 1);
});

test('edit conflicts: changed elsewhere since it was shown, or 412 on PUT; deleted elsewhere', async () => {
  const srv = memServer({ initial: { [`${CAL}evt-1.ics`]: { etag: 'e1', ics: SERVER_DOC } } });
  const comps = await cached(srv);
  const original = componentFields(comps[0]);
  srv.store.set(`${CAL}evt-1.ics`, { etag: 'e2', ics: SERVER_DOC.replace('주간 회의', '다른 기기에서 바꿈') });
  await assert.rejects(run(srv, { op: 'edit', uid: 'evt-1', components: comps, fields: { ...original, title: 'x' } }), (e) => e.code === 'conflict' && /다른 곳/.test(e.message));
  assert.ok(!srv.requests.some((r) => r.method === 'PUT'), 'no write after a conflict');

  // The ETag check passes but the resource changes before the PUT lands: the server's 412.
  const racing = memServer({ initial: { [`${CAL}evt-1.ics`]: { etag: 'e1', ics: SERVER_DOC } } });
  const comps2 = await cached(racing);
  const inner = racing.fetch;
  racing.fetch = async (url, opts) => (opts.method === 'PUT' ? { status: 412, headers: { get: () => null }, body: null, text: async () => '' } : inner(url, opts));
  await assert.rejects(writeEvent({ op: 'edit', source: account, calendarId: CAL, uid: 'evt-1', components: comps2, fields: { ...original, title: 'y' }, password: 'pw', fetch: racing.fetch, now: NOW }), (e) => e.code === 'conflict');

  srv.store.delete(`${CAL}evt-1.ics`);
  await assert.rejects(run(srv, { op: 'edit', uid: 'evt-1', components: comps, fields: { ...original, title: 'z' } }), (e) => e.code === 'gone');
});

test('delete: If-Match, confirmed when the listing no longer has it; not confirmed when it is still there', async () => {
  const srv = memServer({ initial: { [`${CAL}evt-1.ics`]: { etag: 'e1', ics: SERVER_DOC } } });
  const res = await run(srv, { op: 'delete', uid: 'evt-1', components: await cached(srv) });
  assert.equal(res.applied, true);
  assert.equal(srv.requests.find((r) => r.method === 'DELETE').ifMatch, '"e1"');
  assert.equal(srv.store.size, 0);

  const dropping = memServer({ dropWrites: true, initial: { [`${CAL}evt-1.ics`]: { etag: 'e1', ics: SERVER_DOC } } });
  assert.equal((await run(dropping, { op: 'delete', uid: 'evt-1', components: await cached(dropping) })).applied, false);
  const stale = memServer({ initial: { [`${CAL}evt-1.ics`]: { etag: 'e1', ics: SERVER_DOC } } });
  const comps = await cached(stale);
  stale.store.set(`${CAL}evt-1.ics`, { etag: 'e9', ics: SERVER_DOC });
  await assert.rejects(run(stale, { op: 'delete', uid: 'evt-1', components: comps }), (e) => e.code === 'conflict');
  assert.equal(stale.store.size, 1);
});

test('no unconditional writes, and no writes to another host', async () => {
  const c = new CalDavClient({ username: 'u', password: 'p', fetch: async () => assert.fail('must not send') });
  await assert.rejects(c.putResource(`${CAL}x.ics`, 'x'), (e) => e.code === 'unconditional');
  await assert.rejects(c.deleteResource(`${CAL}x.ics`), (e) => e.code === 'unconditional');
  const srv = memServer();
  const foreign = [{ uid: 'a', href: 'https://evil.example.net/a.ics', etag: 'e', rrule: null, rdates: [], recurrenceId: null, start: { allDay: true, date: '2026-10-20' }, end: null, duration: null, title: 'a', location: '', description: '' }];
  await assert.rejects(run(srv, { op: 'delete', uid: 'a', components: foreign }), (e) => e.code === 'untrusted');
  assert.equal(srv.requests.length, 0);
});
