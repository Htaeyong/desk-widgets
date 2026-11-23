// Cancel and correct while a task runs (#129): 중지 keeps what came so far; a correction stops the step and goes on with
// `--resume`; a prompt can also wait for the end; a card that is up is refused either way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ready, sleep } = require('./setup');

const usage = { input_tokens: 10, output_tokens: 5 };
const HALF = [{ id: 'm1', content: [{ type: 'text', text: '절반까지 한 결과' }], usage }];
const items = async (t, id) => (await t.call('open', id)).items;

test('중지: the run ends as stopped, and what came before stays in the conversation', async () => {
  const t = ready({ usageThenHang: HALF });
  try {
    const { sessionId } = t.send('긴 작업');
    await t.until(() => t.runs(sessionId).some((e) => e.type === 'text'), 'the first text');
    assert.equal(t.call('stop', sessionId), true);
    const done = await t.doneOf(sessionId);
    assert.equal(done.stopped, true);
    const log = await items(t, sessionId);
    assert.ok(log.some((i) => i.k === 'ai' && i.text === '절반까지 한 결과'));
    assert.match(log.find((i) => i.k === 'stopped').text, /지금까지의 결과는 위에 남아 있습니다/);
    assert.equal(t.call('list').sessions.find((s) => s.id === sessionId).state, 'stopped');
  } finally {
    t.cleanup();
  }
});

test('while it works a prompt is refused until the user picks how to send it', async () => {
  const t = ready({ hangAfterInit: true });
  try {
    const { sessionId } = t.send('작업');
    await t.until(() => t.ws.calls().length, 'the run');
    const res = t.send('아니, 다르게');
    assert.equal(t.call('send', { sessionId, prompt: '아니, 다르게' }).code, 'same-session');
    assert.ok(res.ok, 'a new conversation is not blocked');
    t.call('stop', sessionId);
    await t.doneOf(sessionId);
  } finally {
    t.cleanup();
  }
});

test('정정으로 보내기: the step stops, and the same Claude Code session goes on with the correction at once', async () => {
  const t = ready({ usageThenHang: HALF, strictResume: true });
  try {
    const { sessionId } = t.send('보고서를 A 형식으로 써 줘');
    await t.until(() => t.runs(sessionId).some((e) => e.type === 'text'), 'the first text');
    t.ws.setBehavior({ strictResume: true });
    const res = t.call('send', { sessionId, prompt: '아니, B 형식으로 해 줘', when: 'correct' });
    assert.equal(res.ok, true);
    assert.equal(res.corrected, true);
    const second = await t.doneOf(sessionId, 2);
    assert.equal(second.ok, true);
    const [first, next] = t.ws.calls();
    assert.ok(!first.args.includes('--resume'));
    assert.equal(next.args[next.args.indexOf('--resume') + 1], t.call('list').sessions.find((s) => s.id === sessionId).runnerSessionId);
    assert.match(next.prompt, /^The user interrupted your previous step to correct the request\./);
    assert.match(next.prompt, /아니, B 형식으로 해 줘$/);
    const log = await items(t, sessionId);
    const kinds = log.map((i) => i.k);
    assert.ok(log.some((i) => i.k === 'ai' && i.text === '절반까지 한 결과'), 'the result so far stays');
    assert.ok(log.some((i) => i.k === 'stopped' && /정정을 반영하려고/.test(i.text)));
    assert.ok(kinds.lastIndexOf('you') > kinds.indexOf('stopped') || log.filter((i) => i.k === 'you').length === 2);
    assert.equal(t.call('list').sessions.find((s) => s.id === sessionId).state, 'idle');
  } finally {
    t.cleanup();
  }
});

test('a correction before Claude Code began carries the first request along', async () => {
  const t = ready({ hangBeforeInit: true });
  try {
    const { sessionId } = t.send('표를 만들어 줘');
    await t.until(() => t.ws.calls().length === 1, 'the run');
    t.ws.setBehavior({});
    t.call('send', { sessionId, prompt: '아니, 그래프로', when: 'correct' });
    await t.doneOf(sessionId, 2);
    const last = t.ws.calls()[1];
    assert.ok(!last.args.includes('--resume'), 'there is nothing to resume yet');
    assert.equal(last.prompt, 'The user corrected this request before work began:\n표를 만들어 줘\n\nThe correction, which takes priority:\n아니, 그래프로');
  } finally {
    t.cleanup();
  }
});

test('a card that is up when the user corrects or stops is refused, and says why', async () => {
  const t = ready();
  try {
    const file = path.join(t.ws.cwd, 'x.txt');
    t.ws.setBehavior({ mcpFlow: [{ tool: 'approve', args: { tool_name: 'Write', input: { file_path: file, content: 'no' }, tool_use_id: 'tu' } }], usageThenHang: HALF });
    const { sessionId } = t.send('파일을 써 줘');
    await t.until(() => t.call('list').sessions.some((s) => s.waiting), 'the card');
    t.ws.setBehavior({});
    t.call('send', { sessionId, prompt: '쓰지 말고 보여만 줘', when: 'correct' });
    await t.doneOf(sessionId, 2);
    assert.ok(!fs.existsSync(file), 'nothing was approved');
    const log = await items(t, sessionId);
    assert.ok(log.some((i) => i.k === 'card' && /정정으로 거부$/.test(i.text)));
    assert.deepEqual(t.call('list').sessions.filter((s) => s.waiting), []);

    t.ws.setBehavior({ mcpFlow: [{ tool: 'ask_user', args: { question: '어디에?' } }], usageThenHang: HALF });
    t.call('send', { sessionId, prompt: '다시' });
    await t.until(() => t.call('list').sessions.some((s) => s.waiting), 'the question');
    t.call('stop', sessionId);
    await t.doneOf(sessionId, 3);
    assert.ok((await items(t, sessionId)).some((i) => i.k === 'card' && /중지로 거부$/.test(i.text)));
  } finally {
    t.cleanup();
  }
});

test('끝난 뒤 보내기: waits behind the running step of the same conversation, then runs', async () => {
  const t = ready({ usageThenHang: HALF });
  try {
    const { sessionId } = t.send('첫 작업');
    await t.until(() => t.runs(sessionId).some((e) => e.type === 'text'), 'the first text');
    t.ws.setBehavior({});
    const res = t.call('send', { sessionId, prompt: '끝나면 이것도', when: 'after' });
    assert.equal(res.ok, true);
    assert.equal(res.queued, true);
    await sleep(300);
    assert.equal(t.ws.calls().length, 1, 'not a second run of the same conversation at once');
    assert.deepEqual(t.call('list').queue, [sessionId]);
    t.call('stop', sessionId);
    const second = await t.doneOf(sessionId, 2);
    assert.equal(second.ok, true);
    assert.match(t.ws.calls()[1].prompt, /^끝나면 이것도/);
  } finally {
    t.cleanup();
  }
});
