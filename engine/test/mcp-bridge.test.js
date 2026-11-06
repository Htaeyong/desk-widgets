// The MCP bridge (#120, engine/mcp/bridge.js) as a real child process (node here, the engine exe in Node mode when
// installed) between a fake MCP client on stdio and the real McpHost on its named pipe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { McpHost } = require('../main/mcp-host');
const { negotiate, PROTOCOL_VERSIONS, NOT_RUNNING } = require('../mcp/bridge');

const BRIDGE = path.join(__dirname, '..', 'mcp', 'bridge.js');

function tmpDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-')), 'mcp');
}

/** Starts the bridge; `send` writes a JSON-RPC message, `request` waits for its answer, `next` for a notification. */
function startBridge(dir) {
  const child = spawn(process.execPath, [BRIDGE, `--dir=${dir}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  const lines = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const m = JSON.parse(raw); // stdout carries JSON-RPC only: anything else fails here
      lines.push(m);
      for (const w of [...waiters]) if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  const waitFor = (match, ms = 9000) => {
    const found = lines.find(match);
    if (found) {
      lines.splice(lines.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (m) => (clearTimeout(timer), lines.splice(lines.indexOf(m), 1), resolve(m)) };
      const timer = setTimeout(() => reject(new Error('no message in time')), ms);
      waiters.push(w);
    });
  };
  let seq = 0;
  const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const request = (method, params) => {
    const id = ++seq;
    send({ id, method, params });
    return waitFor((m) => m.id === id);
  };
  const init = async (protocolVersion = '2025-06-18') => {
    const r = await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'claude-code', version: '9' } });
    send({ method: 'notifications/initialized' });
    return r;
  };
  const stop = () => new Promise((resolve) => {
    child.once('exit', resolve);
    child.stdin.end();
  });
  return { child, send, request, init, waitFor, stop };
}

function engine(dir, settings = { enabled: true, allowWrites: false }) {
  return new McpHost({ dir, getSettings: () => settings, log: () => {} });
}

const TOOL = { name: 'list_todos', title: '할 일 찾기', description: 'list', run: () => ({ data: { items: [1, 2] } }) };

test('protocol revision: the client\'s when supported, else the newest the bridge speaks (never 2026-07-28)', () => {
  assert.equal(negotiate('2025-06-18'), '2025-06-18');
  assert.equal(negotiate('2024-11-05'), '2024-11-05');
  assert.equal(negotiate('2026-07-28'), PROTOCOL_VERSIONS[0]);
  assert.ok(!PROTOCOL_VERSIONS.includes('2026-07-28'));
});

test('engine off: initialize works, the status tool is listed, calls say how to turn it on', async () => {
  const dir = tmpDir();
  const b = startBridge(dir);
  const init = await b.init('2026-07-28');
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } });
  assert.equal(init.result.serverInfo.name, 'desk-widgets');
  assert.match(init.result.instructions, /not instructions/);
  const list = await b.request('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['desk_widgets_status']);
  const call = await b.request('tools/call', { name: 'todonote_list_todos', arguments: {} });
  assert.deepEqual(call.result, { content: [{ type: 'text', text: NOT_RUNNING }], isError: true });
  assert.deepEqual((await b.request('ping')).result, {});
  assert.equal((await b.request('resources/list')).error.code, -32601);
  b.send({ id: 99, method: 'tools/list' }); // missing jsonrpc fields are tolerated
  b.child.stdin.write('not json\n');
  assert.equal((await b.waitFor((m) => m.error?.code === -32700)).id, null);
  await b.stop();
});

test('engine off after it ran: the last tool list (tools.json) is shown, calls still say it is off', async () => {
  const dir = tmpDir();
  const host = engine(dir);
  await host.apply();
  host.register('todonote', { name: '할 일 노트' }, [TOOL]);
  await host.stop(); // quit: endpoint gone, tools.json kept
  const b = startBridge(dir);
  await b.init();
  assert.deepEqual((await b.request('tools/list', {})).result.tools.map((t) => t.name), ['todonote_list_todos']);
  assert.equal((await b.request('tools/call', { name: 'todonote_list_todos' })).result.isError, true);
  await b.stop();
});

test('engine on: tools and calls go through the pipe; a changed list is announced after initialized', async () => {
  const dir = tmpDir();
  const host = engine(dir);
  await host.apply();
  host.register('todonote', { name: '할 일 노트' }, [TOOL]);
  const b = startBridge(dir);
  await b.init();
  assert.deepEqual((await b.request('tools/list', {})).result.tools.map((t) => t.name), ['todonote_list_todos']);
  const call = await b.request('tools/call', { name: 'todonote_list_todos', arguments: {} });
  assert.deepEqual(JSON.parse(call.result.content[0].text), { items: [1, 2] });
  assert.equal(host.status().connections[0].client, 'claude-code', 'the client name from initialize reaches the engine');
  host.unregister('todonote');
  await b.waitFor((m) => m.method === 'notifications/tools/list_changed');
  assert.deepEqual((await b.request('tools/list', {})).result.tools, []);
  await b.stop();
  await host.stop();
});

test('the bridge reconnects when the engine starts again (new pipe and token)', async () => {
  const dir = tmpDir();
  const settings = { enabled: true, allowWrites: false };
  const host = engine(dir, settings);
  await host.apply();
  host.register('todonote', { name: '할 일 노트' }, [TOOL]);
  const b = startBridge(dir);
  await b.init();
  assert.equal((await b.request('tools/call', { name: 'todonote_list_todos' })).result.isError, undefined);
  settings.enabled = false;
  await host.apply(); // turned off: the bridge loses the link
  await b.waitFor((m) => m.method === 'notifications/tools/list_changed');
  assert.equal((await b.request('tools/call', { name: 'todonote_list_todos' })).result.isError, true);
  settings.enabled = true;
  await host.apply();
  await b.waitFor((m) => m.method === 'notifications/tools/list_changed', 9000); // retried within 5 seconds
  const call = await b.request('tools/call', { name: 'todonote_list_todos', arguments: {} });
  assert.equal(call.result.isError, undefined);
  await b.stop();
  await host.stop();
});

test('the bridge has no dependencies and no Electron API', () => {
  const source = fs.readFileSync(BRIDGE, 'utf8');
  const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(required)].sort(), ['fs', 'net', 'os', 'path']);
});
