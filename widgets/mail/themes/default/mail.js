// Mail theme page 기본 (#65, mail theme contract v1): the unified list with account chips, and a text detail
// view. Everything goes through window.widget; view helpers are the kit's mail-model.js. Mail content is
// someone else's text: always textContent. Calls that change mail or open something run straight from a
// click handler (the engine requires a user gesture for them).
(() => {
  const M = window.MailModel;
  const W = window.widget;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const state = { view: null, items: [], hasMore: false, filter: '', category: '', detail: null, loading: false, selected: null };
  const NONE = '__none__'; // the widget's "분류 없음" filter
  const catsOf = () => state.view?.categories || [];
  // Back / forward (mouse side buttons, Alt+← / Alt+→, the ‹ button): kit nav.js keeps snapshots of screens.
  const history = window.MailNav.createHistory();
  let noticeTimer = null;
  let listSeq = 0;

  /** A message at the bottom; with action { label, run } a button (e.g. "웹메일로 쓰기") that stays until used. */
  function notice(text, action = null) {
    clearTimeout(noticeTimer);
    $('notice').replaceChildren(el('span', '', text || ''));
    if (action) {
      const btn = el('button', 'notice-btn', action.label);
      btn.type = 'button';
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        notice('');
        action.run(); // inside this click: the call keeps its user gesture
      });
      $('notice').append(btn);
    }
    $('notice').hidden = !text;
    if (text) noticeTimer = setTimeout(() => notice(''), action ? 15000 : 6000);
  }

  /** Shows { ok: false, message } answers; retry(via) offers the account's other way of writing. */
  const check = (res, retry = null) => {
    if (res && res.ok === false && res.message) {
      const other = res.fallback === 'webmail' ? '웹메일로 쓰기' : res.fallback === 'mailto' ? '메일 프로그램으로 쓰기' : null;
      notice(res.message, other && retry ? { label: other, run: () => retry(res.fallback).then((r) => check(r)) } : null);
    }
    return res;
  };
  /** 새 메일 / 답장 / 전달: says something at once (the body may take a moment), then the result. */
  const write = (run) => {
    notice('메일 쓰기 창을 여는 중…');
    return run(undefined).then((res) => {
      if (res?.ok && res.via === 'widget') notice('');
      else if (res?.ok) notice(res.note || (res.via === 'webmail' ? '웹메일을 열었습니다.' : '메일 프로그램으로 넘겼습니다.'), res.via === 'mailto' && state.detail?.hasWebmail ? { label: '웹메일로 쓰기', run: () => run('webmail').then((r) => check(r)) } : null);
      return check(res, run);
    });
  };

  async function loadState() {
    state.view = await W.api.getState();
    state.category = state.view?.categoryFilter || ''; // the widget keeps the filter for 더 보기
    renderHead();
  }

  async function loadList() {
    const seq = ++listSeq;
    const res = await W.api.list();
    if (seq !== listSeq || !res || !Array.isArray(res.items)) return;
    state.items = res.items;
    state.hasMore = res.hasMore;
    renderList();
  }

  function renderHead() {
    const v = state.view;
    if (!v) return;
    $('total').textContent = String(v.totalUnread);
    $('total').hidden = !v.totalUnread;
    $('refresh').classList.toggle('spin', Boolean(v.refreshing) || $('refresh').dataset.busy === '1');
    const live = v.accounts.filter((a) => a.enabled);
    if (state.filter && !live.some((a) => a.id === state.filter)) state.filter = '';
    const all = el('button', `chip${state.filter ? '' : ' on'}`);
    all.type = 'button';
    all.append(el('span', '', '전체'), el('span', 'n', String(v.totalUnread || '')));
    all.addEventListener('click', () => setFilter(''));
    $('chips').replaceChildren(
      ...(live.length > 1 ? [all] : []),
      ...(live.length > 1 || live.some((a) => a.state === 'error')
        ? live.map((a) => {
            const chip = el('button', `chip${state.filter === a.id ? ' on' : ''}${a.state === 'error' ? ' err' : ''}`);
            chip.type = 'button';
            chip.title = M.accountStatus(a);
            const dot = el('span', 'dot');
            dot.style.background = a.color;
            chip.append(dot, el('span', '', a.state === 'error' ? `⚠ ${a.name}` : a.name), el('span', 'n', a.unread ? String(a.unread) : ''));
            chip.addEventListener('click', () => setFilter(state.filter === a.id ? '' : a.id));
            return chip;
          })
        : []),
    );
    renderCats();
    $('updated').textContent = v.sending ? `✉ 보내는 중… (${v.sending}통)` : v.paused ? '자리 비움 중 멈춤' : v.refreshing ? '받는 중…' : v.lastUpdated ? `갱신 ${M.timeLabel(v.lastUpdated)}` : '';
    // A send that just finished (failures also come as a notification card from the widget).
    if (v.lastSent && v.lastSent.at !== state.lastSentAt) {
      if (state.lastSentAt !== undefined && v.lastSent.ok) notice(`보냈습니다: ${v.lastSent.subject || '(제목 없음)'}${v.lastSent.note ? ` (${v.lastSent.note})` : ''}`);
      state.lastSentAt = v.lastSent.at;
    } else if (state.lastSentAt === undefined) state.lastSentAt = v.lastSent ? v.lastSent.at : null;
    $('errors').hidden = !v.errorCount;
    $('errors').textContent = v.errorCount ? `⚠ 연결 오류 ${v.errorCount}개 — 설정` : '';
  }

  // ---- #69 categories (this PC only) ----

  /** The category filter chips: 전체 · each category (count of loaded mail) · 분류 없음. */
  function renderCats() {
    const cats = catsOf();
    $('cats').hidden = !cats.length;
    if (!cats.length) return;
    const chip = (id, label, color, count) => {
      const b = el('button', `chip${state.category === id ? ' on' : ''}`);
      b.type = 'button';
      if (color) {
        const dot = el('span', 'dot');
        dot.style.background = color;
        b.append(dot);
      }
      b.append(el('span', '', label));
      if (count) b.append(el('span', 'n', String(count)));
      b.addEventListener('click', () => setCategory(state.category === id ? '' : id));
      return b;
    };
    $('cats').replaceChildren(chip('', '모든 분류'), ...cats.map((c) => chip(c.id, c.name, c.color, c.count)), chip(NONE, '분류 없음'));
  }

  /** Category chips of a message (row or detail). */
  function catChips(ids) {
    const byId = new Map(catsOf().map((c) => [c.id, c]));
    return (ids || []).filter((id) => byId.has(id)).map((id) => {
      const c = byId.get(id);
      const s = el('span', 'cat', c.name);
      s.style.borderColor = c.color;
      s.style.background = `${c.color}33`;
      return s;
    });
  }

  async function applyCategory(id) {
    state.category = id;
    const res = await W.api.filter(id);
    if (res && Array.isArray(res.items)) {
      state.items = res.items;
      state.hasMore = res.hasMore;
    }
    renderCats();
    renderList();
  }

  function setCategory(id) {
    if (id === state.category) return;
    navigate(() => {
      applyCategory(id);
      $('list').scrollTop = 0;
    });
  }

  let popFor = null;
  function closePop() {
    popFor = null;
    $('catPop').hidden = true;
  }

  /** The 분류 popover for a message, near (x, y) inside the widget. */
  function openPop(id, x, y) {
    const item = state.items.find((m) => m.id === id) || (state.detail?.id === id ? state.detail : null);
    if (!item) return;
    popFor = id;
    $('catPopTitle').textContent = `분류: ${item.subject || '(제목 없음)'}`;
    renderPopList(item.categoryIds || []);
    const pop = $('catPop');
    pop.hidden = false;
    const app = $('app').getBoundingClientRect();
    pop.style.left = `${Math.max(6, Math.min(x - app.left, app.width - pop.offsetWidth - 6))}px`;
    pop.style.top = `${Math.max(6, Math.min(y - app.top, app.height - pop.offsetHeight - 6))}px`;
    $('catNewName').value = '';
  }

  function renderPopList(selected) {
    const set = new Set(selected);
    const cats = catsOf();
    $('catPopList').replaceChildren(
      ...(cats.length
        ? cats.map((c) => {
            const li = el('li');
            const label = el('label');
            const box = el('input');
            box.type = 'checkbox';
            box.checked = set.has(c.id);
            box.addEventListener('change', () => toggle(c.id, box.checked));
            const dot = el('span', 'dot');
            dot.style.background = c.color;
            label.append(box, dot, el('span', '', c.name));
            li.append(label);
            return li;
          })
        : [el('li', 'cat-pop-hint', '아직 분류가 없습니다. 아래에서 만드세요.')]),
    );
  }

  const idsOfPop = () => (state.items.find((m) => m.id === popFor) || state.detail || {}).categoryIds || [];

  /** A checkbox in the popover: called inside the click, so the widget accepts it (user gesture). */
  async function toggle(catId, on) {
    const id = popFor;
    if (!id) return;
    const cur = new Set(idsOfPop());
    if (on) cur.add(catId);
    else cur.delete(catId);
    const res = check(await W.api.setCategories(id, [...cur]));
    if (res?.ok) applyIds(id, res.categoryIds);
  }

  function applyIds(id, ids) {
    const row = state.items.find((m) => m.id === id);
    if (row) row.categoryIds = ids;
    if (state.detail?.id === id) {
      state.detail.categoryIds = ids;
      $('dCatChips').replaceChildren(...catChips(ids));
    }
    if (popFor === id) renderPopList(ids);
    renderList();
  }

  $('catNew').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('catNewName').value.trim();
    const id = popFor;
    if (!name || !id) return;
    const res = check(await W.api.createCategory(name));
    if (!res?.ok) return;
    state.view = { ...state.view, categories: res.categories.map((c) => ({ ...c, count: 0 })) };
    $('catNewName').value = '';
    // The new category goes on this message right away (the Enter / click was the gesture).
    const set = await W.api.setCategories(id, [...idsOfPop(), res.category.id]);
    if (set?.ok) applyIds(id, set.categoryIds);
    renderCats();
  });
  document.addEventListener('mousedown', (event) => {
    if (!$('catPop').hidden && !event.target.closest('#catPop') && !event.target.closest('#dCats')) closePop();
  });

  function setFilter(id) {
    if (id === state.filter) return;
    navigate(() => {
      state.filter = id;
      renderHead();
      renderList();
      $('list').scrollTop = 0;
    });
  }

  // ---- back / forward ----

  /** What is on screen now: list (with its filter, scroll position, highlighted row) or a message. */
  const snapshot = () => ({
    screen: state.detail ? 'detail' : 'list',
    id: state.detail?.id || null,
    filter: state.filter,
    category: state.category,
    scroll: $('list').scrollTop,
    selected: state.selected,
  });

  /** A move to a new screen: remember this one first (a new move clears "forward"). */
  function navigate(apply) {
    history.record(snapshot());
    apply();
  }

  function restore(snap) {
    closePop();
    if ((snap.category || '') !== state.category) applyCategory(snap.category || '');
    state.filter = snap.filter;
    state.selected = snap.selected;
    renderHead();
    renderList();
    if (snap.screen === 'detail' && snap.id && state.items.some((m) => m.id === snap.id)) openDetail(snap.id, true);
    else hideDetail();
    $('list').scrollTop = snap.scroll;
    requestAnimationFrame(() => ($('list').scrollTop = snap.scroll));
  }

  /** Back: nothing to go back to = nothing happens (the widget stays as it is). */
  function goBack() {
    const prev = history.back(snapshot());
    if (prev) restore(prev);
  }

  function goForward() {
    const next = history.forward(snapshot());
    if (next) restore(next);
  }

  /** ‹ / Esc / 안 읽음: the previous screen, or simply the list when there is no history. */
  function closeDetail() {
    if (history.canBack()) goBack();
    else hideDetail();
  }

  function renderList() {
    const items = M.filterBy(state.items, state.filter);
    const now = Date.now();
    $('list').replaceChildren(
      ...items.map((m) => {
        const li = el('li', `row${m.unread ? ' unread' : ''}${m.id === state.selected ? ' selected' : ''}`);
        li.dataset.id = m.id;
        const bar = el('span', 'bar');
        bar.style.background = m.color;
        const body = el('div', 'body');
        const line1 = el('div', 'line1');
        line1.append(el('span', 'from', M.senderLabel(m.from)), el('span', 'marks', `${m.hasAttachments ? '📎' : ''}${m.flagged ? '★' : ''}`), el('span', 'time', M.timeLabel(m.date, now)));
        // #80: mail from a chosen mailbox shows where it is.
        if (m.folder && m.folder !== 'INBOX') line1.insertBefore(el('span', 'folder-tag', m.folder), line1.children[1]);
        body.append(line1, el('div', 'subject', m.subject || '(제목 없음)'));
        if (m.categoryIds?.length) {
          const line = el('div', 'cats-line');
          line.append(...catChips(m.categoryIds));
          body.append(line);
        }
        if (m.snippet) body.append(el('div', 'snippet', m.snippet));
        li.title = `${m.accountName} · ${M.fullDate(m.date)}`;
        li.append(bar, body);
        return li;
      }),
    );
    const v = state.view;
    const hasAccounts = v && v.accounts.some((a) => a.enabled);
    $('empty').hidden = items.length > 0;
    $('empty').textContent = !hasAccounts ? '메일 계정이 없습니다. 오른쪽 클릭 → 설정에서 계정을 추가하세요.' : v.refreshing ? '받는 중…' : '받은 메일이 없습니다.';
    $('more').hidden = !state.hasMore;
  }

  // ---- detail ----

  /** byCard: from a notification card (no click in this page): get() reads without marking it read here. */
  async function openDetail(id, byCard = false) {
    state.detail = { id, loading: true };
    state.selected = id;
    $('detail').hidden = false;
    const item = state.items.find((m) => m.id === id);
    $('dSubject').textContent = item?.subject || '';
    $('dFrom').textContent = item ? M.senderLabel(item.from) : '';
    $('dDate').textContent = item ? M.fullDate(item.date) : '';
    $('dBar').style.background = item?.color || 'transparent';
    $('dTo').textContent = '';
    $('dFiles').replaceChildren();
    $('dNote').textContent = '';
    $('dText').textContent = '불러오는 중…';
    const res = byCard ? await W.api.get(id) : await W.api.select(id);
    if (state.detail?.id !== id) return;
    if (!res || res.ok === false) {
      $('dText').textContent = res?.message || '메일을 불러오지 못했습니다.';
      state.detail = { id, failed: true };
      return;
    }
    showDetail(res.message);
  }

  function showDetail(d) {
    state.detail = d;
    $('dTodo').hidden = !state.view?.todoIntegration;
    $('dTodo').textContent = /^en\b/i.test(navigator.language || '') ? 'Add to Todo' : '할 일에 추가';
    $('dSubject').textContent = d.subject || '(제목 없음)';
    $('dFrom').textContent = M.personLabel(d.from);
    $('dDate').textContent = M.fullDate(d.date);
    $('dBar').style.background = d.color;
    const to = d.to.map(M.personLabel).join(', ');
    $('dTo').textContent = `${to ? `받는 사람: ${to}` : ''}${d.cc.length ? ` · 참조: ${d.cc.map(M.personLabel).join(', ')}` : ''} · ${d.accountName}${d.folder && d.folder !== 'INBOX' ? ` · ${d.folder}` : ''}`;
    $('dFiles').replaceChildren(...d.attachments.map((f) => el('li', '', `📎 ${f.name} (${M.sizeLabel(f.size)})`)));
    const notes = [];
    if (d.hasHtml) notes.push('서식이 있는 메일입니다. 원문 보기로 보면 원래 모양으로 보입니다.');
    if (d.remoteImages) notes.push(`외부 이미지 ${d.remoteImages}개는 원문 보기에서 "이미지 표시"를 눌러야 보입니다.`);
    if (d.truncated) notes.push('메일이 커서 일부만 보입니다.');
    $('dNote').textContent = notes.join(' ');
    $('dText').textContent = d.text || '(본문 없음)';
    $('dText').scrollTop = 0;
    $('dWebmail').hidden = !d.hasWebmail;
    $('dCatChips').replaceChildren(...catChips(d.categoryIds));
    const row = state.items.find((m) => m.id === d.id);
    if (row) row.unread = d.unread;
    renderList();
  }

  function hideDetail() {
    state.detail = null;
    $('detail').hidden = true;
  }

  const current = () => state.detail?.id || null;

  // ---- events ----

  $('list').addEventListener('click', (event) => {
    const row = event.target.closest('.row');
    if (row) navigate(() => openDetail(row.dataset.id));
  });
  $('more').addEventListener('click', async () => {
    $('more').disabled = true;
    try {
      const res = await W.api.loadMore();
      if (res && Array.isArray(res.items)) {
        state.items = res.items;
        state.hasMore = res.hasMore;
        renderList();
      }
    } finally {
      $('more').disabled = false;
    }
  });
  // #79: the press shows at once, spins at least 0.6 s and until the server check is done, then says the result.
  window.MailRefresh.bind($('refresh'), { run: () => W.api.refresh(), notice: (text) => notice(text) });
  $('compose').addEventListener('click', () => write((via) => W.api.compose({ accountId: state.filter || undefined, via })));
  $('errors').addEventListener('click', () => W.openSettings());
  $('notice').addEventListener('click', () => notice(''));
  $('dBack').addEventListener('click', closeDetail);
  $('dPreview').addEventListener('click', () => current() && W.api.openPreview(current()).then(check));
  $('dReply').addEventListener('click', () => current() && write((via) => W.api.reply(current(), { via })));
  $('dReplyAll').addEventListener('click', () => current() && write((via) => W.api.reply(current(), { all: true, via })));
  $('dForward').addEventListener('click', () => current() && write((via) => W.api.forward(current(), { via })));
  $('dTodo').addEventListener('click', async () => {
    if (!current()) return;
    const res = check(await W.api.addToTodo(current()));
    if (res?.ok) notice(/^en\b/i.test(navigator.language || '') ? 'Added to Todo.' : '할 일에 추가했습니다.');
  });
  $('dWebmail').addEventListener('click', () => current() && W.api.openWebmail({ id: current() }).then(check));
  $('dUnread').addEventListener('click', async () => {
    const id = current();
    if (!id) return;
    const res = check(await W.api.markUnread(id));
    if (res?.ok) closeDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('catPop').hidden) closePop();
    else if (event.key === 'Escape' && state.detail) closeDetail();
  });
  window.MailNav.bindInputs(window, { back: goBack, forward: goForward });
  // Outside the drag region the page gets the right-click; the engine drops a duplicate of the same click.
  // A right-click on a message opens its 분류; elsewhere the widget's menu.
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const row = event.target.closest('.row');
    if (row) openPop(row.dataset.id, event.clientX, event.clientY);
    else W.window.openMenu();
  });
  $('dCats').addEventListener('click', (event) => {
    if (!state.detail?.id) return;
    if (!$('catPop').hidden) return closePop();
    const r = event.target.getBoundingClientRect();
    openPop(state.detail.id, r.left, r.bottom + 4);
  });

  W.on('changed', (view) => {
    state.view = view;
    renderHead();
    renderList();
  });
  W.on('messages', () => loadList());
  // A notification card's 열기: show that message.
  W.on('reveal', async (req) => {
    await loadList();
    if (req?.id && state.items.some((m) => m.id === req.id)) {
      navigate(() => {
        state.filter = '';
        renderHead();
        renderList();
        openDetail(req.id, true);
      });
    }
  });

  loadState().then(loadList);
})();
