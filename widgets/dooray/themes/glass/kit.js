// Shared helpers for themes built on glass ("extends": "glass" makes this file available as kit.js).
// No UI of its own: element builder, icons, dates, search (incl. 초성), status text, back/forward.
window.DoorayKit = (() => {
  const ICONS = {
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4H6l4-4z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    detach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  };

  /** Creates an element. Text is always set via textContent (task data is untrusted). */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'icon') el.innerHTML = ICONS[value]; // trusted constants only
      else if (key === 'style') el.setAttribute('style', value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // ---------- dates ----------

  function relativeTime(iso) {
    if (!iso) return '';
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 45) return '방금';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}분 전`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    return `${Math.round(hr / 24)}일 전`;
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /** Days from today to the task's due day (negative = past), or null without a deadline. */
  function dueDays(task) {
    if (!task.deadline) return null;
    // deadline for date-only tasks is the next midnight; step back 1ms to get the due day.
    const dueDay = startOfDay(new Date(new Date(task.deadline).getTime() - 1));
    return Math.round((dueDay - startOfDay(new Date())) / 86400000);
  }

  /** "오늘", "내일", "D-5", "3일 지남" from the effective deadline. */
  function dueLabel(task) {
    const days = dueDays(task);
    if (days === null) return '';
    if (task.dueState === 'overdue') return days < 0 ? `${-days}일 지남` : '마감 지남';
    if (days === 0) return '오늘';
    if (days === 1) return '내일';
    return `D-${days}`;
  }

  // ---------- search ----------

  const CHOSUNG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const haystacks = new WeakMap();

  // Maps each Hangul syllable to its initial consonant; other characters stay as-is.
  // The result has the same length as the input, so match positions line up for highlighting.
  function toChosung(text) {
    let out = '';
    for (const ch of text) {
      const code = ch.charCodeAt(0) - 0xac00;
      out += code >= 0 && code < 11172 ? CHOSUNG[Math.floor(code / 588)] : ch;
    }
    return out;
  }

  const isChosungTerm = (term) => /^[ㄱ-ㅎ]+$/.test(term);

  function parseQuery(query) {
    return String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  function haystackOf(task) {
    let hay = haystacks.get(task);
    if (!hay) {
      const text = [
        task.subject,
        task.key,
        task.projectName,
        task.workflowName,
        ...task.assignees.map((a) => a.name),
        task.author?.name,
        ...(task.tags || []).map((t) => t.name),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      hay = { text, chosung: toChosung(text) };
      haystacks.set(task, hay);
    }
    return hay;
  }

  /** Every term must match (AND). Terms made only of initial consonants match against 초성. */
  function matches(task, terms) {
    const hay = haystackOf(task);
    return terms.every((term) => (isChosungTerm(term) ? hay.chosung : hay.text).includes(term));
  }

  function searchTasks(tasks, terms) {
    return terms.length ? tasks.filter((t) => matches(t, terms)) : tasks;
  }

  /** Returns text split into plain text and <mark> nodes for every term occurrence. */
  function highlight(text, terms) {
    if (!terms?.length) return [text];
    const lower = text.toLowerCase();
    const cho = toChosung(lower);
    const marks = new Array(text.length).fill(false);
    for (const term of terms) {
      const source = isChosungTerm(term) ? cho : lower;
      for (let i = source.indexOf(term); i >= 0; i = source.indexOf(term, i + 1)) {
        for (let k = i; k < i + term.length; k++) marks[k] = true;
      }
    }
    const nodes = [];
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || marks[i] !== marks[start]) {
        const part = text.slice(start, i);
        nodes.push(marks[start] ? h('mark', { text: part }) : part);
        start = i;
      }
    }
    return nodes;
  }

  // ---------- tasks ----------

  const DUE_ORDER = { overdue: 0, soon: 1, later: 2, none: 3 };

  /** Open first, then overdue → due soon → later → no deadline, then most recently updated. */
  function byUrgency(a, b) {
    return (
      (a.workflowClass === 'closed') - (b.workflowClass === 'closed') ||
      DUE_ORDER[a.dueState] - DUE_ORDER[b.dueState] ||
      (a.deadline && b.deadline ? a.deadline.localeCompare(b.deadline) : 0) ||
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  /** Every task the widget knows about: open tasks of all projects plus categorized ones. */
  function allKnownTasks(snapshot) {
    const byId = new Map();
    for (const p of snapshot.projects) for (const t of p.tasks.open) byId.set(t.id, t);
    for (const c of snapshot.categories || []) for (const t of c.tasks) if (!byId.has(t.id)) byId.set(t.id, t);
    return [...byId.values()];
  }

  /** Open tasks of every project (no categorized copies). */
  function openTasks(snapshot, projectId = null) {
    return snapshot.projects.filter((p) => !projectId || p.id === projectId).flatMap((p) => p.tasks.open);
  }

  // "고객사: 예시시청" -> "예시시청" on a chip; the full name stays in the tooltip.
  function tagLabel(tag) {
    return tag.group && tag.name.startsWith(`${tag.group}:`) ? tag.name.slice(tag.group.length + 1).trim() : tag.name;
  }

  // ---------- status ----------

  const PAUSE_LABEL = { locked: '잠금 중 · 갱신 멈춤', suspended: '절전 중 · 갱신 멈춤', idle: '자리 비움 · 갱신 멈춤' };

  /** { dot: '' | 'busy' | 'paused' | 'error', text } for a small status line. */
  function statusInfo(status) {
    const dot = status?.refreshing ? 'busy' : status?.paused ? 'paused' : status?.state === 'error' ? 'error' : '';
    let text = '';
    if (status?.refreshing) text = '갱신 중…';
    else if (status?.paused) text = PAUSE_LABEL[status.pausedReason] || '갱신 멈춤';
    else if (status?.state === 'error') text = status.message || '데이터를 가져오지 못했습니다.';
    else if (status?.lastSuccessAt) text = relativeTime(status.lastSuccessAt);
    return { dot, text };
  }

  // ---------- navigation ----------

  /** Mouse side buttons (3 = back, 4 = forward; Chromium reports them on mouseup) and Alt+Left/Right. */
  function onBackForward(back, forward) {
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        back();
      } else if (e.button === 4) {
        e.preventDefault();
        forward();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (!e.altKey || e.isComposing) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        forward();
      }
    });
  }

  /** Simple screen history: go(view) remembers the current one; back/forward move through them. */
  function createHistory(getView, setView, limit = 50) {
    const past = [];
    const future = [];
    return {
      go(view) {
        if (JSON.stringify(view) === JSON.stringify(getView())) return;
        past.push(getView());
        if (past.length > limit) past.shift();
        future.length = 0;
        setView(view);
      },
      back() {
        if (!past.length) return false;
        future.push(getView());
        setView(past.pop());
        return true;
      },
      forward() {
        if (!future.length) return false;
        past.push(getView());
        setView(future.pop());
        return true;
      },
      get canBack() {
        return past.length > 0;
      },
    };
  }

  return {
    ICONS,
    h,
    relativeTime,
    startOfDay,
    dueDays,
    dueLabel,
    toChosung,
    isChosungTerm,
    parseQuery,
    matches,
    searchTasks,
    highlight,
    DUE_ORDER,
    byUrgency,
    allKnownTasks,
    openTasks,
    tagLabel,
    statusInfo,
    onBackForward,
    createHistory,
  };
})();
