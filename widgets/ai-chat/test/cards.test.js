// Cards and ai-chat-host (#129, design 9, 13) with a fake `claude` that speaks MCP as Claude Code does. The Manual-mode path:
// a file changes only after a click on the card. Page-level clicks are in page.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { visibleText, approvalCard, questionCard, MAX_INPUT_TEXT } = require('../lib/cards');
const { createHostServer } = require('../lib/host-server');
const { WIDGET_DIR, FAKE_KEY, allFiles } = require('./helpers');
const { ready, sleep } = require('./setup');

const ROOT = path.join(WIDGET_DIR, '..', '..');
const HOST = path.join(WIDGET_DIR, 'host', 'ai-chat-host.js');

const approveWrite = (file, content = 'written') => ({ tool: 'approve', args: { tool_name: 'Write', input: { file_path: file, content }, tool_use_id: 'tu_1' } });
const results = (t) => {
  const file = path.join(t.ws.dir, 'mcp-results.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

/** Waits for the card, marks it drawn and armed, and answers as a click would. */
async function waitCard(t) {
  const card = await t.until(() => t.call('list').sessions.some((s) => s.waiting) && (t.win.sent.filter(([n]) => n === 'cards').pop()?.[1] || [])[0], 'a card');
  t.call('cardShown', card.id);
  await sleep(450);
  return card;
}

test('Manual path: nothing changes until the click; allow runs exactly the input that was asked', async () => {
  const t = ready({ strictResume: true });
  try {
    const target = path.join(t.ws.dir, 'changed.txt');
    t.ws.setBehavior({ mcpFlow: [approveWrite(target, 'the asked content')] });
    t.widget.settings.save({ model: 'claude-haiku-5-5', mode: 'default' });
    const { sessionId } = t.send('파일을 만들어');
    const card = await t.until(() => (t.win.sent.filter(([n]) => n === 'cards').pop()?.[1] || [])[0], 'a card');
    assert.equal(card.kind, 'approval');
    assert.equal(card.tool, 'Write');
    assert.match(card.inputText, /the asked content/);
    assert.equal(card.input, undefined, 'the window gets display text, not the input to run');
    assert.equal(card.sessionId, sessionId);
    await sleep(600);
    assert.ok(!fs.existsSync(target), 'no click, no file');

    // None of these is a click on a card that is showing.
    assert.equal(t.call('answerCard', { id: card.id, action: 'allow', trusted: true }), false, 'not drawn yet');
    t.call('cardShown', card.id);
    assert.equal(t.call('answerCard', { id: card.id, action: 'allow', trusted: true }), false, 'too soon after it appeared');
    await sleep(450);
    assert.equal(t.call('answerCard', { id: card.id, action: 'allow' }), false, 'a script click');
    assert.equal(t.call('answerCard', { id: card.id, action: 'allow', trusted: 'yes' }), false);
    assert.equal(t.call('answerCard', { id: 'nope', action: 'allow', trusted: true }), false);
    assert.equal(t.call('answerCard', { id: card.id, action: 'answer', text: 'x', trusted: true }), false, 'wrong kind');
    assert.equal(t.call('answerCard', { id: card.id, action: 'allow', trusted: true, input: { file_path: 'elsewhere' } }), true);
    assert.equal(t.call('answerCard', { id: card.id, action: 'allow', trusted: true }), false, 'one answer');
    assert.equal((await t.doneOf(sessionId)).ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'the asked content');
    assert.deepEqual(results(t)[0].answer, { behavior: 'allow', updatedInput: { file_path: target, content: 'the asked content' } });
    assert.ok(t.call('open', sessionId).items.some((i) => i.k === 'card' && /허용/.test(i.text)));
  } finally {
    t.cleanup();
  }
});

test('deny: the file stays absent and the reason goes back', async () => {
  const t = ready();
  try {
    const target = path.join(t.ws.dir, 'denied.txt');
    t.ws.setBehavior({ mcpFlow: [approveWrite(target)] });
    const { sessionId } = t.send('x');
    const card = await waitCard(t);
    assert.equal(t.call('answerCard', { id: card.id, action: 'deny', text: '위험해 보임', trusted: true }), true);
    await t.doneOf(sessionId);
    assert.ok(!fs.existsSync(target));
    assert.deepEqual(results(t)[0].answer, { behavior: 'deny', message: 'The user denied this action: 위험해 보임' });
  } finally {
    t.cleanup();
  }
});

test('stop while a card waits: it is denied and the file stays absent', async () => {
  const t = ready();
  try {
    const target = path.join(t.ws.dir, 'stopped.txt');
    t.ws.setBehavior({ mcpFlow: [approveWrite(target)] });
    const { sessionId } = t.send('x');
    await waitCard(t);
    assert.equal(t.call('stop', sessionId), true);
    assert.equal((await t.doneOf(sessionId)).stopped, true);
    assert.deepEqual(t.call('state') instanceof Promise, true);
    assert.deepEqual((await t.call('state')).cards, []);
    await sleep(300);
    assert.ok(!fs.existsSync(target));
  } finally {
    t.cleanup();
  }
});

test('the time limit denies; with no limit the card keeps waiting', async () => {
  const t = ready();
  try {
    const target = path.join(t.ws.dir, 'late.txt');
    t.ws.setBehavior({ mcpFlow: [approveWrite(target)] });
    assert.equal(require('../lib/settings').sanitize({ cardTimeoutMinutes: 5 }).cardTimeoutMinutes, 0);
    assert.equal(require('../lib/settings').sanitize({ cardTimeoutMinutes: 30 }).cardTimeoutMinutes, 30);
    const { sessionId } = t.send('x');
    await waitCard(t);
    await sleep(300);
    assert.equal(results(t).length, 0);
    t.call('stop', sessionId);
    await t.doneOf(sessionId);
  } finally {
    t.cleanup();
  }
});

test('ask_user: option or typed answer goes back as text; no answer is an error result, not a guess', async () => {
  const t = ready();
  try {
    t.ws.setBehavior({ mcpFlow: [{ list: true }, { tool: 'ask_user', args: { question: '어느 색?', options: ['빨강', '파랑'] } }, { tool: 'ask_user', args: { question: '이름?' } }, { tool: 'ask_user', args: { question: '또?' } }] });
    const { sessionId } = t.send('x');
    const first = await waitCard(t);
    assert.deepEqual([first.kind, first.question, first.options], ['question', '어느 색?', ['빨강', '파랑']]);
    assert.equal(t.call('answerCard', { id: first.id, action: 'answer', text: '   ', trusted: true }), false, 'an empty answer is no answer');
    t.call('answerCard', { id: first.id, action: 'answer', text: '파랑', trusted: true });
    await t.until(() => results(t).length === 2, 'the first answer');
    const second = await waitCard(t);
    t.call('answerCard', { id: second.id, action: 'answer', text: '직접 쓴 답', trusted: true });
    await t.until(() => results(t).length === 3, 'the second answer');
    const third = await waitCard(t);
    t.call('answerCard', { id: third.id, action: 'deny', trusted: true });
    await t.doneOf(sessionId);
    const r = results(t);
    assert.deepEqual(r[0].tools, ['approve', 'ask_user', 'list_recipes', 'read_recipe', 'save_memory', 'list_memory']);
    assert.deepEqual([r[1].text, r[2].text], ['파랑', '직접 쓴 답']);
    assert.equal(r[3].isError, true);
  } finally {
    t.cleanup();
  }
});

test('the arguments and config: approve and ask_user wired, AskUserQuestion not offered, the token gone after the run', async () => {
  const t = ready({ strictResume: true });
  try {
    const { sessionId } = t.send('x');
    await t.doneOf(sessionId);
    const a = t.ws.calls()[0].args;
    assert.equal(a[a.indexOf('--permission-prompt-tool') + 1], 'mcp__ai-chat-host__approve');
    assert.equal(a[a.indexOf('--allowedTools') + 1], 'mcp__ai-chat-host__ask_user,mcp__ai-chat-host__list_recipes,mcp__ai-chat-host__read_recipe,mcp__ai-chat-host__save_memory,mcp__ai-chat-host__list_memory,mcp__desk-widgets__dooray_fetch_file,mcp__desk-widgets__dooray_fetch_file_status');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.doesNotMatch(a[a.indexOf('--tools') + 1], /AskUserQuestion/);
    assert.ok(!a.join(' ').includes(FAKE_KEY));
    const configFile = a[a.indexOf('--mcp-config') + 1];
    assert.ok(!fs.existsSync(configFile), 'the file with the run token is removed with the run');
    assert.deepEqual(fs.readdirSync(path.dirname(configFile)), []);
  } finally {
    t.cleanup();
  }
});

test('the MCP config holds no key, gives each server its own env, and no key reaches a server', async () => {
  const t = ready();
  try {
    // A server that reports its environment, standing in for ai-chat-host in the config the run builds.
    const seen = path.join(t.ws.dir, 'config-copy.json');
    t.ws.setBehavior({ copyMcpConfig: seen });
    const { sessionId } = t.send('x');
    await t.doneOf(sessionId);
    const text = fs.readFileSync(seen, 'utf8');
    assert.ok(!text.includes(FAKE_KEY));
    const config = JSON.parse(text);
    const host = config.mcpServers['ai-chat-host'];
    assert.deepEqual(Object.keys(config.mcpServers), ['ai-chat-host']);
    assert.equal(host.env.ELECTRON_RUN_AS_NODE, '1');
    assert.match(host.env.AI_CHAT_HOST_TOKEN, /^[0-9a-f]{48}$/);
    assert.ok(!host.args.join(' ').includes(host.env.AI_CHAT_HOST_TOKEN), 'the token is not on a command line');
    assert.ok(host.args[0].endsWith('ai-chat-host.js'));
    assert.equal(t.ws.calls()[0].env.ELECTRON_RUN_AS_NODE, undefined, 'only that server gets Node mode');
    assert.equal(t.ws.calls()[0].env.AI_CHAT_HOST_TOKEN, undefined, 'and only that server gets the token');
    for (const f of allFiles(t.fake.ctx.dataDir)) assert.ok(!fs.readFileSync(f, 'utf8').includes(FAKE_KEY), f);
  } finally {
    t.cleanup();
  }
});

test('host pipe: a connection without the token is dropped and can ask nothing', async () => {
  const asked = [];
  const host = await createHostServer((method, args) => {
    asked.push([method, args]);
    return { behavior: 'allow' };
  });
  try {
    const talk = (lines) => new Promise((resolve) => {
      const s = net.connect(`\\\\.\\pipe\\ai-chat-host-${host.id}`);
      let got = '';
      s.setEncoding('utf8');
      s.on('connect', () => { for (const l of lines) s.write(`${l}\n`); });
      s.on('data', (d) => {
        got += d;
        s.destroy();
      });
      s.on('error', () => resolve(got));
      s.on('close', () => resolve(got));
      setTimeout(() => s.destroy(), 400);
    });
    assert.equal(await talk([JSON.stringify({ id: 1, method: 'approve', args: {} })]), '');
    assert.equal(await talk([JSON.stringify({ token: 'wrong' }), JSON.stringify({ id: 1, method: 'approve', args: {} })]), '');
    assert.equal(await talk(['not json']), '');
    assert.deepEqual(asked, []);
    const ok = await talk([JSON.stringify({ token: host.token }), JSON.stringify({ id: 7, method: 'approve', args: { a: 1 } })]);
    assert.deepEqual(JSON.parse(ok), { id: 7, result: { behavior: 'allow' } });
    assert.deepEqual(asked, [['approve', { a: 1 }]]);
  } finally {
    await host.close();
  }
});

test('with no widget to ask, the host denies: approval never defaults to allow', async () => {
  const child = cp.spawn(process.execPath, [HOST], { env: { AI_CHAT_HOST_PIPE: 'abcdefabcdefabcdef', AI_CHAT_HOST_TOKEN: 'x', SystemRoot: process.env.SystemRoot }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  try {
    const out = await new Promise((resolve) => {
      let got = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        got += d;
        if (got.split('\n').length >= 3) resolve(got);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: {} } } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'q' } } })}\n`);
    });
    const [a, b] = out.trim().split('\n').map((l) => JSON.parse(l)).sort((x, y) => x.id - y.id);
    assert.equal(JSON.parse(a.result.content[0].text).behavior, 'deny');
    assert.equal(b.result.isError, true);
  } finally {
    child.kill();
  }
});

// ---- what a card shows ----

test('a card shows hidden characters and the full input, and keeps the input itself to itself', () => {
  const ch = (code) => String.fromCodePoint(code);
  const sneaky = `rm -rf ${ch(0x202e)}fdp.exe${ch(0x200b)}${ch(7)} ${ch(0xe0041)}`;
  const v = visibleText(sneaky);
  assert.equal(v.hidden, 4);
  assert.equal(v.text, 'rm -rf [U+202E]fdp.exe[U+200B][U+0007] [U+E0041]');
  assert.deepEqual(visibleText(`한글 tab${ch(9)}here${ch(10)}new`).hidden, 0);
  const card = approvalCard({ tool_name: `Bash${ch(0x202e)}`, input: { command: sneaky }, tool_use_id: 't' });
  assert.equal(card.view.tool, 'Bash[U+202E]');
  assert.ok(card.view.inputText.includes('[U+202E]fdp.exe'));
  assert.ok(!card.view.inputText.includes(ch(0x202e)));
  assert.ok(card.view.hidden >= 3);
  assert.equal(card.input.command, sneaky, 'what runs is what was asked, unchanged');
  assert.equal(card.view.input, undefined);
  const long = 'x'.repeat(50000);
  assert.ok(approvalCard({ tool_name: 'Write', input: { content: long } }).view.inputText.includes(long), 'the full input');
  const q = questionCard({ question: `q${ch(0x200b)}`, options: [`a${ch(0x202e)}`, 3, 'b'] });
  assert.deepEqual([q.view.question, q.view.options, q.view.hidden], ['q[U+200B]', ['a[U+202E]', 'b'], 2]);
  for (const bad of [null, 'x', { input: 'text' }]) assert.deepEqual(approvalCard(bad).input, {});
});

test('too large to read is refused, never approved unseen', async () => {
  assert.equal(approvalCard({ tool_name: 'Write', input: { content: 'x'.repeat(MAX_INPUT_TEXT + 1) } }).tooLarge, true);
  const t = ready();
  try {
    const target = path.join(t.ws.dir, 'big.txt');
    t.ws.setBehavior({ mcpFlow: [approveWrite(target, 'x'.repeat(MAX_INPUT_TEXT + 1))] });
    const { sessionId } = t.send('x');
    await t.doneOf(sessionId);
    assert.ok(!fs.existsSync(target));
    assert.equal(results(t)[0].answer.behavior, 'deny');
    assert.deepEqual(t.win.sent.filter(([n, c]) => n === 'cards' && c.length), []);
  } finally {
    t.cleanup();
  }
});

test('window closed: an engine card says one waits, with no content and no way to approve from it', async () => {
  const t = ready();
  try {
    const target = path.join(t.ws.dir, 'closed.txt');
    t.ws.setBehavior({ mcpFlow: [approveWrite(target, 'SECRET-CONTENT')] });
    const { sessionId } = t.send('비밀 작업');
    t.win.hiddenForTest = true;
    await t.until(() => t.fake.notified.length, 'the alert');
    const { events, options } = t.fake.notified[0];
    assert.equal(events[0].type, 'card');
    assert.equal(events[0].sticky, true);
    assert.match(events[0].title, /승인이 필요합니다/);
    assert.ok(!JSON.stringify(events).includes('SECRET-CONTENT'));
    assert.deepEqual(events[0].actions, [{ id: 'open', label: '열기' }]);
    // Its only button opens the window; nothing is approved.
    options.onAction(events[0], 'open');
    await sleep(200);
    assert.ok(!fs.existsSync(target));
    assert.equal((await t.call('state')).cards.length, 1, 'still waiting for a click in the window');
    assert.ok(t.win.sent.some(([n, id]) => n === 'focusSession' && id === sessionId));
    t.call('stop', sessionId);
    await t.doneOf(sessionId);
  } finally {
    t.cleanup();
  }
});

test('a card shown in an open window raises no notification', async () => {
  const t = ready();
  try {
    t.ws.setBehavior({ mcpFlow: [approveWrite(path.join(t.ws.dir, 'x.txt'))] });
    const { sessionId } = t.send('x');
    await waitCard(t);
    assert.equal(t.fake.notified.length, 0);
    t.call('stop', sessionId);
    await t.doneOf(sessionId);
  } finally {
    t.cleanup();
  }
});

// ---- the bridge ----

test('AI 도우미 연결 on: the real bridge is in the config with --strict-mcp-config and answers; off: it is not there', async () => {
  const bridgeFile = path.join(ROOT, 'engine', 'mcp', 'bridge.js');
  const bridge = () => ({ command: process.execPath, args: [bridgeFile, '--dir=C:\\nowhere-ai-chat-test'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  const on = ready({}, { deps: { widgetTools: () => ({ state: 'on', tools: ['desk_widgets_status'], server: bridge() }) } });
  try {
    on.ws.setBehavior({ mcpFlow: [{ server: 'desk-widgets', list: true }] });
    const { sessionId } = on.send('x');
    assert.equal((await on.doneOf(sessionId)).ok, true);
    const a = on.ws.calls()[0].args;
    assert.ok(a.includes('--strict-mcp-config'));
    assert.ok(results(on)[0].tools.includes('desk_widgets_status'), 'the real bridge started from the config');
    assert.ok(on.ws.calls()[0].keyFromHelper);
  } finally {
    on.cleanup();
  }
  const off = ready();
  try {
    off.ws.setBehavior({ copyMcpConfig: path.join(off.ws.dir, 'copy.json') });
    const { sessionId } = off.send('x');
    await off.doneOf(sessionId);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(off.ws.dir, 'copy.json'), 'utf8')).mcpServers), ['ai-chat-host']);
  } finally {
    off.cleanup();
  }
});

// ---- the widget's key typed by the user (self-check before the public release) ----

test('the key typed into a prompt, a conversation name or a card answer never reaches Claude Code or the record', async () => {
  const t = ready();
  try {
    const refused = t.send(`이 키로 해 줘 ${FAKE_KEY}`);
    assert.deepEqual([refused.ok, refused.code], [false, 'key-in-prompt']);
    assert.equal(t.send(`쪼개서 ${FAKE_KEY.slice(0, 12)} ${FAKE_KEY.slice(12)}`).code, 'key-in-prompt', 'broken up too');
    assert.equal(t.call('list').sessions.length, 0, 'no conversation was made');
    assert.deepEqual(t.ws.calls(), []);

    t.ws.setBehavior({ mcpFlow: [{ list: true }, { tool: 'ask_user', args: { question: '키?' } }, { tool: 'ask_user', args: { question: '또?' } }, approveWrite(path.join(t.ws.dir, 'x.txt'))] });
    t.widget.settings.save({ mode: 'default' });
    const { sessionId } = t.send('x');
    const first = await waitCard(t);
    assert.equal(t.call('answerCard', { id: first.id, action: 'answer', text: `여기 ${FAKE_KEY} 입니다`, trusted: true }), true);
    await t.until(() => results(t).length === 2, 'the first answer');
    const second = await waitCard(t);
    t.call('answerCard', { id: second.id, action: 'answer', text: Buffer.from(FAKE_KEY).toString('base64'), trusted: true });
    await t.until(() => results(t).length === 3, 'the second answer');
    const third = await waitCard(t);
    t.call('answerCard', { id: third.id, action: 'deny', text: `싫어요 ${FAKE_KEY}`, trusted: true });
    await t.doneOf(sessionId);
    const r = results(t);
    assert.deepEqual([r[1].text, r[2].text], ['여기 [키 가림] 입니다', '[키 가림]']);
    assert.match(JSON.stringify(r[3].answer), /싫어요 \[키 가림\]/);
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY));

    const renamed = t.call('renameSession', { id: sessionId, title: `이름 ${FAKE_KEY}` });
    assert.deepEqual([renamed.ok, renamed.code], [false, 'key-in-name']);
    for (const file of allFiles(path.join(t.fake.ctx.dataDir, 'sessions'))) assert.ok(!fs.readFileSync(file, 'utf8').includes(FAKE_KEY), file);
  } finally {
    t.cleanup();
  }
});

test('on start, run files a crash left behind (MCP config with its token, instructions) are removed, nothing else', () => {
  const { workspace, fakeContext } = require('./helpers');
  const { create } = require('../index');
  const ws = workspace({});
  const fake = fakeContext(ws);
  const run = path.join(fake.ctx.dataDir, 'run');
  fs.mkdirSync(run, { recursive: true });
  const stale = ['mcp-0123456789abcdef.json', 'note-0123456789abcdef.md'];
  for (const name of [...stale, 'keep.txt']) fs.writeFileSync(path.join(run, name), 'x');
  const widget = create(fake.ctx, { resolve: ws.resolve, exe: process.execPath, documents: path.join(ws.dir, 'documents'), widgetTools: () => ({ state: 'off', tools: [] }) });
  try {
    widget.start();
    assert.deepEqual(fs.readdirSync(run), ['keep.txt']);
  } finally {
    widget.stop();
    ws.cleanup();
  }
});
