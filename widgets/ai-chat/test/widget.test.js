// The widget around the runner (#129): key storage and what the windows may see, consent, the order of the gates, the
// manifest and packaging, and that an unreleased widget stays off the site, GitHub and the picker's default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create, CHANNEL, LINKS } = require('../index');
const { CONSENT, CONSENT_VERSION } = require('../lib/consent');
const { keyProblem, classifyApiError, checkConnection, MODELS_URL } = require('../lib/key');
const S = require('../lib/settings');
const { WIDGET_DIR, FAKE_KEY, workspace, fakeContext, allFiles, READY } = require('./helpers');
const { setup } = require('./setup');

const root = path.join(WIDGET_DIR, '..', '..');
const CONSENTED = { consent: { version: CONSENT_VERSION, at: '2026-11-07T00:00:00.000Z' }, modelChosen: true };

// ---- manifest and release rules ----

test('widget.json: first public version 0.1.1, off by default, engine API with the tray, no installer hooks', () => {
  const m = JSON.parse(fs.readFileSync(path.join(WIDGET_DIR, 'widget.json'), 'utf8'));
  assert.equal(m.id, 'ai-chat');
  assert.equal(m.name, 'AI Widgets');
  assert.equal(m.version, '0.1.1');
  assert.equal(m.defaultEnabled, false);
  assert.equal(m.engineApi, '1.9');
  assert.equal(m.package.productName, 'AiChatWidget');
  assert.equal(m.package.installerHooks, undefined);
});

test('not on the picker by default; on the site and release:all once it has a public version; on GitHub without the spike tool', () => {
  const { DEFAULT_CHECKED } = require('../../../engine/main/widget-picker');
  assert.ok(!DEFAULT_CHECKED.includes('ai-chat'));
  // Public prep for 0.1.1 (#129): the site and release:all follow the version, so a 0.0.x build stays off them by itself.
  const { isUnreleasedWidget } = require('../../../scripts/version');
  const unreleased = isUnreleasedWidget(JSON.parse(fs.readFileSync(path.join(WIDGET_DIR, 'widget.json'), 'utf8')));
  const { buildProducts } = require('../../../scripts/site-build');
  assert.equal(buildProducts(root).widgets.some((w) => w.id === 'ai-chat'), !unreleased);
  const { productOrder } = require('../../../scripts/release-all');
  assert.equal(productOrder().includes('ai-chat'), !unreleased);
  const { loadConfig, excludedBy } = require('../../../scripts/publish-github');
  const rules = loadConfig().exclude;
  for (const f of ['widgets/ai-chat/widget.json', 'widgets/ai-chat/lib/claude-runner.js', 'docs/ai-chat.md', 'docs/ai-chat-design.md', 'release-notes/widget-ai-chat-v0.1.1.md']) {
    assert.ok(!excludedBy(f, rules), `${f} is public`);
  }
  for (const f of ['docs/ai-chat-internal-test.md', 'tools/ai-chat-spike/spike.js', 'engine/test/ai-chat-spike.test.js', 'engine/test/fixtures/ai-chat-spike-fake-claude.js']) {
    assert.ok(excludedBy(f, rules), `${f} stays out of the public copy`);
  }
  // The download page has the text ready; its screenshots come before the release (engine/test/site.test.js).
  const showcase = JSON.parse(fs.readFileSync(path.join(root, 'site', 'public', 'showcase.json'), 'utf8'))['ai-chat'];
  assert.ok(showcase.features.length >= 3);
  for (const words of ['Anthropic과 제휴한 제품이 아닙니다', 'SmartScreen', 'SHA-256', '격리 공간이 아닙니다']) assert.ok(showcase.requires.includes(words), words);
});

test('the package has the pages, the helper and the libraries, and no tests', () => {
  const { packageWidget } = require('../../../tools/widget-kit/build');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ai-chat-')), 'ai-chat');
  try {
    packageWidget(WIDGET_DIR, out);
    for (const f of ['widget.json', 'index.js', 'preload.js', 'bin/ai-chat-key.cmd', 'bin/ai-chat-key.js', 'lib/claude-runner.js', 'lib/sessions.js', 'lib/chat-controller.js', 'lib/cards.js', 'lib/host-server.js', 'host/ai-chat-host.js', 'lib/key.js', 'lib/budget.js', 'lib/recipes.js', 'lib/attachments.js', 'lib/recipe-safety.js', 'lib/recipe-prompts.js', 'chat/recipes.js', 'lib/consent.js', 'lib/settings.js', 'chat/chat.html', 'chat/chat.js', 'chat/chat.css', 'chat/markdown-parse.js', 'chat/markdown-view.js', 'settings/panel.html', 'settings/panel.js', 'settings/panel.css']) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
    }
    assert.ok(!fs.existsSync(path.join(out, 'test')));
    assert.match(fs.readFileSync(path.join(out, 'chat', 'chat.html'), 'utf8'), /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src data:"/);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('no key literal in the widget code, and the key never reaches the page code', () => {
  for (const f of allFiles(WIDGET_DIR).filter((p) => !p.includes(`${path.sep}test${path.sep}`))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /sk-ant-api|ANTHROPIC_API_KEY/, f);
  }
  const page = ['chat/chat.js', 'chat/recipes.js', 'chat/markdown-view.js', 'chat/markdown-parse.js', 'preload.js'].map((f) => fs.readFileSync(path.join(WIDGET_DIR, f), 'utf8')).join('\n');
  assert.doesNotMatch(page, /ctx\.secrets|secrets\(\)|getKey|require\('fs'\)|innerHTML|insertAdjacentHTML|outerHTML/);
});

// ---- consent and the first-run steps ----

test('the consent text is the design text, word for word', () => {
  const design = fs.readFileSync(path.join(root, 'docs', 'ai-chat-design.md'), 'utf8').split('\n');
  const at = design.findIndex((l) => l.startsWith(`> **${CONSENT.title}**`));
  assert.ok(at > 0, 'the title is in the design');
  const items = [];
  for (let i = at + 1; design[i].startsWith('> - '); i++) items.push(design[i].slice(4));
  assert.deepEqual(CONSENT.items, items);
});

test('before consent: the screen asks, a run is refused, no process starts even with a key', async () => {
  const t = setup();
  try {
    t.handlers.saveKey(FAKE_KEY);
    const before = await t.call('state');
    assert.deepEqual(before.consent, CONSENT);
    assert.equal(before.prerequisites, null);
    const refused = t.call('send', { prompt: 'x' });
    assert.deepEqual([refused.ok, refused.code], [false, 'consent']);
    assert.equal(t.ws.versionCalls(), 0);
    assert.deepEqual(t.ws.calls(), []);
    assert.equal(t.call('acceptConsent'), true);
    assert.equal(t.fake.state().consent.version, CONSENT_VERSION);
    assert.equal((await t.call('state')).consent, null);
  } finally {
    t.cleanup();
  }
});

test('an older consent version asks again', async () => {
  const t = setup({}, { initial: { consent: { version: CONSENT_VERSION - 1, at: 'x' } } });
  try {
    t.handlers.saveKey(FAKE_KEY);
    assert.deepEqual((await t.call('state')).consent, CONSENT);
    assert.equal(t.call('send', { prompt: 'x' }).code, 'consent');
  } finally {
    t.cleanup();
  }
});

test('C6: the model is picked once on first run, with Opus 5.5 selected and costs shown', async () => {
  const t = setup({}, { initial: { consent: CONSENTED.consent } });
  try {
    t.handlers.saveKey(FAKE_KEY);
    const s = await t.call('state');
    assert.equal(s.needsModel, true);
    assert.equal(s.model, 'claude-opus-5-5');
    assert.ok(s.models.every((m) => /추정/.test(m.cost)));
    assert.equal(t.call('send', { prompt: 'x' }).code, 'model');
    assert.deepEqual(t.ws.calls(), []);
    assert.equal(t.call('chooseModel', '--bad'), false);
    assert.equal(t.call('chooseModel', 'claude-haiku-5-5'), true);
    const after = await t.call('state');
    assert.deepEqual([after.needsModel, after.model], [false, 'claude-haiku-5-5']);
  } finally {
    t.cleanup();
  }
});

// ---- the key ----

test('no key: no process at all, not even the version check', async () => {
  const t = setup({}, { initial: CONSENTED });
  try {
    const s = await t.call('state');
    assert.deepEqual([s.consent, s.key, s.prerequisites], [null, { has: false, tail: '' }, null]);
    assert.equal(t.call('send', { prompt: 'x' }).code, 'no-key');
    assert.equal(t.ws.versionCalls(), 0);
    assert.deepEqual(t.ws.calls(), []);
    assert.ok(!fs.existsSync(path.join(t.fake.ctx.dataDir, 'claude-config')));
  } finally {
    t.cleanup();
  }
});

test('the windows get only whether there is a key and its last 4 characters', async () => {
  const t = setup({}, { initial: CONSENTED });
  try {
    const saved = t.handlers.saveKey(`  ${FAKE_KEY}\n`);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.status, { has: true, tail: 'Z9y8', encryption: true });
    assert.ok(!JSON.stringify(saved).includes(FAKE_KEY));
    assert.deepEqual(t.handlers.keyStatus(), saved.status);
    const s = await t.call('state');
    assert.deepEqual(s.key, { has: true, tail: 'Z9y8' });
    assert.ok(!JSON.stringify(s).includes(FAKE_KEY));
    const view = t.widget.settings.get();
    assert.ok(!JSON.stringify(view).includes(FAKE_KEY));
    // Settings cannot carry the key into the plain settings file.
    t.widget.settings.save({ model: 'claude-haiku-5-5', workDir: '', apiKey: FAKE_KEY, key: FAKE_KEY });
    assert.ok(!JSON.stringify(t.fake.state()).includes(FAKE_KEY));
    // Only the secret store has it, and not in plain text.
    for (const f of allFiles(t.fake.ctx.dataDir)) assert.ok(!fs.readFileSync(f, 'utf8').includes(FAKE_KEY), f);
    assert.deepEqual(t.handlers.deleteKey().status, { has: false, tail: '', encryption: true });
  } finally {
    t.cleanup();
  }
});

test('a key that cannot be encrypted is refused, never stored in plain text', () => {
  const t = setup({}, { encrypted: false, initial: CONSENTED });
  try {
    const res = t.handlers.saveKey(FAKE_KEY);
    assert.deepEqual([res.ok, res.code, res.status.has, res.status.encryption], [false, 'secret-unavailable', false, false]);
    for (const f of allFiles(t.fake.ctx.dataDir)) assert.ok(!fs.readFileSync(f, 'utf8').includes(FAKE_KEY), f);
    assert.ok(!allFiles(t.fake.ctx.dataDir).some((f) => f.endsWith('secrets.json')));
  } finally {
    t.cleanup();
  }
});

test('key format: admin keys and subscription tokens are refused', () => {
  assert.equal(keyProblem(FAKE_KEY), null);
  assert.match(keyProblem('sk-ant-admin01-abcdefghijklmnopqrstuvwxyz'), /관리자/);
  assert.match(keyProblem('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz'), /구독/);
  for (const bad of ['', 'hello', 'sk-ant-short', `sk-ant-api03-${'a'.repeat(20)} x`]) assert.ok(keyProblem(bad), bad);
  const t = setup();
  try {
    assert.equal(t.handlers.saveKey('sk-ant-admin01-abcdefghijklmnopqrstuvwxyz').ok, false);
    assert.equal(t.handlers.keyStatus().has, false);
  } finally {
    t.cleanup();
  }
});

// ---- the connection check ----

const response = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test('connection check: GET /v1/models with the key header, no redirects, and a workspace error explained', async () => {
  const asked = [];
  const ok = await checkConnection(FAKE_KEY, { fetchImpl: async (url, options) => { asked.push([url, options]); return response(200); } });
  assert.equal(ok.ok, true);
  assert.equal(asked[0][0], MODELS_URL);
  assert.equal(asked[0][1].method, 'GET');
  assert.equal(asked[0][1].redirect, 'error');
  assert.equal(asked[0][1].headers['x-api-key'], FAKE_KEY);
  assert.equal(asked[0][1].body, undefined);

  const scope = await checkConnection(FAKE_KEY, { fetchImpl: async () => response(400, '{"error":{"message":"This API key is not scoped to a workspace"}}') });
  assert.deepEqual([scope.ok, scope.kind, scope.link], [false, 'workspace-scope', 'keys']);
  assert.match(scope.message, /workspace를 골라/);
  assert.equal((await checkConnection(FAKE_KEY, { fetchImpl: async () => response(401, 'x') })).kind, 'authentication');
  assert.equal((await checkConnection(FAKE_KEY, { fetchImpl: async () => response(403, 'x') })).kind, 'permission');
  const other = await checkConnection(FAKE_KEY, { fetchImpl: async () => response(500, `oops ${FAKE_KEY}`) });
  assert.equal(other.ok, false);
  assert.ok(!JSON.stringify(other).includes(FAKE_KEY), 'an answer text never comes through');
  const offline = await checkConnection(FAKE_KEY, { fetchImpl: async () => { throw new Error(`fail ${FAKE_KEY}`); } });
  assert.equal(offline.kind, 'network');
  assert.ok(!JSON.stringify(offline).includes(FAKE_KEY));
  assert.equal(classifyApiError('all fine'), null);
});

test('the check button: only with a saved key, and no process', async () => {
  let asked = 0;
  const t = setup({}, { fetchImpl: async () => { asked++; return response(200); } });
  try {
    assert.equal((await t.handlers.testKey()).kind, 'no-key');
    assert.equal(asked, 0);
    t.handlers.saveKey(FAKE_KEY);
    assert.equal((await t.handlers.testKey()).ok, true);
    assert.equal(asked, 1);
    assert.equal(t.ws.versionCalls(), 0);
  } finally {
    t.cleanup();
  }
});

test('the widget has no way to ask for bypassPermissions', () => {
  for (const f of ['index.js', 'lib/chat-controller.js', 'lib/settings.js', 'settings/panel.html', 'settings/panel.js', 'chat/chat.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(WIDGET_DIR, f), 'utf8'), /bypass|dontAsk|dangerously/i, f);
  }
  assert.equal(S.sanitize({ mode: 'bypassPermissions' }).mode, 'auto');
  const t = setup();
  try {
    t.widget.settings.save({ model: 'claude-haiku-5-5', workDir: '', mode: 'bypassPermissions', permissionMode: 'bypassPermissions' });
    assert.ok(!JSON.stringify(t.fake.state()).includes('bypass'));
    assert.equal(t.widget.settings.get().mode, 'auto');
  } finally {
    t.cleanup();
  }
});

// ---- the window and engine edges ----

test('quiet start: only a tray item, no window and no process until it is opened', () => {
  const ws = workspace();
  try {
    const fake = fakeContext(ws);
    const widget = create(fake.ctx, { resolve: ws.resolve, documents: ws.dir, widgetTools: () => ({ state: 'off', tools: [] }) });
    assert.equal(widget.needsSetup(), false);
    widget.start();
    assert.deepEqual(fake.windows, []);
    assert.deepEqual(fake.tray().map((i) => [i.id, i.label]), [['open', 'AI Widgets']]);
    assert.equal(ws.versionCalls(), 0);
    fake.tray()[0].click();
    assert.equal(fake.windows.length, 1);
    fake.tray()[0].click();
    assert.equal(fake.windows.length, 1, 'the open window comes forward');
    assert.deepEqual(widget.desktopWindows(), []);
    assert.match(fake.windows[0].options.html, /chat[\\/]chat\.html$/);
    widget.stop();
  } finally {
    ws.cleanup();
  }
});

test('IPC: only the chat window, only known calls; links only from the list', () => {
  const t = setup();
  try {
    assert.throws(() => t.fake.handlers[CHANNEL]({ sender: {} }, 'state'), /Not the AI chat window/);
    assert.throws(() => t.call('constructor'), /Unknown call/);
    assert.equal(t.call('openLink', 'https://evil.example'), false);
    assert.equal(t.call('openLink', 'constructor'), false);
    assert.deepEqual(t.fake.opened, []);
    assert.equal(t.call('openLink', 'aup'), true);
    assert.deepEqual(t.fake.opened, [LINKS.aup]);
    for (const url of Object.values(LINKS)) assert.match(url, /^https:\/\/(www\.anthropic\.com|code\.claude\.com|platform\.claude\.com)\//);
    t.call('openSettings');
    assert.equal(t.fake.settingsOpened(), 1);
  } finally {
    t.cleanup();
  }
});

test('settings: every value is checked, the defaults are the design defaults', () => {
  const d = S.sanitize({});
  assert.deepEqual([d.monthlyBudgetUsd, d.taskCapUsd, d.resetDay], [20, 3, 1]);
  assert.equal(S.sanitize({ monthlyBudgetUsd: -5 }).monthlyBudgetUsd, 20);
  assert.equal(S.sanitize({ taskCapUsd: 'x' }).taskCapUsd, 3);
  assert.equal(S.sanitize({ resetDay: 31 }).resetDay, 1);
  assert.deepEqual([d.model, d.modelChosen, d.mode, d.workDir, d.keepDays, d.maxConcurrent, d.writeGuard, d.consent], ['claude-opus-5-5', false, 'auto', '', 30, 1, true, null]);
  assert.equal(S.sanitize({ model: '--evil' }).model, 'claude-opus-5-5');
  assert.equal(S.sanitize({ workDir: 'relative\\dir' }).workDir, '');
  assert.equal(S.sanitize({ keepDays: 5 }).keepDays, 30);
  assert.equal(S.sanitize({ keepDays: 0 }).keepDays, 0);
  assert.equal(S.sanitize({ maxConcurrent: 9 }).maxConcurrent, 1);
  assert.deepEqual([d.sideWidth, d.sideCollapsed], [180, false]);
  assert.deepEqual([S.sanitize({ sideWidth: 20 }).sideWidth, S.sanitize({ sideWidth: 9999 }).sideWidth, S.sanitize({ sideWidth: 'x' }).sideWidth, S.sanitize({ sideWidth: 200.6 }).sideWidth], [140, 360, 180, 201]);
  assert.equal(S.sanitize({ sideCollapsed: 'yes' }).sideCollapsed, false);
  assert.equal(S.defaultWorkDir('C:\\Docs'), path.join('C:\\Docs', 'Desk Widgets', 'AI 대화'));
  const t = setup({}, { initial: READY });
  try {
    assert.equal(t.widget.settings.save({ model: 'claude-haiku-5-5', workDir: 'relative' }).ok, false);
    assert.equal(t.widget.settings.save({ model: 'claude-haiku-5-5', workDir: 'C:\\Work', maxConcurrent: 2, keepDays: 90, writeGuard: false }).ok, true);
    const v = t.fake.state();
    assert.deepEqual([v.model, v.workDir, v.maxConcurrent, v.keepDays, v.writeGuard], ['claude-haiku-5-5', 'C:\\Work', 2, 90, false]);
  } finally {
    t.cleanup();
  }
});

test('the list layout is kept for next time, within its limits, and nothing else rides along', async () => {
  const t = setup();
  try {
    assert.deepEqual((await t.call('state')).layout, { sideWidth: 180, sideCollapsed: false, default: 180, min: 140, max: 360 });
    assert.deepEqual(t.call('setLayout', { sideWidth: 260 }), { sideWidth: 260, sideCollapsed: false });
    assert.deepEqual(t.call('setLayout', { sideWidth: 5000, sideCollapsed: true }), { sideWidth: 360, sideCollapsed: true });
    assert.deepEqual(t.call('setLayout', { sideWidth: 'wide', sideCollapsed: 'no', model: 'x', mode: 'bypassPermissions' }), { sideWidth: 360, sideCollapsed: true });
    assert.equal(t.fake.state().mode, 'auto');
    assert.deepEqual(t.call('setLayout', null), { sideWidth: 360, sideCollapsed: true });
    assert.equal((await t.call('state')).layout.sideWidth, 360);
  } finally {
    t.cleanup();
  }
});

test('a link from an answer opens only as http or https, only after a real click, and in full', () => {
  const t = setup();
  try {
    assert.equal(t.call('openUrl', { url: 'https://example.com/a b', trusted: true }), true);
    assert.deepEqual(t.fake.opened, ['https://example.com/a%20b']);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/Windows', 'ftp://x.example', 'ms-settings:', 'not a url', `https://e.example/${'a'.repeat(3000)}`]) {
      assert.equal(t.call('openUrl', { url, trusted: true }), false, url.slice(0, 30));
    }
    for (const trusted of [undefined, false, 'true']) assert.equal(t.call('openUrl', { url: 'https://example.com', trusted }), false);
    assert.equal(t.call('openUrl', null), false);
    assert.equal(t.fake.opened.length, 1);
  } finally {
    t.cleanup();
  }
});
