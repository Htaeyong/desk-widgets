// Back / forward (#65, like the Dooray widget's #17): the kit's history and input mapping (kit/nav.js),
// used by the mail themes and the reader window.
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../kit/nav');
const { keyAction } = require('../lib/preview');

const snap = (screen, extra = {}) => ({ screen, id: null, filter: '', scroll: 0, selected: null, ...extra });

test('history: record / back / forward, snapshots come back unchanged (list scroll and selection)', () => {
  const h = N.createHistory();
  assert.equal(h.back(snap('list')), null, 'nothing to go back to: nothing happens');
  const list = snap('list', { filter: 'acc1', scroll: 420, selected: 'acc1:7' });
  h.record(list); // list -> message
  const detail = snap('detail', { id: 'acc1:7', filter: 'acc1', scroll: 420, selected: 'acc1:7' });
  assert.deepEqual(h.back(detail), { screen: 'list', id: null, filter: 'acc1', scroll: 420, selected: 'acc1:7' });
  assert.equal(h.canForward(), true);
  assert.deepEqual(h.forward(list), detail);
  assert.equal(h.forward(detail), null, 'no more forward');
  assert.deepEqual(h.sizes(), { back: 1, forward: 0 });
});

test('history: a new move clears forward; the limit drops the oldest', () => {
  const h = N.createHistory({ limit: 3 });
  h.record(snap('list', { scroll: 1 }));
  h.back(snap('detail'));
  assert.equal(h.canForward(), true);
  h.record(snap('list', { scroll: 2 }));
  assert.equal(h.canForward(), false, 'new navigation clears forward');
  for (let i = 3; i <= 6; i++) h.record(snap('list', { scroll: i }));
  assert.equal(h.sizes().back, 3);
  const seen = [];
  let cur = snap('detail');
  for (let s = h.back(cur); s; s = h.back(cur)) {
    seen.push(s.scroll);
    cur = s;
  }
  assert.deepEqual(seen, [6, 5, 4], 'the oldest snapshots were dropped');
  h.clear();
  assert.deepEqual(h.sizes(), { back: 0, forward: 0 });
  assert.equal(N.LIMIT, 50);
});

test('inputs: side buttons 3 / 4 (mouseup acts, mousedown / auxclick only swallowed), Alt+← / Alt+→', () => {
  assert.equal(N.inputAction({ type: 'mouseup', button: 3 }), 'back');
  assert.equal(N.inputAction({ type: 'mouseup', button: 4 }), 'forward');
  assert.equal(N.inputAction({ type: 'mouseup', button: 0 }), null);
  assert.equal(N.inputAction({ type: 'keydown', key: 'ArrowLeft', altKey: true }), 'back');
  assert.equal(N.inputAction({ type: 'keydown', key: 'ArrowRight', altKey: true }), 'forward');
  assert.equal(N.inputAction({ type: 'keydown', key: 'ArrowLeft', altKey: false }), null, 'plain arrows move the caret / scroll');
  assert.equal(N.inputAction({ type: 'keydown', key: 'ArrowLeft', altKey: true, ctrlKey: true }), null);
  assert.equal(N.inputAction({ type: 'keydown', key: 'ArrowLeft', altKey: true, isComposing: true }), null, 'Korean IME composing');

  const listeners = {};
  const target = { addEventListener: (t, fn) => (listeners[t] = fn), removeEventListener: (t) => delete listeners[t] };
  const calls = [];
  const unbind = N.bindInputs(target, { back: () => calls.push('back'), forward: () => calls.push('forward') });
  const ev = (type, extra) => {
    const e = { type, ...extra, prevented: false, preventDefault() { this.prevented = true; } };
    listeners[type](e);
    return e;
  };
  assert.equal(ev('mousedown', { button: 3 }).prevented, true);
  assert.deepEqual(calls, [], 'mousedown does not navigate');
  assert.equal(ev('mouseup', { button: 3 }).prevented, true);
  ev('auxclick', { button: 4 });
  ev('mouseup', { button: 4 });
  assert.equal(ev('mouseup', { button: 0 }).prevented, false, 'a normal click is untouched');
  ev('keydown', { key: 'ArrowLeft', altKey: true });
  assert.deepEqual(calls, ['back', 'forward', 'back']);
  unbind();
  assert.deepEqual(Object.keys(listeners), []);
});

test('reader keys: Alt+← / Alt+→ from Electron before-input-event', () => {
  assert.equal(keyAction({ type: 'keyDown', alt: true, key: 'ArrowLeft' }), 'back');
  assert.equal(keyAction({ type: 'keyDown', alt: true, key: 'ArrowRight' }), 'forward');
  assert.equal(keyAction({ type: 'keyUp', alt: true, key: 'ArrowLeft' }), null);
  assert.equal(keyAction({ type: 'keyDown', alt: false, key: 'ArrowLeft' }), null);
});
