// AI tools that ask Dooray when called (#131): wiki, drive, calendar. Read only (GET), fake responses only —
// nothing here reaches the real Dooray API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ML = require('../backend/mcp-live');
const { createClient, trustedRedirect } = require('../backend/dooray');

const TOKEN = 'SECRET-TOKEN-do-not-leak-9f8e7d';
const NOW = new Date(2026, 10, 9, 15, 0).getTime();
const ok = (result, totalCount) => ({ header: { isSuccessful: true, resultCode: 0 }, result, ...(totalCount !== undefined ? { totalCount } : {}) });

/** A client double: answers by path, records every call. */
function fakeClient(routes, bytes = {}) {
  const calls = [];
  return {
    calls,
    async request(pathname, query = {}) {
      calls.push({ pathname, query });
      for (const [re, fn] of routes) {
        const m = re.exec(pathname);
        if (m) return fn(query, m);
      }
      throw Object.assign(new Error('not found'), { status: 404 });
    },
    async requestBytes(pathname, query = {}, opts = {}) {
      calls.push({ pathname, query, bytes: true, maxBytes: opts.maxBytes });
      const b = bytes[pathname];
      if (!b) throw Object.assign(new Error('not found'), { status: 404 });
      return b.length > opts.maxBytes ? { tooBig: true } : { bytes: b, contentType: 'text/plain' };
    },
  };
}

const run = (fn, client, input, ctx = {}) => ML.runLive(fn, client, input, NOW, ctx);
const fits = (result) => assert.ok(JSON.stringify(result).length <= 12000, `result ${JSON.stringify(result).length} chars`);

test('list_wikis: names, ids and the untrusted note; query filters the fetched list', async () => {
  const client = fakeClient([[/^\/wiki\/v1\/wikis$/, () => ok([
    { id: '11', name: 'Alpha 프로젝트', project: { id: 'p1' }, home: { pageId: '100' } },
    { id: '12', name: 'Beta', project: { id: 'p2' } },
  ])]]);
  const r = await run(ML.listWikis, client, { query: 'alpha' });
  assert.equal(r.untrusted, ML.UNTRUSTED);
  assert.deepEqual(r.items, [{ id: '11', name: 'Alpha 프로젝트', project_id: 'p1', home_page_id: '100' }]);
  assert.deepEqual(client.calls, [{ pathname: '/wiki/v1/wikis', query: { page: 0, size: 100 } }]);
});

test('list_wiki_pages: one level, parent_page_id passed through', async () => {
  const client = fakeClient([[/^\/wiki\/v1\/wikis\/11\/pages$/, (q) => ok(q.parentPageId === '100' ? [{ id: '101', subject: '배포 절차', parentPageId: '100' }] : [{ id: '100', subject: 'Home', root: true }])]]);
  assert.deepEqual((await run(ML.listWikiPages, client, { wiki_id: '11' })).items, [{ id: '100', title: 'Home', root: true }]);
  const child = await run(ML.listWikiPages, client, { wiki_id: '11', parent_page_id: '100' });
  assert.deepEqual(child.items, [{ id: '101', title: '배포 절차', root: false }]);
  assert.equal(client.calls[1].query.parentPageId, '100');
});

test('read_wiki_page: plain text without image URLs, windows with next_offset, attachments by name only', async () => {
  const body = `# 제목\n\n![구성도](/page-files/999?x=1)\n<b>굵게</b>\n\n\n\n${'가'.repeat(9000)}`;
  const client = fakeClient([[/^\/wiki\/v1\/wikis\/11\/pages\/101$/, () => ok({
    id: '101', subject: '배포 절차', updatedAt: '2026-11-08T01:00:00Z', body: { mimeType: 'text/x-markdown', content: body },
    files: [{ id: 'f9', name: 'run.txt', size: 12 }], images: [{ id: 'i1' }],
  })]]);
  const first = await run(ML.readWikiPage, client, { wiki_id: '11', page_id: '101', max_chars: 6000 }, { webBase: 'https://acme.dooray.com' });
  assert.ok(first.body.startsWith('# 제목\n\n[이미지: 구성도]\n굵게\n\n가'));
  assert.ok(!first.body.includes('/page-files/'));
  assert.equal(first.body.length, 6000);
  assert.equal(first.next_offset, 6000);
  assert.equal(first.url, 'https://acme.dooray.com/wiki/11/101');
  assert.deepEqual(first.files, [{ id: 'f9', name: 'run.txt', size: 12 }]);
  assert.equal(first.images, 1);
  fits(first);
  const rest = await run(ML.readWikiPage, client, { wiki_id: '11', page_id: '101', offset: first.next_offset, max_chars: 6000 });
  assert.equal(rest.offset, 6000);
  assert.equal(rest.next_offset, null);
  assert.equal(first.body + rest.body, first.body.slice(0, 6000) + rest.body);
  assert.equal(rest.body_length, first.body_length);
});

test('read_wiki_page: text that grows in JSON (many newlines) is cut to the limit and next_offset follows', async () => {
  const client = fakeClient([[/pages\/1$/, () => ok({ id: '1', subject: 's', body: { content: '"\\'.repeat(5000) } })]]); // every character doubles in JSON
  const r = await run(ML.readWikiPage, client, { wiki_id: '1', page_id: '1', max_chars: 6000 });
  fits(r);
  assert.ok(r.body.length < 6000);
  assert.equal(r.next_offset, r.body.length);
});

test('ids are checked before they go into a path', async () => {
  const client = fakeClient([]);
  for (const bad of ['../etc', '1/2', 'a?b=1', '', 'x'.repeat(41)]) {
    await assert.rejects(run(ML.readWikiPage, client, { wiki_id: bad, page_id: '1' }), /wiki_id가 올바르지 않습니다/);
  }
  assert.equal(client.calls.length, 0);
});

test('list_drives: personal and project drives, the personal one named', async () => {
  const client = fakeClient([[/^\/drive\/v1\/drives$/, (q) => ok(q.type === 'private' ? [{ id: 'd1', name: null, type: 'private' }] : [{ id: 'd2', name: 'Alpha', type: 'project', project: { id: 'p1' } }, { id: 'd1', type: 'private' }])]]);
  const r = await run(ML.listDrives, client, {});
  assert.deepEqual(r.items, [{ id: 'd1', name: '내 드라이브', kind: 'private', project_id: null }, { id: 'd2', name: 'Alpha', kind: 'project', project_id: 'p1' }]);
  assert.deepEqual(client.calls.map((c) => c.query.type), ['private', 'project']);
  const onlyProject = await run(ML.listDrives, fakeClient([[/drives$/, () => ok([{ id: 'd2', name: 'A', type: 'project' }])]]), { kind: 'project' });
  assert.equal(onlyProject.items.length, 1);
});

test('list_drive_files: the root folder first, folders first, sizes but no contents, paging', async () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, name: `file ${i}.txt`, type: 'file', mimeType: 'text/plain', size: i, updatedAt: '2026-11-01T00:00:00Z' }));
  files.push({ id: 'fd', name: '폴더', type: 'folder' });
  const client = fakeClient([[/^\/drive\/v1\/drives\/d1\/files$/, (q) => (q.subTypes === 'root' ? ok([{ id: 'root1', type: 'folder' }]) : ok(files.slice(0, 100), 250))]]);
  const r = await run(ML.listDriveFiles, client, { drive_id: 'd1', limit: 100 });
  assert.equal(r.folder_id, 'root1');
  assert.equal(client.calls[1].query.parentId, 'root1');
  assert.equal(client.calls[1].query.size, 100);
  assert.equal(r.has_more, true);
  assert.ok(r.items.every((i) => !('content' in i) && !('text' in i)));
  fits(r);
  const second = await run(ML.listDriveFiles, client, { drive_id: 'd1', folder_id: 'root1', page: 2 });
  assert.equal(second.has_more, false, 'page 2 of 250');
  const withFolder = await run(ML.listDriveFiles, fakeClient([[/files$/, () => ok([files[0], files[100]])]]), { drive_id: 'd1', folder_id: 'x' });
  assert.deepEqual(withFolder.items.map((i) => i.kind), ['folder', 'file']);
  assert.equal(withFolder.items[0].size, undefined);
});

test('list_calendars and list_events: local-day range sent with the PC offset, all-day end shown inclusive', async () => {
  const cals = fakeClient([[/calendars$/, () => ok([{ id: 'c1', name: '내 캘린더', type: 'private' }])]]);
  assert.deepEqual((await run(ML.listCalendars, cals, {})).items, [{ id: 'c1', name: '내 캘린더', kind: 'private' }]);

  const from = new Date(2026, 10, 9);
  const client = fakeClient([[/^\/calendar\/v1\/calendars\/\*\/events$/, () => ok([
    { id: 'e2', subject: '휴가', startedAt: new Date(2026, 10, 11).toISOString(), endedAt: new Date(2026, 10, 12).toISOString(), wholeDayFlag: true, calendar: { name: '내 캘린더' } },
    { id: 'e1', subject: '회의', startedAt: new Date(2026, 10, 9, 10).toISOString(), endedAt: new Date(2026, 10, 9, 11).toISOString(), location: '3층', calendar: { name: 'Alpha' }, category: 'general', body: { content: '비밀 안건' } },
  ])]]);
  const r = await run(ML.listEvents, client, { from: '2026-11-09', to: '2026-11-15', calendar_ids: ['c1', 'c2'] });
  assert.equal(client.calls[0].query.timeMin, ML.isoLocal(from));
  assert.equal(client.calls[0].query.timeMax, ML.isoLocal(new Date(2026, 10, 16)));
  assert.equal(client.calls[0].query.calendars, 'c1,c2');
  assert.deepEqual(r.items.map((e) => e.id), ['e1', 'e2']);
  assert.equal(r.items[0].start, '2026-11-09 10:00');
  assert.deepEqual([r.items[1].start, r.items[1].end, r.items[1].all_day], ['2026-11-11', '2026-11-11', true]);
  assert.ok(!JSON.stringify(r).includes('비밀 안건'), 'descriptions are not included');
  assert.equal(r.from, '2026-11-09');
  assert.equal(r.to, '2026-11-15');
});

test('list_events: bad or too long ranges are refused before asking Dooray', async () => {
  const client = fakeClient([]);
  await assert.rejects(run(ML.listEvents, client, { from: '2026-11-31' }), /YYYY-MM-DD/);
  await assert.rejects(run(ML.listEvents, client, { from: '2026-11-09', to: '2026-11-01' }), /앞입니다/);
  await assert.rejects(run(ML.listEvents, client, { from: '2026-11-01', to: '2026-12-02' }), /31일/);
  await assert.rejects(run(ML.listEvents, client, { from: '2026-11-01', calendar_ids: ['../x'] }), /올바르지 않습니다/);
  assert.equal(client.calls.length, 0);
  assert.ok(await run(ML.listEvents, fakeClient([[/events$/, () => ok([])]]), { from: '2026-11-01', to: '2026-12-01' }));
});

test('read_drive_file: text files only, at most 1 MB, UTF-8 or EUC-KR, with the file note', async () => {
  const files = {
    t1: { id: 't1', name: '메모.txt', type: 'file', mimeType: 'text/plain', size: 20 },
    k1: { id: 'k1', name: 'old.csv', type: 'file', size: 4 },
    p1: { id: 'p1', name: '제안서.pdf', type: 'file', mimeType: 'application/pdf', size: 2000 },
    big: { id: 'big', name: 'big.log', type: 'file', size: 2 * 1024 * 1024 },
    fd: { id: 'fd', name: '폴더', type: 'folder' },
    bin: { id: 'bin', name: 'x.txt', type: 'file', size: 3 },
  };
  const client = fakeClient([[/^\/drive\/v1\/drives\/d1\/files\/(\w+)$/, (q, m) => (assert.equal(q.media, 'meta'), ok(files[m[1]]))]], {
    '/drive/v1/drives/d1/files/t1': Buffer.from('﻿안녕하세요\n두 번째 줄', 'utf8'),
    '/drive/v1/drives/d1/files/k1': Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), // "한글" in EUC-KR
    '/drive/v1/drives/d1/files/bin': Buffer.from([0x41, 0x00, 0x42]),
  });
  const r = await run(ML.readDriveFile, client, { drive_id: 'd1', file_id: 't1' });
  assert.equal(r.text, '안녕하세요\n두 번째 줄');
  assert.ok(r.note.includes('허용'));
  assert.equal(r.untrusted, ML.UNTRUSTED);
  const raw = client.calls.find((c) => c.bytes);
  assert.deepEqual([raw.query.media, raw.maxBytes], ['raw', 1024 * 1024]);
  assert.equal((await run(ML.readDriveFile, client, { drive_id: 'd1', file_id: 'k1' })).text, '한글');
  await assert.rejects(run(ML.readDriveFile, client, { drive_id: 'd1', file_id: 'p1' }), /글자 파일/);
  await assert.rejects(run(ML.readDriveFile, client, { drive_id: 'd1', file_id: 'big' }), /너무 큽니다/);
  await assert.rejects(run(ML.readDriveFile, client, { drive_id: 'd1', file_id: 'fd' }), /폴더입니다/);
  await assert.rejects(run(ML.readDriveFile, client, { drive_id: 'd1', file_id: 'bin' }), /글자 파일이 아닌/);
  assert.equal(client.calls.filter((c) => c.bytes).length, 3, 'pdf, too big and folder are refused before downloading');
});

test('read_wiki_file: only an attachment of that page, text only', async () => {
  const client = fakeClient([[/^\/wiki\/v1\/wikis\/11\/pages\/101$/, () => ok({ id: '101', files: [{ id: 'a1', name: 'note.md', size: 10 }, { id: 'a2', name: 'pic.png', size: 10 }] })]], {
    '/wiki/v1/wikis/11/pages/101/files/a1': Buffer.from('# 노트', 'utf8'),
  });
  assert.equal((await run(ML.readWikiFile, client, { wiki_id: '11', page_id: '101', file_id: 'a1' })).text, '# 노트');
  await assert.rejects(run(ML.readWikiFile, client, { wiki_id: '11', page_id: '101', file_id: 'a2' }), /글자 파일/);
  await assert.rejects(run(ML.readWikiFile, client, { wiki_id: '11', page_id: '101', file_id: 'zz' }), /첨부 파일이 없습니다/);
});

test('Dooray failures become short messages without the path, body or token; slow answers hit the deadline', async () => {
  for (const [status, re] of [[401, /토큰/], [403, /권한/], [404, /찾을 수 없습니다/], [429, /많습니다/], [500, /HTTP 500/]]) {
    const client = { request: async () => { throw Object.assign(new Error(`Dooray API ${status} for /wiki/v1/wikis token ${TOKEN}`), { status, body: { secret: TOKEN } }); } };
    const err = await run(ML.listWikis, client, {}).catch((e) => e);
    assert.match(err.message, re);
    assert.ok(!err.message.includes(TOKEN) && !err.message.includes('/wiki/'), err.message);
  }
  const slow = { request: () => new Promise(() => {}) };
  const err = await run(ML.listWikis, slow, {}, { deadlineMs: 30 }).catch((e) => e);
  assert.match(err.message, /제때 응답하지/);
  assert.equal(ML.LIMITS.DEADLINE_MS < 10000, true, 'inside the engine 10 s');
});

test('big lists are trimmed under the engine limit', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `${'긴 이름 '.repeat(30)}${i}`, type: 'private' }));
  const r = await run(ML.listCalendars, fakeClient([[/calendars$/, () => ok(many)]]), { limit: 100 });
  fits(r);
  assert.equal(r.truncated, true);
});

test('tool declarations: names, read only, schemas the engine accepts', () => {
  const { cleanTools, checkInput } = require('../../../engine/main/mcp-host');
  const all = [...ML.LIVE_TOOLS, ...ML.FILE_TOOLS];
  assert.deepEqual(ML.LIVE_TOOLS.map((t) => t.name), ['list_wikis', 'list_wiki_pages', 'read_wiki_page', 'list_drives', 'list_drive_files', 'list_calendars', 'list_events']);
  assert.deepEqual(ML.FILE_TOOLS.map((t) => t.name), ['read_drive_file', 'read_wiki_file']);
  const cleaned = cleanTools(all.map((t) => ({ ...t })));
  assert.equal(cleaned.length, all.length);
  assert.ok(all.every((t) => !t.write && t.inputSchema.additionalProperties === false));
  const events = all.find((t) => t.name === 'list_events').inputSchema;
  assert.equal(checkInput(events, { from: '2026-11-09', calendar_ids: ['a'] }), null);
  assert.match(checkInput(events, { from: '2026-11-09', bogus: 1 }), /알 수 없는 입력/);
});

// ---- the HTTP client: GET only, short timeout, no retries, capped downloads, trusted redirects ----

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init, seen.length);
  };
  return Promise.resolve(fn(seen)).finally(() => (globalThis.fetch = real));
}

test('client: tool requests are GET with the token header, the short timeout and no 429 retry', () =>
  withFetch(() => new Response('{"result":[]}', { status: 429 }), async (seen) => {
    const client = createClient({ apiBase: 'https://api.dooray.com', token: TOKEN, timeoutMs: 7000, maxRetries: 0 });
    await assert.rejects(client.request('/wiki/v1/wikis', { page: 0 }), (e) => e.status === 429);
    assert.equal(seen.length, 1, 'no retry');
    assert.equal(seen[0].init.method, 'GET');
    assert.equal(seen[0].init.headers.Authorization, `dooray-api ${TOKEN}`);
    assert.ok(seen[0].init.signal);
  }));

test('client: file bytes are capped and follow one redirect only to a Dooray host', async () => {
  await withFetch((url, init, n) => {
    if (n === 1) return new Response(null, { status: 307, headers: { location: 'https://file.dooray.com/dl/1' } });
    return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
  }, async (seen) => {
    const client = createClient({ token: TOKEN, timeoutMs: 7000, maxRetries: 0 });
    const got = await client.requestBytes('/drive/v1/drives/d/files/f', { media: 'raw' }, { maxBytes: 100 });
    assert.equal(got.bytes.toString(), 'hello');
    assert.equal(seen[1].url, 'https://file.dooray.com/dl/1');
    assert.ok(seen.every((s) => s.init.method === 'GET' && s.init.redirect === 'manual'));
  });
  await withFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }), async (seen) => {
    const client = createClient({ token: TOKEN });
    await assert.rejects(client.requestBytes('/drive/v1/drives/d/files/f', {}, { maxBytes: 100 }), /unexpected host/);
    assert.equal(seen.length, 1, 'the token is not sent to another host');
  });
  await withFetch(() => new Response('x'.repeat(500), { status: 200 }), async () => {
    const got = await createClient({ token: TOKEN }).requestBytes('/f', {}, { maxBytes: 100 });
    assert.equal(got.tooBig, true);
  });
  assert.equal(trustedRedirect('http://file.dooray.com/x', 'https://api.dooray.com'), null, 'not plain http');
  assert.ok(trustedRedirect('https://acme.dooray.com/x', 'https://api.dooray.com'));
  assert.equal(trustedRedirect('https://dooray.com.evil.io/x', 'https://api.dooray.com'), null);
});

test('only GET is used: no other HTTP method anywhere in the client or the tools', () => {
  const dir = path.join(__dirname, '..', 'backend');
  for (const f of ['dooray.js', 'mcp-live.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(src), f);
  }
});

// ---- the widget: the switches decide which tools are registered ----

function fakeCtx() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dooray-live-widget-'));
  const registered = { tools: null };
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
    notify() {},
    sendToSettings() {},
    openExternal: async () => {},
    useThemes: () => ({
      open() {}, close() {}, focus() {}, desktopWindows: () => [], broadcast() {}, settingsHandlers: () => ({}),
      windows: { setOverviewPinned() {}, reloadAll() {} },
    }),
    mcp: { registerTools: (tools) => ((registered.tools = tools), true) },
  };
  return { ctx, registered };
}

test('widget: live tools only after the setting, file tools only with the second switch; mock answers', async () => {
  const { create } = require('../index');
  const { ctx, registered } = fakeCtx();
  const w = create(ctx);
  w.start();
  try {
    const names = () => registered.tools.map((t) => t.name);
    assert.equal(names().length, 4, 'off by default');
    assert.equal(w.settings.get().aiLiveTools, false);

    await w.settings.save({ aiLiveTools: true, aiFileContent: true });
    assert.equal(names().length, 15, '4 tasks + 7 live + 2 file text + fetch_file and fetch_file_status');
    await w.settings.save({ aiFileContent: false });
    assert.equal(names().length, 11);
    assert.ok(!names().includes('read_drive_file'));
    await w.settings.save({ aiLiveTools: false, aiFileContent: true });
    assert.equal(names().length, 4, 'file contents need the live tools');
    assert.equal(w.settings.get().aiFileContent, false);

    await w.settings.save({ aiLiveTools: true, aiFileContent: true });
    const call = async (name, input) => (await registered.tools.find((t) => t.name === name).run(input, { client: 'test' })).data;
    const wiki = (await call('list_wikis', {})).items[0];
    const page = await call('read_wiki_page', { wiki_id: wiki.id, page_id: wiki.home_page_id });
    assert.ok(page.body.includes('[이미지: 구성도]'));
    assert.equal(page.url, `https://example.dooray.com/wiki/${wiki.id}/${wiki.home_page_id}`);
    const drives = (await call('list_drives', {})).items;
    const files = await call('list_drive_files', { drive_id: drives[0].id });
    assert.deepEqual(files.items.map((f) => f.kind), ['folder', 'file', 'file']);
    assert.ok((await call('read_drive_file', { drive_id: drives[0].id, file_id: 'f1' })).text.includes('기획 회의'));
    assert.ok((await call('read_wiki_file', { wiki_id: wiki.id, page_id: wiki.home_page_id, file_id: 'a1' })).text.includes('서버 점검'));
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.equal((await call('list_events', { from: day })).items[0].title, '주간 회의');
    assert.ok((await call('list_calendars', {})).items.length === 2);
  } finally {
    w.stop();
  }
});
