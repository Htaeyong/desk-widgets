// Top bar of the theme preview window. The theme itself is a separate view placed below it.
const $ = (id) => document.getElementById(id);

function show(state) {
  if (!state) return;
  const t = state.theme;
  $('name').textContent = t.name;
  $('kind').textContent = t.kind;
  $('kind').hidden = !t.kind;
  $('pos').textContent = `${state.index + 1} / ${state.total}`;
  $('desc').textContent = [t.description, t.author && `· ${t.author}`].filter(Boolean).join(' ');
  $('desc').title = $('desc').textContent;
  const inUse = state.current === t.id;
  $('apply').disabled = inUse;
  $('apply').textContent = inUse ? '✓ 사용 중인 테마' : '이 테마로 바꾸기';
  document.title = `테마 미리보기 — ${t.name}`;
}

$('prev').addEventListener('click', () => window.previewApi.step(-1));
$('next').addEventListener('click', () => window.previewApi.step(1));
$('apply').addEventListener('click', () => window.previewApi.apply());
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') window.previewApi.step(-1);
  else if (e.key === 'ArrowRight') window.previewApi.step(1);
  else if (e.key === 'Escape') window.previewApi.close();
});

window.previewApi.onState(show);
window.previewApi.getState().then(show);
