// "AI 도우미 연결 (MCP)" engine side (#120): a fake MCP client talks to McpHost over its real named pipe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { McpHost, sanitizeSettings, checkInput, cleanTools, installCommands, LIMITS } = require('../main/mcp-host');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcp-${name}-`));
}

/** A host with settings in memory, cards collected, and a clock the test moves. */
function makeHost(settings = {}, extra = {}) {
  const dir = path.join(tmp('host'), 'mcp');
  let s = { enabled: true, allowWrites: false, widgets: {}, ...settings };
  let now = Date.parse('2026-11-06T09:00:00Z');
  const cards = [];
  const host = new McpHost({
    dir,
    getSettings: () => s,
    notify: (events, opts) => cards.push({ ...events[0], onAction: opts.onAction }),
    log: () => {},
    now: () => now,
    ...extra,
  });
  return { host, dir, cards, set: (v) => (s = { ...s, ...v }), tick: (ms) => (now += ms), file: (n) => path.join(dir, n) };
}

/** A pipe client like the bridge: hello with the token, then requests; collects events. */
async function connect(dir, { token } = {}) {
  const endpoint = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'));
  const socket = net.connect(endpoint.pipe);
  socket.setEncoding('utf8');
  const waiting = new Map();
  const events = [];
  let hello;
  const helloP = new Promise((r) => (hello = r));
  let closed;
  const closedP = new Promise((r) => (closed = r));
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (m.type === 'hello') hello(m);
      else if (m.event) events.push(m.event);
      else waiting.get(m.id)?.(m);
    }
  });
  socket.on('close', () => closed());
  socket.on('error', () => {});
  await new Promise((r) => socket.once('connect', r));
  socket.write(`${JSON.stringify({ type: 'hello', token: token ?? endpoint.token, client: 'claude-code', version: 'test' })}\n`);
  let seq = 0;
  const request = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return {
    hello: () => Promise.race([helloP, closedP.then(() => ({ closed: true }))]),
    closed: closedP,
    events,
    list: async () => (await request('tools/list', {})).result.tools,
    call: async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result,
    end: () => socket.destroy(),
  };
}

const textOf = (r) => JSON.parse(r.content[0].text);

function sampleTools(log = []) {
  return [
    {
      name: 'list_todos', title: '할 일 찾기', description: 'list',
      inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, q: { type: 'string', maxLength: 5 } } },
      run: (input, info) => ({ data: { items: ['a'], input, client: info.client } }),
    },
    {
      name: 'set_due', title: '마감 정하기', description: 'set', write: true, idempotent: true,
      inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
      run: async (input) => {
        log.push(`set ${input.id}`);
        return { data: { ok: true }, summary: `${input.id} 마감 → 금`, undo: async () => log.push(`undo ${input.id}`), open: () => log.push(`open ${input.id}`) };
      },
    },
    { name: 'big', title: 'big', run: () => ({ data: 'x'.repeat(LIMITS.MAX_RESULT_CHARS + 10) }) },
    { name: 'boom', title: 'boom', run: () => { throw new Error('노트를 찾을 수 없습니다.'); } },
  ];
}

test('settings: off unless turned on, writes off unless allowed, per widget read/write default on', () => {
  assert.deepEqual(sanitizeSettings(undefined), { enabled: false, allowWrites: false, widgets: {} });
  assert.deepEqual(sanitizeSettings({ enabled: 1, allowWrites: 'yes', widgets: { todonote: { write: false }, 'BAD ID': {} } }),
    { enabled: false, allowWrites: false, widgets: { todonote: { read: true, write: false } } });
});

test('tool declarations are cleaned: name rule, duplicates, at most 20, a run function', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `t${i}`, run() {} }));
  assert.equal(cleanTools(many).length, LIMITS.MAX_TOOLS);
  assert.deepEqual(cleanTools([{ name: 'Bad-Name', run() {} }, { name: 'ok', run() {} }, { name: 'ok', run() {} }, { name: 'norun' }]).map((t) => t.name), ['ok']);
});

test('input check: required, unknown keys, types, lengths, ranges, enums', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['id'], properties: {
    id: { type: 'string', maxLength: 3 }, n: { type: 'integer', minimum: 1, maximum: 5 }, s: { type: 'string', enum: ['a', 'b'] }, b: { type: 'boolean' },
  } };
  assert.equal(checkInput(schema, { id: 'abc', n: 2, s: 'a', b: true }), null);
  assert.match(checkInput(schema, {}), /"id" 값이 필요/);
  assert.match(checkInput(schema, { id: 'a', x: 1 }), /알 수 없는 입력/);
  assert.match(checkInput(schema, { id: 'abcd' }), /너무 깁니다/);
  assert.match(checkInput(schema, { id: 'a', n: 1.5 }), /정수/);
  assert.match(checkInput(schema, { id: 'a', n: 9 }), /이하/);
  assert.match(checkInput(schema, { id: 'a', s: 'c' }), /중 하나/);
  assert.match(checkInput(schema, { id: 'a', b: 'yes' }), /true\/false/);
  assert.match(checkInput(schema, []), /객체/);
});

test('off: no pipe and no files; on: endpoint.json with a random pipe and token, tools.json; off again removes both', async () => {
  const t = makeHost({ enabled: false });
  await t.host.apply();
  assert.equal(fs.existsSync(t.file('endpoint.json')), false);
  t.set({ enabled: true });
  await t.host.apply();
  const e1 = JSON.parse(fs.readFileSync(t.file('endpoint.json'), 'utf8'));
  assert.match(e1.pipe, /desk-widgets-mcp-[0-9a-f]{32}/);
  assert.match(e1.token, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(t.file('tools.json')));
  t.set({ enabled: false });
  await t.host.apply();
  assert.equal(fs.existsSync(t.file('endpoint.json')), false);
  assert.equal(fs.existsSync(t.file('tools.json')), false);
  // A new start: a new pipe name and token.
  t.set({ enabled: true });
  await t.host.apply();
  const e2 = JSON.parse(fs.readFileSync(t.file('endpoint.json'), 'utf8'));
  assert.notEqual(e2.pipe, e1.pipe);
  assert.notEqual(e2.token, e1.token);
  await t.host.stop();
  assert.equal(fs.existsSync(t.file('endpoint.json')), false, 'quit removes the endpoint');
  assert.ok(fs.existsSync(t.file('tools.json')), 'quit keeps the tool list for the bridge');
});

test('a wrong token is refused and the connection closed', async () => {
  const t = makeHost();
  await t.host.apply();
  const c = await connect(t.dir, { token: 'f'.repeat(64) });
  const hello = await c.hello();
  assert.ok(hello.closed || hello.ok === false);
  await c.closed;
  assert.equal(t.host.status().connections.length, 0);
  await t.host.stop();
});

test('tools: names get the widget prefix and annotations; write tools only when writes are allowed', async () => {
  const t = makeHost();
  await t.host.apply();
  t.host.register('todonote', { name: '할 일 노트' }, sampleTools());
  const c = await connect(t.dir);
  assert.equal((await c.hello()).ok, true);
  let tools = await c.list();
  assert.deepEqual(tools.map((x) => x.name), ['todonote_list_todos', 'todonote_big', 'todonote_boom']);
  assert.deepEqual(tools[0].annotations, { title: '할 일 찾기', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const refused = await c.call('todonote_set_due', { id: 'n1' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /쓰기 허용/);
  t.set({ allowWrites: true });
  await t.host.apply();
  tools = await c.list();
  assert.ok(c.events.includes('tools-changed'), 'the bridge hears that the list changed (sent before the list answer)');
  const write = tools.find((x) => x.name === 'todonote_set_due');
  assert.deepEqual(write.annotations, { title: '마감 정하기', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  // Per widget: writes off for this widget hides them again; reads off hides everything.
  t.set({ widgets: { todonote: { read: true, write: false } } });
  assert.equal((await c.list()).some((x) => x.name === 'todonote_set_due'), false);
  t.set({ widgets: { todonote: { read: false, write: true } } });
  assert.deepEqual(await c.list(), []);
  c.end();
  await t.host.stop();
});

test('calls: input checked first, results as JSON text, errors and oversize results as isError', async () => {
  const t = makeHost();
  await t.host.apply();
  t.host.register('todonote', { name: '할 일 노트' }, sampleTools());
  const c = await connect(t.dir);
  await c.hello();
  const ok = await c.call('todonote_list_todos', { limit: 3 });
  assert.deepEqual(textOf(ok), { items: ['a'], input: { limit: 3 }, client: 'claude-code' });
  assert.match((await c.call('todonote_list_todos', { limit: 99 })).content[0].text, /50 이하/);
  assert.match((await c.call('todonote_list_todos', { nope: 1 })).content[0].text, /알 수 없는 입력/);
  assert.match((await c.call('todonote_list_todos', { q: 'x'.repeat(70 * 1024) })).content[0].text, /64KB/);
  const big = await c.call('todonote_big');
  assert.equal(big.isError, true);
  assert.match(big.content[0].text, /너무 큽니다/);
  const boom = await c.call('todonote_boom');
  assert.deepEqual(boom, { content: [{ type: 'text', text: '노트를 찾을 수 없습니다.' }], isError: true });
  assert.match((await c.call('todonote_nothing')).content[0].text, /알 수 없는 도구/);
  // A stopped widget: its tools are gone.
  t.host.unregister('todonote');
  assert.deepEqual(await c.list(), []);
  c.end();
  await t.host.stop();
});

test('writes: one card per write, grouped within 5 seconds, undo within 10 minutes, a log without note text', async () => {
  const log = [];
  const t = makeHost({ allowWrites: true });
  await t.host.apply();
  t.host.register('todonote', { name: '할 일 노트' }, sampleTools(log));
  const c = await connect(t.dir);
  await c.hello();
  await c.call('todonote_set_due', { id: 'n1' });
  assert.equal(t.cards.length, 1);
  assert.equal(t.cards[0].title, 'Claude가 할 일 노트를 바꿨습니다');
  assert.equal(t.cards[0].body, 'n1 마감 → 금');
  assert.deepEqual(t.cards[0].actions.map((a) => a.id), ['undo', 'open']);
  t.tick(2000);
  await c.call('todonote_set_due', { id: 'n2' });
  assert.equal(t.cards.length, 2);
  assert.equal(t.cards[1].tag, t.cards[0].tag, 'the same card is replaced');
  assert.equal(t.cards[1].title, 'Claude가 할 일 노트에서 2개를 바꿨습니다');
  assert.deepEqual(t.cards[1].actions.map((a) => a.id), ['undo'], 'open only for one change');
  await t.cards[1].onAction({}, 'undo');
  assert.deepEqual(log, ['set n1', 'set n2', 'undo n2', 'undo n1'], 'undone newest first');
  t.tick(6000);
  await c.call('todonote_set_due', { id: 'n3' });
  assert.notEqual(t.cards[2].tag, t.cards[0].tag, 'a later write starts a new card');
  t.tick(LIMITS.UNDO_MS + 1);
  await assert.rejects(Promise.resolve(t.cards[2].onAction({}, 'undo')), /10분/);
  await t.cards[2].onAction({}, 'open');
  assert.ok(log.includes('open n3'));
  const entries = t.host.recentLog();
  assert.ok(entries.some((e) => e.tool === 'todonote_set_due' && e.summary === 'n1 마감 → 금' && e.client === 'claude-code'));
  assert.ok(entries.some((e) => e.tool === 'undo' && e.client === 'user'));
  c.end();
  await t.host.stop();
});

test('writes are limited to 30 in 10 minutes per connection and run one after another per widget', async () => {
  const order = [];
  const t = makeHost({ allowWrites: true });
  await t.host.apply();
  let active = 0;
  t.host.register('todonote', { name: '할 일 노트' }, [{
    name: 'slow', title: 'slow', write: true, inputSchema: { type: 'object', properties: { i: { type: 'integer' } } },
    run: async ({ i }) => {
      active++;
      assert.equal(active, 1, 'never two writes of one widget at once');
      await new Promise((r) => setTimeout(r, 5));
      order.push(i);
      active--;
      return { data: i, summary: `w${i}` };
    },
  }]);
  const c = await connect(t.dir);
  await c.hello();
  await Promise.all([1, 2, 3].map((i) => c.call('todonote_slow', { i })));
  assert.deepEqual(order, [1, 2, 3]);
  for (let i = 4; i <= 30; i++) await c.call('todonote_slow', { i });
  const limited = await c.call('todonote_slow', { i: 31 });
  assert.equal(limited.isError, true);
  assert.match(limited.content[0].text, /10분에 30번/);
  t.tick(LIMITS.WRITE_WINDOW_MS + 1);
  assert.equal((await c.call('todonote_slow', { i: 32 })).isError, undefined);
  c.end();
  await t.host.stop();
});

test('a widget that does not answer in 10 seconds gets a timeout (fake timers)', async (tt) => {
  tt.mock.timers.enable({ apis: ['setTimeout'] });
  const t = makeHost();
  t.host.register('todonote', { name: '할 일 노트' }, [{ name: 'hang', title: 'hang', run: () => new Promise(() => {}) }]);
  const tool = t.host.registry.get('todonote').tools[0];
  const pending = t.host.runTool(tool, {}, {});
  tt.mock.timers.tick(LIMITS.TOOL_TIMEOUT_MS);
  assert.match((await pending).error, /시간 초과/);
});

test('install commands: the engine exe in Node mode and the unpacked bridge; --dir only for a non-default data folder', () => {
  const exe = 'C:\\Program Files\\chilgong88\\Desk Widgets\\Desk Widgets.exe';
  const bridge = 'C:\\Program Files\\chilgong88\\Desk Widgets\\resources\\app.asar.unpacked\\engine\\mcp\\bridge.js';
  const c = installCommands({ exe, bridge });
  assert.equal(c.code, `claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 --transport stdio desk-widgets -- "${exe}" "${bridge}"`);
  const desktop = JSON.parse(`{${c.desktop}}`);
  assert.deepEqual(desktop, { 'desk-widgets': { command: exe, args: [bridge], env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const other = installCommands({ exe, bridge, dir: 'C:\\temp\\data\\mcp' });
  assert.match(other.code, /"--dir=C:\\temp\\data\\mcp"$/);
  assert.deepEqual(JSON.parse(`{${other.desktop}}`)['desk-widgets'].args, [bridge, '--dir=C:\\temp\\data\\mcp']);
});

test('the bridge file is unpacked from the asar in the engine package', () => {
  const pkg = require('../../package.json');
  assert.ok(pkg.build.asarUnpack.includes('engine/mcp/**'));
  assert.ok(pkg.build.files.some((f) => f === 'engine/**/*'));
});
