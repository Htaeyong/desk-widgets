// Pure functions that turn raw Dooray API data into the contract v1 snapshot.
// Kept free of I/O so it can be unit tested and reused for mock data.

const CONTRACT_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_CLASSES = ['backlog', 'registered', 'working'];
const CLASS_ORDER = { backlog: 0, registered: 1, working: 2, closed: 3 };
const PRIORITIES = new Set(['highest', 'high', 'normal', 'low', 'lowest', 'none']);
const DUE_RANK = { overdue: 0, soon: 1, later: 2, none: 3 };

const DEFAULT_RULES = { dueSoonDays: 3, recentDays: 7, taskListLimit: 10, openTaskLimit: 500 };

function emptyCounts() {
  return {
    open: 0,
    backlog: 0,
    registered: 0,
    working: 0,
    overdue: 0,
    dueSoon: 0,
    mine: 0,
    unassigned: 0,
    closedRecently: 0,
  };
}

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
  return target;
}

// Dooray stores date-only due dates as local midnight of that day.
// Treat those as "due by the end of that day" so a task is not overdue on its due date.
function effectiveDeadline(dueDate) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return null;
  const isLocalMidnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  return isLocalMidnight ? new Date(d.getTime() + DAY_MS) : d;
}

function dueStateOf(deadline, now, dueSoonDays) {
  if (!deadline) return 'none';
  const diff = deadline.getTime() - now.getTime();
  if (diff < 0) return 'overdue';
  if (diff <= dueSoonDays * DAY_MS) return 'soon';
  return 'later';
}

function toPerson(user) {
  if (!user) return null;
  if (user.type === 'member' && user.member) {
    return { id: user.member.organizationMemberId || null, name: user.member.name || '(이름 없음)' };
  }
  if (user.emailUser) return { id: null, name: user.emailUser.name || user.emailUser.emailAddress || '(외부)' };
  if (user.group) return { id: user.group.projectMemberGroupId || null, name: user.group.name || '(그룹)' };
  return { id: null, name: '(알 수 없음)' };
}

/** Display name of a project: its code, except the personal project ("@id"). */
function projectLabel(code) {
  const c = String(code || '');
  return c.startsWith('@') ? '개인 프로젝트' : c;
}

function webUrlOf(domain) {
  return domain ? `https://${domain}` : '';
}

/** Contract tag from a Dooray tag definition. "고객사: 예시시청" keeps its full name; group is separate. */
function toTag(raw) {
  const color = /^[0-9a-f]{6}$/i.test(raw?.color || '') ? `#${raw.color}` : '';
  return { id: String(raw.id), name: String(raw.name || ''), color, group: raw.tagGroup?.name || null };
}

function buildTask(post, { meId, now, rules, webUrl, tagIndex = null }) {
  const deadline = effectiveDeadline(post.dueDate);
  const workflowClass = OPEN_CLASSES.includes(post.workflowClass) ? post.workflowClass : 'closed';
  const assignees = (post.users?.to || []).map(toPerson).filter(Boolean);
  return {
    id: String(post.id),
    key: post.taskNumber || `${post.project?.code || ''}/${post.number ?? ''}`,
    number: Number.isInteger(post.number) ? post.number : null,
    subject: String(post.subject || ''),
    url: webUrl ? `${webUrl}/project/tasks/${post.id}` : '',
    projectId: post.project?.id ? String(post.project.id) : '',
    projectName: projectLabel(post.project?.code),
    workflowClass,
    workflowName: post.workflow?.name || '',
    priority: PRIORITIES.has(post.priority) ? post.priority : 'none',
    dueDate: post.dueDate || null,
    deadline: deadline ? deadline.toISOString() : null,
    // Closed tasks are never overdue or due soon.
    dueState: workflowClass === 'closed' ? 'none' : dueStateOf(deadline, now, rules.dueSoonDays),
    assignees,
    author: toPerson(post.users?.from),
    isMine: Boolean(meId) && assignees.some((a) => a.id === meId),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt || post.createdAt,
    // Tag ids resolved through the project tag lists; unknown ids are left out.
    tags: (post.tags || []).map((t) => tagIndex?.get(String(t.id))).filter(Boolean),
    categoryIds: [],
    stale: false,
  };
}

const byUpdatedDesc = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
const byDeadlineAsc = (a, b) => (a.deadline || '').localeCompare(b.deadline || '');

function buildProjectDashboard(project, posts, ctx) {
  const { meId, rules, webUrl, closedRecently = 0, truncated = false, error = null } = ctx;
  const tasks = posts.map((p) => buildTask(p, ctx)).sort(byUpdatedDesc);

  const counts = emptyCounts();
  counts.closedRecently = closedRecently;
  const workflows = new Map();
  const assignees = new Map();

  for (const t of tasks) {
    counts.open++;
    counts[t.workflowClass]++;
    if (t.dueState === 'overdue') counts.overdue++;
    if (t.dueState === 'soon') counts.dueSoon++;
    if (t.isMine) counts.mine++;
    if (t.assignees.length === 0) counts.unassigned++;

    const wfKey = `${t.workflowClass}:${t.workflowName}`;
    const wf = workflows.get(wfKey) || { id: '', name: t.workflowName, class: t.workflowClass, count: 0 };
    wf.count++;
    workflows.set(wfKey, wf);

    for (const a of t.assignees) {
      const key = a.id || `name:${a.name}`;
      const entry = assignees.get(key) || { id: a.id, name: a.name, open: 0, working: 0, overdue: 0, isMe: a.id === meId };
      entry.open++;
      if (t.workflowClass === 'working') entry.working++;
      if (t.dueState === 'overdue') entry.overdue++;
      assignees.set(key, entry);
    }
  }

  // Workflow ids come from the raw posts; fill them in by name/class.
  for (const p of posts) {
    const key = `${p.workflowClass}:${p.workflow?.name || ''}`;
    const wf = workflows.get(key);
    if (wf && !wf.id && p.workflow?.id) wf.id = String(p.workflow.id);
  }

  const limit = rules.taskListLimit;
  return {
    id: String(project.id),
    name: projectLabel(project.code) || project.name || String(project.id),
    description: project.description || '',
    url: webUrl ? `${webUrl}/project/projects/${project.id}` : '',
    counts,
    workflows: [...workflows.values()].sort(
      (a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || b.count - a.count || a.name.localeCompare(b.name)
    ),
    assignees: [...assignees.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)),
    tasks: {
      open: tasks.slice(0, rules.openTaskLimit),
      overdue: tasks.filter((t) => t.dueState === 'overdue').sort(byDeadlineAsc).slice(0, limit),
      dueSoon: tasks.filter((t) => t.dueState === 'soon').sort(byDeadlineAsc).slice(0, limit),
      mine: tasks
        .filter((t) => t.isMine)
        .sort((a, b) => DUE_RANK[a.dueState] - DUE_RANK[b.dueState] || byUpdatedDesc(a, b))
        .slice(0, limit),
      recent: tasks.slice(0, limit),
    },
    truncated,
    error,
  };
}

/** Sets task.categoryIds on every task list in the given project dashboards (mutates). */
function applyCategoryIds(projects, assignments) {
  for (const p of projects) {
    for (const list of Object.values(p.tasks)) {
      for (const t of list) t.categoryIds = assignments[t.id]?.categoryIds || [];
    }
  }
}

/**
 * Builds contract categories from user definitions and assignments.
 * liveTasks: Map<taskId, Task> with freshly fetched data; others fall back to the cache (stale).
 */
function buildCategories(definitions, assignments, liveTasks, { now, rules }) {
  return definitions.map((def) => {
    const tasks = [];
    for (const [taskId, a] of Object.entries(assignments)) {
      if (!a.categoryIds.includes(def.id)) continue;
      const live = liveTasks.get(taskId);
      const base = live || a.task;
      if (!base) continue;
      // Cached copies saved before v1.4 have no tags.
      let task = { tags: [], ...base, categoryIds: a.categoryIds, stale: !live };
      // Recompute due state for cached tasks so D-day labels stay correct.
      if (!live && task.workflowClass !== 'closed') {
        task.dueState = dueStateOf(task.deadline ? new Date(task.deadline) : null, now, rules.dueSoonDays);
      }
      tasks.push(task);
    }
    tasks.sort(
      (a, b) =>
        (a.workflowClass === 'closed') - (b.workflowClass === 'closed') ||
        DUE_RANK[a.dueState] - DUE_RANK[b.dueState] ||
        byUpdatedDesc(a, b)
    );
    const open = tasks.filter((t) => t.workflowClass !== 'closed');
    return {
      id: def.id,
      name: def.name,
      color: def.color,
      counts: {
        total: tasks.length,
        open: open.length,
        overdue: open.filter((t) => t.dueState === 'overdue').length,
        dueSoon: open.filter((t) => t.dueState === 'soon').length,
        closed: tasks.length - open.length,
      },
      tasks,
    };
  });
}

/**
 * Sorts projects by the user's saved order. Projects not in the list (e.g. newly joined)
 * keep their original relative order and go after the ordered ones.
 */
function orderProjects(projects, order = []) {
  const rank = new Map(order.map((id, i) => [String(id), i]));
  return projects
    .map((p, i) => ({ p, i, r: rank.has(p.id) ? rank.get(p.id) : Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}

function publicRules(rules) {
  return { dueSoonDays: rules.dueSoonDays, recentDays: rules.recentDays, taskListLimit: rules.taskListLimit };
}

function buildSnapshot({ status, me, domain, rules, projects, categories = [], now = new Date() }) {
  const summaryCounts = emptyCounts();
  for (const p of projects) addCounts(summaryCounts, p.counts);
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    status: {
      state: status.state,
      refreshing: Boolean(status.refreshing),
      message: status.message ?? null,
      lastSuccessAt: status.lastSuccessAt ?? null,
      nextRefreshAt: status.nextRefreshAt ?? null,
      paused: Boolean(status.paused),
      pausedReason: status.pausedReason ?? null,
    },
    me: me || null,
    dooray: { domain: domain || '', webUrl: webUrlOf(domain) },
    rules: publicRules(rules),
    summary: { projectCount: projects.length, counts: summaryCounts },
    projects,
    categories,
  };
}

module.exports = {
  CONTRACT_VERSION,
  DEFAULT_RULES,
  effectiveDeadline,
  toTag,
  buildTask,
  buildProjectDashboard,
  buildSnapshot,
  orderProjects,
  buildCategories,
  applyCategoryIds,
  webUrlOf,
  projectLabel,
};
