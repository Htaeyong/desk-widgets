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
