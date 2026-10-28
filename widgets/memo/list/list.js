// Memo list (#75). Shows what the widget sends ("list" events); every action is a call to the widget.
(() => {
  const api = window.memo;
  const $ = (id) => document.getElementById(id);
  let state = { items: [], view: 'memos', dir: '', query: '' };
  let searchTimer = null;

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

  function render() {
    const archive = state.view === 'archive';
    $('tabMemos').classList.toggle('on', !archive);
    $('tabArchive').classList.toggle('on', archive);
    const items = state.items.filter((m) => m.archived === archive);
    const ul = $('items');
    ul.textContent = '';
    for (const m of items) {
      const li = document.createElement('li');
      li.className = `item${m.open ? ' open' : ''}${m.listPinned ? ' pinned' : ''}`;
      const sw = document.createElement('span');
      sw.className = `swatch ${m.color}`;
      const text = document.createElement('div');
      text.className = 'text';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = m.title;
      if (m.ext === 'txt') name.append(badge('.txt'));
      if (m.conflictCopy) name.append(badge('충돌 사본'));
      if (m.tooBig) name.append(badge('너무 큼'));
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = m.preview || '(빈 노트)';
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
      } else {
        acts.append(button('pin', '📌', m.listPinned ? '목록 위 고정 풀기' : '목록 맨 위에 고정', () => api.call('pin', { id: m.id })));
        if (m.open) acts.append(button('', '⊟', '창 닫기', () => api.call('hide', { id: m.id })));
        acts.append(button('', '🗄', '보관함으로', () => api.call('archive', { id: m.id })));
      }
      acts.append(button('', '🗑', '휴지통으로', () => api.call('trash', { id: m.id })));
      li.append(sw, text, acts);
      li.title = archive ? '보관함의 노트는 꺼낸 뒤 열 수 있습니다.' : m.open ? '눌러서 노트 창으로 가기' : '눌러서 노트 열기';
      if (!archive && !m.tooBig) li.addEventListener('click', () => api.call('open', { id: m.id }));
      ul.append(li);
    }
    const empty = $('empty');
    empty.hidden = items.length > 0;
    empty.textContent = state.query ? '찾는 노트가 없습니다.' : archive ? '보관함이 비어 있습니다.' : '노트가 없습니다. + 를 눌러 새 노트를 만드세요.';
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

  $('noticeClose').addEventListener('click', () => ($('notice').hidden = true));
  $('btnNew').addEventListener('click', () => api.call('new'));
  $('btnFolder').addEventListener('click', () => api.call('openFolder'));
  $('btnSettings').addEventListener('click', () => api.call('settings'));
  $('btnClose').addEventListener('click', () => api.call('close'));
  $('tabMemos').addEventListener('click', () => api.call('view', { view: 'memos' }).then(apply));
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
    else if (name === 'notice') {
      $('noticeText').textContent = p.message;
      $('notice').hidden = false;
    }
  });

  api.call('init').then((r) => {
    if (r?.style) applyStyle(r.style);
    if (r?.notice) {
      $('noticeText').textContent = r.notice;
      $('notice').hidden = false;
    }
    $('search').value = r?.query || '';
    apply(r);
  });
})();
