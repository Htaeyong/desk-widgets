// Dooray originals (#129 with #131): the Dooray widget asks on its own Desk Widgets card (decision C), so there is one card; the
// chat says where to look while it waits, and a fetched file comes in as an attachment marked "두레이에서 받음" (or "받지 않음").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FETCH_TOOL } = require('../lib/cards');
const { systemNote } = require('../lib/recipe-prompts');
const { ATTACH_DIR } = require('../lib/attachments');
const { ready } = require('./setup');

const FETCH_ID = '9f2c4e1a0b3d5e67';
const PDF = '%PDF-1.4 proposal';

function withFetched() {
  const fetchedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-fetched-'));
  const folder = path.join(fetchedDir, FETCH_ID);
  fs.mkdirSync(folder);
  const file = path.join(folder, '제안서 v2.pdf');
  fs.writeFileSync(file, PDF);
  const t = ready({}, { deps: { fetchedDir, widgetTools: () => ({ state: 'on', tools: ['dooray_fetch_file', 'dooray_fetch_file_status'] }) } });
  const cleanup = t.cleanup;
  t.cleanup = () => {
    cleanup();
    fs.rmSync(fetchedDir, { recursive: true, force: true });
  };
  return { t, fetchedDir, file };
}

/** Claude Code's stream for one tool call and its result. */
const callAndResult = (name, result, id = 'tu_f1') => [
  JSON.stringify({ type: 'assistant', session_id: 's', message: { id: 'm1', content: [{ type: 'tool_use', id, name, input: { drive_id: 'd1', file_id: 'f1' } }] } }),
  JSON.stringify({ type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(result) }] }] } }),
];
const done = (file) => ({ status: 'done', fetch_id: FETCH_ID, path: file, name: path.basename(file), size: PDF.length, mime: 'application/pdf', source: 'dooray', kind: 'drive', untrusted: '...', note: '...' });

test('one card only: the Dooray widget asks on its own card, so Claude Code runs both fetch tools without the widget\'s card', async () => {
  const { t, file } = withFetched();
  try {
    t.ws.setBehavior({ rawLines: [
      ...callAndResult(FETCH_TOOL, { status: 'waiting_approval', fetch_id: FETCH_ID, name: '제안서 v2.pdf', size: 183204, note: '...' }, 'a'),
      ...callAndResult(`${FETCH_TOOL}_status`, { status: 'downloading', fetch_id: FETCH_ID, name: '제안서 v2.pdf', received: 1000, size: 183204 }, 'b'),
      ...callAndResult(`${FETCH_TOOL}_status`, done(file), 'c'),
    ] });
    const { sessionId } = t.send('제안서 원본으로 요약해 줘');
    await t.doneOf(sessionId);
    const args = t.ws.calls()[0].args;
    assert.deepEqual(args[args.indexOf('--allowedTools') + 1].split(',').filter((x) => x.includes('dooray')), [FETCH_TOOL, `${FETCH_TOOL}_status`]);
    assert.ok(!t.win.sent.some(([n, cards]) => n === 'cards' && cards.length), 'the widget raised no card of its own');
    assert.ok(!(await t.call('open', sessionId)).items.some((i) => i.k === 'card'));
    // The chat says where to look while it waits, then what is going on, then clears it.
    const states = t.runs(sessionId).filter((e) => e.type === 'fetchState').map((e) => [e.state, e.name || '']);
    assert.deepEqual(states, [['asking', ''], ['asking', '제안서 v2.pdf'], ['downloading', '제안서 v2.pdf'], ['clear', '']]);
    assert.ok(t.runs(sessionId).some((e) => e.type === 'fetched' && e.name === '제안서 v2.pdf' && !e.declined));
  } finally {
    t.cleanup();
  }
});

test('declined on the Dooray card: "받지 않음" in the chat and the record, and nothing copied', async () => {
  const { t } = withFetched();
  try {
    t.ws.setBehavior({ rawLines: [
      ...callAndResult(FETCH_TOOL, { status: 'declined', fetch_id: FETCH_ID, name: '제안서 v2.pdf', reason: 'timeout', note: '...' }, 'a'),
      ...callAndResult(FETCH_TOOL, { status: 'declined', fetch_id: FETCH_ID, name: '다른 파일.pdf', reason: 'made-up', note: '...' }, 'b'),
    ] });
    const { sessionId } = t.send('x');
    await t.doneOf(sessionId);
    const items = (await t.call('open', sessionId)).items.filter((i) => i.k === 'fetched');
    assert.deepEqual(items.map((i) => [i.name, i.declined, i.reason]), [['제안서 v2.pdf', true, 'timeout'], ['다른 파일.pdf', true, 'rejected']]);
    assert.ok(!fs.existsSync(path.join(t.ws.cwd, ATTACH_DIR, sessionId)));
  } finally {
    t.cleanup();
  }
});

test('a fetched original is copied into the conversation and shown as "두레이에서 받음"; the tool text never reaches the window', async () => {
  const { t, file } = withFetched();
  try {
    t.ws.setBehavior({ rawLines: callAndResult(FETCH_TOOL, done(file)), copySystemNote: path.join(t.ws.dir, 'note.md') });
    const { sessionId } = t.send('제안서 원본을 받아서 요약해 줘');
    await t.doneOf(sessionId);
    const copy = path.join(t.ws.cwd, ATTACH_DIR, sessionId, 'dooray', FETCH_ID, '제안서 v2.pdf');
    assert.equal(fs.readFileSync(copy, 'utf8'), PDF);
    const item = (await t.call('open', sessionId)).items.find((i) => i.k === 'fetched');
    assert.deepEqual(item && { name: item.name, size: item.size, kind: item.kind, source: item.source }, { name: '제안서 v2.pdf', size: PDF.length, kind: 'file', source: 'dooray' });
    assert.ok(t.runs(sessionId).some((e) => e.type === 'fetched' && e.name === '제안서 v2.pdf'));
    assert.ok(!t.runs(sessionId).some((e) => e.type === 'toolResult'));
    // The instructions say where the copy is, so Claude reads it inside the work folder.
    const note = fs.readFileSync(path.join(t.ws.dir, 'note.md'), 'utf8');
    assert.ok(note.includes(path.join(t.ws.cwd, ATTACH_DIR, sessionId, 'dooray')), note);
    // Deleting the conversation deletes the copy.
    assert.equal(t.call('remove', sessionId).ok, true);
    assert.ok(!fs.existsSync(copy));
  } finally {
    t.cleanup();
  }
});

test('only from the Dooray widget\'s folder, only a finished fetch, only from the fetch tools', async () => {
  const { t, fetchedDir } = withFetched();
  try {
    const elsewhere = path.join(t.ws.dir, 'secret.txt');
    fs.writeFileSync(elsewhere, 'not for the chat');
    const sneaky = path.join(fetchedDir, FETCH_ID, '..', '..', 'secret.txt');
    t.ws.setBehavior({ rawLines: [
      ...callAndResult(FETCH_TOOL, done(elsewhere), 'a'),
      ...callAndResult(FETCH_TOOL, done(sneaky), 'b'),
      ...callAndResult(FETCH_TOOL, { ...done(path.join(fetchedDir, FETCH_ID, '제안서 v2.pdf')), status: 'downloading' }, 'c'),
      ...callAndResult('mcp__desk-widgets__dooray_list_tasks', done(path.join(fetchedDir, FETCH_ID, '제안서 v2.pdf')), 'd'),
      ...callAndResult(FETCH_TOOL, { ...done(path.join(fetchedDir, FETCH_ID, '제안서 v2.pdf')), fetch_id: '../../x' }, 'e'),
    ] });
    const { sessionId } = t.send('x');
    await t.doneOf(sessionId);
    assert.ok(!fs.existsSync(path.join(t.ws.cwd, ATTACH_DIR, sessionId)), 'nothing was copied');
    assert.ok(!(await t.call('open', sessionId)).items.some((i) => i.k === 'fetched'));
    // The status tool's "done" counts as well.
    t.ws.setBehavior({ rawLines: callAndResult(`${FETCH_TOOL}_status`, done(path.join(fetchedDir, FETCH_ID, '제안서 v2.pdf')), 's1') });
    t.send('확인', sessionId);
    await t.doneOf(sessionId, 2);
    assert.ok(fs.existsSync(path.join(t.ws.cwd, ATTACH_DIR, sessionId, 'dooray', FETCH_ID, '제안서 v2.pdf')));
  } finally {
    t.cleanup();
  }
});

test('the instructions name the folder only when the fetch tool is there', () => {
  assert.match(systemNote([], { state: 'on', tools: ['dooray_fetch_file'] }, { fetchFolder: 'C:\\w\\AI Widgets 첨부\\s\\dooray' }), /copies the file into this conversation's attachment folder as C:\\w\\AI Widgets 첨부\\s\\dooray\\<fetch_id>\\<name>/);
  assert.doesNotMatch(systemNote([], { state: 'on', tools: ['dooray_list_tasks'] }, { fetchFolder: 'C:\\w' }), /attachment folder/);
});
