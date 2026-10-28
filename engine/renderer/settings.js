// Widget manager: installed widgets with on/off (applied right away) and engine-wide settings.
const $ = (id) => document.getElementById(id);
const form = $('form');

const STATUS = {
  running: ['사용 중', 'ok'],
  off: ['꺼짐', ''],
  incompatible: ['호환 안 됨', 'err'],
  error: ['오류', 'err'],
};

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

function el(tag, props = {}, text) {
  const node = Object.assign(document.createElement(tag), props);
  if (text !== undefined) node.textContent = text;
  return node;
}

function widgetRow(w) {
  const row = el('div', { className: 'widget-row' });
  const head = el('div', { className: 'widget-head' });
  const toggle = el('label', { className: 'check widget-toggle' });
  const box = el('input', { type: 'checkbox', checked: w.enabled, disabled: w.status === 'incompatible' || w.status === 'error' });
  box.addEventListener('change', async () => {
    box.disabled = true;
    const res = await window.engineApi.setEnabled(w.id, box.checked);
    if (res.ok) render(res.state);
    else box.disabled = false;
  });
  toggle.append(box, el('span', {}, ` ${w.name}`));
  const [label, kind] = STATUS[w.status] || [w.status, ''];
  head.append(toggle, el('span', { className: 'version' }, w.version ? `v${w.version}` : ''), el('span', { className: `badge ${kind}` }, label));
  if (w.source === 'dev') head.append(el('span', { className: 'badge' }, '개발 중'));
  if (w.hasSettings && w.status === 'running') {
    const btn = el('button', { type: 'button', className: 'secondary small' }, '설정');
    btn.addEventListener('click', () => window.engineApi.openWidgetSettings(w.id));
    head.append(btn);
  }
  row.append(head);
  if (w.message) row.append(el('p', { className: 'hint err' }, w.message));
  else if (w.description) row.append(el('p', { className: 'hint' }, w.description));
  return row;
}

function render(state) {
  $('widgetList').replaceChildren(...state.widgets.map(widgetRow));
  $('emptyHelp').hidden = state.widgets.length > 0;
  $('engineInfo').textContent = `엔진 API ${state.engineApi}`;
  $('openFolder').title = state.widgetsDir;
  renderUpdates(state.updates);
  renderPicker(state.picker);
}

// ---- First-run widget picker (#96) ----

const picked = new Set(); // ids the user has checked
const seenRows = new Set(); // rows already given their default; a later render keeps the user's choices
let pickerOpened = false;
let pickerState = null;

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);

function pickerRow(r, queued) {
  const row = el('div', { className: 'widget-row' });
  const head = el('div', { className: 'widget-head' });
  const toggle = el('label', { className: 'check widget-toggle' });
  const box = el('input', { type: 'checkbox', checked: r.status === 'available' && picked.has(r.id), disabled: r.status !== 'available' || Boolean(queued) });
  box.addEventListener('change', () => (box.checked ? picked.add(r.id) : picked.delete(r.id)));
  toggle.append(box, el('span', {}, ` ${r.name}`));
  head.append(toggle, el('span', { className: 'version' }, `v${r.version} · ${formatSize(r.size)}`));
  if (r.status === 'installed') head.append(el('span', { className: 'badge ok' }, '설치됨'));
  if (r.status === 'needs-engine') head.append(el('span', { className: 'badge err' }, '엔진 업데이트 필요'));
  row.append(head);
  if (r.status === 'needs-engine') row.append(el('p', { className: 'hint' }, `Desk Widgets ${r.engineMin || '새 버전'} 이상이 필요합니다. 아래 업데이트에서 엔진을 먼저 업데이트하세요.`));
  else if (r.description) row.append(el('p', { className: 'hint' }, r.description));
  if (queued) {
    const bad = queued.state === 'failed' || queued.state === 'stalled';
    row.append(el('p', { className: `hint${bad ? ' err' : ''}` }, queued.state === 'failed' ? `${queued.text}: ${queued.message}` : queued.text));
    const actions = el('div', { className: 'row' });
    if (queued.state === 'waiting' || queued.state === 'queued') {
      const skip = el('button', { type: 'button', className: 'ghost small' }, '건너뛰기');
      skip.addEventListener('click', () => window.engineApi.pickerSkip(r.id));
      actions.append(skip);
    }
    if (['failed', 'stalled', 'skipped'].includes(queued.state)) {
      const retry = el('button', { type: 'button', className: 'secondary small' }, '다시 시도');
      retry.addEventListener('click', () => window.engineApi.pickerRetry(r.id));
      actions.append(retry);
    }
    if (actions.children.length) row.append(actions);
  }
  return row;
}

function renderPicker(p) {
  if (!p) return;
  pickerState = p;
  for (const r of p.rows) {
    if (!seenRows.has(r.id)) {
      seenRows.add(r.id);
      if (r.checked) picked.add(r.id);
    }
  }
  $('pickerPanel').hidden = !pickerOpened;
  $('pickerOpen').hidden = pickerOpened;
  if (!pickerOpened) return;
  const queue = new Map(p.queue.map((q) => [q.id, q]));
  $('pickerList').replaceChildren(...p.rows.map((r) => pickerRow(r, queue.get(r.id))));
  const available = p.rows.filter((r) => r.status === 'available').length;
  let info = '';
  if (p.loading) info = '위젯 목록을 불러오는 중...';
  else if (p.error) info = `${p.error} 인터넷 연결을 확인하고 다시 불러오거나, 다운로드 페이지에서 받은 설치 파일을 직접 열 수 있습니다.`;
  else if (p.loaded && !p.rows.length) info = '설치할 수 있는 위젯이 없습니다.';
  else if (p.loaded && !available && !p.queue.length) info = '모든 위젯을 설치했습니다.';
  const done = p.queue.filter((q) => q.state === 'done').length;
  if (p.running) info = `설치 중 (${done + 1}/${p.queue.length}) — 관리자 확인 창이 뜨면 "예"를 누르세요.`;
  else if (p.queue.length) info = `${done}/${p.queue.length}개 설치했습니다.${p.queue.some((q) => q.state === 'failed' || q.state === 'stalled') ? ' 실패한 위젯은 다시 시도할 수 있습니다.' : ''}`;
  setStatus($('pickerInfo'), info, p.error ? 'err' : '');
  $('pickerInfo').classList.add('hint');
  $('pickerInstall').disabled = p.loading || p.running || !p.rows.some((r) => r.status === 'available' && picked.has(r.id));
  $('pickerReload').disabled = p.loading || p.running;
  const local = p.localMessage || '';
  setStatus($('pickerLocal'), local, local && !local.startsWith('설치 프로그램을') ? 'err' : '');
  $('pickerLocal').classList.add('hint');
}

async function openPicker() {
  pickerOpened = true;
  renderPicker(pickerState || { rows: [], queue: [], loading: true });
  renderPicker(await window.engineApi.pickerLoad());
}

// ---- In-app updates (#104) ----

const UPDATE_STATUS = {
  available: ['새 버전', 'ok'],
  'needs-engine': ['엔진을 먼저 업데이트', 'err'],
  current: ['최신', ''],
  unknown: ['정보 없음', ''],
  frozen: ['새 버전 없음', ''],
};

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateRow(item) {
  const row = el('div', { className: 'widget-row' });
  const head = el('div', { className: 'widget-head' });
  const versions = item.status !== 'frozen' && item.latest && item.latest !== item.current ?`v${item.current || '?'} → v${item.latest}` : item.current ? `v${item.current}` : '';
  head.append(el('span', { className: 'widget-toggle' }, item.name), el('span', { className: 'version' }, versions));
  const [label, kind] = UPDATE_STATUS[item.status] || [item.status, ''];
  head.append(el('span', { className: `badge ${kind}` }, label));
  const job = item.job;
  const busy = job && ['downloading', 'verifying', 'launching'].includes(job.phase);
  if (item.status === 'available' && job?.phase !== 'launched') {
    const btn = el('button', { type: 'button', className: 'secondary small', disabled: Boolean(busy) }, job?.phase === 'error' ? '다시 시도' : '업데이트');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await window.engineApi.installUpdate(item.id);
    });
    head.append(btn);
  }
  row.append(head);
  if (job) {
    let text = job.text;
    if (job.phase === 'downloading' && job.total) text = `${job.text} ${Math.floor((job.received / job.total) * 100)}%`;
    if (job.phase === 'launched') text = item.kind === 'engine' ? '설치 프로그램을 실행했습니다. Desk Widgets가 곧 종료되고 설치가 끝나면 다시 시작됩니다.' : '설치 프로그램을 실행했습니다. 설치가 끝나면 위젯이 다시 시작됩니다.';
    if (job.phase === 'error') text = job.message;
    row.append(el('p', { className: `hint${job.phase === 'error' ? ' err' : ''}` }, text));
    if (job.phase === 'downloading' && job.total) row.append(el('progress', { max: job.total, value: job.received, className: 'update-progress' }));
  } else if (item.status === 'needs-engine') {
    row.append(el('p', { className: 'hint' }, `이 버전에는 Desk Widgets ${item.engineMin || '새 버전'} 이상이 필요합니다. 엔진을 먼저 업데이트하세요.`));
  }
  if (item.notice) row.append(...frozenNotice(item.notice));
  return row;
}

// #111: a frozen widget's row says where its features went and offers the successor when it is not installed.
function frozenNotice(notice) {
  const s = notice.successor;
  const job = s.job;
  const busy = job && ['downloading', 'verifying', 'launching'].includes(job.phase);
  const line = el('div', { className: 'frozen-notice' });
  line.append(el('span', { className: 'hint' }, notice.text));
  if (s.status === 'available' && job?.phase !== 'launched') {
    const btn = el('button', { type: 'button', className: 'secondary small', disabled: Boolean(busy) }, job?.phase === 'error' ? '다시 시도' : `${s.name} 설치`);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await window.engineApi.installUpdate(s.id);
    });
    line.append(btn);
  }
  const out = [line];
  if (job) {
    let text = job.text;
    if (job.phase === 'downloading' && job.total) text = `${job.text} ${Math.floor((job.received / job.total) * 100)}%`;
    if (job.phase === 'launched') text = `설치 프로그램을 실행했습니다. 설치가 끝나면 ${s.name} 위젯이 나타납니다.`;
    if (job.phase === 'error') text = job.message;
    out.push(el('p', { className: `hint${job.phase === 'error' ? ' err' : ''}` }, text));
    if (job.phase === 'downloading' && job.total) out.push(el('progress', { max: job.total, value: job.received, className: 'update-progress' }));
  } else if (s.status === 'needs-engine') {
    out.push(el('p', { className: 'hint' }, `${s.name} 위젯에는 Desk Widgets ${s.engineMin || '새 버전'} 이상이 필요합니다. 엔진을 먼저 업데이트하세요.`));
  }
  return out;
}

function renderUpdates(u) {
  const list = $('updateList');
  if (!u) return;
  const shown = u.checked ? u.items.filter((i) => i.status !== 'unknown' || i.kind === 'engine') : [];
  list.replaceChildren(...shown.map(updateRow));
  $('checkUpdates').disabled = u.checking;
  const pending = u.items.filter((i) => i.status === 'available' || i.status === 'needs-engine').length;
  let info = '';
  if (u.checking) info = '확인 중...';
  else if (u.error) info = u.error;
  else if (u.checked) info = pending ? `업데이트 ${pending}개` : '모두 최신 버전입니다.';
  else info = '아직 확인하지 않았습니다.';
  if (!u.checking && u.lastCheck) info += ` (마지막 확인 ${formatTime(u.lastCheck)})`;
  setStatus($('updateInfo'), info.trim(), u.error ? 'err' : '');
  $('updateInfo').classList.add('hint');
}

function fillEngine(e) {
  $('notifyUntilAck').checked = !e.notifyDurationSec;
  $('notifyTimed').checked = e.notifyDurationSec > 0;
  $('notifyDurationSec').value = e.notifyDurationSec || 10;
  $('notifyDurationSec').max = e.limits.MAX_NOTIFY_SEC;
  $('notifyMaxVisible').value = e.notifyMaxVisible;
  $('notifyMaxVisible').max = e.limits.MAX_NOTIFY_VISIBLE;
  $('pauseWhenIdle').checked = e.idleMinutes > 0;
  $('idleMinutes').value = e.idleMinutes || 5;
  $('idleMinutes').max = e.limits.MAX_IDLE_MINUTES;
  $('idleMinutes').disabled = !$('pauseWhenIdle').checked;
  $('desktopMode').value = e.desktopMode || 'anchor';
  $('launchAtStartup').checked = e.launchAtStartup;
  $('updateCheck').checked = e.updateCheck !== false;
}

function readEngine() {
  return {
    notifyDurationSec: $('notifyTimed').checked ? Number($('notifyDurationSec').value) || 10 : 0,
    notifyMaxVisible: Number($('notifyMaxVisible').value),
    // 0 disables idle detection; the minutes are kept in the field for when it is re-enabled.
    idleMinutes: $('pauseWhenIdle').checked ? Number($('idleMinutes').value) || 5 : 0,
    desktopMode: $('desktopMode').value,
    launchAtStartup: $('launchAtStartup').checked,
    updateCheck: $('updateCheck').checked,
  };
}

// The manager presents only sync decisions. Reading and writing records stays in the engine.
const SYNC_I18N = {
  ko: {
    tabs: '설정 항목', mainTab: '위젯·일반 설정', syncTab: '동기화', title: '개인 클라우드 동기화',
    disabled: '꺼짐', ready: '최신', checking: '확인 중', pending: '확인할 항목', error: '오류',
    description: 'OneDrive·Google Drive·Dropbox 등의 PC 프로그램이 동기화하는 폴더를 고르세요. Desk Widgets는 이 폴더의 파일만 읽고 씁니다.',
    privacy: '동기화할 데이터는 선택한 폴더에 일반 파일로 저장됩니다. 비밀번호·토큰은 동기화하지 않습니다.',
    businessWarning: '두레이·메일 데이터에는 업무 제목과 메일 주소가 포함될 수 있습니다. 회사 정책을 확인했나요?',
    folder: '동기화 폴더', pick: '폴더 고르기…', device: '이 PC 이름',
    driveRoot: '드라이브 맨 위는 동기화 폴더로 고를 수 없습니다. 그 안의 폴더를 고르거나, 아래 버튼으로 "Desk Widgets Sync" 폴더를 만들어 쓰세요.',
    createFolder: '폴더 만들어 쓰기', folderCreated: '폴더를 만들었습니다. "연결 내용 비교"를 눌러 계속하세요.',
    widgets: '연결 후 동기화할 위젯 데이터', unavailable: '이 위젯 버전은 동기화를 지원하지 않습니다.',
    localStorageHint: '동기화 폴더가 연결되지 않았습니다. 체크 표시는 연결 후 주고받을 대상입니다. 위젯 데이터는 연결과 관계없이 항상 이 PC에 저장됩니다.',
    sharedStorageHint: '위젯 데이터는 이 PC에 저장되고, 엔진이 체크한 데이터의 변경만 동기화 폴더로 주고받습니다. 위젯의 저장 위치는 바뀌지 않습니다.',
    alwaysConfirm: '받아오기 전 항상 확인', connect: '연결 내용 비교', changeFolder: '폴더 변경 내용 비교',
    interval: '자동 확인 주기', minutes: '분마다', everyMinutes: '분마다 확인', lastCheck: '마지막 확인', nextCheck: '다음 확인',
    checkingNow: '확인 중…', watching: '폴더 변경 감시 켜짐', polling: '폴더 감시를 쓸 수 없어 주기 확인만 함(네트워크 폴더 등)',
    autoOff: '자동 확인 꺼짐(연결 안 됨 또는 자리 비움)',
    saveChoices: '설정 저장', syncNow: '지금 동기화', disconnect: '동기화 끄기',
    disconnectAsk: '이 PC의 동기화를 끌까요? 이 PC의 위젯 데이터와 클라우드 폴더는 그대로 둡니다.',
    lastSync: '마지막 동기화', never: '아직 없음', items: '항목',
    compare: '적용 전 비교', local: '이 PC', remote: '다른 PC',
    choose: '사용할 값', keepLocal: '이 PC 값', useRemote: '다른 PC 값', keepBoth: '둘 다 남기기',
    noValue: '(없음)', noChanges: '적용할 변경이 없습니다.', apply: '선택 적용', cancelCompare: '취소',
    bulk: '충돌 한꺼번에', bulkGroup: '이 위젯의 충돌', allLocal: '모두 이 PC 값', allRemote: '모두 다른 PC 값',
    allNewest: '모두 최신 값(수정 시각 기준)', bulkHint: '한꺼번에 고른 뒤에도 항목마다 바꿀 수 있습니다. 수정 시각이 없는 항목은 그 PC가 변경을 처음 확인한 시각으로 비교합니다.',
    conflictCount: '충돌',
    chooseAll: '각 충돌에서 사용할 값을 선택하세요.', folderRequired: '동기화 폴더를 골라 주세요.',
    saved: '저장했습니다.', connected: '연결했습니다.', synced: '동기화를 확인했습니다.', disconnected: '동기화를 껐습니다.',
    import: '받아오기', upload: '올리기', conflict: '충돌', delete: '삭제', overwrite: '덮어쓰기',
    reconnectWarning: '오랫동안 동기화하지 않았거나 동기화 폴더를 바꾸려 합니다. 이전 삭제 항목이 다시 나타나거나 다른 폴더의 데이터가 들어올 수 있으므로 비교 내용을 확인하세요.',
    'stale-device': '이 PC가 오랫동안 동기화되지 않았습니다. 이전에 삭제한 항목이 다시 나타날 수 있으니 변경 내용을 확인하세요.',
    'folder-changed': '동기화 폴더가 바뀌었습니다. 새 폴더의 데이터를 적용하기 전에 변경 내용을 확인하세요.',
    reconnectAck: '위험을 확인했고 표시된 변경에 동의합니다.', reconnectRequired: '변경 위험을 확인해 주세요.',
    undoTitle: '최근 선택 되돌리기', undoHelp: '비교 화면에서 버린 값은 30일 동안 이 PC에서 되살릴 수 있습니다.',
    undoEmpty: '되돌릴 항목이 없습니다.', undoButton: '되살리기', undoExpiry: '기한',
    undoConfirm: '이 항목을 되살릴까요? 현재 값과 충돌할 수 있습니다.', undone: '항목을 되살렸습니다.',
  },
  en: {
    tabs: 'Settings sections', mainTab: 'Widgets & settings', syncTab: 'Sync', title: 'Personal cloud sync',
    disabled: 'Off', ready: 'Up to date', checking: 'Checking', pending: 'Needs review', error: 'Error',
    description: 'Choose a folder synchronized by OneDrive, Google Drive, Dropbox, or another desktop app. Desk Widgets only reads and writes files in that folder.',
    privacy: 'Selected data is stored as ordinary files in the chosen folder. Passwords and tokens are excluded.',
    businessWarning: 'Dooray and Mail data may include work titles and email addresses. Have you checked your company policy?',
    folder: 'Sync folder', pick: 'Choose folder…', device: 'This PC name',
    driveRoot: 'A drive root cannot be the sync folder. Choose a folder inside it, or use the button below to create and use "Desk Widgets Sync".',
    createFolder: 'Create folder', folderCreated: 'Folder created. Press "Review connection" to continue.',
    widgets: 'Widget data to sync after connecting', unavailable: 'This widget version does not support sync.',
    localStorageHint: 'No sync folder is connected. The checkboxes select what is exchanged after connecting. Widget data always stays on this PC.',
    sharedStorageHint: 'Widget data stays on this PC; the engine exchanges changes of the checked data through the sync folder. Where widgets store data does not change.',
    alwaysConfirm: 'Confirm every download', connect: 'Review connection', changeFolder: 'Review folder change',
    interval: 'Check every', minutes: 'min', everyMinutes: 'min interval', lastCheck: 'Last check', nextCheck: 'Next check',
    checkingNow: 'Checking…', watching: 'Folder changes are watched', polling: 'Folder cannot be watched; checking on the interval only (network folder etc.)',
    autoOff: 'Automatic checks off (not connected or away)',
    saveChoices: 'Save options', syncNow: 'Sync now', disconnect: 'Turn sync off',
    disconnectAsk: 'Turn off sync on this PC? Local widget data and the cloud folder will remain.',
    lastSync: 'Last sync', never: 'Not yet', items: 'items',
    compare: 'Review before applying', local: 'This PC', remote: 'Other PC',
    choose: 'Value to use', keepLocal: 'Keep this PC', useRemote: 'Use other PC', keepBoth: 'Keep both',
    noValue: '(none)', noChanges: 'No changes to apply.', apply: 'Apply choices', cancelCompare: 'Cancel',
    bulk: 'All conflicts', bulkGroup: 'Conflicts of this widget', allLocal: 'All this PC', allRemote: 'All other PC',
    allNewest: 'All newest (by edit time)', bulkHint: 'You can still change each item afterwards. Items without an edit time compare when their PC first saw the change.',
    conflictCount: 'conflicts',
    chooseAll: 'Choose a value for each conflict.', folderRequired: 'Choose a sync folder.',
    saved: 'Saved.', connected: 'Connected.', synced: 'Sync checked.', disconnected: 'Sync turned off.',
    import: 'Download', upload: 'Upload', conflict: 'Conflict', delete: 'Delete', overwrite: 'Overwrite',
    reconnectWarning: 'This PC has not synced for a long time or you are changing folders. Deleted items may reappear or data from another folder may arrive. Review the changes carefully.',
    'stale-device': 'This PC has not synced for a long time. Previously deleted items may reappear. Review the changes.',
    'folder-changed': 'The sync folder changed. Review the changes before applying data from the new folder.',
    reconnectAck: 'I understand the risk and accept the shown changes.', reconnectRequired: 'Acknowledge the change risk first.',
    undoTitle: 'Undo recent choices', undoHelp: 'Discarded values can be restored on this PC for 30 days.',
    undoEmpty: 'No values can be restored.', undoButton: 'Restore', undoExpiry: 'Expires',
    undoConfirm: 'Restore this value? It may conflict with the current value.', undone: 'Value restored.',
  },
};
const syncLocale = /^en(?:-|$)/i.test(navigator.language) ? 'en' : 'ko';
const syncT = (key) => SYNC_I18N[syncLocale][key] || key;
const syncUi = { state: null, pending: null, connecting: false, previewingConnect: false, busy: false };

function syncMessage(message, kind = '') {
  setStatus($('syncMessage'), message, kind);
}

function switchManagerTab(sync) {
  $('mainPane').hidden = sync;
  $('syncPane').hidden = !sync;
  $('mainTab').classList.toggle('active', !sync);
  $('syncTab').classList.toggle('active', sync);
  $('mainTab').setAttribute('aria-selected', String(!sync));
  $('syncTab').setAttribute('aria-selected', String(sync));
  $('save').hidden = sync;
}

function syncButton(id, label, action, className = 'secondary') {
  const button = el('button', { id, type: 'button', className }, label);
  button.addEventListener('click', action);
  return button;
}

function buildSyncPane() {
  $('managerTabs').setAttribute('aria-label', syncT('tabs'));
  $('mainTab').textContent = syncT('mainTab');
  $('syncTab').textContent = syncT('syncTab');
  $('mainTab').addEventListener('click', () => switchManagerTab(false));
  $('syncTab').addEventListener('click', async () => {
    switchManagerTab(true);
    await refreshSync();
  });

  const pane = $('syncPane');
  const settings = el('fieldset');
  settings.append(el('legend', {}, syncT('title')));
  settings.append(el('p', { className: 'hint' }, syncT('description')));
  settings.append(el('p', { className: 'hint' }, syncT('privacy')));
  settings.append(el('p', { id: 'syncStatus', className: 'status', role: 'status' }));
  settings.append(el('p', { id: 'syncStorageHint', className: 'hint' }));
  const folderLabel = el('label', { htmlFor: 'syncFolder' }, syncT('folder'));
  const folderRow = el('div', { className: 'sync-folder-row' });
  folderRow.append(el('input', { id: 'syncFolder', type: 'text', spellcheck: false }), syncButton('syncPick', syncT('pick'), pickSyncFolder));
  settings.append(folderLabel, folderRow);
  const rootNotice = el('div', { id: 'syncRootNotice', className: 'sync-root-notice', hidden: true });
  rootNotice.append(el('p', { className: 'hint err' }, syncT('driveRoot')), syncButton('syncCreateFolder', syncT('createFolder'), createSyncFolderInRoot));
  settings.append(rootNotice);
  folderRow.querySelector('input').addEventListener('input', updateSyncRootNotice);
  settings.append(el('label', { htmlFor: 'syncDevice' }, syncT('device')));
  settings.append(el('input', { id: 'syncDevice', type: 'text', maxLength: 80 }));
  settings.append(el('label', {}, syncT('widgets')));
  settings.append(el('div', { id: 'syncWidgetList', className: 'sync-widget-list' }));
  const confirmLabel = el('label', { className: 'check' });
  confirmLabel.append(el('input', { id: 'syncAlwaysConfirm', type: 'checkbox' }), el('span', {}, syncT('alwaysConfirm')));
  settings.append(confirmLabel);
  settings.append(el('label', { htmlFor: 'syncInterval' }, syncT('interval')));
  settings.append(el('select', { id: 'syncInterval' }));
  settings.append(el('p', { id: 'syncSchedule', className: 'hint', role: 'status' }));
  const actions = el('div', { className: 'sync-actions' });
  actions.append(
    syncButton('syncConnect', syncT('connect'), previewSyncConnection, 'primary'),
    syncButton('syncSaveOptions', syncT('saveChoices'), saveSyncOptions),
    syncButton('syncNow', syncT('syncNow'), runSyncNow),
    syncButton('syncDisable', syncT('disconnect'), turnSyncOff),
  );
  settings.append(actions, el('p', { id: 'syncMessage', className: 'status', role: 'status' }));
  pane.append(settings);

  const compare = el('fieldset', { id: 'syncCompare', hidden: true });
  compare.append(el('legend', {}, syncT('compare')));
  compare.append(el('p', { id: 'syncCompareSummary', className: 'hint' }));
  compare.append(el('p', { id: 'syncReconnectWarning', className: 'hint err', hidden: true }));
  compare.append(el('div', { id: 'syncBulk', className: 'sync-bulk', hidden: true }));
  compare.append(el('div', { id: 'syncCompareList', className: 'sync-compare-list' }));
  const reconnectLabel = el('label', { id: 'syncReconnectLabel', className: 'check', hidden: true });
  reconnectLabel.append(el('input', { id: 'syncReconnectAck', type: 'checkbox' }), el('span', {}, syncT('reconnectAck')));
  compare.append(reconnectLabel);
  const compareActions = el('div', { className: 'sync-actions' });
  compareActions.append(syncButton('syncApply', syncT('apply'), applySyncChoices, 'primary'), syncButton('syncCancelCompare', syncT('cancelCompare'), cancelSyncCompare));
  compare.append(compareActions);
  pane.append(compare);

  const undo = el('fieldset');
  undo.append(el('legend', {}, syncT('undoTitle')));
  undo.append(el('p', { className: 'hint' }, syncT('undoHelp')));
  undo.append(el('div', { id: 'syncUndoList', className: 'widget-list' }));
  pane.append(undo);
}

function syncFormValues() {
  return {
    folder: $('syncFolder').value.trim(),
    deviceName: $('syncDevice').value.trim(),
    widgets: Object.fromEntries([...$('syncWidgetList').querySelectorAll('input[data-sync-widget]')].map((box) => [box.dataset.syncWidget, box.checked])),
    alwaysConfirm: $('syncAlwaysConfirm').checked,
    intervalMinutes: Number($('syncInterval').value) || undefined,
  };
}

/** Interval, last and next check, and watching or polling only: updated live from the engine's state. */
function renderSyncSchedule(state) {
  const s = state.schedule || {};
  const parts = [];
  if (!state.enabled || !s.nextCheck) parts.push(syncT('autoOff'));
  else {
    parts.push(`${s.intervalMinutes}${syncT('everyMinutes')}`);
    parts.push(s.checking ? syncT('checkingNow') : `${syncT('lastCheck')}: ${s.lastCheck ? formatTime(s.lastCheck) : syncT('never')}`);
    parts.push(`${syncT('nextCheck')}: ${formatTime(s.nextCheck)}`);
    if (s.watch === 'watching' || s.watch === 'polling') parts.push(syncT(s.watch));
  }
  $('syncSchedule').textContent = parts.join(' · ');
}

function renderSyncWidgets(items = []) {
  const rows = items.map((item) => {
    const label = el('label', { className: 'check' });
    const box = el('input', { type: 'checkbox', checked: Boolean(item.enabled), disabled: item.available === false });
    box.dataset.syncWidget = item.id;
    if (item.id === 'dooray' || item.id === 'mail') {
      box.addEventListener('change', () => {
        if (box.checked && !window.confirm(syncT('businessWarning'))) box.checked = false;
      });
    }
    label.append(box, el('span', {}, item.name || item.id));
    if (item.available === false) label.title = item.reason || syncT('unavailable');
    return label;
  });
  $('syncWidgetList').replaceChildren(...rows);
}

function renderSyncState(state) {
  if (!state) return;
  syncUi.state = state;
  if (!syncUi.previewingConnect) {
    $('syncFolder').value = state.folder || '';
    updateSyncRootNotice();
    $('syncDevice').value = state.deviceName || '';
    $('syncAlwaysConfirm').checked = Boolean(state.alwaysConfirm);
    const interval = $('syncInterval');
    if (document.activeElement !== interval) {
      interval.replaceChildren(...(state.intervals || [1, 2, 5, 10, 30]).map((m) => el('option', { value: String(m) }, `${m}${syncT('minutes')}`)));
      interval.value = String(state.intervalMinutes || 2);
    }
    renderSyncWidgets(state.widgets);
  }
  renderSyncSchedule(state);
  const status = state.error || syncT(state.status || (state.enabled ? 'ready' : 'disabled'));
  const last = state.lastSync ? `${syncT('lastSync')}: ${formatTime(state.lastSync)}` : `${syncT('lastSync')}: ${syncT('never')}`;
  $('syncStatus').textContent = `${status} · ${last}`;
  $('syncStatus').className = `status${state.error ? ' err' : ''}`;
  $('syncStorageHint').textContent = [syncT(state.enabled ? 'sharedStorageHint' : 'localStorageHint'), ...(state.notices || [])].join(' ');
  $('syncConnect').textContent = syncT(state.enabled ? 'changeFolder' : 'connect');
  $('syncSaveOptions').hidden = !state.enabled;
  $('syncNow').hidden = !state.enabled;
  $('syncDisable').hidden = !state.enabled;
  if (state.pending && !syncUi.pending && !syncUi.previewingConnect) showSyncCompare(state.pending, false);
}

async function refreshSync() {
  try {
    renderSyncState(await window.engineApi.getSyncState());
    await refreshSyncUndo();
  } catch (error) {
    syncMessage(error.message, 'err');
  }
}

function setSyncBusy(busy) {
  syncUi.busy = busy;
  for (const id of ['syncPick', 'syncCreateFolder', 'syncConnect', 'syncSaveOptions', 'syncNow', 'syncDisable', 'syncApply']) $(id).disabled = busy;
  for (const button of $('syncUndoList').querySelectorAll('button')) button.disabled = busy;
}

async function pickSyncFolder() {
  try {
    const folder = await window.engineApi.pickSyncFolder();
    if (folder) $('syncFolder').value = folder;
    updateSyncRootNotice();
  } catch (error) {
    syncMessage(error.message, 'err');
  }
}

/** True for a drive root such as Y:\ or \\server\share (the engine refuses those as sync folders). */
function isDriveRoot(folder) {
  return /^[A-Za-z]:[\\/]?$/.test(folder) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/.test(folder);
}

function updateSyncRootNotice(force = false) {
  $('syncRootNotice').hidden = !(force === true || isDriveRoot($('syncFolder').value.trim()));
}

async function createSyncFolderInRoot() {
  setSyncBusy(true);
  try {
    const res = await window.engineApi.createSyncFolder($('syncFolder').value.trim());
    if (res?.ok === false) return syncMessage(res.message || syncT('error'), 'err');
    $('syncFolder').value = res.folder;
    updateSyncRootNotice();
    syncMessage(syncT('folderCreated'), 'ok');
  } catch (error) {
    syncMessage(error.message, 'err');
  } finally {
    setSyncBusy(false);
  }
}

function syncResult(res, successText) {
  if (res?.ok === false) {
    syncMessage(res.message || syncT('error'), 'err');
    return false;
  }
  if (res?.state) renderSyncState(res.state);
  syncMessage(successText, 'ok');
  refreshSyncUndo().catch(() => {});
  return true;
}

async function refreshSyncUndo() {
  const result = await window.engineApi.listSyncUndo();
  if (result?.ok === false) return syncMessage(result.message || syncT('error'), 'err');
  const items = Array.isArray(result?.items) ? result.items : [];
  const rows = items.map((item) => {
    const row = el('div', { className: 'widget-row' });
    const head = el('div', { className: 'widget-head' });
    head.append(el('span', { className: 'widget-toggle' }, item.key || item.id));
    const button = syncButton('', syncT('undoButton'), () => undoSyncItem(item), 'secondary small');
    button.disabled = syncUi.busy;
    head.append(button);
    row.append(head);
    if (item.expiresAt) row.append(el('p', { className: 'hint' }, `${syncT('undoExpiry')}: ${formatTime(item.expiresAt)}`));
    return row;
  });
  $('syncUndoList').replaceChildren(...(rows.length ? rows : [el('p', { className: 'hint' }, syncT('undoEmpty'))]));
}

async function undoSyncItem(item) {
  const expiry = item.expiresAt ? `\n${syncT('undoExpiry')}: ${formatTime(item.expiresAt)}` : '';
  if (!window.confirm(`${syncT('undoConfirm')}\n${item.key || item.id}${expiry}`)) return;
  setSyncBusy(true);
  try {
    syncResult(await window.engineApi.undoSync({ id: item.id }), syncT('undone'));
    await refreshSyncUndo();
  } catch (error) {
    syncMessage(error.message, 'err');
  } finally {
    setSyncBusy(false);
  }
}

async function previewSyncConnection() {
  const values = syncFormValues();
  if (!values.folder) return syncMessage(syncT('folderRequired'), 'err');
  setSyncBusy(true);
  syncUi.previewingConnect = true;
  try {
    const res = await window.engineApi.previewSyncConnect(values);
    if (res?.code === 'drive-root') updateSyncRootNotice(true);
    if (res?.ok === false) return syncMessage(res.message || syncT('error'), 'err');
    showSyncCompare(res.pending || res.preview || res, true);
    syncMessage('');
  } catch (error) {
    syncMessage(error.message, 'err');
  } finally {
    syncUi.previewingConnect = false;
    setSyncBusy(false);
  }
}

async function saveSyncOptions() {
  setSyncBusy(true);
  try {
    const result = await window.engineApi.configureSync(syncFormValues());
    if (result?.pending) {
      showSyncCompare(result.pending, true);
      syncMessage('');
    } else syncResult(result, syncT('saved'));
  } catch (error) {
    syncMessage(error.message, 'err');
  } finally {
    setSyncBusy(false);
  }
}

async function runSyncNow() {
  setSyncBusy(true);
  try {
    const res = await window.engineApi.syncNow();
    if (res?.ok === false) syncMessage(res.message || syncT('error'), 'err');
    else if (res?.pending || res?.previewId) showSyncCompare(res.pending || res, false);
    else syncResult(res, syncT('synced'));
  } catch (error) {
    syncMessage(error.message, 'err');
  } finally {
    setSyncBusy(false);
  }
}

async function turnSyncOff() {
  if (!window.confirm(syncT('disconnectAsk'))) return;
  setSyncBusy(true);
  try {
    if (syncResult(await window.engineApi.disableSync(), syncT('disconnected'))) cancelSyncCompare();
  } catch (error) {
    syncMessage(error.message, 'err');
  } finally {
    setSyncBusy(false);
  }
}

function syncValueText(side) {
  if (side == null) return syncT('noValue');
  const value = side.text ?? side.value ?? side;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 12000 ? `${text.slice(0, 12000)}…` : text;
}

function syncSide(label, side) {
  const wrap = el('div', { className: 'sync-side' });
  const time = side?.updatedAt ? ` · ${formatTime(side.updatedAt)}` : '';
  wrap.append(el('strong', {}, `${label}${time}`), el('pre', {}, syncValueText(side)));
  return wrap;
}

function syncChangeRow(change) {
  const row = el('div', { className: 'sync-change' });
  const header = el('div', { className: 'sync-change-header' });
  header.append(el('strong', {}, change.title || change.key), el('span', { className: 'badge' }, syncT(change.kind || 'conflict')));
  row.append(header);
  const sides = el('div', { className: 'sync-sides' });
  sides.append(syncSide(syncT('local'), change.local), syncSide(syncT('remote'), change.remote));
  row.append(sides);
  if (change.kind !== 'conflict') return row;
  const choices = el('label', { className: 'sync-choice' });
  choices.append(el('span', {}, `${syncT('choose')}: `));
  const selector = el('select');
  selector.dataset.syncKey = change.key;
  const defaultChoice = change.kind === 'upload' ? 'local' : change.kind === 'import' ? 'remote' : '';
  selector.append(el('option', { value: '' }, '—'));
  selector.append(el('option', { value: 'local' }, syncT('keepLocal')));
  selector.append(el('option', { value: 'remote' }, syncT('useRemote')));
  if (change.canCopy !== false && !String(change.key).includes('/@settings/')) selector.append(el('option', { value: 'both' }, syncT('keepBoth')));
  selector.value = change.defaultChoice || defaultChoice;
  selector.dataset.syncNewer = change.newer || 'local';
  selector.dataset.syncGroup = change.group || '';
  choices.append(selector);
  row.append(choices);
  return row;
}

/** Buttons that set every conflict (or those of one widget) at once; single choices can be changed afterwards. */
function syncBulkRow(label, group) {
  const row = el('div', { className: 'sync-bulk-row' });
  const pick = (mode) => () => {
    for (const selector of $('syncCompareList').querySelectorAll('select[data-sync-key]')) {
      if (group !== null && selector.dataset.syncGroup !== group) continue;
      selector.value = mode === 'newest' ? selector.dataset.syncNewer : mode;
    }
  };
  const button = (text, mode) => {
    const b = el('button', { type: 'button' }, text);
    b.addEventListener('click', pick(mode));
    return b;
  };
  row.append(el('span', {}, `${label}: `), button(syncT('allLocal'), 'local'), button(syncT('allRemote'), 'remote'), button(syncT('allNewest'), 'newest'));
  return row;
}

function showSyncCompare(preview, connecting) {
  if (!preview?.previewId) return syncMessage(syncT('error'), 'err');
  syncUi.pending = preview;
  syncUi.connecting = connecting;
  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  const risky = Boolean(preview.requiresReconnect);
  $('syncReconnectWarning').hidden = !risky;
  $('syncReconnectWarning').textContent = risky ? syncT(SYNC_I18N[syncLocale][preview.reconnectReason] ? preview.reconnectReason : 'reconnectWarning') : '';
  $('syncReconnectLabel').hidden = !risky;
  $('syncReconnectAck').checked = false;
  const conflicts = changes.filter((change) => change.kind === 'conflict');
  $('syncCompareSummary').textContent = `${changes.length} ${syncT('items')}${conflicts.length ? ` · ${syncT('conflictCount')} ${conflicts.length}` : ''}`;
  // Bulk choices for many conflicts (#108 field test): for all, and per widget when several widgets have some.
  const bulk = $('syncBulk');
  bulk.hidden = conflicts.length < 2;
  bulk.replaceChildren();
  if (conflicts.length >= 2) bulk.append(syncBulkRow(syncT('bulk'), null), el('p', { className: 'hint' }, syncT('bulkHint')));
  const groups = [...new Set(changes.map((change) => change.group || ''))];
  const rows = [];
  for (const group of groups) {
    const members = changes.filter((change) => (change.group || '') === group);
    const groupConflicts = members.filter((change) => change.kind === 'conflict').length;
    if (groups.length > 1) {
      const head = el('div', { className: 'sync-group' });
      head.append(el('strong', {}, members[0].groupName || group));
      if (groupConflicts >= 2) head.append(syncBulkRow(syncT('bulkGroup'), group));
      rows.push(head);
    }
    rows.push(...members.map(syncChangeRow));
  }
  $('syncCompareList').replaceChildren(...(changes.length ? rows : [el('p', { className: 'hint' }, syncT('noChanges'))]));
  $('syncCompare').hidden = false;
  $('syncCompare').scrollIntoView({ block: 'nearest' });
}

function cancelSyncCompare() {
  syncUi.pending = null;
  syncUi.connecting = false;
  $('syncCompare').hidden = true;
  $('syncCompareList').replaceChildren();
  $('syncReconnectAck').checked = false;
}

async function applySyncChoices() {
  if (!syncUi.pending) return;
  const selectors = [...$('syncCompareList').querySelectorAll('select[data-sync-key]')];
  if (selectors.some((selector) => !selector.value)) return syncMessage(syncT('chooseAll'), 'err');
  if (syncUi.pending.requiresReconnect && !$('syncReconnectAck').checked) return syncMessage(syncT('reconnectRequired'), 'err');
  const decision = {
    previewId: syncUi.pending.previewId,
    resolutions: Object.fromEntries(selectors.map((selector) => [selector.dataset.syncKey, selector.value])),
    acknowledgeReconnect: Boolean(syncUi.pending.requiresReconnect && $('syncReconnectAck').checked),
  };
  setSyncBusy(true);
  try {
    const res = syncUi.connecting ? await window.engineApi.applySyncConnect(decision) : await window.engineApi.resolveSync(decision);
    if (syncResult(res, syncT(syncUi.connecting ? 'connected' : 'synced'))) cancelSyncCompare();
  } catch (error) {
    syncMessage(error.message, 'err');
  } finally {
    setSyncBusy(false);
  }
}

async function init() {
  buildSyncPane();
  const state = await window.engineApi.get();
  $('version').textContent = state.version ? `v${state.version}` : '';
  fillEngine(state.engine);
  render(state);
  if (state.picker?.firstRun) openPicker();
  await refreshSync();
}

window.engineApi.onChanged(render);
window.engineApi.onUpdates(renderUpdates);
window.engineApi.onPicker(renderPicker);
$('pickerOpen').addEventListener('click', openPicker);
$('pickerReload').addEventListener('click', async () => renderPicker(await window.engineApi.pickerLoad()));
$('pickerInstall').addEventListener('click', async () => {
  $('pickerInstall').disabled = true;
  renderPicker(await window.engineApi.pickerStart([...picked]));
});
$('pickerFile').addEventListener('click', () => window.engineApi.pickerOpenFile());
$('pickerSite').addEventListener('click', () => window.engineApi.pickerOpenSite());
window.engineApi.onSyncChanged(renderSyncState);
$('checkUpdates').addEventListener('click', async () => {
  $('checkUpdates').disabled = true;
  renderUpdates(await window.engineApi.checkUpdates());
});
$('notifyDurationSec').addEventListener('focus', () => {
  $('notifyTimed').checked = true;
});
$('pauseWhenIdle').addEventListener('change', () => {
  $('idleMinutes').disabled = !$('pauseWhenIdle').checked;
});
$('openFolder').addEventListener('click', async () => {
  const problem = await window.engineApi.openWidgetsFolder();
  if (problem) setStatus($('saveResult'), problem, 'err');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  $('save').disabled = true;
  const res = await window.engineApi.save(readEngine());
  $('save').disabled = false;
  setStatus($('saveResult'), res.ok ? '저장했습니다.' : res.message, res.ok ? 'ok' : 'err');
});

$('cancel').addEventListener('click', () => window.engineApi.close());

init();
