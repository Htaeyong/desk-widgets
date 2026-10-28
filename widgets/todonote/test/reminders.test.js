// Reminders of to-do notes (#111, design 2.3 / 7): when, no duplicates, snooze, late reminders, the summary card,
// the card buttons and reopening a repeating note.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../lib/todo');
const D = require('../lib/dates');
const { setup } = require('./fake-engine');

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const note = (id, todo, extra = {}) => ({ id, title: id, ext: 'md', hasFmId: true, todo: { problems: [], ...todo }, ...extra });
const due = (date, time = null) => ({ date, time });

test('which reminders are due: timed, all-day at the set time, off, snoozed, already shown, late', () => {
  const now = at(2026, 10, 20, 9, 30);
  const memos = [
    note('timed', { due: due('2026-10-20', '09:00') }),
    note('allday', { due: due('2026-10-20') }),
    note('before', { due: due('2026-10-20', '10:00'), remind: D.parseRemind('30분 전') }),
    note('off', { due: due('2026-10-20', '09:00'), remind: D.parseRemind('없음') }),
    note('later', { due: due('2026-10-20', '11:00') }),
    note('shown', { due: due('2026-10-20', '08:00') }),
    note('snoozed', { due: due('2026-10-20', '08:00') }),
    note('old', { due: due('2026-10-18', '09:00') }),
    note('done', { due: due('2026-10-20', '09:00'), completedAt: now - 1000 }),
    note('archived', { due: due('2026-10-20', '09:00') }, { archived: true }),
    note('copy', { due: due('2026-10-20', '09:00') }, { conflictOf: 'timed' }),
  ];
  const states = { shown: { remindedFor: at(2026, 10, 20, 8) }, snoozed: { remindedFor: at(2026, 10, 20, 8), snoozedUntil: at(2026, 10, 20, 9, 40) } };
  const r = T.dueReminders(memos, now, { allDayRemind: '09:00', lateMs: 12 * 3600000, state: (id) => states[id] });
  assert.deepEqual(r.due.map((x) => x.id), ['timed', 'allday', 'before']);
  assert.deepEqual(r.missed.map((x) => x.id), ['old']);
  assert.equal(r.next, at(2026, 10, 20, 9, 40), 'the snooze is the next one');
  const off = T.dueReminders([note('allday', { due: due('2026-10-20') })], now, { allDayRemind: '', lateMs: 1, state: () => ({}) });
  assert.deepEqual(off.due, [], 'all-day reminders switched off');
});

async function started(t) {
  await t.w.start();
  await t.until(() => t.cards.length > 0, 1000);
}

const stamp = (ms) => D.formatDueValue({ date: D.todayOf(ms), time: `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}` });

test('a due reminder shows one sticky card with three buttons; a restart does not show it again', async () => {
  const t = setup();
  const when = Date.now() - 60000;
  t.writeNote('견적서 회신', { id: 'rem1', fm: [`due: ${stamp(when)}`] });
  await started(t);
  assert.equal(t.cards.length, 1);
  const [card] = t.cards[0].events;
  assert.equal(card.title, '견적서 회신');
  assert.equal(card.sticky, true);
  assert.equal(card.tag, 'memo-rem1');
  assert.deepEqual(card.actions.map((a) => a.id), ['done', 'open']);
  assert.equal(t.cards[0].opts.menu.items({})[0].label, '10분 뒤', 'the set snooze comes first in the card menu');
  assert.ok(t.state().memos.rem1.remindedFor, 'marked before it was shown');
  t.w.stop();
  await t.w.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.cards.length, 1, 'no second card after a restart');
  t.w.stop();
});

test('card buttons: snooze keeps the file, open opens the note, done completes it', async () => {
  const t = setup({ initial: { snoozeMinutes: 15 } });
  const when = Date.now() - 60000;
  const file = t.writeNote('치과', { id: 'rem2', fm: [`due: ${stamp(when)}`] });
  await started(t);
  const before = t.read(file);
  const { opts } = t.cards[0];
  opts.menu.toggle({}, opts.menu.items({})[0].id);
  assert.ok(Math.abs(t.state().memos.rem2.snoozedUntil - (Date.now() + 15 * 60000)) < 5000);
  assert.equal(t.read(file), before, 'snoozing never writes the file');
  // The card menu: more snooze times.
  const items = opts.menu.items({});
  assert.ok(items.some((i) => i.id === 'morning'));
  opts.menu.toggle({}, '60');
  assert.ok(Math.abs(t.state().memos.rem2.snoozedUntil - (Date.now() + 60 * 60000)) < 5000);
  opts.onAction({}, 'open');
  assert.equal(t.memoWindows().length, 1);
  if (t.listWindow()) await t.call(t.listWindow(), 'close');
  opts.onAction({}, 'done');
  // #113: the file moves to 완료 under the same name.
  const doneFile = path.join(t.notes, '완료', '치과.md');
  await t.until(() => fs.existsSync(doneFile));
  assert.ok(fs.existsSync(doneFile));
  // No list window: a "완료 · 되돌리기" card replaces the reminder (same tag).
  await t.until(() => t.cards.length === 2);
  const doneCard = t.cards[1].events[0];
  assert.equal(doneCard.tag, 'memo-rem2');
  assert.equal(doneCard.title, '치과 완료');
  t.cards[1].opts.onAction({}, 'undo');
  await t.until(() => fs.existsSync(file));
  assert.ok(fs.existsSync(file));
  t.w.stop();
});

test('reminders older than 12 hours become one summary card', async () => {
  const t = setup();
  t.writeNote('하나', { id: 'mis1', fm: ['due: 2020-01-01'] });
  t.writeNote('둘', { id: 'mis2', fm: ['due: 2020-02-01 10:00'] });
  await started(t);
  assert.equal(t.cards.length, 1);
  assert.equal(t.cards[0].events[0].title, '지난 할 일 2개');
  assert.equal(t.cards[0].events[0].tag, 'memo-missed');
  t.cards[0].opts.onAction({}, 'list');
  await t.until(() => t.listWindow());
  assert.equal(t.state().listView, 'todo');
  t.w.stop();
});

test('a repeating note closed by 완료 opens again at its next reminder, at its place', async () => {
  const t = setup();
  const when = Date.now() - 60000;
  t.writeNote('월간 보고', { id: 'rep9', fm: [`due: ${stamp(when)}`, 'repeat: 매일'] });
  t.setState({ memos: { rep9: { reopen: true, open: false, bounds: { x: 300, y: 200, width: 260, height: 240 } } } });
  await started(t);
  assert.equal(t.memoWindows().length, 1);
  assert.deepEqual(t.memoWindows()[0].getBounds(), { x: 300, y: 200, width: 260, height: 240 });
  assert.equal(t.state().memos.rep9.reopen, false);
  t.w.stop();
});

test('without a notification engine nothing breaks', async () => {
  const t = setup();
  delete t.ctx.notify;
  t.writeNote('x', { id: 'none', fm: [`due: ${stamp(Date.now() - 60000)}`] });
  await t.w.start();
  t.w.stop();
});
