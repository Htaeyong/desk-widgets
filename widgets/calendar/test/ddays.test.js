// D-day (#76): day counting, following a linked event by uid, the sync declaration, reminders and the theme calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeSpec, sharedPart } = require('../../../engine/main/sync-store');
const D = require('../lib/ddays');
const M = require('../kit/model');
const { create } = require('../index');
const { DEFAULTS, sanitize } = require('../lib/settings');
const { withThemeHost } = require('./theme-host');

const item = (extra = {}) => D.sanitizeItem({ id: 'a', title: '시험', date: '2026-11-10', ...extra });

test('count: D-N, D-day, D+N and including the day itself', () => {
  assert.deepEqual(D.count(item(), '2026-11-07'), { target: '2026-11-10', days: -3, label: 'D-3' });
  assert.equal(D.count(item(), '2026-11-10').label, 'D-day');
  assert.equal(D.count(item(), '2026-11-12').label, 'D+2');
  const inc = item({ inclusive: true });
  assert.equal(D.count(inc, '2026-11-09').label, 'D-1', 'before the day nothing changes');
  assert.equal(D.count(inc, '2026-11-10').label, 'D+1', 'the day itself is day 1');
  assert.equal(D.count(inc, '2026-11-12').label, 'D+3');
  assert.equal(D.count(inc, '2026-11-10').days, 0);
});

test('count: month ends, leap years and daylight saving do not move the day numbers', () => {
  assert.equal(D.count(item({ date: '2027-01-01' }), '2026-12-31').label, 'D-1');
  assert.equal(D.count(item({ date: '2028-03-01' }), '2028-02-28').label, 'D-2', '2028 has a Feb 29');
  assert.equal(D.count(item({ date: '2027-03-01' }), '2027-02-28').label, 'D-1');
  assert.equal(D.count(item({ date: '2026-03-30' }), '2026-03-28').label, 'D-2', 'across the EU/US clock change');
  assert.equal(D.count(item({ date: '2026-11-02' }), '2026-10-30').label, 'D-3');
  assert.equal(D.count(item({ date: '2000-01-01' }), '2026-10-26').days, 9795);
});

test('yearly: the next date, Feb 29 on Feb 28 in common years, never passes or archives', () => {
  const birthday = item({ date: '1990-11-10', yearly: true });
  assert.deepEqual(D.count(birthday, '2026-11-09'), { target: '2026-11-10', days: -1, label: 'D-1' });
  assert.equal(D.count(birthday, '2026-11-10').label, 'D-day');
  assert.deepEqual(D.count(birthday, '2026-11-11'), { target: '2027-11-10', days: -364, label: 'D-364' });
  assert.equal(D.count(birthday, '2026-12-31').target, '2027-11-10');
  const leap = item({ date: '2024-02-29', yearly: true });
  assert.equal(D.count(leap, '2026-02-01').target, '2026-02-28', 'common year');
  assert.equal(D.count(leap, '2026-02-28').label, 'D-day');
  assert.equal(D.count(leap, '2026-03-01').target, '2027-02-28');
  assert.equal(D.count(leap, '2027-03-01').target, '2028-02-29', 'leap year keeps Feb 29');
  assert.equal(D.count(leap, '2028-02-28').label, 'D-1');
  assert.equal(D.count(item({ date: '2024-02-29', yearly: true, inclusive: true }), '2026-02-28').label, 'D-day', 'including today does not apply to yearly');
  assert.equal(D.isArchived(birthday, 400, 7), false);
});

test('archive: a one-time D-day moves after the set days, by hand, or never with 0', () => {
  const past = item();
  assert.equal(D.isArchived(past, 7, 7), false);
  assert.equal(D.isArchived(past, 8, 7), true);
  assert.equal(D.isArchived(past, 800, 0), false);
  assert.equal(D.isArchived(item({ archived: true }), -5, 7), true);
  assert.equal(D.isArchived(past, -5, 7), false);
});

test('present: nearest first, the past after it, archive apart', () => {
  const items = [
    item({ id: 'past', title: '지난', date: '2026-10-24' }),
    item({ id: 'far', title: '먼', date: '2026-12-25' }),
    item({ id: 'today', title: '오늘', date: '2026-10-26' }),
    item({ id: 'near', title: '가까운', date: '2026-10-28' }),
    item({ id: 'old', title: '오래', date: '2026-10-01' }),
    item({ id: 'year', title: '생일', date: '1990-11-01', yearly: true }),
  ];
  const v = D.present(items, '2026-10-26', 7, { far: { missing: true } });
  assert.deepEqual(v.active.map((x) => x.id), ['today', 'near', 'year', 'far', 'past']);
  assert.deepEqual(v.archived.map((x) => x.id), ['old']);
  assert.deepEqual(v.active.map((x) => x.label), ['D-day', 'D-2', 'D-6', 'D-60', 'D+2']);
  assert.equal(v.active.find((x) => x.id === 'far').missing, true);
});

test('sanitize: drops bad dates and titles, limits fields, keeps the reminder record', () => {
  const out = D.sanitize({ items: [
    { id: 'ok', title: ' 여행 ', date: '2026-12-01', color: '#ABCDEF', remind: { sameDay: true, before: [3, 5, 1, 3] }, notifiedFor: ['d0:2026-12-01', 5] },
    { title: '날짜 틀림', date: '2026-02-30' },
    { title: '', date: '2026-12-01' },
    { id: 'ok', title: '같은 id', date: '2026-12-02', color: 'red', remind: { sameDay: false, before: [] } },
    null,
  ] });
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.items[0], {
    id: 'ok', title: '여행', date: '2026-12-01', color: '#abcdef', inclusive: false, yearly: false, remind: { sameDay: true, before: [1, 3] },
    archived: false, link: null, ownTitle: true, notifiedFor: ['d0:2026-12-01'],
  });
  assert.notEqual(out.items[1].id, 'ok', 'a repeated id gets a new one');
  assert.equal(out.items[1].remind, null);
  assert.equal(out.items[1].color, '#ff6b6b');
  assert.equal(D.sanitizeItem({ title: 'x', date: '2026-12-01', link: { sourceId: 'local', uid: 'local:1' } }).ownTitle, false, 'a linked one follows the title by default');
});

test('follow: a linked D-day moves with its event, keeps a typed title, and stays when the event is gone', () => {
  const linked = (extra = {}) => item({ id: 'l', title: '회의', date: '2026-11-10', link: { sourceId: 'local', calendarId: 'local', uid: 'local:1' }, ...extra });
  let r = D.follow([linked()], () => ({ date: '2026-11-12', title: '회의 (변경)' }));
  assert.equal(r.changed, true);
  assert.deepEqual([r.items[0].date, r.items[0].title], ['2026-11-12', '회의 (변경)']);
  r = D.follow([linked({ ownTitle: true, title: '내 제목' })], () => ({ date: '2026-11-12', title: '다른' }));
  assert.deepEqual([r.items[0].date, r.items[0].title], ['2026-11-12', '내 제목']);
  r = D.follow([linked()], () => ({ date: '2026-11-10', title: '회의' }));
  assert.equal(r.changed, false, 'nothing to save when nothing moved');
  r = D.follow([linked()], () => null);
  assert.equal(r.items[0].date, '2026-11-10');
  assert.deepEqual(r.missing, { l: { missing: true } });
  r = D.follow([linked()], () => undefined);
  assert.deepEqual([r.changed, r.missing], [false, {}], 'unknown yet is not missing');
  assert.equal(D.follow([item()], () => null).changed, false, 'unlinked ones are never touched');
});

test('dueReminders: from 9:00, the day itself and 1/3/7 days ahead, each date once', () => {
  const r = (extra) => item({ id: 'r', date: '2026-11-10', remind: { sameDay: true, before: [3, 7] }, ...extra });
  assert.deepEqual(D.dueReminders([r()], '2026-11-10', 8, 7), [], 'before 9:00');
  assert.deepEqual(D.dueReminders([r()], '2026-11-10', 9, 7).map((x) => [x.kind, x.mark, x.label]), [['d0', 'd0:2026-11-10', 'D-day']]);
  assert.deepEqual(D.dueReminders([r()], '2026-11-07', 9, 7).map((x) => x.mark), ['d3:2026-11-10']);
  assert.deepEqual(D.dueReminders([r()], '2026-11-03', 20, 7).map((x) => x.mark), ['d7:2026-11-10']);
  assert.deepEqual(D.dueReminders([r()], '2026-11-05', 9, 7), [], 'a day without a rule');
  assert.deepEqual(D.dueReminders([r()], '2026-11-09', 9, 7), [], '1 day before was not asked for');
  assert.deepEqual(D.dueReminders([r({ notifiedFor: ['d0:2026-11-10'] })], '2026-11-10', 9, 7), [], 'sent already');
  assert.deepEqual(D.dueReminders([r({ remind: null })], '2026-11-10', 9, 7), []);
  assert.deepEqual(D.dueReminders([r({ remind: { sameDay: false, before: [3] } })], '2026-11-10', 9, 7), []);
  assert.deepEqual(D.dueReminders([r({ archived: true })], '2026-11-10', 9, 7), []);
  const yearly = r({ date: '1990-11-10', yearly: true });
  assert.deepEqual(D.dueReminders([yearly], '2026-11-10', 9, 7).map((x) => x.mark), ['d0:2026-11-10']);
  assert.deepEqual(D.dueReminders([{ ...yearly, notifiedFor: ['d0:2026-11-10'] }], '2027-11-10', 9, 7).map((x) => x.mark), ['d0:2027-11-10'], 'next year is a new date');
});

test('model.ddayDays: dates in a grid, yearly ones on every year and Feb 29 on Feb 28', () => {
  const items = [
    { id: 'a', date: '2026-10-28', yearly: false },
    { id: 'b', date: '1990-10-31', yearly: true },
    { id: 'c', date: '2024-02-29', yearly: true },
    { id: 'd', date: '2026-12-31', yearly: false },
  ];
  const map = M.ddayDays(items, '2026-09-27', '2026-11-08');
  assert.deepEqual([...map.keys()].sort(), ['2026-10-28', '2026-10-31']);
  assert.deepEqual(map.get('2026-10-31').map((x) => x.id), ['b']);
  assert.deepEqual([...M.ddayDays(items, '2026-02-01', '2026-03-15').keys()], ['2026-02-28']);
  assert.deepEqual([...M.ddayDays(items, '2028-02-01', '2028-03-15').keys()], ['2028-02-29']);
  assert.deepEqual([...M.ddayDays(items, '2026-12-20', '2027-01-10').keys()], ['2026-12-31']);
});

// ---- the widget ----

const settle = () => new Promise((r) => setTimeout(r, 250)); // the widget coalesces changes for 150 ms

function setup(initial = {}) {
  const clock = { now: new Date(2026, 9, 26, 10, 0).getTime() };
  const stores = {};
  const syncSpecs = {};
  const cards = [];
  const { ctx, th } = withThemeHost({
    dir: path.join(__dirname, '..'),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cal-d-')),
    flags: {},
    createStore: (options) => {
      const name = options.sync.name;
      syncSpecs[name] = options.sync;
      stores[name] = stores[name] || { state: options.sanitize({ ...options.defaults, ...(name === 'settings' ? initial : {}) }) };
      return {
        load: () => stores[name].state,
        save: (v) => { stores[name].state = options.sanitize({ ...stores[name].state, ...v }); },
      };
    },
    openExternal: () => {},
    sendToSettings: () => {},
    notify: (events, options) => cards.push({ card: events[0], options }),
    confirm: async () => 0,
  });
  const widget = create(ctx, { fetch: null, crypto: { available: () => true, encrypt: String, decrypt: String }, now: () => clock.now });
  const save = (input) => th.call('ddays.save', [input]);
  return { widget, th, clock, stores, syncSpecs, cards, save, view: () => th.theme.get() };
}

test('sync declaration: D-days are a shared collection and only the reminder record stays on this PC', () => {
  const { syncSpecs } = setup();
  const spec = syncSpecs.ddays;
  assert.deepEqual(spec.collections.items.local, ['notifiedFor']);
  assert.equal(spec.collections.items.id, 'id');
  assert.deepEqual(spec.shared, []);
  const shared = sharedPart({ id: 'a', title: 't', date: '2026-11-10', notifiedFor: ['d0:2026-11-10'] }, normalizeSpec(spec).collections.items);
  assert.equal('notifiedFor' in shared, false);
  assert.equal(shared.title, 't');
  const settings = syncSpecs.settings;
  for (const key of ['ddayEnabled', 'ddayMax', 'ddayArchiveDays']) assert.ok(settings.shared.includes(key), key);
  assert.ok(!settings.shared.includes('ddayRemind'), 'the reminder switch is per PC');
});

test('settings: on by default, 3 rows, 7 days, reminders off; values are limited', () => {
  assert.deepEqual([DEFAULTS.ddayEnabled, DEFAULTS.ddayMax, DEFAULTS.ddayArchiveDays, DEFAULTS.ddayRemind], [true, 3, 7, false]);
  const s = sanitize({ ddayEnabled: false, ddayMax: 99, ddayArchiveDays: -4, ddayRemind: 'yes' });
  assert.deepEqual([s.ddayEnabled, s.ddayMax, s.ddayArchiveDays, s.ddayRemind], [false, 10, 0, false]);
  assert.equal(sanitize({ ddayMax: 0 }).ddayMax, 1);
});

test('theme calls: make, edit, archive and delete a standalone D-day; the state shows today\'s count', async (t) => {
  const { widget, view, save, th } = setup();
  widget.start();
  t.after(() => widget.stop());
  let state = await view();
  assert.deepEqual([state.ddayEnabled, state.ddayMax, state.ddays, state.ddaysArchived], [true, 3, [], []]);
  const made = await save({ title: '시험', date: '2026-11-10', color: '#4f8cff' });
  assert.equal(made.ok, true);
  state = await view();
  assert.equal(state.ddays.length, 1);
  assert.deepEqual([state.ddays[0].title, state.ddays[0].label, state.ddays[0].days, state.ddays[0].linked], ['시험', 'D-15', -15, false]);
  assert.deepEqual((await save({ id: made.id, title: '기말', date: '2026-11-11', inclusive: true, yearly: false })).ok, true);
  state = await view();
  assert.deepEqual([state.ddays[0].title, state.ddays[0].label], ['기말', 'D-16']);
  assert.match((await save({ title: '', date: '2026-11-10' })).message, /제목/);
  assert.match((await save({ title: 'x', date: '2026-13-10' })).message, /날짜/);
  assert.equal((await save({ id: 'nope', title: 'x', date: '2026-11-10' })).ok, false);
  assert.equal((await th.call('ddays.archive', [made.id, true])).ok, true);
  state = await view();
  assert.deepEqual([state.ddays.length, state.ddaysArchived.length], [0, 1]);
  await th.call('ddays.archive', [made.id, false]);
  assert.equal((await view()).ddays.length, 1);
  assert.equal((await th.call('ddays.remove', [made.id])).ok, true);
  assert.deepEqual((await view()).ddays, []);
  // Writes need a click or key press and are refused in the preview.
  assert.match((await th.call('ddays.save', [{ title: 'x', date: '2026-11-10' }], { activated: false })).message, /클릭이나 키 입력/);
  assert.equal(th.opts.methods['ddays.save'].preview, undefined);
});

test('turning D-day off hides everything but keeps the data', async (t) => {
  const { widget, view, save } = setup();
  widget.start();
  t.after(() => widget.stop());
  await save({ title: '시험', date: '2026-11-10' });
  assert.equal(widget.settings.save({ ddayEnabled: false, ddayMax: 5 }).ok, true);
  const off = await view();
  assert.deepEqual([off.ddayEnabled, off.ddayMax, off.ddays], [false, 5, []]);
  widget.settings.save({ ddayEnabled: true });
  assert.equal((await view()).ddays.length, 1);
  assert.equal(widget.settings.get().ddayMax, 5);
});

test('a one-time D-day moves to the archive after the set days', async (t) => {
  const { widget, view, save, clock } = setup();
  widget.start();
  t.after(() => widget.stop());
  await save({ title: '끝난', date: '2026-10-19' });
  assert.equal((await view()).ddays[0].label, 'D+7');
  clock.now = new Date(2026, 9, 27, 10, 0).getTime();
  const s = await view();
  assert.deepEqual([s.ddays.length, s.ddaysArchived[0].label], [0, 'D+8']);
  widget.settings.save({ ddayArchiveDays: 0 });
  assert.equal((await view()).ddays.length, 1);
});

const event = (title, start, end) => ({ title, allDay: true, start, end, location: '', description: '' });
const LOCAL = { sourceId: 'local', calendarId: 'local' };

test('a D-day made from an event follows its uid: date and title move, a typed title stays, gone keeps the last date', async (t) => {
  const { widget, view, save, th, clock } = setup();
  widget.start();
  t.after(() => widget.stop());
  const created = await th.call('events.create', [LOCAL, event('치과', '2026-11-05', '2026-11-06')]);
  assert.equal(created.ok, true);
  await settle();
  const uid = (await th.call('events.list', [[{ from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 11, 1).getTime() }]]))[0][0].uid;
  const made = await save({ title: '치과', date: '2026-11-05', ownTitle: false, link: { ...LOCAL, uid } });
  assert.equal(made.ok, true);
  assert.equal((await view()).ddays[0].linked, true);
  // The event moves: the D-day follows.
  await th.call('events.update', [{ ...LOCAL, uid }, event('치과 (변경)', '2026-11-08', '2026-11-09')]);
  await settle();
  let d = (await view()).ddays[0];
  assert.deepEqual([d.date, d.title, d.label, d.missing], ['2026-11-08', '치과 (변경)', 'D-13', false]);
  // A typed title is kept while the date still follows.
  await save({ id: made.id, title: '내 제목', date: d.date, ownTitle: true, link: { ...LOCAL, uid } });
  await th.call('events.update', [{ ...LOCAL, uid }, event('또 변경', '2026-11-09', '2026-11-10')]);
  await settle();
  d = (await view()).ddays[0];
  assert.deepEqual([d.date, d.title], ['2026-11-09', '내 제목']);
  // The event is deleted: the last known date keeps counting, marked missing.
  await th.call('events.remove', [{ ...LOCAL, uid }]);
  await settle();
  d = (await view()).ddays[0];
  assert.deepEqual([d.date, d.title, d.missing, d.linked], ['2026-11-09', '내 제목', true, true]);
  void clock;
});

test('reminders: off by default, one card per date once switched on, on the day from 9:00', async (t) => {
  const { widget, save, cards, clock, stores } = setup();
  widget.start();
  t.after(() => widget.stop());
  clock.now = new Date(2026, 10, 7, 9, 30).getTime(); // 3 days before
  await save({ title: '여행', date: '2026-11-10', remind: { sameDay: true, before: [3] } });
  widget.ddayTick();
  assert.equal(cards.length, 0, 'this PC\'s switch is off');
  widget.settings.save({ ddayRemind: true });
  widget.ddayTick();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card.title, 'D-3 · 여행');
  assert.equal(cards[0].card.type, 'card');
  assert.deepEqual(stores.ddays.state.items[0].notifiedFor, ['d3:2026-11-10']);
  widget.ddayTick();
  widget.ddayTick();
  assert.equal(cards.length, 1, 'not again');
  clock.now = new Date(2026, 10, 10, 8, 59).getTime();
  widget.ddayTick();
  assert.equal(cards.length, 1, 'before 9:00');
  clock.now = new Date(2026, 10, 10, 9, 0).getTime();
  widget.ddayTick();
  assert.equal(cards.length, 2);
  assert.equal(cards[1].card.title, 'D-day · 여행');
  clock.now = new Date(2026, 10, 10, 15, 0).getTime();
  widget.ddayTick();
  assert.equal(cards.length, 2);
  // Another PC's sync only brings the shared fields: its own record is empty, so it would still show its cards.
  assert.deepEqual(stores.ddays.state.items[0].notifiedFor, ['d3:2026-11-10', 'd0:2026-11-10']);
});

test('a reminder missed while the widget was off is shown late on that day only', async (t) => {
  const { widget, save, cards, clock } = setup({ ddayRemind: true });
  widget.start();
  t.after(() => widget.stop());
  await save({ title: '기념일', date: '2026-10-26', remind: { sameDay: true, before: [] } });
  clock.now = new Date(2026, 9, 26, 21, 0).getTime();
  widget.ddayTick();
  assert.equal(cards.length, 1);
  const { widget: w2, save: save2, cards: cards2, clock: clock2 } = setup({ ddayRemind: true });
  w2.start();
  t.after(() => w2.stop());
  await save2({ title: '지난', date: '2026-10-26', remind: { sameDay: true, before: [] } });
  clock2.now = new Date(2026, 9, 27, 10, 0).getTime();
  w2.ddayTick();
  assert.equal(cards2.length, 0, 'yesterday\'s is not sent');
});
