// Category manager window: edit, reorder, delete categories and curate their tasks.
const $ = (id) => document.getElementById(id);
const api = window.managerApi;
const PALETTE = ['#7aa7ff', '#52d6a4', '#ffbd59', '#ff7272', '#c792ea', '#5ad1e6', '#f78fb3', '#a3b18a'];

let data = { categories: [], webUrl: '' };
let selectedId = new URLSearchParams(location.search).get('select') || null;
// An update that arrived while the user was typing; applied on blur.
let pendingUpdate = false;

function el(tag, props = {}, text) {
  const node = Object.assign(document.createElement(tag), props);
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
  clearTimeout(setStatus.timer);
  if (text) setStatus.timer = setTimeout(() => setStatus(''), 4000);
}

async function run(action, payload) {
  const res = await api.action(action, payload);
  if (!res.ok) setStatus(res.message, 'err');
  return res;
}

const selected = () => data.categories.find((c) => c.id === selectedId) || null;

// ---------- left: category list ----------

function renderList() {
  const list = $('catList');
  list.replaceChildren(
    ...data.categories.map((c) => {
      const li = el('li', { className: `cat-item ${c.id === selectedId ? 'selected' : ''}`, role: 'option' });
      li.setAttribute('aria-selected', String(c.id === selectedId));
      const dot = el('span', { className: 'dot' });
      dot.style.background = c.color;
      const count = el('span', { className: 'count', title: '지연 / 미완료' });
      if (c.counts.overdue) count.append(el('span', { className: 'over' }, String(c.counts.overdue)));
      count.append(String(c.counts.open));
      li.append(dot, el('span', { className: 'name', title: c.name }, c.name), count);
      li.addEventListener('click', () => select(c.id));
      return li;
    })
  );
  if (!data.categories.length) list.append(el('li', { className: 'hint' }, '아직 분류가 없습니다.'));
  const closedTotal = data.categories.reduce((n, c) => n + c.counts.closed, 0);
  $('cleanAll').disabled = !closedTotal;
  $('cleanAll').textContent = closedTotal ? `완료 업무 전체 정리 (${closedTotal})` : '완료 업무 전체 정리';
}

// ---------- right: selected category ----------

function renderSwatches(color) {
  $('swatches').replaceChildren(
    ...PALETTE.map((c) => {
      const b = el('button', { type: 'button', className: `swatch ${c.toLowerCase() === color.toLowerCase() ? 'on' : ''}`, title: c });
      b.style.background = c;
      b.addEventListener('click', () => updateSelected({ color: c }));
      return b;
    })
  );
  $('customColor').value = color;
}

function renderStats(c) {
  const stat = (value, label, cls = '') => {
    const box = el('div', { className: `stat ${value ? cls : ''}` });
    box.append(el('b', {}, String(value)), el('span', {}, label));
    return box;
  };
  $('stats').replaceChildren(
    stat(c.counts.open, '미완료'),
    stat(c.counts.overdue, '지연', 'err'),
    stat(c.counts.dueSoon, '마감 임박', 'warn'),
    stat(c.counts.closed, '완료')
  );
}

function dueText(t) {
  if (t.workflowClass === 'closed') return { text: '완료', cls: '' };
  if (t.dueState === 'overdue') return { text: '지연', cls: 'over' };
  if (t.dueState === 'soon') return { text: '마감 임박', cls: 'soon' };
  return null;
}

function renderTasks(c) {
  const terms = TaskSearch.parse($('query').value);
  const found = terms.length ? c.tasks.filter((t) => TaskSearch.matches(t, terms)) : c.tasks;
  $('resultInfo').textContent = !c.tasks.length
    ? '이 분류에 넣은 업무가 없습니다.'
    : terms.length
      ? `검색 결과 ${found.length}건 / 전체 ${c.tasks.length}건`
      : `업무 ${c.tasks.length}건`;

  $('taskList').replaceChildren(
    ...found.map((t) => {
      const li = el('li', { className: `task-row ${t.workflowClass === 'closed' ? 'closed' : ''}` });
      const body = el('div', { className: 'body' });
      const subject = el('button', { type: 'button', className: 'subject', title: `${t.subject}\n두레이에서 열기` });
      TaskSearch.appendHighlighted(subject, t.subject, terms);
      subject.addEventListener('click', () => api.openUrl(t.url));

      const meta = el('div', { className: 'meta' });
      const due = dueText(t);
      if (due) meta.append(el('span', { className: due.cls }, due.text), ' · ');
      if (t.stale) meta.append(el('span', { className: 'soon' }, '확인 불가'), ' · ');
      TaskSearch.appendHighlighted(meta, [t.key || t.projectName, t.workflowName, t.assignees.map((a) => a.name).join(', ') || '미지정', ...(t.tags || []).map((x) => `#${x.name}`)].filter(Boolean).join(' · '), terms);

      body.append(subject, meta);
      const remove = el('button', { type: 'button', className: 'ghost unassign', title: '이 분류에서 빼기 (업무는 그대로)' }, '빼기');
      remove.addEventListener('click', () =>
        run('setTaskCategories', { taskId: t.id, categoryIds: t.categoryIds.filter((id) => id !== c.id) })
      );
      li.append(body, remove);
      return li;
    })
  );
}

function renderDetail() {
  const c = selected();
  $('emptyDetail').hidden = Boolean(c);
  $('detailBody').hidden = !c;
  if (!c) return;

  // Do not overwrite the name while the user is editing it.
  if (document.activeElement !== $('name')) $('name').value = c.name;
  renderSwatches(c.color);
  const index = data.categories.indexOf(c);
  $('moveUp').disabled = index <= 0;
  $('moveDown').disabled = index >= data.categories.length - 1;
  $('cleanClosed').textContent = `완료 ${c.counts.closed}건 정리`;
  $('cleanClosed').disabled = !c.counts.closed;
  renderStats(c);
  renderTasks(c);
}

function render() {
  pendingUpdate = false;
  if (selectedId && !selected()) selectedId = null;
  renderList();
  renderDetail();
}

function select(id) {
  if (id === selectedId) return;
  selectedId = id;
  $('query').value = '';
  render();
}

async function updateSelected(changes) {
  const c = selected();
  if (!c) return;
  const res = await run('update', { id: c.id, ...changes });
  if (!res.ok && changes.name !== undefined) $('name').value = c.name;
  if (res.ok) setStatus('저장했습니다.', 'ok');
}

// ---------- events ----------

$('newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('newName').value;
  const res = await run('create', { name });
  if (res.ok) {
    $('newName').value = '';
    selectedId = res.result.id;
    render();
    setStatus(`'${res.result.name}' 분류를 만들었습니다.`, 'ok');
  }
});

$('name').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter') $('name').blur();
  if (e.key === 'Escape') {
    $('name').value = selected()?.name || '';
    $('name').blur();
  }
});
$('name').addEventListener('change', () => updateSelected({ name: $('name').value }));
$('customColor').addEventListener('change', () => updateSelected({ color: $('customColor').value }));
$('moveUp').addEventListener('click', () => run('move', { id: selectedId, delta: -1 }));
$('moveDown').addEventListener('click', () => run('move', { id: selectedId, delta: 1 }));

$('cleanClosed').addEventListener('click', async () => {
  const res = await run('removeClosed', { id: selectedId });
  if (res.ok) setStatus(`완료된 업무 ${res.result}건을 이 분류에서 뺐습니다.`, 'ok');
});

$('cleanAll').addEventListener('click', async () => {
  const res = await run('removeClosed', {});
  if (res.ok) setStatus(`완료된 업무 ${res.result}건을 모든 분류에서 뺐습니다.`, 'ok');
});

$('remove').addEventListener('click', async () => {
  const c = selected();
  if (!c) return;
  const ok = await api.confirm(
    `'${c.name}' 분류를 삭제할까요?`,
    c.counts.total ? `업무 ${c.counts.total}건이 이 분류에서 빠집니다. 두레이의 업무는 그대로 남습니다.` : undefined
  );
  if (!ok) return;
  const res = await run('remove', { id: c.id });
  if (res.ok) {
    selectedId = null;
    render();
    setStatus(`'${c.name}' 분류를 삭제했습니다.`, 'ok');
  }
});

$('query').addEventListener('input', () => {
  const c = selected();
  if (c) renderTasks(c);
});

// Apply deferred updates once typing is done.
document.addEventListener('focusout', () => setTimeout(() => pendingUpdate && render(), 0));

api.onUpdate((next) => {
  data = next;
  const typing = document.activeElement?.tagName === 'INPUT' && document.activeElement.type === 'text' && document.activeElement !== $('query');
  if (typing) {
    pendingUpdate = true;
    renderList();
    return;
  }
  render();
});

api.onSelect((id) => {
  selectedId = id;
  $('query').value = '';
  render();
});

api.get().then((initial) => {
  data = initial;
  if (!selectedId && data.categories.length) selectedId = data.categories[0].id;
  render();
});
