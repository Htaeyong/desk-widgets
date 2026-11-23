// The Claude Code runner of the AI chat widget (#129, design 15): everything specific to Claude Code is in this file, so
// another runner can sit behind the same shape later.
//   runner.check() -> { installed, version, verified, problems[], notes[] }
//   runner.start({ prompt, cwd, model, mode, resumeId, budgetUsd, getKey, configDir, writeGuard, mcp, systemNote }) -> handle
//   handle.events: EventEmitter, 'event' with { type: spawned | init | textDelta | text | toolCall | usage | result | apiRetry | rateLimit | notice | keyRetry | done }
//   runner.inspect({ pid, marker }) -> whether that process is still a run this widget started
//   handle.done: Promise of the final 'done' event (costUsd is what Claude Code reported, null when it ended without saying); handle.stop(); handle.respond(id, answer) (cards come in a later step)
//
// How it runs (design 16.1.2, tested by the user in spike S9): non-bare `claude -p`, isolated by its own CLAUDE_CONFIG_DIR
// and --setting-sources user --strict-mcp-config --disable-slash-commands, with a fixed --tools list. No shell; the prompt
// goes over stdin. The child's environment is built from an allow list, so nothing can redirect the key or pick another
// credential. The key reaches Claude Code only through apiKeyHelper, from a pipe that answers once per run: it is never in
// arguments, the environment, a file or a log.
const childProcess = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { classifyApiError } = require('./key');

const MIN_VERSION = '2.1.309'; // the version the structure was tested on (S9)
const VERIFIED_VERSION = '2.1.309';
const DEFAULT_BUDGET_USD = 3; // per task (design 19 C5)
const HELPER_TTL_MS = '86400000'; // longer than a run: the once-only helper is asked one time (design 16.1.2, plan A)
const VERSION_TIMEOUT_MS = 15000;
const STDERR_KEEP = 64 * 1024;
const MAX_LINE = 32 * 1024 * 1024;
const REDACTED = '[키 가림]';
const RESUME_PROMPT = 'Continue the previous task from where it stopped. Do not repeat work that is already done.';

// `bypassPermissions` is left out on purpose (design 8.2) and so is `dontAsk`, which refuses instead of asking.
const MODES = ['auto', 'default', 'acceptEdits', 'plan'];
const FORBIDDEN_ARG = /bypass|dangerously/i;
const HOST_SERVER = 'ai-chat-host';

const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch', 'Task'];
const REQUIRED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const SHELL_TOOLS = ['Bash', 'PowerShell']; // one is enough
const OPTIONAL_TOOLS = ['PowerShell', 'Task']; // missing: a notice only

// What Claude Code gets from this process's environment, matched without case as Windows does. Nothing that can redirect
// the key (ANTHROPIC_BASE_URL, proxies) or select another credential (ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_USE_*,
// CLAUDE_CODE_OAUTH_TOKEN), and not ELECTRON_RUN_AS_NODE or NODE_OPTIONS.
const ENV_ALLOW = ['Path', 'PATHEXT', 'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'CLAUDE_CODE_GIT_BASH_PATH'];

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// ---- environment and arguments ----

/**
 * The child's whole environment. `helper`: { binDir, exe, script } of the key helper. Its folder goes first on PATH so the
 * helper's command has no quotes or spaces and reads the same in cmd, PowerShell and Git Bash (node may not be installed,
 * and the engine's own path has a space).
 */
function buildEnv({ env = process.env, configDir, helper }) {
  const byUpper = new Map(Object.keys(env).map((name) => [name.toUpperCase(), name]));
  const out = {};
  for (const name of ENV_ALLOW) {
    const found = byUpper.get(name.toUpperCase());
    if (found !== undefined && env[found] !== undefined) out[name] = env[found];
  }
  out.CLAUDE_CONFIG_DIR = configDir;
  out.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = HELPER_TTL_MS;
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'; // the widget keeps memory itself (save_memory); Claude Code's own would not carry over
  out.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'; // S9: without it the PowerShell tool is missing on a PC with Git Bash
  if (helper) {
    out.Path = out.Path ? `${helper.binDir};${out.Path}` : helper.binDir;
    out.AI_CHAT_ENGINE_EXE = helper.exe;
    out.AI_CHAT_KEY_SCRIPT = helper.script;
  }
  return out;
}

/** Throws on a mode the public build must not run. Checked before anything starts. */
function assertMode(mode) {
  if (!MODES.includes(mode)) throw Object.assign(new Error(`허용하지 않는 승인 모드입니다: ${String(mode)}`), { code: 'mode-refused' });
}

/** A Windows path as a permission rule's absolute path: C:\Users\a -> //c/Users/a (permissions docs: POSIX form). */
function rulePath(dir) {
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(String(dir));
  if (!m) return null;
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `//${m[1].toLowerCase()}/${rest}`;
}

/**
 * Design 8.3: what the file tools must not touch, and no writes outside the work folder. It does not limit shell commands
 * (permissions docs), so it is a seat belt, not a boundary. blockWritesOutsideWorkingDirectories needs v2.1.314; older
 * versions ignore it and the deny rules still apply.
 */
function guardSettings(env) {
  const read = (wanted) => env[Object.keys(env).find((name) => name.toUpperCase() === wanted)];
  const appData = read('APPDATA');
  const local = read('LOCALAPPDATA');
  const home = read('USERPROFILE');
  const dirs = [
    appData && `${appData}\\chilgong88`,
    home && `${home}\\.ssh`,
    home && `${home}\\.aws`,
    home && `${home}\\.claude`,
    local && `${local}\\Google\\Chrome\\User Data`,
    local && `${local}\\Microsoft\\Edge\\User Data`,
    local && `${local}\\BraveSoftware\\Brave-Browser\\User Data`,
    appData && `${appData}\\Mozilla\\Firefox\\Profiles`,
  ].filter(Boolean).map(rulePath).filter(Boolean);
  const deny = dirs.flatMap((dir) => [`Read(${dir}/**)`, `Edit(${dir}/**)`]);
  return { permissions: { deny, blockWritesOutsideWorkingDirectories: true } };
}

/** Claude Code's arguments for one run. The prompt is never here. */
// Dooray originals: the Dooray widget asks before each download on a Desk Widgets card (decision C), so a card here would ask
// twice. The status tool only reports on a fetch already asked about.
const FETCH_TOOLS = ['mcp__desk-widgets__dooray_fetch_file', 'mcp__desk-widgets__dooray_fetch_file_status'];

function buildArgs({ model, mode = 'auto', resumeId, budgetUsd = DEFAULT_BUDGET_USD, keyServer, guard = null, mcpConfigFile = null, systemNoteFile = null }) {
  assertMode(mode);
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(String(model))) throw Object.assign(new Error('모델 이름이 올바르지 않습니다.'), { code: 'bad-model' });
  if (resumeId !== undefined && resumeId !== null && !/^[A-Za-z0-9-]{1,64}$/.test(String(resumeId))) throw Object.assign(new Error('세션 ID가 올바르지 않습니다.'), { code: 'bad-session' });
  const budget = Number(budgetUsd);
  if (!(budget > 0)) throw Object.assign(new Error('작업 상한이 올바르지 않습니다.'), { code: 'bad-budget' });
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', String(model),
    '--max-budget-usd', String(budget),
    '--permission-mode', mode,
    '--setting-sources', 'user',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools', TOOLS.join(','),
    '--settings', JSON.stringify({ apiKeyHelper: `ai-chat-key.cmd ${keyServer.id} ${keyServer.nonce}`, ...(guard || {}) }),
  ];
  // The widget's own tools. --strict-mcp-config (above) keeps every other MCP server out, as S9 ran it. AskUserQuestion is not
  // offered: an answer through it was never seen to arrive (design 9).
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile, '--permission-prompt-tool', `mcp__${HOST_SERVER}__approve`, '--allowedTools', [...['ask_user', 'list_recipes', 'read_recipe', 'save_memory', 'list_memory'].map((tool) => `mcp__${HOST_SERVER}__${tool}`), ...FETCH_TOOLS].join(','));
  if (systemNoteFile) args.push('--append-system-prompt-file', systemNoteFile);
  if (resumeId) args.push('--resume', String(resumeId));
  if (args.some((arg) => FORBIDDEN_ARG.test(arg))) throw Object.assign(new Error('허용하지 않는 옵션입니다.'), { code: 'mode-refused' });
  return args;
}

// ---- finding claude without a shell ----

/**
 * { file, args } of the installed claude.exe, { shimOnly: true } when only an npm command shim was found (it cannot run
 * without a shell), or null. Relative PATH entries are skipped so a work folder cannot plant one.
 */
function resolveClaude({ env = process.env, exists = fs.existsSync } = {}) {
  const read = (wanted) => env[Object.keys(env).find((name) => name.toUpperCase() === wanted)];
  const dirs = String(read('PATH') || '').split(';').map((dir) => dir.trim().replace(/^"|"$/g, '')).filter((dir) => dir && path.isAbsolute(dir));
  const home = read('USERPROFILE');
  if (home) dirs.push(path.join(home, '.local', 'bin')); // the native installer; PATH may predate the install
  for (const dir of dirs) {
    const file = path.join(dir, 'claude.exe');
    if (exists(file)) return { file, args: [] };
  }
  for (const dir of dirs) {
    if (!exists(path.join(dir, 'claude.cmd'))) continue;
    const file = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    return exists(file) ? { file, args: [] } : { shimOnly: true };
  }
  return null;
}

// ---- the key server ----

/** Serves the key from memory over a local pipe to the first request with the one-run value; everything after is refused. */
function startKeyServer(getValue) {
  const id = crypto.randomBytes(12).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const expected = Buffer.from(nonce);
  const stats = { served: 0, refused: 0 };
  const server = net.createServer((socket) => {
    let line = '';
    let answered = false;
    const refuse = () => {
      answered = true;
      stats.refused++;
      socket.end();
    };
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (answered) return;
      line += chunk;
      if (line.length > 256) {
        refuse();
        return;
      }
      if (!line.includes('\n')) return;
      const given = Buffer.from(line.trim());
      if (stats.served === 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
        answered = true;
        stats.served++;
        socket.end(getValue());
      } else refuse();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\\\\.\\pipe\\ai-chat-key-${id}`, () => resolve({ id, nonce, stats, close: () => new Promise((done) => server.close(() => done())) }));
  });
}

// ---- the stream parser ----

/** What one stream-json object means for the widget: a list of events. Unknown types and shapes give nothing. */
function eventsOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : null;
  if (raw.type === 'system' && raw.subtype === 'init') {
    return [{
      type: 'init', sessionId, model: raw.model ?? null, permissionMode: raw.permissionMode ?? null, apiKeySource: raw.apiKeySource ?? null,
      tools: Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === 'string') : null,
      mcpServers: Array.isArray(raw.mcp_servers) ? raw.mcp_servers.filter((s) => s && typeof s.name === 'string').map((s) => ({ name: s.name, status: typeof s.status === 'string' ? s.status : '' })) : null,
    }];
  }
  if (raw.type === 'system' && raw.subtype === 'api_retry') {
    return [{ type: 'apiRetry', sessionId, attempt: raw.attempt ?? null, maxRetries: raw.max_retries ?? null, delayMs: raw.retry_delay_ms ?? null, error: typeof raw.error === 'string' ? raw.error : null, status: raw.error_status ?? null }];
  }
  // Not seen with an API key in the spike; used if it comes, needed by nothing.
  if (raw.type === 'rate_limit_event') {
    const info = raw.rate_limit_info && typeof raw.rate_limit_info === 'object' ? raw.rate_limit_info : {};
    return [{ type: 'rateLimit', sessionId, status: typeof info.status === 'string' ? info.status : null, resetsAt: info.resetsAt ?? null }];
  }
  if (raw.type === 'stream_event' && raw.event?.type === 'content_block_delta' && raw.event.delta?.type === 'text_delta' && typeof raw.event.delta.text === 'string') {
    return [{ type: 'textDelta', sessionId, text: raw.event.delta.text }];
  }
  if (raw.type === 'assistant' && raw.message && typeof raw.message === 'object') {
    const out = [];
    for (const block of Array.isArray(raw.message.content) ? raw.message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push({ type: 'text', sessionId, text: block.text });
      else if (block?.type === 'tool_use' && typeof block.name === 'string') out.push({ type: 'toolCall', sessionId, id: block.id ?? null, name: block.name, input: block.input ?? null });
    }
    if (raw.message.usage && typeof raw.message.usage === 'object') out.push({ type: 'usage', sessionId, messageId: typeof raw.message.id === 'string' ? raw.message.id : null, usage: raw.message.usage });
    return out;
  }
  // A tool's result, as Claude Code hands it back to the model. Only its id and text: the widget looks at the few it must.
  if (raw.type === 'user' && Array.isArray(raw.message?.content)) {
    const out = [];
    for (const block of raw.message.content) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const text = typeof block.content === 'string' ? block.content : (Array.isArray(block.content) ? block.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('') : '');
      out.push({ type: 'toolResult', sessionId, id: block.tool_use_id, isError: Boolean(block.is_error), text: text.slice(0, 64 * 1024) });
    }
    return out;
  }
  if (raw.type === 'result') {
    return [{
      type: 'result', sessionId, subtype: raw.subtype ?? null, isError: Boolean(raw.is_error), text: typeof raw.result === 'string' ? raw.result : '',
      costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : null, usage: raw.usage ?? null, numTurns: raw.num_turns ?? null,
      denials: Array.isArray(raw.permission_denials) ? raw.permission_denials : [],
    }];
  }
  return sessionId ? [{ type: 'session', sessionId }] : [];
}

/** Line splitter for stream-json: a broken line is skipped and counted, an unknown event ignored. */
function createStreamParser(onEvent) {
  let buffer = '';
  const stats = { lines: 0, broken: 0 };
  const line = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    stats.lines++;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      stats.broken++;
      return;
    }
    for (const event of eventsOf(raw)) onEvent(event);
  };
  return {
    stats,
    push(chunk) {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        line(text);
      }
      if (buffer.length > MAX_LINE) {
        buffer = '';
        stats.broken++;
      }
    },
    end() {
      const rest = buffer;
      buffer = '';
      line(rest);
    },
  };
}

/**
 * Passes streamed text but holds back a tail that could be the start of the key, so a key split across deltas is never
 * shown even for a moment. flush() gives what was held (hidden if it became the whole key).
 */
function createDeltaFilter(key, replacement) {
  let held = '';
  const heldLength = (text) => {
    for (let n = Math.min(key.length - 1, text.length); n > 0; n--) if (key.startsWith(text.slice(-n))) return n;
    return 0;
  };
  return {
    push(chunk) {
      const text = (held + chunk).split(key).join(replacement);
      const n = heldLength(text);
      held = n ? text.slice(-n) : '';
      return n ? text.slice(0, -n) : text;
    },
    flush() {
      const rest = held;
      held = '';
      return rest;
    },
  };
}

/** Why the first event of a run says it must not go on, or null. A newer Claude Code that shrinks its tools stops here (design 16.1.2). */
function initProblem(init, wantedMode) {
  if (init.apiKeySource && init.apiKeySource !== 'apiKeyHelper') return { kind: 'key-source', message: `Claude Code가 위젯의 키가 아닌 다른 자격(${init.apiKeySource})을 쓰려고 해서 멈췄습니다.` };
  if (init.permissionMode && init.permissionMode !== wantedMode) return { kind: 'mode-changed', message: `승인 모드가 요청(${wantedMode})과 다르게(${init.permissionMode}) 시작되어 멈췄습니다. 조직 정책이나 모델 때문일 수 있습니다.` };
  if (!init.tools) return null;
  const missing = REQUIRED_TOOLS.filter((tool) => !init.tools.includes(tool));
  if (!SHELL_TOOLS.some((tool) => init.tools.includes(tool))) missing.push(SHELL_TOOLS.join(' 또는 '));
  if (missing.length) return { kind: 'tools-missing', tools: missing, message: `이 Claude Code에는 필요한 도구가 없어 멈췄습니다: ${missing.join(', ')}. 새 버전에서 동작이 바뀌었을 수 있습니다.` };
  return null;
}

// ---- stopping ----

/** Ends the process and everything it started. Node's child.kill() would leave the children running on Windows (S6). */
function killTree(child, env = process.env) {
  if (!child?.pid) return;
  try {
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'SYSTEMROOT');
    const killer = childProcess.spawn(path.join(env[key] || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.on('error', () => {});
  } catch { /* already gone */ }
}

// ---- the runner ----

/**
 * @param {object} o
 * @param {string} o.configDir  the widget's own Claude Code folder
 * @param {string} o.binDir  folder of ai-chat-key.cmd and ai-chat-key.js
 * @param {string} [o.exe]  runs ai-chat-key.js (the engine in Node mode; Node in tests)
 * @param {object} [o.env]  the parent's environment
 * @param {function} [o.resolve]  finds claude ({ file, args } | { shimOnly } | null)
 */
function createClaudeRunner({ configDir: defaultConfigDir, binDir, exe = process.execPath, env = process.env, resolve = () => resolveClaude({ env }) }) {
  const helper = { binDir, exe, script: path.join(binDir, 'ai-chat-key.js') };
  const childEnv = (configDir = defaultConfigDir) => buildEnv({ env, configDir, helper });

  /** Runs only `claude --version`. The caller checks consent and the key first: with neither, nothing starts at all. */
  function check() {
    const command = resolve();
    if (!command || command.shimOnly) {
      return Promise.resolve({
        installed: false, version: null, verified: false, notes: [],
        problems: [command?.shimOnly
          ? { kind: 'unsupported-install', link: 'install', message: 'npm 명령만 찾았고 실행 파일을 찾지 못했습니다. 공식 설치 방법으로 Claude Code를 설치해 주세요.' }
          : { kind: 'not-installed', link: 'install', message: 'Claude Code가 설치된 PC에서 쓸 수 있습니다. 공식 안내를 따라 설치한 뒤 다시 확인해 주세요.' }],
      });
    }
    return new Promise((done) => {
      childProcess.execFile(command.file, [...command.args, '--version'], { env: childEnv(), cwd: os.tmpdir(), timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: false, encoding: 'utf8' }, (err, stdout) => {
        const version = !err && /(\d+\.\d+\.\d+)/.exec(stdout || '')?.[1];
        if (!version) {
          done({ installed: false, version: null, verified: false, notes: [], problems: [{ kind: 'not-runnable', link: 'install', message: 'Claude Code를 실행하지 못했습니다(claude --version 실패). 설치 상태를 확인해 주세요.' }] });
          return;
        }
        const old = compareVersions(version, MIN_VERSION) < 0;
        const newer = compareVersions(version, VERIFIED_VERSION) > 0;
        done({
          installed: true, version, verified: !newer,
          problems: old ? [{ kind: 'too-old', message: `Claude Code ${version}은 낮습니다. ${MIN_VERSION} 이상이 필요합니다. 터미널에서 claude update를 실행해 주세요.` }] : [],
          notes: newer ? [{ kind: 'unverified-version', message: `Claude Code ${version}: 확인되지 않은 새 버전입니다(시험한 버전 ${VERIFIED_VERSION}).` }] : [],
        });
      });
    });
  }

  /** Throws before anything starts on a refused mode or a missing key. Otherwise returns at once; the run goes on behind it. */
  function start({ prompt, cwd, model, mode = 'auto', resumeId = null, budgetUsd = DEFAULT_BUDGET_USD, getKey, configDir = defaultConfigDir, writeGuard = false, mcp = null, systemNote = null }) {
    assertMode(mode);
    const key = typeof getKey === 'function' ? getKey() : '';
    if (!key) throw Object.assign(new Error('API 키가 없어 실행하지 않았습니다.'), { code: 'no-key' });

    const events = new EventEmitter();
    const redact = (value) => {
      if (typeof value === 'string') return value.split(key).join(REDACTED);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, v]) => [name, redact(v)]));
      return value;
    };
    const emit = (event) => events.emit('event', redact(event));
    const guard = writeGuard ? guardSettings(env) : null;
    let mcpConfigFile = null;
    let systemNoteFile = null;

    let stopped = false;
    let current = null;
    let settle;
    const done = new Promise((r) => { settle = r; });

    /** One Claude Code process with its own key server. */
    async function attempt(attemptPrompt, attemptResume, command) {
      const state = { resumed: Boolean(attemptResume), sessionId: attemptResume, result: null, stderr: '', exitCode: null, spawnError: null, guard: null, keyStats: null };
      const server = await startKeyServer(() => key);
      state.keyStats = server.stats;
      try {
        const args = buildArgs({ model, mode, resumeId: attemptResume, budgetUsd, keyServer: server, guard, mcpConfigFile, systemNoteFile });
        await new Promise((finish) => {
          let finished = false;
          let exitTimer = null;
          const end = () => {
            if (finished) return;
            finished = true;
            clearTimeout(exitTimer);
            finish();
          };
          const child = childProcess.spawn(command.file, [...command.args, ...args], { cwd, env: childEnv(configDir), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
          current = child;
          // Lets a later start tell whether a leftover process with this pid is still ours: the id is on its command line.
          if (child.pid) emit({ type: 'spawned', pid: child.pid, marker: server.id });
          const deltas = createDeltaFilter(key, REDACTED);
          const parser = createStreamParser((event) => {
            if (event.sessionId) state.sessionId = event.sessionId;
            if (event.type === 'session') return;
            if (event.type === 'textDelta') {
              const text = deltas.push(event.text);
              if (text) emit({ ...event, text });
              return;
            }
            if (event.type === 'text') deltas.flush(); // the whole text follows, hidden as a whole
            if (event.type === 'result') state.result = event;
            if (event.type === 'apiRetry') {
              state.retryError = event.error;
              // Waiting cannot fix a missing balance: stop now instead of letting Claude Code keep trying.
              if (event.error === 'billing_error' && !state.guard) {
                state.guard = classifyApiError('billing_error');
                emit(event);
                killTree(child, env);
                return;
              }
            }
            emit(event);
            if (event.type !== 'init' || state.guard) return;
            state.guard = initProblem(event, mode);
            if (state.guard) {
              killTree(child, env);
              return;
            }
            const missing = event.tools ? OPTIONAL_TOOLS.filter((tool) => !event.tools.includes(tool)) : [];
            if (missing.length) emit({ type: 'notice', kind: 'optional-tool-missing', tools: missing, message: `이 실행에는 다음 도구가 없습니다: ${missing.join(', ')}` });
          });
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk) => parser.push(chunk));
          child.stderr.on('data', (chunk) => { state.stderr = (state.stderr + chunk).slice(-STDERR_KEEP); });
          child.stdin.on('error', () => {});
          child.on('error', (err) => {
            state.spawnError = err.code || 'spawn-error';
            end();
          });
          child.on('exit', (code) => {
            state.exitCode = code;
            // A leftover grandchild can hold the pipes open; do not wait for it forever.
            exitTimer = setTimeout(() => {
              parser.end();
              end();
            }, 3000);
          });
          child.on('close', () => {
            parser.end();
            end();
          });
          child.stdin.end(attemptPrompt);
          if (stopped) killTree(child, env);
        });
      } finally {
        current = null;
        await server.close();
      }
      return state;
    }

    /** The final event from how the last attempt ended. */
    function outcome(state) {
      const base = { type: 'done', stopped, sessionId: state.sessionId, exitCode: state.exitCode, costUsd: state.result?.costUsd ?? null, usage: state.result?.usage ?? null };
      if (stopped) return { ...base, ok: false, text: state.result?.text || '', error: { kind: 'stopped', message: '중단했습니다. 일부 작업은 이미 끝났을 수 있습니다.' } };
      if (state.guard) return { ...base, ok: false, text: '', error: state.guard };
      if (state.spawnError) return { ...base, ok: false, text: '', error: { kind: 'spawn-error', link: 'install', message: `Claude Code를 실행하지 못했습니다(${state.spawnError}).` } };
      if (state.result && !state.result.isError) return { ...base, ok: true, text: state.result.text, error: null };
      if (state.result?.subtype === 'error_max_budget_usd') return { ...base, ok: false, text: '', error: { kind: 'task-cap', retryable: false, message: '이 작업의 상한에 닿아 멈췄습니다. 이어서 보내면 계속합니다. 상한은 설정에서 바꿀 수 있습니다.' } };
      const said = `${state.result?.text || ''}\n${state.stderr}\n${state.retryError || ''}`;
      if (state.resumed && /no conversation found|session.*not found/i.test(said)) return { ...base, ok: false, text: '', error: { kind: 'resume-failed', message: '이 대화는 이어 갈 수 없습니다(기록이 지워졌거나 오래되었습니다). 내용은 읽을 수 있고, 새 대화로 시작할 수 있습니다.' } };
      const known = classifyApiError(said);
      if (known) return { ...base, ok: false, text: '', error: known };
      // A managed policy's own words are the explanation (design 14.3).
      if (/forceLogin|managed (settings|policy)|disabled by your organization/i.test(said)) return { ...base, ok: false, text: '', error: { kind: 'policy', retryable: false, message: said.trim().slice(0, 500) } };
      if (state.keyStats?.refused > 0 || /apiKeyHelper|not logged in/i.test(said)) {
        return { ...base, ok: false, text: '', error: { kind: 'key-taken', message: 'Claude Code가 키를 받지 못했습니다. 다른 프로그램이 키를 요청했을 수 있습니다. 다시 시도하고, 반복되면 Console에서 키를 폐기한 뒤 새로 만들어 주세요.' } };
      }
      if (state.result) return { ...base, ok: false, text: '', error: { kind: 'run-failed', message: state.result.text || '작업이 오류로 끝났습니다.' } };
      return { ...base, ok: false, text: '', error: { kind: 'no-result', message: 'Claude Code가 결과 없이 끝났습니다.', detail: state.stderr.trim().slice(-500) } };
    }

    /** Plan A: a run that failed because the once-only helper said no gets one new key server and --resume (design 16.1.2). */
    function needsKeyRetry(state) {
      if (stopped || state.guard || state.spawnError || !state.sessionId) return false;
      if (state.result && !state.result.isError) return false; // S9: a refused helper can still end in success
      const said = `${state.result?.text || ''}\n${state.stderr}`;
      if (classifyApiError(said) || /no conversation found/i.test(said)) return false;
      return state.keyStats?.refused > 0 || /apiKeyHelper/i.test(said);
    }

    async function run() {
      let final;
      try {
        const command = resolve();
        if (!command || command.shimOnly) {
          final = { type: 'done', ok: false, stopped: false, sessionId: resumeId, exitCode: null, costUsd: null, usage: null, text: '', error: { kind: 'not-installed', link: 'install', message: 'Claude Code를 찾지 못했습니다.' } };
        } else {
          fs.mkdirSync(configDir, { recursive: true });
          if (mcp) {
            // The run's token is in here, so it lives only as long as the run. mcp: { dir, host: { pipe, token, script }, servers }
            fs.mkdirSync(mcp.dir, { recursive: true });
            mcpConfigFile = path.join(mcp.dir, `mcp-${crypto.randomBytes(8).toString('hex')}.json`);
            const host = { command: exe, args: [mcp.host.script], env: { ELECTRON_RUN_AS_NODE: '1', AI_CHAT_HOST_PIPE: mcp.host.pipe, AI_CHAT_HOST_TOKEN: mcp.host.token } };
            fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { [HOST_SERVER]: host, ...(mcp.servers || {}) } }), { mode: 0o600 });
          }
          if (systemNote && mcp) {
            systemNoteFile = path.join(mcp.dir, `note-${crypto.randomBytes(8).toString('hex')}.md`);
            fs.writeFileSync(systemNoteFile, systemNote);
          }
          let state = await attempt(prompt, resumeId, command);
          if (needsKeyRetry(state)) {
            emit({ type: 'keyRetry', sessionId: state.sessionId, message: '키를 다시 받아 작업을 이어 갑니다.' });
            state = await attempt(RESUME_PROMPT, state.sessionId, command);
          }
          final = outcome(state);
        }
      } catch (err) {
        final = { type: 'done', ok: false, stopped, sessionId: resumeId, exitCode: null, costUsd: null, usage: null, text: '', error: { kind: err.code || 'run-error', message: err.message } };
      }
      if (mcpConfigFile) fs.rmSync(mcpConfigFile, { force: true });
      if (systemNoteFile) fs.rmSync(systemNoteFile, { force: true });
      const clean = redact(final);
      events.emit('event', clean);
      settle(clean);
    }

    setImmediate(run);
    return {
      events,
      done,
      respond: () => false,
      stop() {
        stopped = true;
        if (current) killTree(current, env);
      },
    };
  }

  /** Whether a pid from an earlier run is still that run: alive, and with this run's id on its command line. Reads only. */
  function inspect({ pid, marker }) {
    if (!Number.isInteger(pid) || pid <= 0 || !/^[0-9a-f]+$/.test(String(marker))) return Promise.resolve({ alive: false, ours: false });
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
    return new Promise((done) => {
      childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: childEnv(), windowsHide: true, shell: false, timeout: 15000, encoding: 'utf8' }, (err, stdout) => {
        const line = String(stdout || '').trim();
        done({ alive: !err && Boolean(line), ours: !err && line.includes(String(marker)) });
      });
    });
  }

  return { id: 'claude', check, start, inspect };
}

module.exports = {
  createClaudeRunner, HOST_SERVER, buildEnv, buildArgs, guardSettings, rulePath, createDeltaFilter, assertMode, resolveClaude, startKeyServer, createStreamParser, eventsOf, initProblem, compareVersions,
  MODES, TOOLS, ENV_ALLOW, MIN_VERSION, VERIFIED_VERSION, DEFAULT_BUDGET_USD,
};
