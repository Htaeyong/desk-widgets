// "원본 받기" (#131 follow-up): fetch_file saves a Dooray original under <dataDir>\fetched and answers with its path.
// Fake responses only; nothing here reaches the real Dooray API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileFetcher, cleanName, targetOf, approvalCard, expiredCard, clientLabel } = require('../backend/fetch-file');
const { createClient } = require('../backend/dooray');

const TOKEN = 'SECRET-TOKEN-do-not-leak-9f8e7d';
const ok = (result) => ({ header: { isSuccessful: true }, result });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dooray-fetch-'));

/** A response whose body arrives in chunks, optionally slowly or never ending. */
function bodyResponse(chunks, { headers = {}, delayMs = 0 } = {}) {
  const stream = new ReadableStream({
    async pull(controller) {
      if (!chunks.length) return controller.close();
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(new Uint8Array(chunks.shift()));
    },
  });
  return new Response(stream, { status: 200, headers });
}

function fakeClient({ meta = {}, files = [], body = () => bodyResponse([Buffer.from('hello')]) } = {}) {
  const calls = [];
  return {
    calls,
    async request(pathname, query = {}) {
      calls.push({ pathname, query });
      if (pathname.startsWith('/drive/')) return ok({ name: 'a.pdf', size: 5, mimeType: 'application/pdf', type: 'file', ...meta });
      if (pathname.startsWith('/wiki/')) return ok({ files, images: [] });
      throw Object.assign(new Error('nf'), { status: 404 });
    },
    async openFile(pathname, query = {}) {
      calls.push({ pathname, query, open: true });
      return body(pathname);
    },
  };
}

const fetcherWith = (client, opts = {}) => {
  const dir = tmp();
  // Approved at once unless a test says otherwise.
  return { dir, f: new FileFetcher({ dir, client: () => client, approve: async () => 'accept', ...opts }) };
};

test('cleanName: no path or reserved characters, no device names, length limit keeps the extension', () => {
  assert.equal(cleanName('..\\..\\Windows\\evil.exe'), '_.._Windows_evil.exe');
  assert.equal(cleanName('a/b:c*d?"e<f>g|h.txt'), 'a_b_c_d__e_f_g_h.txt');
  assert.equal(cleanName('CON.txt'), '_CON.txt');
  assert.equal(cleanName('nul'), '_nul');
  assert.equal(cleanName('  .hidden. '), 'hidden');
  assert.equal(cleanName(''), 'file');
  assert.equal(cleanName('줄\n바꿈\u0007.md'), '줄_바꿈_.md');
  const long = cleanName(`${'가'.repeat(300)}.pdf`);
  assert.ok(long.endsWith('.pdf') && [...long].length === 120);
  for (const s of ['../x', 'a\\b', 'C:\\x']) assert.ok(!/[\\/:]/.test(cleanName(s)), s);
});

test('targetOf: a drive file or a wiki attachment, checked ids', () => {
  assert.deepEqual(targetOf({ drive_id: 'd1', file_id: 'f1' }), { kind: 'drive', driveId: 'd1', fileId: 'f1' });
  assert.deepEqual(targetOf({ wiki_id: 'w', page_id: 'p', file_id: 'f' }), { kind: 'wiki', wikiId: 'w', pageId: 'p', fileId: 'f' });
  assert.throws(() => targetOf({ file_id: 'f' }), /drive_id/);
  assert.throws(() => targetOf({ drive_id: 'd', wiki_id: 'w', file_id: 'f' }), /하나만/);
  assert.throws(() => targetOf({ drive_id: '../d', file_id: 'f' }), /올바르지 않습니다/);
  assert.throws(() => targetOf({ wiki_id: 'w', file_id: 'f' }), /page_id/);
});

test('a drive file is saved under fetched\\<id>\\<name>; the result has the path and no content', async () => {
  const client = fakeClient({ meta: { name: '제안서 v2.pdf', size: 5 }, body: () => bodyResponse([Buffer.from('%PDF-')], { headers: { 'content-type': 'application/pdf' } }) });
  const { dir, f } = fetcherWith(client);
  const r = await f.fetch({ drive_id: 'd1', file_id: 'f1' });
  assert.equal(r.status, 'done');
  assert.equal(path.dirname(path.dirname(r.path)), dir);
  assert.match(path.basename(path.dirname(r.path)), /^[a-f0-9]{16}$/);
  assert.equal(path.basename(r.path), '제안서 v2.pdf');
  assert.equal(fs.readFileSync(r.path, 'latin1'), '%PDF-');
  assert.deepEqual(
    { name: r.name, size: r.size, mime: r.mime, source: r.source, kind: r.kind },
    { name: '제안서 v2.pdf', size: 5, mime: 'application/pdf', source: 'dooray', kind: 'drive' },
  );
  assert.ok(r.untrusted && r.note);
  assert.ok(!('text' in r) && !('content' in r) && !('bytes' in r));
  assert.deepEqual(client.calls.map((c) => c.query.media), ['meta', 'raw']);
  assert.ok(!fs.readdirSync(path.dirname(r.path)).some((n) => n.endsWith('.part')));
});

test('a wiki attachment (or image) of that page only', async () => {
  const client = fakeClient({ files: [{ id: 'a1', name: 'spec.docx', size: 5 }] });
  const { f } = fetcherWith(client);
  const r = await f.fetch({ wiki_id: 'w1', page_id: 'p1', file_id: 'a1' });
  assert.equal(r.kind, 'wiki');
  assert.equal(client.calls[1].pathname, '/wiki/v1/wikis/w1/pages/p1/files/a1');
  await assert.rejects(f.fetch({ wiki_id: 'w1', page_id: 'p1', file_id: 'zz' }), /첨부 파일이 없습니다/);
});

test('20 MB: refused by the metadata before downloading, by Content-Length, and while streaming (file removed)', async () => {
  const big = fakeClient({ meta: { size: 21 * 1024 * 1024 } });
  await assert.rejects(fetcherWith(big).f.fetch({ drive_id: 'd', file_id: 'f' }), /20MB/);
  assert.ok(!big.calls.some((c) => c.open), 'no download started');

  const declared = fakeClient({ meta: { size: 0 }, body: () => bodyResponse([Buffer.alloc(10)], { headers: { 'content-length': String(30) } }) });
  const a = fetcherWith(declared, { maxBytes: 20 });
  await assert.rejects(a.f.fetch({ drive_id: 'd', file_id: 'f' }), /너무 큽니다/);
  assert.deepEqual(fs.readdirSync(a.dir), []);

  const streamed = fakeClient({ meta: { size: 0 }, body: () => bodyResponse([Buffer.alloc(15), Buffer.alloc(15)]) });
  const b = fetcherWith(streamed, { maxBytes: 20 });
  await assert.rejects(b.f.fetch({ drive_id: 'd', file_id: 'f' }), /너무 큽니다/);
  assert.deepEqual(fs.readdirSync(b.dir), [], 'the partial download is deleted');
});

test('folders and failed downloads leave nothing behind', async () => {
  await assert.rejects(fetcherWith(fakeClient({ meta: { type: 'folder' } })).f.fetch({ drive_id: 'd', file_id: 'f' }), /폴더/);
  const failing = fakeClient({ body: () => { throw Object.assign(new Error('x'), { status: 403 }); } });
  const { dir, f } = fetcherWith(failing);
  await assert.rejects(f.fetch({ drive_id: 'd', file_id: 'f' }), (e) => e.status === 403);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a slow download answers "downloading" with a fetch_id, then fetch_file_status gives the result', async () => {
  const client = fakeClient({ meta: { name: 'slow.zip', size: 6 }, body: () => bodyResponse([Buffer.from('abc'), Buffer.from('def')], { delayMs: 60 }) });
  const { f } = fetcherWith(client, { waitMs: 20 });
  const first = await f.fetch({ drive_id: 'd', file_id: 'f' });
  assert.equal(first.status, 'downloading');
  assert.match(first.fetch_id, /^[a-f0-9]{16}$/);
  assert.equal(first.size, 6);
  f.waitMs = 2000;
  const done = await f.status({ fetch_id: first.fetch_id });
  assert.equal(done.status, 'done');
  assert.equal(fs.readFileSync(done.path, 'utf8'), 'abcdef');
  await assert.rejects(f.status({ fetch_id: '0'.repeat(16) }), /찾을 수 없습니다/);
  await assert.rejects(f.status({ fetch_id: '../x' }), /찾을 수 없습니다/);
});

test('cleanup removes downloads older than 24 hours, not newer ones or other folders', async () => {
  let now = Date.now();
  const { dir, f } = fetcherWith(fakeClient(), { now: () => now });
  const r = await f.fetch({ drive_id: 'd', file_id: 'f' });
  fs.mkdirSync(path.join(dir, 'keep-me'));
  assert.equal(f.cleanup(), 0);
  now += 24 * 60 * 60 * 1000 + 1000;
  assert.equal(f.cleanup(), 1);
  assert.equal(fs.existsSync(r.path), false);
  assert.ok(fs.existsSync(path.join(dir, 'keep-me')), 'only fetch folders');
  // start() cleans right away too
  const old = path.join(dir, 'abcdef0123456789');
  fs.mkdirSync(old);
  f.start();
  f.stop();
  assert.equal(fs.existsSync(old), false);
});

test('client openFile: GET, the token only to a Dooray host on redirect', async () => {
  const real = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return seen.length === 1
        ? new Response(null, { status: 307, headers: { location: 'https://evil.example.com/f' } })
        : new Response('x');
    };
    await assert.rejects(createClient({ token: TOKEN }).openFile('/drive/v1/drives/d/files/f', { media: 'raw' }), /unexpected host/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.method, 'GET');
  } finally {
    globalThis.fetch = real;
  }
});

// ---- approval: nothing is downloaded until the user clicks 받기 on a Desk Widgets card ----

/** An approve() the test answers by hand. */
function manualApproval() {
  const asked = [];
  return {
    asked,
    approve: (req) => new Promise((resolve) => asked.push({ req, resolve })),
  };
}

test('approval: the card names the client, the place, the file and its size; buttons 받기 / 거절', () => {
  const card = approvalCard({ id: 'abcdef0123456789', kind: 'drive', name: '회의자료.pdf', size: 3355443, client: 'claude-code' });
  assert.equal(card.type, 'card');
  assert.match(card.body, /^Claude Code\(AI 도우미\)가 두레이 드라이브의 「회의자료\.pdf」\(3\.2MB\)를 이 PC로 받으려 합니다/);
  assert.deepEqual(card.actions, [{ id: 'accept', label: '받기' }, { id: 'reject', label: '거절' }]);
  assert.equal(card.sticky, true);
  assert.equal(card.tag, 'dooray-fetch-abcdef0123456789');
  assert.equal(expiredCard({ id: 'abcdef0123456789', name: 'x' }).tag, card.tag, 'the expiry replaces the asking card');
  assert.match(approvalCard({ id: 'a', kind: 'wiki', name: 'n', size: 0, client: 'unknown' }).body, /^AI 도우미\(AI 도우미\)가 두레이 위키 첨부의 「n」를/);
  assert.equal(clientLabel('Claude Desktop'), 'Claude 데스크톱');
  assert.equal(clientLabel('claude-ai'), 'Claude 데스크톱');
  assert.equal(clientLabel('cursor'), 'cursor');
});

test('approval: waiting_approval first, nothing downloaded; 받기 then downloads and status gives the path', async () => {
  const m = manualApproval();
  const client = fakeClient();
  const { dir, f } = fetcherWith(client, { approve: m.approve, waitMs: 20 });
  const first = await f.fetch({ drive_id: 'd', file_id: 'f' }, { client: 'claude-code' });
  assert.equal(first.status, 'waiting_approval');
  assert.match(first.fetch_id, /^[a-f0-9]{16}$/);
  assert.ok(!client.calls.some((c) => c.open), 'no download before the click');
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual({ ...m.asked[0].req, id: undefined }, { id: undefined, kind: 'drive', name: 'a.pdf', size: 5, client: 'claude-code' });
  assert.equal((await f.status({ fetch_id: first.fetch_id })).status, 'waiting_approval');
  m.asked[0].resolve('accept');
  f.waitMs = 2000;
  const done = await f.status({ fetch_id: first.fetch_id });
  assert.equal(done.status, 'done');
  assert.equal(fs.readFileSync(done.path, 'utf8'), 'hello');
});

test('approval: 거절, closing the card and no answer in time are "declined" results, not errors, and download nothing', async () => {
  for (const answer of ['rejected', 'closed']) {
    const m = manualApproval();
    const client = fakeClient();
    const { dir, f } = fetcherWith(client, { approve: m.approve, waitMs: 2000 });
    const pending = f.fetch({ drive_id: 'd', file_id: 'f' });
    await new Promise((r) => setTimeout(r, 10));
    m.asked[0].resolve(answer);
    const r = await pending;
    assert.equal(r.status, 'declined');
    assert.equal(r.reason, answer);
    assert.match(r.note, /받지 않았습니다.*다시 요청하지 말고/);
    assert.ok(!client.calls.some((c) => c.open));
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  const expired = [];
  const client = fakeClient();
  const { f } = fetcherWith(client, { approve: () => new Promise(() => {}), expire: (req) => expired.push(req.id), approvalMs: 30, waitMs: 2000 });
  const r = await f.fetch({ drive_id: 'd', file_id: 'f' });
  assert.equal(r.status, 'declined');
  assert.equal(r.reason, 'timeout');
  assert.deepEqual(expired, [r.fetch_id], 'the asking card is replaced');
  assert.ok(!client.calls.some((c) => c.open));
  const late = await f.status({ fetch_id: r.fetch_id });
  assert.equal(late.status, 'declined', 'asking again gives the same answer');
});

test('approval: a failing approve is a no; at most three files wait or download at once', async () => {
  const { f } = fetcherWith(fakeClient(), { approve: async () => { throw new Error('no cards'); }, waitMs: 2000 });
  assert.equal((await f.fetch({ drive_id: 'd', file_id: 'f' })).reason, 'unavailable');
  const m = manualApproval();
  const many = fetcherWith(fakeClient(), { approve: m.approve, waitMs: 5 }).f;
  for (let i = 0; i < 3; i++) assert.equal((await many.fetch({ drive_id: 'd', file_id: 'f' })).status, 'waiting_approval');
  await assert.rejects(many.fetch({ drive_id: 'd', file_id: 'f' }), /많습니다/);
});

// ---- the widget: the file switch decides whether the tools are there; the card asks ----

function fakeCtx({ notify = true } = {}) {
  const dataDir = tmp();
  const registered = { tools: null };
  const cards = [];
  const ctx = {
    dir: path.join(__dirname, '..'),
    dataDir,
    flags: { mockData: true },
    app: { isPackaged: true, locale: () => 'ko' },
    createStore: (opts) => {
      let state = structuredClone(opts.defaults || {});
      return { load: () => (opts.sanitize ? opts.sanitize(state) : state), save: (patch) => (state = { ...state, ...patch }) };
    },
    handle() {},
    ...(notify ? { notify: (list, opts) => cards.push({ list, opts }) } : {}),
    sendToSettings() {},
    openExternal: async () => {},
    useThemes: () => ({
      open() {}, close() {}, focus() {}, desktopWindows: () => [], broadcast() {}, settingsHandlers: () => ({}),
      windows: { setOverviewPinned() {}, reloadAll() {} },
    }),
    mcp: { registerTools: (tools) => ((registered.tools = tools), true), userInteraction: true },
  };
  return { ctx, registered, cards };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const askingCards = (cards) => cards.filter((c) => c.list[0]?.type === 'card' && c.list[0].tag?.startsWith('dooray-fetch-'));

test('widget: fetch tools with the file switch, no requiresUserInteraction; the card decides (mock download)', async () => {
  const { create } = require('../index');
  const { ctx, registered, cards } = fakeCtx();
  const w = create(ctx);
  w.start();
  try {
    const names = () => registered.tools.map((t) => t.name);
    await w.settings.save({ aiLiveTools: true });
    assert.ok(!names().includes('fetch_file'), 'not without the file switch');
    await w.settings.save({ aiFileContent: true });
    assert.ok(names().includes('fetch_file') && names().includes('fetch_file_status'));
    assert.ok(registered.tools.every((t) => t.requiresUserInteraction === undefined), 'team lead decision C: no _meta flag');
    const tool = registered.tools.find((t) => t.name === 'fetch_file');
    const status = registered.tools.find((t) => t.name === 'fetch_file_status');

    // 받기
    const pending = tool.run({ drive_id: 'd1', file_id: 'f2' }, { client: 'claude-code', connection: 1 });
    await settle();
    const ask = askingCards(cards).at(-1);
    assert.match(ask.list[0].body, /Claude Code\(AI 도우미\)가 두레이 드라이브의 「제안서\.pdf」\(200KB\)/);
    ask.opts.onAction({}, 'accept');
    ask.opts.onClose({}); // the engine closes the card after the button: changes nothing
    let r = (await pending).data;
    if (r.status !== 'done') r = (await status.run({ fetch_id: r.fetch_id })).data;
    assert.equal(r.status, 'done');
    assert.ok(r.path.startsWith(path.join(ctx.dataDir, 'fetched')));
    assert.equal(r.mime, 'application/pdf');
    assert.ok(fs.readFileSync(r.path, 'latin1').startsWith('%PDF'));

    // 거절
    const no = tool.run({ drive_id: 'd1', file_id: 'f2' }, { client: 'claude-code' });
    await settle();
    askingCards(cards).at(-1).opts.onAction({}, 'reject');
    assert.equal((await no).data.status, 'declined');

    // X (onClose) without a button
    const closed = tool.run({ drive_id: 'd1', file_id: 'f2' }, {});
    await settle();
    askingCards(cards).at(-1).opts.onClose({});
    assert.equal((await closed).data.reason, 'closed');

    await assert.rejects(tool.run({ drive_id: 'd1', file_id: 'nope' }, {}), /찾을 수 없습니다\(HTTP 404\)/);
    await w.settings.save({ aiFileContent: false });
    assert.ok(!names().includes('fetch_file'));
  } finally {
    w.stop();
  }
});

test('widget: without notification cards (no ctx.notify) there is no fetch tool', async () => {
  const { create } = require('../index');
  const { ctx, registered } = fakeCtx({ notify: false });
  const w = create(ctx);
  w.start();
  try {
    await w.settings.save({ aiLiveTools: true, aiFileContent: true });
    assert.ok(registered.tools.some((t) => t.name === 'read_drive_file'));
    assert.ok(!registered.tools.some((t) => t.name.startsWith('fetch_file')));
  } finally {
    w.stop();
  }
});
