// Calendar theme page (theme contract v1, #61): month grid on top, the selected day's (or upcoming) events below
// (기본) or the big month layout (큰 달력, body[data-layout="month"]), and (#48) a small editor for events on
// writable CalDAV calendars. Everything goes through window.widget (the engine's theme API); view logic is in
// model.js. Writes need a click or key press (the engine checks), deletes are confirmed by the widget, and
// links are opened by event id: the page never handles a URL itself.
(() => {
  const M = window.CalendarModel;
  const W = window.widget;
  const target = (e) => ({ sourceId: e.sourceId, calendarId: e.calendarId, uid: e.uid });
  // The calls this page makes, on top of the calendar contract (docs/theme-guide.md).
  const api = {
    get: () => W.api.getState(),
    /** { grid, upcoming } ranges -> { grid: [...], upcoming: [...] } (events.list takes an array of ranges). */
    events: async (ranges) => {
      const res = await W.api.events.list([ranges.grid, ranges.upcoming]);
      return Array.isArray(res) ? { grid: res[0] || [], upcoming: res[1] || [] } : { grid: [], upcoming: [] };
    },
    openMenu: () => W.window.openMenu(),
    refresh: () => W.api.refresh(),
    openSettings: () => W.openSettings(),
    openLink: (e) => W.api.events.openLink(target(e)),
    saveEvent: (req) =>
      req.uid
        ? W.api.events.update({ sourceId: req.sourceId, calendarId: req.calendarId, uid: req.uid }, req.fields)
        : W.api.events.create({ sourceId: req.sourceId, calendarId: req.calendarId }, req.fields),
    deleteEvent: (req) => W.api.events.remove(target(req)),
    updateTodoDue: (req) => W.api.tasks.updateDue(req),
    onChanged: (callback) => W.on('changed', callback),
    onReveal: (callback) => W.on('reveal', callback),
    onOpenEditor: (callback) => W.on('open-editor', callback),
  };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const now0 = new Date();
  const taskLabels = {
    ko: { head: '할 일 목표 날짜 수정', allDay: '날짜만 지정', due: '목표 날짜', save: '저장', cancel: '취소', required: '목표 날짜를 지정하세요.', failed: '할 일 날짜를 저장하지 못했습니다.', completed: '완료한 할 일' },
    en: { head: 'Edit task due date', allDay: 'Date only', due: 'Due date', save: 'Save', cancel: 'Cancel', required: 'Choose a due date.', failed: 'Could not save the task due date.', completed: 'Completed task' },
  };
  const taskText = () => taskLabels[String(state.view.locale || '').startsWith('en') ? 'en' : 'ko'];
  const state = {
    view: { weekStart: 0, upcomingDays: 7, sources: [], lastUpdated: 0, errorCount: 0, refreshing: false, calendars: [], pending: [], unconfirmed: {} },
    year: now0.getFullYear(),
    month: now0.getMonth() + 1,
    selected: null,
    gridEvents: [],
    upEvents: [],
    today: M.dateKey(now0),
    detail: null,
    editing: null, // { event | null, saving }
  };
  let noticeTimer = null;
  let syncing = false; // the header 새로고침 is running (#81)
  let loadSeq = 0;

  /** Fetches events for the shown grid and for the upcoming range (one call, two ranges). */
  async function load() {
    const grid = M.monthGrid(state.year, state.month, state.view.weekStart);
    const today = M.dateKey(new Date());
    const ranges = {
      grid: { from: M.parseKey(grid.from).getTime(), to: M.parseKey(grid.to).getTime() },
      upcoming: { from: M.parseKey(today).getTime(), to: M.parseKey(M.addDays(today, state.view.upcomingDays)).getTime() },
    };
    const seq = ++loadSeq;
    const res = await api.events(ranges);
    if (seq !== loadSeq) return;
    state.gridEvents = res?.grid || [];
    state.upEvents = res?.upcoming || [];
    render();
  }

  function renderHeader() {
    $('month').textContent = `${state.year}년 ${state.month}월`;
    const labels = M.weekdayLabels(state.view.weekStart);
    $('weekdays').replaceChildren(
      ...labels.map((label, i) => {
        const wd = (i + state.view.weekStart) % 7;
        return el('div', wd === 0 ? 'sun' : wd === 6 ? 'sat' : '', label);
      }),
    );
  }

  function renderGrid(map) {
    const grid = M.monthGrid(state.year, state.month, state.view.weekStart);
    $('grid').replaceChildren(
      ...grid.days.map((d) => {
        const cls = ['cell'];
        if (!d.inMonth) cls.push('out');
        if (d.key === state.today) cls.push('is-today');
        if (d.key === state.selected) cls.push('selected');
        if (d.weekday === 0) cls.push('sun');
        if (d.weekday === 6) cls.push('sat');
        const cell = el('button', cls.join(' '));
        cell.type = 'button';
        cell.dataset.key = d.key;
        const list = map.get(d.key) || [];
        cell.title = list.length ? `${M.dayTitle(d.key)} · 일정 ${list.length}개` : M.dayTitle(d.key);
        cell.append(el('span', 'num', String(d.day)));
        const dots = el('span', 'dots');
        for (const color of M.dayColors(list)) {
          const dot = el('span', 'dot');
          dot.style.background = color;
          dots.append(dot);
        }
        cell.append(dots);
        return cell;
      }),
    );
  }

  const isPending = (e) => (state.view.pending || []).includes(e.uid);
  const unconfirmedOf = (e) => (state.view.unconfirmed || {})[e.uid] || null;

  function eventRow(e, key) {
    const li = el('li', isPending(e) ? 'event pending' : 'event');
    const bar = el('span', 'bar');
    bar.style.background = e.color || 'var(--accent)';
    li.append(bar, el('span', 'time', isPending(e) ? '저장 중…' : M.timeLabel(e, key)), el('span', 'title', e.title));
    if (unconfirmedOf(e)) li.append(el('span', 'flag', '⚠'));
    li.title = [e.title, e.location, unconfirmedOf(e) ? '반영 확인 안 됨' : ''].filter(Boolean).join('\n');
    li.addEventListener('click', () => showDetail(e));
    return li;
  }

  function relativeDay(key) {
    if (key === state.today) return `오늘 · ${M.dayTitle(key)}`;
    if (key === M.addDays(state.today, 1)) return `내일 · ${M.dayTitle(key)}`;
    return M.dayTitle(key);
  }

  function renderList(map) {
    const list = $('events');
    const empty = $('empty');
    const hasSources = state.view.sources.some((s) => s.enabled);
    list.replaceChildren();
    empty.hidden = true;
    empty.replaceChildren();
    $('clearDay').hidden = !state.selected;
    if (state.selected) {
      $('listTitle').textContent = relativeDay(state.selected);
      const items = map.get(state.selected) || [];
      list.append(...items.map((e) => eventRow(e, state.selected)));
      if (!items.length) {
        empty.textContent = hasSources ? '일정이 없습니다.' : '';
        empty.hidden = !hasSources;
      }
    } else {
      $('listTitle').textContent = `다가오는 일정 (${state.view.upcomingDays}일)`;
      const groups = M.upcoming(state.upEvents, new Date(), state.view.upcomingDays);
      for (const g of groups) {
        list.append(el('li', 'day-label', relativeDay(g.key)));
        list.append(...g.events.map((e) => eventRow(e, g.key)));
      }
      if (!groups.length && hasSources) {
        empty.textContent = `앞으로 ${state.view.upcomingDays}일 동안 일정이 없습니다.`;
        empty.hidden = false;
      }
    }
    if (!hasSources) {
      empty.append(el('div', '', state.view.sources.length ? '켜 둔 캘린더가 없습니다.' : '구독한 캘린더가 없습니다.'));
      empty.append(el('div', '', '설정에서 ICS 구독 주소를 추가하세요.'));
      const btn = el('button', '', '설정 열기');
      btn.type = 'button';
      btn.addEventListener('click', () => api.openSettings());
      empty.append(btn);
      empty.hidden = false;
    }
  }

  function renderFooter() {
    const v = state.view;
    const foot = $('updated');
    foot.replaceChildren();
    if (v.sources.some((s) => s.enabled)) {
      if (v.lastUpdated) {
        const d = new Date(v.lastUpdated);
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        foot.append(`마지막 갱신 ${M.dateKey(d) === state.today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`}`);
      } else foot.append(v.refreshing ? '받는 중…' : '아직 받지 못함');
      if (v.errorCount) foot.append(' · ', el('span', 'warn', `오류 ${v.errorCount}`));
    }
    foot.title = v.errorCount ? '오류가 난 구독은 설정 창에서 이유를 볼 수 있습니다.' : '';
    $('refresh').classList.toggle('spin', syncing || Boolean(v.refreshing));
  }

  // ---- big month calendar (#52 '큰 달력'): events inside the day cells ----

  const ROW_H = 16; // px per event row in a cell (big.css .brow height + gap)
  const isBig = () => document.body.dataset.layout === 'month';
  let bigEvents = []; // events of the drawn big grid, addressed by data-i

  /** Rows that fit in one day cell of the big grid (6 weeks fill the grid's height). */
  function capacity() {
    const h = $('grid').clientHeight / 6;
    return Math.max(1, Math.floor((h - 21) / ROW_H));
  }

  function bigRow(row) {
    if (!row) return el('div', 'brow gap'); // not .empty / .dot: those are global rules of the list (calendar.css)
    const e = row.event;
    let i = bigEvents.indexOf(e);
    if (i < 0) i = bigEvents.push(e) - 1;
    const pending = isPending(e) ? ' pending' : '';
    if (row.type === 'bar') {
      const bar = el('div', `brow bar${row.first ? ' first' : ''}${row.last ? ' last' : ''}${pending}`, row.head ? `${unconfirmedOf(e) ? '⚠ ' : ''}${e.title}` : '');
      bar.style.background = e.color || 'var(--accent)';
      bar.dataset.i = i;
      bar.title = `${e.title}\n${M.detailTime(e)}`;
      return bar;
    }
    const item = el('div', `brow item${pending}`);
    const dot = el('span', 'bdot');
    dot.style.background = e.color || 'var(--accent)';
    item.append(dot, el('span', 'bt', M.timeLabel(e, M.dateKey(new Date(e.start))).split(' ')[0]), el('span', 'btitle', `${unconfirmedOf(e) ? '⚠ ' : ''}${e.title}`));
    item.dataset.i = i;
    item.title = `${e.title}\n${M.detailTime(e)}${e.location ? `\n${e.location}` : ''}`;
    return item;
  }

  function renderBigGrid() {
    const grid = M.monthGrid(state.year, state.month, state.view.weekStart);
    const cap = capacity();
    bigEvents = [];
    const cells = [];
    for (const week of M.weeks(grid.days)) {
      const laid = M.weekLayout(week.map((d) => d.key), state.gridEvents, cap);
      week.forEach((d, i) => {
        const cls = ['bcell'];
        if (!d.inMonth) cls.push('out');
        if (d.key === state.today) cls.push('is-today');
        if (d.weekday === 0) cls.push('sun');
        if (d.weekday === 6) cls.push('sat');
        const cell = el('div', cls.join(' '));
        cell.dataset.key = d.key;
        cell.append(el('div', 'bnum', String(d.day)));
        cell.append(...laid[i].rows.map(bigRow));
        if (laid[i].more) {
          const more = el('div', 'brow more', `+${laid[i].more}개`);
          more.dataset.more = d.key;
          cell.append(more);
        }
        cells.push(cell);
      });
    }
    $('grid').replaceChildren(...cells);
  }

  /** The day popover of the big calendar: that day's full list. */
  function openDay(key) {
    const list = M.byDay(state.gridEvents, key, M.addDays(key, 1)).get(key) || [];
    $('pTitle').textContent = relativeDay(key);
    $('pEvents').replaceChildren(...list.map((e) => eventRow(e, key)));
    $('pEmpty').hidden = list.length > 0;
    $('pAdd').hidden = !(state.view.calendars || []).length;
    $('dayPop').dataset.key = key;
    $('dayPop').hidden = false;
  }

  const closeDay = () => ($('dayPop').hidden = true);

  function render() {
    state.today = M.dateKey(new Date());
    // The layout is the theme's (body data-layout in its page); the background opacity comes from the host.
    $('add').hidden = !(state.view.calendars || []).length;
    const grid = M.monthGrid(state.year, state.month, state.view.weekStart);
    const map = M.byDay(state.gridEvents, grid.from, grid.to);
    renderHeader();
    if (isBig()) renderBigGrid();
    else renderGrid(map);
    renderList(map);
    renderFooter();
  }

  function showDetail(e) {
    if (!e) return;
    state.detail = e;
    $('dColor').style.background = e.color || 'var(--accent)';
    $('dTitle').textContent = e.title;
    $('dTime').textContent = M.detailTime(e);
    $('dLocation').textContent = e.location ? `장소: ${e.location}` : '';
    $('dCalendar').textContent = e.sourceName || '';
    $('dDesc').textContent = e.description ? (e.description.length > 600 ? `${e.description.slice(0, 600)}…` : e.description) : '';
    $('dOpen').hidden = !e.hasUrl;
    const editable = !e.readOnly && !isPending(e);
    $('dEdit').hidden = !editable;
    $('dDelete').hidden = !editable || e.sourceId === 'todo';
    // Why it cannot be changed here (not for plain ICS subscriptions, which are read-only by nature).
    const note = [unconfirmedOf(e) ? `반영 확인 안 됨: ${unconfirmedOf(e)}` : '', isPending(e) ? '저장 중…' : '', e.readOnly && e.readOnlyReason && !/ICS/.test(e.readOnlyReason) ? e.readOnlyReason : '']
      .filter(Boolean)
      .join('\n');
    $('dNote').textContent = [e.completed ? taskText().completed : '', note].filter(Boolean).join('\n');
    $('detail').hidden = false;
  }

  // ---- notices and the event editor (#48) ----

  function notice(text, ms = 12000) {
    clearTimeout(noticeTimer);
    $('notice').textContent = text || '';
    $('notice').hidden = !text;
    if (text) noticeTimer = setTimeout(() => ($('notice').hidden = true), ms);
  }

  /**
   * 새로고침 (#81): the button stays pressed and turning until the widget has asked every server again (unchanged
   * calendars answer briefly), at least 600 ms so a quick answer is still seen; then "마지막 갱신" shows the new time
   * and an error is mentioned briefly (the details are in the settings window).
   */
  async function syncNow() {
    if (syncing) return;
    syncing = true;
    const btn = $('refresh');
    btn.classList.add('pressed', 'spin');
    const started = Date.now();
    let res;
    try {
      res = await api.refresh();
    } catch (err) {
      res = { ok: false, message: err.message };
    }
    const rest = 600 - (Date.now() - started);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    syncing = false;
    btn.classList.remove('pressed');
    try {
      state.view = (await api.get()) || state.view;
    } catch {
      // keep the last state
    }
    await load();
    if (res && res.ok === false) notice(`새로고침하지 못했습니다. ${res.message || ''}`.trim(), 6000);
    else if (res?.errorCount) notice(`새로고침: 캘린더 ${res.errorCount}개에서 오류가 났습니다. 자세한 내용은 설정 창에 있습니다.`, 6000);
  }

  const pad = (n) => String(n).padStart(2, '0');
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const localMs = (dateKey, time) => {
    const [y, m, d] = dateKey.split('-').map(Number);
    const [h, mi] = String(time || '00:00').split(':').map(Number);
    return new Date(y, m - 1, d, h || 0, mi || 0).getTime();
  };

  function openTodoEditor(e) {
    hideDetail();
    state.editing = { event: e, saving: false, todo: true };
    const labels = taskText();
    $('todoHead').textContent = labels.head;
    $('todoAllDayLabel').textContent = labels.allDay;
    $('todoDueLabel').textContent = labels.due;
    $('todoSave').textContent = labels.save;
    $('todoCancel').textContent = labels.cancel;
    $('todoTitle').textContent = e.title;
    $('todoDateOnly').checked = e.allDay;
    $('todoDate').value = e.allDay ? e.start : M.dateKey(new Date(e.start));
    $('todoTime').value = e.allDay ? '09:00' : hm(new Date(e.start));
    $('todoTime').hidden = e.allDay;
    $('todoError').textContent = '';
    $('todoEditor').hidden = false;
    $('todoDate').focus();
  }

  function closeTodoEditor() {
    if (state.editing?.saving) return;
    state.editing = null;
    $('todoEditor').hidden = true;
  }

  async function saveTodoEditor(event) {
    event.preventDefault();
    if (!state.editing?.todo || state.editing.saving) return;
    const date = $('todoDate').value;
    const dateOnly = $('todoDateOnly').checked;
    if (!date || (!dateOnly && !$('todoTime').value)) { $('todoError').textContent = taskText().required; return; }
    const dueAt = localMs(date, dateOnly ? '23:59' : $('todoTime').value);
    state.editing.saving = true;
    $('todoSave').disabled = true;
    let answer;
    try { answer = await api.updateTodoDue({ taskId: state.editing.event.taskId, dueAt, dateOnly }); }
    catch (err) { answer = { ok: false, message: err.message }; }
    state.editing.saving = false;
    $('todoSave').disabled = false;
    if (!answer?.ok) { $('todoError').textContent = answer?.message || taskText().failed; return; }
    closeTodoEditor();
    state.year = Number(date.slice(0, 4));
    state.month = Number(date.slice(5, 7));
    state.selected = date;
    load();
  }

  function calendarOptions(selectedKey, onlyOne) {
    const list = onlyOne ? [onlyOne] : state.view.calendars || [];
    $('edCal').replaceChildren(
      ...list.map((c) => {
        const o = el('option', '', c.name);
        o.value = JSON.stringify([c.sourceId, c.calendarId]);
        return o;
      }),
    );
    if (selectedKey && list.some((c) => JSON.stringify([c.sourceId, c.calendarId]) === selectedKey)) $('edCal').value = selectedKey;
    $('edCal').disabled = Boolean(onlyOne);
  }

  function syncAllDay() {
    const allDay = $('edAllDay').checked;
    $('edStartTime').hidden = allDay;
    $('edEndTime').hidden = allDay;
  }

  /** Opens the editor: a new event on the given day (next full hour, 1 hour), or the given event. */
  function openEditor(e, dayKey) {
    hideDetail();
    $('dayPop').hidden = true;
    state.editing = { event: e || null, saving: false };
    $('edError').textContent = '';
    $('edSave').disabled = false;
    $('edCancel').disabled = false;
    if (e) {
      $('edHead').textContent = '일정 수정';
      $('edTitle').value = e.title === '(제목 없음)' ? '' : e.title;
      calendarOptions(null, { sourceId: e.sourceId, calendarId: e.calendarId, name: e.sourceName || '' });
      $('edAllDay').checked = e.allDay;
      if (e.allDay) {
        $('edStartDate').value = e.start;
        $('edEndDate').value = M.addDays(e.end, -1);
        $('edStartTime').value = '09:00';
        $('edEndTime').value = '10:00';
      } else {
        const s = new Date(e.start);
        const en = new Date(e.end);
        $('edStartDate').value = M.dateKey(s);
        $('edStartTime').value = hm(s);
        $('edEndDate').value = M.dateKey(en);
        $('edEndTime').value = hm(en);
      }
      $('edLocation').value = e.location || '';
      $('edDesc').value = e.description || '';
    } else {
      $('edHead').textContent = '새 일정';
      $('edTitle').value = '';
      const last = state.view.lastCalendar ? JSON.stringify([state.view.lastCalendar.sourceId, state.view.lastCalendar.calendarId]) : null;
      calendarOptions(last, null);
      $('edAllDay').checked = false;
      // Next full hour (today), or the same hour on the chosen day; one hour long.
      const next = new Date();
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      const key = dayKey || M.dateKey(next);
      const start = new Date(localMs(key, hm(next)));
      if (key === state.today && M.dateKey(next) !== key) start.setTime(next.getTime());
      const end = new Date(start.getTime() + 3600000);
      $('edStartDate').value = M.dateKey(start);
      $('edStartTime').value = hm(start);
      $('edEndDate').value = M.dateKey(end);
      $('edEndTime').value = hm(end);
      $('edLocation').value = '';
      $('edDesc').value = '';
    }
    syncAllDay();
    $('editor').hidden = false;
    $('edTitle').focus();
  }

  function closeEditor() {
    if (state.editing?.saving) return;
    state.editing = null;
    $('editor').hidden = true;
  }

  /** Editor values -> { fields } or { error } (the main process checks again). */
  function readEditor() {
    const title = $('edTitle').value.trim();
    if (!title) return { error: '제목을 넣으세요.' };
    if (!$('edCal').value) return { error: '캘린더를 고르세요.' };
    const allDay = $('edAllDay').checked;
    const sd = $('edStartDate').value;
    const ed = $('edEndDate').value;
    if (!sd || !ed) return { error: '날짜를 넣으세요.' };
    const base = { title, allDay, location: $('edLocation').value.trim(), description: $('edDesc').value };
    if (allDay) {
      if (ed < sd) return { error: '끝 날짜가 시작 날짜보다 앞설 수 없습니다.' };
      return { fields: { ...base, start: sd, end: M.addDays(ed, 1) } };
    }
    if (!$('edStartTime').value || !$('edEndTime').value) return { error: '시간을 넣으세요.' };
    const start = localMs(sd, $('edStartTime').value);
    const end = localMs(ed, $('edEndTime').value);
    if (end <= start) return { error: '끝 시간이 시작 시간보다 뒤여야 합니다.' };
    return { fields: { ...base, start, end } };
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!state.editing || state.editing.saving) return;
    const read = readEditor();
    if (read.error) {
      $('edError').textContent = read.error;
      return;
    }
    const [sourceId, calendarId] = JSON.parse($('edCal').value);
    const editing = state.editing.event;
    // The main process answers at once (#63): the write goes on in the background, the event shows as
    // "저장 중…" and a failure comes as a notification card. Only checks it can make right away come back here.
    state.editing.saving = true;
    $('edSave').disabled = true;
    $('edCancel').disabled = true;
    let res;
    try {
      res = await api.saveEvent({ sourceId, calendarId, uid: editing ? editing.uid : null, fields: read.fields });
    } catch (err) {
      res = { ok: false, message: err.message };
    }
    state.editing.saving = false;
    $('edSave').disabled = false;
    $('edCancel').disabled = false;
    if (!res?.ok) {
      $('edError').textContent = res?.message || '저장하지 못했습니다.';
      return;
    }
    closeEditor();
    // Show the day of the saved event.
    const key = read.fields.allDay ? read.fields.start : M.dateKey(new Date(read.fields.start));
    const d = M.parseKey(key);
    state.year = d.getFullYear();
    state.month = d.getMonth() + 1;
    state.selected = key;
    load();
  }

  async function deleteDetail() {
    const e = state.detail;
    if (!e) return;
    hideDetail();
    const res = await api.deleteEvent(e); // the widget asks first (its own confirm dialog)
    if (res?.cancelled) return;
    if (!res?.ok) notice(res?.message || '삭제하지 못했습니다.');
    load();
  }

  function hideDetail() {
    state.detail = null;
    $('detail').hidden = true;
  }

  function goMonth(delta) {
    const d = new Date(state.year, state.month - 1 + delta, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth() + 1;
    state.selected = null;
    load();
  }

  $('prev').addEventListener('click', () => goMonth(-1));
  $('next').addEventListener('click', () => goMonth(1));
  $('today').addEventListener('click', () => {
    const d = new Date();
    state.year = d.getFullYear();
    state.month = d.getMonth() + 1;
    state.selected = null;
    load();
  });
  $('clearDay').addEventListener('click', () => {
    state.selected = null;
    render();
  });
  $('grid').addEventListener('click', (event) => {
    if (isBig()) {
      const row = event.target.closest('[data-i]');
      if (row) return showDetail(bigEvents[Number(row.dataset.i)]);
      const big = event.target.closest('.bcell');
      if (big) openDay(big.dataset.key);
      return;
    }
    const cell = event.target.closest('.cell');
    if (!cell) return;
    const key = cell.dataset.key;
    if (cell.classList.contains('out')) {
      // A day of the previous/next month opens that month with the day selected.
      const d = M.parseKey(key);
      state.year = d.getFullYear();
      state.month = d.getMonth() + 1;
      state.selected = key;
      load();
      return;
    }
    state.selected = state.selected === key ? null : key;
    render();
  });
  $('grid').addEventListener(
    'wheel',
    (event) => {
      if (Math.abs(event.deltaY) < 1) return;
      event.preventDefault();
      goMonth(event.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );
  $('refresh').addEventListener('click', syncNow);
  $('add').addEventListener('click', () => openEditor(null, state.selected || state.today));
  $('grid').addEventListener('dblclick', (event) => {
    const cell = event.target.closest('.cell, .bcell');
    if (!cell || event.target.closest('[data-i]') || !(state.view.calendars || []).length) return;
    closeDay();
    openEditor(null, cell.dataset.key);
  });
  $('pClose').addEventListener('click', closeDay);
  $('pAdd').addEventListener('click', () => {
    const key = $('dayPop').dataset.key;
    closeDay();
    openEditor(null, key);
  });
  $('dayPop').addEventListener('click', (event) => {
    if (event.target === $('dayPop')) closeDay();
  });
  // The big grid's rows per cell follow the window size.
  let lastHeight = 0;
  new ResizeObserver(() => {
    const h = $('grid').clientHeight;
    if (isBig() && Math.abs(h - lastHeight) > 2) {
      lastHeight = h;
      renderBigGrid();
    }
  }).observe($('grid'));
  $('edForm').addEventListener('submit', saveEditor);
  $('todoForm').addEventListener('submit', saveTodoEditor);
  $('todoCancel').addEventListener('click', closeTodoEditor);
  $('todoDateOnly').addEventListener('change', () => { $('todoTime').hidden = $('todoDateOnly').checked; });
  $('todoEditor').addEventListener('click', (event) => { if (event.target === $('todoEditor')) closeTodoEditor(); });
  $('edCancel').addEventListener('click', closeEditor);
  $('edAllDay').addEventListener('change', syncAllDay);
  $('editor').addEventListener('click', (event) => {
    if (event.target === $('editor')) closeEditor();
  });
  $('edStartDate').addEventListener('change', () => {
    if ($('edEndDate').value < $('edStartDate').value) $('edEndDate').value = $('edStartDate').value;
  });
  $('dEdit').addEventListener('click', () => {
    if (!state.detail) return;
    if (state.detail.sourceId === 'todo') openTodoEditor(state.detail);
    else openEditor(state.detail);
  });
  $('dDelete').addEventListener('click', deleteDetail);
  $('notice').addEventListener('click', () => notice(''));
  $('dClose').addEventListener('click', hideDetail);
  $('detail').addEventListener('click', (event) => {
    if (event.target === $('detail')) hideDetail();
  });
  // By event id: the widget opens that event's own http(s) link, the page never passes a URL.
  $('dOpen').addEventListener('click', () => {
    if (state.detail?.hasUrl) api.openLink(state.detail);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.editing?.todo) closeTodoEditor();
      else if (state.editing) closeEditor();
      else if (!$('detail').hidden) hideDetail();
      else closeDay();
    }
  });
  // Outside the drag region the page gets the right-click; the engine drops a duplicate of the same click.
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.openMenu();
  });

  // ---- from a notification card (#63): 열기 shows the event, 다시 시도 after a conflict opens the editor ----

  const sameEvent = (e, req) => e.uid === req.uid && e.sourceId === req.sourceId && e.calendarId === req.calendarId;

  /** Goes to the month of req.day, loads it, and returns the event if it is there. */
  async function goTo(req) {
    hideDetail();
    closeDay();
    if (state.editing && !state.editing.saving) closeEditor();
    if (req.day) {
      const d = M.parseKey(req.day);
      state.year = d.getFullYear();
      state.month = d.getMonth() + 1;
      state.selected = isBig() ? null : req.day;
    }
    await load();
    return [...state.gridEvents, ...state.upEvents].find((e) => sameEvent(e, req)) || null;
  }

  api.onReveal(async (req) => {
    const e = await goTo(req);
    if (e) showDetail(e);
    else if (req.day && isBig()) openDay(req.day);
  });

  api.onOpenEditor(async (req) => {
    const e = await goTo(req);
    if (e && !e.readOnly) openEditor(e);
    else if (e) showDetail(e);
    else notice('그 일정을 찾지 못했습니다. 다른 곳에서 삭제되었을 수 있습니다.');
  });

  // Settings, data or refresh status changed: reload (one IPC call over the cached events).
  api.onChanged((view) => {
    state.view = view;
    load();
  });

  // A new day (midnight, or after sleep) moves "today" and the upcoming list; ended events drop off.
  setInterval(() => {
    const today = M.dateKey(new Date());
    if (today !== state.today) load();
    else renderList(M.byDay(state.gridEvents, null, null));
  }, 60000);

  api.get().then((view) => {
    state.view = view;
    load();
  });
})();
