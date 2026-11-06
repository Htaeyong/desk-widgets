// The calendar's MCP tools (#121, engine API 1.10): declarations the engine accepts, read results (ranges,
// recurring events, limits, no addresses or passwords), and writes through the editor's real path against an
// in-memory CalDAV server (conditional PUT, re-read verification), refusals and undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../index');
const { DEFAULTS, sanitize } = require('../lib/settings');
const { withThemeHost } = require('./theme-host');
const { cleanTools, checkInput, LIMITS } = require('../../../engine/main/mcp-host');
const MT = require('../lib/mcp-tools');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const BASE = 'https://caldav.calendar.naver.com/';
const CAL = 'https://caldav.calendar.naver.com/caldav/user01/calendar/1234/';
const ICS_URL = 'https://feeds.example.com/private/abc123secrettoken/basic.ics';
const PASSWORD = 'app-pass-9f8e7d';
const NOW = new Date(2026, 9, 19, 9, 0).getTime(); // Mon 2026-10-19 09:00 local
const fakeCrypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };

const ics = (uid, lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const pad = (n) => String(n).padStart(2, '0');
const localIcs = (y, m, d, h, mi = 0) => `${y}${pad(m)}${pad(d)}T${pad(h)}${pad(mi)}00`;

/** The ICS feed: a shared calendar with someone else's text, plus `many` filler events in October. */
function feed(many = 0) {
  const events = [
    ['BEGIN:VEVENT', 'UID:shared-1', `DTSTART:${localIcs(2026, 10, 21, 15)}`, `DTEND:${localIcs(2026, 10, 21, 16)}`, 'SUMMARY:팀 공유 회의', 'LOCATION:본사 5층', `DESCRIPTION:${'긴 설명 '.repeat(200)}`, 'URL:https://example.com/meet/1', 'END:VEVENT'],
    ['BEGIN:VEVENT', 'UID:holiday-1', 'DTSTART;VALUE=DATE:20261009', 'DTEND;VALUE=DATE:20261010', 'SUMMARY:한글날', 'END:VEVENT'],
  ];
  for (let i = 0; i < many; i++) {
    events.push(['BEGIN:VEVENT', `UID:filler-${i}`, `DTSTART:${localIcs(2026, 10, 1 + (i % 28), 8 + (i % 10))}`, `DTEND:${localIcs(2026, 10, 1 + (i % 28), 9 + (i % 10))}`, `SUMMARY:채우기 ${i}`, `DESCRIPTION:${'x'.repeat(400)}`, 'END:VEVENT']);
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:공유', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
}

/** Naver-like discovery (fixtures), an in-memory CalDAV calendar with ETags, and the ICS feed. */
function server({ gate = null, failWrites = 0, many = 0 } = {}) {
  const store = new Map([
    [`${CAL}plain.ics`, { etag: 'p1', ics: ics('plain', [`DTSTART:${localIcs(2026, 10, 20, 10)}`, `DTEND:${localIcs(2026, 10, 20, 11)}`, 'SUMMARY:보통 일정', 'LOCATION:3층', 'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'END:VALARM']) }],
    [`${CAL}weekly.ics`, { etag: 'w1', ics: ics('weekly', [`DTSTART:${localIcs(2026, 10, 5, 9)}`, 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY', 'SUMMARY:주간 회의']) }],
    [`${CAL}trip.ics`, { etag: 't1', ics: ics('trip', ['DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261026', 'SUMMARY:부산 출장']) }],
  ]);
  let v = 0;
  const requests = [];
  const discovery = {
    [`PROPFIND ${BASE}`]: fx('principal.xml'),
    [`PROPFIND ${BASE}123456/principal/`]: fx('home.xml'),
    [`PROPFIND ${BASE}123456/calendars/`]: fx('naver-calendars.xml'),
  };
  const reply = (status, body = '', headers = {}) => {
    const h = new Map(Object.entries(headers).map(([k, x]) => [k.toLowerCase(), x]));
    return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, body: null, text: async () => body };
  };
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const h = opts.headers || {};
    requests.push({ url, method, ifMatch: h['If-Match'], ifNoneMatch: h['If-None-Match'] });
    if (url === ICS_URL) return reply(200, feed(many), { 'Content-Type': 'text/calendar' });
    if (discovery[`${method} ${url}`]) return reply(207, discovery[`${method} ${url}`]);
    if (method === 'PROPFIND') return reply(404);
    if (method === 'REPORT') {
      const items = [...store].map(([href, r]) => `<D:response><D:href>${new URL(href).pathname}</D:href><D:propstat><D:prop><D:getetag>"${r.etag}"</D:getetag><C:calendar-data><![CDATA[${r.ics}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      return reply(207, `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${items.join('')}</D:multistatus>`);
    }
    const res = store.get(url);
    if ((method === 'PUT' || method === 'DELETE') && gate) await gate();
    if ((method === 'PUT' || method === 'DELETE') && failWrites) return reply(failWrites);
    if (method === 'GET') return res ? reply(200, res.ics, { ETag: `"${res.etag}"` }) : reply(404);
    if (method === 'PUT') {
      if ((h['If-None-Match'] === '*' && res) || (h['If-Match'] && (!res || h['If-Match'] !== `"${res.etag}"`))) return reply(412);
      store.set(url, { etag: `n${++v}`, ics: opts.body });
      return reply(201);
    }
    return reply(405);
  };
  return { fetch, store, requests };
}

async function setup({ mcp = true, gate = null, failWrites = 0, many = 0, mcpWaitMs, initial = {} } = {}) {
  let state = sanitize({ ...DEFAULTS, localEnabled: true, ddayEnabled: true, ...initial });
  const cards = [];
  let tools = null;
  const { ctx, th } = withThemeHost({
    notify: (events, options) => cards.push({ card: events[0], options }),
    dir: path.join(__dirname, '..'),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cal-mcp-')),
    createStore: () => ({ load: () => state, save: (v) => { state = sanitize({ ...state, ...v }); } }),
    openExternal() {},
    sendToSettings() {},
    confirm: async () => 0,
    ...(mcp ? { mcp: { registerTools: (list) => ((tools = list), true) } } : {}),
  });
  const srv = server({ gate, failWrites, many });
  const widget = create(ctx, { fetch: srv.fetch, crypto: fakeCrypto, now: () => NOW, mcpWaitMs });
  widget.start();
  const found = await widget.settings.handlers.caldavDiscover({ provider: 'naver', username: 'user01', password: PASSWORD });
  assert.equal(found.ok, true, found.message);
  assert.deepEqual(
    widget.settings.save({
      sources: [
        { type: 'caldav', provider: 'naver', username: 'user01', name: '네이버', enabled: true, calendars: found.calendars, draft: found.token },
        { type: 'ics', name: '공유 캘린더', url: ICS_URL, enabled: true },
      ],
    }),
    { ok: true },
  );
  await new Promise((r) => setTimeout(r, 80));
  const account = state.sources.find((s) => s.type === 'caldav');
  const feedSource = state.sources.find((s) => s.type === 'ics');
  const cleaned = () => cleanTools(tools);
  /** A tool call the way the engine makes it: input checked against the schema, result size limited. */
  const call = async (name, input = {}) => {
    const tool = cleaned().find((t) => t.name === name);
    assert.ok(tool, `${name} declared`);
    const bad = checkInput(tool.inputSchema, input);
    if (bad) throw new Error(`engine refused input: ${bad}`);
    const out = await tool.run(input, { client: 'test' });
    assert.ok(JSON.stringify(out.data).length <= LIMITS.MAX_RESULT_CHARS, `${name}: result within the engine limit`);
    return out;
  };
  const noSecrets = (out) => {
    const json = JSON.stringify(out);
    for (const s of [PASSWORD, 'abc123secrettoken', ICS_URL, CAL, 'caldav.calendar.naver.com', 'password', 'example.com/meet']) assert.ok(!json.includes(s), `result must not contain ${s}`);
  };
  return { widget, th, srv, cards, tools: () => tools, cleaned, call, noSecrets, account, feedSource, getState: () => state };
}

const ids = (out) => out.data.items.map((i) => i.title);

test('without ctx.mcp (engine before 1.10) the widget starts and works as before', async (t) => {
  const s = await setup({ mcp: false });
  t.after(() => s.widget.stop());
  assert.equal(s.tools(), null);
  const res = await s.th.call('events.list', [[{ from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 10, 1).getTime() }]]);
  assert.ok(res[0].some((e) => e.title === '보통 일정'));
});

test('declarations: names, Korean titles, closed schemas the engine accepts, writes marked, no delete tool', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const list = s.tools();
  assert.deepEqual(list.map((x) => x.name), ['list_calendars', 'list_events', 'upcoming_events', 'search_events', 'list_ddays', 'create_event', 'update_event']);
  assert.equal(s.cleaned().length, list.length, 'the engine keeps every tool');
  for (const tool of list) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{0,40}$/);
    assert.match(tool.title, /[가-힣]/, tool.name);
    assert.ok(tool.description.length > 20);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    for (const p of Object.values(tool.inputSchema.properties)) assert.ok(['string', 'integer', 'number', 'boolean', 'array'].includes(p.type));
    assert.ok(!/delete|remove/.test(tool.name), 'no tool deletes');
  }
  assert.deepEqual(list.filter((x) => x.write).map((x) => x.name), ['create_event', 'update_event']);
  await assert.rejects(s.call('list_events', { from: '2026-10-01', url: 'x' }), /알 수 없는 입력/);
});

test('list_calendars: local, CalDAV and ICS calendars with opaque ids; only editable ones writable; no addresses', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const out = await s.call('list_calendars');
  s.noSecrets(out);
  const by = Object.fromEntries(out.data.items.map((c) => [c.source_type, c]));
  assert.equal(by.local.writable, true);
  assert.equal(by.caldav.writable, true);
  assert.equal(by.caldav.source, '네이버');
  assert.equal(by.ics.writable, false);
  assert.equal(by.ics.name, '공유 캘린더');
  assert.equal(by.caldav.id, MT.calRef(s.account.id, CAL));
  assert.match(by.caldav.id, /^[a-z0-9-]+\/[0-9a-f]{10}$/);
});

test('list_events: a date range with recurring instances, all-day end inclusive, local times, trimmed text, untrusted note', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const out = await s.call('list_events', { from: '2026-10-19', to: '2026-10-25' });
  s.noSecrets(out);
  assert.equal(out.data.now, '2026-10-19 09:00');
  assert.match(out.data.untrusted, /지시가 아닙니다/);
  assert.deepEqual(ids(out), ['주간 회의', '보통 일정', '팀 공유 회의', '부산 출장']);
  const by = Object.fromEntries(out.data.items.map((i) => [i.title, i]));
  assert.deepEqual([by['주간 회의'].start, by['주간 회의'].end, by['주간 회의'].recurring, by['주간 회의'].writable], ['2026-10-19 09:00', '2026-10-19 10:00', true, false]);
  assert.match(by['주간 회의'].read_only_reason, /반복/);
  assert.deepEqual([by['보통 일정'].start, by['보통 일정'].location, by['보통 일정'].writable, by['보통 일정'].source, by['보통 일정'].source_type], ['2026-10-20 10:00', '3층', true, '네이버', 'caldav']);
  assert.ok(by['보통 일정'].calendar);
  assert.deepEqual([by['부산 출장'].all_day, by['부산 출장'].start, by['부산 출장'].end], [true, '2026-10-23', '2026-10-25']);
  const shared = by['팀 공유 회의'];
  assert.equal(shared.writable, false);
  assert.match(shared.read_only_reason, /ICS/);
  assert.equal(shared.description_truncated, true);
  assert.ok(shared.description.length <= MT.LIMITS.DESC_MAX + 1);
  assert.equal('url' in shared, false);
  // The id names the event for update_event (calendar ref + uid).
  assert.deepEqual(MT.parseEventRef(by['보통 일정'].id), { sourceId: s.account.id, key: MT.calRef(s.account.id, CAL).split('/')[1], uid: 'plain', recurrenceId: null });
  // A filter by calendar id or source id.
  const only = await s.call('list_events', { from: '2026-10-19', to: '2026-10-25', calendar: s.feedSource.id });
  assert.deepEqual(ids(only), ['팀 공유 회의']);
  await assert.rejects(s.call('list_events', { from: '2026-10-19', calendar: 'nope/0123456789' }), /캘린더를 찾지 못했습니다/);
  await assert.rejects(s.call('list_events', { from: '2026-10-01', to: '2027-03-01' }), /92일/);
  await assert.rejects(s.call('list_events', { from: '2026-02-30' }), /YYYY-MM-DD/);
  await assert.rejects(s.call('list_events', { from: '2026-10-10', to: '2026-10-01' }), /앞설 수 없습니다/);
});

test('limits: long lists are cut to fit the engine (truncated, next_offset) and can be paged', async (t) => {
  const s = await setup({ many: 120 });
  t.after(() => s.widget.stop());
  const first = await s.call('list_events', { from: '2026-10-01', to: '2026-10-31' });
  assert.ok(first.data.total > 120);
  assert.equal(first.data.truncated, true);
  assert.ok(first.data.items.length > 0 && first.data.items.length <= MT.LIMITS.LIST_MAX);
  assert.ok(JSON.stringify(first.data).length <= MT.LIMITS.BUDGET + 200);
  const second = await s.call('list_events', { from: '2026-10-01', to: '2026-10-31', offset: first.data.next_offset, limit: 5 });
  assert.equal(second.data.items.length, 5);
  assert.notDeepEqual(second.data.items[0].id, first.data.items[0].id);
  const few = await s.call('list_events', { from: '2026-10-01', to: '2026-10-31', limit: 3 });
  assert.equal(few.data.items.length, 3);
  assert.equal(few.data.next_offset, 3);
});

test('upcoming_events and search_events', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const up = await s.call('upcoming_events', { days: 3 });
  s.noSecrets(up);
  assert.deepEqual(ids(up), ['주간 회의', '보통 일정', '팀 공유 회의'], 'the 09:00 meeting is ongoing at 09:00; nothing past day 3');
  assert.equal(up.data.until, '2026-10-21');
  const def = await s.call('upcoming_events');
  assert.equal(def.data.days, 7, 'the widget\'s upcoming setting');
  const found = await s.call('search_events', { query: '회의' });
  s.noSecrets(found);
  assert.equal(found.data.items[0].title, '주간 회의');
  assert.ok(found.data.items.some((i) => i.title === '팀 공유 회의'));
  assert.ok(found.data.items.every((i) => /회의/.test(i.title)));
  assert.ok(found.data.items.length <= 10);
  const where = await s.call('search_events', { query: '본사 5층' });
  assert.deepEqual(ids(where), ['팀 공유 회의'], 'location words, all of them');
  const past = await s.call('search_events', { query: '한글날' });
  assert.deepEqual(ids(past), ['한글날']);
  assert.deepEqual((await s.call('search_events', { query: '없는말' })).data.items, []);
});

test('list_ddays: counters nearest first, archived only when asked', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  assert.equal((await s.th.call('ddays.save', [{ title: '시험', date: '2026-10-31' }])).ok, true);
  assert.equal((await s.th.call('ddays.save', [{ title: '오래전 일', date: '2026-01-01' }])).ok, true);
  const out = await s.call('list_ddays');
  assert.deepEqual(out.data.items.map((d) => [d.title, d.label, d.date]), [['시험', 'D-12', '2026-10-31']]);
  assert.equal(out.data.archived_count, 1);
  assert.equal(out.data.enabled, true);
  const all = await s.call('list_ddays', { include_archived: true });
  assert.deepEqual(all.data.items.map((d) => [d.title, Boolean(d.archived)]), [['시험', false], ['오래전 일', true]]);
});

test('create_event on a CalDAV calendar: the editor\'s conditional write, verified, then listed; no undo (no deletes)', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const calendar_id = MT.calRef(s.account.id, CAL);
  const out = await s.call('create_event', { calendar_id, title: '치과', start: '2026-10-22 17:00', duration_minutes: 30, location: '역 앞' });
  s.noSecrets(out);
  assert.equal(out.data.ok, true);
  assert.equal(out.data.confirmed, true);
  assert.deepEqual([out.data.event.start, out.data.event.end], ['2026-10-22 17:00', '2026-10-22 17:30']);
  assert.match(out.summary, /"치과" 10\/22 \(목\) 17:00 · .+ 추가$/);
  assert.equal(out.undo, undefined);
  assert.equal(typeof out.open, 'function');
  const put = s.srv.requests.find((r) => r.method === 'PUT');
  assert.equal(put.ifNoneMatch, '*');
  assert.ok([...s.srv.store.values()].some((r) => /SUMMARY:치과/.test(r.ics)));
  const listed = await s.call('list_events', { from: '2026-10-22' });
  const item = listed.data.items.find((i) => i.title === '치과');
  assert.equal(item.id, out.data.id);
  assert.equal(item.writable, true);
  assert.deepEqual(s.getState().lastCalendar, { sourceId: s.account.id, calendarId: CAL }, 'same bookkeeping as the editor');
  assert.deepEqual(s.cards, [], 'no widget card: the engine shows the change');
  // All-day without end: one day.
  const day = await s.call('create_event', { calendar_id, title: '휴가', start: '2026-10-27' });
  assert.deepEqual([day.data.event.all_day, day.data.event.start, day.data.event.end], [true, '2026-10-27', '2026-10-27']);
  await assert.rejects(s.call('create_event', { calendar_id, title: '틀림', start: '2026-10-22 17:00', end: '2026-10-22 16:00' }), /끝 시간/);
  await assert.rejects(s.call('create_event', { calendar_id, title: '틀림', start: '2026-10-22', all_day: false }), /HH:mm/);
});

test('create_event on the local calendar; refused on a read-only (ICS) calendar or an unknown one', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const local = (await s.call('list_calendars')).data.items.find((c) => c.source_type === 'local');
  const out = await s.call('create_event', { calendar_id: local.id, title: '로컬 메모', start: '2026-10-24', end: '2026-10-25' });
  assert.equal(out.data.confirmed, true);
  assert.deepEqual([out.data.event.start, out.data.event.end], ['2026-10-24', '2026-10-25']);
  const listed = await s.call('list_events', { from: '2026-10-24' });
  assert.equal(listed.data.items.find((i) => i.title === '로컬 메모').id, out.data.id);
  const before = s.srv.requests.length;
  await assert.rejects(s.call('create_event', { calendar_id: MT.calRef(s.feedSource.id, 'default'), title: 'x', start: '2026-10-24' }), /읽기 전용/);
  await assert.rejects(s.call('create_event', { calendar_id: 'nope/0123456789', title: 'x', start: '2026-10-24' }), /찾지 못했습니다/);
  assert.equal(s.srv.requests.slice(before).filter((r) => r.method === 'PUT').length, 0);
});

test('update_event: changes only the given fields with If-Match; same values again = unchanged; undo writes the old ones back', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const plain = (await s.call('list_events', { from: '2026-10-20' })).data.items.find((i) => i.title === '보통 일정');
  const out = await s.call('update_event', { id: plain.id, title: '바뀐 일정', start: '2026-10-20 14:00' });
  s.noSecrets(out);
  assert.equal(out.data.confirmed, true);
  assert.deepEqual([out.data.before.title, out.data.event.title, out.data.event.start, out.data.event.end], ['보통 일정', '바뀐 일정', '2026-10-20 14:00', '2026-10-20 15:00']);
  assert.match(out.summary, /"보통 일정" 제목 → "바뀐 일정", 시간 → 10\/20 \(화\) 14:00/);
  assert.equal(s.srv.requests.find((r) => r.method === 'PUT').ifMatch, '"p1"');
  const doc = s.srv.store.get(`${CAL}plain.ics`).ics;
  assert.match(doc, /SUMMARY:바뀐 일정/);
  assert.match(doc, /BEGIN:VALARM/, 'what the widget does not show is kept');
  assert.match(doc, /LOCATION:3층/);
  const again = await s.call('update_event', { id: plain.id, title: '바뀐 일정' });
  assert.equal(again.unchanged, true);
  await out.undo();
  const restored = s.srv.store.get(`${CAL}plain.ics`).ics;
  assert.match(restored, /SUMMARY:보통 일정/);
  const back = (await s.call('list_events', { from: '2026-10-20' })).data.items.find((i) => i.id === plain.id);
  assert.deepEqual([back.title, back.start], ['보통 일정', '2026-10-20 10:00']);
  // An undo after someone changed it again is refused.
  const second = await s.call('update_event', { id: plain.id, location: '' });
  assert.match(second.summary, /장소 지움/);
  await s.call('update_event', { id: plain.id, title: '다른 곳에서 바뀜' });
  await assert.rejects(second.undo(), /그 뒤 일정이 바뀌어/);
});

test('update_event on the local calendar, with undo', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const local = (await s.call('list_calendars')).data.items.find((c) => c.source_type === 'local');
  const made = await s.call('create_event', { calendar_id: local.id, title: '산책', start: '2026-10-25 07:00' });
  const out = await s.call('update_event', { id: made.data.id, start: '2026-10-25 08:30', description: '공원' });
  assert.deepEqual([out.data.event.start, out.data.event.end, out.data.event.description], ['2026-10-25 08:30', '2026-10-25 09:30', '공원']);
  await out.undo();
  const back = (await s.call('list_events', { from: '2026-10-25' })).data.items.find((i) => i.id === made.data.id);
  assert.deepEqual([back.start, back.description], ['2026-10-25 07:00', '']);
});

test('update_event refusals: recurring instance, read-only calendar, bad id; nothing is sent', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const items = (await s.call('list_events', { from: '2026-10-19', to: '2026-10-25' })).data.items;
  const before = s.srv.requests.length;
  await assert.rejects(s.call('update_event', { id: items.find((i) => i.title === '주간 회의').id, title: 'x' }), /반복/);
  await assert.rejects(s.call('update_event', { id: items.find((i) => i.title === '팀 공유 회의').id, title: 'x' }), /읽기 전용/);
  await assert.rejects(s.call('update_event', { id: 'garbage', title: 'x' }), /id가 올바르지 않습니다/);
  // The series master itself (no recurrence id) is refused by the editor's rule too.
  const master = MT.eventRef({ sourceId: s.account.id, calendarId: CAL, uid: 'weekly' });
  await assert.rejects(s.call('update_event', { id: master, title: 'x' }), /반복/);
  assert.equal(s.srv.requests.slice(before).filter((r) => r.method === 'PUT').length, 0);
});

test('a failed write: the assistant gets the server\'s reason, no widget card while it waited', async (t) => {
  const s = await setup({ failWrites: 403 });
  t.after(() => s.widget.stop());
  await assert.rejects(s.call('create_event', { calendar_id: MT.calRef(s.account.id, CAL), title: '안 됨', start: '2026-10-22 10:00' }), (err) => err.message.length > 0 && !err.message.includes(PASSWORD));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(s.cards, []);
});

test('a slow server: the tool answers "pending" in time, the write goes on in the background like the editor\'s', async (t) => {
  let open;
  const opened = new Promise((r) => (open = r));
  const s = await setup({ gate: () => opened, mcpWaitMs: 50 });
  t.after(() => s.widget.stop());
  const out = await s.call('create_event', { calendar_id: MT.calRef(s.account.id, CAL), title: '늦은 저장', start: '2026-10-22 10:00' });
  assert.equal(out.data.status, 'pending');
  assert.match(out.summary, /추가 중/);
  const shown = await s.th.call('events.list', [[{ from: new Date(2026, 9, 22).getTime(), to: new Date(2026, 9, 23).getTime() }]]);
  assert.equal(shown[0].find((e) => e.title === '늦은 저장').pending, true, 'the widget shows it as saving');
  open();
  for (let i = 0; i < 100 && ![...s.srv.store.values()].some((r) => /늦은 저장/.test(r.ics)); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok([...s.srv.store.values()].some((r) => /SUMMARY:늦은 저장/.test(r.ics)));
  assert.deepEqual(s.cards, [], 'success: no card');
});

test('parseWhen and ids', () => {
  assert.deepEqual(MT.parseWhen('2026-10-20'), { date: '2026-10-20' });
  assert.equal(MT.parseWhen('2026-10-20 14:30').ms, new Date(2026, 9, 20, 14, 30).getTime());
  assert.equal(MT.parseWhen('2026-10-20T14:30:00').ms, new Date(2026, 9, 20, 14, 30).getTime());
  for (const bad of ['2026-13-01', '2026-10-20 24:00', '10/20', '', '2026-10-20 14']) assert.equal(MT.parseWhen(bad), null, bad);
  const e = { sourceId: 's1', calendarId: CAL, uid: 'a/b:c@x', recurrenceId: 't:123' };
  const id = MT.eventRef(e);
  assert.ok(!id.includes('naver'));
  assert.deepEqual(MT.parseEventRef(id), { sourceId: 's1', key: MT.calRef('s1', CAL).split('/')[1], uid: 'a/b:c@x', recurrenceId: 't:123' });
  assert.equal(MT.parseEventRef('s1/zz/abc'), null);
});
