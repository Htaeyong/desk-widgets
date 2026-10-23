const test = require('node:test');
const assert = require('node:assert/strict');
const { fullyCovered, WindowOcclusion } = require('../main/window-occlusion');

const target = { left: 0, top: 0, right: 100, bottom: 100 };

test('coverage combines opaque rectangles and leaves any exposed area active', () => {
  assert.equal(fullyCovered(target, [{ left: 0, top: 0, right: 100, bottom: 100 }]), true);
  assert.equal(fullyCovered(target, [
    { left: 0, top: 0, right: 50, bottom: 100 },
    { left: 50, top: 0, right: 100, bottom: 100 },
  ]), true);
  assert.equal(fullyCovered(target, [{ left: 0, top: 0, right: 99, bottom: 100 }]), false);
  assert.equal(fullyCovered(target, []), false);
});

test('hidden, minimized, cloaked and layered windows do not count as covers', () => {
  const windows = new Map([
    [1, { rect: target, visible: true, next: 2 }],
    [2, { rect: target, visible: true, iconic: true, next: 3 }],
    [3, { rect: target, visible: true, cloaked: true, next: 4 }],
    [4, { rect: target, visible: true, layered: true, next: 5 }],
    [5, { rect: target, visible: false, next: 0 }],
  ]);
  const native = {
    previous: (hwnd) => windows.get(hwnd)?.next || 0,
    visible: (hwnd) => windows.get(hwnd)?.visible,
    iconic: (hwnd) => windows.get(hwnd)?.iconic,
    style: (hwnd) => windows.get(hwnd)?.layered ? 0x80000 : 0,
    rect: (hwnd, buffer) => { const r = windows.get(hwnd)?.rect; if (!r) return false; [r.left, r.top, r.right, r.bottom].forEach((x, i) => buffer.writeInt32LE(x, i * 4)); return true; },
    attribute: (hwnd, attr, buffer) => {
      const w = windows.get(hwnd);
      if (attr === 9) { [w.rect.left, w.rect.top, w.rect.right, w.rect.bottom].forEach((x, i) => buffer.writeInt32LE(x, i * 4)); return 0; }
      if (attr === 14) { buffer.writeUInt32LE(w.cloaked ? 1 : 0); return 0; }
      return 1;
    },
  };
  const widget = { getNativeWindowHandle: () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1n); return b; }, isVisible: () => true };
  const detector = new WindowOcclusion(native);
  assert.equal(detector.isCovered(widget), false);
  windows.get(5).visible = true;
  assert.equal(detector.isCovered(widget), true);
});
