// Keeps widget windows visible on the desktop after "Show desktop" (Win+D). Two modes:
//
// anchor (DesktopAnchor): the desktop window (Progman) becomes the OWNER of each widget window.
//   The shell leaves windows owned by the desktop alone, so Win+D never hides them (no flicker).
//   Verified: restarting Explorer does not destroy the widgets, it only clears the owner, so we
//   re-check every second and re-attach to the new desktop window.
//   An owned window that gets activated becomes the desktop's "last active popup", and Win+D then
//   hands activation to the widget instead of the desktop, which cancels the shell's show-desktop
//   state (the second Win+D no longer restores windows). So an active widget has no owner: when a
//   widget gets focus while the desktop remembers it, we drop the owner, let a throwaway window owned
//   by the desktop take the activation for a moment and take it back (all on our own thread, so the
//   click and the keyboard focus are kept), then destroy the helper, which resets the desktop's
//   memory. Focusing from code calls detach() first. The owner comes back once another window is in
//   the foreground. Verified with real clicks and Win+D key presses (issue #26).
//   Windows treats the windows of one owner as a group: moving one of them in the z-order (HWND_TOP
//   on activation, HWND_BOTTOM, or "after X") moves every window owned by the desktop with it,
//   unless the call passes SWP_NOOWNERZORDER (checked with hidden windows, #116). So a click on one
//   widget also brought every other widget above the apps. We remember the z-order whenever another
//   app comes to the foreground and, after a widget is activated, put each other widget back right
//   under the window it was under (with SWP_NOOWNERZORDER, so only that widget moves).
// raise (DesktopKeeper): Win+D does not minimize or hide our windows; the desktop comes to the
//   front over them. We detect that and pass the widgets through the topmost band so they show
//   again (a brief flicker).

const CHECK_INTERVAL_MS = 400;
// Show-desktop animates; raise again shortly after so the shell does not cover us at the end.
const RAISE_AGAIN_MS = [250, 700];
const DESKTOP_CLASSES = new Set(['WorkerW', 'Progman']);

function loadUser32() {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    return {
      GetForegroundWindow: user32.func('intptr __stdcall GetForegroundWindow()'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr hwnd, _Out_ uint8_t *buf, int maxCount)'),
      FindWindowW: user32.func('intptr __stdcall FindWindowW(str16 cls, str16 name)'),
      GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)'),
      SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)'),
      GetLastActivePopup: user32.func('intptr __stdcall GetLastActivePopup(intptr hwnd)'),
      SetActiveWindow: user32.func('intptr __stdcall SetActiveWindow(intptr hwnd)'),
      CreateWindowExW: user32.func('intptr __stdcall CreateWindowExW(uint32 exStyle, str16 cls, str16 name, uint32 style, int x, int y, int w, int h, intptr owner, intptr menu, intptr inst, intptr param)'),
      DestroyWindow: user32.func('bool __stdcall DestroyWindow(intptr hwnd)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint32 flags)'),
      GetTopWindow: user32.func('intptr __stdcall GetTopWindow(intptr hwnd)'),
      GetWindow: user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr hwnd)'),
    };
  } catch {
    // Without FFI the widgets behave like normal windows; nothing else breaks.
    return null;
  }
}

/** Pure decision used by DesktopKeeper (unit-tested). */
function shouldRaise(prevOnDesktop, foregroundClass) {
  const onDesktop = DESKTOP_CLASSES.has(foregroundClass);
  return { onDesktop, raise: onDesktop && !prevOnDesktop };
}

class DesktopKeeper {
  /**
   * @param {{ getWindows: () => Electron.BrowserWindow[], isEnabled: () => boolean, user32?: object }} opts
   */
  constructor({ getWindows, isEnabled, user32 = loadUser32() }) {
    this.getWindows = getWindows;
    this.isEnabled = isEnabled;
    this.user32 = user32;
    this.onDesktop = false;
    this.timer = null;
    this.buffer = Buffer.alloc(512);
  }

  get available() {
    return Boolean(this.user32);
  }

  start() {
    if (!this.user32 || this.timer) return;
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  foregroundClass() {
    const hwnd = this.user32.GetForegroundWindow();
    if (!hwnd) return '';
    const n = this.user32.GetClassNameW(hwnd, this.buffer, this.buffer.length / 2);
    return n > 0 ? this.buffer.toString('utf16le', 0, n * 2) : '';
  }

  check() {
    if (!this.isEnabled()) {
      this.onDesktop = false;
      return;
    }
    let cls = '';
    try {
      cls = this.foregroundClass();
    } catch {
      return;
    }
    const { onDesktop, raise } = shouldRaise(this.onDesktop, cls);
    this.onDesktop = onDesktop;
    if (!raise) return;
    this.raise();
    for (const ms of RAISE_AGAIN_MS) setTimeout(() => this.onDesktop && this.raise(), ms);
  }

  // A plain HWND_TOP (moveTop) stays under the desktop after a real Win+D key press.
  // Passing through the topmost band and back puts the widget above the desktop, and it stays
  // there as a normal window, so other apps still cover it later. Neither call takes focus.
  raise() {
    for (const win of this.getWindows()) {
      if (win.isDestroyed() || !win.isVisible() || win.isAlwaysOnTop()) continue;
      win.setAlwaysOnTop(true);
      win.setAlwaysOnTop(false);
    }
  }
}

// ---------- anchor mode ----------

const GWLP_HWNDPARENT = -8; // for top-level windows this is the OWNER, not a parent
const ANCHOR_SYNC_MS = 1000;
// HWND_BOTTOM on an owned window puts it right above its owner: back over the desktop after Win+D
// covered it while it was unowned, and under the apps, where a desktop widget belongs.
const HWND_BOTTOM = 1;
const SWP_KEEP = 0x0001 | 0x0002 | 0x0010; // NOSIZE | NOMOVE | NOACTIVATE
const ACTIVE_SYNC_MS = 150; // while a widget is active (unowned), notice Win+D quickly
const HELPER_STYLE = 0x80000000; // WS_POPUP, never shown
const HELPER_EX_STYLE = 0x00000080; // WS_EX_TOOLWINDOW
const SWP_NOOWNERZORDER = 0x0200; // move only this window, not the desktop's other owned windows
const TRACK_MS = 250; // how often the foreground window is checked for a z-order snapshot
const GW_HWNDNEXT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;
const MAX_STACK = 5000; // top-level windows walked at most (guards against a z-order that changes mid-walk)

/** HWND of an Electron window as a number (koffi intptr). */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
}

/**
 * Desired owner for a widget window (pure, unit-tested):
 * the desktop while anchoring and not pinned; none when pinned ("always on top"), anchoring is off,
 * or the widget is the active window (see the note at the top of this file).
 */
function wantedOwner({ enabled, pinned, focused = false, desktop }) {
  return enabled && !pinned && !focused && desktop ? desktop : 0;
}

/**
 * Moves that put the other widgets back where they were before a click raised them (pure, unit-tested, #116).
 * before / after: visible normal (not topmost) top-level windows above the desktop, top first, before the click
 * and now. widgets: the desktop-owned widgets to put back (not the clicked one).
 * Each widget goes right under the nearest window that was above it and still exists (skipping the clicked
 * widget); a widget that had nothing above it stays where it is. Returns [hwnd, insertAfter] pairs in order.
 */
function zOrderMoves({ before, after, widgets, clicked }) {
  const keep = new Set(widgets);
  const alive = new Set(after);
  const order = [...after];
  const moves = [];
  for (let i = 0; i < before.length; i++) {
    const w = before[i];
    if (!keep.has(w) || !alive.has(w)) continue;
    let above = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (before[j] !== clicked && alive.has(before[j])) {
        above = before[j];
        break;
      }
    }
    if (!above) continue;
    const at = order.indexOf(w);
    if (order[at - 1] === above) continue;
    moves.push([w, above]);
    order.splice(at, 1);
    order.splice(order.indexOf(above) + 1, 0, w);
  }
  return moves;
}

class DesktopAnchor {
  /**
   * @param {{ getWindows: () => Electron.BrowserWindow[], isEnabled: () => boolean, user32?: object }} opts
   */
  constructor({ getWindows, isEnabled, user32 = loadUser32() }) {
    this.getWindows = getWindows;
    this.isEnabled = isEnabled;
    this.user32 = user32;
    this.timer = null;
    this.watched = new WeakSet();
    this.quick = null;
    this.tracker = null;
    this.lastForeground = 0;
    this.snapshot = null; // stack() from when another app last came to the foreground
    this.buffer = Buffer.alloc(512);
  }

  get available() {
    return Boolean(this.user32);
  }

  start() {
    if (!this.user32 || this.timer) return;
    this.sync();
    // Covers new windows, pin changes, mode changes and Explorer restarts (new desktop window).
    this.timer = setInterval(() => this.sync(), ANCHOR_SYNC_MS);
    this.tracker = setInterval(() => this.track(), TRACK_MS);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.tracker);
    clearTimeout(this.quick);
    this.timer = null;
    this.tracker = null;
    this.quick = null;
    this.snapshot = null;
    this.lastForeground = 0;
  }

  classOf(hwnd) {
    if (!hwnd) return '';
    const n = this.user32.GetClassNameW(hwnd, this.buffer, this.buffer.length / 2);
    return n > 0 ? this.buffer.toString('utf16le', 0, n * 2) : '';
  }

  /** Visible normal (not topmost) top-level windows above the desktop window, top first. */
  stack() {
    const u = this.user32;
    const desktop = Number(u.FindWindowW('Progman', null)) || 0;
    const list = [];
    let h = Number(u.GetTopWindow(0)) || 0;
    for (let n = 0; h && h !== desktop && n < MAX_STACK; n++) {
      if (u.IsWindowVisible(h) && !(Number(u.GetWindowLongPtrW(h, GWL_EXSTYLE)) & WS_EX_TOPMOST)) list.push(h);
      h = Number(u.GetWindow(h, GW_HWNDNEXT)) || 0;
    }
    return list;
  }

  /**
   * Remembers the z-order whenever another app comes to the foreground, so that a click on a widget can put
   * the other widgets back. Nothing is kept while the desktop is in front (Win+D): every widget is on the
   * desktop then, and a window "above" a widget may be one the desktop covers.
   */
  track() {
    if (!this.user32 || !this.isEnabled()) return;
    try {
      const fg = Number(this.user32.GetForegroundWindow()) || 0;
      if (fg === this.lastForeground) return;
      this.lastForeground = fg;
      for (const win of this.getWindows()) if (!win.isDestroyed() && hwndOf(win) === fg) return;
      this.snapshot = DESKTOP_CLASSES.has(this.classOf(fg)) ? null : this.stack();
    } catch {
      this.snapshot = null;
    }
  }

  /** A click on one desktop-owned widget raised all of them: puts the others back (see the note at the top). */
  restoreOthers(win) {
    if (!this.snapshot || win.isDestroyed()) return;
    const u = this.user32;
    try {
      const widgets = [];
      for (const w of this.getWindows()) {
        if (w === win || w.isDestroyed() || w.isAlwaysOnTop()) continue;
        const hwnd = hwndOf(w);
        if (Number(u.GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT))) widgets.push(hwnd);
      }
      const moves = zOrderMoves({ before: this.snapshot, after: this.stack(), widgets, clicked: hwndOf(win) });
      for (const [hwnd, after] of moves) u.SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_KEEP | SWP_NOOWNERZORDER);
      // A click on the next widget leaves this one above the apps, where it is now.
      this.snapshot = this.stack();
    } catch {
      // The other widgets stay above the apps until another app is activated.
    }
  }

  sync() {
    if (!this.user32) return;
    let desktop = 0;
    try {
      desktop = Number(this.user32.FindWindowW('Progman', null)) || 0;
    } catch {
      return;
    }
    const enabled = this.isEnabled();
    // win.isFocused() follows the thread's active window, which can stay on the widget after the
    // desktop takes the foreground; only the real foreground window counts here.
    let foreground = 0;
    try {
      foreground = Number(this.user32.GetForegroundWindow()) || 0;
    } catch {
      // treat as not focused
    }
    let held = false;
    let onDesktop = null; // the desktop is in the foreground (Win+D); looked up once, when needed
    for (const win of this.getWindows()) {
      if (win.isDestroyed()) continue;
      this.watch(win);
      try {
        const hwnd = hwndOf(win);
        const focused = hwnd === foreground;
        const want = wantedOwner({ enabled, pinned: win.isAlwaysOnTop(), focused, desktop });
        if (focused && enabled) held = true;
        if (Number(this.user32.GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT)) !== want) {
          this.user32.SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, want);
          // Only after Win+D: anywhere else the widget keeps its place, and HWND_BOTTOM would also pull every
          // other widget down with it (#116).
          if (want && (onDesktop ??= DESKTOP_CLASSES.has(this.classOf(foreground)))) {
            this.user32.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_KEEP);
          }
        }
      } catch {
        // Leave this window as a normal window.
      }
    }
    // The blur event is unreliable here (see above), so check again soon while a widget is unowned.
    if (held && this.timer && !this.quick) {
      this.quick = setTimeout(() => {
        this.quick = null;
        this.sync();
      }, ACTIVE_SYNC_MS);
    }
  }

  watch(win) {
    if (this.watched.has(win) || typeof win.on !== 'function') return;
    this.watched.add(win);
    // Not inside the activation itself: Windows does not expect activation changes from WM_ACTIVATE.
    win.on('focus', () =>
      setImmediate(() => {
        if (!this.timer) return;
        this.repair(win);
        this.restoreOthers(win);
      })
    );
    win.on('blur', () => this.timer && this.sync());
  }

  /** Makes the desktop forget an active widget (see the note at the top of this file). */
  repair(win) {
    if (win.isDestroyed()) return;
    const u = this.user32;
    try {
      const hwnd = hwndOf(win);
      const desktop = Number(u.FindWindowW('Progman', null)) || 0;
      if (!desktop || Number(u.GetLastActivePopup(desktop)) !== hwnd) return;
      this.detach(win);
      const helper = u.CreateWindowExW(HELPER_EX_STYLE, 'STATIC', '', HELPER_STYLE, 0, 0, 0, 0, desktop, 0, 0, 0);
      if (!helper) return;
      u.SetActiveWindow(helper);
      u.SetActiveWindow(hwnd);
      u.DestroyWindow(helper);
    } catch {
      // The widget keeps working; only the second Win+D may not restore windows.
    }
  }

  /** Drops the owner link of one widget; call before focusing it from code. True when it was linked. */
  detach(win) {
    if (!this.user32 || win.isDestroyed()) return false;
    try {
      const hwnd = hwndOf(win);
      if (!Number(this.user32.GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT))) return false;
      this.user32.SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Clears the owner of every widget (mode switched off, app quitting). */
  releaseAll() {
    if (!this.user32) return;
    for (const win of this.getWindows()) {
      if (win.isDestroyed()) continue;
      try {
        this.user32.SetWindowLongPtrW(hwndOf(win), GWLP_HWNDPARENT, 0);
      } catch {
        // ignore
      }
    }
  }
}

module.exports = { DesktopKeeper, DesktopAnchor, shouldRaise, wantedOwner, zOrderMoves, DESKTOP_CLASSES };
