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
}

function readEngine() {
  return {
    notifyDurationSec: $('notifyTimed').checked ? Number($('notifyDurationSec').value) || 10 : 0,
    notifyMaxVisible: Number($('notifyMaxVisible').value),
    // 0 disables idle detection; the minutes are kept in the field for when it is re-enabled.
    idleMinutes: $('pauseWhenIdle').checked ? Number($('idleMinutes').value) || 5 : 0,
    desktopMode: $('desktopMode').value,
    launchAtStartup: $('launchAtStartup').checked,
  };
}

async function init() {
  const state = await window.engineApi.get();
  $('version').textContent = state.version ? `v${state.version}` : '';
  fillEngine(state.engine);
  render(state);
}

window.engineApi.onChanged(render);
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
