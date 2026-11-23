// Notices that may wait a week, and the same notice not piling up in one conversation (#129).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/settings');
const { setup, ready } = require('./setup');

const DAY = 86400000;

function clocked(start = Date.UTC(2026, 10, 9, 3)) {
  const clock = { now: start };
  const t = setup({}, { deps: { now: () => clock.now } });
  t.clock = clock;
  return t;
}

test('only the notices that may wait can be put off; safety, money and errors cannot', () => {
  assert.deepEqual(S.SNOOZABLE, ['folder-boundary', 'widget-tools', 'unverified-version']);
  assert.equal(S.SNOOZE_MS, 7 * DAY);
  const t = clocked();
  try {
    for (const kind of ['consent', 'budget', 'error', 'key', 'card', 'attach', 'leftover', '__proto__']) {
      assert.equal(t.call('snoozeNotice', kind), false, kind);
    }
    assert.deepEqual(t.fake.state().noticeSnooze, {});
  } finally {
    t.cleanup();
  }
});

test('"이번 주 그만 보기": hidden for 7 days, each kind on its own, then back', async () => {
  const t = clocked();
  try {
    assert.deepEqual((await t.call('state')).snoozed, {});
    assert.equal(t.call('snoozeNotice', 'widget-tools'), true);
    assert.deepEqual((await t.call('state')).snoozed, { 'widget-tools': true });
    t.clock.now += 3 * DAY;
    assert.equal(t.call('snoozeNotice', 'folder-boundary'), true);
    assert.deepEqual((await t.call('state')).snoozed, { 'folder-boundary': true, 'widget-tools': true });
    t.clock.now += 4 * DAY + 1000; // 7 days after the first
    assert.deepEqual((await t.call('state')).snoozed, { 'folder-boundary': true }, 'the first came back after a week');
    t.clock.now += 3 * DAY;
    assert.deepEqual((await t.call('state')).snoozed, {});
  } finally {
    t.cleanup();
  }
});

test('closing without the check stores nothing: the notice is back next time', async () => {
  // The window keeps "closed here" to itself; the widget only learns of a notice through snoozeNotice.
  const t = clocked();
  try {
    await t.call('state');
    assert.deepEqual((await t.call('state')).snoozed, {});
    assert.deepEqual(t.fake.state().noticeSnooze, {});
  } finally {
    t.cleanup();
  }
});

test('"안내 다시 보기" in the settings brings every notice back and tells the window', async () => {
  const t = clocked();
  try {
    t.call('snoozeNotice', 'widget-tools');
    t.call('snoozeNotice', 'unverified-version');
    const res = t.handlers.resetNotices();
    assert.equal(res.ok, true);
    assert.match(res.message, /다시 보이게/);
    assert.deepEqual((await t.call('state')).snoozed, {});
    const names = t.win.sent.map(([n]) => n);
    assert.ok(names.includes('noticesReset'));
    assert.ok(names.lastIndexOf('changed') > names.lastIndexOf('noticesReset'));
  } finally {
    t.cleanup();
  }
});

test('the stored value keeps only known kinds and numbers', () => {
  const v = S.sanitize({ noticeSnooze: { 'widget-tools': 123, 'folder-boundary': 'soon', budget: 999, 'unverified-version': Infinity } });
  assert.deepEqual(v.noticeSnooze, { 'widget-tools': 123 });
  assert.deepEqual(S.sanitize({}).noticeSnooze, {});
  assert.deepEqual(S.sanitize({ noticeSnooze: 'x' }).noticeSnooze, {});
});

test('widget tools off: said once in a conversation, not on every prompt; a new conversation says it again', async () => {
  const t = ready();
  try {
    const { sessionId } = t.send('하나');
    await t.doneOf(sessionId);
    t.send('둘', sessionId);
    await t.doneOf(sessionId, 2);
    t.send('셋', sessionId);
    await t.doneOf(sessionId, 3);
    const told = t.runs(sessionId).filter((e) => e.kind === 'widget-tools');
    assert.equal(told.length, 1);
    const log = (await t.call('open', sessionId)).items;
    assert.equal(log.filter((e) => e.k === 'meta' && e.text === told[0].message).length, 1);

    const other = t.send('다른 대화');
    await t.doneOf(other.sessionId);
    assert.equal(t.runs(other.sessionId).filter((e) => e.kind === 'widget-tools').length, 1);
  } finally {
    t.cleanup();
  }
});
