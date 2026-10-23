const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { create } = require('../index');

test('the widget samples only while visible and present, and closes its engine sampler on stop', () => {
  const saved = { intervalMs: 2000, historyMs: 60000, showCores: false, alwaysOnTop: false, themeId: 'graph', themeOpacity: {} };
  const calls = { reads: 0, resets: 0, closes: 0, emits: [] };
  let visible = true;
  let covered = false;
  const host = {
    open() {}, close() {}, focus: () => true,
    desktopWindows: () => [{ isVisible: () => visible, isDestroyed: () => false }],
    emit: (name, payload) => calls.emits.push({ name, payload }),
    settingsHandlers: () => ({}),
  };
  const ctx = {
    dir: path.join(__dirname, '..'),
    dataDir: __dirname,
    app: { locale: () => 'ko-KR' },
    createStore: () => ({ load: () => saved, save: (value) => Object.assign(saved, value) }),
    useThemes: () => host,
    system: {
      isWindowCovered: () => covered,
      createSampler: () => ({
        read: () => (calls.reads++, { cpu: { percent: 20 } }),
        reset: () => calls.resets++,
        close: () => calls.closes++,
      }),
    },
  };
  const widget = create(ctx);
  widget.start();
  assert.equal(calls.reads, 1);
  assert.equal(calls.emits[0].name, 'metrics');
  visible = false;
  widget.setPaused('idle');
  widget.setPaused(null);
  assert.equal(calls.reads, 1);
  assert.ok(calls.resets >= 2);
  visible = true;
  widget.setPaused(null);
  assert.equal(calls.reads, 2);
  covered = true;
  widget.setPaused(null);
  assert.equal(calls.reads, 2);
  covered = false;
  widget.setPaused(null);
  assert.equal(calls.reads, 3);
  widget.stop();
  assert.equal(calls.closes, 1);
});
