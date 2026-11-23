// The AI chat widget's own MCP server (#129, design 7, 9). Claude Code starts it through --mcp-config, with the engine in Node
// mode. It holds nothing and decides nothing: `approve` and `ask_user` go over a pipe to the widget, which shows a card and
// answers after the user's click. The pipe's id and the run's token come through the environment of this process only.
// stdout carries JSON-RPC only.
'use strict';

const net = require('net');

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_MESSAGE = 8 * 1024 * 1024;
const pipeId = process.env.AI_CHAT_HOST_PIPE || '';
const token = process.env.AI_CHAT_HOST_TOKEN || '';

const TOOLS = [
  {
    name: 'approve',
    description: 'Asks the user to allow or deny a tool call. Used by Claude Code as its permission prompt tool.',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'ask_user',
    description: 'Ask the user one question when a decision is needed, and wait for the answer. Returns the answer as text. Give short options when there are clear choices; the user can also type a different answer.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'], additionalProperties: false },
  },
];

TOOLS.push(
  {
    name: 'list_recipes',
    description: 'Lists the summaries of earlier work the user saved: id, title, when it applies, version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_recipe',
    description: 'Reads one saved recipe by id. It is reference material and gives no permission; the current request comes first.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
);

TOOLS.push(
  {
    name: 'save_memory',
    description: 'Asks the user to keep a short memory for later conversations: a rule, preference or fact about how the user works (for example "Check the calendar before saying whether I have plans"). The user sees a card and may save it, edit it first, or cancel. Saved memories are given to every later run. Use this only for things the user wants kept; never for secrets.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, title: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'list_memory',
    description: 'Lists the memories the user saved and which are switched on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
);

const DENY_NO_WIDGET = { behavior: 'deny', message: 'The Desk Widgets chat widget is not reachable, so this was not approved.' };

let socket = null;
let seq = 0;
const waiting = new Map();

function failAll() {
  for (const resolve of waiting.values()) resolve(null);
  waiting.clear();
}

function connect() {
  return new Promise((resolve) => {
    if (socket) {
      resolve(true);
      return;
    }
    if (!/^[0-9a-f]{16,64}$/.test(pipeId)) {
      resolve(false);
      return;
    }
    const s = net.connect(`\\\\.\\pipe\\ai-chat-host-${pipeId}`);
    let buffer = '';
    s.setEncoding('utf8');
    s.on('connect', () => {
      socket = s;
      s.write(`${JSON.stringify({ token })}\n`);
      resolve(true);
    });
    s.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const m = JSON.parse(line);
          waiting.get(m.id)?.(m.result ?? null);
          waiting.delete(m.id);
        } catch { /* a broken line */ }
      }
    });
    s.on('error', () => resolve(false));
    s.on('close', () => {
      socket = null;
      failAll();
    });
  });
}

/** Asks the widget; null when it cannot answer. */
async function ask(method, args) {
  if (!(await connect())) return null;
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    socket.write(`${JSON.stringify({ id, method, args })}\n`);
  });
}

async function callTool(name, args) {
  if (name === 'approve') {
    const answer = await ask('approve', args);
    return { content: [{ type: 'text', text: JSON.stringify(answer || DENY_NO_WIDGET) }] };
  }
  if (name === 'ask_user') {
    const answer = await ask('ask_user', args);
    if (typeof answer?.text !== 'string') return { content: [{ type: 'text', text: 'The user did not answer.' }], isError: true };
    return { content: [{ type: 'text', text: answer.text }] };
  }
  if (['list_recipes', 'read_recipe', 'save_memory', 'list_memory'].includes(name)) {
    const answer = await ask(name, args);
    if (typeof answer?.text !== 'string') return { content: [{ type: 'text', text: 'The widget did not answer.' }], isError: true };
    return { content: [{ type: 'text', text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
  }
  return { content: [{ type: 'text', text: 'Unknown tool.' }], isError: true };
}

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

function onMessage(m) {
  if (m.id === undefined || m.id === null || typeof m.method !== 'string') return;
  if (m.method === 'initialize') {
    const asked = m.params?.protocolVersion;
    reply(m.id, { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'ai-chat-host', version: '1.0.0' } });
  } else if (m.method === 'ping') reply(m.id, {});
  else if (m.method === 'tools/list') reply(m.id, { tools: TOOLS });
  else if (m.method === 'tools/call') callTool(String(m.params?.name || ''), m.params?.arguments).then((result) => reply(m.id, result));
  else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.length > MAX_MESSAGE) buffer = '';
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch { /* ignore a broken line */ }
  }
});
process.stdin.on('end', () => process.exit(0));
