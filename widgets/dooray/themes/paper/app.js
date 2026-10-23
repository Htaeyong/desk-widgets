// Minimal theme: the smallest useful example of theme contract v1.
(async () => {
  const api = window.dooray;
  const main = document.getElementById('main');
  const ctx = await api.getContext();
  let snapshot = await api.getSnapshot();
  let openProjectId = ctx.mode === 'project' ? ctx.projectId : null;

  document.getElementById('refresh').onclick = () => api.refresh();
  document.getElementById('settings').onclick = () => api.openSettings();
  document.getElementById('close').onclick = () => api.window.close();

  const el = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text; // never innerHTML for data
    if (cls) e.className = cls;
    return e;
  };

  function overview() {
    const table = el('table');
    const head = el('tr');
    ['프로젝트', '미완료', '지연', '내 업무'].forEach((t) => head.append(el('th', t)));
    table.append(el('thead'), el('tbody'));
    table.tHead.append(head);
    for (const p of snapshot.projects.filter((x) => x.counts.open > 0)) {
      const tr = el('tr');
      tr.append(el('td', p.name), el('td', p.counts.open), el('td', p.counts.overdue, p.counts.overdue ? 'red' : ''), el('td', p.counts.mine));
      tr.onclick = () => {
        openProjectId = p.id;
        render();
      };
      table.tBodies[0].append(tr);
    }
    return [table];
  }

  function project(p) {
    const nodes = [];
    if (ctx.mode === 'overview') {
      const back = el('button', '← 전체', 'back');
      back.onclick = () => {
        openProjectId = null;
        render();
      };
      nodes.push(back);
    }
    if (!p.tasks.open.length) nodes.push(el('div', '미완료 업무가 없습니다.', 'msg'));
    for (const t of p.tasks.open) {
      const row = el('div', undefined, 'task');
      row.append(el('div', t.subject));
      const due = t.dueState === 'overdue' ? ' · 지연' : t.dueState === 'soon' ? ' · 임박' : '';
      row.append(el('small', `${t.workflowName} · ${t.assignees.map((a) => a.name).join(', ') || '미지정'}${due}`));
      if (snapshot.integrations?.todoEnabled) {
        const todo = el('button', '+', 'todo-add');
        todo.type = 'button';
        todo.title = /^en\b/i.test(navigator.language || '') ? 'Add to Todo' : '할 일에 추가';
        todo.onclick = async (event) => {
          event.stopPropagation();
          const res = await api.addToTodo(t.id);
          if (res?.ok) todo.textContent = '✓';
          else window.alert(res?.message || (/^en\b/i.test(navigator.language || '') ? 'Could not add to Todo.' : '할 일에 추가하지 못했습니다.'));
        };
        row.append(todo);
      }
      row.onclick = () => api.openUrl(t.url);
      nodes.push(row);
    }
    return nodes;
  }

  function render() {
    const s = snapshot.status;
    const p = openProjectId && snapshot.projects.find((x) => x.id === openProjectId);
    document.getElementById('title').textContent = p ? p.name : 'Dooray';
    document.getElementById('updated').textContent = s.refreshing ? '갱신 중…' : s.state === 'error' ? s.message : '';

    if (s.state === 'unconfigured') main.replaceChildren(el('div', '설정에서 도메인과 토큰을 입력하세요.', 'msg'));
    else if (!s.lastSuccessAt) main.replaceChildren(el('div', '불러오는 중…', 'msg'));
    else main.replaceChildren(...(p ? project(p) : openProjectId ? [el('div', '프로젝트를 찾을 수 없습니다.', 'msg')] : overview()));
  }

  api.onSnapshot((next) => {
    snapshot = next;
    render();
  });
  render();
})();
