// Polls Dooray, aggregates the data and emits contract v1 snapshots.
const { EventEmitter } = require('events');
const { createClient } = require('./dooray');
const {
  DEFAULT_RULES,
  toTag,
  buildTask,
  buildProjectDashboard,
  buildSnapshot,
  orderProjects,
  buildCategories,
  applyCategoryIds,
  webUrlOf,
  projectLabel,
} = require('./aggregate');
const { describeApiError } = require('./errors');
const {
  DEFAULT_SCOPE,
  isRelated,
  authorId,
  diffPosts,
  commentCandidates,
  commentEvent,
  editEvent,
  mentions,
  preview,
  overdueTransitions,
  dedupe,
} = require('./events');
const mock = require('./mock');
const { dayKey, periodFor, isDue, evaluate } = require('./rules');

// Caps for the cross-project queries (100 tasks per request).
const MAX_OPEN_TOTAL = 3000;
const MAX_CLOSED_TOTAL = 2000;
// Project list, closed counts and a full re-read happen at least this often even without changes
// (catches deletions and anything the updatedAt filter cannot see).
const FULL_REFETCH_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Tag definitions change rarely: refetched this often, on manual refresh and when projects change.
const TAG_REFETCH_MS = 30 * 60 * 1000;
// Upper bound of comment lookups per cycle (each is one request).
const MAX_COMMENT_LOOKUPS = 20;
const CONCURRENCY = 3;
const MAX_BACKOFF_SEC = 600;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function notifyOptions(settings) {
  return {
    enabled: settings.notifyEnabled !== false,
    types: settings.notifyTypes || {},
    scope: { ...DEFAULT_SCOPE, ...(settings.notifyScope || {}) },
  };
}

function groupByProject(posts) {
  const map = new Map();
  for (const post of posts || []) {
    const id = String(post.project?.id ?? '');
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(post);
  }
  return map;
}

function countByProject(posts) {
  const map = new Map();
  for (const post of posts) {
    const id = String(post.project?.id ?? '');
    map.set(id, (map.get(id) || 0) + 1);
  }
  return map;
}

class DashboardService extends EventEmitter {
  /**
   * @param {{ getSettings: () => object, isConfigured: () => boolean, categories: import('./categories').CategoryStore, useMock?: boolean }} opts
   */
  /** now: the clock in ms (a seam for tests; date-dependent results must not depend on the real date). */
  constructor({ getSettings, isConfigured, categories, rules = null, useMock = false, clientFactory = createClient, now = () => Date.now() }) {
    super();
    this.now = now;
    this.ruleStore = rules;
    this.clientFactory = clientFactory;
    this.resetCache();
    this.categories = categories;
    // Categorized tasks fetched one by one because they are not in the open lists (closed, hidden project, ...).
    this.extraTasks = new Map();
    this.getSettings = getSettings;
    this.isConfigured = isConfigured;
    this.useMock = useMock;
    this.timer = null;
    this.inFlight = null;
    this.failures = 0;
    this.me = null;
    this.allProjects = [];
    this.status = { state: 'loading', refreshing: false, message: null, lastSuccessAt: null, nextRefreshAt: null };
    // 'locked' | 'suspended' | 'idle' while the user is away; polling stops until it clears.
    this.pausedReason = null;
    this.snapshot = this.compose([]);
  }

  rules() {
    const s = this.getSettings();
    return { ...DEFAULT_RULES, dueSoonDays: s.dueSoonDays ?? DEFAULT_RULES.dueSoonDays };
  }

  /** Every task with fresh data from the last refresh, keyed by id. */
  liveTasks(projects) {
    const map = new Map(this.extraTasks);
    for (const p of projects) for (const t of p.tasks.open) map.set(t.id, t);
    return map;
  }

  compose(projects) {
    const s = this.getSettings();
    const assignments = this.categories.assignments();
    applyCategoryIds(projects, assignments);
    const categories = buildCategories(this.categories.categories(), assignments, this.liveTasks(projects), {
      now: new Date(this.now()),
      rules: this.rules(),
    });
    // Projects reach themes in the user's order (drag and drop); see contract v1.5.
    projects = orderProjects(projects, s.projectOrder || []);
    return buildSnapshot({
      categories,
      status: { ...this.status, paused: Boolean(this.pausedReason), pausedReason: this.pausedReason },
      me: this.me,
      domain: this.useMock ? mock.DOMAIN : s.doorayDomain,
      rules: this.rules(),
      projects,
    });
  }

  publish(projects) {
    // Keep the fetched (unsorted) list so a cleared or changed user order sorts from scratch.
    if (projects) this.baseProjects = projects;
    this.snapshot = this.compose(this.baseProjects || []);
    this.emit('snapshot', this.snapshot);
  }

  getSnapshot() {
    return this.snapshot;
  }

  /**
   * The body of one task (#111: "할 일에 추가" makes a sticky note with it): { content, html } or null. Asked only
   * for that one click; the sample data mode has a made-up text.
   */
  async taskBody(taskId) {
    if (this.useMock) return { content: '샘플 업무 본문입니다.\n\n- 확인할 것 1\n- 확인할 것 2\n', html: false };
    const settings = this.getSettings();
    const client = this.clientFactory({ apiBase: settings.apiBase, token: settings.apiToken });
    const body = (await client.getPost(String(taskId)))?.result?.body;
    if (!body || typeof body.content !== 'string') return null;
    return { content: body.content, html: /html/i.test(String(body.mimeType || '')) };
  }

  /** Finds a task in the current snapshot (project lists or categories). */
  findTask(taskId) {
    for (const p of this.snapshot.projects) {
      const t = p.tasks.open.find((x) => x.id === taskId);
      if (t) return t;
    }
    for (const c of this.snapshot.categories) {
      const t = c.tasks.find((x) => x.id === taskId);
      if (t) return t;
    }
    return null;
  }

  /** Runs a category change and republishes without refetching from Dooray. */
  updateCategories(change) {
    const result = change(this.categories);
    this.publish();
    return result;
  }

  /** All projects the user belongs to (including hidden ones), for the settings window. */
  getProjects() {
    return this.allProjects.map((p) => ({ id: String(p.id), name: projectLabel(p.code) || String(p.id), description: p.description || '' }));
  }

  start() {
    this.refresh();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Call after settings change. Drops cached identity when credentials change. */
  reconfigure({ credentialsChanged = true } = {}) {
    if (credentialsChanged) {
      this.me = null;
      this.extraTasks.clear();
      this.tagLoadedFor.clear();
      this.allProjects = [];
      this.status = { ...this.status, state: 'loading', lastSuccessAt: null };
    }
    this.failures = 0;
    this.resetCache();
    return this.refresh();
  }

  /** Drops fetched task data so the next cycle does a full read. */
  resetCache() {
    this.openPosts = null;
    this.openTruncated = false;
    this.closedByProject = new Map();
    this.closedDays = null;
    this.watermark = null;
    this.fullAt = 0;
    this.projectsFetchedAt = 0;
    this.visibleKey = '';
    this.forceNext = false;
    this.tagIndex = new Map();
    this.tagLoadedFor = new Set();
    this.tagsFetchedAt = 0;
    this.tagProjectsKey = '';
    // Previous state for change notifications; null means "next fetch is the baseline".
    this.prevOpenById = null;
    this.prevDueStates = null;
  }

  /** Stops polling while the user is away (reason) and refreshes right away when they return (null). */
  setPaused(reason) {
    const next = reason || null;
    if (next === this.pausedReason) return;
    const wasPaused = Boolean(this.pausedReason);
    this.pausedReason = next;
    if (next) {
      clearTimeout(this.timer);
      this.timer = null;
      this.status.nextRefreshAt = null;
      this.publish();
    } else if (wasPaused) {
      this.refresh();
    }
  }

  schedule(delaySec) {
    clearTimeout(this.timer);
    if (this.pausedReason) {
      this.timer = null;
      this.status.nextRefreshAt = null;
      return;
    }
    this.status.nextRefreshAt = new Date(this.now() + delaySec * 1000).toISOString();
    this.timer = setTimeout(() => this.refresh(), delaySec * 1000);
  }

  /** @param {{ force?: boolean }} [opts] force skips change detection (manual refresh). */
  refresh({ force = false } = {}) {
    if (force) this.forceNext = true;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async runRefresh() {
    const settings = this.getSettings();
    clearTimeout(this.timer);

    if (!this.useMock && !this.isConfigured()) {
      this.status = { state: 'unconfigured', refreshing: false, message: '설정에서 두레이 도메인과 API 토큰을 입력해 주세요.', lastSuccessAt: null, nextRefreshAt: null };
      this.publish([]);
      return;
    }

    this.status.refreshing = true;
    this.publish();

    try {
      const projects = this.useMock ? this.collectMock(settings) : await this.collect(settings);
      this.failures = 0;
      this.status = {
        state: 'ok',
        refreshing: false,
        message: null,
        lastSuccessAt: new Date(this.now()).toISOString(),
        nextRefreshAt: null,
      };
      this.schedule(settings.pollIntervalSec);
      this.publish(projects);
      if (this.newEvents?.length) this.emit('events', this.newEvents);
      this.newEvents = null;
    } catch (err) {
      this.failures++;
      const delay = Math.min(MAX_BACKOFF_SEC, settings.pollIntervalSec * 2 ** Math.min(this.failures, 4));
      this.status = { ...this.status, state: 'error', refreshing: false, message: describeApiError(err) };
      this.schedule(delay);
      this.publish();
    }
  }

  collectMock(settings) {
    const data = mock.build(new Date(this.now()));
    this.me = data.me;
    // First mock run: start with the sample categories so themes have something to show.
    if (!this.mockSeeded && !this.categories.categories().length && !Object.keys(this.categories.assignments()).length) {
      this.categories.load().categories.push(...data.categories);
      Object.assign(this.categories.load().assignments, data.assignments);
      this.categories.persist();
    }
    this.mockSeeded = true;
    this.allProjects = data.projects;
    const hidden = new Set(settings.hiddenProjectIds || []);
    const tagIndex = new Map(data.tags.map((t) => [String(t.id), toTag(t)]));
    const ctx = { meId: data.me.id, now: new Date(this.now()), rules: this.rules(), webUrl: webUrlOf(mock.DOMAIN), tagIndex };
    const projects = data.projects
      .filter((p) => !hidden.has(String(p.id)))
      .map((p) => buildProjectDashboard(p, data.posts[p.id] || [], { ...ctx, closedRecently: data.closedRecently[p.id] || 0 }));
    this.categories.updateCache(this.liveTasks(projects));
    return projects;
  }

  // One refresh cycle. Cheap path: a single "anything updated since the watermark?" request.
  // Full path (first run, change detected, every FULL_REFETCH_MS, manual refresh): open tasks of
  // all visible projects in one cross-project query, plus recently closed tasks for the counts.
  async collect(settings) {
    const client = this.clientFactory({ apiBase: settings.apiBase, token: settings.apiToken });
    const rules = this.rules();
    const now = this.now();
    const force = this.forceNext;
    this.forceNext = false;
    // Server-time watermark before this cycle: tasks created after it count as new.
    const eventsSince = this.watermark;
    const notify = notifyOptions(settings);
    let rawEvents = [];
    let candidates = [];

    if (!this.me) {
      const me = (await client.getMyMember())?.result;
      this.me = { id: me?.id ? String(me.id) : null, name: me?.name || '' };
    }

    if (force || !this.allProjects.length || now - this.projectsFetchedAt > FULL_REFETCH_MS) {
      const { items } = await client.listAllMyProjects();
      this.allProjects = items.filter((p) => p.state !== 'archived' && p.state !== 'deleted');
      this.projectsFetchedAt = now;
    }

    const hidden = new Set(settings.hiddenProjectIds || []);
    const visible = this.allProjects.filter((p) => !hidden.has(String(p.id)));
    const ids = visible.map((p) => String(p.id));
    const visibleKey = ids.join(',');

    if (force || visibleKey !== this.tagProjectsKey || now - this.tagsFetchedAt > TAG_REFETCH_MS) {
      await this.loadTags(client, ids);
      this.tagProjectsKey = visibleKey;
      this.tagsFetchedAt = now;
    }

    let full =
      force ||
      !this.openPosts ||
      this.watermark === null ||
      visibleKey !== this.visibleKey ||
      this.closedDays !== rules.recentDays ||
      now - this.fullAt > FULL_REFETCH_MS;

    if (!full && ids.length) {
      // Dooray timestamps have second precision; +1s skips the item that set the watermark.
      const changes = await client.listUpdatedSince(ids, new Date(this.watermark + 1000).toISOString());
      if (changes.totalCount > 0) {
        full = true;
        this.raiseWatermark(changes.items);
      }
    }

    if (full) {
      if (ids.length) {
        const open = await client.listOpenPostsAcross(ids, MAX_OPEN_TOTAL);
        const since = new Date(now - rules.recentDays * DAY_MS).toISOString();
        const closed = await client.listClosedSince(ids, since, MAX_CLOSED_TOTAL);
        rawEvents = diffPosts(this.prevOpenById, open.items, closed.items, { meId: this.me.id, since: eventsSince, scope: notify.scope });
        candidates = commentCandidates(this.prevOpenById, open.items, closed.items, eventsSince);
        this.rememberNames([...open.items, ...closed.items]);
        this.prevOpenById = new Map(open.items.map((p) => [String(p.id), p]));
        this.openPosts = open.items;
        this.openTruncated = open.truncated;
        this.closedByProject = countByProject(closed.items);
        this.raiseWatermark(open.items);
        this.raiseWatermark(closed.items);
      } else {
        this.openPosts = [];
        this.prevOpenById = new Map();
        this.openTruncated = false;
        this.closedByProject = new Map();
      }
      // Nothing seen yet (empty projects): start watching from a few minutes ago.
      if (this.watermark === null) this.watermark = now - 5 * 60 * 1000;
      this.fullAt = now;
      this.visibleKey = visibleKey;
      this.closedDays = rules.recentDays;
    }

    // Rebuild dashboards every cycle so overdue/due-soon states follow the clock.
    const ctx = { meId: this.me.id, now: new Date(now), rules, webUrl: webUrlOf(settings.doorayDomain), tagIndex: this.tagIndex };
    const byProject = groupByProject(this.openPosts);
    const projects = visible.map((project) => {
      const id = String(project.id);
      return buildProjectDashboard(project, byProject.get(id) || [], {
        ...ctx,
        closedRecently: this.closedByProject.get(id) || 0,
        truncated: this.openTruncated,
      });
    });

    // Notifications: task changes from the diff, new comments/mentions, and tasks in scope
    // that just passed their deadline. One event per task (most important wins).
    const relatedIds = new Set(
      (this.openPosts || []).filter((p) => isRelated(p, this.me.id, notify.scope)).map((p) => String(p.id))
    );
    const scoped = projects.flatMap((p) => p.tasks.open.filter((t) => relatedIds.has(t.id)));
    const overdue = overdueTransitions(this.prevDueStates, scoped);
    this.prevDueStates = new Map(scoped.map((t) => [t.id, t.dueState]));
    const commentEvents = await this.findCommentEvents(client, candidates, notify);

    const at = new Date(now).toISOString();
    this.newEvents = dedupe([...rawEvents, ...commentEvents, ...overdue]).map((e) => {
      const task = e.task || buildTask(e.post, ctx);
      const url = e.comment?.id ? `${task.url}#comment-${e.comment.id}` : task.url;
      return { id: `${e.type}:${task.id}:${now}`, type: e.type, task, url, from: e.from || null, comment: e.comment || null, at };
    });

    // Categorized tasks outside the open lists change rarely; refresh them with full fetches only.
    if (full) await this.fetchCategorizedTasks(client, projects, ctx);
    this.categories.updateCache(this.liveTasks(projects));
    this.lastCycle = full ? 'full' : 'check';

    // Condition alerts due now (cheap check every cycle; a query only when a rule is due).
    try {
      const alerts = await this.checkRules(client, settings, new Date(now));
      if (alerts.length) this.newEvents = [...(this.newEvents || []), ...alerts];
    } catch {
      // A failed rule check is retried next cycle; the dashboard is unaffected.
    }
    return projects;
  }

  projectNameOf(id) {
    const p = this.allProjects.find((x) => String(x.id) === String(id));
    return p ? projectLabel(p.code) || String(p.id) : '(알 수 없는 프로젝트)';
  }

  /**
   * Evaluates condition-alert rules. Scheduled runs (no onlyId) only touch rules that are due
   * and record their state; a manual run (onlyId) evaluates that rule now without recording.
   * @returns notification events for rules whose condition is not met
   */
  async checkRules(client, settings, now, { onlyId = null } = {}) {
    if (!this.ruleStore) return [];
    const events = [];
    for (const rule of this.ruleStore.rules()) {
      if (onlyId ? rule.id !== onlyId : !isDue(rule, this.ruleStore.stateOf(rule.id), now)) continue;
      if (rule.tag) {
        const unknown = rule.projectIds.filter((id) => !this.tagLoadedFor.has(id));
        if (unknown.length) await this.loadTags(client, unknown);
      }
      const period = periodFor(rule, now);
      const { items } = await client.listCreatedBetween(rule.projectIds, period.from.toISOString(), period.to.toISOString());
      const result = evaluate(rule, items, {
        projectName: (id) => this.projectNameOf(id),
        tagName: (id) => this.tagIndex.get(id)?.name,
      });
      const webUrl = webUrlOf(settings.doorayDomain);
      const missing = result.missing.map((m) => ({ ...m, url: webUrl ? `${webUrl}/project/projects/${m.id}` : '' }));
      const alert = missing.length > 0;
      const state = {
        date: dayKey(now),
        resolved: !alert,
        lastCheckedAt: now.toISOString(),
        lastAlertAt: alert ? now.toISOString() : null,
        period: { label: period.label, from: period.from.toISOString(), to: period.to.toISOString() },
        counts: result.counts,
        missing,
      };
      if (!onlyId) this.ruleStore.setState(rule.id, state);
      if (alert) {
        events.push({
          id: `rule:${rule.id}:${now.getTime()}`,
          type: 'rule',
          rule: { id: rule.id, name: rule.name, minCount: rule.minCount, tag: rule.tag },
          period: state.period,
          missing,
          url: missing[0].url,
          task: null,
          at: now.toISOString(),
        });
      }
      if (onlyId) return { state, events };
    }
    if (onlyId) throw new Error('규칙을 찾을 수 없습니다.');
    return events;
  }

  /** "지금 확인" from the rule manager: evaluates one rule immediately. */
  async runRuleNow(ruleId) {
    if (this.useMock) throw new Error('샘플 데이터 모드에서는 사용할 수 없습니다.');
    const settings = this.getSettings();
    const client = this.clientFactory({ apiBase: settings.apiBase, token: settings.apiToken });
    if (!this.allProjects.length) await this.refresh();
    return this.checkRules(client, settings, new Date(this.now()), { onlyId: ruleId });
  }

  // One request per visible project. A project that fails keeps the tags we already had.
  async loadTags(client, projectIds) {
    const next = new Map(this.tagIndex);
    await mapLimit(projectIds, 2, async (id) => {
      try {
        const { items } = await client.listProjectTags(id);
        for (const tag of items) next.set(String(tag.id), toTag(tag));
        this.tagLoadedFor.add(String(id));
      } catch {
        // Tags are decoration; the dashboard works without them.
      }
    });
    this.tagIndex = next;
  }

  // Member names: comment logs carry only member ids. Names seen on tasks are reused for free;
  // unknown ones cost one lookup each and are cached for the session.
  rememberNames(posts) {
    if (!this.memberNames) this.memberNames = new Map();
    for (const post of posts) {
      const users = [post.users?.from, ...(post.users?.to || []), ...(post.users?.cc || [])];
      for (const u of users) {
        const m = u?.member;
        if (m?.organizationMemberId && m.name) this.memberNames.set(String(m.organizationMemberId), m.name);
      }
    }
  }

  async memberName(client, id) {
    if (!this.memberNames) this.memberNames = new Map();
    if (!this.memberNames.has(id)) {
      try {
        this.memberNames.set(id, (await client.request(`/common/v1/members/${id}`))?.result?.name || '');
      } catch {
        this.memberNames.set(id, '');
      }
    }
    return this.memberNames.get(id) || '알 수 없음';
  }

  // Reads comment logs of changed tasks. Skipped entirely when comment and mention
  // notifications are off; without mentions only tasks in the user's scope are read.
  async findCommentEvents(client, candidates, notify) {
    const wantMention = notify.enabled && notify.types.mention !== false;
    const wantComment = notify.enabled && notify.types.comment !== false;
    // Off by default: unlike the other types, a missing flag means "off".
    const wantEdit = notify.enabled && notify.types['comment-edit'] === true;
    if (!candidates.length || (!wantMention && !wantComment && !wantEdit)) return [];
    if (wantEdit && !this.seenComments) this.seenComments = new Map();
    const meId = this.me.id;
    const todo = candidates
      .filter((c) => wantMention || isRelated(c.post, meId, notify.scope))
      .slice(0, MAX_COMMENT_LOOKUPS);

    const events = [];
    await mapLimit(todo, 2, async (c) => {
      try {
        const related = isRelated(c.post, meId, notify.scope);
        const logs = (await client.getPostLogs(c.post.project?.id, c.post.id))?.result || [];
        let event = commentEvent(c.post, logs, { meId, since: c.since, wantComment: wantComment && related, wantMention });
        // A brand-new task whose body mentions me.
        if (!event && wantMention && c.isNew && authorId(c.post) !== meId) {
          const body = (await client.getPost(c.post.id))?.result?.body?.content;
          if (mentions(body, meId)) {
            const author = c.post.users?.from?.member?.name || '';
            event = { type: 'mention', post: c.post, comment: { id: null, author, text: preview(body), count: 0 } };
          }
        }
        if (wantEdit) {
          // A new comment wins over an edit; the logs are recorded either way so later edits show.
          const edit = editEvent(c.post, logs, this.seenComments, { meId, wantMention });
          if (!event && edit && (edit.type === 'mention' || related)) event = edit;
        }
        if (event?.comment && !event.comment.author && event.comment.authorId) {
          event.comment.author = await this.memberName(client, event.comment.authorId);
        }
        if (event) events.push(event);
      } catch {
        // A failed lookup only loses this notification; the dashboard is unaffected.
      }
    });
    return events;
  }

  raiseWatermark(items) {
    for (const item of items) {
      const t = Date.parse(item.updatedAt || item.createdAt);
      if (Number.isFinite(t) && (this.watermark === null || t > this.watermark)) this.watermark = t;
    }
  }

  // Categorized tasks outside the open lists are fetched one by one.
  // Tasks cached as closed are skipped; they rarely reopen and this keeps polling cheap.
  async fetchCategorizedTasks(client, projects, ctx) {
    const open = new Set();
    for (const p of projects) for (const t of p.tasks.open) open.add(t.id);
    const missing = Object.entries(this.categories.assignments())
      .filter(([id, a]) => !open.has(id) && a.task?.workflowClass !== 'closed')
      .map(([id]) => id);

    const next = new Map();
    for (const [id, task] of this.extraTasks) if (!open.has(id) && task.workflowClass === 'closed') next.set(id, task);
    await mapLimit(missing, CONCURRENCY, async (id) => {
      try {
        const post = (await client.getPost(id))?.result;
        if (post) next.set(id, buildTask(post, ctx));
      } catch {
        // Deleted or no access: the category shows the cached copy marked as stale.
      }
    });
    this.extraTasks = next;
  }
}

module.exports = { DashboardService };
