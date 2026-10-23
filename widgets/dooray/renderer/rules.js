// Condition alert manager: list, edit, delete and test rules.
const $ = (id) => document.getElementById(id);
const api = window.rulesApi;

let data = { rules: [], states: {}, projects: [] };
let selectedId = null; // rule id, or 'new' for an unsaved rule
let draftProjects = new Set();
// The form is not refilled while the user is editing it.
let dirty = false;

const DEFAULT_RULE = {
  name: '',
  enabled: true,
  projectIds: [],
  minCount: 1,
  period: 'yesterday',
  tag: '',
  time: '09:30',
  days: 'weekdays',
  repeatMinutes: 60,
};

function el(tag, props = {}, text) {
  const node = Object.assign(document.createElement(tag), props);
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
  clearTimeout(setStatus.timer);
  if (text) setStatus.timer = setTimeout(() => setStatus(''), 5000);
}

const projectName = (id) => data.projects.find((p) => p.id === id)?.name || '(알 수 없는 프로젝트)';
const selectedRule = () => data.rules.find((r) => r.id === selectedId) || null;

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- list ----------

function renderList() {
  const list = $('ruleList');
  list.replaceChildren(
    ...data.rules.map((r) => {
      const st = data.states[r.id];
      const li = el('li', { className: `cat-item rule-item ${r.id === selectedId ? 'selected' : ''} ${r.enabled ? '' : 'off'}` });
      const stateText = !st ? '대기' : st.missing.length ? `미충족 ${st.missing.length}` : '충족';
      li.append(
        el('span', { className: 'name', title: r.name }, r.name),
        el('span', { className: `state ${!st ? '' : st.missing.length ? 'err' : 'ok'}`, title: st ? `${formatTime(st.lastCheckedAt)} 확인` : '아직 확인 전' }, stateText)
      );
      li.addEventListener('click', () => select(r.id));
      return li;
    })
  );
  if (!data.rules.length) list.append(el('li', { className: 'hint' }, '아직 규칙이 없습니다.'));
}

// ---------- form ----------

function renderProjects() {
  const filter = $('projectFilter').value.trim().toLowerCase();
  const items = data.projects
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    .filter((p) => !filter || p.name.toLowerCase().includes(filter));
  $('projects').replaceChildren(
    ...items.map((p) => {
      const label = el('label', { title: p.description || p.name });
      const box = el('input', { type: 'checkbox', value: p.id, checked: draftProjects.has(p.id) });
      box.addEventListener('change', () => {
        if (box.checked) draftProjects.add(p.id);
        else draftProjects.delete(p.id);
        dirty = true;
        $('projectCount').textContent = `${draftProjects.size}개 선택`;
      });
      label.append(box, el('span', {}, p.name));
      return label;
    })
  );
  if (!items.length) $('projects').append(el('p', { className: 'hint' }, data.projects.length ? '일치하는 프로젝트가 없습니다.' : '프로젝트를 불러오지 못했습니다. 연결 설정을 확인해 주세요.'));
  $('projectCount').textContent = `${draftProjects.size}개 선택`;
}

function fillForm(rule) {
  $('enabled').checked = rule.enabled;
  $('name').value = rule.name;
  draftProjects = new Set(rule.projectIds);
  $('period').value = rule.period;
  $('minCount').value = rule.minCount;
  $('tag').value = rule.tag;
  $('time').value = rule.time;
  $('days').value = rule.days;
  $('repeatMinutes').value = String(rule.repeatMinutes);
  $('remove').hidden = selectedId === 'new';
  $('runNow').disabled = selectedId === 'new';
  renderProjects();
  dirty = false;
}

function readForm() {
  return {
    id: selectedId === 'new' ? undefined : selectedId,
    enabled: $('enabled').checked,
    name: $('name').value,
    projectIds: [...draftProjects],
    period: $('period').value,
    minCount: Number($('minCount').value),
    tag: $('tag').value,
    time: $('time').value,
    days: $('days').value,
    repeatMinutes: Number($('repeatMinutes').value),
  };
}

function renderResult(state, title) {
  $('resultTitle').textContent = title;
  if (!state) {
    $('resultInfo').textContent = selectedId === 'new' ? '저장한 뒤 "지금 확인"으로 결과를 볼 수 있습니다.' : '아직 확인 전입니다. 확인 시각이 지나면 자동으로 확인합니다.';
    $('resultList').replaceChildren();
    return;
  }
  const missing = new Set(state.missing.map((m) => m.id));
  $('resultInfo').textContent = `${formatTime(state.lastCheckedAt)} 확인 · 기간 ${state.period.label} · ${
    state.missing.length ? `${state.missing.length}개 프로젝트 미충족` : '모두 충족'
  }`;
  $('resultList').replaceChildren(
    ...Object.entries(state.counts).map(([id, count]) => {
      const miss = missing.has(id);
      const li = el('li', { className: `task-row ${miss ? 'miss' : 'ok'}` });
      li.append(el('span', { className: 'mark' }, miss ? '✕' : '✓'), el('span', { className: 'body' }, projectName(id)), el('span', { className: 'count' }, `${count}건`));
      return li;
    })
  );
}

function renderDetail() {
  const rule = selectedId === 'new' ? null : selectedRule();
  $('empty').hidden = Boolean(selectedId);
  $('form').hidden = !selectedId;
  if (!selectedId) return;
  if (!dirty) fillForm(rule || { ...DEFAULT_RULE });
  renderResult(rule ? data.states[rule.id] : null, '마지막 확인');
}

function render() {
  if (selectedId && selectedId !== 'new' && !selectedRule()) selectedId = null;
  renderList();
  renderDetail();
}

async function reload() {
  const res = await api.get();
  if (!res.ok) return setStatus(res.message, 'err');
  data = res.result;
  render();
}

function select(id) {
  if (dirty && id !== selectedId && !confirm('저장하지 않은 변경 사항이 있습니다. 버리고 이동할까요?')) return;
  selectedId = id;
  dirty = false;
  render();
}

// ---------- events ----------

$('addRule').addEventListener('click', () => select('new'));
$('form').addEventListener('input', () => (dirty = true));
$('projectFilter').addEventListener('input', renderProjects);
$('selectShown').addEventListener('click', () => {
  $('projects')
    .querySelectorAll('input')
    .forEach((box) => draftProjects.add(box.value));
  dirty = true;
  renderProjects();
});
$('clearProjects').addEventListener('click', () => {
  draftProjects.clear();
  dirty = true;
  renderProjects();
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await api.save(readForm());
  if (!res.ok) return setStatus(res.message, 'err');
  selectedId = res.result.id;
  dirty = false;
  setStatus(`'${res.result.name}' 규칙을 저장했습니다.`, 'ok');
  await reload();
});

$('runNow').addEventListener('click', async () => {
  if (dirty) return setStatus('먼저 저장해 주세요.', 'err');
  $('runNow').disabled = true;
  setStatus('확인 중…');
  const res = await api.run(selectedId);
  $('runNow').disabled = false;
  if (!res.ok) return setStatus(res.message, 'err');
  renderResult(res.result, '지금 확인 결과 (예약 확인 기록에는 남지 않음)');
  setStatus(res.result.missing.length ? '조건을 충족하지 않은 프로젝트가 있어 알림을 띄웠습니다.' : '모든 프로젝트가 조건을 충족합니다.', res.result.missing.length ? 'err' : 'ok');
});

$('remove').addEventListener('click', async () => {
  const rule = selectedRule();
  if (!rule || !confirm(`'${rule.name}' 규칙을 삭제할까요?`)) return;
  const res = await api.remove(rule.id);
  if (!res.ok) return setStatus(res.message, 'err');
  selectedId = null;
  dirty = false;
  setStatus(`'${rule.name}' 규칙을 삭제했습니다.`, 'ok');
  await reload();
});

api.onChanged(async () => {
  const res = await api.get();
  if (!res.ok) return;
  data = res.result;
  renderList();
  if (!dirty) renderDetail();
});

reload();
