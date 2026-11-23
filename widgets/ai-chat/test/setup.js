// A widget over a fake engine and a fake `claude`, with the helpers most tests need.
const path = require('path');
const { create, CHANNEL } = require('../index');
const { FAKE_KEY, workspace, fakeContext, READY } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(behavior = {}, { encrypted = true, initial = {}, fetchImpl, deps = {}, clock } = {}) {
  const ws = workspace(behavior);
  const fake = fakeContext(ws, { encrypted, initial });
  const widget = create(fake.ctx, { resolve: ws.resolve, exe: process.execPath, documents: path.join(ws.dir, 'documents'), fetchImpl, clock, widgetTools: () => ({ state: 'off', tools: [] }), ...deps });
  widget.start();
  const win = widget.focus() && fake.windows[0];
  const call = (name, arg) => fake.handlers[CHANNEL]({ sender: win.webContents }, name, arg);
  return {
    ws, fake, widget, win, call, handlers: widget.settings.handlers,
    cleanup() {
      widget.stop();
      ws.cleanup();
    },
    /** Everything the window was told about runs. */
    runs: (sessionId) => win.sent.filter(([n, e]) => n === 'run' && (!sessionId || e.sessionId === sessionId)).map(([, e]) => e),
    /** Waits until the session's run has ended. */
    async doneOf(sessionId, count = 1) {
      for (let i = 0; i < 600; i++) {
        const done = win.sent.filter(([n, e]) => n === 'run' && e.type === 'done' && e.sessionId === sessionId);
        if (done.length >= count) return done[count - 1][1];
        await sleep(25);
      }
      throw new Error('the run did not end');
    },
    async until(test, what = 'condition') {
      for (let i = 0; i < 800; i++) {
        const value = test();
        if (value) return value;
        await sleep(25);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
  };
}

/** Ready to run: consent, model, key, and this folder known. */
function ready(behavior = {}, options = {}) {
  const t = setup(behavior, { ...options, initial: { ...READY, ...(options.initial || {}) } });
  t.handlers.saveKey(FAKE_KEY);
  t.call('confirmFolder', t.ws.cwd);
  t.send = (prompt, sessionId = null) => t.call('send', { prompt, sessionId, cwd: sessionId ? null : t.ws.cwd });
  return t;
}

module.exports = { setup, ready, sleep };
