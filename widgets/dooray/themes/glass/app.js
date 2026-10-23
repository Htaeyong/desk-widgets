// "Dark glass" theme — reference implementation of theme contract v1.
(() => {
  const api = window.dooray;
  const titlebarEl = document.getElementById('titlebar');
  const mainEl = document.getElementById('main');
  const layerEl = document.body.appendChild(document.createElement('div'));
  layerEl.className = 'layer';

  const PALETTE = ['#7aa7ff', '#52d6a4', '#ffbd59', '#ff7272', '#c792ea', '#5ad1e6', '#f78fb3', '#a3b18a'];

  const state = {
    context: null,
    snapshot: null,
    pinned: false,
    // overview window: { name: 'overview' } | { name: 'project', projectId } | { name: 'category', categoryId }
    view: { name: 'overview' },
    section: 'projects', // overview list: 'projects' | 'categories'
    tab: 'overdue',
    showQuiet: false,
    // Category assignment menu: { taskId, anchor: DOMRect, newName }
    popover: null,
    // Inline category form: { type: 'new' | 'edit', id?, name, color, confirmDelete? }
    form: null,
    toast: null,
    // Current search text (reset on navigation)
    query: '',
    // Task ids whose tag chips are unfolded
    expandedTags: new Set(),
    // Project id being dragged to reorder; renders wait until the drop
    dragging: null,
    // Screen history for the mouse back/forward buttons and Alt+Left/Right
    history: { back: [], forward: [] },
    // A snapshot arrived while the user was typing; render when they finish.
    deferred: false,
  };

  // ---------- helpers ----------

  const {
    h,
    relativeTime,
    dueLabel,
    toChosung,
    isChosungTerm,
    parseQuery,
    searchTasks,
    highlight,
    DUE_ORDER,
    tagLabel,
  } = window.DoorayKit;

  function iconButton(icon, title, onclick, extraClass = '') {
    return h('button', { class: `icon-btn ${extraClass}`, title, 'aria-label': title, icon, onclick });
  }

  function currentProject() {
    const id = state.context?.mode === 'project' ? state.context.projectId : state.view.projectId;
    return state.snapshot?.projects.find((p) => p.id === id) || null;
  }

  function categoryById(id) {
    return (state.snapshot?.categories || []).find((c) => c.id === id) || null;
  }

  function currentCategory() {
    return state.view.name === 'category' ? categoryById(state.view.categoryId) : null;
  }

  function findTask(taskId) {
    for (const p of state.snapshot.projects) {
      const t = p.tasks.open.find((x) => x.id === taskId);
      if (t) return t;
    }
    for (const c of state.snapshot.categories || []) {
      const t = c.tasks.find((x) => x.id === taskId);
      if (t) return t;
    }
    return null;
  }

  function showToast(text) {
    state.toast = text;
    renderLayer();
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      state.toast = null;
      renderLayer();
    }, 3000);
  }

  /** Calls a categories API method and reports failures as a toast. */
  async function categoryCall(promise) {
    const res = await promise;
    if (!res?.ok) showToast(res?.message || '처리하지 못했습니다.');
    return res;
  }

  // ---------- search ----------

  const SEARCH_LIMIT = 50;

  /** A region that can be refilled without rebuilding the search box (keeps IME composition intact). */
  function liveRegion(fill) {
    const host = h('div', { class: 'live' });
    const update = () => host.replaceChildren(...fill().flat().filter(Boolean));
    update();
    return { host, update };
  }

  function searchBox(placeholder, onChange) {
    const input = h('input', {
      class: 'text-input search-input',
      type: 'text',
      placeholder,
      value: state.query,
      'data-search': true,
      spellcheck: 'false',
      oninput: (e) => {
        state.query = e.target.value;
        onChange();
        clear.hidden = !state.query;
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && !e.isComposing) {
          e.target.value = '';
          state.query = '';
          clear.hidden = true;
          onChange();
        }
      },
      // A refresh that arrived while typing is applied once the box loses focus.
      onblur: () => setTimeout(() => state.deferred && renderWhenIdle(), 250),
    });
    const clear = h('button', {
      class: 'search-clear',
      title: '지우기',
      icon: 'close',
      hidden: !state.query,
      onclick: () => {
        input.value = '';
        state.query = '';
        clear.hidden = true;
        onChange();
        input.focus();
      },
    });
    return h('div', { class: 'search' }, h('span', { class: 'search-icon', icon: 'search' }), input, clear);
  }

  /** Renders search results: a count line, up to SEARCH_LIMIT tasks, and a hint when truncated. */
  function resultList(found, terms, { showProject = true } = {}) {
    if (!found.length) return [h('div', { class: 'empty', text: '검색 결과가 없습니다.' })];
    const sorted = found
      .slice()
      .sort(
        (a, b) =>
          (a.workflowClass === 'closed') - (b.workflowClass === 'closed') ||
          DUE_ORDER[a.dueState] - DUE_ORDER[b.dueState] ||
          b.updatedAt.localeCompare(a.updatedAt)
      );
    return [
      h('div', { class: 'result-head', text: `검색 결과 ${found.length}건` }),
      h('div', { class: 'tasks' }, sorted.slice(0, SEARCH_LIMIT).map((t) => taskItem(t, { showProject, terms }))),
      found.length > SEARCH_LIMIT
        ? h('div', { class: 'empty', text: `${SEARCH_LIMIT}건까지만 표시합니다. 검색어를 더 입력해 보세요.` })
        : null,
    ];
  }

  /** Every task the widget knows about: open tasks of all projects plus categorized ones. */
  function allKnownTasks() {
    return window.DoorayKit.allKnownTasks(state.snapshot);
  }

  // ---------- titlebar ----------

  function renderTitlebar() {
    const snap = state.snapshot;
    const status = snap?.status;
    const isProjectWindow = state.context?.mode === 'project';
    const inProject = isProjectWindow || state.view.name === 'project';
    const project = inProject ? currentProject() : null;
    const category = !isProjectWindow ? currentCategory() : null;
    const showBack = (inProject && !isProjectWindow) || state.view.name === 'category';

    const PAUSE_LABEL = { locked: '잠금 중 · 갱신 멈춤', suspended: '절전 중 · 갱신 멈춤', idle: '자리 비움 · 갱신 멈춤' };
    const dotClass = status?.refreshing ? 'busy' : status?.paused ? 'paused' : status?.state === 'error' ? 'error' : '';
    let sub = '';
    if (status?.refreshing) sub = '갱신 중…';
    else if (status?.paused) sub = PAUSE_LABEL[status.pausedReason] || '갱신 멈춤';
    else if (status?.lastSuccessAt) sub = relativeTime(status.lastSuccessAt);

    const brand = h(
      'div',
      { class: 'brand' },
      showBack
        ? iconButton('back', '뒤로 (마우스 뒤로 버튼, Alt+←)', () => (state.history.back.length ? goBack() : go({ name: 'overview' })))
        : h('span', { class: `brand-dot ${dotClass}` }),
      category ? h('span', { class: 'cat-dot big', style: `background:${category.color}` }) : null,
      h('span', { class: 'brand-title', text: project ? project.name : category ? category.name : 'Dooray' }),
      h('span', { class: 'brand-sub', text: sub })
    );

    const tools = h(
      'div',
      { class: 'tools' },
      inProject && !isProjectWindow && project
        ? iconButton('detach', '별도 위젯으로 띄우기', () => api.openProjectWidget(project.id))
        : null,
      iconButton('refresh', '새로고침', () => api.refresh(), status?.refreshing ? 'spin' : ''),
      iconButton('pin', state.pinned ? '항상 위 해제' : '항상 위', togglePin, state.pinned ? 'active' : ''),
      iconButton('settings', '설정', () => api.openSettings()),
      iconButton('close', isProjectWindow ? '위젯 닫기' : '종료', () => api.window.close())
    );

    titlebarEl.replaceChildren(brand, tools);
  }

  async function togglePin() {
    state.pinned = await api.window.togglePin();
    renderTitlebar();
  }

  // ---------- shared pieces ----------

  function tile(value, label, tone) {
    return h(
      'div',
      { class: `tile ${value === 0 ? 'zero' : tone || ''}` },
      h('div', { class: 'tile-value', text: value }),
      h('div', { class: 'tile-label', text: label })
    );
  }

  function statusBar(counts) {
    const total = counts.backlog + counts.registered + counts.working;
    if (!total) return h('div', { class: 'bar' });
    const seg = (cls) => (counts[cls] ? h('span', { class: cls, style: `flex:${counts[cls]}` }) : null);
    return h('div', { class: 'bar' }, seg('backlog'), seg('registered'), seg('working'));
  }

  function errorBanner(status) {
    if (status?.state !== 'error') return null;
    return h('div', { class: 'banner' }, h('span', { text: `⚠ ${status.message || '데이터를 가져오지 못했습니다.'}` }));
  }

  // ---------- overview ----------

  // ---------- project reordering (drag and drop) ----------

  function clearDropMarks() {
    mainEl.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'dragging'));
  }

  // Moves dragId before/after targetId in the full project list and saves the order.
  function moveProject(dragId, targetId, after) {
    if (!dragId || dragId === targetId) return;
    const ids = state.snapshot.projects.map((p) => p.id).filter((id) => id !== dragId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(after ? at + 1 : at, 0, dragId);
    // Show the new order right away; the backend confirms with the next snapshot.
    const byId = new Map(state.snapshot.projects.map((p) => [p.id, p]));
    state.snapshot = { ...state.snapshot, projects: ids.map((id) => byId.get(id)) };
    api.setProjectOrder(ids);
  }

  /** Drag-and-drop handlers shared by project cards. */
  function dragProps(p) {
    return {
      draggable: 'true',
      'data-project-id': p.id,
      ondragstart: (e) => {
        state.dragging = p.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', p.id);
        e.currentTarget.classList.add('dragging');
      },
      ondragover: (e) => {
        if (!state.dragging || state.dragging === p.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        mainEl.querySelectorAll('.drop-before, .drop-after').forEach((el) => el !== e.currentTarget && el.classList.remove('drop-before', 'drop-after'));
        e.currentTarget.classList.toggle('drop-after', after);
        e.currentTarget.classList.toggle('drop-before', !after);
      },
      ondragleave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop-before', 'drop-after');
      },
      ondrop: (e) => {
        e.preventDefault();
        const after = e.currentTarget.classList.contains('drop-after');
        moveProject(state.dragging, p.id, after);
      },
      ondragend: () => {
        state.dragging = null;
        clearDropMarks();
        render();
      },
    };
  }

  function projectCard(p) {
    const c = p.counts;
    return h(
      'div',
      { class: 'project-card', role: 'button', tabindex: '0', title: '끌어서 순서 변경', onclick: () => go({ name: 'project', projectId: p.id }), ...dragProps(p) },
      h(
        'div',
        { class: 'project-row' },
        h('span', { class: 'project-name', text: p.name, title: p.description || p.name }),
        h('button', {
          class: 'icon-btn detach',
          title: '별도 위젯으로 띄우기',
          icon: 'detach',
          onclick: (e) => {
            e.stopPropagation();
            api.openProjectWidget(p.id);
          },
        }),
        h('span', { class: 'project-count' }, String(c.open), h('small', { text: '건' }))
      ),
      statusBar(c),
      h(
        'div',
        { class: 'chips' },
        c.overdue ? h('span', { class: 'chip danger', text: `지연 ${c.overdue}` }) : null,
        c.dueSoon ? h('span', { class: 'chip warn', text: `임박 ${c.dueSoon}` }) : null,
        c.mine ? h('span', { class: 'chip accent', text: `내 업무 ${c.mine}` }) : null,
        c.working ? h('span', { class: 'chip', text: `진행 ${c.working}` }) : null,
        c.closedRecently ? h('span', { class: 'chip', text: `완료 ${c.closedRecently}` }) : null,
        p.error ? h('span', { class: 'chip danger', text: '갱신 실패' }) : null
      )
    );
  }

  function quietCard(p) {
    return h(
      'div',
      { class: 'project-card quiet', role: 'button', tabindex: '0', title: '끌어서 순서 변경', onclick: () => go({ name: 'project', projectId: p.id }), ...dragProps(p) },
      h('div', { class: 'project-row' }, h('span', { class: 'project-name', text: p.name }), h('span', { class: 'num', text: '0' }))
    );
  }

  function renderOverview() {
    const snap = state.snapshot;
    const c = snap.summary.counts;
    // Projects arrive in the user's order (drag and drop); empty ones fold into their own group.
    const active = snap.projects.filter((p) => p.counts.open > 0);
    const quiet = snap.projects.filter((p) => p.counts.open === 0);
    const region = liveRegion(() => sectionContent());

    return [
      errorBanner(snap.status),
      h('div', { class: 'tiles' }, tile(c.open, '미완료'), tile(c.overdue, '지연', 'danger'), tile(c.dueSoon, '마감 임박', 'warn'), tile(c.mine, '내 업무', 'accent')),
      searchBox('모든 업무 검색 (제목, 번호, 담당자, 태그, 초성)', () => region.update()),
      sectionSwitch(),
      region.host,
    ];

    function sectionContent() {
      const terms = parseQuery(state.query);
      if (terms.length) return resultList(searchTasks(allKnownTasks(), terms), terms);
      if (state.section === 'categories') return [renderCategoryList()];
      return [
        h('div', { class: 'section-head' }, h('span', { text: '프로젝트' }), h('span', { class: 'aside', text: `${snap.projects.length}개 · 끌어서 순서 변경` })),
        active.length ? h('div', { class: 'stack' }, active.map(projectCard)) : h('div', { class: 'empty', text: '진행 중인 업무가 없습니다.' }),
        quiet.length
        ? h(
            'div',
            { class: 'stack' },
            h('button', {
              class: 'toggle-quiet',
              text: `${state.showQuiet ? '▾' : '▸'} 업무 없는 프로젝트 ${quiet.length}개`,
              onclick: () => {
                state.showQuiet = !state.showQuiet;
                render();
              },
            }),
            state.showQuiet ? quiet.map(quietCard) : null
          )
        : null,
      ];
    }
  }

  // ---------- project dashboard ----------

  const CLASS_LABEL = { backlog: '대기', registered: '할 일', working: '진행 중' };

  function workflowPanel(p) {
    const rows = p.workflows.length
      ? p.workflows.flatMap((w) => [
          h('div', { class: 'label' }, h('span', { class: `dot ${w.class}` }), h('span', { text: w.name || CLASS_LABEL[w.class] })),
          h('span', { class: 'num', text: w.count }),
        ])
      : [h('span', { class: 'label', text: '미완료 업무 없음' }), h('span')];
    return h(
      'div',
      { class: 'panel' },
      h('div', { class: 'section-head', style: 'margin:0' }, h('span', { text: '상태' }), h('span', { class: 'aside', text: `${p.counts.open}건` })),
      statusBar(p.counts),
      h('div', { class: 'legend' }, rows)
    );
  }

  function peoplePanel(p) {
    if (!p.assignees.length && !p.counts.unassigned) return null;
    const max = Math.max(1, ...p.assignees.map((a) => a.open), p.counts.unassigned);
    const row = (name, open, overdue, isMe) =>
      h(
        'div',
        { class: 'person' },
        h('span', { class: 'person-name', title: name }, name, isMe ? h('span', { class: 'me', text: '나' }) : null),
        h(
          'div',
          { class: 'person-bar' },
          overdue ? h('span', { class: 'over', style: `width:${(overdue / max) * 100}%` }) : null,
          h('span', { style: `width:${((open - overdue) / max) * 100}%` })
        ),
        h('span', { class: 'person-num' }, overdue ? h('b', { text: `${overdue}` }) : null, overdue ? ' / ' : '', String(open))
      );
    return h(
      'div',
      { class: 'panel' },
      h('div', { class: 'section-head', style: 'margin:0' }, h('span', { text: '담당자' }), h('span', { class: 'aside', text: '지연 / 미완료' })),
      h(
        'div',
        { class: 'people' },
        p.assignees.map((a) => row(a.name, a.open, a.overdue, a.isMe)),
        p.counts.unassigned ? row('미지정', p.counts.unassigned, 0, false) : null
      )
    );
  }

  /** Searches for a tag from a chip: fills the search box of the current screen. */
  function searchTag(tag) {
    state.query = tagLabel(tag);
    state.popover = null;
    render();
    focusEnd(mainEl.querySelector('[data-search]'));
  }

  function tagChip(tag, terms) {
    return h(
      'button',
      {
        class: 'tag-chip',
        title: `${tag.name}
눌러서 이 태그로 검색`,
        style: tag.color ? `--tag:${tag.color}` : null,
        onclick: (e) => {
          e.stopPropagation();
          searchTag(tag);
        },
      },
      highlight(tagLabel(tag), terms)
    );
  }

  /**
   * One tag chip; the rest fold behind "+N". While searching, a tag that matches the
   * query is shown first. Expanded rows stay expanded across re-renders.
   */
  function tagChips(t, terms) {
    const tags = t.tags || [];
    if (!tags.length) return null;
    const hits = (tag) => {
      const name = tag.name.toLowerCase();
      return terms.some((term) => (isChosungTerm(term) ? toChosung(name) : name).includes(term));
    };
    const lead = (terms?.length && tags.find(hits)) || tags[0];
    const ordered = [lead, ...tags.filter((tag) => tag !== lead)];

    const row = h('span', { class: 'tag-row' });
    const fill = () => {
      const open = state.expandedTags.has(t.id);
      const toggle = (label, title) =>
        h('button', {
          class: 'tag-more',
          text: label,
          title,
          onclick: (e) => {
            e.stopPropagation();
            if (open) state.expandedTags.delete(t.id);
            else state.expandedTags.add(t.id);
            fill(); // redraw just this row so the list and search box stay put
          },
        });
      const visible = open ? ordered : ordered.slice(0, 1);
      row.replaceChildren(
        ...visible.map((tag) => tagChip(tag, terms)),
        ordered.length > 1 ? (open ? toggle('접기', '태그 접기') : toggle(`+${ordered.length - 1}`, ordered.slice(1).map((x) => x.name).join(', '))) : ''
      );
    };
    fill();
    return row;
  }

  function taskItem(t, { showProject = false, terms = null } = {}) {
    const closed = t.workflowClass === 'closed';
    const due = closed ? '' : dueLabel(t);
    const people = t.assignees.map((a) => a.name).join(', ') || '미지정';
    const cats = (t.categoryIds || []).map(categoryById).filter(Boolean);
    return h(
      'div',
      { class: `task ${closed ? 'closed' : ''}`, role: 'button', tabindex: '0', title: t.subject, onclick: () => api.openUrl(t.url) },
      h('span', { class: `prio ${t.priority}` }),
      h(
        'span',
        { class: 'task-body' },
        h('span', { class: 'task-subject' }, highlight(t.subject, terms)),
        tagChips(t, terms),
        h(
          'span',
          { class: 'task-meta' },
          terms ? h('span', { class: 'key' }, highlight(t.key, terms)) : null,
          closed ? h('span', { class: 'badge', text: '완료' }) : null,
          t.stale ? h('span', { class: 'badge warn', text: '확인 불가', title: '삭제되었거나 볼 수 없는 업무입니다.' }) : null,
          due ? h('span', { class: `due ${t.dueState}`, text: due }) : null,
          // While searching the key (project/number) is shown, which already names the project.
          showProject && !terms ? h('span', { class: 'proj', text: t.projectName }) : null,
          h('span', { text: t.workflowName }),
          h('span', { text: '·' }),
          h('span', { text: people })
        )
      ),
      h(
        'button',
        {
          class: `tag-btn ${cats.length ? 'has' : ''}`,
          title: cats.length ? `내 분류: ${cats.map((c) => c.name).join(', ')}` : '내 분류에 넣기',
          onclick: (e) => {
            e.stopPropagation();
            openPopover(t.id, e.currentTarget);
          },
        },
        cats.length
          ? cats.slice(0, 3).map((c) => h('span', { class: 'cat-dot', style: `background:${c.color}` }))
          : h('span', { class: 'tag-icon', icon: 'tag' })
      ),
      state.snapshot?.integrations?.todoEnabled ? h('button', { class: 'tag-btn', title: /^en\b/i.test(navigator.language || '') ? 'Add to Todo' : '할 일에 추가', text: '+', onclick: async (e) => { e.stopPropagation(); const res = await api.addToTodo(t.id); showToast(res?.ok ? (/^en\b/i.test(navigator.language || '') ? 'Added to Todo.' : '할 일에 추가했습니다.') : (res?.message || '할 일에 추가하지 못했습니다.')); } }) : null
    );
  }

  const TABS = [
    { key: 'overdue', label: '지연', tone: 'danger' },
    { key: 'dueSoon', label: '임박' },
    { key: 'mine', label: '내 업무' },
    { key: 'recent', label: '최근' },
  ];

  function tasksPanel(p) {
    // Default to the first non-empty tab so the panel is never empty for no reason.
    if (!p.tasks[state.tab]?.length) {
      const firstNonEmpty = TABS.find((t) => p.tasks[t.key].length);
      if (firstNonEmpty) state.tab = firstNonEmpty.key;
    }
    const countOf = (key) => (key === 'recent' ? p.counts.open : p.counts[key]);
    const region = liveRegion(() => {
      const terms = parseQuery(state.query);
      if (terms.length) return resultList(searchTasks(p.tasks.open, terms), terms, { showProject: false });
      const list = p.tasks[state.tab] || [];
      return [
        tabsRow(),
        list.length ? h('div', { class: 'tasks' }, list.map((t) => taskItem(t))) : h('div', { class: 'empty', text: '해당하는 업무가 없습니다.' }),
      ];
    });
    return h('div', { class: 'panel' }, searchBox(`이 프로젝트 업무 검색 (${p.tasks.open.length}건)`, () => region.update()), region.host);

    function tabsRow() {
      return h(
        'div',
        { class: 'tabs' },
        TABS.map((t) =>
          h(
            'button',
            {
              class: `tab ${state.tab === t.key ? 'active' : ''}`,
              onclick: () => {
                state.tab = t.key;
                render();
              },
            },
            t.label,
            h('span', { class: `n ${t.tone || ''}`, text: countOf(t.key) })
          )
        )
      );
    }
  }

  function renderProject() {
    const p = currentProject();
    if (!p) {
      return [
        h(
          'div',
          { class: 'state' },
          h('h2', { text: '프로젝트를 찾을 수 없습니다' }),
          h('p', { text: '숨김 처리되었거나 더 이상 참여하지 않는 프로젝트입니다.' }),
          state.context.mode === 'project'
            ? h('button', { class: 'primary-btn', text: '위젯 닫기', onclick: () => api.window.close() })
            : h('button', { class: 'primary-btn', text: '전체 보기', onclick: () => go({ name: 'overview' }) })
        ),
      ];
    }
    const c = p.counts;
    return [
      errorBanner(state.snapshot.status),
      p.error ? h('div', { class: 'banner', text: `⚠ 이 프로젝트를 갱신하지 못했습니다: ${p.error}` }) : null,
      h('div', { class: 'tiles' }, tile(c.open, '미완료'), tile(c.overdue, '지연', 'danger'), tile(c.dueSoon, '마감 임박', 'warn'), tile(c.closedRecently, `완료 ${state.snapshot.rules.recentDays}일`, 'accent')),
      workflowPanel(p),
      peoplePanel(p),
      tasksPanel(p),
      p.truncated ? h('div', { class: 'banner info', text: '업무가 많아 일부만 집계했습니다.' }) : null,
      p.url ? h('button', { class: 'link-btn', text: '두레이에서 프로젝트 열기 ↗', onclick: () => api.openUrl(p.url) }) : null,
    ];
  }

  // ---------- categories ----------

  function sectionSwitch() {
    const cats = state.snapshot.categories || [];
    const item = (key, label, n) =>
      h(
        'button',
        {
          class: `tab ${state.section === key ? 'active' : ''}`,
          onclick: () => {
            if (state.section === key) return;
            remember();
            state.section = key;
            state.form = null;
            state.query = '';
            render();
          },
        },
        label,
        h('span', { class: 'n', text: n })
      );
    return h(
      'div',
      { class: 'tabs switch' },
      item('projects', '프로젝트', state.snapshot.projects.length),
      item('categories', '내 분류', cats.length)
    );
  }

  function swatches(selected, onPick) {
    return h(
      'div',
      { class: 'swatches' },
      PALETTE.map((color) =>
        h('button', {
          class: `swatch ${color === selected ? 'on' : ''}`,
          style: `background:${color}`,
          title: color,
          onclick: (e) => {
            e.stopPropagation();
            onPick(color);
          },
        })
      )
    );
  }

  function nameInput(value, onInput, onSubmit, onCancel) {
    return h('input', {
      class: 'text-input',
      type: 'text',
      maxlength: '30',
      placeholder: '분류 이름',
      value,
      'data-autofocus': true,
      oninput: (e) => onInput(e.target.value),
      onkeydown: (e) => {
        if (e.isComposing) return; // Korean IME: wait until the syllable is committed
        if (e.key === 'Enter') onSubmit();
        if (e.key === 'Escape') onCancel();
      },
      onclick: (e) => e.stopPropagation(),
    });
  }

  function closeForm() {
    state.form = null;
    render();
  }

  async function submitNewCategory() {
    const f = state.form;
    const res = await categoryCall(api.categories.create({ name: f.name, color: f.color }));
    if (res.ok) closeForm();
  }

  function newCategoryForm() {
    const f = state.form;
    return h(
      'div',
      { class: 'panel form' },
      nameInput(f.name, (v) => (f.name = v), submitNewCategory, closeForm),
      swatches(f.color, (c) => {
        f.color = c;
        render();
      }),
      h(
        'div',
        { class: 'form-actions' },
        h('button', { class: 'ghost-btn', text: '취소', onclick: closeForm }),
        h('button', { class: 'primary-btn small', text: '만들기', onclick: submitNewCategory })
      )
    );
  }

  function categoryCard(c) {
    const n = c.counts;
    return h(
      'div',
      { class: 'project-card cat-card', role: 'button', tabindex: '0', style: `--cat:${c.color}`, onclick: () => go({ name: 'category', categoryId: c.id }) },
      h(
        'div',
        { class: 'project-row' },
        h('span', { class: 'cat-dot', style: `background:${c.color}` }),
        h('span', { class: 'project-name', text: c.name }),
        h('span', { class: 'project-count' }, String(n.open), h('small', { text: '건' }))
      ),
      h(
        'div',
        { class: 'chips' },
        n.overdue ? h('span', { class: 'chip danger', text: `지연 ${n.overdue}` }) : null,
        n.dueSoon ? h('span', { class: 'chip warn', text: `임박 ${n.dueSoon}` }) : null,
        n.closed ? h('span', { class: 'chip', text: `완료 ${n.closed}` }) : null,
        !n.total ? h('span', { class: 'chip', text: '비어 있음' }) : null
      )
    );
  }

  function tagHint() {
    return [' ', h('span', { class: 'inline-icon', icon: 'tag' }), ' '];
  }

  function renderCategoryList() {
    const cats = state.snapshot.categories || [];
    const startNew = () => {
      state.form = { type: 'new', name: '', color: PALETTE[cats.length % PALETTE.length] };
      render();
    };
    return h(
      'div',
      { class: 'stack' },
      cats.length
        ? h(
            'div',
            { class: 'section-head' },
            h('span', { text: '내 분류' }),
            h('button', { class: 'head-link', text: '분류 관리', onclick: () => api.openCategoryManager() })
          )
        : null,
      cats.length
        ? cats.map(categoryCard)
        : h('div', { class: 'empty' }, '아직 분류가 없습니다.', h('br'), '업무 옆', tagHint(), '버튼으로 내 분류에 넣을 수 있어요.'),
      state.form?.type === 'new' ? newCategoryForm() : h('button', { class: 'add-btn', text: '+ 새 분류', onclick: startNew })
    );
  }

  function renderCategory() {
    const c = currentCategory();
    if (!c) {
      return [
        h(
          'div',
          { class: 'state' },
          h('h2', { text: '분류를 찾을 수 없습니다' }),
          h('button', { class: 'primary-btn', text: '전체 보기', onclick: () => go({ name: 'overview' }) })
        ),
      ];
    }
    const n = c.counts;
    const region = liveRegion(() => {
      const terms = parseQuery(state.query);
      if (terms.length) return resultList(searchTasks(c.tasks, terms), terms);
      return c.tasks.length
        ? [h('div', { class: 'tasks' }, c.tasks.map((t) => taskItem(t, { showProject: true })))]
        : [h('div', { class: 'empty' }, '이 분류에 넣은 업무가 없습니다.', h('br'), '업무 옆', tagHint(), '버튼이나 검색으로 찾아 넣으세요.')];
    });
    return [
      h('div', { class: 'tiles' }, tile(n.open, '미완료'), tile(n.overdue, '지연', 'danger'), tile(n.dueSoon, '마감 임박', 'warn'), tile(n.closed, '완료', 'accent')),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'ghost-btn', text: '분류 관리', onclick: () => api.openCategoryManager(c.id) }),
        n.closed
          ? h('button', { class: 'ghost-btn', text: `완료 ${n.closed}건 정리`, onclick: () => categoryCall(api.categories.removeClosed(c.id)) })
          : null
      ),
      h('div', { class: 'panel' }, searchBox('이 분류에서 검색', () => region.update()), region.host),
    ];
  }

  // ---------- category popover ----------

  function openPopover(taskId, anchor) {
    state.popover = { taskId, anchor: anchor.getBoundingClientRect(), newName: '' };
    renderLayer();
  }

  function closePopover() {
    state.popover = null;
    if (state.deferred) render();
    else {
      renderLayer();
      // Refresh the dots on the task that was edited.
      render();
    }
  }

  async function toggleTaskCategory(task, categoryId, on) {
    const current = new Set(task.categoryIds || []);
    if (on) current.add(categoryId);
    else current.delete(categoryId);
    task.categoryIds = [...current]; // optimistic; the next snapshot confirms it
    await categoryCall(api.categories.setTaskCategories(task.id, task.categoryIds));
  }

  async function createAndAssign(task) {
    const pop = state.popover;
    const created = await categoryCall(api.categories.create({ name: pop.newName }));
    if (!created.ok) return;
    pop.newName = '';
    await toggleTaskCategory(task, created.result.id, true);
    // The category list in the menu comes from the snapshot; wait for it briefly.
    setTimeout(renderLayer, 150);
  }

  function renderPopover() {
    const pop = state.popover;
    const task = pop && findTask(pop.taskId);
    if (!task) return [];
    const cats = state.snapshot.categories || [];
    const ids = new Set(task.categoryIds || []);
    const menu = h(
      'div',
      { class: 'popover', onclick: (e) => e.stopPropagation() },
      h('div', { class: 'pop-title', text: '내 분류' }),
      cats.length ? null : h('div', { class: 'pop-empty', text: '아래에서 첫 분류를 만들어 보세요.' }),
      h(
        'div',
        { class: 'pop-list' },
        cats.map((c) =>
          h(
            'label',
            { class: 'pop-item' },
            h('input', { type: 'checkbox', checked: ids.has(c.id), onchange: (e) => toggleTaskCategory(task, c.id, e.target.checked) }),
            h('span', { class: 'cat-dot', style: `background:${c.color}` }),
            h('span', { class: 'pop-name', text: c.name })
          )
        )
      ),
      h(
        'div',
        { class: 'pop-new' },
        nameInput(pop.newName, (v) => (pop.newName = v), () => createAndAssign(task), closePopover),
        h('button', { class: 'primary-btn small', text: '추가', onclick: () => createAndAssign(task) })
      )
    );
    return [h('div', { class: 'overlay', onclick: closePopover }), menu];
  }

  // Keep the menu inside the window: below the anchor if it fits, otherwise above.
  function placePopover() {
    const menu = layerEl.querySelector('.popover');
    if (!menu || !state.popover) return;
    const a = state.popover.anchor;
    const w = menu.offsetWidth;
    const ht = menu.offsetHeight;
    const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
    let top = a.bottom + 4;
    if (top + ht > window.innerHeight - 8) top = Math.max(8, a.top - ht - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function renderLayer() {
    const nodes = state.popover ? renderPopover() : [];
    if (state.toast) nodes.push(h('div', { class: 'toast', text: state.toast }));
    const typed = layerEl.querySelector('.pop-new input')?.value;
    layerEl.replaceChildren(...nodes);
    placePopover();
    const input = layerEl.querySelector('.pop-new input');
    if (input) {
      if (typed && state.popover?.newName) input.value = state.popover.newName;
      input.focus();
    }
  }

  // ---------- states ----------

  function renderUnconfigured() {
    return [
      h(
        'div',
        { class: 'state' },
        h('h2', { text: '설정이 필요합니다' }),
        h('p', { text: '두레이 도메인과 API 토큰을 입력하면 대시보드가 표시됩니다.' }),
        h('button', { class: 'primary-btn', text: '설정 열기', onclick: () => api.openSettings() })
      ),
    ];
  }

  function renderLoading() {
    return [errorBanner(state.snapshot.status), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })];
  }

  // ---------- render loop ----------

  function render() {
    if (!state.snapshot || !state.context) return;
    renderTitlebar();

    const snap = state.snapshot;
    let content;
    if (snap.status.state === 'unconfigured') content = renderUnconfigured();
    else if (!snap.status.lastSuccessAt && !snap.projects.length) content = renderLoading();
    else if (state.context.mode === 'project' || state.view.name === 'project') content = renderProject();
    else if (state.view.name === 'category') content = renderCategory();
    else content = renderOverview();

    state.deferred = false;
    const scrollTop = mainEl.scrollTop;
    mainEl.replaceChildren(...content.filter(Boolean));
    mainEl.scrollTop = scrollTop;
    focusEnd(mainEl.querySelector('[data-autofocus]'));
    renderLayer();
  }

  // Focus an input with the caret after the existing text.
  function focusEnd(input) {
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  // Do not rebuild the page while the user is typing or choosing categories.
  function renderWhenIdle() {
    const searching = document.activeElement?.dataset?.search !== undefined;
    if (state.popover || state.form || searching || state.dragging) {
      state.deferred = true;
      renderTitlebar();
      return;
    }
    render();
  }

  // ---------- navigation history ----------

  const HISTORY_LIMIT = 50;
  const sameView = (a, b) => a.name === b.name && a.projectId === b.projectId && a.categoryId === b.categoryId;

  function currentNav() {
    return { view: state.view, section: state.section, tab: state.tab, scroll: mainEl.scrollTop };
  }

  /** Records the current screen before moving away from it; a new move clears "forward". */
  function remember() {
    state.history.back.push(currentNav());
    if (state.history.back.length > HISTORY_LIMIT) state.history.back.shift();
    state.history.forward = [];
  }

  function restore(nav) {
    state.view = nav.view;
    state.section = nav.section;
    state.tab = nav.tab;
    state.form = null;
    state.popover = null;
    state.query = '';
    render();
    mainEl.scrollTop = nav.scroll;
  }

  /** Back: close an open menu or form first, then clear the search, then the previous screen. */
  function goBack() {
    if (state.popover) return closePopover();
    if (state.form) return closeForm();
    if (state.query) {
      state.query = '';
      return render();
    }
    const prev = state.history.back.pop();
    if (!prev) return;
    state.history.forward.push(currentNav());
    restore(prev);
  }

  function goForward() {
    const next = state.history.forward.pop();
    if (!next) return;
    state.history.back.push(currentNav());
    restore(next);
  }

  function go(view) {
    if (!sameView(view, state.view)) remember();
    state.view = view;
    state.form = null;
    state.popover = null;
    state.query = '';
    state.tab = 'overdue';
    mainEl.scrollTop = 0;
    render();
  }

  // Mouse side buttons: 3 = back, 4 = forward. Chromium reports them on mouseup.
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      goForward();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.isComposing) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goBack();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      goForward();
    }
  });

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
    // Keep relative times ("3분 전", D-day labels) fresh.
    setInterval(renderWhenIdle, 30000);
    window.addEventListener('resize', placePopover);
  }

  init();
})();
