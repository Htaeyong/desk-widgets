// Where "할 일에 추가" goes (#111), the same rule as the Dooray widget's (widgets share no code, #40).
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

module.exports = { todoTargetOf, TARGETS };
