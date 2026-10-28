// Mail section of the settings window (#65; panel contract: engine/renderer/widget-settings.js). Accounts with
// per-provider how-to. A typed password goes to the widget's main code only through "연결 확인"
// (api.call('check')), which keeps it until the settings are saved; this page never stores it.
(() => {
  const PALETTE = ['#4f8cff', '#3ccf8e', '#ff9f43', '#ff6b6b', '#a78bfa', '#2dd4bf', '#f472b6', '#facc15'];
  let root = null;
  let api = null;
  let status = [];
  let providers = [];
  const $ = (id) => root.querySelector(`#${id}`);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };
  const usable = () => providers.filter((p) => !p.unavailable);
  const provider = (id) => providers.find((p) => p.id === id) || usable()[0];

  const time = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function statusText(id, enabled) {
    const st = status.find((s) => s.id === id);
    if (!id || !st) return { text: '저장하면 연결합니다.', kind: '' };
    if (!enabled) return { text: '꺼짐 (연결하지 않음)', kind: '' };
    if (st.state === 'off') return { text: '위젯이 꺼져 있습니다.', kind: '' };
    if (st.state === 'connecting') return { text: '연결 중…', kind: '' };
    if (st.state === 'syncing') return { text: '받는 중…', kind: '' };
    if (st.state === 'paused') return { text: '자리 비움 중 연결 끊음 (돌아오면 다시 연결)', kind: '' };
    if (st.state === 'error') return { text: `오류: ${st.error}${st.lastSync ? ` (마지막 성공 ${time(st.lastSync)})` : ''}`, kind: 'err' };
    return { text: `연결됨 · 안 읽은 메일 ${st.unread ?? 0}통${st.lastSync ? ` · 마지막 확인 ${time(st.lastSync)}` : ''}`, kind: 'ok' };
  }

  function updateStatus() {
    for (const box of root.querySelectorAll('.mail-acc')) {
      const { text, kind } = statusText(box.dataset.id, box.querySelector('.mail-on').checked);
      const line = box.querySelector('.mail-status');
      line.textContent = text;
      line.className = `mail-status ${kind}`;
    }
  }

  function updateEmpty() {
    const list = $('mailAccounts');
    list.querySelector('.mail-empty')?.remove();
    if (!list.querySelector('.mail-acc')) list.append(el('div', { className: 'mail-empty', textContent: '아직 연결한 계정이 없습니다. "+ 계정 추가"를 누르세요.' }));
  }

  /** Labels, guide and server fields for the chosen provider. */
  function showProvider(box) {
    const p = provider(box.querySelector('.mail-provider').value);
    box.querySelector('.mail-guide-steps').replaceChildren(...p.steps.map((s) => el('li', { textContent: s })));
    box.querySelector('.mail-guide-link').textContent = p.helpUrl ? `안내: ${p.helpUrl}` : '';
    box.querySelector('.mail-verify').hidden = p.verified;
    box.querySelector('.mail-user-label').textContent = p.userLabel;
    box.querySelector('.mail-pass-label').textContent = p.passwordLabel;
    const fixed = p.server === 'fixed';
    box.querySelector('.mail-server-row').hidden = fixed;
    box.querySelector('.mail-fixed').textContent = fixed ? `받는 서버: ${p.host} · ${p.port} · SSL/TLS / 보내는 서버: ${p.smtp?.host} · ${p.smtp?.port} · SSL/TLS` : '';
    box.querySelector('.mail-smtp-row').hidden = fixed;
    const sh = box.querySelector('.mail-smtp-host');
    sh.placeholder = p.server === 'optional' && p.smtp?.host ? `비워 두면 ${p.smtp.host}` : 'smtp.example.com';
    if (!box.querySelector('.mail-smtp-port').value) box.querySelector('.mail-smtp-port').value = p.smtp?.port || 465;
    box.querySelector('.mail-smtp-verify').hidden = p.smtp?.verified !== false;
    const host = box.querySelector('.mail-host');
    host.placeholder = p.server === 'optional' ? `비워 두면 ${p.host}` : 'imap.example.com';
    if (!box.querySelector('.mail-port').value) box.querySelector('.mail-port').value = p.port;
    const web = box.querySelector('.mail-webmail');
    web.placeholder = p.webmailHint || p.webmail || 'https://';
    if (!web.value && p.webmail) web.value = p.webmail;
  }

  const loginKey = (box) =>
    JSON.stringify(['.mail-provider', '.mail-host', '.mail-port', '.mail-security', '.mail-user', '.mail-smtp-host', '.mail-smtp-port', '.mail-smtp-security'].map((s) => box.querySelector(s).value.trim()));

  function setResult(box, text, kind) {
    const line = box.querySelector('.mail-result');
    line.textContent = text;
    line.className = `mail-result hint ${kind || ''}`;
  }

  async function connect(box) {
    const btn = box.querySelector('.mail-connect');
    btn.disabled = true;
    setResult(box, '연결하는 중…', '');
    try {
      const res = await api.call('check', {
        accountId: box.dataset.id || null,
        provider: box.querySelector('.mail-provider').value,
        host: box.querySelector('.mail-host').value.trim(),
        port: Number(box.querySelector('.mail-port').value),
        security: box.querySelector('.mail-security').value,
        smtpHost: box.querySelector('.mail-smtp-host').value.trim(),
        smtpPort: Number(box.querySelector('.mail-smtp-port').value),
        smtpSecurity: box.querySelector('.mail-smtp-security').value,
        username: box.querySelector('.mail-user').value.trim(),
        password: box.querySelector('.mail-pass').value,
      });
      if (!res?.ok) {
        setResult(box, res?.message || '연결하지 못했습니다.', 'err');
        return;
      }
      if (res.token) box.dataset.draft = res.token;
      box.dataset.connected = loginKey(box);
      box.querySelector('.mail-pass').value = '';
      box.querySelector('.mail-pass').placeholder = res.token ? '확인됨 — 저장하면 암호화해 저장합니다' : '저장됨 — 바꿀 때만 입력';
      const smtp = res.smtp?.ok ? ' · 보내기(SMTP) 로그인 확인됨' : ` · 보내기(SMTP)는 안 됨: ${res.smtp?.message || '확인하지 못함'}`;
      setResult(box, `연결됨 · 받은편지함 ${res.exists}통${res.unseen !== null && res.unseen !== undefined ? `, 안 읽음 ${res.unseen}통` : ''}${res.idle ? ' · 새 메일 즉시 알림(IDLE) 지원' : ' · IDLE 없음(확인 주기마다 확인)'}${smtp}. 저장하세요.`, res.smtp?.ok ? 'ok' : 'warn');
    } catch (err) {
      setResult(box, `연결하지 못했습니다: ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  function addAccount(acc, isNew) {
    const box = el('div', { className: 'mail-acc' });
    box.dataset.id = acc.id || '';
    if (!isNew) box.dataset.connected = 'saved';
    const n = root.querySelectorAll('.mail-acc').length;
    const on = el('input', { type: 'checkbox', className: 'mail-on', checked: acc.enabled !== false, title: '사용' });
    const color = el('input', { type: 'color', className: 'mail-color', value: acc.color || PALETTE[n % PALETTE.length], title: '목록의 계정 색' });
    const name = el('input', { type: 'text', className: 'mail-name', value: acc.name || '', placeholder: '이름 (예: 회사, 개인)', maxLength: 60 });
    const remove = el('button', { type: 'button', textContent: '삭제' });
    remove.addEventListener('click', () => {
      box.remove();
      updateEmpty();
    });
    on.addEventListener('change', updateStatus);

    const select = el('select', { className: 'mail-provider', disabled: !isNew });
    for (const p of providers) select.append(el('option', { value: p.id, textContent: p.label, disabled: Boolean(p.unavailable) }));
    select.value = acc.provider || usable()[0].id;
    const unavailable = el('div', { className: 'hint mail-unavail', textContent: providers.filter((p) => p.unavailable).map((p) => `${p.label}: ${p.reason}`).join(' ') });
    select.addEventListener('change', () => {
      box.querySelector('.mail-port').value = '';
      box.querySelector('.mail-smtp-port').value = '';
      box.querySelector('.mail-webmail').value = '';
      showProvider(box);
      delete box.dataset.draft;
    });

    const guide = el(
      'details',
      { className: 'mail-guide', open: isNew },
      el('summary', { textContent: 'IMAP 켜기 · 앱 비밀번호 안내' }),
      el('ol', { className: 'mail-guide-steps' }),
      el('div', { className: 'mail-guide-link hint' }),
    );
    const verify = el('div', { className: 'hint err mail-verify', textContent: '이 서비스의 서버 값은 공식 안내로 아직 확인하지 못했습니다(확인 필요). 연결 확인이 되면 그대로 쓰면 됩니다.' });
    const p0 = provider(select.value);
    const host = el('input', { type: 'text', className: 'mail-host', value: acc.host && acc.host !== p0.host ? acc.host : '', spellcheck: false });
    const port = el('input', { type: 'number', className: 'mail-port', min: 1, max: 65535, value: acc.port || '' });
    const security = el('select', { className: 'mail-security' }, el('option', { value: 'tls', textContent: 'SSL/TLS' }), el('option', { value: 'starttls', textContent: 'STARTTLS' }));
    security.value = acc.security || 'tls';
    const serverRow = el(
      'div',
      { className: 'mail-server-row' },
      el('label', { className: 'grow', textContent: '받는 메일 서버 (IMAP)' }, host),
      el('label', { className: 'port', textContent: '포트' }, port),
      el('label', { className: 'sec', textContent: '보안' }, security),
    );
    const smtpHost = el('input', { type: 'text', className: 'mail-smtp-host', value: acc.smtpHost && acc.smtpHost !== p0.smtp?.host ? acc.smtpHost : '', spellcheck: false });
    const smtpPort = el('input', { type: 'number', className: 'mail-smtp-port', min: 1, max: 65535, value: acc.smtpPort || '' });
    const smtpSecurity = el('select', { className: 'mail-smtp-security' }, el('option', { value: 'tls', textContent: 'SSL/TLS' }), el('option', { value: 'starttls', textContent: 'STARTTLS' }));
    smtpSecurity.value = acc.smtpSecurity || 'tls';
    const smtpRow = el(
      'div',
      { className: 'mail-server-row mail-smtp-row' },
      el('label', { className: 'grow', textContent: '보내는 메일 서버 (SMTP)' }, smtpHost),
      el('label', { className: 'port', textContent: '포트' }, smtpPort),
      el('label', { className: 'sec', textContent: '보안' }, smtpSecurity),
    );
    const smtpVerify = el('div', { className: 'hint err mail-smtp-verify mail-verify', textContent: '보내는 메일 서버 값도 확인 필요입니다(연결 확인에서 보내기 로그인을 시험합니다).' });
    const user = el('input', { type: 'text', className: 'mail-user', value: acc.username || '', autocomplete: 'off', spellcheck: false });
    const pass = el('input', { type: 'password', className: 'mail-pass', autocomplete: 'new-password', placeholder: isNew ? '' : '저장됨 — 바꿀 때만 입력하고 연결 확인' });
    const email = el('input', { type: 'email', className: 'mail-email', value: acc.email || '', placeholder: '아이디가 메일 주소가 아니면 넣으세요', spellcheck: false });
    const connectBtn = el('button', { type: 'button', className: 'mail-connect', textContent: '연결 확인' });
    connectBtn.addEventListener('click', () => connect(box));
    for (const input of [host, port, user, pass]) input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), connect(box)));

    const notify = el('input', { type: 'checkbox', className: 'mail-notify', checked: acc.notify !== false });
    const compose = el(
      'select',
      { className: 'mail-compose' },
      el('option', { value: 'widget', textContent: '위젯에서 보내기 (이 계정으로 보냄)' }),
      el('option', { value: 'mailto', textContent: '메일 프로그램 (Windows 기본 메일 앱, 보내는 계정은 그 프로그램이 정함)' }),
      el('option', { value: 'webmail', textContent: '웹메일' }),
    );
    compose.value = acc.compose || 'widget';
    const senderName = el('input', { type: 'text', className: 'mail-sender-name', value: acc.senderName || '', maxLength: 60, placeholder: '예: 홍길동 (비우면 주소만)' });
    const signature = el('textarea', { className: 'mail-signature', value: acc.signature || '', maxLength: 2000, rows: 3, placeholder: '예: 홍길동 드림 / 회사 · 010-0000-0000 — 새 메일·답장·전달 본문 아래("-- " 줄 다음)에 자동으로 들어갑니다' });
    const saveSent = el(
      'select',
      { className: 'mail-save-sent' },
      el('option', { value: 'auto', textContent: '자동 (Gmail은 서버가 저장, 그 밖은 위젯이 저장)' }),
      el('option', { value: 'on', textContent: '위젯이 보낸편지함에 저장' }),
      el('option', { value: 'off', textContent: '저장하지 않음' }),
    );
    saveSent.value = acc.saveSent || 'auto';
    const openWith = el('select', { className: 'mail-open' }, el('option', { value: 'widget', textContent: '위젯에서 보기' }), el('option', { value: 'webmail', textContent: '웹메일 열기' }));
    openWith.value = acc.openWith || 'widget';
    const webmail = el('input', { type: 'url', className: 'mail-webmail', value: acc.webmail || '', spellcheck: false });

    box.append(
      el('div', { className: 'row' }, on, color, name, remove),
      el('label', { textContent: '서비스' }, select),
      unavailable,
      guide,
      verify,
      el('div', { className: 'hint mail-fixed' }),
      serverRow,
      smtpRow,
      smtpVerify,
      el('label', {}, el('span', { className: 'mail-user-label' }), user),
      el('label', {}, el('span', { className: 'mail-pass-label' }), pass),
      el('div', { className: 'row' }, connectBtn),
      el('label', { className: 'mail-sig-label', textContent: '서명 (메일 쓸 때 자동으로 넣기)' }, signature),
      el('div', { className: 'mail-result hint' }),
      el(
        'details',
        { className: 'mail-folders', open: Boolean(acc.folders && acc.folders.length) },
        el('summary', { textContent: `함께 볼 메일함${acc.folders && acc.folders.length ? ` (${acc.folders.length})` : ' (받은편지함만)'}` }),
        el('div', { className: 'hint', textContent: '웹메일의 필터·규칙으로 다른 메일함에 옮겨지는 메일도 위젯 목록·새 메일 알림·안 읽은 수에 넣으려면 그 메일함을 고르세요. 받은편지함은 늘 봅니다. 보낸편지함·임시 보관함·휴지통·스팸·전체 보관함은 고를 수 없습니다.' }),
        el('div', { className: 'row' }, Object.assign(el('button', { type: 'button', className: 'mail-folder-load', textContent: '메일함 불러오기' }), {})),
        el('div', { className: 'mail-folder-note hint' }),
        el('div', { className: 'mail-folder-list' }),
      ),
      el(
        'details',
        { className: 'mail-more' },
        el('summary', { textContent: '알림 · 보내기 · 서명 · 웹메일' }),
        el('label', { className: 'check' }, notify, ' 이 계정의 새 메일 알림'),
        el('label', { textContent: '새 메일·답장·전달을 쓸 곳' }, compose),
        el('label', { textContent: '보내는 사람 이름' }, senderName),
        el('label', { textContent: '보낸 메일 저장 (보낸편지함)' }, saveSent),
        el('label', { textContent: '알림 카드의 열기' }, openWith),
        el('label', { textContent: '웹메일 주소 (https)' }, webmail),
        el('label', { textContent: '내 메일 주소 (보내는 주소, 전체 답장에서 뺄 주소)' }, email),
      ),
      el('div', { className: 'mail-status' }),
    );
    $('mailAccounts').append(box);
    box.querySelector('.mail-folder-load').addEventListener('click', () => loadFolders(box));
    fillFolders(box, [], acc.folders || []);
    showProvider(box);
    if (isNew) box.querySelector('.mail-status').hidden = true;
    updateEmpty();
    updateStatus();
    return box;
  }

  // ---- #69 categories ----

  function addCategory(c) {
    const row = el('div', { className: 'row mail-cat' });
    row.dataset.id = c.id || '';
    const color = el('input', { type: 'color', className: 'mail-cat-color', value: c.color || PALETTE[root.querySelectorAll('.mail-cat').length % PALETTE.length], title: '색' });
    const name = el('input', { type: 'text', className: 'mail-cat-name', value: c.name || '', maxLength: 30, placeholder: '분류 이름 (예: 중요, 결재, 나중에)' });
    const up = el('button', { type: 'button', textContent: '▲', title: '위로' });
    up.addEventListener('click', () => row.previousElementSibling && row.parentNode.insertBefore(row, row.previousElementSibling));
    const remove = el('button', { type: 'button', textContent: '삭제' });
    remove.addEventListener('click', () => row.remove());
    row.append(color, name, up, remove);
    $('mailCats').append(row);
    return row;
  }

  const readCategories = () =>
    [...root.querySelectorAll('.mail-cat')]
      .map((r) => ({ id: r.dataset.id || undefined, name: r.querySelector('.mail-cat-name').value.trim(), color: r.querySelector('.mail-cat-color').value }))
      .filter((c) => c.name);

  // ---- #70 주소록 ----

  let bookTimer = null;
  async function loadBook() {
    const res = await api.call('contactsSearch', $('mailBookSearch').value);
    if (!res) return;
    $('mailBookInfo').textContent = res.total ? `주소 ${res.total}개${res.list.length < res.total ? ` 중 ${res.list.length}개 표시` : ''}` : '아직 모인 주소가 없습니다. 메일을 받거나 보내면 모이고, 파일을 가져올 수도 있습니다.';
    $('mailBook').replaceChildren(
      ...res.list.map((c) => {
        const row = el('div', { className: 'row mail-book-row' });
        const name = el('input', { type: 'text', className: 'mail-book-name', value: c.name, maxLength: 100, placeholder: '(이름 없음)' });
        name.addEventListener('change', async () => {
          const r = await api.call('contactsRename', c.address, name.value);
          if (!r?.ok) name.value = c.name;
        });
        const addr = el('span', { className: 'mail-book-addr', textContent: c.address, title: `보낸 ${c.sent} · 받은 ${c.received}${c.imported ? ' · 가져옴' : ''}` });
        const remove = el('button', { type: 'button', textContent: '삭제' });
        remove.addEventListener('click', async () => {
          await api.call('contactsRemove', c.address);
          loadBook();
        });
        row.append(name, addr, remove);
        return row;
      }),
    );
  }

  // ---- #80 "함께 볼 메일함": mailboxes watched with INBOX ----

  /** Rows of the picker: [{ raw, name, special, specialLabel, selectable }] with the chosen ones checked. */
  function fillFolders(box, folders, chosen) {
    const list = box.querySelector('.mail-folder-list');
    const on = new Set(chosen.map((f) => f.raw));
    // Chosen folders the server did not list (renamed / deleted) stay visible so they can be unticked.
    const all = [...folders, ...chosen.filter((c) => !folders.some((f) => f.raw === c.raw)).map((c) => ({ ...c, selectable: true, missing: folders.length > 0 }))];
    list.replaceChildren(
      ...all.map((f) => {
        const row = el('label', { className: 'check mail-folder' });
        row.dataset.raw = f.raw;
        row.dataset.name = f.name;
        const cb = el('input', { type: 'checkbox', className: 'mail-folder-on', checked: on.has(f.raw), disabled: !f.selectable && !on.has(f.raw) });
        row.append(cb, el('span', { textContent: f.name }));
        if (f.special) row.append(el('span', { className: 'cal-badge mail-badge', textContent: `${f.specialLabel} — 제외` }));
        if (f.missing) row.append(el('span', { className: 'mail-badge err', textContent: '서버에 없음' }));
        return row;
      }),
    );
    if (!all.length) list.append(el('div', { className: 'mail-empty', textContent: folders.length ? '' : '받은편지함만 봅니다.' }));
  }

  async function loadFolders(box) {
    const btn = box.querySelector('.mail-folder-load');
    const note = box.querySelector('.mail-folder-note');
    btn.disabled = true;
    note.textContent = '메일함 목록을 받는 중…';
    try {
      const res = await api.call('listFolders', {
        accountId: box.dataset.id || null,
        draft: box.dataset.draft || undefined,
      folders: readFolders(box),
        provider: box.querySelector('.mail-provider').value,
        host: box.querySelector('.mail-host').value.trim(),
        port: Number(box.querySelector('.mail-port').value),
        security: box.querySelector('.mail-security').value,
        username: box.querySelector('.mail-user').value.trim(),
      });
      if (!res?.ok) {
        note.textContent = res?.message || '메일함 목록을 받지 못했습니다.';
        return;
      }
      fillFolders(box, res.folders, readFolders(box));
      const n = res.folders.filter((f) => f.selectable).length;
      note.textContent = n ? `받은편지함 말고 ${n}개의 메일함이 있습니다. 서버 규칙(필터)으로 메일이 옮겨지는 메일함을 고르세요(최대 10개).` : '받은편지함 말고 고를 메일함이 없습니다.';
    } finally {
      btn.disabled = false;
    }
  }

  const readFolders = (box) =>
    [...box.querySelectorAll('.mail-folder')].filter((r) => r.querySelector('.mail-folder-on').checked).map((r) => ({ raw: r.dataset.raw, name: r.dataset.name }));

  function readAccounts() {
    return [...root.querySelectorAll('.mail-acc')].map((box) => ({
      id: box.dataset.id || undefined,
      enabled: box.querySelector('.mail-on').checked,
      color: box.querySelector('.mail-color').value,
      name: box.querySelector('.mail-name').value.trim(),
      provider: box.querySelector('.mail-provider').value,
      host: box.querySelector('.mail-host').value.trim(),
      port: Number(box.querySelector('.mail-port').value),
      security: box.querySelector('.mail-security').value,
      username: box.querySelector('.mail-user').value.trim(),
      email: box.querySelector('.mail-email').value.trim(),
      smtpHost: box.querySelector('.mail-smtp-host').value.trim(),
      smtpPort: Number(box.querySelector('.mail-smtp-port').value),
      smtpSecurity: box.querySelector('.mail-smtp-security').value,
      senderName: box.querySelector('.mail-sender-name').value.trim(),
      signature: box.querySelector('.mail-signature').value,
      saveSent: box.querySelector('.mail-save-sent').value,
      notify: box.querySelector('.mail-notify').checked,
      compose: box.querySelector('.mail-compose').value,
      openWith: box.querySelector('.mail-open').value,
      webmail: box.querySelector('.mail-webmail').value.trim(),
      draft: box.dataset.draft || undefined,
    }));
  }

  window.settingsShell.registerPanel('mail', {
    init(panelRoot, values, shellApi) {
      root = panelRoot;
      api = shellApi;
      status = values.status || [];
      providers = values.providers || [];
      for (const acc of values.accounts || []) addAccount(acc, false);
      for (const c of values.categories || []) addCategory(c);
      $('mailCatAdd').addEventListener('click', () => addCategory({}).querySelector('.mail-cat-name').focus());
      $('mailBookSearch').addEventListener('input', () => {
        clearTimeout(bookTimer);
        bookTimer = setTimeout(loadBook, 150);
      });
      $('mailBookImport').addEventListener('click', async () => {
        $('mailBookImport').disabled = true;
        try {
          const r = await api.call('contactsImport');
          if (r && !r.cancelled) {
            await loadBook();
            $('mailBookInfo').textContent = `가져옴: 주소 ${r.found}개 중 새 주소 ${r.added}개, 갱신 ${r.updated}개${r.failed?.length ? ` · 읽지 못한 파일: ${r.failed.join(', ')}` : ''}`;
          }
        } finally {
          $('mailBookImport').disabled = false;
        }
      });
      loadBook();
      updateEmpty();
      $('mailSecretWarn').hidden = values.secretAvailable !== false;
      $('mailAdd').disabled = values.secretAvailable === false || !usable().length;
      if (api.mountThemePicker) api.mountThemePicker($('mailThemes'), { themeId: values.themeId, themeOpacity: values.themeOpacity });
      $('mailMockNote').hidden = !values.mock;
      $('mailProgram').textContent = values.mailProgram
        ? `Windows 기본 메일 프로그램(mailto): ${values.mailProgram}. 답장·새 메일이 열리지 않으면 계정의 쓰기를 웹메일로 바꾸거나 기본 앱을 확인하세요.`
        : 'Windows에 기본 메일 프로그램(mailto)이 없습니다. 웹메일 주소가 있는 계정은 웹메일로 씁니다. 메일 프로그램을 쓰려면 Windows 설정 → 앱 → 기본 앱 → "링크 유형별 기본값 선택" → MAILTO에서 Outlook 클래식·Thunderbird 등을 고르세요.';
      $('mailProgram').classList.toggle('err', !values.mailProgram);
      $('mailNotify').checked = values.notify !== false;
      const english = /^en\b/i.test(navigator.language || '');
      $('mailTodoTitle').textContent = english ? 'Todo integration' : '할 일 연동';
      $('mailTodoLabel').textContent = english ? 'Add messages to Todo' : '메일을 할 일에 추가';
      $('mailTodoIntegration').checked = Boolean(values.todoIntegration);
      $('mailTodoTarget').value = values.todoTarget === 'todo' ? 'todo' : 'todonote';
      if (english) {
        $('mailTodoTargetLabel').textContent = 'Add to';
        $('mailTodoTarget').options[0].textContent = 'To-do Notes';
        $('mailTodoTarget').options[1].textContent = 'Tasks (old)';
      }
      async function updateTodoStatus() {
        const box = $('mailTodoStatus');
        box.hidden = !$('mailTodoIntegration').checked;
        if (box.hidden) return;
        const s = await api.call('todoStatus');
        // #111: the choice shows only when both the sticky notes and the old to-do widget can take messages.
        $('mailTodoTargetRow').hidden = !s?.both;
        if (s?.target === 'todonote') {
          box.textContent = (english
            ? [`Engine ${s?.engineVersion || '—'} / API ${s?.engineApi || '—'} (API 1.7 required)`, `To-do Notes: ${s?.enabled && s?.running ? 'running' : 'enable it'}`, s?.peerEnabled ? 'Receive from Mail: enabled' : 'Enable “Receive from Mail” in To-do Notes settings.']
            : [`엔진 ${s?.engineVersion || '—'} / API ${s?.engineApi || '—'} (연동 API 1.7 필요)`, `할 일 노트: ${s?.enabled && s?.running ? '사용 중' : '사용 상태로 켜기'}`, s?.peerEnabled ? '메일에서 받기: 켜짐' : '할 일 노트 설정에서 “메일에서 받기”를 켜야 합니다.']).join(' · ');
          return;
        }
        const requirements = english
          ? [`Engine ${s?.engineVersion || '—'} / API ${s?.engineApi || '—'} (integration API 1.6 required)`, `Todo widget: ${s?.installed ? (s.enabled && s.running ? 'running' : 'enable it') : 'install it'}`, `Todo receiving support: ${s?.capabilities?.includes('todo-receive-external') ? 'available' : 'update Todo'}`, s?.peerEnabled ? 'Receive from Mail: enabled' : 'Enable “Receive from Mail” in Todo settings.']
          : [`엔진 ${s?.engineVersion || '—'} / API ${s?.engineApi || '—'} (연동 API 1.6 필요)`, `할 일 위젯: ${s?.installed ? (s.enabled && s.running ? '사용 중' : '사용 상태로 켜기') : '설치 필요'}`, `할 일 받기 기능: ${s?.capabilities?.includes('todo-receive-external') ? '지원' : '할 일 위젯 업데이트 필요'}`, s?.peerEnabled ? '메일에서 받기: 켜짐' : '할 일 설정에서 “메일에서 받기”를 켜야 합니다.'];
        box.textContent = requirements.join(' · ');
      }
      $('mailTodoIntegration').addEventListener('change', updateTodoStatus);
      $('mailTodoTarget').addEventListener('change', async () => {
        await api.call('setTodoTarget', $('mailTodoTarget').value);
        updateTodoStatus();
      });
      api.onEvent('integration-status', updateTodoStatus);
      updateTodoStatus();
      $('mailMarkRead').checked = values.markReadOnOpen !== false;
      $('mailPageSize').value = values.pageSize;
      $('mailOnTop').checked = Boolean(values.alwaysOnTop);
      $('mailRefreshMinutes').value = values.refreshMinutes;
      $('mailAdd').addEventListener('click', () => {
        addAccount({ enabled: true, provider: usable()[0].id }, true).querySelector('.mail-provider').focus();
      });
      $('mailRefresh').addEventListener('click', async () => {
        $('mailRefresh').disabled = true;
        try {
          status = (await api.call('refresh')) || status;
          updateStatus();
        } finally {
          $('mailRefresh').disabled = false;
        }
      });
      api.onEvent('display', (d) => {
        $('mailOnTop').checked = Boolean(d.alwaysOnTop);
        $('mailNotify').checked = d.notify !== false;
      });
      api.onEvent('status', (next) => {
        status = next || [];
        updateStatus();
      });
    },
    validate() {
      let problem = null;
      root.querySelectorAll('.mail-acc').forEach((box, i) => {
        const label = box.querySelector('.mail-name').value.trim() || `${i + 1}번째 계정`;
        const p = provider(box.querySelector('.mail-provider').value);
        if (!box.querySelector('.mail-user').value.trim()) problem ||= `${label}: 아이디를 넣으세요.`;
        else if (p.server === 'required' && !box.querySelector('.mail-host').value.trim()) problem ||= `${label}: 받는 메일 서버(IMAP)를 넣으세요.`;
        else if (box.dataset.connected !== 'saved' && box.dataset.connected !== loginKey(box)) problem ||= `${label}: 연결 확인을 눌러 받은편지함을 읽을 수 있는지 확인한 뒤 저장하세요.`;
        else if (box.dataset.connected === 'saved' && box.querySelector('.mail-pass').value) problem ||= `${label}: 새 비밀번호는 연결 확인을 눌러야 적용됩니다.`;
        const web = box.querySelector('.mail-webmail').value.trim();
        if (web && !/^https:\/\/\S+$/i.test(web)) problem ||= `${label}: 웹메일 주소는 https:// 로 시작해야 합니다.`;
      });
      const names = readCategories().map((c) => c.name);
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) problem ||= `같은 이름의 분류가 두 개 있습니다: ${dup}`;
      const minutes = Number($('mailRefreshMinutes').value);
      if (!(minutes >= 2 && minutes <= 1440)) problem ||= '확인 주기는 2~1440분입니다.';
      const page = Number($('mailPageSize').value);
      if (!(page >= 10 && page <= 100)) problem ||= '더 보기 단위는 10~100통입니다.';
      return problem;
    },
    read: () => ({
      accounts: readAccounts(),
      categories: readCategories(),
      notify: $('mailNotify').checked,
      todoIntegration: $('mailTodoIntegration').checked,
      todoTarget: $('mailTodoTarget').value,
      markReadOnOpen: $('mailMarkRead').checked,
      pageSize: Number($('mailPageSize').value),
      alwaysOnTop: $('mailOnTop').checked,
      refreshMinutes: Number($('mailRefreshMinutes').value),
    }),
  });
})();
