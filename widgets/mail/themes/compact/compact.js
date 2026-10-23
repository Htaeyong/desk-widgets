// 작은 카드 (#65, mail theme contract v1): the unread total, account dots and the newest messages that fit.
// A click opens the message in the widget's isolated reader (api.openPreview, needs the click itself).
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
  let view = null;
  let items = [];
  let noticeTimer = null;

  function notice(text) {
    clearTimeout(noticeTimer);
    $('notice').textContent = text || '';
    $('notice').hidden = !text;
    if (text) noticeTimer = setTimeout(() => notice(''), 5000);
  }
  const check = (res) => {
    if (res && res.ok === false && res.message) notice(res.message);
    return res;
  };
  /** 새 메일: a message at once, then the result; when the mail program cannot be opened, a click on the
      message tries the account's webmail (a new click, so the call keeps its user gesture). */
  function compose() {
    notice('메일 쓰기 창을 여는 중…');
    W.api.compose({}).then((res) => {
      if (res?.ok && res.via === 'widget') notice('');
      else if (res?.ok) notice(res.note || (res.via === 'webmail' ? '웹메일을 열었습니다.' : '메일 프로그램으로 넘겼습니다.'));
      else if (res?.fallback === 'webmail') {
        notice(`${res.message} (여기를 누르면 웹메일로 씁니다)`);
        pendingFallback = true;
      } else check(res);
    });
  }
  let pendingFallback = false;

  /** As many rows as the window height allows (about 20px each). */
  const fits = () => Math.max(1, Math.floor($('list').clientHeight / 20));

  function render() {
    if (view) {
      $('total').textContent = String(view.totalUnread);
      $('total').title = view.sending ? `보내는 중 ${view.sending}통` : '';
      document.body.classList.toggle('sending', Boolean(view.sending));
      $('dots').replaceChildren(
        ...view.accounts
          .filter((a) => a.enabled)
          .map((a) => {
            const d = el('span', a.state === 'error' ? 'err' : '');
            d.style.background = a.color;
            d.title = M.accountStatus(a);
            return d;
          }),
      );
    }
    const shown = items.slice(0, fits());
    $('list').replaceChildren(
      ...shown.map((m) => {
        const li = el('li', m.unread ? 'unread' : '');
        li.dataset.id = m.id;
        li.title = `${M.senderLabel(m.from)} · ${m.subject} · ${M.fullDate(m.date)}`;
        const bar = el('span', 'bar');
        bar.style.background = m.color;
        li.append(bar, el('span', 'who', M.senderLabel(m.from)), el('span', 'what', `${m.folder && m.folder !== 'INBOX' ? `[${m.folder}] ` : ''}${m.subject || '(제목 없음)'}`));
        if (view?.todoIntegration) {
          const todo = el('button', 'todo-add', '+');
          todo.type = 'button';
          todo.title = /^en\b/i.test(navigator.language || '') ? 'Add to Todo' : '할 일에 추가';
          todo.addEventListener('click', async (event) => {
            event.stopPropagation();
            const res = check(await W.api.addToTodo(m.id));
            if (res?.ok) notice(/^en\b/i.test(navigator.language || '') ? 'Added to Todo.' : '할 일에 추가했습니다.');
          });
          li.append(todo);
        }
        return li;
      }),
    );
    const hasAccounts = view && view.accounts.some((a) => a.enabled);
    $('empty').hidden = shown.length > 0;
    $('empty').textContent = hasAccounts ? '받은 메일이 없습니다.' : '오른쪽 클릭 → 설정에서 계정을 추가하세요.';
  }

  async function loadList() {
    const res = await W.api.list();
    if (res && Array.isArray(res.items)) items = res.items;
    render();
  }

  $('list').addEventListener('click', (event) => {
    const li = event.target.closest('li[data-id]');
    if (li) W.api.openPreview(li.dataset.id).then(check);
  });
  $('compose').addEventListener('click', compose);
  // #79: the press shows at once, spins at least 0.6 s and until the server check is done, then says the result.
  window.MailRefresh.bind($('refresh'), { run: () => W.api.refresh(), notice: (text) => notice(text) });
  $('notice').addEventListener('click', () => {
    notice('');
    if (pendingFallback) {
      pendingFallback = false;
      W.api.compose({ via: 'webmail' }).then(check);
    }
  });
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    W.window.openMenu();
  });
  // One screen only (a click opens the reader window): back / forward have nothing to do, but the side
  // buttons and Alt+← / Alt+→ are still taken so they never do anything else here.
  window.MailNav.bindInputs(window, { back: () => {}, forward: () => {} });
  new ResizeObserver(render).observe($('list'));
  W.on('changed', (v) => {
    view = v;
    render();
  });
  W.on('messages', loadList);
  // A notification card's 열기 brings this window forward; the list already shows the newest mail.
  W.on('reveal', loadList);
  W.api.getState().then((v) => {
    view = v;
    loadList();
  });
})();
