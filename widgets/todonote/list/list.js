// Memo list (#75). Shows what the widget sends ("list" events); every action is a call to the widget.
// Four views (#111, design 2.4): notes, to-dos (grouped by due state), completed notes, the archive.
(() => {
  const api = window.memo;
  const $ = (id) => document.getElementById(id);
  let state = { items: [], view: 'memos', dir: '', query: '' };
  let searchTimer = null;
  let undoId = null;
  const GROUPS = [
    ['overdue', '지남'],
    ['today', '오늘'],
    ['soon', '곧'],
    ['later', '나중'],
  ];
  const isTodo = (m) => m.todo?.due && !m.done && !m.archived && !m.conflictCopy && m.todo.state !== 'done';
  const VIEWS = {
    memos: (m) => !m.archived && !m.done,
    todo: isTodo,
    done: (m) => m.done,
    archive: (m) => m.archived,
  };

  function button(cls, label, title, run) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  }

  function chip(todo) {
    const c = document.createElement('span');
    c.className = `chip ${todo.state || ''}`;
    c.textContent = todo.chip;
    c.title = todo.dueText + (todo.repeat ? ` · ↻ ${todo.repeat}` : '');
    return c;
  }

  function header(text) {
    const li = document.createElement('li');
    li.className = 'group';
    li.textContent = text;
    return li;
  }

  function render() {
    const viewName = VIEWS[state.view] ? state.view : 'memos';
    const archive = viewName === 'archive';
    const done = viewName === 'done';
    const todoView = viewName === 'todo';
    for (const [tab, name] of [['tabMemos', 'memos'], ['tabTodo', 'todo'], ['tabDone', 'done'], ['tabArchive', 'archive']]) $(tab).classList.toggle('on', viewName === name);
    const pressing = state.items.filter((m) => isTodo(m) && (m.todo.state === 'overdue' || m.todo.state === 'today')).length;
    $('todoCount').textContent = pressing ? String(pressing) : '';
    let items = state.items.filter(VIEWS[viewName]);
    if (todoView) items = items.sort((a, b) => a.dueAt - b.dueAt || a.title.localeCompare(b.title, 'ko'));
    if (done) items = items.sort((a, b) => (b.completedAt || b.mtimeMs) - (a.completedAt || a.mtimeMs));
    const ul = $('items');
    ul.textContent = '';
    let group = null;
    for (const m of items) {
      if (todoView) {
        const g = m.todo.state === 'later' && m.todo.repeat ? 'later' : m.todo.state;
        if (g !== group) {
          group = g;
          const label = GROUPS.find(([k]) => k === g)?.[1] || '';
          ul.append(header(g === 'later' && items.some((x) => x.todo.state === 'later' && x.todo.repeat) ? `${label} · 반복 예정` : label));
        }
      }
      const li = document.createElement('li');
      li.className = `item${m.open ? ' open' : ''}${m.listPinned ? ' pinned' : ''}`;
      const sw = document.createElement('span');
      sw.className = `swatch ${m.color}`;
      const text = document.createElement('div');
      text.className = 'text';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = m.title;
      if (m.todo?.repeat && !done) name.append(badge('↻'));
      if (m.ext === 'txt') name.append(badge('.txt'));
      if (m.conflictCopy) name.append(badge('충돌 사본'));
      if (m.tooBig) name.append(badge('너무 큼'));
      if (done && !m.completedAt) name.append(badge('완료 폴더에 있지만 완료 안 됨'));
      const preview = document.createElement('div');
      preview.className = 'preview';
      if (done) {
        const when = m.completedAt ? new Date(m.completedAt) : null;
        preview.textContent = [when ? `완료 ${when.getMonth() + 1}/${when.getDate()}` : '', m.deleteText].filter(Boolean).join(' · ') || m.preview || '';
      } else preview.textContent = m.preview || '(빈 노트)';
      text.append(name, preview);
      // Memos that link here ([[이 노트]]): each name opens that memo.
      if (m.backlinks?.length) {
        const back = document.createElement('div');
        back.className = 'backlinks';
        back.append('← ');
        m.backlinks.forEach((b, k) => {
          if (k) back.append(', ');
          const link = document.createElement('span');
          link.className = 'backlink';
          link.textContent = b.title;
          link.title = b.archived ? `${b.title} (보관함)` : `${b.title} 열기 — 이 노트를 가리킴`;
          link.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!b.archived) api.call('open', { id: b.id });
          });
          back.append(link);
        });
        text.append(back);
      }
      const acts = document.createElement('div');
      acts.className = 'acts';
      if (archive) {
        acts.append(button('', '↩', '보관함에서 꺼내기', () => api.call('restore', { id: m.id })));
      } else if (done) {
        acts.append(button('', '↩', '되살리기 (노트 폴더로, 창이 열림)', () => api.call('uncomplete', { id: m.id })));
      } else {
        acts.append(button('pin', '📌', m.listPinned ? '목록 위 고정 풀기' : '목록 맨 위에 고정', () => api.call('pin', { id: m.id })));
        if (m.open) acts.append(button('', '⊟', '창 닫기', () => api.call('hide', { id: m.id })));
        acts.append(button('', '🗄', '보관함으로', () => api.call('archive', { id: m.id })));
      }
      acts.append(button('', '🗑', '휴지통으로', () => api.call('trash', { id: m.id })));
      li.append(sw, text);
      if (m.todo && !done && !archive) li.append(chip(m.todo));
      li.append(acts);
      li.title = archive ? '보관함의 노트는 꺼낸 뒤 열 수 있습니다.' : m.open ? '눌러서 노트 창으로 가기' : '눌러서 노트 열기';
      if (!archive && !m.tooBig) li.addEventListener('click', () => api.call('open', { id: m.id }));
      if (m.todo && !archive) {
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          api.call('todoMenu', { id: m.id });
        });
      }
      ul.append(li);
    }
    const empty = $('empty');
    empty.hidden = items.length > 0;
    empty.textContent = state.query
      ? '찾는 노트가 없습니다.'
      : archive
        ? '보관함이 비어 있습니다.'
        : todoView
          ? '날짜가 걸린 노트가 없습니다. 노트 창의 ⏰ 로 날짜를 걸면 여기에 보입니다.'
          : done
            ? '완료한 노트가 없습니다.'
            : '노트가 없습니다. + 를 눌러 새 노트를 만드세요.';
    $('trashLine').hidden = !done || !state.autoDeleteDays;
    $('dir').textContent = state.dir;
    $('dir').title = `노트 폴더: ${state.dir}`;
  }

  function badge(text) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = text;
    return b;
  }

  function apply(r) {
    if (!r || r.ok === false) return;
    state = { ...state, ...r };
    render();
  }

  function applyStyle(s) {
    document.documentElement.style.setProperty('--bg-alpha', String(Math.max(0, Math.min(100, s.opacity)) / 100));
  }

  function notice(text, undo = null) {
    $('noticeText').textContent = text;
    undoId = undo;
    $('noticeUndo').hidden = !undo;
    $('notice').hidden = false;
  }

  $('noticeClose').addEventListener('click', () => ($('notice').hidden = true));
  $('noticeUndo').addEventListener('click', async () => {
    const id = undoId;
    $('notice').hidden = true;
    if (!id) return;
    const r = await api.call('undoComplete', { id });
    if (r && !r.ok && r.message) notice(r.message);
  });
  $('btnTrash').addEventListener('click', () => api.call('openTrash'));
  $('btnNew').addEventListener('click', () => api.call('new'));
  $('btnFolder').addEventListener('click', () => api.call('openFolder'));
  $('btnSettings').addEventListener('click', () => api.call('settings'));
  $('btnClose').addEventListener('click', () => api.call('close'));
  $('tabMemos').addEventListener('click', () => api.call('view', { view: 'memos' }).then(apply));
  $('tabTodo').addEventListener('click', () => api.call('view', { view: 'todo' }).then(apply));
  $('tabDone').addEventListener('click', () => api.call('view', { view: 'done' }).then(apply));
  $('tabArchive').addEventListener('click', () => api.call('view', { view: 'archive' }).then(apply));
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => api.call('search', { q: $('search').value }).then(apply), 150);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('search').value = '';
      api.call('search', { q: '' }).then(apply);
    }
  });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input')) return;
    e.preventDefault();
    api.call('menu');
  });
  addEventListener('focus', () => api.call('refresh').then(apply));

  api.on((name, p) => {
    if (name === 'list') apply(p);
    else if (name === 'style') applyStyle(p);
    else if (name === 'notice') notice(p.message);
    // "월간 보고 완료 · 되돌리기" for a few seconds (design 2.1).
    else if (name === 'done') {
      notice(`${p.title} 완료 · ${p.text}`, p.id);
      setTimeout(() => undoId === p.id && ($('notice').hidden = true), 8000);
    }
  });

  api.call('init').then((r) => {
    if (r?.style) applyStyle(r.style);
    if (r?.notice) notice(r.notice);
    $('search').value = r?.query || '';
    apply(r);
  });
})();
