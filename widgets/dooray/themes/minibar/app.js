// "Mini bar" theme: one thin strip of counters; clicking one unfolds that list below (window.setSize, v1.7).
(() => {
  const api = window.dooray;
  const K = window.DoorayKit;
  const { h, highlight, dueLabel, parseQuery, searchTasks, byUrgency } = K;
  const shellEl = document.getElementById('shell');
  const barEl = document.getElementById('bar');
  const drawerEl = document.getElementById('drawer');

  const BAR_HEIGHT = 46;
  const OPEN_HEIGHT = 440;

  const TABS = [
    { key: 'overdue', label: '지연', tone: 'danger', count: (c) => c.overdue, pick: (t) => t.dueState === 'overdue' },
    { key: 'dueSoon', label: '임박', tone: 'warn', count: (c) => c.dueSoon, pick: (t) => t.dueState === 'soon' },
    { key: 'mine', label: '내 업무', tone: 'accent', count: (c) => c.mine, pick: (t) => t.isMine },
    { key: 'open', label: '미완료', tone: '', count: (c) => c.open, pick: () => true },
  ];

  const state = {
    context: null,
    snapshot: null,
    pinned: false,
    open: false,
    tab: 'overdue',
    query: '',
    deferred: false,
  };

  // Mouse back / Alt+Left: clear the search, then fold the drawer.
  K.onBackForward(
    () => {
      if (state.query) {
        state.query = '';
        render();
      } else if (state.open) setOpen(false);
    },
    () => {}
  );
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing && state.open && !state.query) setOpen(false);
  });

  const projectWindow = () => state.context?.mode === 'project';

  function project() {
    return projectWindow() ? state.snapshot.projects.find((p) => p.id === state.context.projectId) || null : null;
  }

  function counts() {
    return project()?.counts || state.snapshot.summary.counts;
  }

  function iconBtn(icon, title, onclick, extra = '') {
    return h('button', { class: `icon-btn ${extra}`, title, 'aria-label': title, icon, onclick });
  }

  async function setOpen(open) {
    state.open = open;
    if (!open) state.query = '';
    shellEl.classList.toggle('open', open);
    render();
    await api.window.setSize(window.innerWidth, open ? OPEN_HEIGHT : BAR_HEIGHT);
    if (open) drawerEl.querySelector('[data-search]')?.focus();
  }

  // ---------- bar ----------

  function renderBar() {
    const snap = state.snapshot;
    const status = K.statusInfo(snap.status);
    const c = counts();
    const ready = snap.status.state !== 'unconfigured' && (snap.status.lastSuccessAt || snap.projects.length);

    const counters = ready
      ? TABS.map((tab) =>
          h(
            'button',
            {
              class: `counter ${tab.tone} ${tab.count(c) ? '' : 'zero'} ${state.open && state.tab === tab.key ? 'on' : ''}`,
              title: `${tab.label} 목록 ${state.open && state.tab === tab.key ? '접기' : '펼치기'}`,
              onclick: () => {
                if (state.open && state.tab === tab.key) return setOpen(false);
                state.tab = tab.key;
                state.query = '';
                if (state.open) render();
                else setOpen(true);
              },
            },
            h('b', { text: tab.count(c) }),
            h('span', { text: tab.label })
          )
        )
      : [
          h('button', {
            class: 'counter',
            text: snap.status.state === 'unconfigured' ? '설정이 필요합니다 — 눌러서 설정 열기' : '불러오는 중…',
            onclick: () => snap.status.state === 'unconfigured' && api.openSettings(),
          }),
        ];

    barEl.replaceChildren(
      h(
        'span',
        { class: 'brand', title: status.text || 'Dooray' },
        h('span', { class: `dot ${status.dot}` }),
        h('span', { class: 'brand-name', text: project()?.name || 'Dooray' })
      ),
      h('span', { class: 'counters' }, counters),
      h(
        'span',
        { class: 'tools' },
        iconBtn(state.open ? 'collapse' : 'expand', state.open ? '접기' : '펼치기', () => setOpen(!state.open)),
        iconBtn('refresh', '새로고침', () => api.refresh(), snap.status.refreshing ? 'spin' : ''),
        iconBtn('close', projectWindow() ? '위젯 닫기' : '종료', () => api.window.close())
      )
    );
  }

  // ---------- drawer ----------

  function row(t, terms) {
    const due = dueLabel(t);
    return h(
      'div',
      { class: 'row', role: 'button', tabindex: '0', title: t.subject, onclick: () => api.openUrl(t.url) },
      h('span', { class: `mark ${t.dueState}` }),
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'row-title' }, highlight(t.subject, terms)),
        h(
          'span',
          { class: 'row-sub' },
          projectWindow() ? h('span', {}, highlight(t.key, terms)) : h('span', { text: t.projectName }),
          h('span', {}, highlight(t.assignees.map((a) => a.name).join(', ') || '미지정', terms))
        )
      ),
      due ? h('span', { class: `due ${t.dueState}`, text: due }) : null,
      state.snapshot?.integrations?.todoEnabled ? h('button', { class: 'todo-add', title: /^en\b/i.test(navigator.language || '') ? 'Add to Todo' : '할 일에 추가', text: '+', onclick: async (e) => { e.stopPropagation(); const res = await api.addToTodo(t.id); if (res?.ok) e.currentTarget.textContent = '✓'; else window.alert(res?.message || (/^en\b/i.test(navigator.language || '') ? 'Could not add to Todo.' : '할 일에 추가하지 못했습니다.')); } }) : null
    );
  }

  function renderDrawer() {
    if (!state.open) {
      drawerEl.replaceChildren();
      return;
    }
    const snap = state.snapshot;
    const tab = TABS.find((x) => x.key === state.tab) || TABS[0];
    const terms = parseQuery(state.query);
    const base = K.openTasks(snap, project()?.id || null);
    const list = h('div', { class: 'list' });
    const fill = () => {
      const t = parseQuery(state.query);
      const found = searchTasks(t.length ? base : base.filter(tab.pick), t).slice().sort(byUrgency);
      list.replaceChildren(
        ...(found.length
          ? found.slice(0, 200).map((task) => row(task, t.length ? t : null))
          : [h('div', { class: 'empty', text: t.length ? '검색 결과가 없습니다.' : `${tab.label} 업무가 없습니다.` })])
      );
    };
    fill();

    const search = h('input', {
      class: 'search',
      type: 'text',
      placeholder: terms.length ? '' : `전체에서 검색 (지금은 ${tab.label} 목록)`,
      value: state.query,
      'data-search': true,
      spellcheck: 'false',
      oninput: (e) => {
        state.query = e.target.value;
        fill();
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && !e.isComposing) {
          e.stopPropagation();
          if (state.query) {
            e.target.value = '';
            state.query = '';
            fill();
          } else setOpen(false);
        }
      },
      onblur: () => setTimeout(() => state.deferred && renderWhenIdle(), 250),
    });

    drawerEl.replaceChildren(
      ...[
        snap.status.state === 'error' ? h('div', { class: 'banner', text: `⚠ ${snap.status.message || '데이터를 가져오지 못했습니다.'}` }) : null,
        h('div', { class: 'drawer-top' }, h('span', { class: 'search-icon', icon: 'search' }), search),
        list,
        h(
          'div',
          { class: 'drawer-foot' },
          h('span', { class: 'foot-status', text: K.statusInfo(snap.status).text }),
          project() ? iconBtn('folder', '두레이에서 열기', () => api.openUrl(project().url)) : null,
          iconBtn('pin', state.pinned ? '항상 위 해제' : '항상 위', togglePin, state.pinned ? 'active' : ''),
          iconBtn('settings', '설정', () => api.openSettings())
        ),
      ].filter(Boolean)
    );
  }

  async function togglePin() {
    state.pinned = await api.window.togglePin();
    render();
  }

  // ---------- render loop ----------

  function render() {
    if (!state.snapshot || !state.context) return;
    state.deferred = false;
    renderBar();
    const top = drawerEl.querySelector('.list')?.scrollTop || 0;
    renderDrawer();
    const list = drawerEl.querySelector('.list');
    if (list) list.scrollTop = top;
  }

  function renderWhenIdle() {
    if (document.activeElement?.dataset?.search !== undefined) {
      state.deferred = true;
      renderBar(); // the counters can still update
      return;
    }
    render();
  }

  async function init() {
    const [context, snapshot, winState] = await Promise.all([api.getContext(), api.getSnapshot(), api.window.getState()]);
    state.context = context;
    state.snapshot = snapshot;
    state.pinned = winState.pinned;
    document.title = context.mode === 'project' ? 'Dooray 프로젝트' : 'Dooray';
    render();
    // Always start folded (a saved size may be the unfolded one).
    if (window.innerHeight !== BAR_HEIGHT) api.window.setSize(window.innerWidth, BAR_HEIGHT);
    api.onSnapshot((next) => {
      state.snapshot = next;
      renderWhenIdle();
    });
    setInterval(renderWhenIdle, 30000);
  }

  init();
})();
