// Calendar section of the settings window (see engine/renderer/widget-settings.js for the panel contract).
// CalDAV accounts (#47) and ICS subscriptions (#49). Passwords typed here go to the widget's main code
// only through "연결 확인" (api.call('caldavDiscover')), which keeps them until the settings are saved.
(() => {
  const URL_RE = /^(https?|webcals?):\/\/[^\s/]+\S*$/i;
  let PALETTE = ['#4f8cff', '#3ccf8e', '#ff9f43', '#ff6b6b', '#a78bfa', '#2dd4bf', '#f472b6', '#facc15'];
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
  const provider = (id) => providers.find((p) => p.id === id) || providers[0];
  const todoText = {
    ko: { localHeading: '내 캘린더', localLabel: '오프라인 로컬 일정 사용', localHint: '일정은 이 PC의 캘린더 위젯 데이터에 저장됩니다.', todoHeading: '할 일 연동', todoLabel: '할 일 목표 날짜를 표시하고 캘린더에서 수정', completedLabel: '완료한 할 일', hide: '숨김', show: '완료 표시', needEngine: '위젯 간 연동을 지원하는 Desk Widgets 엔진이 필요합니다.', needTodo: '할 일 위젯을 설치하고 사용으로 켜세요.', needShare: '할 일 위젯에서 캘린더에 마감 표시를 켜세요.', ready: '연동 조건이 충족되었습니다.', checking: '연동 조건 확인 중…' },
    en: { localHeading: 'My Calendar', localLabel: 'Use offline local events', localHint: 'Events are stored in this calendar widget on this PC.', todoHeading: 'Tasks integration', todoLabel: 'Show task due dates and edit them in Calendar', completedLabel: 'Completed tasks', hide: 'Hide', show: 'Show as completed', needEngine: 'Update Desk Widgets to an engine with widget integration.', needTodo: 'Install and enable the Tasks widget.', needShare: 'Enable calendar due dates in the Tasks widget.', ready: 'Integration requirements are met.', checking: 'Checking integration requirements…' },
  };
  let labels = todoText.ko;
  async function updateTodoPrerequisites() {
    const line = $('calTodoPrerequisites');
    line.hidden = !$('calTodoIntegration').checked;
    $('calCompletedRow').hidden = !$('calTodoIntegration').checked;
    if (line.hidden) return;
    line.textContent = labels.checking;
    let result;
    try { result = await api.call('todoPrerequisites'); } catch { result = null; }
    const st = result?.status || {};
    line.textContent = !st.brokerAvailable ? labels.needEngine : !st.installed || !st.enabled || !st.running ? labels.needTodo : !st.peerEnabled || !st.capabilities?.includes('calendar-share') || !result?.access?.ok ? labels.needShare : labels.ready;
  }

  const time = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /** One status line: error, refreshing, last success, or "saved later". */
  function statusText(id, enabled) {
    const st = status.find((s) => s.id === id);
    if (!id || !st) return { text: '저장하면 받아옵니다.', kind: '' };
    if (!enabled) return { text: '꺼짐 (받지 않음)', kind: '' };
    if (st.refreshing) return { text: '받는 중…', kind: '' };
    if (st.error) return { text: `오류: ${st.error}${st.fetchedAt ? ` (마지막 성공 ${time(st.fetchedAt)}, 그때 받은 일정을 표시 중)` : ''}`, kind: 'err' };
    if (st.fetchedAt) return { text: `마지막 갱신 ${time(st.fetchedAt)} · 일정 ${st.count}개${st.calendarName ? ` · ${st.calendarName}` : ''}`, kind: 'ok' };
    return { text: '아직 받지 못했습니다.', kind: '' };
  }

  function updateStatus() {
    for (const box of root.querySelectorAll('.cal-src, .cal-acc')) {
      const { text, kind } = statusText(box.dataset.id, box.querySelector('.cal-on').checked);
      const line = box.querySelector('.cal-status');
      line.textContent = text;
      line.className = `cal-status ${kind}`;
    }
  }

  function updateEmpty(listId, text) {
    const list = $(listId);
    list.querySelector('.cal-empty')?.remove();
    if (!list.querySelector('.cal-src, .cal-acc')) list.append(el('div', { className: 'cal-empty', textContent: text }));
  }
  const emptyIcs = () => updateEmpty('calSources', '아직 구독한 캘린더가 없습니다. "+ 구독 추가"를 누르세요.');
  const emptyAcc = () => updateEmpty('calAccounts', '아직 연결한 계정이 없습니다. "+ 계정 추가"를 누르세요.');

  // ---- ICS subscriptions ----

  function addRow(src) {
    const box = el('div', { className: 'cal-src' });
    box.dataset.id = src.id || '';
    const on = el('input', { type: 'checkbox', className: 'cal-on', checked: src.enabled !== false, title: '사용' });
    const color = el('input', { type: 'color', className: 'cal-color', value: src.color, title: '색' });
    const name = el('input', { type: 'text', className: 'cal-name', value: src.name || '', placeholder: '이름 (예: 회사, 공휴일)', maxLength: 60 });
    const remove = el('button', { type: 'button', textContent: '삭제' });
    remove.addEventListener('click', () => {
      box.remove();
      emptyIcs();
    });
    on.addEventListener('change', updateStatus);
    const url = el('input', { type: 'url', className: 'cal-url', value: src.url || '', placeholder: 'https://… 또는 webcal://… (.ics 주소)' });
    url.addEventListener('input', () => url.classList.remove('invalid'));
    box.append(el('div', { className: 'row' }, on, color, name, remove), url, el('div', { className: 'cal-status' }));
    $('calSources').append(box);
    emptyIcs();
    updateStatus();
    return box;
  }

  function readIcs() {
    return [...root.querySelectorAll('.cal-src')].map((box) => ({
      id: box.dataset.id || undefined,
      type: 'ics',
      enabled: box.querySelector('.cal-on').checked,
      color: box.querySelector('.cal-color').value,
      name: box.querySelector('.cal-name').value.trim(),
      url: box.querySelector('.cal-url').value.trim(),
    }));
  }

  // ---- CalDAV accounts ----

  /** The calendars found by discovery (or saved), with on/off and color. */
  function fillCalendars(box, calendars) {
    const list = box.querySelector('.cal-cals');
    list.replaceChildren(
      ...calendars.map((c) => {
        const row = el('label', { className: 'check cal-cal' });
        row.dataset.id = c.id;
        row.dataset.canWrite = c.canWrite === true ? 'true' : c.canWrite === false ? 'false' : '';
        const on = el('input', { type: 'checkbox', className: 'cal-cal-on', checked: c.enabled !== false });
        const color = el('input', { type: 'color', className: 'cal-cal-color', value: c.color || PALETTE[0], title: '색' });
        const name = el('span', { className: 'cal-cal-name', textContent: c.name });
        row.append(on, color, name);
        if (c.canWrite === false) row.append(el('span', { className: 'cal-badge', textContent: '읽기 전용' }));
        return row;
      }),
    );
    if (!calendars.length) list.append(el('div', { className: 'cal-empty', textContent: '이 계정에서 일정(VEVENT)을 담는 캘린더를 찾지 못했습니다.' }));
  }

  /** Labels, guide and server field for the chosen provider. */
  function showProvider(box) {
    const p = provider(box.querySelector('.cal-provider').value);
    box.querySelector('.cal-guide-steps').replaceChildren(...p.steps.map((s) => el('li', { textContent: s })));
    box.querySelector('.cal-guide-link').textContent = p.helpUrl ? `안내/발급: ${p.helpUrl}` : '';
    box.querySelector('.cal-user-label').textContent = p.userLabel;
    box.querySelector('.cal-pass-label').textContent = p.passwordLabel;
    const serverRow = box.querySelector('.cal-server-row');
    serverRow.hidden = p.server === 'fixed';
    box.querySelector('.cal-server').placeholder = p.server === 'optional' ? `비워 두면 ${p.baseUrl}` : 'https://cal.example.com';
    box.querySelector('.cal-server-hint').textContent = p.serverHint || '';
  }

  /** Login fields as last connected; a change after "연결 확인" needs another one. */
  const loginKey = (box) =>
    JSON.stringify([box.querySelector('.cal-provider').value, box.querySelector('.cal-server').value.trim(), box.querySelector('.cal-user').value.trim()]);

  function setResult(box, text, kind) {
    const line = box.querySelector('.cal-result');
    line.textContent = text;
    line.className = `cal-result hint ${kind || ''}`;
  }

  async function connect(box) {
    const btn = box.querySelector('.cal-connect');
    btn.disabled = true;
    setResult(box, '연결하는 중…', '');
    try {
      const res = await api.call('caldavDiscover', {
        accountId: box.dataset.id || null,
        provider: box.querySelector('.cal-provider').value,
        server: box.querySelector('.cal-server').value.trim(),
        username: box.querySelector('.cal-user').value.trim(),
        password: box.querySelector('.cal-pass').value,
      });
      if (!res?.ok) {
        setResult(box, res?.message || '연결하지 못했습니다.', 'err');
        return;
      }
      // Keep the choices of calendars already in the list.
      const prev = new Map([...box.querySelectorAll('.cal-cal')].map((r) => [r.dataset.id, { enabled: r.querySelector('.cal-cal-on').checked, color: r.querySelector('.cal-cal-color').value }]));
      fillCalendars(
        box,
        res.calendars.map((c) => ({ ...c, ...(prev.get(c.id) || {}) })),
      );
      if (res.token) box.dataset.draft = res.token;
      box.dataset.connected = loginKey(box);
      box.querySelector('.cal-pass').value = '';
      box.querySelector('.cal-pass').placeholder = res.token ? '확인됨 — 저장하면 암호화해 저장합니다' : '저장됨 — 바꿀 때만 입력';
      setResult(box, `연결됨 · 캘린더 ${res.calendars.length}개를 찾았습니다. 볼 캘린더를 고르고 저장하세요.`, 'ok');
    } catch (err) {
      setResult(box, `연결하지 못했습니다: ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  function addAccount(acc, isNew) {
    const box = el('div', { className: 'cal-acc' });
    box.dataset.id = acc.id || '';
    if (!isNew) box.dataset.connected = 'saved';
    const on = el('input', { type: 'checkbox', className: 'cal-on', checked: acc.enabled !== false, title: '사용' });
    const name = el('input', { type: 'text', className: 'cal-name', value: acc.name || '', placeholder: '이름 (예: 개인 iCloud)', maxLength: 60 });
    const remove = el('button', { type: 'button', textContent: '삭제' });
    remove.addEventListener('click', () => {
      box.remove();
      emptyAcc();
    });
    on.addEventListener('change', updateStatus);

    const select = el('select', { className: 'cal-provider', disabled: !isNew });
    for (const p of providers) select.append(el('option', { value: p.id, textContent: p.label }));
    select.value = acc.provider || providers[0].id;
    select.addEventListener('change', () => {
      showProvider(box);
      fillCalendars(box, []);
      delete box.dataset.draft;
    });

    const guide = el(
      'details',
      { className: 'cal-guide', open: isNew },
      el('summary', { textContent: '앱 비밀번호 발급 방법' }),
      el('ol', { className: 'cal-guide-steps' }),
      el('div', { className: 'cal-guide-link hint' }),
    );
    const server = el('input', { type: 'url', className: 'cal-server', value: acc.server && provider(acc.provider)?.server !== 'fixed' && acc.server !== provider(acc.provider)?.baseUrl ? acc.server : '' });
    const serverRow = el(
      'div',
      { className: 'cal-server-row' },
      el('label', { textContent: 'CalDAV 서버 주소' }, server),
      el('div', { className: 'cal-server-hint hint' }),
    );
    const user = el('input', { type: 'text', className: 'cal-user', value: acc.username || '', autocomplete: 'off', spellcheck: false });
    const pass = el('input', {
      type: 'password',
      className: 'cal-pass',
      autocomplete: 'new-password',
      placeholder: isNew ? '' : '저장됨 — 바꿀 때만 입력하고 연결 확인',
    });
    const connectBtn = el('button', { type: 'button', className: 'cal-connect', textContent: isNew ? '연결 확인' : '연결 확인 · 캘린더 다시 찾기' });
    connectBtn.addEventListener('click', () => connect(box));
    for (const input of [server, user, pass]) input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), connect(box)));

    box.append(
      el('div', { className: 'row' }, on, name, remove),
      el('label', { textContent: '서비스' }, select),
      guide,
      serverRow,
      el('label', {}, el('span', { className: 'cal-user-label' }), user),
      el('label', {}, el('span', { className: 'cal-pass-label' }), pass),
      el('div', { className: 'row' }, connectBtn),
      el('div', { className: 'cal-result hint' }),
      el('div', { className: 'cal-cals' }),
      el('div', { className: 'cal-status' }),
    );
    $('calAccounts').append(box);
    showProvider(box);
    fillCalendars(box, acc.calendars || []);
    if (isNew) box.querySelector('.cal-status').hidden = true;
    emptyAcc();
    updateStatus();
    return box;
  }

  function readAccounts() {
    return [...root.querySelectorAll('.cal-acc')].map((box) => ({
      id: box.dataset.id || undefined,
      type: 'caldav',
      enabled: box.querySelector('.cal-on').checked,
      name: box.querySelector('.cal-name').value.trim(),
      provider: box.querySelector('.cal-provider').value,
      server: box.querySelector('.cal-server').value.trim(),
      username: box.querySelector('.cal-user').value.trim(),
      draft: box.dataset.draft || undefined,
      calendars: [...box.querySelectorAll('.cal-cal')].map((r) => ({
        id: r.dataset.id,
        name: r.querySelector('.cal-cal-name').textContent,
        color: r.querySelector('.cal-cal-color').value,
        enabled: r.querySelector('.cal-cal-on').checked,
        canWrite: r.dataset.canWrite === 'true' ? true : r.dataset.canWrite === 'false' ? false : null,
      })),
    }));
  }

  window.settingsShell.registerPanel('calendar', {
    init(panelRoot, values, shellApi) {
      root = panelRoot;
      api = shellApi;
      labels = todoText[String(values.locale || '').startsWith('en') ? 'en' : 'ko'];
      for (const [id, key] of Object.entries({ calLocalHeading: 'localHeading', calLocalLabel: 'localLabel', calLocalHint: 'localHint', calTodoHeading: 'todoHeading', calTodoLabel: 'todoLabel', calCompletedLabel: 'completedLabel' })) $(id).textContent = labels[key];
      for (const key of ['hide', 'show']) $('calCompletedTodos').querySelector(`[value="${key}"]`).textContent = labels[key];
      $('calLocalEnabled').checked = values.localEnabled !== false;
      $('calTodoIntegration').checked = values.todoIntegration === true;
      $('calCompletedTodos').value = values.completedTodos === 'show' ? 'show' : 'hide';
      $('calTodoIntegration').addEventListener('change', updateTodoPrerequisites);
      updateTodoPrerequisites();
      status = values.status || [];
      providers = values.providers || [];
      if (values.palette) PALETTE = values.palette;
      for (const src of values.sources || []) {
        if (src.type === 'caldav') addAccount(src, false);
        else addRow(src);
      }
      emptyIcs();
      emptyAcc();
      $('calSecretWarn').hidden = values.secretAvailable !== false;
      $('calAddAccount').disabled = values.secretAvailable === false || !providers.length;
      // The engine's theme section (#59, #61): list, preview, background opacity, theme folder. Its themeId and
      // themeOpacity are saved with read() by the settings window itself.
      if (api.mountThemePicker) api.mountThemePicker($('calThemes'), { themeId: values.themeId, themeOpacity: values.themeOpacity });
      $('calMockNote').hidden = !values.mock;
      $('calWeekStart').value = String(values.weekStart);
      $('calUpcoming').value = values.upcomingDays;
      $('calOnTop').checked = Boolean(values.alwaysOnTop);
      $('calRefreshMinutes').value = values.refreshMinutes;
      $('calAddAccount').addEventListener('click', () => {
        addAccount({ enabled: true, provider: providers[0].id }, true).querySelector('.cal-provider').focus();
      });
      $('calAdd').addEventListener('click', () => {
        const n = root.querySelectorAll('.cal-src').length;
        addRow({ enabled: true, color: PALETTE[n % PALETTE.length], name: '', url: '' }).querySelector('.cal-url').focus();
      });
      $('calRefresh').addEventListener('click', async () => {
        $('calRefresh').disabled = true;
        try {
          status = (await api.call('refresh')) || status;
          updateStatus();
        } finally {
          $('calRefresh').disabled = false;
        }
      });
      api.onEvent('display', (d) => {
        $('calWeekStart').value = String(d.weekStart);
        $('calOnTop').checked = Boolean(d.alwaysOnTop);
      });
      api.onEvent('status', (next) => {
        status = next || [];
        updateStatus();
      });
    },
    validate() {
      let problem = null;
      root.querySelectorAll('.cal-acc').forEach((box, i) => {
        const label = box.querySelector('.cal-name').value.trim() || `${i + 1}번째 계정`;
        if (!box.querySelector('.cal-user').value.trim()) problem ||= `${label}: 아이디를 넣으세요.`;
        else if (box.dataset.connected !== 'saved' && box.dataset.connected !== loginKey(box)) problem ||= `${label}: 연결 확인을 눌러 캘린더를 찾은 뒤 저장하세요.`;
        else if (box.dataset.connected === 'saved' && box.querySelector('.cal-pass').value) problem ||= `${label}: 새 비밀번호는 연결 확인을 눌러야 적용됩니다.`;
        else if (!box.querySelector('.cal-cal')) problem ||= `${label}: 캘린더가 없습니다. 연결 확인을 다시 눌러 보세요.`;
      });
      root.querySelectorAll('.cal-src').forEach((box, i) => {
        const url = box.querySelector('.cal-url');
        if (!URL_RE.test(url.value.trim())) {
          url.classList.add('invalid');
          problem ||= `${i + 1}번째 구독의 주소가 올바르지 않습니다. http(s):// 또는 webcal:// 로 시작하는 iCal 주소를 넣으세요.`;
        }
      });
      const up = Number($('calUpcoming').value);
      if (!(up >= 1 && up <= 31)) problem ||= '다가오는 일정 기간은 1~31일입니다.';
      const minutes = Number($('calRefreshMinutes').value);
      if (!(minutes >= 5 && minutes <= 1440)) problem ||= '새로고침 주기는 5~1440분입니다.';
      return problem;
    },
    read: () => ({
      sources: [...readAccounts(), ...readIcs()],
      weekStart: Number($('calWeekStart').value),
      upcomingDays: Number($('calUpcoming').value),
      alwaysOnTop: $('calOnTop').checked,
      refreshMinutes: Number($('calRefreshMinutes').value),
      localEnabled: $('calLocalEnabled').checked,
      todoIntegration: $('calTodoIntegration').checked,
      completedTodos: $('calCompletedTodos').value,
    }),
  });
})();
