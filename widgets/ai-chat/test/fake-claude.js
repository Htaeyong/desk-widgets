// A fake `claude` for the AI chat widget's tests. behavior.json beside it says how to act; every run is appended to
// calls.jsonl there (arguments, environment, folder, prompt, and whether the helper gave the key). It runs apiKeyHelper
// through a shell as Claude Code does. It never contacts a server.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const here = process.env.AI_CHAT_FAKE_DIR || __dirname;
const args = process.argv.slice(2);
const behaviorFile = fs.readdirSync(__dirname).includes('behavior.json') ? path.join(__dirname, 'behavior.json') : path.join(here, 'behavior.json');
const behavior = JSON.parse(fs.readFileSync(behaviorFile, 'utf8'));
const dir = path.dirname(behaviorFile);

if (args[0] === '--version') {
  fs.appendFileSync(path.join(dir, 'versions.log'), 'called\n');
  if (behavior.versionFails) process.exit(1);
  console.log(`${behavior.version || '2.1.309'} (Claude Code)`);
  process.exit(0);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const settings = opt('--settings') ? JSON.parse(opt('--settings')) : {};
const askHelper = () => {
  try {
    return cp.execSync(settings.apiKeyHelper, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

/** Starts one server from --mcp-config and returns a call(method, params) over its stdio. */
function mcpServer(name) {
  const config = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8'));
  const server = config.mcpServers[name];
  const child = cp.spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const waiting = new Map();
  let buffer = '';
  let seq = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiting.get(m.id)?.(m.result);
    }
  });
  return {
    child,
    call: (method, params) => new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    }),
    close: () => child.kill(),
  };
}

/** What Claude Code does: asks `approve` before a tool that needs it, and only runs it (here, writes the file) on allow. */
async function mcpFlow(flow) {
  const results = path.join(dir, 'mcp-results.jsonl');
  const servers = new Map();
  for (const step of flow) {
    const name = step.server || 'ai-chat-host';
    if (!servers.has(name)) {
      const s = mcpServer(name);
      await s.call('initialize', { protocolVersion: '2025-11-25' });
      servers.set(name, s);
    }
    const server = servers.get(name);
    if (step.list) {
      fs.appendFileSync(results, `${JSON.stringify({ step: 'list', tools: (await server.call('tools/list', {})).tools.map((t) => t.name) })}\n`);
      continue;
    }
    const out = await server.call('tools/call', { name: step.tool, arguments: step.args });
    const text = out?.content?.[0]?.text ?? '';
    if (step.tool === 'approve') {
      const answer = JSON.parse(text);
      if (answer.behavior === 'allow' && answer.updatedInput?.file_path) fs.writeFileSync(answer.updatedInput.file_path, answer.updatedInput.content ?? '');
      fs.appendFileSync(results, `${JSON.stringify({ step: 'approve', answer })}\n`);
    } else fs.appendFileSync(results, `${JSON.stringify({ step: step.tool, text, isError: Boolean(out?.isError) })}\n`);
  }
  for (const s of servers.values()) s.close();
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  const resuming = args.includes('--resume');
  const sid = opt('--resume') || 'fake-session-1';
  const key = behavior.helperTakenFirst && !resuming ? (askHelper(), askHelper()) : askHelper();
  const second = behavior.askHelperTwice ? askHelper() : null;
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({
    args, prompt, cwd: process.cwd(), env: process.env, keyFromHelper: Boolean(key), keyLength: key.length, secondRefused: second === '',
  })}\n`);

  if (behavior.strictResume) {
    const record = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'x', `${sid}.jsonl`);
    if (resuming && !fs.existsSync(record)) {
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, result: `No conversation found with session ID: ${sid}`, total_cost_usd: 0 });
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.appendFileSync(record, 'record\n');
  }
  for (const raw of behavior.rawLines || []) process.stdout.write(`${raw}\n`);
  if (behavior.hangBeforeInit) {
    setTimeout(() => {}, 120000); // stopped before Claude Code said which session it is
    return;
  }
  emit({
    type: 'system', subtype: 'init', session_id: sid, model: opt('--model'), apiKeySource: behavior.apiKeySource || (key ? 'apiKeyHelper' : 'none'),
    permissionMode: behavior.forceMode || opt('--permission-mode'),
    tools: behavior.tools || opt('--tools').split(',').filter((t) => !(behavior.dropTools || []).includes(t)),
    mcp_servers: opt('--mcp-config') ? Object.keys(JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers).map((name) => ({ name, status: (behavior.mcpFailed || []).includes(name) ? 'failed' : 'connected' })) : [],
  });
  if (behavior.copyMcpConfig) fs.copyFileSync(opt('--mcp-config'), behavior.copyMcpConfig);
  if (behavior.copySystemNote && opt('--append-system-prompt-file')) fs.copyFileSync(opt('--append-system-prompt-file'), behavior.copySystemNote);
  if (behavior.summaryText && prompt.includes('TITLE:')) {
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: behavior.summaryText, total_cost_usd: behavior.cost ?? 0.002 });
    process.exit(0);
  }
  if (behavior.earlyText) emit({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: behavior.earlyText }] } });
  if (behavior.mcpFlow) await mcpFlow(behavior.mcpFlow);
  if (behavior.apiRetries) for (const r of behavior.apiRetries) emit({ type: 'system', subtype: 'api_retry', session_id: sid, attempt: r.attempt ?? 1, max_retries: 10, retry_delay_ms: 500, error_status: r.status ?? 500, error: r.error });
  if (behavior.rateLimit) emit({ type: 'rate_limit_event', session_id: sid, rate_limit_info: behavior.rateLimit });
  if (behavior.usageThenHang) {
    for (const message of behavior.usageThenHang) emit({ type: 'assistant', session_id: sid, message });
    setTimeout(() => {}, 120000);
    return;
  }
  if (behavior.resultSubtype) {
    emit({ type: 'result', subtype: behavior.resultSubtype, is_error: true, session_id: sid, result: '', total_cost_usd: behavior.cost ?? 3.01 });
    process.exit(1);
  }
  if (behavior.spawnProbe) {
    const probe = cp.spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'probe.pid'))}, String(process.pid)); setTimeout(() => {}, 120000);`], { stdio: 'ignore', windowsHide: true });
    probe.unref();
    setTimeout(() => {}, 120000);
    return;
  }
  if (behavior.hangAfterInit) {
    setTimeout(() => {}, 120000);
    return;
  }
  if (behavior.noResult) process.exit(behavior.exitCode ?? 1);
  if (behavior.failFirstWithHelperError && !resuming) {
    askHelper(); // the once-only server says no, as after the helper's TTL
    process.stderr.write('apiKeyHelper failed: exited 1\n');
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, result: 'apiKeyHelper failed', total_cost_usd: 0.0001 });
    process.exit(1);
  }
  if (behavior.helperRefusedButSucceeds) {
    askHelper();
    process.stderr.write('apiKeyHelper failed: exited 1\n');
  }
  if (behavior.resultError) {
    emit({ type: 'result', subtype: 'success', is_error: true, session_id: sid, result: behavior.resultError, total_cost_usd: 0 });
    process.exit(1);
  }
  if (!key) {
    emit({ type: 'result', subtype: 'success', is_error: true, session_id: sid, result: 'Not logged in', total_cost_usd: 0 });
    process.exit(1);
  }
  const toolBurst = (names) => {
    for (const [i, name] of names.entries()) emit({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: `b${i}`, name, input: { n: i } }] } });
  };
  if (behavior.toolBurst) toolBurst(behavior.toolBurst);
  if (behavior.pauseFile) {
    const started = Date.now();
    while (!fs.existsSync(path.join(dir, behavior.pauseFile)) && Date.now() - started < 20000) cp.spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)'], { windowsHide: true });
  }
  if (behavior.toolBurstAfter) toolBurst(behavior.toolBurstAfter);
  if (behavior.textBetween) emit({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: behavior.textBetween }] } });
  if (behavior.toolBurstLast) toolBurst(behavior.toolBurstLast);
  for (const delta of behavior.deltas || []) emit({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta === '$KEYHEAD' ? key.slice(0, 10) : (delta === '$KEYTAIL' ? key.slice(10) : delta) } } });
  if (behavior.tool) emit({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 't0', name: behavior.tool.name, input: behavior.tool.input }] } });
  if (behavior.tellText) emit({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: behavior.tellText }] } });
  if (behavior.waitForFile) {
    // waitMs: how long before going on anyway; a test that counts runs gives a long one, so load cannot end a run early.
    const started = Date.now();
    const limit = behavior.waitMs ?? 20000;
    while (!fs.existsSync(path.join(dir, behavior.waitForFile)) && Date.now() - started < limit) cp.spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)'], { windowsHide: true });
  }
  if (behavior.leak) {
    process.stderr.write(`leaking ${key}\n`);
    emit({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: `the key is ${key}` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${key}` } }] } });
  }
  emit({ type: 'future_event', session_id: sid, anything: { nested: true } });
  emit({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.txt' } }, { type: 'text', text: 'working' }], usage: { input_tokens: 3, output_tokens: 2 } } });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: behavior.leak ? `done ${key}` : `result for: ${prompt}`, num_turns: 1, total_cost_usd: behavior.cost ?? 0.0012, usage: { input_tokens: 3, output_tokens: 2 }, permission_denials: [] });
  process.exit(0);
});
