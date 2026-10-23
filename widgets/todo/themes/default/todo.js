// Theme contract v1. Task content only enters the DOM through textContent.
const W = window.widget;
const $ = (id) => document.getElementById(id);
let state = null;
let showCompleted = false;
let dragging = null;
let listEditMode = null;

const label = (key) => state?.labels?.[key] || key;
const dayKey = (timestamp) => {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};
function dueText(task) {
  if (!task.dueAt) return '';
  const when = new Date(task.dueAt);
  const today = dayKey(Date.now());
  const nextDay = new Date(); nextDay.setDate(nextDay.getDate() + 1);
  const tomorrow = dayKey(nextDay.getTime());
  const date = dayKey(task.dueAt) === today ? label('today') : dayKey(task.dueAt) === tomorrow ? label('tomorrow')
    : when.toLocaleDateString(state.locale, { month: 'short', day: 'numeric', weekday: 'short' });
  const time = task.dateOnly ? '' : ` ${when.toLocaleTimeString(state.locale, { hour: 'numeric', minute: '2-digit' })}`;
  return `${task.repeatWeekday !== null ? `${label('weekly')} · ` : ''}${date}${time}`;
}
function setError(message = '') { $('error').textContent = message; }
function applyResult(result) {
  if (!result?.ok) { if (result) setError(result.message || ''); return false; }
  setError();
  if (result.result) render(result.result);
  return true;
}
async function call(method, ...args) { return applyResult(await method(...args)); }

function makeTask(task) {
  const row = document.createElement('li');
  row.className = 'task';
  row.dataset.id = task.id;
  row.draggable = !task.completedAt;
  if (task.completedAt) row.classList.add('completed');
  if (task.dueAt && !task.completedAt) {
    if ((!task.dateOnly && task.dueAt < Date.now()) || (task.dateOnly && dayKey(task.dueAt) < dayKey(Date.now()))) row.classList.add('overdue');
    else if (dayKey(task.dueAt) === dayKey(Date.now())) row.classList.add('today');
  }
  const check = document.createElement('input');
  check.type = 'checkbox'; check.className = 'task-check'; check.checked = Boolean(task.completedAt);
  check.setAttribute('aria-label', `${label('done')}: ${task.title}`);
  check.addEventListener('change', () => call(W.api.tasks.toggle, task.id));
  const body = document.createElement('div'); body.className = 'task-body';
  const title = document.createElement('span'); title.className = 'task-title'; title.textContent = task.title;
  body.append(title);
  const due = dueText(task);
  if (due) { const meta = document.createElement('span'); meta.className = 'task-meta'; meta.textContent = due; body.append(meta); }
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'task-remove';
  remove.textContent = '×'; remove.title = label('delete'); remove.setAttribute('aria-label', `${label('delete')}: ${task.title}`);
  remove.addEventListener('click', () => call(W.api.tasks.remove, task.id));
  row.append(check, body, remove);
  row.addEventListener('dragstart', (event) => { dragging = task.id; row.classList.add('dragging'); event.dataTransfer.setData('text/plain', task.id); });
  row.addEventListener('dragend', () => { dragging = null; row.classList.remove('dragging'); });
  row.addEventListener('dragover', (event) => {
    if (dragging && dragging !== task.id && !task.completedAt) { event.preventDefault(); row.classList.add('drop-before'); }
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
  row.addEventListener('drop', (event) => {
    event.preventDefault(); row.classList.remove('drop-before');
    if (dragging && dragging !== task.id) call(W.api.tasks.reorder, dragging, task.id);
  });
  return row;
}

function render(next) {
  state = next;
  document.documentElement.lang = next.locale || 'ko';
  document.title = label('widget');
  $('heading').textContent = label('widget');
  $('listLabel').textContent = label('lists');
  $('entry').placeholder = label('addPlaceholder');
  $('add').title = label('add'); $('add').setAttribute('aria-label', label('add'));
  $('addList').title = label('newList'); $('renameList').title = label('rename'); $('removeList').title = label('removeList');
  $('addList').setAttribute('aria-label', label('newList'));
  $('renameList').setAttribute('aria-label', label('rename'));
  $('removeList').setAttribute('aria-label', label('removeList'));
  $('menu').setAttribute('aria-label', label('settingsDisplay'));
  $('listName').placeholder = label('listName');
  $('saveList').textContent = label('save'); $('cancelList').textContent = label('cancel');
  $('removeQuestion').textContent = label('removeListConfirm');
  $('confirmRemove').textContent = label('delete'); $('cancelRemove').textContent = label('cancel');
  $('activeHeading').textContent = label('active');
  const selected = $('lists'); selected.replaceChildren();
  for (const list of next.lists) {
    const option = document.createElement('option'); option.value = list.id; option.textContent = list.name; selected.append(option);
  }
  selected.value = next.selectedListId;
  $('removeList').disabled = next.lists.length <= 1;
  const tasks = next.tasks.filter((task) => task.listId === next.selectedListId);
  const active = tasks.filter((task) => !task.completedAt);
  const completed = tasks.filter((task) => task.completedAt);
  $('active').replaceChildren(...active.map(makeTask));
  $('empty').textContent = active.length ? '' : label('empty');
  $('completedToggle').hidden = !completed.length;
  $('completedToggle').textContent = `${showCompleted ? '▾' : '▸'} ${label('completed')} (${completed.length})`;
  $('completedToggle').setAttribute('aria-expanded', String(showCompleted));
  $('completed').hidden = !showCompleted;
  if (showCompleted) $('completed').replaceChildren(...completed.map(makeTask));
}

$('menu').addEventListener('click', () => W.window.openMenu());
window.addEventListener('contextmenu', (event) => { event.preventDefault(); W.window.openMenu(); });
$('quickAdd').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('entry');
  if (await call(W.api.tasks.add, input.value)) input.value = '';
  input.focus();
});
$('lists').addEventListener('change', (event) => call(W.api.lists.select, event.target.value));
$('addList').addEventListener('click', () => {
  listEditMode = 'add'; $('removeConfirm').hidden = true; $('listEditor').hidden = false; $('listName').value = ''; $('listName').focus();
});
$('renameList').addEventListener('click', () => {
  listEditMode = 'rename'; $('removeConfirm').hidden = true; $('listEditor').hidden = false;
  $('listName').value = state?.lists.find((list) => list.id === state.selectedListId)?.name || ''; $('listName').focus();
});
$('listEditor').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('listName').value;
  const result = listEditMode === 'rename' ? await call(W.api.lists.rename, state.selectedListId, name) : await call(W.api.lists.add, name);
  if (result) { listEditMode = null; $('listEditor').hidden = true; }
});
$('cancelList').addEventListener('click', () => { listEditMode = null; $('listEditor').hidden = true; setError(); });
$('removeList').addEventListener('click', () => { $('listEditor').hidden = true; $('removeConfirm').hidden = false; });
$('confirmRemove').addEventListener('click', async () => {
  if (await call(W.api.lists.remove, state.selectedListId)) $('removeConfirm').hidden = true;
});
$('cancelRemove').addEventListener('click', () => { $('removeConfirm').hidden = true; });
$('completedToggle').addEventListener('click', () => { showCompleted = !showCompleted; render(state); });
$('active').addEventListener('dragover', (event) => { if (dragging) event.preventDefault(); });
$('active').addEventListener('drop', (event) => {
  if (event.target === $('active') && dragging) { event.preventDefault(); call(W.api.tasks.reorder, dragging, null); }
});
W.on('state', render);
W.api.getState().then((result) => { if (result?.ok) render(result.result); });
