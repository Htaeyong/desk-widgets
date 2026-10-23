// Pure todo state operations; array order is the user's drag order within a list.
const { parseQuickInput, nextRepeat } = require('./dates');
const { t } = require('../kit/i18n');

const LIMITS = Object.freeze({ lists: 30, tasks: 2000, title: 240, listName: 60, snoozeMin: 1, snoozeMax: 120 });
const DEFAULTS = Object.freeze({
  alwaysOnTop: false, themeId: 'default', themeOpacity: {},
  lists: [{ id: 'inbox', name: '' }], selectedListId: 'inbox', tasks: [], snoozeMinutes: 10,
  receiveDooray: false, receiveMail: false, shareCalendar: false,
});
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const integer = (value) => Number.isInteger(value) && value >= 0;
const validDate = (value) => Number.isSafeInteger(value) && value > 0;
const clean = (value, length) => String(value || '').trim().slice(0, length);
const SOURCE_IDS = new Set(['dooray', 'mail']);
function sanitizeSource(value) {
  if (!value || !SOURCE_IDS.has(value.widgetId) || typeof value.itemId !== 'string') return null;
  const itemId = clean(value.itemId, 256);
  if (!itemId) return null;
  const url = typeof value.url === 'string' && /^https:\/\//i.test(value.url) ? value.url.slice(0, 2048) : null;
  return { widgetId: value.widgetId, itemId, url, label: clean(value.label, 120) || null };
}

function sanitize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const lists = [];
  for (const item of Array.isArray(source.lists) ? source.lists : []) {
    if (!ID.test(item?.id) || lists.some((list) => list.id === item.id)) continue;
    lists.push({ id: item.id, name: clean(item.name, LIMITS.listName) });
    if (lists.length >= LIMITS.lists) break;
  }
  if (!lists.length) lists.push({ id: 'inbox', name: '' });
  const ids = new Set(lists.map((list) => list.id));
  const tasks = [];
  for (const item of Array.isArray(source.tasks) ? source.tasks : []) {
    if (!ID.test(item?.id) || tasks.some((task) => task.id === item.id) || !ids.has(item.listId)) continue;
    const title = clean(item.title, LIMITS.title);
    if (!title) continue;
    const dueAt = validDate(item.dueAt) ? item.dueAt : null;
    const repeatWeekday = integer(item.repeatWeekday) && item.repeatWeekday <= 6 && dueAt ? item.repeatWeekday : null;
    tasks.push({
      id: item.id, listId: item.listId, title, dueAt, dateOnly: Boolean(item.dateOnly && dueAt), repeatWeekday,
      completedAt: validDate(item.completedAt) ? item.completedAt : null,
      remindedFor: validDate(item.remindedFor) ? item.remindedFor : null,
      snoozedUntil: validDate(item.snoozedUntil) ? item.snoozedUntil : null,
      createdAt: validDate(item.createdAt) ? item.createdAt : Date.now(),
      source: sanitizeSource(item.source),
    });
    if (tasks.length >= LIMITS.tasks) break;
  }
  const snooze = Number(source.snoozeMinutes);
  return {
    ...source,
    alwaysOnTop: Boolean(source.alwaysOnTop),
    themeId: ID.test(source.themeId) ? source.themeId : DEFAULTS.themeId,
    themeOpacity: source.themeOpacity && typeof source.themeOpacity === 'object' && !Array.isArray(source.themeOpacity) ? source.themeOpacity : {},
    lists, tasks,
    selectedListId: ids.has(source.selectedListId) ? source.selectedListId : lists[0].id,
    snoozeMinutes: Number.isFinite(snooze) ? Math.min(LIMITS.snoozeMax, Math.max(LIMITS.snoozeMin, Math.round(snooze))) : DEFAULTS.snoozeMinutes,
    receiveDooray: Boolean(source.receiveDooray),
    receiveMail: Boolean(source.receiveMail),
    shareCalendar: Boolean(source.shareCalendar),
  };
}

const result = (state, value = {}) => ({ ok: true, state: sanitize(state), ...value });
const failure = (locale, key) => ({ ok: false, message: t(locale, key) });

function addTask(state, input, now, locale, id) {
  if (state.tasks.length >= LIMITS.tasks) return failure(locale, 'taskLimit');
  const parsed = parseQuickInput(input, new Date(now));
  if (parsed.error) return failure(locale, parsed.error);
  const title = clean(parsed.title, LIMITS.title);
  if (!title) return failure(locale, 'noTitle');
  const task = { id, listId: state.selectedListId, title, dueAt: parsed.dueAt, dateOnly: parsed.dateOnly,
    repeatWeekday: parsed.repeatWeekday, completedAt: null, remindedFor: null, snoozedUntil: null, createdAt: now };
  return result({ ...state, tasks: [...state.tasks, task] }, { task });
}

/** Imports one chosen source item without interpreting date phrases inside its title. */
function addExternalTask(state, input, now, locale, id) {
  const source = sanitizeSource(input?.source);
  if (!source) return failure(locale, 'invalidSource');
  const existing = state.tasks.find((task) => task.source?.widgetId === source.widgetId && task.source.itemId === source.itemId);
  if (existing) return { ok: true, state, task: existing, existing: true };
  if (state.tasks.length >= LIMITS.tasks) return failure(locale, 'taskLimit');
  const title = clean(input?.title, LIMITS.title);
  if (!title) return failure(locale, 'noTitle');
  const dueAt = input?.dueAt == null ? null : input.dueAt;
  if (dueAt !== null && !validDate(dueAt)) return failure(locale, 'invalidDate');
  const task = { id, listId: state.selectedListId, title, dueAt, dateOnly: Boolean(dueAt && input.dateOnly),
    repeatWeekday: null, completedAt: null, remindedFor: null, snoozedUntil: null, createdAt: now, source };
  return result({ ...state, tasks: [...state.tasks, task] }, { task, existing: false });
}

/** Changes only the due date; Calendar remains a view over this stored task. */
function updateTaskDue(state, taskId, dueAt, dateOnly, locale) {
  if (typeof taskId !== 'string' || !state.tasks.some((task) => task.id === taskId)) return failure(locale, 'noTask');
  if (dueAt !== null && !validDate(dueAt)) return failure(locale, 'invalidDate');
  if (typeof dateOnly !== 'boolean') return failure(locale, 'invalidDate');
  const tasks = state.tasks.map((task) => task.id === taskId ? { ...task, dueAt,
    dateOnly: Boolean(dueAt && dateOnly), repeatWeekday: null, remindedFor: null, snoozedUntil: null } : task);
  return result({ ...state, tasks }, { task: tasks.find((task) => task.id === taskId) });
}

function toggleTask(state, id, now, locale) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return failure(locale, 'noTask');
  const tasks = state.tasks.map((item) => {
    if (item.id !== id) return item;
    if (item.completedAt) return { ...item, completedAt: null };
    if (item.repeatWeekday !== null) return { ...item, dueAt: nextRepeat(item, now), remindedFor: null, snoozedUntil: null };
    return { ...item, completedAt: now, snoozedUntil: null };
  });
  return result({ ...state, tasks });
}

function removeTask(state, id, locale) {
  if (!state.tasks.some((task) => task.id === id)) return failure(locale, 'noTask');
  return result({ ...state, tasks: state.tasks.filter((task) => task.id !== id) });
}

function reorderTask(state, id, beforeId, locale) {
  const task = state.tasks.find((item) => item.id === id);
  const before = beforeId ? state.tasks.find((item) => item.id === beforeId) : null;
  if (!task || task.listId !== state.selectedListId || (beforeId && (!before || before.listId !== task.listId))) return failure(locale, 'noTask');
  const rest = state.tasks.filter((item) => item.id !== id);
  if (!beforeId) {
    const last = rest.findLastIndex((item) => item.listId === task.listId);
    rest.splice(last + 1, 0, task);
  } else rest.splice(rest.findIndex((item) => item.id === beforeId), 0, task);
  return result({ ...state, tasks: rest });
}

function addList(state, name, locale, id) {
  const value = clean(name, LIMITS.listName);
  if (!value) return failure(locale, 'enterListName');
  if (state.lists.length >= LIMITS.lists) return failure(locale, 'listLimit');
  if (state.lists.some((item) => (item.name || t(locale, 'defaultList')).toLocaleLowerCase() === value.toLocaleLowerCase())) return failure(locale, 'duplicateList');
  return result({ ...state, lists: [...state.lists, { id, name: value }], selectedListId: id });
}
function renameList(state, id, name, locale) {
  const value = clean(name, LIMITS.listName);
  if (!value) return failure(locale, 'enterListName');
  if (!state.lists.some((list) => list.id === id)) return failure(locale, 'noList');
  if (state.lists.some((list) => list.id !== id && (list.name || t(locale, 'defaultList')).toLocaleLowerCase() === value.toLocaleLowerCase())) return failure(locale, 'duplicateList');
  return result({ ...state, lists: state.lists.map((list) => list.id === id ? { ...list, name: value } : list) });
}
function removeList(state, id, locale) {
  if (!state.lists.some((list) => list.id === id)) return failure(locale, 'noList');
  const lists = state.lists.filter((list) => list.id !== id);
  if (!lists.length) return failure(locale, 'listLimit');
  return result({ ...state, lists, tasks: state.tasks.filter((task) => task.listId !== id),
    selectedListId: state.selectedListId === id ? lists[0].id : state.selectedListId });
}
function selectList(state, id, locale) {
  if (!state.lists.some((list) => list.id === id)) return failure(locale, 'noList');
  return result({ ...state, selectedListId: id });
}

module.exports = { LIMITS, DEFAULTS, sanitize, addTask, addExternalTask, updateTaskDue,
  toggleTask, removeTask, reorderTask, addList, renameList, removeList, selectList };
