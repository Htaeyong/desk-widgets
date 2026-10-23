// The widget's event editor through its IPC (#48): create, edit, delete with confirmation, the pending and
// "반영 확인 안 됨" states, and the refusals (ICS, recurring, read-only calendar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../index');
const { DEFAULTS, sanitize } = require('../lib/settings');
const { withThemeHost } = require('./theme-host');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const BASE = 'https://caldav.calendar.naver.com/';
const CAL = 'https://caldav.calendar.naver.com/caldav/user01/calendar/1234/';
const OCT = { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-11-01T00:00:00Z') };
const fakeCrypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };

const ics = (uid, lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

/** Naver-like discovery (fixtures) + an in-memory calendar with ETags; dropWrites keeps nothing (Dooray #100). */
function server({ dropWrites = false, gate = null, failWrites = 0 } = {}) {
  const store = new Map([
    [`${CAL}plain.ics`, { etag: 'p1', ics: ics('plain', ['DTSTART:20261020T010000Z', 'DTEND:20261020T020000Z', 'SUMMARY:보통 일정', 'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'END:VALARM']) }],
    [`${CAL}weekly.ics`, { etag: 'w1', ics: ics('weekly', ['DTSTART:20261019T000000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY', 'SUMMARY:주간 회의']) }],
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
    return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, body: null, text: async () => body };
  };
  const fetch = async (url, opts) => {
    const h = opts.headers || {};
    requests.push({ url, method: opts.method, ifMatch: h['If-Match'], ifNoneMatch: h['If-None-Match'] });
    if (discovery[`${opts.method} ${url}`]) return reply(207, discovery[`${opts.method} ${url}`]);
    if (opts.method === 'PROPFIND') return reply(404);
    if (opts.method === 'REPORT') {
      const items = [...store].map(([href, r]) => `<D:response><D:href>${new URL(href).pathname}</D:href><D:propstat><D:prop><D:getetag>"${r.etag}"</D:getetag><C:calendar-data><![CDATA[${r.ics}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      return reply(207, `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${items.join('')}</D:multistatus>`);
    }
    const res = store.get(url);
    if ((opts.method === 'PUT' || opts.method === 'DELETE') && gate) await gate();
    if ((opts.method === 'PUT' || opts.method === 'DELETE') && failWrites) return reply(failWrites);
    if (opts.method === 'GET') return res ? reply(200, res.ics, { ETag: `"${res.etag}"` }) : reply(404);
    if (opts.method === 'PUT') {
      if ((h['If-None-Match'] === '*' && res) || (h['If-Match'] && (!res || h['If-Match'] !== `"${res.etag}"`))) return reply(412);
      if (!dropWrites) store.set(url, { etag: `n${++v}`, ics: opts.body });
      return reply(201);
    }
    if (opts.method === 'DELETE') {
      if (!res) return reply(404);
      if (h['If-Match'] !== `"${res.etag}"`) return reply(412);
      if (!dropWrites) store.delete(url);
      return reply(204);
    }
    return reply(405);
  };
  return { fetch, store, requests };
}

async function setup({ dropWrites = false, canWrite = true, confirmAnswer = 0, gate = null, failWrites = 0 } = {}) {
    let state = sanitize({ ...DEFAULTS });
  const confirms = [];
  const cards = [];
  const { ctx, th } = withThemeHost({
    notify: (events, options) => cards.push({ card: events[0], options }),
    dir: path.join(__dirname, '..'),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cal-ed-')),
    createStore: () => ({ load: () => state, save: (v) => { state = sanitize({ ...state, ...v }); } }),
    popupMenu() {},
    openExternal() {},
    openSettings() {},
    sendToSettings() {},
    beforeFocus() {},
    confirm: async (_w, options) => {
      confirms.push(options);
      return confirmAnswer;
    },
  });
  const srv = server({ dropWrites, gate, failWrites });
  const widget = create(ctx, { fetch: srv.fetch, crypto: fakeCrypto });
  widget.start();
  const found = await widget.settings.handlers.caldavDiscover({ provider: 'naver', username: 'user01', password: 'app-pass' });
  const calendars = found.calendars.map((c) => ({ ...c, canWrite: canWrite ? c.canWrite : false }));
  assert.deepEqual(
    widget.settings.save({
      sources: [
        { type: 'caldav', provider: 'naver', username: 'user01', name: '네이버', enabled: true, calendars, draft: found.token },
        { type: 'ics', name: '공휴일', url: 'https://example.com/h.ics', enabled: false },
      ],
    }),
    { ok: true },
  );
  await new Promise((r) => setTimeout(r, 50));
  const account = state.sources.find((s) => s.type === 'caldav');
  // Reads straight from the declared theme methods (synchronous); writes go through the engine's call rules (th.theme).
  const events = () => th.opts.methods['events.list'].run({}, [OCT])[0];
  const view = () => th.opts.methods.getState.run({});
  // Waits until no write is in flight (#63: saves return at once and go on in the background).
  const idle = async () => {
    for (let i = 0; i < 200 && view().pending.length; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
  };
  return { widget, th, srv, account, events, confirms, cards, idle, getState: () => state, view };
}

const newFields = { title: '새 일정', allDay: false, start: Date.UTC(2026, 9, 22, 1), end: Date.UTC(2026, 9, 22, 2), location: '회의실', description: '' };

test('view: writable calendars for the editor; plain events editable, recurring ones read-only with a reason', async (t) => {
  const { widget, view, events } = await setup();
  t.after(() => widget.stop());
  assert.deepEqual(view().calendars.map((c) => c.calendarId), ['local', CAL]);
  const byUid = Object.fromEntries(events().map((e) => [e.uid, e]));
  assert.equal(byUid.plain.readOnly, false);
  assert.equal(byUid.plain.readOnlyReason, null);
  assert.equal(byUid.weekly.readOnly, true);
  assert.match(byUid.weekly.readOnlyReason, /반복/);
});

/** A gate the fake server waits on before answering a write: open() lets the held writes through. */
function makeGate() {
  let open;
  const opened = new Promise((r) => (open = r));
  const gate = () => opened;
  gate.open = open;
  return gate;
}

test('create returns at once; the event shows as pending, then normal once confirmed; no card on success', async (t) => {
  const gate = makeGate();
  const { widget, th, srv, account, events, getState, view, idle, cards } = await setup({ gate });
  t.after(() => widget.stop());
  const bad = await th.theme.save({ sourceId: account.id, calendarId: CAL, fields: { ...newFields, title: '' } });
  assert.deepEqual(bad, { ok: false, message: '제목을 넣으세요.' });
  const res = await th.theme.save({ sourceId: account.id, calendarId: CAL, fields: newFields });
  assert.deepEqual(res, { ok: true, queued: true });
  const pending = events().find((e) => e.title === '새 일정');
  assert.ok(pending, 'shown before the server answered');
  assert.equal(pending.pending, true);
  assert.equal(pending.readOnly, true);
  assert.match(pending.uid, /^pending:/);
  assert.deepEqual(view().pending, [pending.uid]);
  gate.open();
  await idle();
  const done = events().find((e) => e.title === '새 일정');
  assert.ok(done && !done.pending && /@desk-widgets$/.test(done.uid), 'now the server\'s event');
  assert.equal(srv.requests.find((r) => r.method === 'PUT').ifNoneMatch, '*');
  assert.deepEqual(getState().lastCalendar, { sourceId: account.id, calendarId: CAL });
  assert.deepEqual(view().pending, []);
  assert.deepEqual(cards, []);
});

test('edit shows the new form at once and keeps what the widget does not show (VALARM), with If-Match', async (t) => {
  const gate = makeGate();
  const { widget, th, srv, account, events, idle } = await setup({ gate });
  t.after(() => widget.stop());
  const plain = events().find((e) => e.uid === 'plain');
  const fields = { title: '바뀐 일정', allDay: false, start: Date.parse(plain.start), end: Date.parse(plain.end), location: '', description: '' };
  assert.deepEqual(await th.theme.save({ sourceId: account.id, calendarId: CAL, uid: 'plain', fields }), { ok: true, queued: true });
  const shown = events().filter((e) => e.uid === 'plain');
  assert.deepEqual(shown.map((e) => [e.title, e.pending]), [['바뀐 일정', true]], 'one event, in its new form');
  gate.open();
  await idle();
  assert.equal(srv.requests.find((r) => r.method === 'PUT').ifMatch, '"p1"');
  assert.match(srv.store.get(`${CAL}plain.ics`).ics, /BEGIN:VALARM/);
  assert.deepEqual(events().filter((e) => e.uid === 'plain').map((e) => [e.title, Boolean(e.pending)]), [['바뀐 일정', false]]);
});

test('a write the server does not keep: "반영 확인 안 됨" card, the event goes back to the server state', async (t) => {
  const { widget, th, account, events, view, idle, cards } = await setup({ dropWrites: true });
  t.after(() => widget.stop());
  const plain = events().find((e) => e.uid === 'plain');
  const fields = { title: '반영 안 될 제목', allDay: false, start: Date.parse(plain.start), end: Date.parse(plain.end), location: '', description: '' };
  await th.theme.save({ sourceId: account.id, calendarId: CAL, uid: 'plain', fields });
  await idle();
  assert.equal(events().find((e) => e.uid === 'plain').title, '보통 일정', 'previous state kept');
  assert.match(view().unconfirmed.plain, /반영 확인 안 됨/);
  assert.equal(cards.length, 1);
  const { card } = cards[0];
  assert.equal(card.type, 'card');
  assert.equal(card.title, '반영 확인 안 됨');
  assert.match(card.body, /"반영 안 될 제목"/);
  assert.equal(card.sticky, true);
  assert.match(card.tag, /plain/);
  assert.deepEqual(card.actions.map((a) => a.id), ['open'], 'no blind retry when the server may have kept it after all');
});

test('a failed save: card with the reason, the optimistic event disappears, 다시 시도 runs it again (still failing here)', async (t) => {
  const { widget, th, srv, account, events, idle, cards, view } = await setup({ failWrites: 503 });
  t.after(() => widget.stop());
  await th.theme.save({ sourceId: account.id, calendarId: CAL, fields: newFields });
  await idle();
  assert.ok(!events().some((e) => e.title === '새 일정'), 'reverted to the server state');
  assert.equal(cards.length, 1);
  const { card, options } = cards[0];
  assert.deepEqual([card.title, card.icon, card.sticky], ['일정 저장 실패', 'warning', true]);
  assert.match(card.body, /"새 일정" — .*HTTP 503/);
  assert.deepEqual(card.actions.map((a) => [a.id, a.label]), [['retry', '다시 시도'], ['open', '열기']]);
  // The server is fine again: 다시 시도 creates it (a new UID, still If-None-Match: *).
  srv.requests.length = 0;
  options.onAction(card, 'retry');
  assert.equal(view().pending.length, 1, 'pending again while it retries');
  await idle();
  assert.equal(cards.length, 2, 'still failing: a second card (same tag replaces the first)');
  assert.equal(cards[1].card.tag, cards[0].card.tag);
  assert.ok(srv.requests.some((r) => r.method === 'PUT' && r.ifNoneMatch === '*'));
});

test('a conflicting edit: no blind retry, 다시 시도 opens the editor with the server version', async (t) => {
  const { widget, th, srv, account, events, idle, cards } = await setup();
  t.after(() => widget.stop());
  const plain = events().find((e) => e.uid === 'plain');
  // Someone changes it on the server after the widget read it.
  srv.store.set(`${CAL}plain.ics`, { etag: 'other', ics: srv.store.get(`${CAL}plain.ics`).ics.replace('보통 일정', '다른 기기에서 바꿈') });
  const fields = { title: '내 수정', allDay: false, start: Date.parse(plain.start), end: Date.parse(plain.end), location: '', description: '' };
  await th.theme.save({ sourceId: account.id, calendarId: CAL, uid: 'plain', fields });
  await idle();
  assert.ok(!srv.requests.some((r) => r.method === 'PUT'), 'nothing written over the other change');
  assert.equal(events().find((e) => e.uid === 'plain').title, '다른 기기에서 바꿈', 'the server version shows');
  const { card, options } = cards[0];
  assert.equal(card.title, '일정 저장 실패');
  assert.match(card.body, /다른 곳/);
  assert.deepEqual(card.actions.map((a) => a.id), ['reopen', 'open']);
  options.onAction(card, 'reopen');
  const msg = th.emitted.find((m) => m[0] === 'open-editor');
  assert.equal(th.focused, 1, 'the widget comes forward');
  const d = new Date(plain.start);
  const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.deepEqual(msg[1], { sourceId: account.id, calendarId: CAL, uid: 'plain', day: localDay });
});

test('delete asks first; then the event disappears at once and is deleted with If-Match', async (t) => {
  const cancelled = await setup({ confirmAnswer: 1 });
  t.after(() => cancelled.widget.stop());
  const r1 = await cancelled.th.theme.remove({ sourceId: cancelled.account.id, calendarId: CAL, uid: 'plain', title: '보통 일정' });
  assert.deepEqual(r1, { ok: false, cancelled: true });
  assert.ok(!cancelled.srv.requests.some((r) => r.method === 'DELETE'));
  assert.match(cancelled.confirms[0].message, /보통 일정/);

  const gate = makeGate();
  const s = await setup({ confirmAnswer: 0, gate });
  t.after(() => s.widget.stop());
  const r2 = await s.th.theme.remove({ sourceId: s.account.id, calendarId: CAL, uid: 'plain', title: '보통 일정' });
  assert.deepEqual(r2, { ok: true, queued: true });
  assert.ok(!s.events().some((e) => e.uid === 'plain'), 'gone from the widget before the server answered');
  gate.open();
  await s.idle();
  assert.equal(s.srv.requests.find((r) => r.method === 'DELETE').ifMatch, '"p1"');
  assert.ok(!s.events().some((e) => e.uid === 'plain'));
  assert.deepEqual(s.cards, []);
});

test('a failed delete brings the event back and says why', async (t) => {
  const s = await setup({ failWrites: 500 });
  t.after(() => s.widget.stop());
  await s.th.theme.remove({ sourceId: s.account.id, calendarId: CAL, uid: 'plain', title: '보통 일정' });
  await s.idle();
  assert.ok(s.events().some((e) => e.uid === 'plain' && !e.pending), 'back');
  assert.equal(s.cards[0].card.title, '일정 삭제 실패');
  assert.match(s.cards[0].card.body, /"보통 일정"/);
});

test('edit then delete of the same event reach the server in that order; other events run in parallel', async (t) => {
  const gate = makeGate();
  const s = await setup({ gate });
  t.after(() => s.widget.stop());
  const plain = s.events().find((e) => e.uid === 'plain');
  const fields = { title: '먼저 수정', allDay: false, start: Date.parse(plain.start), end: Date.parse(plain.end), location: '', description: '' };
  await s.th.theme.save({ sourceId: s.account.id, calendarId: CAL, uid: 'plain', fields });
  // The editor of a pending event is closed in the page; a delete of it is still queued after the edit.
  const del = await s.th.theme.remove({ sourceId: s.account.id, calendarId: CAL, uid: 'plain', title: '먼저 수정' });
  assert.deepEqual(del, { ok: true, queued: true });
  assert.ok(!s.events().some((e) => e.uid === 'plain'), 'the latest intent shows: gone');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.srv.requests.filter((r) => r.method === 'DELETE').length, 0, 'the delete waits for the edit');
  gate.open();
  await s.idle();
  const writes = s.srv.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE').map((r) => [r.method, r.ifMatch]);
  assert.equal(writes[0][0], 'PUT');
  assert.equal(writes[1][0], 'DELETE');
  assert.notEqual(writes[1][1], '"p1"', 'the delete used the version the edit produced');
  assert.ok(!s.srv.store.has(`${CAL}plain.ics`));
  assert.deepEqual(s.cards, []);
});

test('turning the widget off: queued writes are dropped, a write in flight ends without a card', async (t) => {
  const gate = makeGate();
  const s = await setup({ gate });
  const plain = s.events().find((e) => e.uid === 'plain');
  const fields = { title: '끄기 전 수정', allDay: false, start: Date.parse(plain.start), end: Date.parse(plain.end), location: '', description: '' };
  await s.th.theme.save({ sourceId: s.account.id, calendarId: CAL, uid: 'plain', fields });
  await s.th.theme.remove({ sourceId: s.account.id, calendarId: CAL, uid: 'plain', title: 'x' });
  await new Promise((r) => setTimeout(r, 30));
  s.widget.stop();
  gate.open();
  await new Promise((r) => setTimeout(r, 100));
  const writes = s.srv.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE').map((r) => r.method);
  assert.deepEqual(writes, ['PUT'], 'the edit already sent finished; the queued delete was never sent');
  assert.deepEqual(s.cards, []);
  void t;
});

test('refusals: recurring event, read-only calendar, ICS source, other windows', async (t) => {
  const s = await setup();
  t.after(() => s.widget.stop());
  const rec = await s.th.theme.save({ sourceId: s.account.id, calendarId: CAL, uid: 'weekly', fields: newFields });
  assert.equal(rec.ok, false);
  assert.match(rec.message, /반복/);
  const ics = s.getState().sources.find((x) => x.type === 'ics');
  const icsRes = await s.th.theme.save({ sourceId: ics.id, calendarId: 'default', fields: newFields });
  assert.equal(icsRes.ok, false);
  assert.match(icsRes.message, /읽기 전용/);
  // A theme cannot write on its own: only right after a click or key press, and never from the preview.
  assert.match((await s.th.theme.save({ sourceId: s.account.id, calendarId: CAL, fields: newFields }, { activated: false })).message, /클릭이나 키 입력/);
  assert.match((await s.th.theme.save({ sourceId: s.account.id, calendarId: CAL, fields: newFields }, { preview: true })).message, /미리보기/);
  assert.match((await s.th.theme.remove({ sourceId: s.account.id, calendarId: CAL, uid: 'plain' }, { activated: false })).message, /클릭이나 키 입력/);
  assert.ok(!s.srv.requests.some((r) => r.method === 'PUT' || r.method === 'DELETE'));

  const ro = await setup({ canWrite: false });
  t.after(() => ro.widget.stop());
  assert.deepEqual(ro.view().calendars.map((c) => c.calendarId), ['local']);
  const r = await ro.th.theme.save({ sourceId: ro.account.id, calendarId: CAL, fields: newFields });
  assert.equal(r.ok, false);
  assert.match(r.message, /쓰기 권한/);
  assert.match(ro.events().find((e) => e.uid === 'plain').readOnlyReason, /쓰기 권한/);
});
