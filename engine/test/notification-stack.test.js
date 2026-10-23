const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationCenter, arrange, stackHeight, CARD } = require('../main/notifications');

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const card = (seq, extra = {}) => ({ seq, height: CARD.height, menuOpen: false, ...extra });
const seqs = (list) => list.map((c) => c.seq);

// ---------- the pure overflow rule ----------

test('arrange: under the maximum new cards go on top and nothing else moves', () => {
  const visible = [card(1), card(2)];
  const r = arrange({ visible, waiting: [], incoming: [card(3)], max: 3 });
  assert.deepEqual(seqs(r.visible), [1, 2, 3]);
  assert.deepEqual(r.waiting, []);
  assert.deepEqual(seqs(visible), [1, 2], 'inputs are not changed');
});

test('arrange: over the maximum the oldest visible card leaves and the new one shows at once', () => {
  const r = arrange({ visible: [card(1), card(2), card(3)], waiting: [], incoming: [card(4)], max: 3 });
  assert.deepEqual(seqs(r.visible), [2, 3, 4]);
  assert.deepEqual(seqs(r.waiting), [1]);
});

test('arrange: a freed slot takes back the most recently hidden card, at the bottom (LIFO)', () => {
  let r = arrange({ visible: [card(1), card(2), card(3)], incoming: [card(4)], max: 3 });
  r = arrange({ ...r, incoming: [card(5)], max: 3 });
  assert.deepEqual(seqs(r.visible), [3, 4, 5]);
  assert.deepEqual(seqs(r.waiting), [1, 2]);
  // Card 4 closes: card 2 (hidden last) returns below 3.
  r = arrange({ visible: r.visible.filter((c) => c.seq !== 4), waiting: r.waiting, max: 3 });
  assert.deepEqual(seqs(r.visible), [2, 3, 5]);
  assert.deepEqual(seqs(r.waiting), [1]);
});

test('arrange: a burst fills the slots with the newest cards, the older ones wait', () => {
  const r = arrange({ visible: [card(1)], incoming: [2, 3, 4, 5, 6].map((s) => card(s)), max: 3 });
  assert.deepEqual(seqs(r.visible), [4, 5, 6]);
  assert.deepEqual(seqs(r.waiting), [1, 2, 3], '3 was hidden last and comes back first');
});

test('arrange: a card with its menu open is never pushed out; the oldest one without a menu goes', () => {
  const r = arrange({ visible: [card(1, { menuOpen: true }), card(2), card(3)], incoming: [card(4)], max: 3 });
  assert.deepEqual(seqs(r.visible), [1, 3, 4]);
  assert.deepEqual(seqs(r.waiting), [2]);
  // When a slot frees, the waiting card goes back in age order (above the older open card).
  const back = arrange({ visible: [r.visible[0], r.visible[2]], waiting: r.waiting, max: 3 });
  assert.deepEqual(seqs(back.visible), [1, 2, 4]);
});

test('arrange: a taller card (menu open) pushes others out instead of overlapping off screen', () => {
  const room = stackHeight([CARD.height, CARD.height, CARD.height]); // exactly three standard cards
  const tall = card(3, { menuOpen: true, height: CARD.height + 100 });
  const r = arrange({ visible: [card(1), card(2), tall], max: 3, room });
  assert.deepEqual(seqs(r.visible), [2, 3]);
  assert.deepEqual(seqs(r.waiting), [1]);
  // Menu closed: the card shrinks and the hidden one returns.
  const closed = arrange({ visible: [r.visible[0], card(3)], waiting: r.waiting, max: 3, room });
  assert.deepEqual(seqs(closed.visible), [1, 2, 3]);
});

// ---------- the center with fake windows ----------

function setup({ max = 3, duration = 30 } = {}) {
  const handlers = new Map();
  const center = new NotificationCenter({
    getSettings: () => ({ notifyDurationSec: duration, notifyMaxVisible: max }),
    ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
  });
  center.workArea = () => workArea;
  const windows = [];
  center.createWindow = (entry) => {
    const win = {
      shown: false,
      destroyed: false,
      bounds: null,
      queue: null,
      isDestroyed: () => win.destroyed,
      showInactive: () => (win.shown = true),
      // Like the real 'closed' handler: only removes the card while this window is still its window.
      close: () => {
        win.destroyed = true;
        win.shown = false;
        if (entry.win === win) center.removeEntry(entry);
      },
      destroy: () => win.close(),
      setBounds: (b) => (win.bounds = b),
      setFocusable: () => {},
      focus: () => {},
      webContents: { send: (channel, payload) => channel === 'notification:queue' && (win.queue = payload) },
    };
    entry.ready = true; // page loaded at once
    windows.push(win);
    return win;
  };
  const call = (entry, channel, ...args) => handlers.get(channel)({ sender: entry.win.webContents }, ...args);
  const ids = (list) => list.map((e) => e.card.event.n);
  const events = (...ns) => ns.map((n) => ({ type: 'comment', n }));
  const cleanup = () => [...center.visible, ...center.waiting].forEach((e) => clearTimeout(e.timer));
  return { center, windows, call, ids, events, cleanup };
}

test('center: overflow hides the oldest card, closing brings it back at the bottom', () => {
  const { center, windows, call, ids, events, cleanup } = setup();
  try {
    center.push(events(1, 2, 3));
    const [first] = center.visible;
    assert.ok(first.timer, 'visible cards count down');
    center.push(events(4));
    assert.deepEqual(ids(center.visible), [2, 3, 4]);
    assert.deepEqual(ids(center.waiting), [1]);
    const oldWin = windows[0];
    assert.equal(first.win, null, 'a waiting card keeps no window');
    assert.equal(oldWin.destroyed, true);
    assert.ok(center.sources.has(first.card.id), 'but keeps its widget source');
    assert.equal(first.timer, null, 'a hidden card does not count down');
    assert.equal(first.remaining, null);

    // Newest on top: the bottom slot belongs to the oldest visible card.
    const [bottom, , top] = center.visible;
    assert.ok(top.win.bounds.y < bottom.win.bounds.y);
    assert.equal(bottom.win.bounds.y, workArea.height - CARD.margin - CARD.height);
    // "+N 대기" goes to the bottom card only.
    assert.equal(bottom.win.queue, 1);
    assert.equal(top.win.queue, 0);

    call(top, 'notification:dismiss');
    assert.deepEqual(ids(center.visible), [1, 2, 3]);
    assert.deepEqual(center.waiting, []);
    assert.ok(first.win && first.win !== oldWin, 'comes back in a new window');
    assert.equal(first.win.shown, true);
    assert.ok(center.sources.has(first.card.id));
    assert.ok(first.timer, 'its countdown starts over');
    assert.equal(first.win.bounds.y, workArea.height - CARD.margin - CARD.height, 'back at the bottom');
  } finally {
    cleanup();
  }
});

test('center: waiting cards are kept; dismiss-all closes visible and waiting cards', async () => {
  const { center, windows, call, events, cleanup } = setup({ max: 2 });
  try {
    center.push(events(1, 2, 3, 4, 5));
    assert.equal(center.visible.length, 2);
    assert.equal(center.waiting.length, 3);
    assert.equal(windows.length, 2, 'cards that never showed have no window yet');
    assert.equal((await call(center.visible[0], 'notification:get')).waiting, 3);
    call(center.visible[0], 'notification:dismiss-all');
    assert.deepEqual(center.visible, []);
    assert.deepEqual(center.waiting, []);
    assert.equal(center.sources.size, 0);
    assert.ok(windows.every((w) => w.destroyed));
  } finally {
    cleanup();
  }
});

test('center: an open menu keeps its card on screen when new cards arrive', async () => {
  const { center, call, ids, events, cleanup } = setup();
  try {
    center.push(events(1, 2, 3));
    const first = center.visible[0];
    await call(first, 'notification:menu-open', true, 40);
    center.push(events(4));
    assert.deepEqual(ids(center.visible), [1, 3, 4]);
    assert.deepEqual(ids(center.waiting), [2]);
    // No overlap with the taller card.
    const [a, b] = center.visible;
    assert.equal(a.win.bounds.height, CARD.height + 40);
    assert.ok(b.win.bounds.y + b.win.bounds.height + CARD.gap <= a.win.bounds.y);
  } finally {
    cleanup();
  }
});

test('center: away pauses only visible cards; hidden cards stay stopped', () => {
  const { center, events, cleanup } = setup({ max: 1 });
  try {
    center.push(events(1, 2));
    const [hidden] = center.waiting;
    center.setAway(true);
    assert.equal(center.visible[0].timer, null);
    center.setAway(false);
    assert.ok(center.visible[0].timer);
    assert.equal(hidden.timer, null);
  } finally {
    cleanup();
  }
});

test('center: dismissing a visible card keeps the waiting ones (with their sources)', () => {
  const { center, call, ids, events, cleanup } = setup({ max: 2 });
  try {
    center.push(events(1, 2, 3, 4));
    assert.deepEqual(ids(center.waiting), [1, 2]);
    call(center.visible[1], 'notification:dismiss');
    assert.deepEqual(ids(center.visible), [2, 3]);
    assert.deepEqual(ids(center.waiting), [1]);
    assert.ok(center.sources.has(center.waiting[0].card.id));
    assert.equal(center.waiting[0].win, null);
    assert.equal(center.sources.size, 3);
  } finally {
    cleanup();
  }
});
