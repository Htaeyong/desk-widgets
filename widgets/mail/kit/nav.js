// Back / forward for mail themes (#65, like the Dooray widget's #17): a bounded history of screen snapshots
// and the inputs that drive it (mouse side buttons, Alt+← / Alt+→). Any mail theme loads it with
// <script src="nav.js"> (window.MailNav); the widget's reader window and the tests require it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailNav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LIMIT = 50;

  /**
   * History of snapshots (whatever a theme needs to redraw a screen: { screen, id, filter, scroll, ... }).
   * record(current) before moving to a new screen (clears "forward"); back(current) / forward(current)
   * return the snapshot to show, or null when there is none (then nothing should happen).
   */
  function createHistory({ limit = LIMIT } = {}) {
    let back = [];
    let forward = [];
    const trim = () => {
      while (back.length > limit) back.shift();
    };
    return {
      record(current) {
        back.push(current);
        trim();
        forward = [];
      },
      back(current) {
        const prev = back.pop();
        if (prev === undefined) return null;
        forward.push(current);
        return prev;
      },
      forward(current) {
        const next = forward.pop();
        if (next === undefined) return null;
        back.push(current);
        trim();
        return next;
      },
      canBack: () => back.length > 0,
      canForward: () => forward.length > 0,
      clear() {
        back = [];
        forward = [];
      },
      sizes: () => ({ back: back.length, forward: forward.length }),
    };
  }

  /** The action of an input: 'back' | 'forward' | null. Mouse side buttons are 3 (back) and 4 (forward). */
  function inputAction(e) {
    if (!e) return null;
    if (e.type === 'mouseup' || e.type === 'mousedown' || e.type === 'auxclick') {
      return e.button === 3 ? 'back' : e.button === 4 ? 'forward' : null;
    }
    if (e.type === 'keydown' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.isComposing) {
      return e.key === 'ArrowLeft' ? 'back' : e.key === 'ArrowRight' ? 'forward' : null;
    }
    return null;
  }

  /**
   * Wires the inputs on a window: Chromium reports side buttons on mouseup; mousedown / auxclick of the same
   * buttons are swallowed too so nothing else reacts. Returns an unbind function.
   */
  function bindInputs(target, { back, forward }) {
    const onMouse = (e) => {
      const action = inputAction(e);
      if (!action) return;
      e.preventDefault();
      if (e.type === 'mouseup') (action === 'back' ? back : forward)();
    };
    const onKey = (e) => {
      const action = inputAction(e);
      if (!action) return;
      e.preventDefault();
      (action === 'back' ? back : forward)();
    };
    for (const t of ['mousedown', 'mouseup', 'auxclick']) target.addEventListener(t, onMouse);
    target.addEventListener('keydown', onKey);
    return () => {
      for (const t of ['mousedown', 'mouseup', 'auxclick']) target.removeEventListener(t, onMouse);
      target.removeEventListener('keydown', onKey);
    };
  }

  return { createHistory, inputAction, bindInputs, LIMIT };
});
