// --mock-data (#61): fictional calendars so themes can be built and tried without any account. A CalDAV account
// with two writable calendars and an ICS feed, served by an in-memory server that behaves like the real ones
// the widget talks to (ETags, If-Match / If-None-Match, calendar-query listing), so reading, the editor and the
// background writes (#48, #63) all run their real code paths. Nothing leaves the process.
const BASE = 'https://mock.desk-widgets.invalid';
const WORK = `${BASE}/cal/work/`;
const PERSONAL = `${BASE}/cal/personal/`;
const HOLIDAYS = `${BASE}/holidays.ics`;
const PASSWORD = 'mock';

const MOCK_SOURCES = [
  {
    id: 'mock-account',
    type: 'caldav',
    name: '예시 계정',
    provider: 'other',
    server: `${BASE}/`,
    username: 'me@example.com',
    color: '#4f8cff',
    enabled: true,
    calendars: [
      { id: WORK, name: '업무', color: '#4f8cff', enabled: true, canWrite: true },
      { id: PERSONAL, name: '개인', color: '#3ccf8e', enabled: true, canWrite: true },
    ],
  },
  { id: 'mock-holidays', type: 'ics', name: '예시 공휴일 (읽기 전용)', url: HOLIDAYS, color: '#ff6b6b', enabled: true },
];

const pad = (n) => String(n).padStart(2, '0');
/** Local day `offset` days from `now`, at hour:minute, as an iCalendar UTC time. */
function at(now, offset, hour, minute = 0) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
/** Local day `offset` days from `now` as an iCalendar DATE. */
function day(now, offset) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
const doc = (uid, lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mock//KO', 'BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

/** The sample events, relative to `now`: timed, all-day, multi-day, overnight, recurring, someone else's meeting. */
function seed(now) {
  return {
    [WORK]: {
      'standup.ics': doc('mock-standup', [`DTSTART:${at(now, -14, 9, 30)}`, 'DURATION:PT15M', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR', 'SUMMARY:주간 스탠드업 (반복)']),
      'review.ics': doc('mock-review', [`DTSTART:${at(now, 0, 14)}`, `DTEND:${at(now, 0, 15, 30)}`, 'SUMMARY:디자인 검토', 'LOCATION:3층 회의실', 'DESCRIPTION:테마 시안 두 가지를 비교합니다.', 'URL:https://example.com/meetings/review']),
      'client.ics': doc('mock-client', [`DTSTART:${at(now, 1, 10)}`, `DTEND:${at(now, 1, 11)}`, 'SUMMARY:고객사 통화', 'ORGANIZER:mailto:boss@example.com', 'ATTENDEE:mailto:me@example.com']),
      'trip.ics': doc('mock-trip', [`DTSTART;VALUE=DATE:${day(now, 5)}`, `DTEND;VALUE=DATE:${day(now, 8)}`, 'SUMMARY:부산 출장']),
      'release.ics': doc('mock-release', [`DTSTART:${at(now, 2, 22)}`, `DTEND:${at(now, 3, 2)}`, 'SUMMARY:야간 배포']),
      'lunch.ics': doc('mock-lunch', [`DTSTART:${at(now, 2, 12)}`, `DTEND:${at(now, 2, 13)}`, 'SUMMARY:팀 점심']),
    },
    [PERSONAL]: {
      'gym.ics': doc('mock-gym', [`DTSTART:${at(now, -3, 19)}`, 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH', 'SUMMARY:운동 (반복)']),
      'dentist.ics': doc('mock-dentist', [`DTSTART:${at(now, 3, 17)}`, `DTEND:${at(now, 3, 18)}`, 'SUMMARY:치과', 'LOCATION:역 앞 치과']),
      'birthday.ics': doc('mock-birthday', [`DTSTART;VALUE=DATE:${day(now, 9)}`, 'RRULE:FREQ=YEARLY', 'SUMMARY:친구 생일']),
      'vacation.ics': doc('mock-vacation', [`DTSTART;VALUE=DATE:${day(now, 12)}`, `DTEND;VALUE=DATE:${day(now, 15)}`, 'SUMMARY:휴가']),
    },
  };
}

function holidays(now) {
  const events = [
    [4, '예시 기념일'],
    [20, '예시 공휴일'],
  ].map(([offset, title], i) => ['BEGIN:VEVENT', `UID:mock-holiday-${i}`, `DTSTART;VALUE=DATE:${day(now, offset)}`, `SUMMARY:${title}`, 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:예시 공휴일', ...events, 'END:VCALENDAR'].join('\r\n');
}

/** A fetch() over the in-memory server. */
function createMockFetch(now = new Date()) {
  const calendars = seed(now);
  const store = new Map();
  for (const [cal, files] of Object.entries(calendars)) for (const [name, ics] of Object.entries(files)) store.set(`${cal}${name}`, { etag: `e${store.size + 1}`, ics });
  let version = 100;
  const reply = (status, body = '', headers = {}) => {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, body: null, text: async () => body };
  };
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const headers = opts.headers || {};
    // Small delay so the "저장 중…" state is visible while developing a theme.
    await new Promise((r) => setTimeout(r, method === 'PUT' || method === 'DELETE' ? 600 : 50));
    if (url === HOLIDAYS) return reply(200, holidays(now), { 'Content-Type': 'text/calendar' });
    if (method === 'PROPFIND') return reply(404);
    if (method === 'REPORT') {
      const items = [...store]
        .filter(([href]) => href.startsWith(url))
        .map(([href, r]) => `<d:response><d:href>${new URL(href).pathname}</d:href><d:propstat><d:prop><d:getetag>"${r.etag}"</d:getetag><c:calendar-data><![CDATA[${r.ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
      return reply(207, `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${items.join('')}</d:multistatus>`);
    }
    const res = store.get(url);
    if (method === 'GET') return res ? reply(200, res.ics, { ETag: `"${res.etag}"` }) : reply(404);
    if (method === 'PUT') {
      if (headers['If-None-Match'] === '*' && res) return reply(412);
      if (headers['If-Match'] && (!res || headers['If-Match'] !== `"${res.etag}"`)) return reply(412);
      const etag = `v${++version}`;
      store.set(url, { etag, ics: String(opts.body || '') });
      return reply(res ? 204 : 201, '', { ETag: `"${etag}"` });
    }
    if (method === 'DELETE') {
      if (!res) return reply(404);
      if (headers['If-Match'] !== `"${res.etag}"`) return reply(412);
      store.delete(url);
      return reply(204);
    }
    return reply(405);
  };
}

module.exports = { MOCK_SOURCES, MOCK_PASSWORD: PASSWORD, createMockFetch, BASE: BASE };
