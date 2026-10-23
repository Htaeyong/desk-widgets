const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DashboardService } = require('../backend/service');
const { CategoryStore } = require('../backend/categories');

// In-memory Dooray with the same query semantics the service relies on.
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
  // Like the real API, every response is a fresh copy (callers must not share objects).
  const page = (items) => ({ items: structuredClone(items), totalCount: items.length, truncated: false });
  const client = {
    getMyMember: async () => (calls.push('me'), { result: { id: 'me', name: '나' } }),
    listAllMyProjects: async () => (calls.push('projects'), page(db.projects)),
    listOpenPostsAcross: async (ids) =>
      (calls.push('open'), page(db.posts.filter(inProjects(ids)).filter((p) => p.workflowClass !== 'closed'))),
    listClosedSince: async (ids, iso) =>
      (calls.push('closed'), page(db.posts.filter(inProjects(ids)).filter((p) => p.workflowClass === 'closed').filter(since(iso)))),
    listUpdatedSince: async (ids, iso) => (calls.push('check'), page(db.posts.filter(inProjects(ids)).filter(since(iso)))),
    getPost: async () => {
      throw Object.assign(new Error('nf'), { status: 404 });
    },
  };
  return { client, calls, db };
}

let seq = 0;
function post(projectId, overrides = {}) {
  seq++;
  return {
    id: `t${seq}`,
    subject: `task ${seq}`,
    project: { id: projectId, code: projectId },
    taskNumber: `${projectId}/${seq}`,
    number: seq,
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T01:00:00Z',
    workflowClass: 'registered',
    workflow: { id: 'w', name: '접수' },
    users: { to: [] },
    ...overrides,
  };
}

// The service's clock: fixed so date-dependent results (recently closed, due states) do not depend on today.
const NOW = Date.parse('2026-10-16T03:00:00Z');

function makeService(settings = {}) {
  const fake = fakeDooray();
  const clock = { now: NOW };
  const store = new CategoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')), 'c.json'));
  const s = { doorayDomain: 'x.dooray.com', apiBase: 'https://api', apiToken: 't', pollIntervalSec: 45, dueSoonDays: 3, hiddenProjectIds: [], ...settings };
  const svc = new DashboardService({
    getSettings: () => s,
    isConfigured: () => true,
    categories: store,
    clientFactory: () => fake.client,
    now: () => clock.now,
  });
  return { svc, fake, settings: s, clock };
}

async function cycle(svc, fake, opts) {
  fake.calls.length = 0;
  await svc.refresh(opts);
  svc.stop();
  return [...fake.calls];
}

test('first cycle is a full read; unchanged cycles cost one request', async () => {
  const { svc, fake } = makeService();
  fake.db.posts.push(post('p1'), post('p1', { workflowClass: 'working' }), post('p2'));

  assert.deepEqual(await cycle(svc, fake), ['me', 'projects', 'open', 'closed']);
  const snap = svc.getSnapshot();
  assert.equal(snap.summary.counts.open, 3);
  assert.deepEqual(snap.projects.map((p) => p.counts.open), [2, 1]);

  assert.deepEqual(await cycle(svc, fake), ['check']);
  assert.deepEqual(await cycle(svc, fake), ['check']);
  assert.equal(svc.getSnapshot().summary.counts.open, 3, 'cached data still shown');
});

test('a change triggers one full read, then checks resume', async () => {
  const { svc, fake } = makeService();
  const t = post('p2');
  fake.db.posts.push(post('p1'), t);
  await cycle(svc, fake);

  // Task closed later on the server
  t.workflowClass = 'closed';
  t.updatedAt = '2026-10-16T02:00:00Z';
  // A new task appears
  fake.db.posts.push(post('p1', { updatedAt: '2026-10-16T02:00:05Z' }));

  assert.deepEqual(await cycle(svc, fake), ['check', 'open', 'closed']);
  const snap = svc.getSnapshot();
  assert.deepEqual(snap.projects.map((p) => [p.counts.open, p.counts.closedRecently]), [[2, 0], [0, 1]]);

  // Watermark moved past the change: no repeated full reads
  assert.deepEqual(await cycle(svc, fake), ['check']);
});

test('manual refresh and visibility changes force a full read', async () => {
  const { svc, fake, settings } = makeService();
  fake.db.posts.push(post('p1'), post('p2'));
  await cycle(svc, fake);

  assert.deepEqual(await cycle(svc, fake, { force: true }), ['projects', 'open', 'closed']);

  settings.hiddenProjectIds = ['p2'];
  assert.deepEqual(await cycle(svc, fake), ['open', 'closed']);
  assert.deepEqual(svc.getSnapshot().projects.map((p) => p.name), ['Alpha']);
});

test('due states follow the clock without new requests', async () => {
  const { svc, fake, clock } = makeService();
  const base = Date.parse('2026-10-16T05:00:00Z');
  clock.now = base;
  fake.db.posts.push(post('p1', { dueDate: new Date(base + 2 * 60 * 1000).toISOString() }));

  await cycle(svc, fake);
  assert.equal(svc.getSnapshot().summary.counts.overdue, 0);

  clock.now = base + 5 * 60 * 1000; // deadline passed, still inside the full-refetch window
  assert.deepEqual(await cycle(svc, fake), ['check']);
  assert.equal(svc.getSnapshot().summary.counts.overdue, 1);
});

test('changes after the baseline are emitted as notification events', async () => {
  const { svc, fake } = makeService();
  const mine = post('p1', { users: { to: [{ type: 'member', member: { organizationMemberId: 'me', name: '나' } }] } });
  fake.db.posts.push(mine, post('p2'));
  const seen = [];
  svc.on('events', (events) => seen.push(...events));

  await cycle(svc, fake); // baseline: no events
  assert.equal(seen.length, 0);

  fake.db.posts.push(post('p2', { createdAt: '2026-10-16T02:00:00Z', updatedAt: '2026-10-16T02:00:00Z' }));
  mine.workflowClass = 'closed';
  mine.updatedAt = '2026-10-16T02:00:01Z';
  await cycle(svc, fake);

  assert.deepEqual(seen.map((e) => e.type).sort(), ['closed', 'created']);
  const created = seen.find((e) => e.type === 'created');
  assert.match(created.task.url, /^https:\/\/x\.dooray\.com\/project\/tasks\//);
  assert.equal(created.task.projectName, 'p2');

  seen.length = 0;
  await cycle(svc, fake); // nothing new
  assert.equal(seen.length, 0);
});

test('new comments and mentions on changed tasks become events; nothing is read when they are off', async () => {
  const { svc, fake, settings } = makeService();
  const meMember = { type: 'member', member: { organizationMemberId: 'me', name: '나' } };
  const mine = post('p1', { users: { to: [meMember] } });
  const other = post('p2');
  fake.db.posts.push(mine, other);
  const logs = {};
  fake.client.getPostLogs = async (_pid, id) => (fake.calls.push('logs'), { result: logs[id] || [] });
  const seen = [];
  svc.on('events', (events) => seen.push(...events));
  await cycle(svc, fake);

  const comment = (id, by, text, at) => ({
    id,
    type: 'comment',
    createdAt: at,
    creator: { member: { organizationMemberId: by, name: by } },
    body: { content: text },
  });
  // Someone comments on my task, another person mentions me on an unrelated task.
  mine.updatedAt = '2026-10-16T02:00:00Z';
  logs[mine.id] = [comment('c1', 'kim', '확인했습니다', mine.updatedAt)];
  other.updatedAt = '2026-10-16T02:00:05Z';
  logs[other.id] = [comment('c2', 'lee', '[@나](dooray://t/members/me) 봐주세요', other.updatedAt)];

  const calls = await cycle(svc, fake);
  assert.equal(calls.filter((c) => c === 'logs').length, 2);
  assert.deepEqual(seen.map((e) => e.type).sort(), ['comment', 'mention']);
  assert.match(seen.find((e) => e.type === 'comment').url, /#comment-c1$/);

  // With comment and mention notifications off, no comment logs are read at all.
  settings.notifyTypes = { comment: false, mention: false };
  mine.updatedAt = '2026-10-16T03:00:00Z';
  const quiet = await cycle(svc, fake);
  assert.equal(quiet.filter((c) => c === 'logs').length, 0);
});

test('edited comments: option on notifies once per change; off, own edits and new comments do not', async () => {
  const { svc, fake, settings } = makeService();
  const meMember = { type: 'member', member: { organizationMemberId: 'me', name: '나' } };
  const mine = post('p1', { users: { to: [meMember] } });
  fake.db.posts.push(mine);
  const logs = {};
  fake.client.getPostLogs = async (_pid, id) => (fake.calls.push('logs'), { result: structuredClone(logs[id] || []) });
  const seen = [];
  svc.on('events', (events) => seen.push(...events));
  const comment = (id, by, text, at) => ({
    id,
    type: 'comment',
    createdAt: at,
    creator: { member: { organizationMemberId: by, name: by } },
    body: { content: text },
  });
  let n = 0;
  const touch = async () => {
    mine.updatedAt = `2026-10-16T02:00:${String(++n * 5).padStart(2, '0')}Z`;
    seen.length = 0;
    return cycle(svc, fake);
  };
  await cycle(svc, fake);

  // Option off (default): edits are silent and no extra reads happen beyond the usual lookup.
  logs[mine.id] = [comment('c1', 'kim', '원본', '2026-10-16T01:30:00Z'), comment('c2', 'me', '내 댓글', '2026-10-16T01:31:00Z')];
  await touch();
  logs[mine.id][0].body.content = '수정 1';
  const off = await touch();
  assert.equal(seen.length, 0, 'option off');
  assert.equal(off.filter((c) => c === 'logs').length, 1);

  settings.notifyTypes = { 'comment-edit': true };
  await touch(); // records the current text; nothing changed yet
  assert.equal(seen.length, 0);

  logs[mine.id][0].body.content = '수정 2';
  await touch();
  assert.deepEqual(seen.map((e) => e.type), ['comment-edit']);
  assert.equal(seen[0].comment.text, '수정 2');
  assert.match(seen[0].url, /#comment-c1$/);

  await touch(); // same text again: no repeat
  assert.equal(seen.length, 0, 'repeated read of the same edit');

  logs[mine.id][1].body.content = '내가 고침'; // my own edit
  await touch();
  assert.equal(seen.length, 0, 'own edit');

  // New comment and an edit of another one in one cycle: counts as the new comment.
  logs[mine.id].unshift(comment('c3', 'lee', '새 댓글', '2026-10-16T02:00:32Z'));
  logs[mine.id][1].body.content = '수정 3';
  await touch();
  assert.deepEqual(seen.map((e) => e.type), ['comment']);

  // An edit that adds a mention of me is a mention (when mentions are on).
  logs[mine.id][0].body.content = '새 댓글 [@나](dooray://t/members/me) 봐주세요';
  await touch();
  assert.deepEqual(seen.map((e) => e.type), ['mention']);
});

test('tag lists load on start, then only every 30 minutes or on manual refresh', async () => {
  const { svc, fake, clock } = makeService();
  clock.now = Date.parse('2026-10-16T05:00:00Z');
  fake.client.listProjectTags = async (id) => (
    fake.calls.push('tags'),
    { items: [{ id: `tag-${id}`, name: `고객사: ${id}`, color: 'ECF7FF', tagGroup: { name: '고객사' } }], totalCount: 1 }
  );
  fake.db.posts.push(post('p1', { tags: [{ id: 'tag-p1' }] }));

  const first = await cycle(svc, fake);
  assert.equal(first.filter((c) => c === 'tags').length, 2, 'one per visible project');
  assert.deepEqual(svc.getSnapshot().projects[0].tasks.open[0].tags.map((x) => x.name), ['고객사: p1']);

  clock.now += 5 * 60 * 1000;
  assert.deepEqual(await cycle(svc, fake), ['check'], 'no tag requests within 30 minutes');

  assert.equal((await cycle(svc, fake, { force: true })).filter((c) => c === 'tags').length, 2, 'manual refresh');
});

test('reordering projects republishes in the new order without any request', async () => {
  const { svc, fake, settings } = makeService();
  fake.db.posts.push(post('p1'), post('p2'));
  await cycle(svc, fake);
  assert.deepEqual(svc.getSnapshot().projects.map((p) => p.name), ['Alpha', 'Beta']);

  fake.calls.length = 0;
  settings.projectOrder = ['p2', 'p1'];
  const published = [];
  svc.on('snapshot', (s) => published.push(s.projects.map((p) => p.name)));
  svc.publish();
  assert.deepEqual(published.pop(), ['Beta', 'Alpha']);
  assert.deepEqual(fake.calls, []);

  // The order also holds for the next refresh cycle.
  await cycle(svc, fake);
  assert.deepEqual(svc.getSnapshot().projects.map((p) => p.name), ['Beta', 'Alpha']);
});

test('clearing the saved order goes back to the original order', async () => {
  const { svc, fake, settings } = makeService();
  fake.db.posts.push(post('p1'));
  await cycle(svc, fake);
  settings.projectOrder = ['p2', 'p1'];
  svc.publish();
  settings.projectOrder = [];
  svc.publish();
  assert.deepEqual(svc.getSnapshot().projects.map((p) => p.name), ['Alpha', 'Beta']);
});

test('condition alerts: checked once after the check time, alert lists missing projects', async () => {
  const { RuleStore } = require('../backend/rules');
  const fake = fakeDooray();
  const store = new CategoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')), 'c.json'));
  const rules = new RuleStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')), 'rules.json'));
  const s = { doorayDomain: 'x.dooray.com', apiBase: 'https://api', apiToken: 't', pollIntervalSec: 45, dueSoonDays: 3, hiddenProjectIds: [] };
  // Friday 2026-10-16 08:00 local: before the check time.
  let clock = new Date(2026, 9, 16, 8, 0).getTime();
  const svc = new DashboardService({ getSettings: () => s, isConfigured: () => true, categories: store, rules, clientFactory: () => fake.client, now: () => clock });
  fake.client.listCreatedBetween = async (ids, from, to) => {
    fake.calls.push('created');
    const items = fake.db.posts.filter((p) => ids.includes(p.project.id) && p.createdAt >= from && p.createdAt < to);
    return { items: structuredClone(items), totalCount: items.length, truncated: false };
  };
  rules.save({ name: '일일보고', projectIds: ['p1', 'p2'], time: '09:30', repeatMinutes: 0 });

  // p1 has a report created on Thursday; p2 has none.
  fake.db.posts.push(post('p1', { createdAt: new Date(2026, 9, 15, 10, 0).toISOString() }));
  const seen = [];
  svc.on('events', (e) => seen.push(...e));

  await cycle(svc, fake);
  assert.ok(!fake.calls.includes('created'), 'not before 09:30');

  clock = new Date(2026, 9, 16, 9, 31).getTime();
  const calls = await cycle(svc, fake);
  assert.equal(calls.filter((c) => c === 'created').length, 1);
  const alert = seen.find((e) => e.type === 'rule');
  assert.deepEqual(alert.missing.map((m) => m.name), ['Beta']);
  assert.equal(alert.period.label, '10/15(목)');
  assert.match(alert.url, /^https:\/\/x\.dooray\.com\/project\/projects\/p2$/);

  clock += 60 * 60 * 1000;
  assert.ok(!(await cycle(svc, fake)).includes('created'), 'once a day without repeat');
});
