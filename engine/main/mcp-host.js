// "AI 도우미 연결 (MCP)" engine side (#120, docs/claude-mcp-design.md 3-6).
//
// Widgets declare tools with ctx.mcp.registerTools (engine API 1.10). While the user has the connection turned on,
// the engine listens on a named pipe with a random name and checks a random token; both are written to
// <userData>\mcp\endpoint.json for the bridge (engine/mcp/bridge.js) the user's MCP client starts. No network
// listener. The engine owns everything that matters: which tools are visible (writes only when allowed), input and
// result limits, a per-widget write queue, a write rate limit, the change cards with undo, and the log.
//
// No Electron imports here: main.js passes notify/log, and tests drive it with a fake client.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_TOOLS = 20;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESULT_CHARS = 12000;
const MAX_MESSAGE = 1024 * 1024;
const TOOL_TIMEOUT_MS = 10000;
const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 10 * 60 * 1000;
const GROUP_MS = 5000;
const UNDO_MS = 10 * 60 * 1000;
const LOG_KEEP = 500;
const HELLO_TIMEOUT_MS = 5000;

const DEFAULTS = Object.freeze({ enabled: false, allowWrites: false, widgets: {} });

/** The engine setting "mcp": { enabled, allowWrites, widgets: { [id]: { read, write } } } (PC-only, never synced). */
function sanitizeSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const widgets = {};
  for (const [id, w] of Object.entries(v.widgets && typeof v.widgets === 'object' ? v.widgets : {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) continue;
    widgets[id] = { read: w?.read !== false, write: w?.write !== false };
  }
  return { enabled: v.enabled === true, allowWrites: v.allowWrites === true, widgets };
}

function pipePath(name) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

function exportedName(widgetId, name) {
  return `${widgetId.replace(/-/g, '_')}_${name}`;
}

/** "할 일 노트" -> "를", "캘린더" -> "를", "메일" -> "을" (object particle after the last syllable). */
function eulReul(word) {
  const code = String(word).charCodeAt(String(word).length - 1);
  if (code < 0xac00 || code > 0xd7a3) return '을(를)';
  return (code - 0xac00) % 28 === 0 ? '를' : '을';
}

/**
 * The basic JSON-schema subset the engine checks before a widget sees the input (design 4.1): object with
 * properties, required, additionalProperties: false; per property type (string, integer, number, boolean,
 * array of strings), enum, maxLength/minLength, minimum/maximum, maxItems. Returns a message or null.
 */
function checkInput(schema, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '입력은 객체여야 합니다.';
  const props = schema.properties || {};
  for (const key of schema.required || []) if (value[key] === undefined) return `"${key}" 값이 필요합니다.`;
  for (const [key, v] of Object.entries(value)) {
    const p = props[key];
    if (!p) {
      if (schema.additionalProperties === false) return `알 수 없는 입력 "${key}"입니다.`;
      continue;
    }
    if (v === null || v === undefined) continue;
    const type = p.type;
    if (type === 'string') {
      if (typeof v !== 'string') return `"${key}"는 문자열이어야 합니다.`;
      if (p.maxLength !== undefined && [...v].length > p.maxLength) return `"${key}"가 너무 깁니다(${p.maxLength}자까지).`;
      if (p.minLength !== undefined && [...v].length < p.minLength) return `"${key}"가 너무 짧습니다.`;
    } else if (type === 'integer' || type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (type === 'integer' && !Number.isInteger(v))) return `"${key}"는 ${type === 'integer' ? '정수' : '숫자'}여야 합니다.`;
      if (p.minimum !== undefined && v < p.minimum) return `"${key}"는 ${p.minimum} 이상이어야 합니다.`;
      if (p.maximum !== undefined && v > p.maximum) return `"${key}"는 ${p.maximum} 이하여야 합니다.`;
    } else if (type === 'boolean') {
      if (typeof v !== 'boolean') return `"${key}"는 true/false여야 합니다.`;
    } else if (type === 'array') {
      if (!Array.isArray(v)) return `"${key}"는 배열이어야 합니다.`;
      if (p.maxItems !== undefined && v.length > p.maxItems) return `"${key}"는 ${p.maxItems}개까지입니다.`;
    }
    if (Array.isArray(p.enum) && !p.enum.includes(v)) return `"${key}"는 ${p.enum.join(', ')} 중 하나여야 합니다.`;
  }
  return null;
}

/** A widget's tool declarations, cleaned (design 4.1). Bad entries are dropped, not thrown. */
function cleanTools(tools, log = () => {}) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (out.length >= MAX_TOOLS) break;
    if (!t || typeof t !== 'object' || typeof t.run !== 'function') continue;
    const name = String(t.name || '');
    if (!TOOL_NAME_RE.test(name) || seen.has(name)) {
      log(`mcp tool "${name}" skipped (invalid or duplicate name)`);
      continue;
    }
    const schema = t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object'
      ? JSON.parse(JSON.stringify(t.inputSchema))
      : { type: 'object', properties: {}, additionalProperties: false };
    seen.add(name);
    out.push({
      name,
      title: String(t.title || name).slice(0, 60),
      description: String(t.description || '').slice(0, 2000),
      inputSchema: schema,
      write: t.write === true,
      idempotent: t.idempotent === true,
      // #131: the user's AI app must ask its user on every call (Claude Code: even in auto mode or with allow rules).
      requiresUserInteraction: t.requiresUserInteraction === true,
      run: t.run,
    });
  }
  return out;
}

class McpHost {
  /**
   * @param {{
   *   dir: string,                                   // <userData>\mcp
   *   getSettings: () => object,                      // the engine setting "mcp"
   *   notify?: (cards: object[], opts: object) => void, // engine generic cards (widget: Desk Widgets)
   *   log?: (msg: string) => void,
   *   now?: () => number,
   *   onChange?: () => void,                         // connections or tools changed (manager window)
   * }} opts
   */
  constructor({ dir, getSettings, notify = () => {}, log = (m) => console.error(m), now = () => Date.now(), onChange = () => {} }) {
    this.dir = dir;
    this.getSettings = () => sanitizeSettings(getSettings());
    this.notify = notify;
    this.log = log;
    this.now = now;
    this.onChange = onChange;
    this.registry = new Map(); // widgetId -> { name, tools, active }
    this.server = null;
    this.endpoint = null; // { pipe, token }
    this.connections = new Set();
    this.connectionSeq = 0;
    this.queues = new Map(); // widgetId -> promise chain of writes
    this.groups = new Map(); // connection id -> current card group
    this.groupSeq = 0;
    this.lastConnection = null; // { client, at }
    this.stopped = false;
    this.starting = null;
  }

  get file() {
    return { endpoint: path.join(this.dir, 'endpoint.json'), tools: path.join(this.dir, 'tools.json'), log: path.join(this.dir, 'log.jsonl') };
  }

  // ---- lifecycle ----

  /** Listens when the setting is on, closes everything when it is off. Call after the setting changes. */
  async apply() {
    if (this.stopped) return;
    const s = this.getSettings();
    if (s.enabled && !this.server) await this.listen();
    else if (!s.enabled && this.server) await this.close({ removeTools: true });
    else if (!s.enabled) this.removeFile(this.file.tools);
    this.toolsChanged();
  }

  async listen() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const name = `desk-widgets-mcp-${crypto.randomBytes(16).toString('hex')}`;
      const token = crypto.randomBytes(32).toString('hex');
      const pipe = pipePath(name);
      const server = net.createServer((socket) => this.accept(socket));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipe, () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.on('error', (err) => this.log(`mcp pipe: ${err.message}`));
      this.server = server;
      this.endpoint = { pipe, token };
      fs.mkdirSync(this.dir, { recursive: true });
      this.writeFile(this.file.endpoint, { pipe, token, pid: process.pid, at: new Date(this.now()).toISOString() });
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async close({ removeTools = false } = {}) {
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    this.removeFile(this.file.endpoint);
    if (removeTools) this.removeFile(this.file.tools);
    for (const c of [...this.connections]) c.socket.destroy();
    this.connections.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    this.onChange();
  }

  /** On quit: the endpoint goes away but tools.json stays, so the bridge can list tools while the engine is off. */
  async stop() {
    this.stopped = true;
    await this.close();
  }

  // ---- registry (ctx.mcp.registerTools) ----

  /** Replaces a widget's tools. `active()` tells whether that widget instance still runs. Returns the count kept. */
  register(widgetId, { name, active = () => true }, tools) {
    const clean = cleanTools(tools, this.log);
    if (clean.length) this.registry.set(widgetId, { name: String(name || widgetId), tools: clean, active });
    else this.registry.delete(widgetId);
    this.toolsChanged();
    return clean.length;
  }

  unregister(widgetId) {
    if (!this.registry.delete(widgetId)) return;
    this.toolsChanged();
  }

  /** The tools the user's settings let MCP clients see: { exported, widgetId, widgetName, tool }. */
  visible() {
    const s = this.getSettings();
    if (!s.enabled) return [];
    const out = [];
    for (const [widgetId, entry] of this.registry) {
      const allowed = s.widgets[widgetId] || { read: true, write: true };
      if (!allowed.read) continue;
      for (const tool of entry.tools) {
        if (tool.write && !(s.allowWrites && allowed.write)) continue;
        out.push({ exported: exportedName(widgetId, tool.name), widgetId, widgetName: entry.name, tool });
      }
    }
    return out;
  }

  listTools() {
    return this.visible().map(({ exported, tool }) => ({
      name: exported,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: !tool.write,
        destructiveHint: false,
        idempotentHint: tool.write ? tool.idempotent : true,
        openWorldHint: false,
      },
      // Claude Code docs (mcp.md, "Require approval for a specific tool"): _meta["anthropic/requiresUserInteraction"]
      // must be the JSON true; the tool's permission prompt then shows on every call, auto mode included.
      ...(tool.requiresUserInteraction ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {}),
    }));
  }

  toolsChanged() {
    if (this.stopped) return;
    if (this.getSettings().enabled) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        this.writeFile(this.file.tools, { tools: this.listTools(), at: new Date(this.now()).toISOString() });
      } catch (err) {
        this.log(`mcp tools.json: ${err.message}`);
      }
    }
    for (const c of this.connections) if (c.ready) c.send({ event: 'tools-changed' });
    this.onChange();
  }

  // ---- connections ----

  accept(socket) {
    const c = { id: ++this.connectionSeq, socket, ready: false, client: 'unknown', since: this.now(), writes: [] };
    c.send = (message) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    socket.setEncoding('utf8');
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_MESSAGE && buffer.indexOf('\n') < 0) {
        socket.destroy();
        return;
      }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (!c.ready) {
          clearTimeout(helloTimer);
          if (!this.checkHello(m)) {
            c.send({ type: 'hello', ok: false });
            socket.destroy();
            return;
          }
          c.ready = true;
          c.client = cleanClient(m.client);
          this.connections.add(c);
          this.lastConnection = { client: c.client, at: this.now() };
          c.send({ type: 'hello', ok: true });
          this.onChange();
          continue;
        }
        this.onRequest(c, m);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (this.connections.delete(c)) this.onChange();
      this.groups.delete(c.id);
    });
  }

  checkHello(m) {
    if (!m || m.type !== 'hello' || typeof m.token !== 'string' || !this.endpoint) return false;
    const want = Buffer.from(this.endpoint.token);
    const got = Buffer.from(m.token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  async onRequest(c, m) {
    if (m?.method === 'client') {
      c.client = cleanClient(m.params?.client);
      this.lastConnection = { client: c.client, at: this.now() };
      this.onChange();
      return;
    }
    if (m?.id === undefined) return;
    try {
      let result;
      if (m.method === 'tools/list') result = { tools: this.listTools() };
      else if (m.method === 'tools/call') result = await this.callTool(c, String(m.params?.name || ''), m.params?.arguments);
      else throw new Error(`unknown method ${m.method}`);
      c.send({ id: m.id, result });
    } catch (err) {
      c.send({ id: m.id, error: { message: err.message } });
    }
  }

  // ---- tool calls ----

  async callTool(c, name, args) {
    const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
    const found = this.visible().find((v) => v.exported === name);
    if (!found) {
      const hidden = [...this.registry].some(([id, e]) => e.tools.some((t) => exportedName(id, t.name) === name && t.write));
      return fail(hidden ? '쓰기가 허용되지 않았습니다. Desk Widgets 위젯 관리 창의 "AI 도우미 연결 (MCP)"에서 쓰기 허용을 켜야 합니다.' : `알 수 없는 도구이거나 위젯이 꺼져 있습니다: ${name}`);
    }
    const { widgetId, widgetName, tool } = found;
    const entry = this.registry.get(widgetId);
    if (!entry?.active()) return fail(`${widgetName} 위젯이 꺼져 있습니다.`);
    const input = args ?? {};
    let size;
    try {
      size = Buffer.byteLength(JSON.stringify(input), 'utf8');
    } catch {
      return fail('입력을 읽을 수 없습니다.');
    }
    if (size > MAX_INPUT_BYTES) return fail('입력이 너무 큽니다(64KB까지).');
    const problem = checkInput(tool.inputSchema, input);
    if (problem) return fail(problem);
    const info = Object.freeze({ client: c.client, connection: c.id });

    if (!tool.write) {
      const r = await this.runTool(tool, input, info);
      this.record({ client: c.client, tool: name, ok: !r.error, message: r.error || undefined });
      return r.error ? fail(r.error) : this.toResult(r.value?.data);
    }

    const now = this.now();
    c.writes = c.writes.filter((t) => now - t < WRITE_WINDOW_MS);
    if (c.writes.length >= WRITE_LIMIT) return fail('짧은 시간에 너무 많이 바꾸려고 했습니다. 잠시 뒤 다시 시도해 주세요(10분에 30번까지).');
    c.writes.push(now);
    const r = await this.enqueue(widgetId, () => this.runTool(tool, input, info));
    if (r.error) {
      this.record({ client: c.client, tool: name, ok: false, message: r.error });
      return fail(r.error);
    }
    const value = r.value || {};
    const result = this.toResult(value.data);
    // Nothing changed (e.g. an item already checked): no card, and it does not count as a write.
    if (value.unchanged === true) {
      c.writes.pop();
      this.record({ client: c.client, tool: name, ok: true, summary: '변경 없음' });
      return result;
    }
    const summary = String(value.summary || tool.title).slice(0, 200);
    this.record({ client: c.client, tool: name, ok: true, summary, write: true });
    this.announce(c, { widgetId, widgetName, summary, undo: typeof value.undo === 'function' ? value.undo : null, open: typeof value.open === 'function' ? value.open : null });
    return result;
  }

  async runTool(tool, input, info) {
    let timer = null;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => tool.run(JSON.parse(JSON.stringify(input)), info)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('시간 초과'), { timeout: true })), TOOL_TIMEOUT_MS); }),
      ]);
      return { value };
    } catch (err) {
      if (!err?.timeout) this.log(`mcp tool ${tool.name}: ${err?.stack || err}`);
      return { error: err?.timeout ? '위젯이 제때 응답하지 않았습니다(시간 초과).' : String(err?.message || err).slice(0, 500) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The MCP result of a tool's data: JSON text, at most MAX_RESULT_CHARS (the widget must page, design 5.5). */
  toResult(data) {
    const text = JSON.stringify(data === undefined ? null : data);
    if (text.length > MAX_RESULT_CHARS) return { content: [{ type: 'text', text: `결과가 너무 큽니다(${MAX_RESULT_CHARS}자 초과). 더 적게 요청해 주세요.` }], isError: true };
    return { content: [{ type: 'text', text }] };
  }

  /** Writes of one widget run one after another (design 3.5). */
  enqueue(widgetId, fn) {
    const prev = this.queues.get(widgetId) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.queues.set(widgetId, tail);
    tail.then(() => {
      if (this.queues.get(widgetId) === tail) this.queues.delete(widgetId);
    });
    return next;
  }

  // ---- cards and log (design 6.2) ----

  announce(c, item) {
    const now = this.now();
    let group = this.groups.get(c.id);
    if (!group || group.widgetId !== item.widgetId || now - group.lastAt > GROUP_MS) {
      group = { id: ++this.groupSeq, widgetId: item.widgetId, widgetName: item.widgetName, client: c.client, items: [], lastAt: now, undone: false };
      this.groups.set(c.id, group);
    }
    group.items.push(item);
    group.lastAt = now;
    this.pushCard(group);
  }

  pushCard(group) {
    const who = /claude/i.test(group.client) ? 'Claude' : 'AI 도우미';
    const n = group.items.length;
    const title = n === 1 ? `${who}가 ${group.widgetName}${eulReul(group.widgetName)} 바꿨습니다` : `${who}가 ${group.widgetName}에서 ${n}개를 바꿨습니다`;
    const body = group.items.map((i) => i.summary).join(' · ').slice(0, 300);
    const actions = [];
    if (group.items.some((i) => i.undo)) actions.push({ id: 'undo', label: '되돌리기' });
    if (n === 1 && group.items[0].open) actions.push({ id: 'open', label: '열기' });
    try {
      this.notify([{ type: 'card', title, body, icon: 'info', tag: `mcp-${group.id}`, actions }], {
        onAction: (_event, action) => this.onCardAction(group, action),
      });
    } catch (err) {
      this.log(`mcp card: ${err.message}`);
    }
  }

  async onCardAction(group, action) {
    if (action === 'open') {
      await group.items[0]?.open?.();
      return undefined;
    }
    if (action !== 'undo') return undefined;
    if (group.undone) return undefined;
    if (this.now() - group.lastAt > UNDO_MS) throw new Error('되돌릴 수 있는 시간(10분)이 지났습니다.');
    group.undone = true;
    const failed = [];
    for (const item of [...group.items].reverse()) {
      if (!item.undo) continue;
      try {
        await this.enqueue(group.widgetId, () => item.undo());
        this.record({ client: 'user', tool: 'undo', ok: true, summary: `되돌림: ${item.summary}`, write: true });
      } catch (err) {
        failed.push(err.message);
        this.record({ client: 'user', tool: 'undo', ok: false, message: err.message });
      }
    }
    if (failed.length) throw new Error(`일부를 되돌리지 못했습니다: ${failed[0]}`);
    return undefined;
  }

  record(entry) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const line = `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })}\n`;
      fs.appendFileSync(this.file.log, line, 'utf8');
      const text = fs.readFileSync(this.file.log, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.length > LOG_KEEP + 100) fs.writeFileSync(this.file.log, `${lines.slice(-LOG_KEEP).join('\n')}\n`, 'utf8');
    } catch (err) {
      this.log(`mcp log: ${err.message}`);
    }
  }

  recentLog(limit = 50) {
    try {
      return fs.readFileSync(this.file.log, 'utf8').split('\n').filter(Boolean).slice(-limit).reverse()
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  }

  clearLog() {
    this.removeFile(this.file.log);
  }

  /** What the widget manager shows. */
  status() {
    const s = this.getSettings();
    return {
      settings: s,
      listening: Boolean(this.server),
      connections: [...this.connections].map((c) => ({ id: c.id, client: c.client, since: c.since })),
      lastConnection: this.lastConnection,
      widgets: [...this.registry].map(([id, e]) => ({
        id, name: e.name,
        tools: e.tools.map((t) => ({ name: exportedName(id, t.name), title: t.title, write: t.write })),
      })),
      log: this.recentLog(30),
    };
  }

  // ---- files ----

  writeFile(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  removeFile(file) {
    try {
      fs.unlinkSync(file);
    } catch { /* already gone */ }
  }
}

function cleanClient(name) {
  return String(name || 'unknown').replace(/[^\w .@/-]/g, '').slice(0, 60) || 'unknown';
}

/** What the manager window shows to copy (design 7.1). `dir` only when it is not the bridge's default. */
function installCommands({ exe, bridge, dir = null }) {
  const extra = dir ? [`--dir=${dir}`] : [];
  const quote = (s) => `"${s}"`;
  const code = ['claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 --transport stdio desk-widgets --', quote(exe), quote(bridge), ...extra.map(quote)].join(' ');
  const desktop = JSON.stringify({ 'desk-widgets': { command: exe, args: [bridge, ...extra], env: { ELECTRON_RUN_AS_NODE: '1' } } }, null, 2);
  // The object goes inside "mcpServers": show it without the outer braces.
  return { code, desktop: desktop.slice(1, -1).replace(/^\n/, '').replace(/\n$/, '').split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n') };
}

module.exports = { McpHost, sanitizeSettings, checkInput, cleanTools, exportedName, installCommands, pipePath, DEFAULTS, LIMITS: { MAX_TOOLS, MAX_INPUT_BYTES, MAX_RESULT_CHARS, TOOL_TIMEOUT_MS, WRITE_LIMIT, WRITE_WINDOW_MS, GROUP_MS, UNDO_MS, LOG_KEEP } };
