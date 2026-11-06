// "AI 도우미 연결 (MCP)" tools of the Dooray widget (#121): read only, answered from the polled cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DashboardService } = require('../backend/service');
const { CategoryStore } = require('../backend/categories');
const MT = require('../backend/mcp-tools');

const TOKEN = 'SECRET-TOKEN-do-not-leak-9f8e7d';
const ME = 'me';
const member = (id, name = id) => ({ type: 'member', member: { organizationMemberId: id, name } });
// Local times (the tools show PC local time); 2026-10-16 15:00 local.
const NOW = new Date(2026, 9, 16, 15, 0).getTime();
const localIso = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

function fakeDooray() {
  const calls = [];
  const db = {
    projects: [
      { id: 'p1', code: 'Alpha', state: 'active' },
      { id: 'p2', code: 'Beta', state: 'active' },
    ],
    posts: [],
  };
  const inProjects = (ids) => (p) => ids.includes(p.project.id);
  const since = (iso) => (p) => Date.parse(p.updatedAt) >= Date.parse(iso);
  const page = (items) => ({ items: structuredClone(items), totalCount: items.length, truncated: false });
  const client = {
    getMyMember: async () => (calls.push('me'), { result: { id: ME, name: '나' } }),
    listAllMyProjects: async () => (calls.push('projects'), page(db.projects)),
    listProjectTags: async (id) => (calls.push('tags'), page(id === 'p1' ? [{ id: 'tg1', name: '긴급', color: 'ff0000' }] : [])),
    listOpenPostsAcross: async (ids) => (calls.push('open'), page(db.posts.filter(inProjects(ids)).filter((p) => p.workflowClass !== 'closed'))),
    listClosedSince: async (ids, iso) => (calls.push('closed'), page(db.posts.filter(inProjects(ids)).filter((p) => p.workflowClass === 'closed').filter(since(iso)))),
    listUpdatedSince: async (ids, iso) => (calls.push('check'), page(db.posts.filter(inProjects(ids)).filter(since(iso)))),
    getPost: async (id) => (calls.push(`post:${id}`), { result: db.posts.find((p) => p.id === id) || null }),
    getPostLogs: async () => (calls.push('logs'), { result: [] }),
  };
  return { client, calls, db };
}

let seq = 0;
function post(projectId, overrides = {}) {
  seq++;
  return {
    id: `t${seq}`,
    subject: `task ${seq}`,
    project: { id: projectId, code: projectId === 'p1' ? 'Alpha' : 'Beta' },
    taskNumber: `${projectId === 'p1' ? 'Alpha' : 'Beta'}/${seq}`,
    number: seq,
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-15T01:00:00Z',
    workflowClass: 'registered',
    workflow: { id: 'w', name: '접수' },
    users: { from: member('boss', '부장'), to: [member(ME, '나')] },
    ...overrides,
  };
}

async function makeService(posts, { categories = null } = {}) {
  const fake = fakeDooray();
  fake.db.posts.push(...posts);
  const clock = { now: NOW };
  const store = new CategoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dooray-mcp-')), 'c.json'));
  if (categories) categories(store);
  const s = { doorayDomain: 'x.dooray.com', apiBase: 'https://api', apiToken: TOKEN, pollIntervalSec: 45, dueSoonDays: 3, hiddenProjectIds: [], notifyTypes: {} };
  const svc = new DashboardService({ getSettings: () => s, isConfigured: () => true, categories: store, clientFactory: () => fake.client, now: () => clock.now });
  await svc.refresh();
  svc.stop();
  return { svc, fake, clock, store };
}

const json = (r) => JSON.stringify(r);

test('four read-only tools with closed schemas', () => {
  assert.deepEqual(MT.TOOLS.map((t) => t.name), ['list_my_tasks', 'list_due_tasks', 'list_mentions', 'search_tasks']);
  for (const t of MT.TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]{0,40}$/);
    assert.ok(!t.write, `${t.name} must not write`);
    assert.ok(t.title && t.description);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    for (const p of Object.values(t.inputSchema.properties)) assert.ok(['string', 'integer', 'number', 'boolean', 'array'].includes(p.type));
    if (t.inputSchema.properties.limit) assert.ok(t.inputSchema.properties.limit.maximum <= 50);
  }
});

test('list_my_tasks: my open tasks with project, status, due, tags, categories and URL; filters', async () => {
  const mine = post('p1', { subject: '로그인 수정', dueDate: localIso(2026, 10, 20), tags: [{ id: 'tg1' }], workflowClass: 'working', workflow: { id: 'w2', name: '처리중' } });
  const other = post('p1', { subject: '남의 일', users: { to: [member('x', '홍길동')] } });
  const beta = post('p2', { subject: '베타 업무', dueDate: localIso(2026, 10, 16, 10, 30) });
  const { svc } = await makeService([mine, other, beta]);
  svc.updateCategories((c) => {
    const cat = c.create({ name: '이번 주' });
    c.setTaskCategories(svc.findTask(mine.id), [cat.id]);
  });

  const r = MT.listMyTasks(svc.getSnapshot(), {}, NOW);
  assert.equal(r.untrusted, MT.UNTRUSTED);
  assert.equal(r.now, '2026-10-16 15:00');
  assert.deepEqual(r.items.map((i) => i.title), ['베타 업무', '로그인 수정'], 'overdue first, then by due');
  const item = r.items.find((i) => i.id === mine.id);
  assert.deepEqual(
    { number: item.number, project: item.project, status: item.status, status_class: item.status_class, due: item.due, tags: item.tags, categories: item.categories, assignees: item.assignees, url: item.url },
    { number: mine.taskNumber, project: 'Alpha', status: '처리중', status_class: 'working', due: '2026-10-20', tags: ['긴급'], categories: ['이번 주'], assignees: ['나'], url: `https://x.dooray.com/project/tasks/${mine.id}` }
  );
  assert.equal(r.items.find((i) => i.id === beta.id).due, '2026-10-16 10:30', 'timed due shows the time');

  assert.equal(MT.listMyTasks(svc.getSnapshot(), { scope: 'all' }, NOW).total, 3);
  assert.deepEqual(MT.listMyTasks(svc.getSnapshot(), { project: 'beta' }, NOW).items.map((i) => i.id), [beta.id]);
  assert.equal(MT.listMyTasks(svc.getSnapshot(), { project: 'p1', scope: 'all' }, NOW).items.length, 2);
  assert.deepEqual(MT.listMyTasks(svc.getSnapshot(), { status: 'working' }, NOW).items.map((i) => i.id), [mine.id]);
  assert.equal(MT.listMyTasks(svc.getSnapshot(), { status: 'done' }, NOW).total, 0);
});

test('list_my_tasks: limit and size truncation keep the result under the engine limit', async () => {
  const many = Array.from({ length: 60 }, (_, i) => post('p1', { subject: `${'긴 제목 '.repeat(60)}${i}`, tags: [{ id: 'tg1' }] }));
  const { svc } = await makeService(many);
  const small = MT.listMyTasks(svc.getSnapshot(), { limit: 5 }, NOW);
  assert.equal(small.items.length, 5);
  assert.equal(small.truncated, true);
  assert.equal(small.total, 60);
  const big = MT.listMyTasks(svc.getSnapshot(), { limit: 50 }, NOW);
  assert.ok(json(big).length <= 12000, `result is ${json(big).length} chars`);
  assert.ok(big.items.length < 50 && big.truncated);
  assert.ok(big.items.every((i) => i.title.length <= 200));
});

test('list_due_tasks: overdue and due soon; a date-only due is not overdue until the day ends', async () => {
  const todayDateOnly = post('p1', { subject: '오늘까지', dueDate: localIso(2026, 10, 16) });
  const yesterday = post('p1', { subject: '어제까지', dueDate: localIso(2026, 10, 15) });
  const timedPast = post('p2', { subject: '오늘 10시', dueDate: localIso(2026, 10, 16, 10, 0) });
  const inTwoDays = post('p2', { subject: '모레', dueDate: localIso(2026, 10, 18) });
  const later = post('p2', { subject: '다음 달', dueDate: localIso(2026, 11, 20) });
  const othersOverdue = post('p1', { subject: '남의 지연', dueDate: localIso(2026, 10, 1), users: { to: [member('x', '홍길동')] } });
  const { svc, clock } = await makeService([todayDateOnly, yesterday, timedPast, inTwoDays, later, othersOverdue]);

  const r = MT.listDueTasks(svc.getSnapshot(), {}, NOW);
  const state = Object.fromEntries(r.items.map((i) => [i.title, i.due_state]));
  assert.deepEqual(state, { 어제까지: 'overdue', '오늘 10시': 'overdue', 오늘까지: 'soon', 모레: 'soon' });
  assert.deepEqual(r.counts, { overdue: 2, soon: 2 });
  assert.equal(r.due_soon_days, 3);
  assert.deepEqual(MT.listDueTasks(svc.getSnapshot(), { which: 'overdue', scope: 'all' }, NOW).items.map((i) => i.title), ['남의 지연', '어제까지', '오늘 10시']);
  assert.deepEqual(MT.listDueTasks(svc.getSnapshot(), { which: 'soon', project: 'Beta' }, NOW).items.map((i) => i.title), ['모레']);

  // While polling is paused the clock still moves: the next day the date-only due is overdue.
  svc.setPaused('locked');
  clock.now = new Date(2026, 9, 17, 0, 5).getTime();
  const next = MT.listDueTasks(svc.getSnapshot(), { which: 'overdue' }, clock.now);
  assert.ok(next.items.some((i) => i.title === '오늘까지'));
  assert.equal(next.source.paused, true);
});

test('search_tasks: all words over title, number, tags and assignees; title matches first; limit', async () => {
  const a = post('p1', { subject: 'API 응답 속도 개선' });
  const b = post('p2', { subject: '배포 점검', tags: [], users: { to: [member('x', 'API 담당자')] } });
  const c = post('p1', { subject: '긴급 아닌 일' });
  const d = post('p1', { subject: '태그만 긴급', tags: [{ id: 'tg1' }] });
  const { svc } = await makeService([a, b, c, d]);
  const snap = svc.getSnapshot();
  assert.deepEqual(MT.searchTasks(snap, { query: 'api' }, NOW).items.map((i) => i.id), [a.id, b.id]);
  assert.deepEqual(MT.searchTasks(snap, { query: 'API 속도' }, NOW).items.map((i) => i.id), [a.id]);
  assert.deepEqual(MT.searchTasks(snap, { query: a.taskNumber }, NOW).items.map((i) => i.id), [a.id], 'task number');
  assert.deepEqual(MT.searchTasks(snap, { query: '긴급' }, NOW).items.map((i) => i.id).sort(), [c.id, d.id].sort());
  const one = MT.searchTasks(snap, { query: '긴급', limit: 1 }, NOW);
  assert.equal(one.items.length, 1);
  assert.equal(one.truncated, true);
  assert.equal(one.untrusted, MT.UNTRUSTED);
  assert.throws(() => MT.searchTasks(snap, { query: '   ' }, NOW), /찾을 말/);
});

test('list_mentions: notifications seen since start, newest first, with a note that they are memory only', async () => {
  const a = post('p1', { subject: '확인 요청' });
  const { svc, fake, clock } = await makeService([a]);
  assert.equal(MT.listMentions(svc.getSnapshot(), svc.recentEvents(), {}, NOW).items.length, 0, 'the first cycle is the baseline');

  // A new task assigned to me arrives: the service keeps the "assigned" event in memory.
  fake.db.posts.push(post('p2', { subject: '새로 배정', createdAt: '2026-10-16T05:30:00Z', updatedAt: '2026-10-16T05:30:00Z' }));
  clock.now = NOW + 60 * 1000;
  await svc.refresh();
  svc.stop();
  const task = svc.findTask(a.id);
  svc.rememberEvents([
    { type: 'mention', task, url: `${task.url}#comment-9`, comment: { id: '9', author: '부장', text: '@나 '.padEnd(500, '가'), count: 1 }, at: '2026-10-16T06:10:00Z' },
    { type: 'rule', task: null, at: '2026-10-16T06:11:00Z' },
  ]);

  const mentions = MT.listMentions(svc.getSnapshot(), svc.recentEvents(), {}, NOW);
  assert.equal(mentions.note, MT.MENTION_NOTE);
  assert.deepEqual(mentions.items.map((i) => i.type), ['mention']);
  assert.equal(mentions.items[0].comment.author, '부장');
  assert.ok(mentions.items[0].comment.text.length <= 300);
  assert.equal(mentions.items[0].task.title, '확인 요청');
  assert.match(mentions.items[0].url, /#comment-9$/);
  assert.equal(mentions.untrusted, MT.UNTRUSTED);

  const all = MT.listMentions(svc.getSnapshot(), svc.recentEvents(), { kind: 'all' }, NOW);
  assert.deepEqual(all.items.map((i) => i.type), ['mention', 'assigned']);
  assert.equal(MT.listMentions(svc.getSnapshot(), svc.recentEvents(), { kind: 'all', limit: 1 }, NOW).truncated, true);
});

test('the tools make no Dooray request and never show the token', async () => {
  const posts = [post('p1', { subject: '토큰 없는 결과', dueDate: localIso(2026, 10, 15) }), post('p2')];
  const { svc, fake } = await makeService(posts);
  const realFetch = global.fetch;
  let fetched = 0;
  global.fetch = async () => {
    fetched++;
    throw new Error('no network in tests');
  };
  try {
    const before = fake.calls.length;
    const snap = svc.getSnapshot();
    const results = [
      MT.listMyTasks(snap, { scope: 'all', status: 'any' }, NOW),
      MT.listDueTasks(snap, { scope: 'all' }, NOW),
      MT.listMentions(snap, svc.recentEvents(), { kind: 'all' }, NOW),
      MT.searchTasks(snap, { query: '토큰' }, NOW),
    ];
    assert.equal(fake.calls.length, before, 'no client call');
    assert.equal(fetched, 0, 'no fetch');
    for (const r of results) {
      assert.ok(!json(r).includes(TOKEN));
      assert.ok(!/apiToken|tokenEnc/i.test(json(r)));
      assert.ok(json(r).length <= 12000);
    }
  } finally {
    global.fetch = realFetch;
  }
});

test('an unconfigured widget says what to do', () => {
  const snap = { status: { state: 'unconfigured' }, projects: [], categories: [], rules: { dueSoonDays: 3 } };
  assert.throws(() => MT.listMyTasks(snap, {}, NOW), /설정/);
});

// --- the widget: registration through ctx.mcp, mock data, and engines without ctx.mcp ---

function fakeCtx({ mcp = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dooray-mcp-widget-'));
  const registered = { tools: null };
  const ctx = {
    dir: path.join(__dirname, '..'),
    dataDir,
    flags: { mockData: true },
    app: { isPackaged: true, locale: () => 'ko' },
    createStore: (opts) => {
      let state = structuredClone(opts.defaults || {});
      return {
        load: () => (opts.sanitize ? opts.sanitize(state) : state),
        save: (patch) => (state = { ...state, ...patch }),
      };
    },
    handle() {},
    notify() {},
    sendToSettings() {},
    openExternal: async () => {},
    useThemes: () => ({
      open() {},
      close() {},
      focus() {},
      desktopWindows: () => [],
      broadcast() {},
      settingsHandlers: () => ({}),
      windows: { setOverviewPinned() {}, reloadAll() {} },
    }),
    ...(mcp ? { mcp: { registerTools: (tools) => ((registered.tools = tools), true) } } : {}),
  };
  return { ctx, registered };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the widget registers the four tools and they answer from the sample data', async () => {
  const { create } = require('../index');
  const { ctx, registered } = fakeCtx();
  const w = create(ctx);
  w.start();
  try {
    await settle();
    assert.deepEqual(registered.tools.map((t) => t.name), ['list_my_tasks', 'list_due_tasks', 'list_mentions', 'search_tasks']);
    assert.ok(registered.tools.every((t) => typeof t.run === 'function' && !t.write));
    const run = (name, input) => registered.tools.find((t) => t.name === name).run(input, { client: 'test' });
    const mine = (await run('list_my_tasks', {})).data;
    assert.ok(mine.items.length > 0 && mine.items.every((i) => i.mine));
    assert.ok(mine.items.every((i) => i.url.startsWith('https://example.dooray.com/project/tasks/')));
    assert.ok((await run('list_due_tasks', { scope: 'all' })).data.items.length > 0);
    const mentions = (await run('list_mentions', {})).data;
    assert.equal(mentions.items.length, 1, 'the sample mention');
    assert.ok((await run('search_tasks', { query: '로그인' })).data.items.length > 0);
  } finally {
    w.stop();
  }
});

test('without ctx.mcp (engines before API 1.10) the widget starts as before', async () => {
  const { create } = require('../index');
  const { ctx } = fakeCtx({ mcp: false });
  const w = create(ctx);
  assert.doesNotThrow(() => w.start());
  await settle();
  w.stop();
});
