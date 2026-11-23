// The budget band's numbers and server errors (#129, design 10, 14.3): always estimates, with a fake `claude`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBudget, costOfUsage, deltaOfReport, periodStart } = require('../lib/budget');
const { classifyApiError } = require('../lib/key');
const { money, aboutMoney } = require('../lib/money');
const { ready, sleep } = require('./setup');

const local = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

test('the period starts on the set day, across a new year', () => {
  assert.equal(periodStart(local(2026, 11, 7), 1), '2026-11-01');
  assert.equal(periodStart(local(2026, 11, 7), 15), '2026-10-15');
  assert.equal(periodStart(local(2026, 1, 3), 15), '2025-12-15');
  assert.equal(periodStart(local(2026, 11, 15), 15), '2026-11-15');
});

test('a reported total counts what came before: only the difference is added', () => {
  assert.equal(deltaOfReport(undefined, 0.5), 0.5);
  assert.ok(Math.abs(deltaOfReport(0.5, 0.7) - 0.2) < 1e-9);
  assert.equal(deltaOfReport(0.7, 0.7), 0);
  assert.equal(deltaOfReport(0.7, 0.1), 0.1, 'a smaller total is a fresh count, not a refund');
});

test('usage is priced per model, with cache and the long-prompt rate, and unknown models say so', () => {
  const usage = { input_tokens: 1000000, cache_creation_input_tokens: 1000000, cache_read_input_tokens: 1000000, output_tokens: 1000000 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(costOfUsage('claude-opus-5-5', usage), 4 + 5 + 0.2 + 20);
  near(costOfUsage('claude-sonnet-5-5', usage), 2 + 2.5 + 0.1 + 10);
  near(costOfUsage('claude-haiku-5-5', usage), 5 * (0.1 + 0.125 + 0.01 + 0.5));
  near(costOfUsage('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 1000 }), (1000 * 0.1 + 1000 * 0.5) / 1e6);
  near(costOfUsage('claude-opus-5-5', { cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 400000 } }), 0.6 * 5 + 0.4 * 8);
  assert.equal(costOfUsage('some-other-model', usage), null);
  near(costOfUsage('claude-opus-5-5', { input_tokens: 'x', output_tokens: -5 }), 0);
});

test('the budget file: level, 80% once, a new period starts over, a broken file is no crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-budget-'));
  try {
    let at = local(2026, 11, 7);
    const file = path.join(dir, 'budget.json');
    const settings = { monthlyBudgetUsd: 10, resetDay: 1 };
    const b = createBudget({ file, settings: () => settings, now: () => at });
    assert.deepEqual([b.view().hasData, b.view().spentUsd, b.view().level, b.view().remainingUsd], [false, 0, 'ok', 10]);
    assert.equal(b.add(1), false);
    assert.equal(b.view().hasData, true);
    assert.equal(b.add(7), true, 'crossing 80% says so');
    assert.equal(b.view().level, 'warn');
    assert.equal(b.add(0.5), false, 'only once');
    assert.equal(b.add(1.5), false);
    assert.deepEqual([b.view().level, b.view().remainingUsd], ['over', 0]);
    b.add(5);
    assert.equal(b.view().remainingUsd, 0, 'never negative');
    settings.monthlyBudgetUsd = 100;
    assert.equal(b.view().level, 'ok', 'a larger budget lifts it');
    b.add(0, { partial: true });
    assert.equal(b.view().partial, true);
    at = local(2026, 12, 1);
    assert.deepEqual([b.view().spentUsd, b.view().partial, b.view().hasData], [0, false, false]);
    fs.writeFileSync(file, 'not json');
    assert.equal(b.view().spentUsd, 0);
    b.add(-3);
    assert.equal(b.view().spentUsd, 0);
    b.add(NaN);
    assert.equal(b.view().spentUsd, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- through a run ----

const spent = async (t) => (await t.call('state')).budget;

test('a resumed session adds only the difference; another session adds its own', async () => {
  const t = ready({ strictResume: true, cost: 0.5 });
  try {
    const a = t.send('a');
    await t.doneOf(a.sessionId);
    assert.ok(Math.abs((await spent(t)).spentUsd - 0.5) < 1e-9);
    t.ws.setBehavior({ strictResume: true, cost: 0.75 });
    t.send('a2', a.sessionId);
    await t.doneOf(a.sessionId, 2);
    assert.ok(Math.abs((await spent(t)).spentUsd - 0.75) < 1e-9, 'not 1.25');
    t.ws.setBehavior({ strictResume: true, cost: 0.25 });
    const b = t.send('b');
    await t.doneOf(b.sessionId);
    const after = await spent(t);
    assert.ok(Math.abs(after.spentUsd - 1) < 1e-9);
    assert.ok(Math.abs(t.call('open', a.sessionId).session.estUsd - 0.75) < 1e-9);
    assert.ok(t.call('open', a.sessionId).items.some((i) => /이번 실행 약 \$0\.25 \(추정\)/.test(i.text || '')));
  } finally {
    t.cleanup();
  }
});

test('a stopped run is estimated from usage, each message once', async () => {
  const usage = { input_tokens: 100000, output_tokens: 10000 };
  const t = ready({ usageThenHang: [
    { id: 'm1', content: [{ type: 'text', text: 'a' }], usage },
    { id: 'm1', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }], usage },
    { id: 'm2', content: [{ type: 'text', text: 'b' }], usage },
  ] });
  try {
    const { sessionId } = t.send('x');
    await t.until(() => t.runs(sessionId).filter((e) => e.type === 'text').length === 2, 'the messages');
    t.call('stop', sessionId);
    await t.doneOf(sessionId);
    const b = await spent(t);
    assert.ok(Math.abs(b.spentUsd - 2 * (100000 * 4 + 10000 * 20) / 1e6) < 1e-9, String(b.spentUsd));
    assert.equal(b.partial, false);
  } finally {
    t.cleanup();
  }
});

test('stopped before any usage came: says part of it is not counted, and draws no number from nothing', async () => {
  const t = ready({ hangAfterInit: true });
  try {
    const { sessionId } = t.send('x');
    await t.until(() => t.ws.calls().length, 'the run');
    t.call('stop', sessionId);
    await t.doneOf(sessionId);
    const b = await spent(t);
    assert.deepEqual([b.spentUsd, b.partial], [0, true]);
  } finally {
    t.cleanup();
  }
});

test('the task cap reaches --max-budget-usd, and hitting it is explained', async () => {
  const t = ready({ resultSubtype: 'error_max_budget_usd', cost: 1.5 }, { initial: { taskCapUsd: 1.5 } });
  try {
    const { sessionId } = t.send('x');
    const done = await t.doneOf(sessionId);
    const a = t.ws.calls()[0].args;
    assert.equal(a[a.indexOf('--max-budget-usd') + 1], '1.5');
    assert.deepEqual([done.error.kind, done.error.retryable], ['task-cap', false]);
    assert.equal((await spent(t)).spentUsd, 1.5, 'what it cost still counts');
  } finally {
    t.cleanup();
  }
});

test('80% is noted once, and at 100% nothing new starts, queued work included, until the budget changes', async () => {
  const t = ready({ cost: 16 }, { initial: { monthlyBudgetUsd: 20 } });
  try {
    const a = t.send('a');
    await t.doneOf(a.sessionId);
    assert.equal((await spent(t)).level, 'warn');
    assert.ok(t.call('open', a.sessionId).items.some((i) => /80%/.test(i.text || '')));
    assert.ok(t.win.sent.some(([n, b]) => n === 'budget' && b.level === 'warn'));
    t.ws.setBehavior({ cost: 21, waitForFile: 'go.txt' });
    const b = t.send('b');
    const c = t.send('c');
    assert.equal(c.queued, true);
    await t.until(() => t.ws.calls().length === 2, 'the second run');
    fs.writeFileSync(path.join(t.ws.dir, 'go.txt'), 'x');
    await t.doneOf(b.sessionId);
    const done = await t.doneOf(c.sessionId);
    assert.equal(done.error.kind, 'budget', 'the waiting one did not start');
    assert.equal(t.ws.calls().length, 2);
    const refused = t.send('d');
    assert.deepEqual([refused.ok, refused.code], [false, 'budget']);
    assert.match(refused.message, /예산/);
    assert.equal(t.call('list').sessions.length, 3, 'no session was made');
    t.widget.settings.save({ model: 'claude-haiku-5-5', monthlyBudgetUsd: 100 });
    assert.equal(t.send('e').ok, true);
  } finally {
    t.cleanup();
  }
});

test('nothing here depends on rate_limit_event: shown if it comes, fine if it does not', async () => {
  const none = ready();
  try {
    const { sessionId } = none.send('x');
    assert.equal((await none.doneOf(sessionId)).ok, true);
    assert.ok(!none.runs().some((e) => e.type === 'rateLimit'));
  } finally {
    none.cleanup();
  }
  const some = ready({ rateLimit: { status: 'allowed_warning', resetsAt: 123, utilization: 0.9 } });
  try {
    const { sessionId } = some.send('x');
    assert.equal((await some.doneOf(sessionId)).ok, true);
    assert.deepEqual(some.runs().filter((e) => e.type === 'rateLimit').map((e) => [e.status, e.resetsAt]), [['allowed_warning', 123]]);
  } finally {
    some.cleanup();
  }
});

// ---- server errors ----

test('every known error says what to do and whether trying again can help', () => {
  const cases = [
    ['This API key is not scoped to a workspace', 'workspace-scope', false, 'keys'],
    ['401 invalid x-api-key', 'authentication', false, 'keys'],
    ['403 permission_error', 'permission', false, 'keys'],
    ['Your credit balance is too low', 'credit', false, 'billing'],
    ['billing_error', 'credit', false, 'billing'],
    ['400 You have reached your specified workspace limit', 'spend-limit', false, 'workspaces'],
    ['429 enforced_spend_limit_reached', 'spend-limit', false, 'workspaces'],
    ['unsupported_country_region_territory', 'region', false, undefined],
    ['404 not_found_error model: x', 'model', false, undefined],
    ['prompt is too long: 300000 tokens', 'too-long', false, undefined],
    ['429 rate_limit_error', 'rate-limit', true, undefined],
    ['529 overloaded_error', 'overloaded', true, undefined],
    ['500 api_error', 'overloaded', true, undefined],
  ];
  for (const [text, kind, retryable, link] of cases) {
    const got = classifyApiError(text);
    assert.deepEqual([got?.kind, got?.retryable, got?.link], [kind, retryable, link], text);
    assert.ok(got.message.length > 5);
  }
});

test('a failed run is never sent again by itself', async () => {
  for (const text of ['API Error: 429 rate_limit_error', 'API Error: 529 overloaded_error', 'Your credit balance is too low']) {
    const t = ready({ resultError: text });
    try {
      const { sessionId } = t.send('x');
      await t.doneOf(sessionId);
      await sleep(150);
      assert.equal(t.ws.calls().length, 1, text);
    } finally {
      t.cleanup();
    }
  }
});

test('api_retry is shown as it happens; billing_error stops the run at once with a way to Billing', async () => {
  const shown = ready({ apiRetries: [{ attempt: 1, error: 'server_error', status: 529 }, { attempt: 2, error: 'server_error', status: 529 }] });
  try {
    const { sessionId } = shown.send('x');
    assert.equal((await shown.doneOf(sessionId)).ok, true);
    assert.deepEqual(shown.runs(sessionId).filter((e) => e.type === 'apiRetry').map((e) => [e.attempt, e.maxRetries, e.error]), [[1, 10, 'server_error'], [2, 10, 'server_error']]);
    assert.equal(shown.call('open', sessionId).items.filter((i) => /다시 시도합니다/.test(i.text || '')).length, 1, 'the record notes it once');
  } finally {
    shown.cleanup();
  }
  const billing = ready({ apiRetries: [{ error: 'billing_error', status: 400 }], hangAfterInit: true });
  try {
    const { sessionId } = billing.send('x');
    const done = await billing.doneOf(sessionId);
    assert.deepEqual([done.ok, done.error.kind, done.error.link], [false, 'credit', 'billing']);
  } finally {
    billing.cleanup();
  }
});

test('a managed policy\'s own words are shown', async () => {
  const t = ready({ resultError: 'Blocked: forceLoginMethod is set by your administrator' });
  try {
    const { sessionId } = t.send('x');
    const done = await t.doneOf(sessionId);
    assert.equal(done.error.kind, 'policy');
    assert.match(done.error.message, /forceLoginMethod/);
  } finally {
    t.cleanup();
  }
});

test('amounts on screen: two decimals at most, under a cent says so, the sum itself stays exact', () => {
  assert.deepEqual([0, 0.0012, 0.00999, 0.01, 0.0901, 1.005, 17, 20.5, -1, NaN].map(money), ['$0.00', '$0.01 미만', '$0.01 미만', '$0.01', '$0.09', '$1.00', '$17.00', '$20.50', '$0.00', '$0.00']);
  assert.deepEqual([0, 0.004, 0.25].map(aboutMoney), ['$0.00', '$0.01 미만', '약 $0.25']);
  const chat = fs.readFileSync(path.join(__dirname, '..', 'chat', 'chat.js'), 'utf8');
  assert.doesNotMatch(chat, /toFixed([3-9])/, 'the window never shows more than two decimals');
});
