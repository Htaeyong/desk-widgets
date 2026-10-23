// iCalendar parsing and RRULE expansion. Expected local times are checked in fixed zones
// (Asia/Seoul, America/New_York, UTC) so the results do not depend on the PC's own zone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { unfold, parseLine, parseIcs, parseDuration, occurrences, plainText } = require('../lib/ical');
const { parseRrule } = require('../lib/rrule');
const { resolveZone, wallToUtc } = require('../lib/tz');

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:테스트', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const utc = (s) => Date.parse(s);
const startsOf = (list) => list.map((e) => e.start).sort();

/** Normalized events of a document in [from, to) (ISO strings). */
const expand = (text, from, to) => occurrences(parseIcs(text).events, utc(from), utc(to), { sourceId: 's1', calendarId: 'default' });

test('folded lines are joined and quoted parameters keep their colons', () => {
  assert.deepEqual(unfold('SUMMARY:Long\r\n  title\r\n\t end\r\nUID:1'), ['SUMMARY:Long title end', 'UID:1']);
  const p = parseLine('DTSTART;TZID="Custom: Zone";VALUE=DATE-TIME:20261018T090000');
  assert.equal(p.name, 'DTSTART');
  assert.equal(p.params.TZID, 'Custom: Zone');
  assert.equal(p.params.VALUE, 'DATE-TIME');
  assert.equal(p.value, '20261018T090000');
});

test('text values are unescaped, the calendar name is read and HTML descriptions become text', () => {
  const doc = parseIcs(
    ics(
      vevent('UID:a', 'DTSTART:20261018T000000Z', 'SUMMARY:회의\\, 1차\\; 준비', 'DESCRIPTION:첫 줄\\n둘째 줄', 'LOCATION:3층 \\\\ 회의실', 'URL:https://example.com/e/1'),
      vevent('UID:b', 'DTSTART:20261018T000000Z', 'DESCRIPTION:<p>안녕 &amp; <b>하세요</b></p><br>끝', 'URL:javascript:alert(1)'),
    ),
  );
  assert.equal(doc.name, '테스트');
  const [a, b] = doc.events;
  assert.equal(a.title, '회의, 1차; 준비');
  assert.equal(a.description, '첫 줄\n둘째 줄');
  assert.equal(a.location, '3층 \\ 회의실');
  assert.equal(a.url, 'https://example.com/e/1');
  assert.equal(b.description, '안녕 & 하세요\n\n끝');
  assert.equal(b.url, '', 'only http(s) links are kept');
  assert.equal(plainText('a\u0001b'), 'ab');
});

test('all-day events: DATE values, exclusive end, default one day', () => {
  const list = expand(
    ics(
      vevent('UID:d1', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261023', 'SUMMARY:출장'),
      vevent('UID:d2', 'DTSTART;VALUE=DATE:20261025', 'SUMMARY:하루'),
      vevent('UID:d3', 'DTSTART;VALUE=DATE:20261026', 'DURATION:P2D', 'SUMMARY:이틀'),
    ),
    '2026-10-01T00:00:00Z',
    '2026-11-01T00:00:00Z',
  );
  const by = Object.fromEntries(list.map((e) => [e.uid, e]));
  assert.deepEqual([by.d1.allDay, by.d1.start, by.d1.end], [true, '2026-10-20', '2026-10-23']);
  assert.deepEqual([by.d2.start, by.d2.end], ['2026-10-25', '2026-10-26']);
  assert.deepEqual([by.d3.start, by.d3.end], ['2026-10-26', '2026-10-28']);
});

test('UTC, TZID (IANA, Windows name, prefixed) and duration give the right instants', () => {
  const list = expand(
    ics(
      vevent('UID:z', 'DTSTART:20261018T010000Z', 'DTEND:20261018T020000Z'),
      vevent('UID:seoul', 'DTSTART;TZID=Asia/Seoul:20261018T090000', 'DTEND;TZID=Asia/Seoul:20261018T103000'),
      vevent('UID:win', 'DTSTART;TZID=Korea Standard Time:20261018T090000', 'DURATION:PT45M'),
      vevent('UID:moz', 'DTSTART;TZID=/mozilla.org/20050126_1/America/New_York:20261018T090000', 'DURATION:PT1H'),
      vevent('UID:ny-winter', 'DTSTART;TZID="America/New_York":20261218T090000'),
    ),
    '2026-10-01T00:00:00Z',
    '2027-01-01T00:00:00Z',
  );
  const by = Object.fromEntries(list.map((e) => [e.uid, e]));
  assert.deepEqual([by.z.start, by.z.end], ['2026-10-18T01:00:00Z', '2026-10-18T02:00:00Z']);
  assert.deepEqual([by.seoul.start, by.seoul.end], ['2026-10-18T00:00:00Z', '2026-10-18T01:30:00Z']);
  assert.deepEqual([by.win.start, by.win.end], ['2026-10-18T00:00:00Z', '2026-10-18T00:45:00Z']);
  assert.equal(by.moz.start, '2026-10-18T13:00:00Z', 'EDT is UTC-4');
  assert.equal(by['ny-winter'].start, '2026-12-18T14:00:00Z', 'EST is UTC-5');
  assert.equal(by['ny-winter'].end, by['ny-winter'].start, 'no DTEND and no DURATION: zero length');
});

test('a TZID only described by its VTIMEZONE falls back to that zone', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE',
    'TZID:(UTC+09:00) 서울',
    'BEGIN:STANDARD',
    'DTSTART:16010101T000000',
    'TZOFFSETFROM:+0900',
    'TZOFFSETTO:+0900',
    'END:STANDARD',
    'END:VTIMEZONE',
    ...vevent('UID:x', 'DTSTART;TZID="(UTC+09:00) 서울":20261018T090000'),
    'END:VCALENDAR',
  ].join('\n');
  const [e] = expand(text, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  assert.equal(e.start, '2026-10-18T00:00:00Z');
  assert.deepEqual(resolveZone('Nowhere/Unknown'), null, 'unknown zones are floating (PC local time)');
  assert.deepEqual(resolveZone('Korea Standard Time'), { iana: 'Asia/Seoul' });
});

test('DST: wall times keep their local hour across the change', () => {
  // America/New_York switched to EST on 2026-11-01.
  assert.equal(new Date(wallToUtc({ y: 2026, m: 10, d: 31, h: 9 }, { iana: 'America/New_York' })).toISOString(), '2026-10-31T13:00:00.000Z');
  assert.equal(new Date(wallToUtc({ y: 2026, m: 11, d: 2, h: 9 }, { iana: 'America/New_York' })).toISOString(), '2026-11-02T14:00:00.000Z');
  const list = expand(
    ics(vevent('UID:w', 'DTSTART;TZID=America/New_York:20261030T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=4')),
    '2026-10-01T00:00:00Z',
    '2026-12-01T00:00:00Z',
  );
  assert.deepEqual(startsOf(list), ['2026-10-30T13:00:00Z', '2026-10-31T13:00:00Z', '2026-11-01T14:00:00Z', '2026-11-02T14:00:00Z']);
});

test('RRULE parsing', () => {
  const r = parseRrule('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR,2MO;BYMONTHDAY=-1;COUNT=5;WKST=SU');
  assert.equal(r.freq, 'MONTHLY');
  assert.equal(r.interval, 2);
  assert.deepEqual(r.byday, [
    { n: -1, wd: 5 },
    { n: 2, wd: 1 },
  ]);
  assert.deepEqual(r.bymonthday, [-1]);
  assert.equal(r.count, 5);
  assert.equal(r.wkst, 0);
  assert.equal(parseRrule('FREQ=SECONDLY'), null);
  assert.equal(parseRrule(''), null);
  assert.deepEqual(parseDuration('P1W'), { days: 7, ms: 0 });
  assert.deepEqual(parseDuration('-PT15M'), { days: -0, ms: -900000 });
});

test('weekly BYDAY with INTERVAL and UNTIL', () => {
  const list = expand(
    ics(vevent('UID:wk', 'DTSTART;TZID=Asia/Seoul:20261005T100000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261031T000000Z')),
    '2026-10-01T00:00:00Z',
    '2026-12-01T00:00:00Z',
  );
  // Mondays/Wednesdays every other week from Mon 10-05: 5, 7, 19, 21 (11-02 is past UNTIL).
  assert.deepEqual(startsOf(list), ['2026-10-05T01:00:00Z', '2026-10-07T01:00:00Z', '2026-10-19T01:00:00Z', '2026-10-21T01:00:00Z']);
  assert.ok(list.every((e) => e.recurrenceId), 'instances of a series carry their recurrence key');
});

test('monthly last Friday (-1FR) and second Monday (2MO), COUNT', () => {
  const lastFri = expand(ics(vevent('UID:m', 'DTSTART;VALUE=DATE:20260130', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4')), '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
  assert.deepEqual(startsOf(lastFri), ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']);
  const secondMon = expand(ics(vevent('UID:m2', 'DTSTART;VALUE=DATE:20261012', 'RRULE:FREQ=MONTHLY;BYDAY=2MO')), '2026-10-01T00:00:00Z', '2027-01-01T00:00:00Z');
  assert.deepEqual(startsOf(secondMon), ['2026-10-12', '2026-11-09', '2026-12-14']);
});

test('monthly BYMONTHDAY skips months without that day; -1 is the last day', () => {
  const d31 = expand(ics(vevent('UID:a', 'DTSTART;VALUE=DATE:20260131', 'RRULE:FREQ=MONTHLY;COUNT=4')), '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
  assert.deepEqual(startsOf(d31), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  const last = expand(ics(vevent('UID:b', 'DTSTART;VALUE=DATE:20260131', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3')), '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
  assert.deepEqual(startsOf(last), ['2026-01-31', '2026-02-28', '2026-03-31']);
});

test('yearly with BYMONTH and BYDAY (Thanksgiving), and a plain birthday', () => {
  const tg = expand(ics(vevent('UID:t', 'DTSTART;VALUE=DATE:20251127', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH')), '2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z');
  assert.deepEqual(startsOf(tg), ['2026-11-26', '2027-11-25']);
  const bd = expand(ics(vevent('UID:b', 'DTSTART;VALUE=DATE:19900315', 'RRULE:FREQ=YEARLY')), '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
  assert.deepEqual(startsOf(bd), ['2026-03-15']);
});

test('a long-running daily series is expanded only for the asked range', () => {
  const list = expand(ics(vevent('UID:d', 'DTSTART:20000101T090000Z', 'DURATION:PT30M', 'RRULE:FREQ=DAILY')), '2026-10-18T00:00:00Z', '2026-10-21T00:00:00Z');
  assert.deepEqual(startsOf(list), ['2026-10-18T09:00:00Z', '2026-10-19T09:00:00Z', '2026-10-20T09:00:00Z']);
});

test('COUNT counts from DTSTART even when the range starts later', () => {
  const list = expand(ics(vevent('UID:c', 'DTSTART:20261001T090000Z', 'RRULE:FREQ=DAILY;COUNT=5')), '2026-10-04T00:00:00Z', '2026-10-31T00:00:00Z');
  assert.deepEqual(startsOf(list), ['2026-10-04T09:00:00Z', '2026-10-05T09:00:00Z']);
});

test('EXDATE removes instances (in its own zone, or by date for all-day)', () => {
  const timed = expand(
    ics(
      vevent(
        'UID:e',
        'DTSTART;TZID=Asia/Seoul:20261019T090000',
        'RRULE:FREQ=DAILY;COUNT=5',
        'EXDATE;TZID=Asia/Seoul:20261020T090000,20261022T090000',
        'EXDATE:20261021T000000Z',
      ),
    ),
    '2026-10-01T00:00:00Z',
    '2026-11-01T00:00:00Z',
  );
  assert.deepEqual(startsOf(timed), ['2026-10-19T00:00:00Z', '2026-10-23T00:00:00Z']);
  const allDay = expand(ics(vevent('UID:f', 'DTSTART;VALUE=DATE:20261019', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20261020')), '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  assert.deepEqual(startsOf(allDay), ['2026-10-19', '2026-10-21']);
});

test('RECURRENCE-ID overrides replace an instance, even when moved out of or into the range', () => {
  const text = ics(
    vevent('UID:r', 'DTSTART;TZID=Asia/Seoul:20261019T090000', 'DTEND;TZID=Asia/Seoul:20261019T100000', 'SUMMARY:주간 회의', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    vevent('UID:r', 'RECURRENCE-ID;TZID=Asia/Seoul:20261026T090000', 'DTSTART;TZID=Asia/Seoul:20261027T140000', 'DTEND;TZID=Asia/Seoul:20261027T150000', 'SUMMARY:주간 회의 (변경)'),
    vevent('UID:r', 'RECURRENCE-ID;TZID=Asia/Seoul:20261102T090000', 'DTSTART;TZID=Asia/Seoul:20261102T090000', 'STATUS:CANCELLED'),
  );
  const list = expand(text, '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z');
  assert.deepEqual(
    list.map((e) => [e.start, e.title]).sort(),
    [
      ['2026-10-19T00:00:00Z', '주간 회의'],
      ['2026-10-27T05:00:00Z', '주간 회의 (변경)'],
    ],
  );
  // Only the week of the moved instance: the original slot (10-26) stays empty.
  const week = expand(text, '2026-10-25T15:00:00Z', '2026-10-26T15:00:00Z');
  assert.deepEqual(week, []);
});

test('cancelled events are dropped and duplicate UIDs are all kept', () => {
  const list = expand(
    ics(
      vevent('UID:x', 'DTSTART:20261018T010000Z', 'STATUS:CANCELLED'),
      vevent('UID:dup', 'DTSTART:20261018T010000Z', 'SUMMARY:하나'),
      vevent('UID:dup', 'DTSTART:20261019T010000Z', 'SUMMARY:둘'),
      vevent('UID:nostart', 'SUMMARY:시작 없음'),
    ),
    '2026-10-01T00:00:00Z',
    '2026-11-01T00:00:00Z',
  );
  assert.deepEqual(list.map((e) => e.title).sort(), ['둘', '하나']);
});

test('events overlapping the range edges are included; events outside are not', () => {
  const text = ics(
    vevent('UID:before', 'DTSTART:20261017T230000Z', 'DTEND:20261018T010000Z'),
    vevent('UID:after', 'DTSTART:20261019T000000Z', 'DTEND:20261019T010000Z'),
    vevent('UID:ended', 'DTSTART:20261017T200000Z', 'DTEND:20261018T000000Z'),
  );
  const list = expand(text, '2026-10-18T00:00:00Z', '2026-10-19T00:00:00Z');
  assert.deepEqual(list.map((e) => e.uid), ['before']);
});

test('normalized events have the shared shape and are read-only', () => {
  const [e] = expand(ics(vevent('UID:n', 'DTSTART:20261018T010000Z', 'SUMMARY:모양')), '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
  assert.deepEqual(Object.keys(e).sort(), ['allDay', 'calendarId', 'description', 'end', 'location', 'readOnly', 'recurrenceId', 'sourceId', 'start', 'title', 'uid', 'url'].sort());
  assert.equal(e.readOnly, true);
  assert.equal(e.sourceId, 's1');
  assert.equal(e.recurrenceId, null);
});
