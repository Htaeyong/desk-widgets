const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotificationCenter,
  normalizeCard,
  normalizeIcon,
  planCards,
  autoCloseMs,
  findAction,
  keepsOpen,
  SUMMARY_THRESHOLD,
  MAX_ICON_DATA,
} = require('../main/notifications');

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const taskEvent = (n) => ({ type: 'status', task: { id: `t${n}`, subject: `업무 ${n}` } });

// ---------- normalizeCard / normalizeIcon ----------

test('generic card: fields are cleaned and defaults filled in', () => {
  assert.deepEqual(normalizeCard({ type: 'card', title: '  타이머\n종료  ' }), {
    type: 'card',
    title: '타이머 종료',
    body: '',
    icon: null,
    actions: [],
    sticky: false,
    sound: false,
    tag: null,
  });
  const full = normalizeCard({ type: 'card', title: 'A', body: 'B', icon: 'alarm', sticky: true, sound: true, tag: 'timer', actions: [{ id: 'x', label: '다시' }] });
  assert.equal(full.body, 'B');
  assert.deepEqual(full.icon, { name: 'alarm' });
  assert.equal(full.sticky, true);
  assert.equal(full.sound, true);
  assert.equal(full.tag, 'timer');
  assert.deepEqual(full.actions, [{ id: 'x', label: '다시' }]);
});

test('generic card: no title, or not a card, cannot be shown', () => {
  assert.equal(normalizeCard({ type: 'card' }), null);
  assert.equal(normalizeCard({ type: 'card', title: '   ' }), null);
  assert.equal(normalizeCard({ type: 'status', title: 'x' }), null);
  assert.equal(normalizeCard(null), null);
});

test('generic card: only real true turns on sticky/sound; long text is cut', () => {
  const c = normalizeCard({ type: 'card', title: 'x'.repeat(500), body: 'y'.repeat(1000), sticky: 'yes', sound: 1 });
  assert.equal(c.title.length, 120);
  assert.equal(c.body.length, 300);
  assert.equal(c.sticky, false);
  assert.equal(c.sound, false);
});

test('generic card: actions need an id and label, no duplicates, at most three', () => {
  const c = normalizeCard({
    type: 'card',
    title: 'x',
    actions: [{ id: 'a', label: 'A' }, { id: 'a', label: 'again' }, { id: '', label: 'no id' }, { id: 'b' }, null, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }, { id: 'e', label: 'E' }],
  });
  assert.deepEqual(c.actions.map((a) => a.id), ['a', 'c', 'd']);
  assert.deepEqual(normalizeCard({ type: 'card', title: 'x', actions: 'nope' }).actions, []);
});

test('generic card icon: built-in name, emoji or a capped image data URL; nothing that loads elsewhere', () => {
  assert.deepEqual(normalizeIcon('timer'), { name: 'timer' });
  assert.deepEqual(normalizeIcon('🍅'), { emoji: '🍅' });
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(normalizeIcon(png), { src: png });
  assert.equal(normalizeIcon('data:image/png;base64,' + 'A'.repeat(MAX_ICON_DATA)), null, 'too big');
  assert.equal(normalizeIcon('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.equal(normalizeIcon('data:image/svg+xml,<svg onload=alert(1)>'), null, 'base64 only');
  assert.equal(normalizeIcon('https://example.com/a.png'), null);
  assert.equal(normalizeIcon('C:\\x.png'), null);
  assert.equal(normalizeIcon('icon.png'), null);
  assert.equal(normalizeIcon('unknown-name'), null);
  assert.equal(normalizeIcon(''), null);
  assert.equal(normalizeIcon({ src: 'x' }), null);
});

// ---------- planCards: which events collapse into the summary ----------

test('planCards: few task events get their own cards', () => {
  const cards = planCards([taskEvent(1), taskEvent(2)]);
  assert.deepEqual(cards.map((c) => c.kind), ['event', 'event']);
});

test('planCards: many task events collapse, rules and generic cards never do', () => {
  const tasks = Array.from({ length: SUMMARY_THRESHOLD + 1 }, (_, i) => taskEvent(i));
  const generic = Array.from({ length: SUMMARY_THRESHOLD + 1 }, (_, i) => ({ type: 'card', title: `알람 ${i}` }));
  const cards = planCards([...tasks, { type: 'rule', rule: {} }, ...generic]);
  const kinds = cards.map((c) => c.kind);
  assert.equal(kinds.filter((k) => k === 'summary').length, 1);
  assert.equal(kinds.filter((k) => k === 'card').length, SUMMARY_THRESHOLD + 1);
  assert.equal(kinds.filter((k) => k === 'event').length, 1, 'the rule');
  assert.equal(cards.find((c) => c.kind === 'summary').count, SUMMARY_THRESHOLD + 1, 'only task events are counted');
});

test('planCards: generic cards alone never make a summary; invalid ones are dropped', () => {
  const generic = Array.from({ length: SUMMARY_THRESHOLD + 5 }, (_, i) => ({ type: 'card', title: `${i}` }));
  const cards = planCards([...generic, { type: 'card' }, null]);
  assert.equal(cards.length, SUMMARY_THRESHOLD + 5);
  assert.ok(cards.every((c) => c.kind === 'card'));
});

// ---------- sticky timer decision ----------

test('autoCloseMs: sticky generic cards stay; everything else follows the engine setting', () => {
  const sticky = { kind: 'card', event: normalizeCard({ type: 'card', title: 'x', sticky: true }) };
  const plain = { kind: 'card', event: normalizeCard({ type: 'card', title: 'x' }) };
  const dooray = { kind: 'event', event: { type: 'status', sticky: true } };
  assert.equal(autoCloseMs(sticky, 30), 0);
  assert.equal(autoCloseMs(plain, 30), 30000);
  assert.equal(autoCloseMs(plain, 0), 0, '"until confirmed" setting');
  assert.equal(autoCloseMs(dooray, 30), 30000, 'sticky is a generic card field only');
  assert.equal(autoCloseMs({ kind: 'summary' }, 5), 5000);
});

// ---------- action routing ----------

test('findAction / keepsOpen: only the card\'s own buttons; keepOpen must be explicit', () => {
  const card = { kind: 'card', event: normalizeCard({ type: 'card', title: 'x', actions: [{ id: 'snooze', label: '다시' }] }) };
  assert.deepEqual(findAction(card, 'snooze'), { id: 'snooze', label: '다시' });
  assert.equal(findAction(card, 'other'), null);
  assert.equal(findAction({ kind: 'event', event: { actions: [{ id: 'snooze' }] } }, 'snooze'), null);
  assert.equal(keepsOpen({ keepOpen: true }), true);
  assert.equal(keepsOpen(undefined), false);
  assert.equal(keepsOpen(false), false);
  assert.equal(keepsOpen({ keepOpen: 'yes' }), false);
});

// ---------- NotificationCenter with fake windows ----------

function setup({ duration = 30, max = 3 } = {}) {
  const handlers = new Map();
  const center = new NotificationCenter({
    getSettings: () => ({ notifyDurationSec: duration, notifyMaxVisible: max }),
    ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
  });
  center.workArea = () => workArea;
  const sent = [];
  center.createWindow = (entry) => {
    let destroyed = false;
    const win = {
      isDestroyed: () => destroyed,
      showInactive: () => {},
      setBounds: () => {},
      setFocusable: () => {},
      focus: () => {},
      destroy: () => (destroyed = true),
      close: () => {
        destroyed = true;
        if (entry.win === win) center.removeEntry(entry);
      },
      webContents: { send: (channel, payload) => sent.push([entry.card.id, channel, payload]) },
    };
    entry.ready = true; // as if 'ready-to-show' fired
    return win;
  };
  const call = (entry, channel, ...args) => handlers.get(channel)({ sender: entry.win.webContents }, ...args);
  const all = () => [...center.visible, ...center.waiting];
  return { center, sent, call, all };
}

const widget = { id: 'clock', name: '시계' };

test('push: a generic card shows the sending widget\'s name; the widget menu since engine API 1.4 (#71), appliesTo decides', async () => {
  const { center, call } = setup();
  const menu = { label: '분류', appliesTo: (event) => String(event.tag || '').startsWith('mail:'), items: () => [{ id: 'c1', label: '중요', checked: false }], toggle: () => [] };
  center.push([{ type: 'card', title: '타이머 종료', tag: 'timer' }, { type: 'card', title: '김부장', tag: 'mail:a:1' }], { widget, menu });
  try {
    const timer = center.visible.find((e) => e.card.event.tag === 'timer');
    const mail = center.visible.find((e) => e.card.event.tag === 'mail:a:1');
    const got = await call(timer, 'notification:get');
    assert.equal(got.card.kind, 'card');
    assert.equal(got.card.widgetName, '시계');
    assert.equal(got.card.event.title, '타이머 종료');
    assert.equal(got.menu, null, 'appliesTo said no');
    assert.deepEqual((await call(mail, 'notification:get')).menu, { label: '분류', placeholder: null, items: [{ id: 'c1', label: '중요', checked: false }] });
  } finally {
    center.dismissAll();
  }
});

test('push: a generic card without a menu, or a summary of Dooray events, still has none', async () => {
  const { center, call } = setup();
  center.push([{ type: 'card', title: 'x' }], { widget });
  try {
    assert.equal((await call(center.visible[0], 'notification:get')).menu, null);
  } finally {
    center.dismissAll();
  }
});

test('push: sticky cards get no countdown, plain ones follow the setting', () => {
  const { center, sent } = setup({ duration: 30 });
  center.push([{ type: 'card', title: 'a', sticky: true }, { type: 'card', title: 'b' }], { widget });
  try {
    const [sticky, plain] = center.visible;
    assert.equal(sticky.timer, null);
    assert.ok(plain.timer);
    const timerOf = (id) => sent.filter(([cid, ch]) => cid === id && ch === 'notification:timer').pop()[2];
    assert.equal(timerOf(sticky.card.id).durationMs, 0);
    assert.equal(timerOf(plain.card.id).durationMs, 30000);
  } finally {
    center.dismissAll();
  }
});

test('push: generic cards follow the shared overflow rule (newest on top, oldest waits)', () => {
  const { center } = setup({ max: 2 });
  center.push([{ type: 'card', title: '1' }], { widget });
  center.push([{ type: 'card', title: '2' }], { widget });
  center.push([{ type: 'card', title: '3', sticky: true }], { widget });
  try {
    assert.deepEqual(center.visible.map((e) => e.card.event.title), ['2', '3']);
    assert.deepEqual(center.waiting.map((e) => e.card.event.title), ['1']);
    assert.equal(center.waiting[0].win, null, 'a waiting card keeps no window');
  } finally {
    center.dismissAll();
  }
});

test('sound: plays once when first shown, waits while the user is away', () => {
  const { center, sent } = setup({ max: 1 });
  const sounds = () => sent.filter(([, ch]) => ch === 'notification:sound').map(([id]) => id);
  center.push([{ type: 'card', title: 'a', sound: true }], { widget });
  const a = center.visible[0];
  assert.deepEqual(sounds(), [a.card.id]);
  // Pushed out and back: no second beep.
  center.push([{ type: 'card', title: 'b' }], { widget });
  center.dismiss(center.visible[0]);
  assert.equal(center.visible[0], a);
  assert.deepEqual(sounds(), [a.card.id]);

  center.setAway(true);
  center.push([{ type: 'card', title: 'c', sound: true }], { widget });
  const c = center.visible[0];
  assert.deepEqual(sounds(), [a.card.id], 'no beep while away');
  center.setAway(false);
  assert.deepEqual(sounds(), [a.card.id, c.card.id], 'beeps when the user is back');
  center.dismissAll();
});

test('action: calls the widget with the card\'s event, then closes unless kept open', async () => {
  const { center, call, all } = setup();
  const log = [];
  const onAction = (event, id) => {
    log.push([event.title, id]);
    if (id === 'keep') return { keepOpen: true };
    if (id === 'fail') throw new Error('실패했습니다.');
    return undefined;
  };
  const actions = [
    { id: 'snooze', label: '다시' },
    { id: 'keep', label: '유지' },
    { id: 'fail', label: '오류' },
  ];
  center.push([{ type: 'card', title: '알람', actions }], { widget, onAction });
  const [entry] = center.visible;

  assert.deepEqual(await call(entry, 'notification:action', 'keep'), { ok: true, keepOpen: true });
  assert.equal(all().length, 1);
  assert.deepEqual(await call(entry, 'notification:action', 'fail'), { ok: false, message: '실패했습니다.' });
  assert.equal(all().length, 1, 'an error keeps the card so the message can be read');
  assert.equal((await call(entry, 'notification:action', 'forged')).ok, false);
  assert.deepEqual(log, [['알람', 'keep'], ['알람', 'fail']], 'unknown ids never reach the widget');

  assert.deepEqual(await call(entry, 'notification:action', 'snooze'), { ok: true, keepOpen: false });
  assert.equal(all().length, 0);
});

test('action: without onAction a button just closes the card; open does nothing on generic cards', async () => {
  const { center, call, all } = setup();
  center.push([{ type: 'card', title: 'x', actions: [{ id: 'ok', label: 'OK' }] }], { widget });
  const [entry] = center.visible;
  await call(entry, 'notification:open');
  assert.equal(all().length, 1);
  await call(entry, 'notification:action', 'ok');
  assert.equal(all().length, 0);
});

test('tag: a new card replaces the same widget\'s card with that tag, on screen or waiting', () => {
  const { center, all } = setup({ max: 1 });
  center.push([{ type: 'card', title: 'old', tag: 'timer' }], { widget });
  center.push([{ type: 'card', title: 'other' }], { widget });
  center.push([{ type: 'card', title: 'not mine', tag: 'timer' }], { widget: { id: 'dooray', name: '두레이' } });
  assert.equal(all().length, 3);
  center.push([{ type: 'card', title: 'new', tag: 'timer' }], { widget });
  try {
    const titles = all().map((e) => e.card.event.title).sort();
    assert.deepEqual(titles, ['new', 'not mine', 'other']);
    assert.equal(center.sources.size, 3, 'the replaced card\'s source is gone');
  } finally {
    center.dismissAll();
  }
});

test('Dooray events keep their old path: event cards and a summary, no generic fields', () => {
  const { center } = setup({ max: 20 });
  center.push([taskEvent(1), { type: 'rule', rule: {} }], { widget: { id: 'dooray', name: '두레이' } });
  try {
    assert.deepEqual(center.visible.map((e) => e.card.kind), ['event', 'event']);
    assert.ok(center.visible.every((e) => !('widgetName' in e.card) && e.soundPending === false));
  } finally {
    center.dismissAll();
  }
});
