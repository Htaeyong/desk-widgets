const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationCenter, stackLayout, stackPositions, CARD, MAX_MENU_HEIGHT } = require('../main/notifications');

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

test('stack layout: a taller card (menu open) pushes the older cards up', () => {
  const plain = stackLayout([CARD.height, CARD.height], workArea);
  assert.deepEqual(
    plain.map(({ x, y }) => ({ x, y })),
    stackPositions(2, workArea)
  );
  const tall = stackLayout([CARD.height + 100, CARD.height], workArea);
  assert.equal(tall[0].height, CARD.height + 100);
  assert.equal(tall[0].y, plain[0].y - 100); // the newest card grows upwards
  assert.equal(tall[1].y, plain[1].y - 100); // and the one above moves up by the same amount
  assert.equal(tall[1].y + tall[1].height + CARD.gap, tall[0].y); // no overlap
});

// A center with fake IPC and windows; cards are put on screen directly (no BrowserWindow).
function setup({ menu, duration = 30 } = {}) {
  const handlers = new Map();
  const center = new NotificationCenter({
    getSettings: () => ({ notifyDurationSec: duration, notifyMaxVisible: 3 }),
    ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
  });
  center.workArea = () => workArea;
  const calls = [];
  const sent = [];
  const addCard = (card) => {
    const sender = { id: Math.random() };
    const win = {
      focusable: false,
      bounds: null,
      isDestroyed: () => false,
      setFocusable: (v) => (win.focusable = v),
      focus: () => calls.push('focus'),
      setBounds: (b) => (win.bounds = b),
      webContents: { ...sender, send: (channel, payload) => sent.push([channel, payload]) },
    };
    const entry = { seq: ++center.seq, card, win, ready: true, timer: null, remaining: null, startedAt: 0, hovered: false, menuOpen: false, height: CARD.height };
    center.sources.set(card.id, { openUrl: async () => true, showWidget: () => {}, menu });
    center.visible.push(entry);
    return { entry, call: (channel, ...args) => handlers.get(channel)({ sender: win.webContents }, ...args) };
  };
  return { center, addCard, calls, sent };
}

const taskEvent = { type: 'comment', task: { id: 't1', subject: 'x' } };

function fakeMenu(log) {
  let items = [{ id: 'a', label: 'A', color: '#ff0000', checked: false }];
  return {
    label: '분류',
    appliesTo: (event) => event.type !== 'rule',
    items: () => items,
    toggle: (event, id, checked) => {
      log.push(['toggle', event.task.id, id, checked]);
      items = items.map((i) => (i.id === id ? { ...i, checked } : i));
      return items;
    },
    create: {
      placeholder: '새 분류',
      run: (event, name) => {
        if (name === 'dup') throw new Error('같은 이름의 분류가 이미 있습니다.');
        items = [...items, { id: 'b', label: name, checked: true }];
        return items;
      },
    },
  };
}

test('card menu: offered only for cards the widget accepts, with its items', async () => {
  const log = [];
  const { addCard } = setup({ menu: fakeMenu(log) });
  const withMenu = addCard({ id: 'n1', kind: 'event', event: taskEvent });
  const rule = addCard({ id: 'n2', kind: 'event', event: { type: 'rule' } });
  const summary = addCard({ id: 'n3', kind: 'summary', count: 12, samples: [] });
  const got = await withMenu.call('notification:get');
  assert.deepEqual(got.menu, { label: '분류', placeholder: '새 분류', items: [{ id: 'a', label: 'A', color: '#ff0000', checked: false }] });
  assert.equal((await rule.call('notification:get')).menu, null);
  assert.equal((await summary.call('notification:get')).menu, null);
  assert.equal((await rule.call('notification:menu-toggle', 'a', true)).ok, false);
});

test('card menu: toggle and create go to the widget with the card\'s event; errors come back as messages', async () => {
  const log = [];
  const { addCard } = setup({ menu: fakeMenu(log) });
  const { call } = addCard({ id: 'n1', kind: 'event', event: taskEvent });
  const toggled = await call('notification:menu-toggle', 'a', true);
  assert.equal(toggled.ok, true);
  assert.equal(toggled.items[0].checked, true);
  assert.deepEqual(log, [['toggle', 't1', 'a', true]]);
  assert.equal((await call('notification:menu-create', '  새것 ')).items[1].label, '새것');
  assert.deepEqual(await call('notification:menu-create', 'dup'), { ok: false, message: '같은 이름의 분류가 이미 있습니다.' });
  assert.deepEqual(await call('notification:menu-create', '   '), { ok: false, message: '이름을 입력하세요.' });
});

test('card menu: opening grows the card (capped), takes focus and pauses only its own countdown', async () => {
  const { center, addCard, calls } = setup({ menu: fakeMenu([]), duration: 30 });
  const a = addCard({ id: 'n1', kind: 'event', event: taskEvent });
  const b = addCard({ id: 'n2', kind: 'event', event: taskEvent });
  try {
    center.startTimer(a.entry);
    center.startTimer(b.entry);
    assert.ok(a.entry.timer && b.entry.timer);

    assert.equal(await a.call('notification:menu-open', true, 120), CARD.height + 120);
    assert.equal(a.entry.win.focusable, true);
    assert.deepEqual(calls, ['focus']);
    assert.equal(a.entry.timer, null); // paused while the menu is open
    assert.ok(b.entry.timer); // the other card keeps counting
    assert.equal(a.entry.win.bounds.height, CARD.height + 120);

    // Leaving the card while the menu is open does not restart the countdown.
    await a.call('notification:hover', false);
    assert.equal(a.entry.timer, null);

    assert.equal(await a.call('notification:menu-open', true, 5000), CARD.height + MAX_MENU_HEIGHT);

    assert.equal(await a.call('notification:menu-open', false), CARD.height);
    assert.equal(a.entry.win.focusable, false);
    assert.ok(a.entry.timer); // resumed
  } finally {
    for (const e of center.visible) clearTimeout(e.timer);
  }
});

// ---------- #71: the same menu on generic cards (engine API 1.4) ----------

const genericCard = (id, extra = {}) => ({ id, kind: 'card', event: { type: 'card', title: '김부장', body: '회의', tag: `mail:${id}`, actions: [], sticky: false, sound: false, icon: null, ...extra } });

test('card menu on generic cards: items, toggle and create get the cleaned card (tag identifies it)', async () => {
  const log = [];
  const menu = {
    label: '분류',
    appliesTo: (event) => String(event.tag).startsWith('mail:'),
    items: (event) => (log.push(['items', event.tag]), [{ id: 'a', label: 'A', color: '#00ff00', checked: false }]),
    toggle: (event, id, checked) => (log.push(['toggle', event.tag, id, checked]), [{ id: 'a', label: 'A', checked }]),
    create: { placeholder: '새 분류', run: (event, name) => (log.push(['create', event.tag, name]), [{ id: 'b', label: name, checked: true }]) },
  };
  const { addCard } = setup({ menu });
  const card = addCard(genericCard('n1'));
  const other = addCard(genericCard('n2', { tag: 'timer' }));
  assert.deepEqual((await card.call('notification:get')).menu, { label: '분류', placeholder: '새 분류', items: [{ id: 'a', label: 'A', color: '#00ff00', checked: false }] });
  assert.equal((await other.call('notification:get')).menu, null);
  assert.deepEqual(await card.call('notification:menu-toggle', 'a', true), { ok: true, items: [{ id: 'a', label: 'A', checked: true }] });
  assert.deepEqual(await card.call('notification:menu-create', '  새것 '), { ok: true, items: [{ id: 'b', label: '새것', checked: true }] });
  assert.deepEqual((await other.call('notification:menu-toggle', 'a', true)).ok, false, 'no menu on that card');
  assert.deepEqual(log.filter((l) => l[0] !== 'items'), [['toggle', 'mail:n1', 'a', true], ['create', 'mail:n1', '새것']]);
});

test('card menu on generic cards: grows, focuses, pauses its countdown; a sticky card stays without one', async () => {
  const { center, addCard } = setup({ menu: { label: '분류', items: () => [], toggle: () => [] }, duration: 30 });
  const plain = addCard(genericCard('n1'));
  const sticky = addCard(genericCard('n2', { sticky: true }));
  try {
    center.startTimer(plain.entry);
    assert.ok(plain.entry.timer);
    assert.equal(await plain.call('notification:menu-open', true, 80), CARD.height + 80);
    assert.equal(plain.entry.win.focusable, true);
    assert.equal(plain.entry.timer, null);
    assert.equal(await plain.call('notification:menu-open', false), CARD.height);
    assert.ok(plain.entry.timer, 'resumed');
    assert.equal(await sticky.call('notification:menu-open', true, 80), CARD.height + 80);
    assert.equal(await sticky.call('notification:menu-open', false), CARD.height);
    assert.equal(sticky.entry.timer, null, 'a sticky card still never counts down');
  } finally {
    for (const e of center.visible) clearTimeout(e.timer);
  }
});

test('card menu on generic cards: a hidden (waiting, #42) card cannot open its menu', async () => {
  const { center, addCard } = setup({ menu: { label: '분류', items: () => [], toggle: () => [] } });
  const card = addCard(genericCard('n1'));
  center.visible = center.visible.filter((e) => e !== card.entry);
  center.waiting.push(card.entry);
  assert.equal(await card.call('notification:menu-open', true, 80), CARD.height);
  assert.equal(card.entry.menuOpen, false);
});

test('Dooray task cards: the menu behaves exactly as before (summary cards never, rules filtered by appliesTo)', async () => {
  const { addCard } = setup({ menu: fakeMenu([]) });
  assert.ok((await addCard({ id: 'd1', kind: 'event', event: taskEvent }).call('notification:get')).menu);
  assert.equal((await addCard({ id: 'd2', kind: 'event', event: { type: 'rule' } }).call('notification:get')).menu, null);
  assert.equal((await addCard({ id: 'd3', kind: 'summary', count: 9, samples: [] }).call('notification:get')).menu, null);
});
