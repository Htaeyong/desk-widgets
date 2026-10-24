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
}

// ---- In-app updates (#104) ----

const UPDATE_STATUS = {
  available: ['새 버전', 'ok'],
  'needs-engine': ['엔진을 먼저 업데이트', 'err'],
  current: ['최신', ''],
  unknown: ['정보 없음', ''],
};

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateRow(item) {
  const row = el('div', { className: 'widget-row' });
  const head = el('div', { className: 'widget-head' });
  const versions = item.latest && item.latest !== item.current ? `v${item.current || '?'} → v${item.latest}` : item.current ? `v${item.current}` : '';
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
  return row;
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

async function init() {
  const state = await window.engineApi.get();
  $('version').textContent = state.version ? `v${state.version}` : '';
  fillEngine(state.engine);
  render(state);
}

window.engineApi.onChanged(render);
window.engineApi.onUpdates(renderUpdates);
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
