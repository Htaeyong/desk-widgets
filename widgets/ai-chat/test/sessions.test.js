// Sessions, the queue, stopping and quitting (#129, design 11, 14): always with a fake `claude`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionStore, shortInput, titleOf } = require('../lib/sessions');
const { FAKE_KEY, allFiles } = require('./helpers');
const { ready, setup, sleep } = require('./setup');

test('a run: the prompt goes to the fake, the stream and the result come back, the key does not', async () => {
  const t = ready({ deltas: ['작업', ' 중'], tellText: '작업 중' });
  try {
    const res = t.send('안녕');
    assert.equal(res.ok, true);
    const done = await t.doneOf(res.sessionId);
    assert.deepEqual([done.ok, done.showText], [true, 'result for: 안녕']);
    const [call] = t.ws.calls();
    assert.equal(call.prompt, '안녕');
    assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'auto');
    assert.equal(call.cwd.toLowerCase(), t.ws.cwd.toLowerCase());
    assert.ok(t.runs().some((e) => e.type === 'textDelta' && e.text === '작업'));
    assert.ok(t.runs().some((e) => e.type === 'toolCall' && e.name === 'Read'));
    assert.ok(!JSON.stringify(t.win.sent).includes(FAKE_KEY));
    for (const f of allFiles(t.fake.ctx.dataDir)) assert.ok(!fs.readFileSync(f, 'utf8').includes(FAKE_KEY), f);
    assert.equal(t.call('list').running.length, 0);
  } finally {
    t.cleanup();
  }
});

test('every widget session has its own Claude Code folder, its own id, and the next prompt resumes it', async () => {
  const t = ready({ strictResume: true });
  try {
    const a = t.send('첫 대화');
    await t.doneOf(a.sessionId);
    const b = t.send('둘째 대화');
    await t.doneOf(b.sessionId);
    const next = t.send('이어서', a.sessionId);
    assert.equal(next.sessionId, a.sessionId);
    await t.doneOf(a.sessionId, 2);
    const [first, second, third] = t.ws.calls();
    const base = path.join(t.fake.ctx.dataDir, 'claude-config');
    assert.equal(first.env.CLAUDE_CONFIG_DIR, path.join(base, a.sessionId));
    assert.equal(second.env.CLAUDE_CONFIG_DIR, path.join(base, b.sessionId));
    assert.equal(third.env.CLAUDE_CONFIG_DIR, path.join(base, a.sessionId));
    assert.ok(!first.args.includes('--resume'));
    assert.equal(third.args[third.args.indexOf('--resume') + 1], 'fake-session-1');
    const session = t.call('open', a.sessionId).session;
    assert.notEqual(session.id, session.runnerSessionId);
    assert.deepEqual([session.runner, session.runnerSessionId], ['claude', 'fake-session-1']);
  } finally {
    t.cleanup();
  }
});

test('the record keeps the prompt, answer, tool name and a short input, never tool results', async () => {
  const t = ready({ strictResume: true });
  try {
    const { sessionId } = t.send('기록 시험');
    await t.doneOf(sessionId);
    const { items } = t.call('open', sessionId);
    assert.deepEqual(items.map((i) => i.k), ['you', 'meta', 'tool', 'ai', 'ai', 'meta']);
    assert.match(items[1].text, /위젯 도구/);
    assert.equal(items[2].name, 'Read');
    assert.equal(items[2].input, '{"file_path":"a.txt"}');
    assert.ok(items.every((i) => !('result' in i) && !('content' in i)));
    assert.equal(shortInput({ command: 'x'.repeat(1000) }).length, 201);
    assert.equal(titleOf(`첫 줄 ${'가'.repeat(100)}\n둘째 줄`).length, 41);
  } finally {
    t.cleanup();
  }
});

test('erasing Claude Code\'s record: this session only, then read-only with a new-session path', async () => {
  const t = ready({ strictResume: true });
  try {
    const a = t.send('a');
    await t.doneOf(a.sessionId);
    const b = t.send('b');
    await t.doneOf(b.sessionId);
    const dirOf = (id) => path.join(t.fake.ctx.dataDir, 'claude-config', id);
    assert.ok(fs.existsSync(dirOf(a.sessionId)) && fs.existsSync(dirOf(b.sessionId)));
    assert.equal(t.call('clearRecord', a.sessionId).ok, true);
    assert.ok(!fs.existsSync(dirOf(a.sessionId)));
    assert.ok(fs.existsSync(dirOf(b.sessionId)), 'the other session is untouched');
    const opened = t.call('open', a.sessionId);
    assert.equal(opened.session.resumable, false);
    assert.ok(opened.items.some((i) => i.k === 'you' && i.text === 'a'), 'the conversation stays readable');
    const refused = t.send('더', a.sessionId);
    assert.deepEqual([refused.ok, refused.code], [false, 'read-only']);
    assert.equal(t.ws.calls().length, 2);
    // The other session goes on.
    const next = t.send('b2', b.sessionId);
    assert.equal(next.ok, true);
    assert.equal((await t.doneOf(b.sessionId, 2)).ok, true);
  } finally {
    t.cleanup();
  }
});

test('deleting a conversation removes both records; a busy one is refused', async () => {
  const t = ready({ hangAfterInit: true });
  try {
    const { sessionId } = t.send('x');
    await t.until(() => t.ws.calls().length, 'the run');
    assert.equal(t.call('remove', sessionId).ok, false);
    assert.equal(t.call('clearRecord', sessionId).ok, false);
    assert.equal(t.call('stop', sessionId), true);
    assert.equal((await t.doneOf(sessionId)).stopped, true);
    assert.equal(t.call('remove', sessionId).ok, true);
    assert.equal(t.call('open', sessionId), null);
    assert.ok(!fs.existsSync(path.join(t.fake.ctx.dataDir, 'sessions', `${sessionId}.jsonl`)));
    assert.ok(!fs.existsSync(path.join(t.fake.ctx.dataDir, 'claude-config', sessionId)));
    assert.equal(t.call('list').sessions.length, 0);
  } finally {
    t.cleanup();
  }
});

test('when Claude Code says the session is gone: read-only and a clear message, no key retry', async () => {
  const t = ready({ strictResume: true });
  try {
    const { sessionId } = t.send('a');
    await t.doneOf(sessionId);
    fs.rmSync(path.join(t.fake.ctx.dataDir, 'claude-config', sessionId), { recursive: true, force: true });
    assert.equal(t.send('b', sessionId).ok, true);
    const done = await t.doneOf(sessionId, 2);
    assert.equal(done.error.kind, 'resume-failed');
    assert.equal(t.ws.calls().length, 2);
    assert.equal(t.call('open', sessionId).session.resumable, false);
    assert.equal(t.send('c', sessionId).code, 'read-only');
  } finally {
    t.cleanup();
  }
});

test('retention: older than the setting goes, with its Claude record; pinned stays; 0 keeps all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-sessions-'));
  try {
    let at = Date.UTC(2026, 0, 1);
    const store = createSessionStore({ dir: path.join(dir, 's'), configRoot: path.join(dir, 'c'), now: () => at });
    const make = (name) => {
      const s = store.create({ prompt: name, cwd: dir, model: 'm', mode: 'auto' });
      fs.mkdirSync(store.configDirOf(s.id), { recursive: true });
      store.append(s.id, { k: 'you', text: name });
      return s.id;
    };
    const old = make('old');
    const pinned = make('pinned');
    store.update(pinned, { pinned: true });
    const busy = make('busy');
    at += 31 * 86400000;
    const fresh = make('fresh');
    assert.deepEqual(store.prune(0), []);
    assert.deepEqual(store.prune(30, new Set([busy])), [old]);
    assert.ok(!fs.existsSync(store.configDirOf(old)));
    assert.deepEqual(store.list().map((s) => s.id).sort(), [pinned, busy, fresh].sort());
    assert.equal(store.list()[0].id, pinned, 'pinned first');
    assert.throws(() => store.configDirOf('..\\..\\evil'), /Invalid session id/);
    assert.throws(() => store.read('../evil'), /Invalid session id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the data stays out of sync: no sync declaration on any store', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(index, /\bsync\s*:/);
  assert.doesNotMatch(index, /ctx\.files\.open/);
});

// ---- the queue ----

test('one at a time by default: the next waits, and starts when the first ends', async () => {
  const t = ready({ waitForFile: 'go.txt' });
  try {
    const a = t.send('a');
    const b = t.send('b');
    assert.deepEqual([a.queued, b.queued], [false, true]);
    await t.until(() => t.ws.calls().length === 1, 'the first run');
    assert.deepEqual(t.call('list').queue, [b.sessionId]);
    assert.equal(t.call('list').sessions.find((s) => s.id === b.sessionId).state, 'queued');
    await sleep(200);
    assert.equal(t.ws.calls().length, 1, 'the second has not started');
    fs.writeFileSync(path.join(t.ws.dir, 'go.txt'), 'x');
    await t.doneOf(a.sessionId);
    await t.doneOf(b.sessionId);
    assert.equal(t.ws.calls().length, 2);
    assert.equal(t.call('list').queue.length, 0);
  } finally {
    t.cleanup();
  }
});

test('the same session is never run twice at once, running or waiting', async () => {
  const t = ready({ waitForFile: 'go.txt' });
  try {
    const a = t.send('a');
    await t.until(() => t.ws.calls().length === 1, 'the run');
    const again = t.send('a2', a.sessionId);
    assert.deepEqual([again.ok, again.code], [false, 'same-session']);
    const b = t.send('b');
    assert.equal(t.send('b2', b.sessionId).code, 'same-session');
    assert.equal(t.call('cancelQueued', b.sessionId), true);
    assert.equal(t.call('cancelQueued', b.sessionId), false);
    fs.writeFileSync(path.join(t.ws.dir, 'go.txt'), 'x');
    await t.doneOf(a.sessionId);
    await sleep(100);
    assert.equal(t.ws.calls().length, 1, 'the cancelled one never ran');
  } finally {
    t.cleanup();
  }
});

test('up to the set number run together', async () => {
  // The first two wait for go.txt with no time limit that load could reach, so the third cannot start before it is written.
  const t = ready({ waitForFile: 'go.txt', waitMs: 10 * 60000 }, { initial: { maxConcurrent: 2 } });
  try {
    const a = t.send('a');
    const b = t.send('b');
    const c = t.send('c');
    assert.deepEqual([a.queued, b.queued, c.queued], [false, false, true]);
    await t.until(() => t.ws.calls().length >= 2, 'two runs');
    const list = t.call('list');
    assert.deepEqual([...list.running].sort(), [a.sessionId, b.sessionId].sort());
    assert.deepEqual(list.queue, [c.sessionId]);
    assert.equal(t.ws.calls().length, 2);
    fs.writeFileSync(path.join(t.ws.dir, 'go.txt'), 'x');
    await t.doneOf(a.sessionId);
    await t.doneOf(b.sessionId);
    await t.doneOf(c.sessionId);
    assert.equal(t.ws.calls().length, 3);
  } finally {
    t.cleanup();
  }
});

test('an empty or oversized prompt starts nothing', () => {
  const t = ready();
  try {
    assert.equal(t.send('   ').code, 'empty');
    assert.equal(t.send('x'.repeat(100001)).code, 'too-long');
    assert.equal(t.call('list').sessions.length, 0);
    assert.equal(t.ws.versionCalls(), 0);
  } finally {
    t.cleanup();
  }
});

test('prerequisites stop the run: too old, with no task started', async () => {
  const t = ready({ version: '2.1.286' });
  try {
    assert.equal((await t.call('state')).prerequisites.problems[0].kind, 'too-old');
    const { sessionId } = t.send('x');
    const done = await t.doneOf(sessionId);
    assert.equal(done.error.kind, 'too-old');
    assert.deepEqual(t.ws.calls(), []);
  } finally {
    t.cleanup();
  }
});

// ---- the folder ----

test('a new folder asks first, once; the default folder is made when used', async () => {
  const t = setup({}, { initial: { consent: { version: 1, at: 'x' }, modelChosen: true } });
  try {
    t.handlers.saveKey(FAKE_KEY);
    const asked = t.call('send', { prompt: 'x' });
    assert.equal(asked.code, 'folder-confirm');
    const expected = path.join(t.ws.dir, 'documents', 'Desk Widgets', 'AI 대화');
    assert.equal(asked.cwd, expected);
    assert.equal(t.call('list').sessions.length, 0);
    assert.equal(t.ws.versionCalls(), 0);
    assert.equal(t.call('confirmFolder', 'relative'), false);
    assert.equal(t.call('confirmFolder', asked.cwd), true);
    const res = t.call('send', { prompt: 'x' });
    assert.equal(res.ok, true);
    await t.doneOf(res.sessionId);
    assert.equal(t.ws.calls()[0].cwd.toLowerCase(), expected.toLowerCase());
    const other = t.call('send', { prompt: 'y', cwd: t.ws.dir });
    assert.equal(other.code, 'folder-confirm', 'another folder asks again');
  } finally {
    t.cleanup();
  }
});

test('the session keeps its folder; the write guard and settings reach the run', async () => {
  const t = ready({}, { initial: { mode: 'plan', model: 'claude-sonnet-5-5' } });
  try {
    const { sessionId } = t.send('x');
    await t.doneOf(sessionId);
    const [call] = t.ws.calls();
    assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
    assert.equal(settings.permissions.blockWritesOutsideWorkingDirectories, true);
    assert.ok(settings.permissions.deny.some((r) => r.includes('chilgong88')));
    assert.equal(t.call('open', sessionId).session.cwd, t.ws.cwd);
  } finally {
    t.cleanup();
  }
});

// ---- stopping and quitting ----

test('stopping the widget ends a run in progress with its children', { skip: process.platform !== 'win32' }, async () => {
  const t = ready({ spawnProbe: true });
  try {
    assert.equal(t.send('x').ok, true);
    const file = path.join(t.ws.dir, 'probe.pid');
    const probe = await t.until(() => fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8')), 'the child');
    const alive = () => {
      try {
        process.kill(probe, 0);
        return true;
      } catch {
        return false;
      }
    };
    assert.ok(alive());
    t.widget.stop();
    await t.until(() => !alive(), 'the child to end');
  } finally {
    t.cleanup();
  }
});

test('quitting: no work, no question; with work it answers at once and never blocks, then quits on yes', async () => {
  const answers = [];
  let asked = 0;
  const t = ready({ waitForFile: 'go.txt' }, { deps: { confirmQuitDialog: () => { asked++; return new Promise((resolve) => answers.push(resolve)); } } });
  try {
    assert.equal(t.widget.confirmQuit(), true);
    assert.equal(asked, 0, 'nothing in progress, nothing asked');
    const { sessionId } = t.send('x');
    assert.equal(t.widget.confirmQuit(), false, 'held at once');
    await sleep(10);
    assert.equal(asked, 1);
    assert.equal(t.widget.confirmQuit(), false, 'a second quit does not open a second question');
    await sleep(10);
    assert.equal(asked, 1);
    answers[0](false);
    await sleep(10);
    assert.deepEqual(t.fake.quits, [], 'cancel keeps it all running');
    assert.equal(t.widget.confirmQuit(), false);
    await sleep(10);
    answers[1](true);
    await sleep(10);
    assert.equal(t.fake.quits.length, 1, 'yes quits again');
    assert.equal(t.widget.confirmQuit(), true, 'and this time it goes through');
    assert.equal(asked, 2);
    await t.until(() => t.ws.calls().length, 'the run');
    fs.writeFileSync(path.join(t.ws.dir, 'go.txt'), 'x');
    await t.doneOf(sessionId);
  } finally {
    t.cleanup();
  }
});

test('a question that cannot be shown does not quit by itself and does not stick', async () => {
  const t = ready({ waitForFile: 'go.txt' }, { deps: { confirmQuitDialog: () => { throw new Error('no dialog'); } } });
  try {
    const { sessionId } = t.send('x');
    assert.equal(t.widget.confirmQuit(), false);
    await sleep(10);
    assert.deepEqual(t.fake.quits, []);
    await t.until(() => t.ws.calls().length, 'the run');
    fs.writeFileSync(path.join(t.ws.dir, 'go.txt'), 'x');
    await t.doneOf(sessionId);
    assert.equal(t.widget.confirmQuit(), true);
  } finally {
    t.cleanup();
  }
});

// ---- after a crash ----

test('after a crash: a leftover that is ours is reported and left alone; the session says it was cut off', async () => {
  const ws = ready({ waitForFile: 'go.txt' });
  try {
    const { sessionId } = ws.send('x');
    const runsFile = path.join(ws.fake.ctx.dataDir, 'runs.json');
    await ws.until(() => fs.existsSync(runsFile) && JSON.parse(fs.readFileSync(runsFile, 'utf8')).length, 'the record');
    const [run] = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
    assert.deepEqual(Object.keys(run).sort(), ['marker', 'pid', 'sessionId']);
    assert.ok(!JSON.stringify(run).includes(FAKE_KEY));
    fs.writeFileSync(path.join(ws.ws.dir, 'go.txt'), 'x');
    await ws.doneOf(sessionId);
    assert.deepEqual(JSON.parse(fs.readFileSync(runsFile, 'utf8')), [], 'a clean end leaves nothing');

    // The next start finds what a crash would have left.
    const { create } = require('../index');
    const seen = [];
    fs.writeFileSync(runsFile, JSON.stringify([{ pid: 4242, marker: 'abc123', sessionId }, { pid: 4243, marker: 'def456', sessionId: 's-0000000000000000' }]));
    const store = require('../lib/sessions').createSessionStore({ dir: path.join(ws.fake.ctx.dataDir, 'sessions'), configRoot: path.join(ws.fake.ctx.dataDir, 'claude-config') });
    store.update(sessionId, { status: 'running' });
    const cards = [];
    ws.fake.ctx.notify = (events) => cards.push(...events);
    const killed = [];
    const realKill = process.kill;
    process.kill = (...args) => { killed.push(args); return true; };
    try {
      const again = create(ws.fake.ctx, { resolve: ws.ws.resolve, documents: ws.ws.dir, widgetTools: () => ({ state: 'off', tools: [] }), inspect: async (r) => { seen.push(r.pid); return { alive: true, ours: r.pid === 4242 }; } });
      again.start();
      await again.leftovers;
      assert.deepEqual(seen, [4242, 4243]);
      assert.deepEqual(killed, [], 'it never stops anything');
      assert.equal(cards.length, 1);
      assert.match(cards[0].body, /PID 4242/);
      assert.doesNotMatch(cards[0].body, /4243/);
      assert.deepEqual(JSON.parse(fs.readFileSync(runsFile, 'utf8')), []);
    } finally {
      process.kill = realKill;
    }
    assert.ok(store.read(sessionId).some((i) => i.kind === 'interrupted'));
  } finally {
    ws.cleanup();
  }
});

test('no record, no process at start', async () => {
  const t = ready({}, { deps: { inspect: async () => { throw new Error('must not run'); } } });
  try {
    await t.widget.leftovers;
    assert.equal(t.ws.versionCalls(), 0);
  } finally {
    t.cleanup();
  }
});
