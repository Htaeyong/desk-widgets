// Checks whether ordinary opaque windows above a widget cover its entire frame.
// Electron's visibility state does not report occlusion on Windows.
const GW_HWNDPREV = 3;
const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x80000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const MAX_WINDOWS = 1024;
const MAX_FRAGMENTS = 256;

function subtract(rect, cover) {
  const left = Math.max(rect.left, cover.left);
  const top = Math.max(rect.top, cover.top);
  const right = Math.min(rect.right, cover.right);
  const bottom = Math.min(rect.bottom, cover.bottom);
  if (left >= right || top >= bottom) return [rect];
  return [
    { left: rect.left, top: rect.top, right: rect.right, bottom: top },
    { left: rect.left, top: bottom, right: rect.right, bottom: rect.bottom },
    { left: rect.left, top, right: left, bottom },
    { left: right, top, right: rect.right, bottom },
  ].filter((part) => part.left < part.right && part.top < part.bottom);
}

function fullyCovered(target, covers) {
  let uncovered = [target];
  for (const cover of covers) {
    uncovered = uncovered.flatMap((rect) => subtract(rect, cover));
    if (!uncovered.length) return true;
    if (uncovered.length > MAX_FRAGMENTS) return false;
  }
  return false;
}

function readRect(buffer) {
  const rect = {
    left: buffer.readInt32LE(0), top: buffer.readInt32LE(4),
    right: buffer.readInt32LE(8), bottom: buffer.readInt32LE(12),
  };
  return rect.left < rect.right && rect.top < rect.bottom ? rect : null;
}

function loadNative() {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwm = koffi.load('dwmapi.dll');
    return {
      previous: user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 command)'),
      visible: user32.func('bool __stdcall IsWindowVisible(intptr hwnd)'),
      iconic: user32.func('bool __stdcall IsIconic(intptr hwnd)'),
      style: user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)'),
      rect: user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ uint8 *buffer)'),
      attribute: dwm.func('int __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attribute, _Out_ uint8 *buffer, uint32 length)'),
    };
  } catch {
    return null;
  }
}

class WindowOcclusion {
  constructor(native = loadNative()) {
    this.native = native;
  }

  bounds(hwnd) {
    const buffer = Buffer.alloc(16);
    if (this.native.attribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buffer, buffer.length) === 0) return readRect(buffer);
    if (this.native.rect(hwnd, buffer)) return readRect(buffer);
    return null;
  }

  cloaked(hwnd) {
    const buffer = Buffer.alloc(4);
    return this.native.attribute(hwnd, DWMWA_CLOAKED, buffer, buffer.length) === 0 && buffer.readUInt32LE(0) !== 0;
  }

  isCovered(window) {
    if (!this.native || !window?.getNativeWindowHandle || window.isDestroyed?.() || !window.isVisible?.()) return false;
    try {
      const buffer = window.getNativeWindowHandle();
      const hwnd = Number(buffer.length === 8 ? buffer.readBigUInt64LE() : buffer.readUInt32LE(0));
      const target = this.bounds(hwnd);
      if (!target) return false;
      const covers = [];
      let above = this.native.previous(hwnd, GW_HWNDPREV);
      for (let checked = 0; above && checked < MAX_WINDOWS; checked++) {
        if (this.native.visible(above) && !this.native.iconic(above) && !this.cloaked(above) && !(Number(this.native.style(above, GWL_EXSTYLE)) & WS_EX_LAYERED)) {
          const rect = this.bounds(above);
          if (rect) {
            covers.push(rect);
            if (fullyCovered(target, covers)) return true;
          }
        }
        above = this.native.previous(above, GW_HWNDPREV);
      }
    } catch {
      // A failed native query must not hide live metrics.
    }
    return false;
  }
}

module.exports = { WindowOcclusion, subtract, fullyCovered };
