// "Board" theme: open tasks as cards in backlog / to do / in progress columns.
(() => {
  const api = window.dooray;
  const K = window.DoorayKit;
  const { h, highlight, dueLabel, parseQuery, searchTasks, byUrgency, tagLabel } = K;
  const topEl = document.getElementById('top');
  const columnsEl = document.getElementById('columns');

  const COLUMNS = [
    { key: 'backlog', label: '대기' },
    { key: 'registered', label: '할 일' },
    { key: 'working', label: '진행 중' },
  ];
  const CARD_LIMIT = 150;

  const state = {
    context: null,
    snapshot: null,
    pinned: false,
    projectId: '', // '' = every project
    onlyMine: false,
    onlyUrgent: false,
    query: '',
    deferred: false,
  };

  // Back/forward walks through the project picker choices.
  const history = K.createHistory(
    () => ({ projectId: state.projectId }),
    (nav) => {
      state.projectId = nav.projectId;
      render();
    }
  );
  K.onBackForward(
    () => (state.query ? setQuery('') : history.back()),
    () => history.forward()
  );

  const projectWindow = () => state.context?.mode === 'project';
  const selectedProjectId = () => (projectWindow() ? state.context.projectId : state.projectId);

  /** One letter for an avatar: the given name's first letter for 3-letter Korean names ("이서연" -> "서"). */
  function initials(name) {
    const s = String(name || '').trim();
    return (s.length === 3 && /^[가-힣]+$/.test(s) ? s[1] : s[0]) || '?';
  }

  function iconBtn(icon, title, onclick, extra = '') {
    return h('button', { class: `icon-btn ${extra}`, title, 'aria-label': title, icon, onclick });
  }

  function setQuery(q) {
    state.query = q;
    const input = topEl.querySelector('[data-search]');
    if (input && input.value !== q) input.value = q;
    renderColumns();
  }

  // ---------- top bar ----------

  function renderTop() {
    const snap = state.snapshot;
    const status = K.statusInfo(snap.status);
    const pid = selectedProjectId();
    const project = pid ? snap.projects.find((p) => p.id === pid) : null;

    const picker = projectWindow()
      ? h('span', { class: 'board-title', text: project?.name || '프로젝트' })
      : h(
          'select',
          {
            class: 'picker',
            title: '프로젝트',
            onchange: (e) => history.go({ projectId: e.target.value }),
          },
          h('option', { value: '', text: `전체 프로젝트 (${snap.projects.length})` }),
          snap.projects.map((p) => h('option', { value: p.id, selected: p.id === pid, text: `${p.name}  ·  ${p.counts.open}` }))
        );

    const toggle = (key, label) =>
      h('button', {
        class: `chip ${state[key] ? 'on' : ''}`,
        text: label,
        onclick: () => {
          state[key] = !state[key];
          render();
        },
      });

    const search = h('input', {
      class: 'search',
      type: 'text',
      placeholder: '카드 검색 (제목, 담당자, 태그, 초성)',
      value: state.query,
      'data-search': true,
      spellcheck: 'false',
      oninput: (e) => setQuery(e.target.value),
      onkeydown: (e) => {
        if (e.key === 'Escape' && !e.isComposing) setQuery('');
      },
      onblur: () => setTimeout(() => state.deferred && renderWhenIdle(), 250),
    });

    topEl.replaceChildren(
      h('div', { class: 'brand' }, h('span', { class: 'logo', text: 'D' }), picker),
      h('div', { class: 'filters' }, toggle('onlyMine', '내 업무'), toggle('onlyUrgent', '지연·임박'), search),
      h(
        'div',
        { class: 'tools' },
        h('span', { class: `status ${status.dot}`, text: status.text }),
        project && !projectWindow() ? iconBtn('detach', '별도 위젯으로 띄우기', () => api.openProjectWidget(project.id)) : null,
        project ? iconBtn('folder', '두레이에서 열기', () => api.openUrl(project.url)) : null,
        iconBtn('refresh', '새로고침', () => api.refresh(), snap.status.refreshing ? 'spin' : ''),
        iconBtn('pin', state.pinned ? '항상 위 해제' : '항상 위', togglePin, state.pinned ? 'active' : ''),
        iconBtn('settings', '설정', () => api.openSettings()),
        iconBtn('close', projectWindow() ? '위젯 닫기' : '종료', () => api.window.close())
      )
    );
  }

  async function togglePin() {
    state.pinned = await api.window.togglePin();
    renderTop();
  }

  // ---------- columns ----------

  function card(t, terms, showProject) {
    const due = dueLabel(t);
    const tags = t.tags || [];
    return h(
      'div',
      { class: `card prio-${t.priority}`, role: 'button', tabindex: '0', title: t.subject, onclick: () => api.openUrl(t.url) },
      tags.length
        ? h(
            'div',
            { class: 'labels' },
            tags.slice(0, 3).map((tag) => h('span', { class: 'label', style: tag.color ? `--tag:${tag.color}` : null, title: tag.name }, highlight(tagLabel(tag), terms)))
          )
        : null,
      h('div', { class: 'card-title' }, highlight(t.subject, terms)),
      h(
        'div',
        { class: 'card-foot' },
        due ? h('span', { class: `due ${t.dueState}`, icon: null, text: due }) : null,
        h('span', { class: 'wf', text: t.workflowName }),
        showProject ? h('span', { class: 'proj', text: t.projectName }) : h('span', { class: 'proj' }, highlight(t.key, terms)),
        h(
          'span',
          { class: 'people' },
          t.assignees.slice(0, 3).map((a) => h('span', { class: `avatar ${a.id === state.snapshot.me?.id ? 'me' : ''}`, title: a.name, text: initials(a.name) }))
        )
      ),
      state.snapshot?.integrations?.todoEnabled ? h('button', { class: 'todo-add', title: /^en\b/i.test(navigator.language || '') ? 'Add to Todo' : '할 일에 추가', text: '+', onclick: async (e) => { e.stopPropagation(); const res = await api.addToTodo(t.id); if (res?.ok) e.currentTarget.textContent = '✓'; else window.alert(res?.message || (/^en\b/i.test(navigator.language || '') ? 'Could not add to Todo.' : '할 일에 추가하지 못했습니다.')); } }) : null
    );
  }

  function renderColumns() {
    const snap = state.snapshot;
    const pid = selectedProjectId();
    const terms = parseQuery(state.query);
    let tasks = K.openTasks(snap, pid || null);
    if (state.onlyMine) tasks = tasks.filter((t) => t.isMine);
    if (state.onlyUrgent) tasks = tasks.filter((t) => t.dueState === 'overdue' || t.dueState === 'soon');
    tasks = searchTasks(tasks, terms).slice().sort(byUrgency);

    columnsEl.replaceChildren(
      ...COLUMNS.map((col) => {
        const items = tasks.filter((t) => t.workflowClass === col.key);
        const late = items.filter((t) => t.dueState === 'overdue').length;
        return h(
          'section',
          { class: `column col-${col.key}` },
          h(
            'header',
            { class: 'col-head' },
            h('span', { class: 'col-name', text: col.label }),
            h('span', { class: 'col-count', text: items.length }),
            late ? h('span', { class: 'col-late', text: `지연 ${late}` }) : null
          ),
          h(
            'div',
            { class: 'col-cards' },
            items.length ? items.slice(0, CARD_LIMIT).map((t) => card(t, terms.length ? terms : null, !pid)) : h('div', { class: 'col-empty', text: terms.length ? '검색 결과 없음' : '비어 있음' }),
            items.length > CARD_LIMIT ? h('div', { class: 'col-empty', text: `${CARD_LIMIT}장까지만 표시합니다.` }) : null
          )
        );
      })
    );
  }

  // ---------- render loop ----------

  function render() {
    const snap = state.snapshot;
    if (!snap || !state.context) return;
    renderTop();
    state.deferred = false;
    if (snap.status.state === 'unconfigured') {
      columnsEl.replaceChildren(
        h(
          'div',
          { class: 'state' },
          h('h2', { text: '설정이 필요합니다' }),
          h('p', { text: '두레이 도메인과 API 토큰을 입력하면 보드가 표시됩니다.' }),
          h('button', { class: 'primary', text: '설정 열기', onclick: () => api.openSettings() })
        )
      );
      return;
    }
    if (!snap.status.lastSuccessAt && !snap.projects.length) {
      columnsEl.replaceChildren(h('div', { class: 'state' }, h('p', { text: '불러오는 중…' })));
      return;
    }
    if (state.projectId && !snap.projects.some((p) => p.id === state.projectId)) state.projectId = '';
    const scroll = [...columnsEl.querySelectorAll('.col-cards')].map((el) => el.scrollTop);
    renderColumns();
    columnsEl.querySelectorAll('.col-cards').forEach((el, i) => (el.scrollTop = scroll[i] || 0));
  }

  function renderWhenIdle() {
    if (document.activeElement?.dataset?.search !== undefined || document.activeElement?.tagName === 'SELECT') {
      state.deferred = true;
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
    api.onSnapshot((next) => {
      state.snapshot = next;
      renderWhenIdle();
    });
    setInterval(renderWhenIdle, 30000);
  }

  init();
})();
