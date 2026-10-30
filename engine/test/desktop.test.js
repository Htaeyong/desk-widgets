const test = require('node:test');
const assert = require('node:assert/strict');
const { DesktopKeeper, shouldRaise } = require('../main/desktop');

test('raise only when the desktop newly becomes the foreground window', () => {
  assert.deepEqual(shouldRaise(false, 'WorkerW'), { onDesktop: true, raise: true });
  assert.deepEqual(shouldRaise(true, 'WorkerW'), { onDesktop: true, raise: false }, 'still on desktop');
  assert.deepEqual(shouldRaise(false, 'Progman'), { onDesktop: true, raise: true });
  assert.deepEqual(shouldRaise(true, 'Chrome_WidgetWin_1'), { onDesktop: false, raise: false });
});

test('keeper raises visible, non-pinned widgets above the desktop on Win+D', () => {
  let cls = 'Chrome_WidgetWin_1';
  const user32 = {
    GetForegroundWindow: () => 1,
    GetClassNameW: (_h, buf) => buf.write(cls, 'utf16le') / 2,
  };
  const moved = [];
  const win = (name, { pinned = false, visible = true } = {}) => ({
    isDestroyed: () => false,
    isVisible: () => visible,
    isAlwaysOnTop: () => pinned,
    // raise() passes through topmost and back; record the round trip once.
    setAlwaysOnTop: (on) => on && moved.push(name),
  });
  let enabled = true;
  const keeper = new DesktopKeeper({
    getWindows: () => [win('overview'), win('pinned', { pinned: true }), win('hidden', { visible: false })],
    isEnabled: () => enabled,
    user32,
  });

  keeper.check();
  assert.deepEqual(moved, [], 'app in front: nothing to do');
  cls = 'WorkerW';
  keeper.check();
  assert.deepEqual(moved, ['overview'], 'only the visible, non-pinned widget');
  keeper.check();
  assert.deepEqual(moved, ['overview'], 'not again while the desktop stays in front');

  cls = 'Notepad';
  keeper.check();
  enabled = false;
  cls = 'WorkerW';
  keeper.check();
  assert.deepEqual(moved, ['overview'], 'disabled in settings');
});

const { DesktopAnchor, wantedOwner } = require('../main/desktop');

test('anchor: desktop owns unpinned widgets; pinned or disabled ones have no owner', () => {
  assert.equal(wantedOwner({ enabled: true, pinned: false, desktop: 100 }), 100);
  assert.equal(wantedOwner({ enabled: true, pinned: true, desktop: 100 }), 0);
  assert.equal(wantedOwner({ enabled: false, pinned: false, desktop: 100 }), 0);
  assert.equal(wantedOwner({ enabled: true, pinned: false, desktop: 0 }), 0, 'no desktop window');
  assert.equal(wantedOwner({ enabled: true, pinned: false, focused: true, desktop: 100 }), 0, 'active widget is not owned');
});

test('anchor sync re-attaches after the desktop window changes (Explorer restart)', () => {
  let desktop = 100;
  let foreground = 0;
  const owners = new Map();
  const user32 = {
    FindWindowW: () => desktop,
    GetForegroundWindow: () => foreground,
    GetWindowLongPtrW: (h) => owners.get(h) || 0,
    SetWindowLongPtrW: (h, _i, v) => owners.set(h, v),
    SetWindowPos: () => true,
  };
  const win = (hwnd, pinned = false) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(hwnd));
    return { isDestroyed: () => false, isAlwaysOnTop: () => pinned, getNativeWindowHandle: () => buf };
  };
  let enabled = true;
  const wins = [win(1), win(2, true)];
  const anchor = new DesktopAnchor({ getWindows: () => wins, isEnabled: () => enabled, user32 });

  anchor.sync();
  assert.deepEqual([owners.get(1), owners.get(2) || 0], [100, 0]);

  // Explorer restarted: the old owner link is gone and the desktop has a new handle.
  owners.set(1, 0);
  desktop = 200;
  anchor.sync();
  assert.equal(owners.get(1), 200);

  // The active widget has no owner (Win+D would otherwise hand activation back to it), and gets
  // the desktop again once something else is in the foreground.
  foreground = 1;
  anchor.sync();
  assert.equal(owners.get(1), 0, 'active widget');
  foreground = 0;
  anchor.sync();
  assert.equal(owners.get(1), 200, 'not active any more');

  enabled = false;
  anchor.sync();
  assert.equal(owners.get(1), 0, 'mode switched off');
});

const { zOrderMoves } = require('../main/desktop');

test('anchor #116: other widgets go back under the window they were under', () => {
  // App 10 was in front; widget 2 under it, widget 3 under app 11. Clicking widget 1 raised the whole group.
  const before = [10, 2, 1, 11, 3];
  const after = [1, 2, 3, 10, 11];
  assert.deepEqual(zOrderMoves({ before, after, widgets: [2, 3], clicked: 1 }), [
    [2, 10],
    [3, 11],
  ]);
});

test('anchor #116: zOrderMoves keeps widgets that were on top, skips gone windows and no-ops', () => {
  // Widget 2 was above every app: nothing to put it under, it stays.
  assert.deepEqual(zOrderMoves({ before: [2, 10, 1], after: [1, 2, 10], widgets: [2], clicked: 1 }), []);
  // The clicked widget is not a place to go back to: widget 3 was right under it, so it goes under app 10.
  assert.deepEqual(zOrderMoves({ before: [10, 1, 3], after: [1, 3, 10], widgets: [3], clicked: 1 }), [[3, 10]]);
  // App 11 closed since: widget 3 goes under the next window above it.
  assert.deepEqual(zOrderMoves({ before: [10, 11, 3], after: [1, 3, 10], widgets: [3], clicked: 1 }), [[3, 10]]);
  // Already in place: no call.
  assert.deepEqual(zOrderMoves({ before: [10, 3], after: [1, 10, 3], widgets: [3], clicked: 1 }), []);
  // Two widgets under the same app keep their order.
  assert.deepEqual(zOrderMoves({ before: [10, 2, 3], after: [1, 2, 3, 10], widgets: [2, 3], clicked: 1 }), [
    [2, 10],
    [3, 2],
  ]);
  // A widget opened after the snapshot is left alone.
  assert.deepEqual(zOrderMoves({ before: [10], after: [1, 4, 10], widgets: [4], clicked: 1 }), []);
});

/** A fake user32 with a z-order list (top first), owners and window classes. */
function fakeDesktop({ order, classes = {}, desktop = 100 }) {
  const owners = new Map();
  const calls = [];
  const z = [...order];
  const user32 = {
    fg: 0,
    FindWindowW: () => desktop,
    GetForegroundWindow: () => user32.fg,
    GetClassNameW: (h, buf) => buf.write(classes[h] || 'App', 'utf16le') / 2,
    GetWindowLongPtrW: (h, i) => (i === -8 ? owners.get(h) || 0 : 0),
    SetWindowLongPtrW: (h, _i, v) => owners.set(h, v),
    GetTopWindow: () => z[0] || 0,
    GetWindow: (h) => z[z.indexOf(h) + 1] || 0,
    IsWindowVisible: () => true,
    SetWindowPos: (h, after, _x, _y, _cx, _cy, flags) => {
      calls.push([h, after, flags]);
      // Model: like Windows, without SWP_NOOWNERZORDER a z-move drags every desktop-owned window along.
      const group = flags & 0x200 || !owners.get(h) ? [h] : z.filter((w) => owners.get(w) === desktop && w !== h).concat(h);
      const moving = after === 0 ? [h, ...group.filter((w) => w !== h)] : group;
      for (const w of moving) z.splice(z.indexOf(w), 1);
      const at = after === 0 ? 0 : after === 1 ? z.indexOf(desktop) : z.indexOf(after) + 1;
      z.splice(at, 0, ...moving);
      return true;
    },
  };
  return { user32, owners, calls, z };
}

const fakeWin = (hwnd, pinned = false) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(hwnd));
  return { isDestroyed: () => false, isAlwaysOnTop: () => pinned, getNativeWindowHandle: () => buf };
};

test('anchor #116: a click on one widget leaves the others under the app', () => {
  // z-order: app 10 in front, widgets 1-3 under it, desktop 100 at the bottom; widget 4 is pinned (topmost).
  const { user32, owners, z } = fakeDesktop({ order: [10, 1, 2, 3, 100] });
  const wins = [fakeWin(1), fakeWin(2), fakeWin(3), fakeWin(4, true)];
  const anchor = new DesktopAnchor({ getWindows: () => wins, isEnabled: () => true, user32 });
  user32.fg = 10;
  anchor.sync();
  assert.deepEqual([owners.get(1), owners.get(2), owners.get(3), owners.get(4) || 0], [100, 100, 100, 0]);
  assert.deepEqual(z, [10, 1, 2, 3, 100], 'owning a widget does not move it while an app is in front');
  anchor.track();
  assert.deepEqual(anchor.snapshot, [10, 1, 2, 3]);

  // Activating widget 2 raises the whole desktop-owned group (what Windows does).
  user32.SetWindowPos(2, 0, 0, 0, 0, 0, 0x13);
  user32.fg = 2;
  anchor.track();
  assert.deepEqual(anchor.snapshot, [10, 1, 2, 3], 'no snapshot while a widget is in front');
  assert.deepEqual(z.slice(0, 3), [2, 1, 3]);
  anchor.restoreOthers(wins[1]);
  assert.deepEqual(z, [2, 10, 1, 3, 100], 'only the clicked widget stays above the app');
});

test('anchor #116: re-owning moves a widget to the bottom only after Win+D', () => {
  const { user32, calls } = fakeDesktop({ order: [10, 1, 100, 200], classes: { 200: 'WorkerW' } });
  const wins = [fakeWin(1)];
  const anchor = new DesktopAnchor({ getWindows: () => wins, isEnabled: () => true, user32 });
  user32.fg = 10;
  anchor.sync();
  assert.deepEqual(calls, [], 'app in front: the widget keeps its place');
  user32.fg = 1;
  anchor.sync(); // active widget: no owner
  user32.fg = 200;
  anchor.sync();
  assert.deepEqual(calls, [[1, 1, 0x13]], 'desktop in front (Win+D): back over the desktop');
  anchor.track();
  assert.equal(anchor.snapshot, null, 'no snapshot while the desktop is in front');
  anchor.restoreOthers(wins[0]);
  assert.equal(calls.length, 1, 'nothing to put back after Win+D');
  anchor.stop();
});
