// One notification card. Data comes from the main process; text is set with textContent only.
const $ = (id) => document.getElementById(id);
const api = window.notificationApi;

const LABEL = {
  mention: '나를 멘션',
  comment: '새 댓글',
  assigned: '나에게 배정',
  created: '새 업무',
  status: '상태 변경',
  closed: '완료됨',
  overdue: '마감 지남',
  summary: '업무 변경',
  rule: '조건 알림',
};

function dueText(task) {
  if (!task.deadline) return '';
  const day = new Date(new Date(task.deadline).getTime() - 1);
  return `마감 ${day.getMonth() + 1}/${day.getDate()}`;
}

// Condition alert: which projects did not meet the rule in the period.
function renderRule(event) {
  $('card').dataset.type = 'rule';
  $('badge').textContent = LABEL.rule;
  $('project').textContent = event.rule.name;
  const names = event.missing.map((m) => m.name);
  $('subject').textContent = `${event.period.label} 등록 없음: ${names.join(', ')}`;
  $('subject').title = `${names.join(', ')} — 누르면 첫 번째 프로젝트를 두레이에서 엽니다`;
  const cond = event.rule.tag ? `'${event.rule.tag}' 태그 ${event.rule.minCount}건 이상` : `${event.rule.minCount}건 이상`;
  $('meta').textContent = `기준: ${cond} · ${event.missing.length}개 프로젝트 미충족`;
}

function renderEvent(event) {
  if (event.type === 'rule') return renderRule(event);
  const t = event.task;
  $('card').dataset.type = event.type;
  $('badge').textContent = LABEL[event.type] || '알림';
  $('project').textContent = t.projectName;
  $('subject').textContent = t.subject;

  if (event.comment) {
    // Comment/mention: show who wrote what instead of status details.
    const more = event.comment.count > 1 ? ` (외 ${event.comment.count - 1}개)` : '';
    $('badge').textContent = event.type === 'comment' && event.comment.count > 1 ? `새 댓글 ${event.comment.count}개` : LABEL[event.type];
    $('meta').textContent = `${event.comment.author}: ${event.comment.text || '(내용 없음)'}${event.type === 'mention' ? more : ''}`;
    $('meta').title = `${t.key} · ${event.comment.author}: ${event.comment.text}`;
    return;
  }

  const parts = [t.key];
  if (event.type === 'status' || event.type === 'closed') parts.push(event.from ? `${event.from} → ${t.workflowName}` : t.workflowName);
  else parts.push(t.workflowName);
  if (event.type === 'overdue' || event.type === 'assigned') parts.push(dueText(t));
  const people = t.assignees.map((a) => a.name).join(', ');
  if (people && event.type !== 'assigned') parts.push(people);
  $('meta').textContent = parts.filter(Boolean).join(' · ');
}

function renderSummary(card) {
  $('card').dataset.type = 'summary';
  $('badge').textContent = LABEL.summary;
  $('project').textContent = `${card.count}건`;
  $('subject').textContent = `업무 변경이 ${card.count}건 있습니다.`;
  $('meta').textContent = card.samples.join(' · ');
  $('open').textContent = '위젯 보기';
  $('subject').title = '위젯 열기';
}

// ---------- generic card (engine API 1.2) ----------
// Sent by any widget: its name, a title, optional body, icon and buttons. The main process has
// already checked every field; text still goes through textContent only.
const ICON_GLYPH = {
  bell: '🔔',
  alarm: '⏰',
  timer: '⏱️',
  clock: '🕒',
  info: 'ℹ️',
  warning: '⚠️',
  error: '⛔',
  check: '✅',
  calendar: '📅',
  mail: '✉️',
  star: '⭐',
};

function renderIcon(icon) {
  const slot = $('icon');
  if (!icon) return;
  if (icon.src) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = icon.src;
    slot.replaceChildren(img);
  } else {
    slot.textContent = icon.name ? ICON_GLYPH[icon.name] || '' : icon.emoji || '';
  }
  slot.hidden = false;
}

function showActionError(message) {
  $('actionError').textContent = message || '';
  $('actionError').hidden = !message;
  $('meta').hidden = Boolean(message); // the card has a fixed height: the error takes the body's line
}

function renderCard(card) {
  const event = card.event;
  $('card').dataset.type = 'card';
  renderIcon(event.icon);
  $('badge').textContent = card.widgetName || '알림';
  $('project').textContent = '';
  $('subject').textContent = event.title;
  $('subject').title = event.title;
  $('subject').classList.add('plain');
  $('meta').textContent = event.body;
  $('meta').title = event.body;
  $('open').hidden = true;
  if (event.actions.length) {
    $('actions').replaceChildren(
      ...event.actions.map((action) => {
        const btn = el('button', 'btn action', action.label);
        btn.type = 'button';
        btn.title = action.label;
        btn.addEventListener('click', async () => {
          const res = await api.action(action.id);
          showActionError(res.ok ? '' : res.message);
        });
        return btn;
      })
    );
    $('actions').hidden = false;
    // The widget's first button is the main one; 확인 stays as the plain way to close.
    $('actions').firstChild.classList.add('primary');
  }
}

// A short two-tone alert, made here so no sound file or URL is involved.
function beep() {
  try {
    const audio = new AudioContext();
    const start = audio.currentTime + 0.02;
    [0, 0.22].forEach((offset, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = i ? 1175 : 880;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.2);
    });
    setTimeout(() => audio.close(), 1000);
  } catch {
    // No audio device: the card still shows.
  }
}

function renderWaiting(n) {
  $('waiting').hidden = !n;
  $('dismissAll').hidden = !n;
  $('waiting').textContent = `+${n}건 대기`;
}

// Countdown bar: the main process owns the timer and reports its state.
function renderTimer({ running, remainingMs, durationMs }) {
  const bar = $('timerBar');
  if (!durationMs) {
    bar.style.width = '0';
    return;
  }
  const ratio = Math.max(0, Math.min(1, remainingMs / durationMs));
  bar.style.transition = 'none';
  bar.style.width = `${ratio * 100}%`;
  if (running) {
    // Next frame: animate to empty over the remaining time.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        bar.style.transition = `width ${remainingMs}ms linear`;
        bar.style.width = '0';
      })
    );
  }
}

// ---------- widget card menu (engine API 1.1) ----------
// The widget (e.g. Dooray) offers a toggle list for this card's event. The button shows what is
// checked; the panel opens inside the card, which grows upwards and takes focus only while open.
let menu = null; // { label, placeholder, items }
let menuOpen = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dot(color) {
  const d = el('span', 'dot');
  if (color && /^#[0-9a-f]{3,8}$/i.test(color)) d.style.background = color;
  return d;
}

function renderMenuButton() {
  const btn = $('menuBtn');
  const checked = menu.items.filter((i) => i.checked);
  const parts = [];
  if (checked.length) {
    parts.push(dot(checked[0].color), el('span', 'name', checked[0].label));
    if (checked.length > 1) parts.push(el('span', 'more', `+${checked.length - 1}`));
  } else {
    parts.push(el('span', 'name', `${menu.label} ▾`));
  }
  btn.replaceChildren(...parts);
  btn.title = checked.length ? `${menu.label}: ${checked.map((i) => i.label).join(', ')}` : `${menu.label}에 넣기`;
  btn.hidden = false;
}

function renderMenuItems() {
  const list = $('menuItems');
  if (!menu.items.length) {
    list.replaceChildren(el('p', 'menu-empty', menu.placeholder !== null ? '아직 없습니다. 아래에서 새로 만드세요.' : '항목이 없습니다.'));
    return;
  }
  list.replaceChildren(
    ...menu.items.map((item) => {
      const row = el('button', 'menu-item');
      row.type = 'button';
      row.setAttribute('role', 'menuitemcheckbox');
      row.setAttribute('aria-checked', String(Boolean(item.checked)));
      row.append(el('span', 'check', item.checked ? '✓' : ''), dot(item.color), el('span', 'label', item.label));
      row.addEventListener('click', async () => applyMenu(await api.menuToggle(item.id, !item.checked)));
      return row;
    })
  );
}

function showMenuError(message) {
  $('menuError').textContent = message || '';
  $('menuError').hidden = !message;
}

function applyMenu(res) {
  if (!res.ok) return showMenuError(res.message);
  showMenuError('');
  menu.items = res.items;
  renderMenuButton();
  if (menuOpen) renderMenuItems();
}

// Height the panel needs: rows, the "new" field and room for an error line.
function panelHeight() {
  const rows = Math.max(1, menu.items.length);
  return 14 + rows * 26 + (menu.placeholder !== null ? 34 : 0) + 20;
}

async function setMenuOpen(open) {
  if (!menu || open === menuOpen) return;
  menuOpen = open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    const fresh = await api.menuItems(); // categories may have changed since the card appeared
    if (fresh.ok) menu.items = fresh.items;
    renderMenuButton();
    renderMenuItems();
    showMenuError('');
    $('menuCreate').hidden = menu.placeholder === null;
    $('menuInput').placeholder = menu.placeholder || '';
    await api.menuOpen(true, panelHeight());
    $('card').classList.add('menu-open');
    $('menu').hidden = false;
  } else {
    $('menu').hidden = true;
    $('card').classList.remove('menu-open');
    $('menuInput').value = '';
    await api.menuOpen(false, 0);
  }
}

$('menuBtn').addEventListener('click', () => setMenuOpen(!menuOpen));
$('menuCreate').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await api.menuCreate($('menuInput').value);
  if (res.ok) $('menuInput').value = '';
  applyMenu(res);
  if (res.ok) await api.menuOpen(true, panelHeight());
});
// Closing: Esc, or clicking anywhere outside the card (the card loses focus).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenuOpen(false);
});
window.addEventListener('blur', () => setMenuOpen(false));

api.onTimer(renderTimer);
api.onQueue(renderWaiting);
api.onSound(beep);

$('open').addEventListener('click', () => api.open());
$('subject').addEventListener('click', () => {
  if ($('card').dataset.type !== 'card') api.open();
});
$('ack').addEventListener('click', () => api.dismiss());
$('close').addEventListener('click', () => api.dismiss());
$('dismissAll').addEventListener('click', () => api.dismissAll());
$('card').addEventListener('mouseenter', () => api.hover(true));
$('card').addEventListener('mouseleave', () => api.hover(false));

api.get().then(({ card, waiting, menu: offered }) => {
  if (card.kind === 'summary') renderSummary(card);
  else if (card.kind === 'card') renderCard(card);
  else renderEvent(card.event);
  renderWaiting(waiting);
  if (offered) {
    menu = offered;
    renderMenuButton();
  }
});
