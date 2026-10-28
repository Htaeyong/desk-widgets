/** Converts a Dooray deadline into Todo's epoch-millisecond deadline without moving a date-only day. */
function todoDeadline(task) {
  const raw = String(task?.dueDate || '');
  const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(raw);
  // Dooray encodes a date-only deadline as a local-midnight ISO instant.
  const dateOnly = plainDate || (Number.isFinite(parsed.getTime()) && parsed.getHours() === 0
    && parsed.getMinutes() === 0 && parsed.getSeconds() === 0 && parsed.getMilliseconds() === 0);
  const day = plainDate ? new Date(`${raw}T00:00:00`) : parsed;
  const at = dateOnly ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59).getTime()
    : Date.parse(task?.deadline || raw);
  return Number.isSafeInteger(at) && at > 0 ? { dueAt: at, dateOnly } : { dueAt: null, dateOnly: false };
}

/** The two widgets that can take "할 일에 추가" (#111): 할 일 노트 (todonote, new) and the to-do list widget. */
const TARGETS = {
  todonote: { method: 'notes.addExternal', capability: 'notes-receive-external', missing: '할 일 노트 위젯을 설치하고 사용 상태로 켜 주세요.' },
  todo: { method: 'tasks.addExternal', capability: 'todo-receive-external', missing: '할 일 위젯을 설치하고 사용 상태로 켜 주세요.' },
};

/**
 * Which widget gets the item: 할 일 노트 when it is installed (an engine with API 1.7 lets it receive), else the to-do
 * list. With both installed (the sticky notes widget is never a target), `choice` ('todonote' | 'todo', the setting,
 * 할 일 노트 by default) decides, unless only the other one is running. { id, both }.
 */
function todoTargetOf(integrations, choice) {
  const notes = integrations?.status?.('todonote');
  const todo = integrations?.status?.('todo');
  const notesOk = Boolean(notes?.installed && notes.capabilities?.includes(TARGETS.todonote.capability));
  const both = notesOk && Boolean(todo?.installed);
  if (!notesOk) return { id: 'todo', both };
  if (!both) return { id: 'todonote', both };
  const wanted = choice === 'todo' ? 'todo' : 'todonote';
  const other = wanted === 'todo' ? 'todonote' : 'todo';
  const running = (id) => Boolean((id === 'todo' ? todo : notes)?.running);
  return { id: !running(wanted) && running(other) ? other : wanted, both };
}

module.exports = { todoDeadline, todoTargetOf, TARGETS };
