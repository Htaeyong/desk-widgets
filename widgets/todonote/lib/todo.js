// To-do notes (#110 / #111): what a note's to-do keys (lib/frontmatter.js) mean at a given time. Pure functions: the
// due state and chip text, what "완료" writes, the checklist reset, reminders and auto-delete candidates.
const D = require('./dates');

const SOON_DAYS = 7;
const pad = (n) => String(n).padStart(2, '0');
const md = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const wd = (date) => D.WD[D.weekdayOf(date)];

/** 'overdue' | 'today' | 'soon' | 'later' | 'done' | null (no due). */
function stateOf(todo, now, { done = false } = {}) {
  if (!todo?.due) return null;
  if (done || todo.completedAt) return 'done';
  if (D.dueEndMs(todo.due) <= now) return 'overdue';
  const today = D.todayOf(now);
  if (todo.due.date === today) return 'today';
  return D.dayNum(todo.due.date) - D.dayNum(today) <= SOON_DAYS ? 'soon' : 'later';
}

function ago(ms) {
  const min = Math.max(1, Math.floor(ms / 60000));
  if (min < 60) return `${min}분`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}시간`;
  return `${Math.floor(min / 1440)}일`;
}

/** The chip text of the due bar and the list (design 2.1). */
function chipText(todo, now, opts = {}) {
  const state = stateOf(todo, now, opts);
  if (!state) return '';
  const { date, time } = todo.due;
  const today = D.todayOf(now);
  const t = time ? ` ${time}` : '';
  if (state === 'done') return todo.completedAt ? `완료 ${md(D.todayOf(todo.completedAt))}` : '완료';
  if (state === 'overdue') {
    const missed = D.missedCount(todo.rule, todo.due, now);
    if (missed >= 2) return `지남 · ${missed}회`;
    if (time) return `지남 · ${ago(now - D.dueMs(todo.due))}`;
    return `지남 · ${md(date)} (${date === D.addDays(today, -1) ? '어제' : wd(date)})`;
  }
  if (state === 'today') return `오늘${t}`;
  if (date === D.addDays(today, 1)) return `내일${t}`;
  if (state === 'soon') return `${wd(date)} (${md(date)})${t}`;
  return `${date.slice(0, 4) === today.slice(0, 4) ? md(date) : `${date.slice(0, 4)}/${md(date)}`}${t}`;
}

/** What the note window and the list show of a note's to-do (null for a plain note). */
function viewOf(memo, now, { allDayRemind = '09:00' } = {}) {
  const todo = memo?.todo;
  if (!todo) return null;
  const problems = (todo.problems || []).filter((p) => p.key === 'due' || p.key === 'repeat');
  if (!todo.due && !problems.length) return null;
  const done = Boolean(memo.done);
  return {
    due: todo.due ? D.formatDueValue(todo.due) : null,
    dueText: todo.due ? D.describeDue(todo.due, now) : '',
    state: stateOf(todo, now, { done }),
    chip: chipText(todo, now, { done }),
    repeat: todo.rule ? D.formatRepeat(todo.rule) : '',
    remind: todo.remind ? D.formatRemind(todo.remind) : '',
    resetChecks: todo.resetChecks,
    completedAt: todo.completedAt,
    allDayRemind,
    problems,
  };
}

// ---- 완료 ----

/**
 * Turns "- [x]" into "- [ ]" outside fenced code blocks; returns { body, count }. Only the marker changes, so the rest
 * of the text (and the user's own spacing) stays as it was.
 */
function resetChecks(body) {
  let fence = null;
  let count = 0;
  const lines = String(body).split('\n').map((line) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+)\[[xX]\]/, (_m, lead) => {
      count++;
      return `${lead}[ ]`;
    });
  });
  return { body: lines.join('\n'), count };
}

/**
 * What "완료" of a to-do note does (design 5.2 / 6.1): { patch (front matter), move ('done' | null), nextDue, reset }.
 * A repeating note gets its next due and last-done and stays in place; any other note gets completed and goes to the
 * done folder. `reset`: whether the checklist is cleared (repeating notes, reset-checks or the default).
 */
function completion(todo, now, { resetDefault = true } = {}) {
  if (!todo?.due) return null;
  if (todo.rule) {
    const next = D.nextDue(todo.rule, todo.due, now);
    if (!next) return null;
    return {
      patch: { due: D.formatDueValue(next), 'last-done': D.stampOf(now) },
      move: null,
      nextDue: next,
      reset: todo.resetChecks ?? resetDefault,
    };
  }
  return { patch: { completed: D.stampOf(now) }, move: 'done', nextDue: null, reset: false };
}

/**
 * The front matter patch for a due set in the date box / "/" command: due, repeat (normalized), remind,
 * reset-checks. Empty strings remove a key; undefined keeps it.
 */
function duePatch({ due, repeat, remind, resetChecks: reset }) {
  const patch = {};
  const parsedDue = typeof due === 'string' ? D.parseDueValue(due) : due;
  if (!parsedDue) throw new Error('알 수 없는 날짜입니다.');
  patch.due = D.formatDueValue(parsedDue);
  if (repeat !== undefined) {
    const rule = repeat ? D.parseRepeat(repeat) : null;
    if (repeat && !rule) throw new Error('알 수 없는 반복입니다.');
    patch.repeat = rule ? D.formatRepeat(rule) : null;
    if (!rule) patch['reset-checks'] = null;
  }
  if (remind !== undefined) {
    const r = remind ? D.parseRemind(remind) : null;
    if (remind && !r) throw new Error('알 수 없는 알림 시각입니다.');
    patch.remind = r ? D.formatRemind(r) : null;
  }
  if (reset !== undefined && patch.repeat !== null) patch['reset-checks'] = reset === null ? null : String(Boolean(reset));
  patch.completed = null; // a new date makes it a to-do again
  return patch;
}

/** "날짜 지우기": the note becomes a plain note again; last-done and source keys stay (design 5.4). */
const CLEAR_PATCH = Object.freeze({ due: null, repeat: null, remind: null, 'reset-checks': null, completed: null });

// ---- reminders ----

/** When a note reminds (ms) or null: open to-dos only (not done, archived or a conflict copy). */
function reminderTime(memo, { allDayRemind = '09:00' } = {}) {
  const t = memo?.todo;
  if (!t?.due || t.completedAt || memo.done || memo.archived || memo.conflictOf) return null;
  return D.remindAt(t.due, t.remind, allDayRemind);
}

/**
 * Reminders due now (design 2.3): [{ id, at }] whose time has come, within `lateMs`, not yet shown for that time.
 * `state(id)` gives { remindedFor, snoozedUntil } from the widget settings. A snooze replaces the time.
 * Also returns `missed`: ids whose reminder passed longer ago than lateMs and was never shown (the summary card).
 */
function dueReminders(memos, now, { allDayRemind, lateMs, state }) {
  const due = [];
  const missed = [];
  let next = null;
  for (const m of memos) {
    const base = reminderTime(m, { allDayRemind });
    if (base === null) continue;
    const st = state(m.id) || {};
    const at = st.snoozedUntil && st.snoozedUntil > base ? st.snoozedUntil : base;
    if (st.remindedFor === at) continue;
    if (at > now) {
      next = next === null ? at : Math.min(next, at);
      continue;
    }
    if (now - at <= lateMs) due.push({ id: m.id, at });
    else missed.push({ id: m.id, at });
  }
  return { due, missed, next };
}

// ---- auto-delete (design 6.2) ----

/**
 * Completed notes to move to the Recycle Bin: in the done folder, with our id and a valid "completed", not repeating,
 * not open; counted from the later of "completed" and the file's last change. days 0 = never. At most `limit`.
 */
function autoDeleteCandidates(memos, now, { days, openIds = new Set(), limit = 50 }) {
  if (!days) return [];
  const out = [];
  for (const m of memos) {
    if (!m.done || !m.hasFmId || m.ext !== 'md' || m.conflictOf || openIds.has(m.id)) continue;
    const t = m.todo;
    if (!t?.completedAt || t.rule || (t.problems || []).some((p) => p.key === 'repeat')) continue;
    if (now - deleteBase(m) < days * D.DAY) continue;
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/** The time auto-delete counts from: the later of completion and the last change (an edited note starts again). */
const deleteBase = (m) => Math.max(m.todo?.completedAt || 0, m.mtimeMs || 0);

/** "9일 뒤 삭제" for the done list, or '' when nothing is deleted. */
function deleteText(m, now, days) {
  if (!days || !m.todo?.completedAt || m.todo.rule || !m.hasFmId) return '';
  const left = Math.ceil((deleteBase(m) + days * D.DAY - now) / D.DAY);
  return left <= 0 ? '곧 삭제' : `${left}일 뒤 삭제`;
}

/** The calendar's snapshot item of a note (same shape as the to-do widget's tasks.snapshot). */
function snapshotItem(m) {
  const t = m.todo;
  const time = t.due.time;
  const end = D.dueMs(t.due);
  return {
    id: m.id,
    title: m.title,
    dueAt: time ? end : D.dueMs({ date: t.due.date, time: '23:59' }),
    dateOnly: !time,
    completedAt: t.completedAt || (m.done ? m.mtimeMs : null),
    repeat: t.rule ? D.formatRepeat(t.rule) : null,
    source: t.source && t.sourceId ? { widgetId: t.source, itemId: t.sourceId, url: t.sourceUrl } : null,
  };
}

module.exports = { stateOf, chipText, viewOf, resetChecks, completion, duePatch, CLEAR_PATCH, reminderTime, dueReminders, autoDeleteCandidates, deleteBase, deleteText, snapshotItem, pad };
