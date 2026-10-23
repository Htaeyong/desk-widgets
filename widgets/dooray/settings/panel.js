// Dooray section of the settings window (see engine/renderer/settings.js for the panel contract).
(() => {
  let root = null;
  let api = null;
  let current = null;
  let themes = [];
  // null until the project list loads; then saving rewrites hiddenProjectIds from the checklist.
  let projects = null;
  // Background opacity per theme (#55): unsaved edits here (null = back to the theme default).
  // Themes declare support and their default with theme.json "background": { "opacity": 0..1 }.
  const editedOpacity = {};

  const $ = (id) => root.querySelector(`#${id}`);
  const all = (selector) => [...root.querySelectorAll(selector)];

  function setStatus(el, text, kind = '') {
    el.textContent = text;
    el.className = `status ${kind}`;
  }

  function el(tag, props = {}, text) {
    const node = Object.assign(document.createElement(tag), props);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function read() {
    return {
      doorayDomain: $('doorayDomain').value,
      // Empty token field means "keep the saved token".
      apiToken: $('apiToken').value || undefined,
      apiBase: $('apiBase').value,
      pollIntervalSec: Number($('pollIntervalSec').value),
      alwaysOnTop: $('alwaysOnTop').checked,
      themeId: $('themeId').value || current.themeId,
      dueSoonDays: Number($('dueSoonDays').value),
      notifyEnabled: $('notifyEnabled').checked,
      notifyTypes: Object.fromEntries(all('[data-notify-type]').map((box) => [box.dataset.notifyType, box.checked])),
      notifyScope: Object.fromEntries(all('[data-notify-scope]').map((box) => [box.dataset.notifyScope, box.checked])),
      hiddenProjectIds: projects ? all('#projectList input:not(:checked)').map((x) => x.value) : current.hiddenProjectIds,
      // The list order is the user's project order (drag and drop).
      projectOrder: projects ? all('#projectList input').map((x) => x.value) : current.projectOrder,
      themeOpacity: readOpacity(),
      todoIntegration: $('todoIntegration').checked,
    };
  }

  const themeOf = (id) => themes.find((t) => t.id === id);
  const savedOpacity = () => current.themeOpacity || {};
  const defaultOpacity = (id) => Math.round((themeOf(id)?.background?.opacity ?? 1) * 100);

  /** Opacity in % the theme is shown with: the edit here, else the saved choice, else the theme default. */
  function opacityOf(id) {
    if (id in editedOpacity) return editedOpacity[id] === null ? defaultOpacity(id) : editedOpacity[id];
    return id in savedOpacity() ? savedOpacity()[id] : defaultOpacity(id);
  }

  /** Saved choices plus the edits here; a reset drops the theme's entry so its default applies again. */
  function readOpacity() {
    const out = { ...savedOpacity() };
    for (const [id, value] of Object.entries(editedOpacity)) {
      if (value === null) delete out[id];
      else out[id] = value;
    }
    return out;
  }

  /** The slider is for the theme selected here, and only when that theme supports it. */
  function showOpacity() {
    const id = $('themeId').value;
    const t = themeOf(id);
    $('opacityBox').hidden = !t?.usable || !t.background;
    if ($('opacityBox').hidden) return;
    $('opacityTheme').textContent = t.name;
    $('themeOpacity').value = String(opacityOf(id));
    $('themeOpacityValue').textContent = `${opacityOf(id)}%`;
  }

  /** Shows the value on the running theme (and its preview) while the slider moves; nothing is saved until 저장. */
  function setOpacity(value) {
    const id = $('themeId').value;
    editedOpacity[id] = value;
    showOpacity();
    api.call('liveOpacity', id, opacityOf(id));
  }

  function describeTheme(t) {
    if (!t) return '';
    if (!t.usable) return `사용할 수 없음: ${t.errors.join(', ')}`;
    const by = t.author ? ` · ${t.author}` : '';
    const src = t.source === 'user' ? ' · 사용자 테마' : t.source === 'dev' ? ' · 개발 중' : '';
    return `v${t.version}${by}${src}${t.description ? ' — ' + t.description : ''}`;
  }

  async function loadThemes() {
    themes = await api.call('themes');
    const select = $('themeId');
    const selected = select.value || current.themeId;
    select.replaceChildren(...themes.map((t) => el('option', { value: t.id, disabled: !t.usable }, t.usable ? t.name : `${t.name} (호환 안 됨)`)));
    select.value = themes.some((t) => t.id === selected && t.usable) ? selected : 'glass';
    $('themeInfo').textContent = describeTheme(themes.find((t) => t.id === select.value));
    showOpacity();
  }

  function updateProjectCount() {
    if (!projects) return;
    $('projectCount').textContent = `${all('#projectList input:checked').length} / ${projects.length}개 표시`;
  }

  async function loadProjects() {
    const list = $('projectList');
    try {
      const items = await api.call('projects');
      if (!items.length) {
        list.replaceChildren(el('p', { className: 'hint' }, '연결 설정을 저장하면 프로젝트 목록이 표시됩니다.'));
        return;
      }
      projects = items;
      const hidden = new Set(current.hiddenProjectIds);
      // Saved order first; projects not in it keep Dooray's order after them.
      const rank = new Map((current.projectOrder || []).map((id, i) => [id, i]));
      const ordered = items
        .map((p, i) => ({ p, i, r: rank.has(p.id) ? rank.get(p.id) : Infinity }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.p);
      list.replaceChildren(
        ...ordered.map((p) => {
          const label = el('label', { title: `${p.description || p.name}\n끌어서 순서 변경`, draggable: true });
          label.dataset.id = p.id;
          const box = el('input', { type: 'checkbox', value: p.id, checked: !hidden.has(p.id) });
          box.addEventListener('change', updateProjectCount);
          label.append(el('span', { className: 'grip', ariaHidden: 'true' }, '⠿'), box, el('span', {}, p.name));
          return label;
        })
      );
      enableReorder(list);
      updateProjectCount();
    } catch {
      list.replaceChildren(el('p', { className: 'hint' }, '프로젝트 목록을 불러오지 못했습니다.'));
    }
  }

  // Drag and drop inside the project checklist: the dragged row moves live under the pointer.
  function enableReorder(list) {
    let dragged = null;
    list.addEventListener('dragstart', (e) => {
      dragged = e.target.closest('label');
      if (!dragged) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragged.dataset.id);
      dragged.classList.add('dragging');
    });
    list.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      const target = e.target.closest('label');
      if (!target || target === dragged) return;
      const rect = target.getBoundingClientRect();
      target[e.clientY > rect.top + rect.height / 2 ? 'after' : 'before'](dragged);
    });
    list.addEventListener('drop', (e) => e.preventDefault());
    list.addEventListener('dragend', () => {
      dragged?.classList.remove('dragging');
      dragged = null;
    });
  }

  function checkConnection(values) {
    if (current.mockData) return true;
    const domainOk = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(values.doorayDomain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
    $('doorayDomain').classList.toggle('invalid', !domainOk);
    const tokenOk = Boolean(values.apiToken || current.hasToken);
    $('apiToken').classList.toggle('invalid', !tokenOk);
    return domainOk && tokenOk;
  }

  // Tells the user what the chosen notification types cost in API requests.
  function describeNotifyLoad() {
    const on = (type) => $('notifyEnabled').checked && root.querySelector(`[data-notify-type="${type}"]`).checked;
    if (on('mention')) return '추가 요청: 변경이 있을 때 바뀐 업무마다 댓글을 확인합니다(멘션 때문에 범위와 무관, 최대 20건).';
    if (on('comment')) return '추가 요청: 변경이 있을 때 범위 안의 바뀐 업무만 댓글을 확인합니다(최대 20건).';
    return '추가 요청 없음: 댓글·멘션 알림이 꺼져 있어 기본 갱신 요청만 사용합니다.';
  }

  function syncNotifyControls() {
    $('notifyOptions').classList.toggle('disabled', !$('notifyEnabled').checked);
    $('notifyLoad').textContent = describeNotifyLoad();
  }

  function init(panelRoot, values, panelApi) {
    root = panelRoot;
    api = panelApi;
    current = values;
    const english = /^en\b/i.test(navigator.language || '');
    $('todoIntegrationTitle').textContent = english ? 'Todo integration' : '할 일 연동';
    $('todoIntegrationLabel').textContent = english ? 'Add Dooray tasks to Todo' : '두레이 업무를 할 일에 추가';
    $('todoIntegration').checked = Boolean(values.todoIntegration);
    async function updateTodoStatus() {
      const box = $('todoIntegrationStatus');
      box.hidden = !$('todoIntegration').checked;
      if (box.hidden) return;
      const s = await api.call('todoStatus');
      const requirements = english
        ? [`Engine ${s?.engineVersion || '—'} / API ${s?.engineApi || '—'} (integration API 1.6 required)`, `Todo widget: ${s?.installed ? (s.enabled && s.running ? 'running' : 'enable it') : 'install it'}`, `Todo receiving support: ${s?.capabilities?.includes('todo-receive-external') ? 'available' : 'update Todo'}`, s?.peerEnabled ? 'Receive from Dooray: enabled' : 'Enable “Receive from Dooray” in Todo settings.']
        : [`엔진 ${s?.engineVersion || '—'} / API ${s?.engineApi || '—'} (연동 API 1.6 필요)`, `할 일 위젯: ${s?.installed ? (s.enabled && s.running ? '사용 중' : '사용 상태로 켜기') : '설치 필요'}`, `할 일 받기 기능: ${s?.capabilities?.includes('todo-receive-external') ? '지원' : '할 일 위젯 업데이트 필요'}`, s?.peerEnabled ? '두레이에서 받기: 켜짐' : '할 일 설정에서 “두레이에서 받기”를 켜야 합니다.'];
      box.textContent = requirements.join(' · ');
    }
    $('todoIntegration').addEventListener('change', updateTodoStatus);
    api.onEvent('integration-status', updateTodoStatus);
    updateTodoStatus();
    $('intro').hidden = current.isConfigured || current.mockData;
    $('doorayDomain').value = current.doorayDomain;
    $('apiBase').value = current.apiBase;
    $('pollIntervalSec').value = current.pollIntervalSec;
    $('pollIntervalSec').min = current.limits.MIN_POLL_SEC;
    $('pollIntervalSec').max = current.limits.MAX_POLL_SEC;
    $('alwaysOnTop').checked = current.alwaysOnTop;
    $('dueSoonDays').value = current.dueSoonDays;
    $('dueSoonDays').max = current.limits.MAX_DUE_SOON_DAYS;
    $('notifyEnabled').checked = current.notifyEnabled;
    all('[data-notify-type]').forEach((box) => (box.checked = box.dataset.notifyType === 'comment-edit' ? current.notifyTypes['comment-edit'] === true : current.notifyTypes[box.dataset.notifyType] !== false));
    all('[data-notify-scope]').forEach((box) => (box.checked = current.notifyScope?.[box.dataset.notifyScope] !== false));
    syncNotifyControls();
    if (current.hasToken) $('apiToken').placeholder = '저장된 토큰 사용 중 (바꿀 때만 입력)';

    $('themeId').addEventListener('change', () => {
      $('themeInfo').textContent = describeTheme(themes.find((t) => t.id === $('themeId').value));
      showOpacity();
    });
    $('themeOpacity').addEventListener('input', () => setOpacity(Number($('themeOpacity').value)));
    $('themeOpacityReset').addEventListener('click', () => setOpacity(null));
    // Closing without 저장 (or after it) ends the live value; the widget goes back to what is saved.
    // The engine also ends it when this window closes.
    window.addEventListener('pagehide', () => api.call('liveOpacity', $('themeId').value, null));
    $('notifyEnabled').addEventListener('change', syncNotifyControls);
    all('[data-notify-type]').forEach((box) => box.addEventListener('change', syncNotifyControls));
    $('testNotification').addEventListener('click', () => api.call('testNotification'));
    $('openRules').addEventListener('click', () => api.call('openRules'));
    $('openThemeFolder').addEventListener('click', () => api.call('openThemeFolder'));
    $('previewTheme').addEventListener('click', () => api.call('previewTheme', $('themeId').value));
    // The preview's "use this theme" applies right away; keep this form in step so saving does not undo it.
    api.onEvent('theme-applied', (themeId) => {
      current.themeId = themeId;
      $('themeId').value = themeId;
      $('themeInfo').textContent = describeTheme(themes.find((t) => t.id === themeId));
      showOpacity();
    });
    $('openCategoryManager').addEventListener('click', () => api.call('openCategoryManager'));
    $('reloadThemes').addEventListener('click', loadThemes);
    for (const [id, value] of [['checkAll', true], ['checkNone', false]]) {
      $(id).addEventListener('click', () => {
        all('#projectList input').forEach((box) => (box.checked = value));
        updateProjectCount();
      });
    }
    $('toggleToken').addEventListener('click', () => {
      const input = $('apiToken');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('toggleToken').textContent = show ? '숨기기' : '보기';
    });
    $('test').addEventListener('click', async () => {
      const values = read();
      if (!checkConnection(values)) {
        setStatus($('testResult'), '도메인과 토큰을 확인해 주세요.', 'err');
        return;
      }
      $('test').disabled = true;
      setStatus($('testResult'), '확인 중…');
      const res = await api.call('test', values);
      $('test').disabled = false;
      if (res.ok) setStatus($('testResult'), `연결 성공 — ${res.name}님`, 'ok');
      else setStatus($('testResult'), res.message, 'err');
    });

    if (!current.isConfigured && !current.mockData) $('doorayDomain').focus();
    loadThemes();
    loadProjects();
  }

  window.settingsShell.registerPanel('dooray', {
    init,
    read,
    validate: () => (checkConnection(read()) ? null : '두레이: 도메인과 API 토큰을 확인해 주세요.'),
  });
})();
