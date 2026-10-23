// "Agenda" theme: open tasks by deadline like a calendar app — overdue, today, tomorrow, this week, later.
(() => {
  const api = window.dooray;
  const K = window.DoorayKit;
  const { h, highlight, dueDays, dueLabel, parseQuery, searchTasks, byUrgency, startOfDay } = K;
  const headEl = document.getElementById('head');
  const bodyEl = document.getElementById('body');

  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const state = {
    context: null,
    snapshot: null,
    pinned: false,
    scope: null, // 'mine' | 'all' (chosen on first snapshot)
    searching: false,
    query: '',
    showUndated: false,
    deferred: false,
  };

  K.onBackForward(
    () => {
      if (state.query || state.searching) closeSearch();
    },
    () => {}
  );

  const projectWindow = () => state.context?.mode === 'project';

  function colorOf(id) {
    let n = 2166136261;
    for (const ch of String(id)) n = Math.imul(n ^ ch.charCodeAt(0), 16777619) >>> 0;
    return `hsl(${Math.round((n % 1000) * 137.508) % 360} 60% 52%)`;
  }

  function iconBtn(icon, title, onclick, extra = '') {
    return h('button', { class: `icon-btn ${extra}`, title, 'aria-label': title, icon, onclick });
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  const dayTitle = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;

  // ---------- data ----------

  function scopedTasks() {
    const snap = state.snapshot;
    let tasks = K.openTasks(snap, projectWindow() ? state.context.projectId : null);
    if (state.scope === 'mine') tasks = tasks.filter((t) => t.isMine);
    return searchTasks(tasks, parseQuery(state.query)).slice().sort(byUrgency);
  }

  /** Days until this week's Sunday (the week runs Monday–Sunday). */
  function daysLeftInWeek() {
    const dow = new Date().getDay();
    return dow === 0 ? 0 : 7 - dow;
  }

  /** Splits tasks into ordered agenda groups. Each group: { key, title, sub?, tone?, tasks }. */
  function groupTasks(tasks) {
    const today = startOfDay(new Date());
    const weekLeft = daysLeftInWeek();
    const groups = new Map();
    const add = (key, make, t) => {
      if (!groups.has(key)) groups.set(key, { key, tasks: [], ...make() });
      groups.get(key).tasks.push(t);
    };
    for (const t of tasks) {
      const d = dueDays(t);
      if (d === null) add('none', () => ({ order: 9999, title: '마감 없음', tone: 'muted' }), t);
      else if (t.dueState === 'overdue' || d < 0) add('past', () => ({ order: -1, title: '지난 업무', tone: 'danger' }), t);
      else if (d === 0) add('d0', () => ({ order: 0, title: '오늘', sub: dayTitle(today), tone: 'today' }), t);
      else if (d === 1) add('d1', () => ({ order: 1, title: '내일', sub: dayTitle(addDays(today, 1)) }), t);
      else if (d <= weekLeft) add(`d${d}`, () => ({ order: d, title: dayTitle(addDays(today, d)) }), t);
      else if (d <= weekLeft + 7) add('next', () => ({ order: 100, title: '다음 주' }), t);
      else add('later', () => ({ order: 200, title: '그 이후' }), t);
    }
    return [...groups.values()].sort((a, b) => a.order - b.order);
  }

  // ---------- header ----------

  function renderHead(tasks) {
    const snap = state.snapshot;
    const now = new Date();
    const status = K.statusInfo(snap.status);
    const project = projectWindow() ? snap.projects.find((p) => p.id === state.context.projectId) : null;
    const todayCount = tasks.filter((t) => dueDays(t) === 0 && t.dueState !== 'overdue').length;
    const pastCount = tasks.filter((t) => t.dueState === 'overdue').length;

    headEl.replaceChildren(
      h(
        'div',
        { class: 'head-row' },
        h(
          'div',
          { class: 'date' },
          h('span', { class: 'date-num', text: now.getDate() }),
          h(
            'span',
            { class: 'date-text' },
            h('b', { text: `${WEEKDAYS[now.getDay()]}요일` }),
            h('span', { text: project ? project.name : `${now.getFullYear()}년 ${now.getMonth() + 1}월` })
          )
        ),
        h(
          'div',
          { class: 'tools' },
          iconBtn('search', '검색', toggleSearch, state.searching ? 'active' : ''),
          iconBtn('refresh', '새로고침', () => api.refresh(), snap.status.refreshing ? 'spin' : ''),
          iconBtn('pin', state.pinned ? '항상 위 해제' : '항상 위', togglePin, state.pinned ? 'active' : ''),
          iconBtn('settings', '설정', () => api.openSettings()),
          iconBtn('close', projectWindow() ? '위젯 닫기' : '종료', () => api.window.close())
        )
      ),
      h(
        'div',
        { class: 'summary' },
        h('span', { class: `status-dot ${status.dot}` }),
        h('span', { class: 'summary-text', text: `오늘 마감 ${todayCount} · 지난 업무 ${pastCount}` }),
        h('span', { class: 'summary-time', text: status.text })
      ),
      state.searching ? searchBox() : '', // replaceChildren would print null
      h(
        'div',
        { class: 'segment' },
        ['mine', 'all'].map((key) =>
          h('button', {
            class: state.scope === key ? 'on' : '',
            text: key === 'mine' ? `내 업무` : '전체',
            onclick: () => {
              state.scope = key;
              render();
            },
          })
        )
      ),
      weekStrip(tasks)
    );
  }

  function searchBox() {
    const input = h('input', {
      class: 'search',
      type: 'text',
      placeholder: '제목, 번호, 담당자, 태그, 초성',
      value: state.query,
      'data-search': true,
      spellcheck: 'false',
      oninput: (e) => {
        state.query = e.target.value;
        renderBody();
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && !e.isComposing) closeSearch();
      },
      onblur: () => setTimeout(() => state.deferred && renderWhenIdle(), 250),
    });
    setTimeout(() => input.focus(), 0);
    return input;
  }

  function toggleSearch() {
    if (state.searching) return closeSearch();
    state.searching = true;
    render();
  }

  function closeSearch() {
    state.searching = false;
    state.query = '';
    render();
  }

  /** Monday–Sunday of this week with a dot per task due that day. */
  function weekStrip(tasks) {
    const today = startOfDay(new Date());
    const monday = addDays(today, -((today.getDay() + 6) % 7));
    const perDay = new Map();
    for (const t of tasks) {
      const d = dueDays(t);
      if (d !== null && t.dueState !== 'overdue') perDay.set(d, (perDay.get(d) || 0) + 1);
    }
    return h(
      'div',
      { class: 'week' },
      Array.from({ length: 7 }, (_, i) => {
        const day = addDays(monday, i);
        const offset = Math.round((day - today) / 86400000);
        const count = offset >= 0 ? perDay.get(offset) || 0 : 0;
        return h(
          'button',
          {
            class: `day ${offset === 0 ? 'today' : ''} ${offset < 0 ? 'past' : ''} ${day.getDay() === 0 ? 'sun' : ''}`,
            title: count ? `${dayTitle(day)} 마감 ${count}건` : dayTitle(day),
            onclick: () => scrollToDay(offset),
          },
          h('span', { class: 'day-name', text: WEEKDAYS[day.getDay()] }),
          h('span', { class: 'day-num', text: day.getDate() }),
          h('span', { class: 'dots' }, Array.from({ length: Math.min(count, 3) }, () => h('i')))
        );
      })
    );
  }

  function scrollToDay(offset) {
    const key = offset < 0 ? 'past' : `d${offset}`;
    const el = bodyEl.querySelector(`[data-group="${key}"]`);
    if (el) bodyEl.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
  }

  async function togglePin() {
    state.pinned = await api.window.togglePin();
    render();
  }

  // ---------- body ----------

  function item(t, terms, tone) {
    const people = t.assignees.map((a) => a.name).join(', ') || '미지정';
    return h(
      'div',
      { class: 'event', role: 'button', tabindex: '0', title: t.subject, style: `--c:${colorOf(t.projectId)}`, onclick: () => api.openUrl(t.url) },
      h('span', { class: 'event-bar' }),
      h(
        'div',
        { class: 'event-main' },
        h('div', { class: 'event-title' }, highlight(t.subject, terms)),
        h('div', { class: 'event-sub' }, projectWindow() ? null : h('span', { text: t.projectName }), h('span', {}, highlight(people, terms)), h('span', { text: t.workflowName }))
      ),
      tone === 'danger' ? h('span', { class: 'event-late', text: dueLabel(t) }) : t.priority === 'highest' ? h('span', { class: 'event-flag', text: '긴급' }) : null,
      state.snapshot?.integrations?.todoEnabled ? h('button', { class: 'todo-add', title: /^en\b/i.test(navigator.language || '') ? 'Add to Todo' : '할 일에 추가', text: '+', onclick: async (e) => { e.stopPropagation(); const res = await api.addToTodo(t.id); if (res?.ok) e.currentTarget.textContent = '✓'; else window.alert(res?.message || (/^en\b/i.test(navigator.language || '') ? 'Could not add to Todo.' : '할 일에 추가하지 못했습니다.')); } }) : null
    );
  }

  function renderBody(tasks = scopedTasks()) {
    const terms = parseQuery(state.query);
    const groups = groupTasks(tasks);
    const content = [];
    if (state.snapshot.status.state === 'error') content.push(h('div', { class: 'banner', text: `⚠ ${state.snapshot.status.message || '데이터를 가져오지 못했습니다.'}` }));
    if (terms.length) content.push(h('div', { class: 'result', text: `검색 결과 ${tasks.length}건` }));
    if (!groups.length) content.push(h('div', { class: 'empty', text: terms.length ? '검색 결과가 없습니다.' : '예정된 업무가 없습니다.' }));
    for (const g of groups) {
      const folded = g.key === 'none' && !state.showUndated && !terms.length;
      content.push(
        h(
          'section',
          { class: `group ${g.tone || ''}`, 'data-group': g.key },
          h(
            'header',
            { class: 'group-head' },
            h('span', { class: 'group-title', text: g.title }),
            g.sub ? h('span', { class: 'group-sub', text: g.sub }) : null,
            h('span', { class: 'group-count', text: g.tasks.length }),
            g.key === 'none'
              ? h('button', {
                  class: 'fold',
                  text: folded ? '펼치기' : '접기',
                  onclick: () => {
                    state.showUndated = !state.showUndated;
                    renderBody();
                  },
                })
              : null
          ),
          folded ? null : g.tasks.slice(0, 200).map((t) => item(t, terms.length ? terms : null, g.tone))
        )
      );
    }
    state.deferred = false;
    const top = bodyEl.scrollTop;
    bodyEl.replaceChildren(...content);
    bodyEl.scrollTop = top;
  }

  // ---------- render loop ----------

  function render() {
    const snap = state.snapshot;
    if (!snap || !state.context) return;
    if (!state.scope && snap.status.lastSuccessAt) state.scope = snap.summary.counts.mine ? 'mine' : 'all';
    if (!state.scope) state.scope = 'all';

    if (snap.status.state === 'unconfigured' || (!snap.status.lastSuccessAt && !snap.projects.length)) {
      renderHead([]);
      bodyEl.replaceChildren(
        snap.status.state === 'unconfigured'
          ? h(
              'div',
              { class: 'state' },
              h('h2', { text: '설정이 필요합니다' }),
              h('p', { text: '두레이 도메인과 API 토큰을 입력하면 일정이 표시됩니다.' }),
              h('button', { class: 'primary', text: '설정 열기', onclick: () => api.openSettings() })
            )
          : h('div', { class: 'empty', text: '불러오는 중…' })
      );
      return;
    }
    const tasks = scopedTasks();
    const searchFocused = document.activeElement?.dataset?.search !== undefined;
    if (!searchFocused) renderHead(tasks);
    renderBody(tasks);
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
