// The runner with a fake `claude` (#129, design 16.4): arguments, environment, the key never exposed, refusals, the key
// helper in every shell, prerequisites, the stream parser and stopping. No real key and no real API call.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const R = require('../lib/claude-runner');
const { WIDGET_DIR, FAKE_KEY, workspace, allFiles } = require('./helpers');

const BIN = path.join(WIDGET_DIR, 'bin');

function runner(ws, extra = {}) {
  return R.createClaudeRunner({ configDir: ws.configDir, binDir: BIN, exe: process.execPath, resolve: ws.resolve, ...extra });
}

/** Runs to the end and returns every event. */
async function runAll(ws, options = {}, runnerOptions = {}) {
  const handle = runner(ws, runnerOptions).start({ prompt: 'hello', cwd: ws.cwd, model: 'claude-haiku-5-5', getKey: () => FAKE_KEY, ...options });
  const events = [];
  handle.events.on('event', (event) => events.push(event));
  const done = await handle.done;
  return { events, done };
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('arguments: isolated non-bare with the fixed tools, prompt only on stdin, the key nowhere', async () => {
  const ws = workspace();
  try {
    const hostile = 'list & echo pwned > x.txt "quoted" %PATH%';
    const { done } = await runAll(ws, { prompt: hostile });
    assert.equal(done.ok, true);
    assert.equal(done.text, `result for: ${hostile}`);
    const [call] = ws.calls();
    assert.equal(call.prompt, hostile);
    const a = call.args;
    assert.ok(!a.includes('--bare'));
    assert.deepEqual(a.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'auto');
    assert.equal(a[a.indexOf('--setting-sources') + 1], 'user');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.ok(a.includes('--disable-slash-commands'));
    assert.equal(a[a.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep,Bash,PowerShell,WebSearch,WebFetch,Task');
    assert.equal(a[a.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.equal(a[a.indexOf('--max-budget-usd') + 1], '3');
    const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
    assert.deepEqual(Object.keys(settings), ['apiKeyHelper']);
    assert.match(settings.apiKeyHelper, /^ai-chat-key\.cmd [0-9a-f]+ [0-9a-f]+$/);
    assert.ok(!a.join(' ').includes(hostile), 'the prompt is not an argument');
    assert.ok(!a.join(' ').includes(FAKE_KEY), 'the key is not an argument');
    assert.equal(call.cwd.toLowerCase(), ws.cwd.toLowerCase());
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'x.txt')), 'no shell ran the prompt');
    assert.equal(call.keyFromHelper, true);
    assert.equal(call.keyLength, FAKE_KEY.length);
  } finally {
    ws.cleanup();
  }
});

test('--resume passes all options again with a new key server', async () => {
  const ws = workspace();
  try {
    await runAll(ws);
    await runAll(ws, { resumeId: 'abc-123' });
    const [first, second] = ws.calls();
    assert.ok(!first.args.includes('--resume'));
    assert.equal(second.args[second.args.indexOf('--resume') + 1], 'abc-123');
    for (const name of ['--setting-sources', '--strict-mcp-config', '--disable-slash-commands', '--tools', '--settings', '--permission-mode']) assert.ok(second.args.includes(name), name);
    const helperOf = (call) => JSON.parse(call.args[call.args.indexOf('--settings') + 1]).apiKeyHelper;
    assert.notEqual(helperOf(first), helperOf(second));
    assert.equal(second.keyFromHelper, true);
  } finally {
    ws.cleanup();
  }
});

test('environment: the allow list only, nothing that redirects the key or picks another credential', async () => {
  const ws = workspace();
  try {
    const bad = {
      ANTHROPIC_API_KEY: 'sk-ant-from-the-parent', ANTHROPIC_BASE_URL: 'https://evil.example', ANTHROPIC_AUTH_TOKEN: 'x', ANTHROPIC_PROFILE: 'x', ANTHROPIC_CUSTOM_HEADERS: 'x',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'x', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      HTTP_PROXY: 'http://evil.example', HTTPS_PROXY: 'http://evil.example', https_proxy: 'http://evil.example', NODE_OPTIONS: '--require x', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: 'C:\\user-claude',
    };
    await runAll(ws, {}, { env: { ...process.env, ...bad } });
    const { env } = ws.calls()[0];
    const names = new Set(Object.keys(env).map((n) => n.toUpperCase()));
    for (const name of Object.keys(bad)) {
      if (name === 'CLAUDE_CONFIG_DIR') continue;
      assert.ok(!names.has(name.toUpperCase()), `${name} must not reach the child`);
    }
    assert.equal(env.CLAUDE_CONFIG_DIR, ws.configDir);
    assert.equal(env.CLAUDE_CODE_USE_POWERSHELL_TOOL, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'Claude Code keeps no memory of its own; the widget does');
    assert.equal(env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS, '86400000');
    assert.ok(!JSON.stringify(env).includes(FAKE_KEY), 'the key is in no environment value');
    const allowed = new Set([...R.ENV_ALLOW.map((n) => n.toUpperCase()), 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_POWERSHELL_TOOL', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'AI_CHAT_ENGINE_EXE', 'AI_CHAT_KEY_SCRIPT']);
    // libuv always adds these Windows values from the parent when a child's environment lacks them; none is a credential.
    for (const name of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']) allowed.add(name);
    for (const name of names) if (!name.startsWith('=')) assert.ok(allowed.has(name), `${name} is not on the allow list`);
    assert.ok(env.Path.toLowerCase().startsWith(BIN.toLowerCase()), 'the helper folder comes first on PATH');
  } finally {
    ws.cleanup();
  }
});

test('buildEnv: names match without case and PATH appears once', () => {
  const env = R.buildEnv({ env: { PATH: 'C:\\x', systemroot: 'C:\\Windows', TEMP: 'C:\\t' }, configDir: 'C:\\c', helper: { binDir: 'C:\\b', exe: 'e', script: 's' } });
  assert.equal(env.Path, 'C:\\b;C:\\x');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(Object.keys(env).filter((n) => n.toUpperCase() === 'PATH').length, 1);
});

test('refusals: bypassPermissions and dontAsk are refused before anything starts', () => {
  const ws = workspace();
  try {
    for (const mode of ['bypassPermissions', 'dontAsk', 'BYPASSPERMISSIONS', '', 'nonsense']) {
      assert.throws(() => runner(ws).start({ prompt: 'x', cwd: ws.cwd, model: 'm', mode, getKey: () => FAKE_KEY }), (err) => err.code === 'mode-refused', String(mode));
      assert.throws(() => R.buildArgs({ model: 'm', mode, keyServer: { id: 'a', nonce: 'b' } }), (err) => err.code === 'mode-refused');
    }
    assert.ok(!R.MODES.includes('bypassPermissions'));
    assert.deepEqual(ws.calls(), []);
    // The words themselves cannot slip in through another argument.
    assert.throws(() => R.buildArgs({ model: 'bypass-model', keyServer: { id: 'a', nonce: 'b' } }), (err) => err.code === 'mode-refused');
    assert.throws(() => R.buildArgs({ model: '--dangerously', keyServer: { id: 'a', nonce: 'b' } }), (err) => err.code === 'bad-model');
    assert.throws(() => R.buildArgs({ model: 'm', resumeId: '--foo bar', keyServer: { id: 'a', nonce: 'b' } }), (err) => err.code === 'bad-session');
    // No code path in the widget names the value except this file's comment.
    const source = fs.readFileSync(path.join(WIDGET_DIR, 'lib', 'claude-runner.js'), 'utf8');
    assert.doesNotMatch(source, /shell:\s*true/);
    assert.doesNotMatch(source, /'--bare'/);
    assert.doesNotMatch(source, /--dangerously/);
  } finally {
    ws.cleanup();
  }
});

test('without a key no process starts', () => {
  const ws = workspace();
  try {
    for (const getKey of [() => '', undefined, () => null]) {
      assert.throws(() => runner(ws).start({ prompt: 'x', cwd: ws.cwd, model: 'm', getKey }), (err) => err.code === 'no-key');
    }
    assert.deepEqual(ws.calls(), []);
    assert.equal(ws.versionCalls(), 0);
  } finally {
    ws.cleanup();
  }
});

test('the key server answers once: a second ask gets nothing, a wrong value gets nothing and uses no answer', async () => {
  const server = await R.startKeyServer(() => FAKE_KEY);
  try {
    const script = path.join(BIN, 'ai-chat-key.js');
    const askAsync = (nonce) => new Promise((resolve) => {
      cp.execFile(process.execPath, [script, server.id, nonce], { windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
    });
    const wrong = await askAsync('0'.repeat(32));
    assert.deepEqual([wrong.code, wrong.stdout], [1, '']);
    assert.deepEqual(server.stats, { served: 0, refused: 1 });
    const first = await askAsync(server.nonce);
    assert.deepEqual([first.code, first.stdout], [0, FAKE_KEY]);
    const second = await askAsync(server.nonce);
    assert.deepEqual([second.code, second.stdout], [1, '']);
    assert.deepEqual(server.stats, { served: 1, refused: 2 });
  } finally {
    await server.close();
  }
});

test('the helper command reads the same in cmd, PowerShell and Git Bash, through a folder with spaces', { skip: process.platform !== 'win32' }, async (t) => {
  const ws = workspace();
  // A copy of bin in a folder with a space and Korean letters, as under Program Files or a Korean user name.
  const bin = path.join(ws.dir, '프로그램 폴더', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['ai-chat-key.cmd', 'ai-chat-key.js']) fs.copyFileSync(path.join(BIN, f), path.join(bin, f));
  try {
    const env = R.buildEnv({ env: process.env, configDir: ws.configDir, helper: { binDir: bin, exe: process.execPath, script: path.join(bin, 'ai-chat-key.js') } });
    const shells = [['cmd', (c) => [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', c]]], ['powershell', (c) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c]]]];
    const gitBash = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')].find((f) => fs.existsSync(f));
    if (gitBash) shells.push(['git bash', (c) => [gitBash, ['-c', c]]]);
    else t.diagnostic('Git Bash not found: that shell is not tested here');
    for (const [name, build] of shells) {
      const server = await R.startKeyServer(() => FAKE_KEY);
      const [file, args] = build(`ai-chat-key.cmd ${server.id} ${server.nonce}`);
      const out = await new Promise((resolve) => {
        cp.execFile(file, args, { env, windowsHide: true, encoding: 'utf8', windowsVerbatimArguments: name === 'cmd' }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
      });
      await server.close();
      assert.equal(out.stdout.trim(), FAKE_KEY, `${name}: ${out.stderr}`);
      assert.ok(!out.stdout.includes('@'), `${name}: the script echoes nothing`);
    }
  } finally {
    ws.cleanup();
  }
});

test('the key is hidden in every event when the program prints it, and stays out of the config folder and calls', async () => {
  const ws = workspace({ leak: true });
  try {
    const { events, done } = await runAll(ws);
    assert.equal(done.ok, true);
    assert.ok(!JSON.stringify(events).includes(FAKE_KEY));
    assert.ok(!JSON.stringify(done).includes(FAKE_KEY));
    assert.ok(events.some((e) => e.type === 'text' && e.text.includes('[키 가림]')));
    assert.equal(events.find((e) => e.type === 'toolCall' && e.name === 'Bash').input.command, 'echo [키 가림]');
    assert.ok(done.text.includes('[키 가림]'));
    for (const file of allFiles(ws.configDir)) assert.ok(!fs.readFileSync(file, 'utf8').includes(FAKE_KEY), file);
  } finally {
    ws.cleanup();
  }
});

test('an error text with the key is hidden too', async () => {
  const ws = workspace({ resultError: `boom ${FAKE_KEY}` });
  try {
    const { events, done } = await runAll(ws);
    assert.equal(done.ok, false);
    assert.equal(done.error.kind, 'run-failed');
    assert.ok(!JSON.stringify([events, done]).includes(FAKE_KEY));
  } finally {
    ws.cleanup();
  }
});

test('a second ask from a command in the run is refused', async () => {
  const ws = workspace({ askHelperTwice: true });
  try {
    const { done } = await runAll(ws);
    assert.equal(done.ok, true);
    const [call] = ws.calls();
    assert.equal(call.keyFromHelper, true);
    assert.equal(call.secondRefused, true);
  } finally {
    ws.cleanup();
  }
});

// ---- plan A: a refused helper ----

test('plan A: a run that failed on the refused helper resumes once with a new key server', async () => {
  const ws = workspace({ failFirstWithHelperError: true });
  try {
    const { events, done } = await runAll(ws);
    assert.equal(done.ok, true);
    assert.ok(events.some((e) => e.type === 'keyRetry'));
    const calls = ws.calls();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], 'fake-session-1');
    assert.equal(calls[1].keyFromHelper, true);
    assert.match(calls[1].prompt, /Continue the previous task/);
  } finally {
    ws.cleanup();
  }
});

test('S9: a refused helper with a successful run is not retried', async () => {
  const ws = workspace({ helperRefusedButSucceeds: true });
  try {
    const { events, done } = await runAll(ws);
    assert.equal(done.ok, true);
    assert.ok(!events.some((e) => e.type === 'keyRetry'));
    assert.equal(ws.calls().length, 1);
  } finally {
    ws.cleanup();
  }
});

test('another program took the key first: one retry at most, then says so', async () => {
  const ws = workspace({ resultError: 'Not logged in', askHelperTwice: true });
  try {
    const { done } = await runAll(ws);
    assert.equal(done.ok, false);
    assert.equal(done.error.kind, 'key-taken');
    assert.equal(ws.calls().length, 2, 'the refused second ask counts: one retry, no more');
  } finally {
    ws.cleanup();
  }
});

test('API errors are explained and not retried', async () => {
  const cases = [
    ['API Error: 400 This API key is not scoped to a workspace', 'workspace-scope'],
    ['API Error: 401 invalid x-api-key', 'authentication'],
    ['API Error: 403 permission_error', 'permission'],
    ['Your credit balance is too low', 'credit'],
    ['You have reached your specified workspace limit', 'spend-limit'],
    ['enforced_spend_limit_reached', 'spend-limit'],
  ];
  for (const [text, kind] of cases) {
    const ws = workspace({ resultError: text });
    try {
      const { done } = await runAll(ws);
      assert.equal(done.error.kind, kind, text);
      assert.equal(ws.calls().length, 1, text);
    } finally {
      ws.cleanup();
    }
  }
});

// ---- what the first event says ----

test('required tools missing: the run stops and says which, also for a future bare default', async () => {
  const ws = workspace({ tools: ['Bash', 'Edit', 'PowerShell', 'Read'], hangAfterInit: true });
  try {
    const { done } = await runAll(ws);
    assert.equal(done.ok, false);
    assert.equal(done.error.kind, 'tools-missing');
    assert.deepEqual(done.error.tools, ['Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
    assert.equal(done.costUsd, null);
  } finally {
    ws.cleanup();
  }
});

test('no shell tool at all stops; PowerShell or Task missing is a notice only', async () => {
  const none = workspace({ dropTools: ['Bash', 'PowerShell'], hangAfterInit: true });
  try {
    const { done } = await runAll(none);
    assert.equal(done.error.kind, 'tools-missing');
    assert.deepEqual(done.error.tools, ['Bash 또는 PowerShell']);
  } finally {
    none.cleanup();
  }
  const ps = workspace({ dropTools: ['PowerShell'] }); // what S9 saw before CLAUDE_CODE_USE_POWERSHELL_TOOL
  try {
    const { events, done } = await runAll(ps);
    assert.equal(done.ok, true);
    assert.deepEqual(events.find((e) => e.type === 'notice').tools, ['PowerShell']);
  } finally {
    ps.cleanup();
  }
});

test('a mode or key source other than asked stops the run', async () => {
  const mode = workspace({ forceMode: 'default', hangAfterInit: true });
  try {
    const { done } = await runAll(mode);
    assert.equal(done.error.kind, 'mode-changed');
  } finally {
    mode.cleanup();
  }
  const source = workspace({ apiKeySource: 'ANTHROPIC_API_KEY', hangAfterInit: true });
  try {
    const { done } = await runAll(source);
    assert.equal(done.error.kind, 'key-source');
  } finally {
    source.cleanup();
  }
});

// ---- prerequisites ----

test('check: runs only --version; too old stops, a newer version is a note, failure stops', async () => {
  const ok = workspace({ version: R.VERIFIED_VERSION });
  try {
    const r = await runner(ok).check();
    assert.deepEqual([r.installed, r.version, r.verified, r.problems, r.notes], [true, R.VERIFIED_VERSION, true, [], []]);
    assert.equal(ok.versionCalls(), 1);
    assert.deepEqual(ok.calls(), []);
  } finally {
    ok.cleanup();
  }
  const old = workspace({ version: '2.1.286' });
  try {
    const r = await runner(old).check();
    assert.equal(r.problems[0].kind, 'too-old');
    assert.match(r.problems[0].message, /claude update/);
  } finally {
    old.cleanup();
  }
  const newer = workspace({ version: '9.0.0' });
  try {
    const r = await runner(newer).check();
    assert.deepEqual([r.problems, r.verified, r.notes[0].kind], [[], false, 'unverified-version']);
  } finally {
    newer.cleanup();
  }
  const broken = workspace({ versionFails: true });
  try {
    assert.equal((await runner(broken).check()).problems[0].kind, 'not-runnable');
  } finally {
    broken.cleanup();
  }
});

test('check: not installed says so and starts nothing, never installs or logs in', async () => {
  const ws = workspace();
  try {
    const missing = await runner(ws, { resolve: () => null }).check();
    assert.deepEqual([missing.installed, missing.problems[0].kind, missing.problems[0].link], [false, 'not-installed', 'install']);
    const shim = await runner(ws, { resolve: () => ({ shimOnly: true }) }).check();
    assert.equal(shim.problems[0].kind, 'unsupported-install');
    assert.equal(ws.versionCalls(), 0);
    const source = fs.readFileSync(path.join(WIDGET_DIR, 'lib', 'claude-runner.js'), 'utf8');
    assert.doesNotMatch(source, /npm install|'install'\]|'update'|'login'|auth login/);
  } finally {
    ws.cleanup();
  }
});

test('resolveClaude: claude.exe on PATH or the installer folder, no relative entries, npm shim to its exe', () => {
  const has = (...files) => (f) => files.includes(f);
  const env = { PATH: 'relative\\bin;C:\\tools;C:\\npm', USERPROFILE: 'C:\\Users\\u' };
  assert.equal(R.resolveClaude({ env, exists: has('C:\\tools\\claude.exe', 'relative\\bin\\claude.exe') }).file, 'C:\\tools\\claude.exe');
  assert.equal(R.resolveClaude({ env, exists: has('relative\\bin\\claude.exe') }), null);
  assert.equal(R.resolveClaude({ env, exists: has('C:\\Users\\u\\.local\\bin\\claude.exe') }).file, 'C:\\Users\\u\\.local\\bin\\claude.exe');
  const npmExe = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  assert.equal(R.resolveClaude({ env, exists: has('C:\\npm\\claude.cmd', npmExe) }).file, npmExe);
  assert.deepEqual(R.resolveClaude({ env, exists: has('C:\\npm\\claude.cmd') }), { shimOnly: true });
  assert.equal(R.resolveClaude({ env: {}, exists: () => true }), null);
});

// ---- the stream parser ----

test('parser: lines split anywhere, unknown events ignored, broken lines skipped', () => {
  const got = [];
  const parser = R.createStreamParser((event) => got.push(event));
  const text = [
    'not json at all',
    '{"broken": ',
    '[1,2,3]',
    '"a string"',
    'null',
    JSON.stringify({ type: 'future_event', x: 1 }),
    JSON.stringify({ type: 'system', subtype: 'hook_started' }),
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'auto', apiKeySource: 'apiKeyHelper', tools: ['Read', 3] }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '가나다' }, { type: 'tool_use', id: 't', name: 'Bash', input: { a: 1 } }, { type: 'image' }], usage: { input_tokens: 1 } } }),
    JSON.stringify({ type: 'assistant' }),
    JSON.stringify({ type: 'assistant', message: { content: 'not a list' } }),
    JSON.stringify({ type: 'result', is_error: false, result: '끝', total_cost_usd: 0.5, session_id: 's' }),
  ].join('\r\n');
  for (let i = 0; i < text.length; i += 7) parser.push(text.slice(i, i + 7));
  parser.end();
  assert.deepEqual(got.map((e) => e.type), ['init', 'text', 'toolCall', 'usage', 'result']);
  assert.deepEqual(got[0].tools, ['Read']);
  assert.equal(got[1].text, '가나다');
  assert.equal(got[4].costUsd, 0.5);
  assert.equal(parser.stats.broken, 2);
});

test('parser: the last line without a newline counts at the end', () => {
  const got = [];
  const parser = R.createStreamParser((event) => got.push(event));
  parser.push(JSON.stringify({ type: 'result', result: 'x' }));
  assert.deepEqual(got, []);
  parser.end();
  assert.equal(got[0].text, 'x');
});

test('no result: broken output and a silent exit end as no-result, with no retry', async () => {
  const ws = workspace({ rawLines: ['garbage', '{"also": broken'], noResult: true });
  try {
    const { done } = await runAll(ws);
    assert.equal(done.ok, false);
    assert.equal(done.error.kind, 'no-result');
    assert.equal(done.exitCode, 1);
    assert.equal(ws.calls().length, 1);
  } finally {
    ws.cleanup();
  }
});

test('a program that cannot start ends with an error, not a hang', async () => {
  const ws = workspace();
  try {
    const { done } = await runAll(ws, {}, { resolve: () => ({ file: path.join(ws.dir, 'nope.exe'), args: [] }) });
    assert.equal(done.error.kind, 'spawn-error');
  } finally {
    ws.cleanup();
  }
});

test('the runner does not know how to start without a found claude', async () => {
  const ws = workspace();
  try {
    const { done } = await runAll(ws, {}, { resolve: () => null });
    assert.equal(done.error.kind, 'not-installed');
    assert.deepEqual(ws.calls(), []);
  } finally {
    ws.cleanup();
  }
});

// ---- stopping ----

test('stop: ends the whole process tree and reports stopped, no retry', { skip: process.platform !== 'win32' }, async () => {
  const ws = workspace({ spawnProbe: true });
  try {
    const handle = runner(ws).start({ prompt: 'x', cwd: ws.cwd, model: 'm', getKey: () => FAKE_KEY });
    const probeFile = path.join(ws.dir, 'probe.pid');
    for (let i = 0; i < 100 && !(fs.existsSync(probeFile) && fs.readFileSync(probeFile, 'utf8')); i++) await new Promise((r) => setTimeout(r, 100));
    const probe = Number(fs.readFileSync(probeFile, 'utf8'));
    assert.ok(isAlive(probe), 'the child runs before the stop');
    handle.stop();
    const done = await handle.done;
    assert.equal(done.stopped, true);
    assert.equal(done.ok, false);
    assert.equal(done.error.kind, 'stopped');
    for (let i = 0; i < 50 && isAlive(probe); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(isAlive(probe), false, 'the child is gone too');
    assert.equal(ws.calls().length, 1);
  } finally {
    ws.cleanup();
  }
});

test('stop right after start still ends with done', { skip: process.platform !== 'win32' }, async () => {
  const ws = workspace({ hangAfterInit: true });
  try {
    const handle = runner(ws).start({ prompt: 'x', cwd: ws.cwd, model: 'm', getKey: () => FAKE_KEY });
    let pid = null;
    handle.events.on('event', (event) => { if (event.type === 'spawned') pid = event.pid; });
    handle.stop();
    const done = await handle.done;
    assert.equal(done.stopped, true);
    // taskkill runs on its own: until the process is really gone it holds the work folder, and removing it fails (EBUSY).
    for (let i = 0; i < 100 && pid && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  } finally {
    ws.cleanup();
  }
});

// ---- step 3: the run's own folder, the guard, streaming, leftovers ----

test('each run uses the config folder it is given', async () => {
  const ws = workspace();
  try {
    const own = path.join(ws.dir, 'session-a');
    await runAll(ws, { configDir: own });
    assert.equal(ws.calls()[0].env.CLAUDE_CONFIG_DIR, own);
  } finally {
    ws.cleanup();
  }
});

test('write guard: file tools kept out of sensitive folders, and off when asked', async () => {
  assert.equal(R.rulePath('C:\\Users\\Kim Tae\\.ssh'), '//c/Users/Kim Tae/.ssh');
  assert.equal(R.rulePath('relative'), null);
  const guard = R.guardSettings({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', USERPROFILE: 'C:\\Users\\a' });
  assert.equal(guard.permissions.blockWritesOutsideWorkingDirectories, true);
  for (const rule of ['Read(//c/Users/a/AppData/Roaming/chilgong88/**)', 'Edit(//c/Users/a/AppData/Roaming/chilgong88/**)', 'Read(//c/Users/a/.ssh/**)', 'Read(//c/Users/a/.claude/**)', 'Read(//c/Users/a/AppData/Local/Google/Chrome/User Data/**)', 'Read(//c/Users/a/AppData/Local/Microsoft/Edge/User Data/**)', 'Read(//c/Users/a/AppData/Roaming/Mozilla/Firefox/Profiles/**)']) {
    assert.ok(guard.permissions.deny.includes(rule), rule);
  }
  const ws = workspace();
  try {
    const settingsOf = (call) => JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
    await runAll(ws, { writeGuard: true });
    await runAll(ws);
    const [on, off] = ws.calls();
    assert.equal(settingsOf(on).permissions.blockWritesOutsideWorkingDirectories, true);
    assert.ok(settingsOf(on).apiKeyHelper);
    assert.equal(settingsOf(off).permissions, undefined);
    assert.ok(!on.args.join(' ').includes(FAKE_KEY));
  } finally {
    ws.cleanup();
  }
});

test('streamed text arrives as it comes, and a key split across pieces never shows', async () => {
  const ws = workspace({ deltas: ['안녕', '하세요 ', '$KEYHEAD', '$KEYTAIL', ' 끝'] });
  try {
    const { events } = await runAll(ws);
    const shown = events.filter((e) => e.type === 'textDelta').map((e) => e.text);
    assert.deepEqual(shown.slice(0, 2), ['안녕', '하세요 ']);
    assert.equal(shown.join(''), '안녕하세요 [키 가림] 끝');
    assert.ok(!JSON.stringify(events).includes(FAKE_KEY.slice(0, 10)));
  } finally {
    ws.cleanup();
  }
  const filter = R.createDeltaFilter('sk-abcd', '[x]');
  assert.equal(filter.push('hello s'), 'hello ');
  assert.equal(filter.push('k-zz'), 'sk-zz');
  assert.equal(filter.push('sk-'), '');
  assert.equal(filter.flush(), 'sk-');
  assert.equal(filter.push('sk-abcd!'), '[x]!');
});

test('a resume with no record ends as resume-failed, with no key retry', async () => {
  const ws = workspace({ strictResume: true });
  try {
    const { done } = await runAll(ws, { resumeId: 'gone-1' });
    assert.equal(done.error.kind, 'resume-failed');
    assert.equal(ws.calls().length, 1);
  } finally {
    ws.cleanup();
  }
});

test('inspect: only a live process with the run id on its command line counts as ours', { skip: process.platform !== 'win32' }, async () => {
  const ws = workspace();
  const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', 'abcdef0123456789'], { stdio: 'ignore', windowsHide: true });
  try {
    const r = runner(ws);
    assert.deepEqual(await r.inspect({ pid: child.pid, marker: 'abcdef0123456789' }), { alive: true, ours: true });
    assert.deepEqual(await r.inspect({ pid: child.pid, marker: '00000000000000ff' }), { alive: true, ours: false });
    assert.equal((await r.inspect({ pid: 'x; calc', marker: 'ab' })).ours, false);
    assert.equal((await r.inspect({ pid: 1, marker: 'not hex!' })).ours, false);
  } finally {
    child.kill();
    ws.cleanup();
  }
});
