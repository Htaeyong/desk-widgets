// "Sidebar" theme: a messenger-style rail (home, my tasks, projects, categories) and a task pane.
(() => {
  const api = window.dooray;
  const K = window.DoorayKit;
  const { h, highlight, dueLabel, parseQuery, searchTasks, byUrgency, tagLabel } = K;
  const railEl = document.getElementById('rail');
  const headEl = document.getElementById('head');
  const bodyEl = document.getElementById('body');

  const state = {
    context: null,
    snapshot: null,
    pinned: false,
    // { name: 'home' } | { name: 'mine' } | { name: 'project', projectId } | { name: 'category', categoryId }
    view: { name: 'home' },
    filter: 'overdue', // project pane: overdue | dueSoon | mine | all
    query: '',
    deferred: false,
  };

  const history = K.createHistory(
    () => ({ view: state.view, filter: state.filter }),
    (nav) => {
      state.view = nav.view;
      state.filter = nav.filter;
      state.query = '';
      render();
    }
  );
  const go = (view) => history.go({ view, filter: 'overdue' });
  K.onBackForward(() => (state.query ? clearQuery() : history.back()), () => history.forward());

  // ---------- helpers ----------

  /** Stable color per id, so a project keeps its avatar color. */
  function colorOf(id) {
    // FNV-1a, then spread hues with the golden angle so similar ids still differ.
    let n = 2166136261;
    for (const ch of String(id)) n = Math.imul(n ^ ch.charCodeAt(0), 16777619) >>> 0;
    return `hsl(${Math.round((n % 1000) * 137.508) % 360} 52% 50%)`;
  }

  /** Two letters for an avatar: "모바일앱-리뉴얼" -> "모바". */
  function initials(name) {
    const clean = String(name).replace(/[^0-9A-Za-z가-힣]/g, '');
    return (clean || '?').slice(0, 2);
  }

  const projectWindow = () => state.context?.mode === 'project';
  const projectById = (id) => state.snapshot.projects.find((p) => p.id === id) || null;
  const categoryById = (id) => (state.snapshot.categories || []).find((c) => c.id === id) || null;

  function currentView() {
    if (projectWindow()) return { name: 'project', projectId: state.context.projectId };
    return state.view;
  }

  function iconBtn(icon, title, onclick, extra = '') {
    return h('button', { class: `icon-btn ${extra}`, title, 'aria-label': title, icon, onclick });
  }

  function clearQuery() {
    state.query = '';
    render();
  }

  // ---------- rail ----------

  function railItem({ key, label, active, onclick, avatar, icon, badge, color }) {
    return h(
      'button',
      { class: `rail-item ${active ? 'active' : ''}`, title: label, 'aria-label': label, 'data-key': key, onclick },
      h('span', { class: 'rail-pill' }),
      icon
        ? h('span', { class: 'rail-icon', icon })
        : h('span', { class: 'rail-avatar', style: `--c:${color}`, text: avatar }),
      badge ? h('span', { class: 'rail-badge', text: badge > 99 ? '99+' : badge }) : null
    );
  }

  function renderRail() {
    const snap = state.snapshot;
    const v = state.view;
    const items = [
      railItem({ key: 'home', label: '홈', icon: 'home', active: v.name === 'home', onclick: () => go({ name: 'home' }) }),
      railItem({
        key: 'mine',
        label: '내 업무',
        icon: 'user',
        active: v.name === 'mine',
        badge: snap.summary.counts.mine,
        onclick: () => go({ name: 'mine' }),
      }),
      h('div', { class: 'rail-sep' }),
      ...snap.projects.map((p) =>
        railItem({
          key: p.id,
          label: `${p.name} (미완료 ${p.counts.open}, 지연 ${p.counts.overdue})`,
          avatar: initials(p.name),
          color: colorOf(p.id),
          badge: p.counts.overdue,
          active: v.name === 'project' && v.projectId === p.id,
          onclick: () => go({ name: 'project', projectId: p.id }),
        })
      ),
    ];
    const cats = snap.categories || [];
    if (cats.length) {
      items.push(h('div', { class: 'rail-sep' }));
      for (const c of cats) {
        items.push(
          railItem({
            key: c.id,
            label: `내 분류: ${c.name}`,
            avatar: initials(c.name),
            color: c.color,
            badge: c.counts.overdue,
            active: v.name === 'category' && v.categoryId === c.id,
            onclick: () => go({ name: 'category', categoryId: c.id }),
          })
        );
      }
    }
    railEl.replaceChildren(
      h('div', { class: 'rail-top', title: 'Dooray' }, h('span', { class: `logo ${K.statusInfo(snap.status).dot}`, text: 'D' })),
      h('div', { class: 'rail-list' }, items),
      h('div', { class: 'rail-bottom' }, railItem({ key: 'settings', label: '설정', icon: 'settings', onclick: () => api.openSettings() }))
    );
  }

  // ---------- header ----------

  function renderHead(title, subtitle, color) {
    const status = K.statusInfo(state.snapshot.status);
    const v = currentView();
    headEl.replaceChildren(
      h(
        'div',
        { class: 'head-title' },
        color ? h('span', { class: 'head-mark', style: `background:${color}` }) : null,
        h('span', { class: 'head-name', text: title }),
        subtitle ? h('span', { class: 'head-sub', text: subtitle }) : null
      ),
      h(
        'div',
        { class: 'head-tools' },
        h('span', { class: `head-status ${status.dot}`, text: status.text }),
        v.name === 'project' && !projectWindow() ? iconBtn('detach', '별도 위젯으로 띄우기', () => api.openProjectWidget(v.projectId)) : null,
        v.name === 'project' ? iconBtn('folder', '두레이에서 열기', () => api.openUrl(projectById(v.projectId)?.url || '')) : null,
        iconBtn('refresh', '새로고침', () => api.refresh(), state.snapshot.status.refreshing ? 'spin' : ''),
        iconBtn('pin', state.pinned ? '항상 위 해제' : '항상 위', togglePin, state.pinned ? 'active' : ''),
        projectWindow() ? iconBtn('settings', '설정', () => api.openSettings()) : null,
        iconBtn('close', projectWindow() ? '위젯 닫기' : '종료', () => api.window.close())
      )
    );
  }

  async function togglePin() {
    state.pinned = await api.window.togglePin();
    render();
  }

  // ---------- pieces ----------

  function searchBox(placeholder, onChange) {
    const input = h('input', {
      class: 'search',
      type: 'text',
      placeholder,
      value: state.query,
      'data-search': true,
      spellcheck: 'false',
      oninput: (e) => {
        state.query = e.target.value;
        onChange();
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && !e.isComposing) {
          e.target.value = '';
          state.query = '';
          onChange();
        }
      },
      onblur: () => setTimeout(() => state.deferred && renderWhenIdle(), 250),
    });
    return h('label', { class: 'search-wrap' }, h('span', { class: 'search-icon', icon: 'search' }), input);
  }

  function taskRow(t, { terms = null, showProject = true } = {}) {
    const due = t.workflowClass === 'closed' ? '' : dueLabel(t);
    const people = t.assignees.map((a) => a.name).join(', ') || '미지정';
    const tag = (t.tags || [])[0];
    return h(
      'div',
      { class: `row ${t.workflowClass === 'closed' ? 'closed' : ''}`, role: 'button', tabindex: '0', title: t.subject, onclick: () => api.openUrl(t.url) },
      h('span', { class: `row-dot ${t.dueState}` }),
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-subject' }, highlight(t.subject, terms)),
        h(
          'div',
          { class: 'row-meta' },
          showProject ? h('span', { class: 'row-proj', style: `--c:${colorOf(t.projectId)}`, text: t.projectName }) : null,
          h('span', {}, highlight(t.key, terms)),
          h('span', { text: t.workflowName }),
          h('span', {}, highlight(people, terms)),
          tag ? h('span', { class: 'row-tag', style: tag.color ? `--tag:${tag.color}` : null, title: tag.name, text: tagLabel(tag) }) : null
        )
      ),
      due ? h('span', { class: `row-due ${t.dueState}`, text: due }) : null,
      state.snapshot?.integrations?.todoEnabled ? h('button', { class: 'todo-add', title: /^en\b/i.test(navigator.language || '') ? 'Add to Todo' : '할 일에 추가', text: '+', onclick: async (e) => { e.stopPropagation(); const res = await api.addToTodo(t.id); if (res?.ok) e.currentTarget.textContent = '✓'; else window.alert(res?.message || (/^en\b/i.test(navigator.language || '') ? 'Could not add to Todo.' : '할 일에 추가하지 못했습니다.')); } }) : null
    );
  }

  function list(tasks, opts) {
    if (!tasks.length) return h('div', { class: 'empty', text: opts?.empty || '업무가 없습니다.' });
    return h('div', { class: 'rows' }, tasks.slice(0, 200).map((t) => taskRow(t, opts)));
  }

  /** A section whose list can be refilled without rebuilding the search box (keeps IME input intact). */
  function searchable(placeholder, tasks, opts) {
    const host = h('div');
    const fill = () => {
      const terms = parseQuery(state.query);
      const found = searchTasks(tasks, terms).slice().sort(byUrgency);
      host.replaceChildren(
        ...[
          terms.length ? h('div', { class: 'result-head', text: `검색 결과 ${found.length}건` }) : null,
          list(found, { ...opts, terms: terms.length ? terms : null, empty: terms.length ? '검색 결과가 없습니다.' : opts.empty }),
        ].filter(Boolean)
      );
    };
    fill();
    return [searchBox(placeholder, fill), host];
  }

  function stat(value, label, tone, onclick) {
    return h(
      'button',
      { class: `stat ${value ? tone || '' : 'zero'}`, onclick },
      h('span', { class: 'stat-value', text: value }),
      h('span', { class: 'stat-label', text: label })
    );
  }

  // ---------- views ----------

  function renderHome() {
    const snap = state.snapshot;
    const c = snap.summary.counts;
    renderHead(`${snap.me?.name || ''}님의 업무`.trim(), `프로젝트 ${snap.projects.length}개`);
    const all = K.openTasks(snap);
    const urgent = all.filter((t) => t.dueState === 'overdue' || t.dueState === 'soon').sort(byUrgency);
    return [
      h(
        'div',
        { class: 'stats' },
        stat(c.open, '미완료'),
        stat(c.overdue, '지연', 'danger'),
        stat(c.dueSoon, '마감 임박', 'warn'),
        stat(c.mine, '내 업무', 'accent', () => go({ name: 'mine' }))
      ),
      h('div', { class: 'section-title', text: '급한 업무 · 지연과 마감 임박' }),
      ...searchable('모든 업무 검색 (제목, 번호, 담당자, 태그, 초성)', urgent, { empty: '급한 업무가 없습니다. 🎉' }),
      h('div', { class: 'section-title', text: '프로젝트' }),
      h(
        'div',
        { class: 'proj-grid' },
        snap.projects.map((p) =>
          h(
            'button',
            { class: 'proj', onclick: () => go({ name: 'project', projectId: p.id }) },
            h('span', { class: 'proj-avatar', style: `--c:${colorOf(p.id)}`, text: initials(p.name) }),
            h('span', { class: 'proj-name', text: p.name }),
            h('span', { class: 'proj-count', text: p.counts.open }),
            p.counts.overdue ? h('span', { class: 'proj-late', text: `지연 ${p.counts.overdue}` }) : null
          )
        )
      ),
    ];
  }

  function renderMine() {
    const mine = K.openTasks(state.snapshot).filter((t) => t.isMine);
    renderHead('내 업무', `${mine.length}건 · 모든 프로젝트`);
    return searchable('내 업무 검색', mine, { empty: '내가 담당한 미완료 업무가 없습니다.' });
  }

  const FILTERS = [
    { key: 'overdue', label: '지연', count: (p) => p.counts.overdue, pick: (ts) => ts.filter((t) => t.dueState === 'overdue') },
    { key: 'dueSoon', label: '임박', count: (p) => p.counts.dueSoon, pick: (ts) => ts.filter((t) => t.dueState === 'soon') },
    { key: 'mine', label: '내 업무', count: (p) => p.counts.mine, pick: (ts) => ts.filter((t) => t.isMine) },
    { key: 'all', label: '전체', count: (p) => p.counts.open, pick: (ts) => ts },
  ];

  function renderProject(projectId) {
    const p = projectById(projectId);
    if (!p) {
      renderHead('프로젝트', '');
      return [h('div', { class: 'empty', text: '이 프로젝트를 찾을 수 없습니다. 설정에서 표시할 프로젝트를 확인하세요.' })];
    }
    renderHead(p.name, `미완료 ${p.counts.open} · 진행 ${p.counts.working}`, colorOf(p.id));
    const filter = FILTERS.find((f) => f.key === state.filter) || FILTERS[0];
    const tasks = state.query ? p.tasks.open : filter.pick(p.tasks.open);
    return [
      p.error ? h('div', { class: 'banner', text: `⚠ ${p.error}` }) : null,
      h(
        'div',
        { class: 'pills' },
        FILTERS.map((f) =>
          h(
            'button',
            {
              class: `pill ${f.key === filter.key ? 'on' : ''} ${f.key === 'overdue' && f.count(p) ? 'danger' : ''}`,
              onclick: () => {
                state.filter = f.key;
                state.query = '';
                render();
              },
            },
            f.label,
            h('b', { text: f.count(p) })
          )
        )
      ),
      ...searchable(`이 프로젝트 업무 검색 (${p.counts.open}건)`, tasks, { showProject: false, empty: '해당하는 업무가 없습니다.' }),
    ];
  }

  function renderCategory(categoryId) {
    const c = categoryById(categoryId);
    if (!c) {
      // The category was deleted elsewhere.
      state.view = { name: 'home' };
      return renderHome();
    }
    renderHead(c.name, `내 분류 · 미완료 ${c.counts.open}${c.counts.closed ? ` · 완료 ${c.counts.closed}` : ''}`, c.color);
    return [
      ...searchable('이 분류에서 검색', c.tasks, { empty: '이 분류에 담긴 업무가 없습니다. 다른 테마나 분류 관리 창에서 업무를 담을 수 있습니다.' }),
      h('button', { class: 'link', text: '분류 관리 열기', onclick: () => api.openCategoryManager(c.id) }),
    ];
  }

  // ---------- render loop ----------

  function render() {
    const snap = state.snapshot;
    if (!snap || !state.context) return;
    document.body.classList.toggle('single', projectWindow());
    if (!projectWindow()) renderRail();

    let content;
    if (snap.status.state === 'unconfigured') {
      renderHead('Dooray', '');
      content = [
        h(
          'div',
          { class: 'state' },
          h('h2', { text: '설정이 필요합니다' }),
          h('p', { text: '두레이 도메인과 API 토큰을 입력하면 업무가 표시됩니다.' }),
          h('button', { class: 'primary', text: '설정 열기', onclick: () => api.openSettings() })
        ),
      ];
    } else if (!snap.status.lastSuccessAt && !snap.projects.length) {
      renderHead('Dooray', '불러오는 중…');
      content = [h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })];
    } else {
      const v = currentView();
      content =
        v.name === 'project'
          ? renderProject(v.projectId)
          : v.name === 'mine'
            ? renderMine()
            : v.name === 'category'
              ? renderCategory(v.categoryId)
              : renderHome();
      if (snap.status.state === 'error') content.unshift(h('div', { class: 'banner', text: `⚠ ${snap.status.message || '데이터를 가져오지 못했습니다.'}` }));
    }
    state.deferred = false;
    const top = bodyEl.scrollTop;
    bodyEl.replaceChildren(...content.filter(Boolean));
    bodyEl.scrollTop = top;
  }

  function renderWhenIdle() {
    if (document.activeElement?.dataset?.search !== undefined) {
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
