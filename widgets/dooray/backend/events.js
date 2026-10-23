// Turns differences between two fetches into notification events. Pure functions (unit-tested).
// Event types: mention, assigned, comment, comment-edit, created, closed, status, overdue.

// When one task has several changes in a cycle, only the most important one is kept.
const PRIORITY = { mention: 0, assigned: 1, comment: 2, 'comment-edit': 3, created: 4, closed: 5, status: 6, overdue: 7 };

const DEFAULT_SCOPE = { assignee: true, cc: true, author: true };

function memberIds(list) {
  return new Set((list || []).map((u) => u.member?.organizationMemberId).filter(Boolean).map(String));
}

const assigneeIds = (post) => memberIds(post?.users?.to);
const ccIds = (post) => memberIds(post?.users?.cc);

function authorId(post) {
  const id = post?.users?.from?.member?.organizationMemberId;
  return id ? String(id) : null;
}

/** Whether a task is "mine" for notifications: assignee, CC or author, as enabled in scope. */
function isRelated(post, meId, scope = DEFAULT_SCOPE) {
  if (!meId || !post) return false;
  return (
    (scope.assignee && assigneeIds(post).has(meId)) ||
    (scope.cc && ccIds(post).has(meId)) ||
    (scope.author && authorId(post) === meId)
  );
}

function workflowKey(post) {
  return `${post.workflowClass}:${post.workflow?.id || post.workflow?.name || ''}`;
}

const timeOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const after = (iso, since) => since !== null && timeOf(iso) !== null && timeOf(iso) > since;

/**
 * Compares the previous open-task map with a fresh fetch.
 * @param {Map<string, object>|null} prevOpen  raw posts by id from the last full fetch; null = baseline (no events)
 * @param {object[]} nextOpen                   raw open posts now
 * @param {object[]} recentlyClosed             raw closed posts updated recently
 * @param {{ meId: string|null, since: number|null, scope?: object }} ctx  since = server-time watermark before this fetch
 * @returns {{ type: string, post: object, from?: string }[]}
 */
function diffPosts(prevOpen, nextOpen, recentlyClosed, { meId, since, scope = DEFAULT_SCOPE }) {
  if (!prevOpen) return [];
  const events = [];

  for (const post of nextOpen) {
    const id = String(post.id);
    const prev = prevOpen.get(id);
    const assigned = Boolean(meId) && assigneeIds(post).has(meId);

    if (!prev) {
      // Not seen before: a new task, or one that just became visible to us.
      if (assigned && after(post.updatedAt || post.createdAt, since)) events.push({ type: 'assigned', post });
      else if (after(post.createdAt, since) && authorId(post) !== meId) events.push({ type: 'created', post });
      continue;
    }

    const wasAssigned = Boolean(meId) && assigneeIds(prev).has(meId);
    if (assigned && !wasAssigned) events.push({ type: 'assigned', post });
    else if (isRelated(post, meId, scope) && workflowKey(prev) !== workflowKey(post)) {
      events.push({ type: 'status', post, from: prev.workflow?.name || '' });
    }
  }

  for (const post of recentlyClosed) {
    const prev = prevOpen.get(String(post.id));
    if (prev && isRelated(prev, meId, scope)) events.push({ type: 'closed', post, from: prev.workflow?.name || '' });
  }

  return dedupe(events);
}

/**
 * Tasks that may have new comments: updated after the watermark and changed since we last saw them.
 * Open tasks we did not know count only if they were created after the watermark (truly new);
 * closed tasks count only if they were open last time (comments on long-closed tasks are skipped).
 * Returns { post, since, isNew } where since is the time after which comments are new.
 */
function commentCandidates(prevOpen, open, closed, since) {
  if (!prevOpen || since === null) return [];
  const seen = new Set();
  const out = [];
  const consider = (post, isClosed) => {
    const id = String(post.id);
    if (seen.has(id) || !after(post.updatedAt, since)) return;
    seen.add(id);
    const prev = prevOpen.get(id);
    if (!prev) {
      if (!isClosed && after(post.createdAt, since)) out.push({ post, since, isNew: true });
      return;
    }
    const prevTime = timeOf(prev.updatedAt);
    if (prevTime !== null && prevTime >= timeOf(post.updatedAt)) return;
    out.push({ post, since: Math.max(since, prevTime ?? since), isNew: false });
  };
  for (const post of open) consider(post, false);
  for (const post of closed) consider(post, true);
  return out.sort((a, b) => timeOf(b.post.updatedAt) - timeOf(a.post.updatedAt));
}

/** True if Dooray markdown mentions the member: [@name](dooray://<tenant>/members/<id>) */
function mentions(markdown, meId) {
  return Boolean(meId) && String(markdown || '').includes(`/members/${meId}`);
}

/** Plain-text preview of Dooray markdown: mentions become @name, links and tags are dropped. */
function preview(markdown, max = 120) {
  return String(markdown || '')
    .replace(/\[(@[^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Builds at most one event from a task's recent comment logs.
 * @param {object[]} logs  newest first, as returned by the logs API
 * @returns {{ type: 'mention'|'comment', post, comment: { id, author, text, count } } | null}
 */
function commentEvent(post, logs, { meId, since, wantComment, wantMention }) {
  const fresh = (logs || []).filter(
    (log) =>
      log.type === 'comment' &&
      after(log.createdAt, since) &&
      String(log.creator?.member?.organizationMemberId || '') !== String(meId)
  );
  if (!fresh.length) return null;

  const mention = wantMention ? fresh.find((log) => mentions(log.body?.content, meId)) : null;
  const pick = mention || (wantComment ? fresh[0] : null);
  if (!pick) return null;
  return {
    type: mention ? 'mention' : 'comment',
    post,
    comment: {
      id: String(pick.id),
      authorId: String(pick.creator?.member?.organizationMemberId || ''),
      author: pick.creator?.member?.name || '',
      text: preview(pick.body?.content),
      count: fresh.length,
    },
  };
}

/** Cheap content fingerprint of a comment body (the API exposes no edit stamp). */
function fingerprint(markdown) {
  const text = String(markdown || '');
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

const MAX_SEEN_COMMENTS = 500;

/**
 * Finds the newest comment by someone else that changed since we last read it, then records every
 * comment of this read in `seen` (commentId -> { hash, mentioned }, insertion-ordered, bounded).
 * Comments never seen before are only recorded: a new comment is not an edit.
 * @returns {{ type: 'mention'|'comment-edit', post, comment } | null}
 */
function editEvent(post, logs, seen, { meId, wantMention }) {
  let found = null;
  for (const log of logs || []) {
    if (log.type !== 'comment') continue;
    const id = String(log.id);
    const hash = fingerprint(log.body?.content);
    const mentioned = mentions(log.body?.content, meId);
    const prev = seen.get(id);
    const creatorId = String(log.creator?.member?.organizationMemberId || '');
    if (!found && prev && prev.hash !== hash && creatorId !== String(meId)) {
      const addedMention = wantMention && mentioned && !prev.mentioned;
      found = {
        type: addedMention ? 'mention' : 'comment-edit',
        post,
        comment: { id, authorId: creatorId, author: log.creator?.member?.name || '', text: preview(log.body?.content), count: 1, edited: true },
      };
    }
    seen.delete(id);
    seen.set(id, { hash, mentioned });
  }
  while (seen.size > MAX_SEEN_COMMENTS) seen.delete(seen.keys().next().value);
  return found;
}

/**
 * Tasks in scope that crossed their deadline since the last cycle.
 * @param {Map<string, string>|null} prevStates  taskId -> dueState from the last cycle; null = baseline
 * @param {object[]} tasks                      contract tasks in scope from this cycle
 */
function overdueTransitions(prevStates, tasks) {
  if (!prevStates) return [];
  return tasks
    .filter((t) => t.dueState === 'overdue' && prevStates.has(t.id) && prevStates.get(t.id) !== 'overdue')
    .map((task) => ({ type: 'overdue', task }));
}

function dedupe(events) {
  const best = new Map();
  for (const e of events) {
    const id = String(e.post?.id ?? e.task?.id);
    const current = best.get(id);
    if (!current || PRIORITY[e.type] < PRIORITY[current.type]) best.set(id, e);
  }
  return [...best.values()];
}

module.exports = {
  PRIORITY,
  DEFAULT_SCOPE,
  isRelated,
  authorId,
  diffPosts,
  commentCandidates,
  commentEvent,
  editEvent,
  fingerprint,
  mentions,
  preview,
  overdueTransitions,
  dedupe,
};
