// 계정 대시보드 (#72, mail theme contract v1): three levels for many accounts.
//   1 dash: a card per account (새 메일 / 중요 from the server, categories of loaded mail, newest subjects)
//   2 account: that account's list with quick filters (전체 / 안 읽음 / 중요 / categories), 더 보기, compose
//   3 message: the text detail (원문 보기, 답장, 전달, 분류, 안 읽음)
// Moving between levels goes through the kit's nav.js history (mouse side buttons, Alt+← / Alt+→), with the
// scroll position and the highlighted message restored. Mail text is someone else's: textContent only.
(() => {
  const M = window.MailModel;
  const D = window.MailDash;
  const W = window.widget;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const btn = (cls, text, onClick, title) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return b;
  };

  const state = { view: null, level: 'dash', accountId: '', quick: 'all', items: [], hasMore: false, detail: null, selected: null };
  const history = window.MailNav.createHistory();
  let noticeTimer = null;
  let listSeq = 0;

  const accountOf = (id) => (state.view?.accounts || []).find((a) => a.id === id) || null;
  const catsOf = () => state.view?.categories || [];

  function notice(text) {
    clearTimeout(noticeTimer);
    $('notice').textContent = text || '';
    $('notice').hidden = !text;
    if (text) noticeTimer = setTimeout(() => notice(''), 6000);
  }
  const check = (res) => {
    if (res && res.ok === false && res.message) notice(res.message);
    return res;
  };

  // ---- header / footer ----

  function renderHead() {
    const v = state.view;
    if (!v) return;
    const t = D.totals(v.accounts);
    const acc = accountOf(state.accountId);
    $('title').textContent = state.level === 'dash' ? '메일' : acc ? acc.name : '메일';
    $('back').hidden = state.level === 'dash';
    $('totals').replaceChildren(el('span', '', '안 읽음 '), el('b', '', String(t.unread)), el('span', '', ` · 중요 ${t.flagged} · 계정 ${t.accounts}`));
    $('updated').textContent = v.sending ? `✉ 보내는 중… (${v.sending}통)` : v.paused ? '자리 비움 중 멈춤' : v.refreshing ? '받는 중…' : v.lastUpdated ? `갱신 ${M.timeLabel(v.lastUpdated)}` : '';
    $('errors').hidden = !t.errors;
    $('errors').textContent = t.errors ? `⚠ 연결 오류 ${t.errors}개 — 설정` : '';
  }

  // ---- level 1: accounts ----

  function renderDash() {
    const accounts = (state.view?.accounts || []).filter((a) => a.enabled !== false);
    $('dashEmpty').hidden = accounts.length > 0;
    $('grid').replaceChildren(
      ...accounts.map((a) => {
        const card = el('article', 'acard');
        const bar = el('span', 'bar');
        bar.style.background = a.color;
        const name = btn('a-name', a.name, () => go({ level: 'account', accountId: a.id, quick: 'all' }), '이 계정의 메일');
        const mail = el('div', 'a-mail', a.email || '');
        const st = el('div', a.state === 'error' ? 'a-state' : 'a-state ok', a.state === 'error' ? `⚠ ${a.error || '오류'}` : M.accountStatus(a).replace(`${a.name}: `, ''));
        const count = (cls, n, label, quick, title) => {
          const b = btn(`count-btn ${cls}${n ? '' : ' zero'}`, '', () => go({ level: 'account', accountId: a.id, quick }), title);
          b.append(el('span', 'n', String(n)), el('span', 'l', label));
          return b;
        };
        const counts = el('div', 'counts');
        counts.append(count('unread', a.unread || 0, '새 메일', 'unread', '받은편지함의 안 읽은 메일(서버 기준)'), count('flag', a.flagged || 0, '중요', 'flagged', '별표(중요) 메일(서버 기준)'));
        const cats = el('div', 'a-cats');
        for (const c of D.cardCategories(a, catsOf())) {
          const chip = btn('cat', `${c.name} ${c.count}`, () => go({ level: 'account', accountId: a.id, quick: `cat:${c.id}` }), `불러온 메일 중 "${c.name}" ${c.count}통`);
          chip.style.borderColor = c.color;
          chip.style.background = `${c.color}33`;
          cats.append(chip);
        }
        const latest = el('ul', 'latest');
        for (const m of a.latest || []) {
          const li = el('li');
          li.append(btn(m.unread ? 'unread' : '', `${m.flagged ? '★ ' : ''}${m.subject || '(제목 없음)'}`, () => go({ level: 'message', accountId: a.id, quick: 'all', messageId: m.id }), `${M.senderLabel(m.from)} · ${M.fullDate(m.date)}`));
          latest.append(li);
        }
        card.append(bar, name, mail, st, counts);
        if (cats.childElementCount) card.append(cats);
        if (latest.childElementCount) card.append(latest);
        return card;
      }),
    );
  }

  // ---- level 2: one account ----

  async function loadList() {
    const seq = ++listSeq;
    const res = await W.api.filter(D.filterFor(state.accountId, state.quick));
    if (seq !== listSeq || !res || !Array.isArray(res.items)) return;
    state.items = res.items;
    state.hasMore = res.hasMore;
    renderAccount();
  }

  async function reloadList() {
    const seq = ++listSeq;
    const res = await W.api.list();
    if (seq !== listSeq || !res || !Array.isArray(res.items)) return;
    state.items = res.items;
    state.hasMore = res.hasMore;
    renderAccount();
  }

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

  function renderAccount() {
    const a = accountOf(state.accountId);
    if (!a) return;
    $('accountInfo').replaceChildren(el('span', '', a.email || ''), el('span', a.state === 'error' ? 'err' : '', a.state === 'error' ? `⚠ ${a.error || ''}` : `불러온 메일 ${a.loaded}통`));
    $('quick').replaceChildren(
      ...D.quickChips(a, catsOf()).map((q) => {
        const b = btn(`chip${state.quick === q.quick ? ' on' : ''}`, '', () => {
          if (q.quick !== state.quick) go({ level: 'account', accountId: a.id, quick: q.quick });
        });
        if (q.color) {
          const dot = el('span', 'dot');
          dot.style.background = q.color;
          b.append(dot);
        }
        b.append(el('span', '', q.label));
        if (q.count !== null) b.append(el('span', 'n', String(q.count)));
        return b;
      }),
    );
    const note = D.scopeNote(state.quick, a.loaded);
    $('scope').textContent = note;
    $('scope').hidden = !note;
    const now = Date.now();
    $('list').replaceChildren(
      ...state.items.map((m) => {
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
        if (m.snippet) body.append(el('div', 'snippet', m.snippet));
        if (m.categoryIds?.length) {
          const line = el('div', 'cats-line');
          line.append(...catChips(m.categoryIds));
          body.append(line);
        }
        li.append(bar, body);
        return li;
      }),
    );
    $('empty').hidden = state.items.length > 0;
    $('empty').textContent = state.quick === 'all' ? '받은 메일이 없습니다.' : String(state.quick).startsWith('cat:') ? '조건에 맞는 메일이 없습니다(불러온 메일 중).' : '조건에 맞는 메일이 없습니다.';
    $('more').hidden = !state.hasMore;
  }

  // ---- level 3: a message ----

  /** byGesture: a click on that message (select marks it read); history / card moves only read it (get). */
  async function openMessage(id, byGesture) {
    state.detail = { id, loading: true };
    state.selected = id;
    $('detail').hidden = false;
    $('dCatBox').hidden = true;
    $('dText').textContent = '불러오는 중…';
    for (const k of ['dSubject', 'dFrom', 'dDate', 'dTo', 'dNote']) $(k).textContent = '';
    $('dFiles').replaceChildren();
    $('dCatChips').replaceChildren();
    const res = byGesture ? await W.api.select(id) : await W.api.get(id);
    if (state.detail?.id !== id) return;
    if (!res || res.ok === false) {
      $('dText').textContent = res?.message || '메일을 불러오지 못했습니다.';
      return;
    }
    const d = res.message;
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
    $('dNote').textContent = [d.hasHtml ? '서식이 있는 메일입니다. 원문 보기로 원래 모양을 볼 수 있습니다.' : '', d.remoteImages ? `외부 이미지 ${d.remoteImages}개는 원문 보기에서 "이미지 표시"로.` : ''].filter(Boolean).join(' ');
    $('dText').textContent = d.text || '(본문 없음)';
    $('dText').scrollTop = 0;
    $('dWebmail').hidden = !d.hasWebmail;
    $('dCatChips').replaceChildren(...catChips(d.categoryIds));
  }

  function renderCatBox() {
    const d = state.detail;
    if (!d?.id) return;
    const on = new Set(d.categoryIds || []);
    const box = $('dCatBox');
    box.replaceChildren(
      ...catsOf().map((c) => {
        const label = el('label');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = on.has(c.id);
        input.addEventListener('change', async () => {
          const next = new Set(state.detail.categoryIds || []);
          if (input.checked) next.add(c.id);
          else next.delete(c.id);
          const res = check(await W.api.setCategories(state.detail.id, [...next]));
          if (res?.ok) {
            state.detail.categoryIds = res.categoryIds;
            $('dCatChips').replaceChildren(...catChips(res.categoryIds));
          }
        });
        const dot = el('span', 'dot');
        dot.style.background = c.color;
        label.append(input, dot, el('span', '', c.name));
        return label;
      }),
    );
    const form = el('form');
    const name = el('input');
    name.type = 'text';
    name.maxLength = 30;
    name.placeholder = '새 분류';
    form.append(name, Object.assign(el('button', '', '만들기'), { type: 'submit' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = name.value.trim();
      if (!text) return;
      const res = check(await W.api.createCategory(text));
      if (!res?.ok) return;
      state.view = { ...state.view, categories: res.categories.map((c) => ({ ...c, count: 0 })) };
      const set = await W.api.setCategories(state.detail.id, [...(state.detail.categoryIds || []), res.category.id]);
      if (set?.ok) {
        state.detail.categoryIds = set.categoryIds;
        $('dCatChips').replaceChildren(...catChips(set.categoryIds));
      }
      renderCatBox();
    });
    box.append(form);
  }

  // ---- levels and history ----

  const scrollOf = () => (state.level === 'dash' ? $('grid').scrollTop : $('list').scrollTop);
  const snapshot = () => ({ level: state.level, accountId: state.accountId, quick: state.quick, messageId: state.detail?.id || null, selected: state.selected, scroll: scrollOf() });

  /** Shows a level. byGesture: the move came from a click on a message (select marks it read). */
  async function show(target, { byGesture = false, scroll = 0 } = {}) {
    const level = target.level;
    const accountChanged = target.accountId !== state.accountId || target.quick !== state.quick;
    state.level = level;
    state.accountId = target.accountId || '';
    state.quick = target.quick || 'all';
    if (target.selected !== undefined) state.selected = target.selected;
    $('dashView').hidden = level !== 'dash';
    $('accountView').hidden = level === 'dash';
    renderHead();
    if (level === 'dash') {
      $('detail').hidden = true;
      state.detail = null;
      renderDash();
      $('grid').scrollTop = scroll;
      return;
    }
    if (accountChanged || !state.items.length || level === 'account') await loadList();
    if (level === 'message' && target.messageId) {
      await openMessage(target.messageId, byGesture);
    } else {
      $('detail').hidden = true;
      state.detail = null;
    }
    renderAccount();
    $('list').scrollTop = scroll;
    requestAnimationFrame(() => ($('list').scrollTop = scroll));
  }

  /** A move to a new place: the current one goes into the history first. */
  function go(target, opts = {}) {
    history.record(snapshot());
    show(target, opts);
  }

  function goBack() {
    const prev = history.back(snapshot());
    if (prev) show(prev, { scroll: prev.scroll });
  }

  function goForward() {
    const next = history.forward(snapshot());
    if (next) show(next, { scroll: next.scroll });
  }

  /** ‹ / Esc: the previous place, or one level up when there is no history. */
  function up() {
    if (history.canBack()) return goBack();
    if (state.level === 'message') return show({ level: 'account', accountId: state.accountId, quick: state.quick });
    if (state.level === 'account') return show({ level: 'dash' });
    return undefined;
  }

  // ---- events ----

  $('back').addEventListener('click', up);
  $('dBack').addEventListener('click', up);
  $('list').addEventListener('click', (event) => {
    const row = event.target.closest('.row');
    if (row) go({ level: 'message', accountId: state.accountId, quick: state.quick, messageId: row.dataset.id }, { byGesture: true, scroll: $('list').scrollTop });
  });
  $('more').addEventListener('click', async () => {
    $('more').disabled = true;
    try {
      const res = await W.api.loadMore();
      if (res && Array.isArray(res.items)) {
        state.items = res.items;
        state.hasMore = res.hasMore;
        renderAccount();
      }
    } finally {
      $('more').disabled = false;
    }
  });
  // #79: the press shows at once, spins at least 0.6 s and until the server check is done, then says the result.
  window.MailRefresh.bind($('refresh'), { run: () => W.api.refresh(), notice: (text) => notice(text) });
  // From the account view the new mail is sent from that account.
  $('compose').addEventListener('click', () => W.api.compose({ accountId: state.accountId || undefined }).then(check));
  $('errors').addEventListener('click', () => W.openSettings());
  $('notice').addEventListener('click', () => notice(''));
  const current = () => state.detail?.id || null;
  $('dPreview').addEventListener('click', () => current() && W.api.openPreview(current()).then(check));
  $('dReply').addEventListener('click', () => current() && W.api.reply(current()).then(check));
  $('dReplyAll').addEventListener('click', () => current() && W.api.reply(current(), { all: true }).then(check));
  $('dForward').addEventListener('click', () => current() && W.api.forward(current()).then(check));
  $('dTodo').addEventListener('click', async () => {
    if (!current()) return;
    const res = check(await W.api.addToTodo(current()));
    if (res?.ok) notice(/^en\b/i.test(navigator.language || '') ? 'Added to Todo.' : '할 일에 추가했습니다.');
  });
  $('dWebmail').addEventListener('click', () => current() && W.api.openWebmail({ id: current() }).then(check));
  $('dUnread').addEventListener('click', async () => {
    const id = current();
    if (id && check(await W.api.markUnread(id))?.ok) up();
  });
  $('dCats').addEventListener('click', () => {
    $('dCatBox').hidden = !$('dCatBox').hidden;
    if (!$('dCatBox').hidden) renderCatBox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.level !== 'dash') up();
  });
  window.MailNav.bindInputs(window, { back: goBack, forward: goForward });
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    W.window.openMenu();
  });

  W.on('changed', (view) => {
    state.view = view;
    renderHead();
    if (state.level === 'dash') renderDash();
    else renderAccount();
  });
  W.on('messages', () => {
    if (state.level !== 'dash') reloadList();
  });
  // A notification card's 열기: that message, in its account (read already by the widget).
  W.on('reveal', async (req) => {
    const id = req?.id;
    if (!id) return;
    const accountId = id.split(':')[0];
    go({ level: 'message', accountId, quick: 'all', messageId: id });
  });

  W.api.getState().then(async (v) => {
    state.view = v;
    // The dashboard starts with every account; a filter left by another theme does not apply here.
    await W.api.filter({});
    show({ level: 'dash' });
  });
})();
