// Memo window (#75): WYSIWYG editing in a contenteditable. The page never writes files: it sends its content as a
// plain tree (the widget turns it into Markdown and saves it) and asks the widget to store pasted / dropped files.
(() => {
  const api = window.memo;
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const uiText = (ko, en) => /^en(?:-|$)/i.test(navigator.language) ? en : ko;
  const SEND_MS = 200;
  const TITLE_CLICK_DELAY_MS = 500;

  let meta = null;
  let plain = false; // a .txt memo: plain text editing
  let ready = false;
  let sentDirty = false;
  let sendTimer = null;
  let lastSend = 0;
  let statusTimer = null;
  let conflict = false;
  let savedRange = null;

  // ---- content -> tree (what the widget turns into Markdown) ----

  const KEEP_ATTRS = ['href', 'title', 'alt', 'class', 'data-asset', 'data-src', 'data-href', 'data-wiki', 'data-task', 'type', 'start', 'data-lang', 'data-align'];

  function toTree(node) {
    const children = [];
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) children.push({ type: 'text', value: n.nodeValue });
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.tagName.toLowerCase();
        const attrs = {};
        for (const a of KEEP_ATTRS) if (n.hasAttribute(a)) attrs[a] = n.getAttribute(a);
        if (tag === 'input' && n.checked) attrs.checked = '';
        if (tag === 'span' && n.style.fontWeight) attrs.style = `font-weight: ${n.style.fontWeight}`;
        children.push({ type: 'element', tag, attrs, children: tag === 'img' || tag === 'input' ? [] : toTree(n).children });
      }
    }
    return { type: 'root', children };
  }

  function payload() {
    return plain ? { text: editor.innerText.replace(/\n$/, '') } : { tree: toTree(editor) };
  }

  function send() {
    clearTimeout(sendTimer);
    sendTimer = null;
    lastSend = Date.now();
    sentDirty = false;
    return api.call('update', payload());
  }

  /** Called on every change: tells the widget once that there are edits, then sends at most every SEND_MS. */
  function changed() {
    if (!ready) return;
    updateEmpty();
    if (!sentDirty) {
      sentDirty = true;
      api.call('dirty');
    }
    if (sendTimer) return;
    sendTimer = setTimeout(send, Math.max(0, SEND_MS - (Date.now() - lastSend)));
  }

  function updateEmpty() {
    const empty = !editor.textContent.trim() && !editor.querySelector('img, hr, table, li, input');
    editor.classList.toggle('empty', empty);
  }

  // ---- showing content ----

  function show(view) {
    if (plain || typeof view.text === 'string') {
      editor.textContent = view.text || '';
    } else {
      editor.innerHTML = view.html || '';
      if (!editor.firstChild) editor.innerHTML = '<p><br></p>';
      fixTasks();
    }
    updateEmpty();
  }

  function applyMeta(m) {
    meta = m;
    plain = m.ext !== 'md';
    document.body.dataset.color = m.color;
    document.body.classList.toggle('pinned', m.alwaysOnTop);
    document.body.classList.toggle('collapsed', m.collapsed);
    document.body.classList.toggle('plain', plain);
    editor.classList.toggle('plain', plain);
    editor.contentEditable = plain ? 'plaintext-only' : 'true';
    $('title').textContent = m.title + (plain ? ' (.txt)' : '') + (m.conflictCopy ? ' · 충돌 사본' : '');
    $('title').title = m.conflictCopy ? '같은 노트의 다른 사본입니다(예: OneDrive 충돌 사본). 내용을 비교해 필요 없는 쪽을 휴지통으로 옮기세요.' : uiText('끌어서 옮기기, 한 번 클릭하여 접기·펼치기, 두 번 클릭하여 이름 바꾸기', 'Drag to move; click to collapse or expand; double-click to rename');
    $('title').setAttribute('aria-label', uiText(`${m.title}: 끌어서 옮기기, 한 번 클릭하여 접기·펼치기, 두 번 클릭하여 이름 바꾸기`, `${m.title}: drag to move; click to collapse or expand; double-click to rename`));
    document.title = m.title;
    showDue(m);
  }

  // ---- to-do notes (#111): the due bar ----

  /** The due bar under the title bar (design 2.1): chip, repeat, 완료. A plain note shows only the ⏰ button. */
  function showDue(m) {
    const t = m.todo;
    const body = document.body;
    $('btnDue').hidden = plain || m.done;
    body.classList.toggle('has-due', Boolean(t));
    for (const s of ['overdue', 'today']) body.classList.toggle(s, Boolean(t && t.state === s));
    $('dueBar').hidden = !t;
    if (!t) {
      hideSuggest();
      return;
    }
    const chip = $('dueChip');
    const problem = t.problems?.[0];
    chip.className = `due-chip ${problem && !t.due ? 'warn' : t.state || ''}`;
    if (problem && !t.due) {
      chip.textContent = `날짜를 읽을 수 없음: ${problem.value} · 다시 정하기`;
      chip.title = '머리말의 due 값을 읽을 수 없습니다. 눌러서 다시 정하면 그 줄만 바뀝니다.';
    } else {
      chip.textContent = t.chip;
      chip.title = `${t.dueText}${t.remind ? ` · 알림 ${t.remind}` : ''} — 눌러서 바꾸기`;
    }
    const repeatProblem = t.problems?.find((p) => p.key === 'repeat');
    $('dueRepeat').textContent = t.repeat ? `↻ ${t.repeat}` : repeatProblem ? `⚠ 반복을 읽을 수 없음: ${repeatProblem.value}` : '';
    const btn = $('btnDone');
    btn.hidden = !t.due && !m.done;
    btn.textContent = m.done ? '↩ 되살리기' : '✓ 완료';
    btn.title = m.done ? '완료를 취소하고 노트 폴더로 되돌립니다' : '완료 (Ctrl+Enter)';
    hideSuggest();
  }

  async function complete() {
    if (!meta?.todo?.due || meta.done || document.body.classList.contains('leaving')) return;
    if (sendTimer || sentDirty) await send();
    document.body.classList.add('leaving');
    await new Promise((r) => setTimeout(r, 300));
    const r = await api.call('complete');
    // On success the window closes; it stays only when completing failed.
    if (!r?.ok) {
      document.body.classList.remove('leaving');
      status(r?.message || '완료하지 못했습니다.', { error: true });
    }
  }

  async function applyDue(values) {
    const r = await api.call('setDue', values);
    if (!r?.ok) {
      status(r?.message || '날짜를 걸지 못했습니다.', { error: true });
      return false;
    }
    applyMeta(r.meta);
    return true;
  }

  // ---- the date box (design 2.2 ①) ----

  const box = { draft: null, valid: false, seq: 0, timer: null, month: null };
  const REMINDS = [
    ['', null],
    ['10분 전', '10분 전'],
    ['1시간 전', '1시간 전'],
    ['1일 전 18:00', '전날 18시'],
    ['없음', '끄기'],
  ];

  function openDueBox(focus = 'date') {
    if (plain || !meta || meta.done) return;
    const t = meta.todo;
    box.draft = { due: t?.due || null, repeat: t?.repeat || '', remind: t?.remind || '', reset: t?.resetChecks ?? null };
    box.valid = Boolean(box.draft.due);
    $('dueInput').value = t?.due || '';
    $('duePreview').textContent = t?.dueText ? `${t.dueText}${t.repeat ? ` · ↻ ${t.repeat}` : ''}` : '';
    $('duePreview').classList.remove('invalid');
    $('dueFit').hidden = true;
    $('dueCal').hidden = true;
    $('dueClear').hidden = !t?.due;
    $('dueBox').hidden = false;
    syncTimeField();
    fillRepeat();
    fillRemind();
    if (focus === 'repeat') $('dueRepeatSel').focus();
    else {
      $('dueInput').focus();
      $('dueInput').select();
    }
  }

  function closeDueBox({ focusEditor = true } = {}) {
    clearTimeout(box.timer);
    box.timer = null;
    box.seq += 1;
    $('dueBox').hidden = true;
    if (focusEditor) editor.focus();
  }

  // The time row shows the draft's time ("YYYY-MM-DD HH:MM"); empty means all day.
  function syncTimeField() {
    const m = /\d\d:\d\d$/.exec(box.draft?.due || '');
    $('dueTime').value = m ? m[0] : '';
    $('dueAllDay').classList.toggle('on', Boolean(box.draft?.due) && !m);
  }

  // Picking a time (or 종일) keeps the date and goes through the same parser as typing.
  function setDueTime(time) {
    const date = /^\d{4}-\d\d-\d\d/.exec(box.draft?.due || '')?.[0];
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    $('dueInput').value = `${date || today}${time ? ` ${time}` : ''}`;
    readInput();
  }

  function preview(text, invalid = false) {
    $('duePreview').textContent = text;
    $('duePreview').classList.toggle('invalid', invalid);
  }

  async function readInput() {
    const seq = ++box.seq;
    const r = await api.call('parseWhen', { text: $('dueInput').value });
    if (seq !== box.seq || !r?.ok) return;
    if (r.empty) {
      box.valid = false;
      preview('');
      return;
    }
    if (r.invalid) {
      box.valid = false;
      preview('알 수 없는 날짜', true);
      return;
    }
    box.valid = true;
    box.draft.due = r.due;
    if (r.repeat) box.draft.repeat = r.repeat; // "매월 1일 9시" also sets the repeat
    syncTimeField();
    preview(r.preview);
    fillRepeat();
    fillRemind();
    if (!$('dueCal').hidden) drawCalendar();
  }

  async function fillRepeat() {
    const sel = $('dueRepeatSel');
    const r = await api.call('repeatOptions', { due: box.draft.due || '' });
    const items = ['', ...(r?.items || [])];
    if (box.draft.repeat && !items.includes(box.draft.repeat)) items.push(box.draft.repeat);
    sel.textContent = '';
    for (const v of items) sel.append(new Option(v || '없음', v));
    sel.value = box.draft.repeat;
    $('dueResetRow').hidden = !box.draft.repeat;
    $('dueReset').checked = box.draft.reset ?? meta.todoDefaults?.resetChecks ?? true;
  }

  function fillRemind() {
    const sel = $('dueRemindSel');
    const timed = /\d\d:\d\d$/.test(box.draft.due || '');
    const allDay = meta.todoDefaults?.allDayRemind;
    sel.textContent = '';
    for (const [v, label] of REMINDS) sel.append(new Option(label || (timed ? '마감 시각' : allDay ? `그날 ${allDay}` : '알림 없음 (설정)'), v));
    if (box.draft.remind && !REMINDS.some(([v]) => v === box.draft.remind)) sel.append(new Option(box.draft.remind, box.draft.remind));
    sel.value = box.draft.remind;
  }

  async function repeatChanged() {
    box.draft.repeat = $('dueRepeatSel').value;
    $('dueResetRow').hidden = !box.draft.repeat;
    $('dueFit').hidden = true;
    if (!box.draft.repeat || !box.draft.due) return;
    const r = await api.call('ruleFit', { due: box.draft.due, repeat: box.draft.repeat });
    if (!r?.ok || r.fits) return;
    // "매월 1일 -> 매월 15일" with the due on 11/1: offer the rule's date (design 5.4).
    $('dueFitText').textContent = `다음 날짜를 ${r.alignedText}로 맞출까요?`;
    $('dueFit').hidden = false;
    $('dueFitYes').onclick = () => {
      box.draft.due = r.aligned;
      $('dueInput').value = r.aligned;
      $('dueFit').hidden = true;
      readInput();
    };
    $('dueFitNo').onclick = () => ($('dueFit').hidden = true);
  }

  async function okDueBox() {
    if (!box.valid || !box.draft.due) {
      preview($('dueInput').value.trim() ? '알 수 없는 날짜' : '날짜를 적어 주세요', true);
      return;
    }
    const values = { due: box.draft.due, repeat: box.draft.repeat, remind: box.draft.remind };
    if (box.draft.repeat) values.resetChecks = $('dueReset').checked;
    if (await applyDue(values)) closeDueBox();
  }

  /** A small month calendar inside the box (7 x 6, design 2.2). */
  function drawCalendar() {
    const cal = $('dueCal');
    const cur = (box.draft.due || '').slice(0, 10);
    const today = new Date();
    const base = box.month || (cur ? new Date(Number(cur.slice(0, 4)), Number(cur.slice(5, 7)) - 1, 1) : new Date(today.getFullYear(), today.getMonth(), 1));
    box.month = base;
    cal.textContent = '';
    const head = document.createElement('div');
    head.className = 'cal-head';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = '‹';
    prev.onclick = () => ((box.month = new Date(base.getFullYear(), base.getMonth() - 1, 1)), drawCalendar());
    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = '›';
    next.onclick = () => ((box.month = new Date(base.getFullYear(), base.getMonth() + 1, 1)), drawCalendar());
    const label = document.createElement('span');
    label.textContent = `${base.getFullYear()}년 ${base.getMonth() + 1}월`;
    head.append(prev, label, next);
    cal.append(head);
    for (const w of '일월화수목금토') {
      const el = document.createElement('span');
      el.className = 'wd';
      el.textContent = w;
      cal.append(el);
    }
    const start = new Date(base.getFullYear(), base.getMonth(), 1 - base.getDay());
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (let k = 0; k < 42; k++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `day${d.getMonth() !== base.getMonth() ? ' other' : ''}${iso(d) === iso(today) ? ' today' : ''}${iso(d) === cur ? ' on' : ''}`;
      b.textContent = String(d.getDate());
      b.onclick = () => {
        const time = /\d\d:\d\d$/.exec(box.draft.due || '');
        $('dueInput').value = `${iso(d)}${time ? ` ${time[0]}` : ''}`;
        readInput();
      };
      cal.append(b);
    }
  }

  const toggleDueBox = () => ($('dueBox').hidden ? openDueBox() : closeDueBox());
  $('btnDue').addEventListener('click', toggleDueBox);
  $('dueChip').addEventListener('click', toggleDueBox);
  document.addEventListener('pointerdown', (event) => {
    if ($('dueBox').hidden || $('dueBox').contains(event.target) || $('btnDue').contains(event.target) || $('dueChip').contains(event.target)) return;
    closeDueBox({ focusEditor: false });
  }, true);
  window.addEventListener('blur', () => {
    if (!$('dueBox').hidden) closeDueBox({ focusEditor: false });
  });
  $('btnDone').addEventListener('click', () => (meta?.done ? api.call('uncomplete') : complete()));
  $('dueInput').addEventListener('input', () => {
    clearTimeout(box.timer);
    box.timer = setTimeout(readInput, 80);
  });
  $('dueInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(box.timer);
      await readInput();
      okDueBox();
    }
  });
  $('dueBox').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDueBox();
    }
  });
  for (const b of $('dueBox').querySelectorAll('.quick button')) {
    b.addEventListener('click', () => {
      // Keep a time already chosen: "내일" + 15:00 -> "내일 15:00".
      const time = $('dueTime').value;
      $('dueInput').value = time ? `${b.dataset.q} ${time}` : b.dataset.q;
      readInput();
    });
  }
  $('dueTime').addEventListener('change', () => setDueTime($('dueTime').value));
  $('dueAllDay').addEventListener('click', () => setDueTime(''));
  $('dueRepeatSel').addEventListener('change', repeatChanged);
  $('dueRemindSel').addEventListener('change', () => (box.draft.remind = $('dueRemindSel').value));
  $('dueReset').addEventListener('change', () => (box.draft.reset = $('dueReset').checked));
  $('dueCalBtn').addEventListener('click', () => {
    $('dueCal').hidden = !$('dueCal').hidden;
    box.month = null;
    if (!$('dueCal').hidden) drawCalendar();
  });
  $('dueOk').addEventListener('click', okDueBox);
  $('dueClear').addEventListener('click', async () => {
    const r = await api.call('clearDue');
    if (!r?.ok) return status(r?.message || '날짜를 지우지 못했습니다.', { error: true });
    applyMeta(r.meta);
    closeDueBox();
  });

  function applyStyle(s) {
    document.documentElement.style.setProperty('--bg-alpha', String(Math.max(0, Math.min(100, s.opacity)) / 100));
    document.documentElement.style.setProperty('--font-size', `${s.fontSize}px`);
  }

  function status(text, { error = false, ms = 1500 } = {}) {
    const el = $('status');
    clearTimeout(statusTimer);
    el.textContent = text;
    el.classList.toggle('error', error);
    el.classList.add('show');
    if (!error) statusTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function banner(text, buttons) {
    $('banner').hidden = !text;
    $('bannerText').textContent = text || '';
    const box = $('bannerButtons');
    box.textContent = '';
    for (const b of buttons || []) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.label;
      el.addEventListener('click', b.run);
      box.append(el);
    }
  }

  async function resolve(choice) {
    const r = await api.call('resolve', { choice, ...payload() });
    if (!r?.ok) return status(r?.message || '처리하지 못했습니다.', { error: true });
    conflict = false;
    sentDirty = false;
    banner(null);
    if (choice === 'copy') status('내 내용을 새 노트(사본)로 저장했습니다.', { ms: 3000 });
  }

  // ---- task lists ----

  function fixTasks() {
    for (const ul of editor.querySelectorAll('ul.task, ol.task')) {
      for (const li of ul.children) {
        if (li.tagName !== 'LI') continue;
        let box = li.firstElementChild;
        if (!(box && box.tagName === 'INPUT' && box.type === 'checkbox' && li.firstChild === box)) {
          box = li.querySelector(':scope > input[type="checkbox"]') || document.createElement('input');
          box.type = 'checkbox';
          box.setAttribute('contenteditable', 'false');
          li.prepend(box);
        }
        li.classList.add('task');
        li.dataset.task = box.checked ? 'x' : ' ';
      }
    }
    // A checkbox left in an item that is no longer in a task list.
    for (const box of editor.querySelectorAll('li > input[type="checkbox"]')) {
      const list = box.parentElement.parentElement;
      if (list && !list.classList.contains('task') && !box.parentElement.classList.contains('task')) box.remove();
    }
  }

  // ---- formatting ----

  const exec = (cmd, value = null) => document.execCommand(cmd, false, value);

  function currentBlock() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.anchorNode;
    while (n && n !== editor) {
      if (n.nodeType === 1 && /^(P|DIV|H[1-6]|LI|PRE|BLOCKQUOTE|TD|TH)$/.test(n.tagName)) return n;
      n = n.parentNode;
    }
    return null;
  }

  const closest = (sel) => {
    const s = getSelection();
    const n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
    const el = n && n.closest(sel);
    return el && editor.contains(el) ? el : null;
  };

  function toggleInlineCode() {
    const sel = getSelection();
    const code = closest('code');
    if (code && !closest('pre')) {
      code.replaceWith(...code.childNodes);
      return;
    }
    if (!sel.rangeCount || sel.isCollapsed) {
      exec('insertHTML', '<code>\u200b</code>');
      return;
    }
    const text = sel.toString();
    const el = document.createElement('code');
    el.textContent = text;
    exec('insertHTML', el.outerHTML);
  }

  function toggleTask() {
    let list = closest('ul, ol');
    if (!list) {
      exec('insertUnorderedList');
      list = closest('ul, ol');
    }
    if (!list) return;
    list.classList.toggle('task');
    if (!list.classList.contains('task')) for (const li of list.children) li.classList.remove('task'), li.removeAttribute('data-task');
    fixTasks();
  }

  function toggleBlock(tag) {
    const block = currentBlock();
    exec('formatBlock', block && block.tagName === tag.toUpperCase() ? 'p' : tag);
  }

  function cycleHeading() {
    const block = currentBlock();
    const level = block && /^H([1-3])$/.test(block.tagName) ? Number(block.tagName[1]) : 0;
    exec('formatBlock', level === 3 ? 'p' : `h${level + 1}`);
  }

  function insertTable() {
    exec('insertHTML', '<table><thead><tr><th><br></th><th><br></th></tr></thead><tbody><tr><td><br></td><td><br></td></tr></tbody></table><p><br></p>');
  }

  function insertCodeBlock() {
    const block = currentBlock();
    if (block && block.tagName === 'PRE') return exec('formatBlock', 'p');
    exec('formatBlock', 'pre');
  }

  function showLinkBox() {
    const sel = getSelection();
    savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const a = closest('a');
    $('linkInput').value = a ? a.getAttribute('href') || '' : '';
    $('linkBox').hidden = false;
    $('linkInput').focus();
  }

  function applyLink() {
    const url = $('linkInput').value.trim();
    $('linkBox').hidden = true;
    editor.focus();
    const sel = getSelection();
    if (savedRange) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    if (!url) {
      exec('unlink');
      return;
    }
    if (!/^(https?:\/\/|mailto:)/i.test(url)) {
      status('링크는 http://, https://, mailto: 주소만 넣을 수 있습니다.', { error: true });
      return;
    }
    if (sel.isCollapsed) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      exec('insertHTML', a.outerHTML);
    } else exec('createLink', url);
  }

  function run(cmd) {
    if (plain && cmd !== 'file') return;
    editor.focus();
    switch (cmd) {
      case 'bold':
        exec('bold');
        break;
      case 'italic':
        exec('italic');
        break;
      case 'strike':
        exec('strikeThrough');
        break;
      case 'code':
        toggleInlineCode();
        break;
      case 'heading':
        cycleHeading();
        break;
      case 'ul':
        exec('insertUnorderedList');
        break;
      case 'ol':
        exec('insertOrderedList');
        break;
      case 'task':
        toggleTask();
        break;
      case 'quote':
        toggleBlock('blockquote');
        break;
      case 'pre':
        insertCodeBlock();
        break;
      case 'link':
        showLinkBox();
        return;
      case 'table':
        insertTable();
        break;
      case 'hr':
        exec('insertHorizontalRule');
        break;
      case 'file':
        pickFiles();
        return;
      default:
        return;
    }
    changed();
  }

  // ---- Markdown typing shortcuts: "# ", "- ", "1. ", "[] ", "> " at the start of a line; "```" / "---" + Enter ----

  function blockPrefix() {
    const sel = getSelection();
    const block = currentBlock();
    if (!block || !sel.isCollapsed) return null;
    const range = document.createRange();
    range.setStart(block, 0);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    return { block, text: range.toString(), range };
  }

  function deletePrefix(range) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    exec('delete');
  }

  function spaceShortcut() {
    const p = blockPrefix();
    if (!p || p.block.closest('pre, li, td, th')) return false;
    const t = p.text;
    let action = null;
    if (/^#{1,6}$/.test(t)) action = () => exec('formatBlock', `h${t.length}`);
    else if (/^[-*+]$/.test(t)) action = () => exec('insertUnorderedList');
    else if (/^1[.)]$/.test(t)) action = () => exec('insertOrderedList');
    else if (/^\[[ xX]?\]$/.test(t)) action = () => toggleTask();
    else if (t === '>') action = () => exec('formatBlock', 'blockquote');
    if (!action) return false;
    deletePrefix(p.range);
    action();
    return true;
  }

  function enterShortcut() {
    const p = blockPrefix();
    if (!p || p.block.closest('pre, li, td, th')) return false;
    if (p.text !== p.block.textContent) return false;
    if (/^```[\w-]*$/.test(p.text)) {
      const lang = p.text.slice(3);
      deletePrefix(p.range);
      exec('formatBlock', 'pre');
      const pre = closest('pre');
      if (pre && lang) pre.dataset.lang = lang;
      return true;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(p.text)) {
      deletePrefix(p.range);
      exec('insertHorizontalRule');
      return true;
    }
    return false;
  }

  // ---- files: paste, drop, pick ----

  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function insertAssets(added) {
    let html = '';
    for (const a of added) {
      if (a.image) html += `<img data-asset="${escAttr(a.name)}"${a.src ? ` src="${escAttr(a.src)}"` : ' data-missing="1"'} alt="${escAttr(a.name.replace(/\.[^.]+$/, ''))}">`;
      else html += `<a class="attach" data-asset="${escAttr(a.name)}">${escAttr(a.name).replace(/>/g, '&gt;')}</a>\u00a0`;
    }
    if (html) {
      editor.focus();
      exec('insertHTML', html);
      changed();
    }
  }

  function reportFiles(r) {
    if (!r?.ok) return status(r?.message || '파일을 넣지 못했습니다.', { error: true });
    if (r.errors?.length) status(r.errors.join(' / '), { error: true });
    insertAssets(r.added || []);
  }

  async function pickFiles() {
    if (plain) return status('이미지·첨부는 Markdown 노트에서만 넣을 수 있습니다 (오른쪽 클릭 → Markdown 노트로 바꾸기).', { error: true });
    reportFiles(await api.call('pickFiles'));
  }

  editor.addEventListener('paste', async (e) => {
    const cd = e.clipboardData;
    const images = [...(cd?.files || [])].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    e.preventDefault();
    if (images.length && !plain) {
      for (const f of images) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const r = await api.call('addImage', { name: f.name && f.name !== 'image.png' ? f.name : '', type: f.type, bytes });
        if (!r?.ok) status(r?.message || '이미지를 넣지 못했습니다.', { error: true });
        else insertAssets([{ name: r.name, image: true, src: r.src }]);
      }
      return;
    }
    const text = cd?.getData('text/plain') || '';
    if (text) {
      exec('insertText', text.replace(/\r\n?/g, '\n'));
      changed();
    } else if (images.length) status('이미지는 Markdown 노트에서만 넣을 수 있습니다.', { error: true });
  });

  editor.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  editor.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return; // text dragged inside the memo: the browser moves it
    e.preventDefault();
    if (plain) return status('이미지·첨부는 Markdown 노트에서만 넣을 수 있습니다.', { error: true });
    const range = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (range && editor.contains(range.startContainer)) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return status('이 항목은 파일로 넣을 수 없습니다.', { error: true });
    reportFiles(await api.call('addFiles', { paths }));
  });

  // ---- clicks: checkboxes, links, attachments ----

  editor.addEventListener('click', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (box && editor.contains(box)) {
      const li = box.closest('li');
      if (li) li.dataset.task = box.checked ? 'x' : ' ';
      changed();
      return;
    }
    const a = e.target.closest('a');
    if (a && editor.contains(a) && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      openLink(a);
    }
  });

  editor.addEventListener('dblclick', (e) => {
    const img = e.target.closest('img[data-asset]');
    if (img) api.call('openAsset', { name: img.dataset.asset }).then((r) => r && !r.ok && r.message && status(r.message, { error: true }));
  });

  async function openLink(a) {
    const r = a.dataset.wiki
      ? await api.call('openWiki', { target: a.dataset.wiki })
      : a.dataset.asset
        ? await api.call('openAsset', { name: a.dataset.asset })
        : await api.call('openLink', { href: a.getAttribute('href') || a.dataset.href || '' });
    if (r && !r.ok && r.message) status(r.message, { error: true });
  }

  editor.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a');
    if (a && editor.contains(a) && a.dataset.wiki) return status(`노트 [[${a.dataset.wiki}]]${a.dataset.missing ? ' (아직 없음, 만들어짐)' : ''} · Ctrl+클릭으로 열기`, { ms: 2500 });
    if (a && editor.contains(a)) status(a.dataset.asset ? `첨부 ${a.dataset.asset} · Ctrl+클릭으로 열기` : `${a.getAttribute('href') || a.dataset.href || ''} · Ctrl+클릭으로 열기`, { ms: 2500 });
  });

  // ---- [[ links to other memos: autocomplete while typing, "]]" closes one by hand ----

  const wiki = { items: [], index: 0, seq: 0 };

  /** The "[[text" right before the caret (not in code or a link): { q, range } or null. */
  function wikiQuery(closing = false) {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || node.parentElement.closest('pre, code, a')) return null;
    const before = node.nodeValue.slice(0, sel.anchorOffset);
    const m = closing ? before.match(/\[\[([^[\]|\n]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]$/) : before.match(/\[\[([^[\]|#\n]{0,60})$/);
    if (!m) return null;
    const range = document.createRange();
    range.setStart(node, sel.anchorOffset - m[0].length);
    range.setEnd(node, sel.anchorOffset);
    return { q: m[1], label: m[2] || '', range };
  }

  function insertWiki(range, target, label = '') {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const a = document.createElement('a');
    a.className = 'wiki';
    a.dataset.wiki = target;
    a.textContent = label || target;
    exec('insertHTML', `${a.outerHTML}\u00a0`);
  }

  function wikiInput() {
    const closed = wikiQuery(true);
    if (closed && closed.q.trim()) {
      hideWiki();
      insertWiki(closed.range, closed.q.trim(), closed.label.trim());
      return;
    }
    const q = wikiQuery();
    if (!q) return hideWiki();
    const seq = ++wiki.seq;
    api.call('suggest', { q: q.q }).then((r) => {
      if (seq !== wiki.seq || !r?.ok) return;
      showWiki(r.items || [], q.range);
    });
  }

  function showWiki(items, range) {
    const box = $('wikiBox');
    wiki.items = items;
    wiki.index = 0;
    box.textContent = '';
    if (!items.length) return hideWiki();
    items.forEach((it, k) => {
      const li = document.createElement('li');
      li.textContent = it.create ? `새 노트 만들기: ${it.title}` : it.title;
      if (it.create) li.className = 'create';
      if (it.preview) li.title = it.preview;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickWiki(k);
      });
      box.append(li);
    });
    box.hidden = false;
    // Under the caret, kept inside the window.
    const rect = range.getBoundingClientRect();
    const card = $('card').getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.left - card.left, card.width - box.offsetWidth - 4));
    const below = rect.bottom - card.top + 2;
    const top = below + box.offsetHeight > card.height - 4 ? Math.max(4, rect.top - card.top - box.offsetHeight - 2) : below;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    markWiki();
  }

  function markWiki() {
    [...$('wikiBox').children].forEach((li, k) => li.classList.toggle('on', k === wiki.index));
  }

  function hideWiki() {
    wiki.items = [];
    $('wikiBox').hidden = true;
  }

  function pickWiki(k) {
    const it = wiki.items[k];
    const q = wikiQuery();
    hideWiki();
    if (!it || !q) return;
    insertWiki(q.range, it.title);
    changed();
  }

  /** Arrow keys / Enter / Tab / Esc while the list is open. */
  function wikiKeydown(e) {
    if ($('wikiBox').hidden || !wiki.items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      wiki.index = (wiki.index + (e.key === 'ArrowDown' ? 1 : -1) + wiki.items.length) % wiki.items.length;
      markWiki();
    } else if (e.key === 'Enter' || e.key === 'Tab') pickWiki(wiki.index);
    else if (e.key === 'Escape') hideWiki();
    else return false;
    e.preventDefault();
    return true;
  }

  // ---- "/" commands (design 2.2 ②): "/" at a line start or after a space, not in code or links ----

  const slash = { items: [], index: 0, seq: 0 };
  const SLASH_COMMANDS = [
    { words: ['날짜', 'date', '언제'], label: '⏰ 날짜 정하기…', run: () => openDueBox() },
    { words: ['반복', 'repeat'], label: '↻ 반복…', run: () => openDueBox('repeat') },
    { words: ['완료', 'done'], label: '✓ 완료', due: true, run: () => complete() },
    { words: ['지우기', '날짜 지우기', 'clear'], label: '✕ 날짜 지우기', due: true, run: () => api.call('clearDue').then((r) => r?.ok && applyMeta(r.meta)) },
  ];

  function slashQuery() {
    const sel = getSelection();
    if (plain || !meta || meta.done || !sel.rangeCount || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || node.parentElement.closest('pre, code, a')) return null;
    const before = node.nodeValue.slice(0, sel.anchorOffset);
    const m = before.match(/(^|[\s\u00a0])\/([^\n/]{0,40})$/);
    if (!m) return null;
    const range = document.createRange();
    range.setStart(node, sel.anchorOffset - m[0].length + m[1].length);
    range.setEnd(node, sel.anchorOffset);
    return { q: m[2].replace(/\u00a0/g, ' ').trim(), range };
  }

  async function slashInput() {
    const q = slashQuery();
    if (!q) return hideSlash();
    const seq = ++slash.seq;
    const hasDue = Boolean(meta.todo?.due);
    const items = [];
    if (q.q) {
      const r = await api.call('parseWhen', { text: q.q });
      if (seq !== slash.seq) return;
      if (r?.ok && r.due) items.push({ label: `⏰ 날짜: ${r.preview}`, run: () => applyDue({ due: r.due, ...(r.repeat ? { repeat: r.repeat } : {}) }) });
    }
    const key = q.q.toLowerCase();
    for (const c of SLASH_COMMANDS) {
      if (c.due && !hasDue) continue;
      if (key && !c.words.some((w) => w.startsWith(key) || key.startsWith(w))) continue;
      items.push(c);
    }
    if (!items.length && q.q) items.push({ label: '알 수 없는 날짜', off: true });
    showSlash(items, q.range);
  }

  function showSlash(items, range) {
    const list = $('slashBox');
    slash.items = items;
    slash.index = items.findIndex((it) => !it.off);
    list.textContent = '';
    if (!items.length) return hideSlash();
    items.forEach((it, k) => {
      const li = document.createElement('li');
      li.textContent = it.label;
      if (it.off) li.className = 'off';
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickSlash(k);
      });
      list.append(li);
    });
    list.hidden = false;
    const rect = range.getBoundingClientRect();
    const card = $('card').getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.left - card.left, card.width - list.offsetWidth - 4));
    const below = rect.bottom - card.top + 2;
    list.style.left = `${left}px`;
    list.style.top = `${below + list.offsetHeight > card.height - 4 ? Math.max(4, rect.top - card.top - list.offsetHeight - 2) : below}px`;
    [...list.children].forEach((li, k) => li.classList.toggle('on', k === slash.index));
  }

  function hideSlash() {
    slash.items = [];
    $('slashBox').hidden = true;
  }

  function pickSlash(k) {
    const it = slash.items[k];
    const q = slashQuery();
    hideSlash();
    if (!it || it.off) return;
    if (q) {
      // The typed "/내일 3시" goes away; the command runs on the note.
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(q.range);
      exec('delete');
      changed();
    }
    it.run();
  }

  function slashKeydown(e) {
    if ($('slashBox').hidden || !slash.items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = slash.items.length;
      do slash.index = (slash.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      while (slash.items[slash.index].off && slash.items.some((it) => !it.off));
      [...$('slashBox').children].forEach((li, k) => li.classList.toggle('on', k === slash.index));
    } else if (e.key === 'Enter' || e.key === 'Tab') pickSlash(slash.index);
    else if (e.key === 'Escape') hideSlash();
    else return false;
    e.preventDefault();
    return true;
  }

  // ---- the first line suggestion (design 2.2 ③): never applied by itself ----

  const suggest = { value: null, seq: 0, timer: null };

  function firstBlock() {
    const b = editor.firstElementChild;
    return b && /^(P|H[1-6]|DIV)$/.test(b.tagName) ? b : null;
  }

  function suggestInput() {
    clearTimeout(suggest.timer);
    if (plain || !meta?.autoTitle || meta.todo?.due || meta.done) return hideSuggest();
    suggest.timer = setTimeout(async () => {
      const b = firstBlock();
      if (!b) return hideSuggest();
      const seq = ++suggest.seq;
      const r = await api.call('suggestDue', { line: b.textContent });
      if (seq !== suggest.seq || !r?.ok || !r.suggestion) return hideSuggest();
      suggest.value = r.suggestion;
      const chip = $('suggestChip');
      chip.textContent = `⏰ ${r.suggestion.chip}?`;
      chip.hidden = false;
      // At the end of the first line, kept inside the window.
      const range = document.createRange();
      range.selectNodeContents(b);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] || b.getBoundingClientRect();
      const card = $('card').getBoundingClientRect();
      let left = last.right - card.left + 6;
      let top = last.top - card.top + Math.max(0, (last.height - 18) / 2);
      if (left + chip.offsetWidth > card.width - 4) {
        left = card.width - chip.offsetWidth - 6;
        top = last.bottom - card.top + 2;
      }
      chip.style.left = `${Math.max(4, left)}px`;
      chip.style.top = `${top}px`;
    }, 250);
  }

  function hideSuggest() {
    suggest.value = null;
    $('suggestChip').hidden = true;
  }

  /** Removes the date phrase from the end of the first line (whatever the spacing was) and sets the date. */
  async function applySuggest() {
    const s = suggest.value;
    const b = firstBlock();
    hideSuggest();
    if (!s || !b) return;
    const nodes = [];
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const want = s.phrase.replace(/\s+/g, '');
    let left = want.length;
    let cut = null;
    for (let i = nodes.length - 1; i >= 0 && left > 0; i--) {
      const text = nodes[i].nodeValue;
      for (let j = text.length - 1; j >= 0; j--) {
        if (/\s/.test(text[j])) continue;
        if (left === 0) break;
        left--;
        if (left === 0) cut = { node: nodes[i], offset: j };
      }
    }
    if (cut) {
      const range = document.createRange();
      range.setStart(cut.node, cut.offset);
      range.setEndAfter(b.lastChild);
      range.deleteContents();
      // The space before the phrase goes too.
      if (b.contains(cut.node)) cut.node.nodeValue = cut.node.nodeValue.replace(/[\s\u00a0]+$/, '');
      if (!b.textContent) b.innerHTML = '<br>';
      changed();
      await send();
    }
    applyDue({ due: s.due, ...(s.repeat ? { repeat: s.repeat } : {}) });
  }

  $('suggestChip').addEventListener('mousedown', (e) => {
    e.preventDefault();
    applySuggest();
  });

  // ---- keys ----

  addEventListener('keydown', (e) => document.body.classList.toggle('ctrl', e.ctrlKey));
  addEventListener('keyup', (e) => document.body.classList.toggle('ctrl', e.ctrlKey));

  addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      openDueBox();
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter' && meta?.todo?.due && !meta.done) {
      e.preventDefault();
      complete();
    }
  });

  editor.addEventListener('keydown', (e) => {
    if (wikiKeydown(e) || slashKeydown(e)) return;
    if (e.key === 'Tab' && !e.shiftKey && suggest.value && firstBlock()?.contains(getSelection().anchorNode)) {
      e.preventDefault();
      applySuggest();
      return;
    }
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey) {
      if (k === 'u') return e.preventDefault(); // underline has no Markdown
      if (k === 's') {
        e.preventDefault();
        send().then(() => api.call('flush'));
        return;
      }
      if (plain) return;
      if (k === 'k') {
        e.preventDefault();
        return showLinkBox();
      }
      if (k === 'e') {
        e.preventDefault();
        return run('code');
      }
      if (e.shiftKey && k === 'x') {
        e.preventDefault();
        return run('strike');
      }
    }
    if (plain) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (closest('pre')) exec('insertText', '  ');
      else if (closest('li')) exec(e.shiftKey ? 'outdent' : 'indent');
      changed();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (closest('pre')) {
        e.preventDefault();
        exec('insertText', '\n');
        changed();
        return;
      }
      if (enterShortcut()) {
        e.preventDefault();
        changed();
      }
    }
  });

  editor.addEventListener('beforeinput', (e) => {
    if (plain || e.inputType !== 'insertText' || e.data !== ' ') return;
    if (spaceShortcut()) {
      e.preventDefault();
      changed();
    }
  });

  editor.addEventListener('input', () => {
    if (!plain) {
      fixTasks();
      wikiInput();
      slashInput();
      suggestInput();
    }
    changed();
  });
  editor.addEventListener('blur', () =>
    setTimeout(() => {
      hideWiki();
      hideSlash();
    }, 150),
  );

  editor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.call('menu', { editing: true });
  });

  // ---- header ----

  $('head').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.call('menu', { editing: false });
  });
  $('btnNew').addEventListener('click', () => api.call('new'));
  $('btnFold').addEventListener('click', () => api.call('collapse'));
  $('btnClose').addEventListener('click', async () => {
    if (sendTimer || sentDirty) await send();
    api.call('close');
  });
  $('btnFmt').addEventListener('click', () => {
    $('toolbar').hidden = !$('toolbar').hidden;
  });
  for (const b of document.querySelectorAll('#toolbar button')) {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection in the editor
    b.addEventListener('click', () => run(b.dataset.cmd));
  }
  $('linkOk').addEventListener('click', applyLink);
  $('linkInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyLink();
      changed();
    } else if (e.key === 'Escape') {
      $('linkBox').hidden = true;
      editor.focus();
    }
  });

  function startRename() {
    if (!$('dueBox').hidden) closeDueBox({ focusEditor: false });
    const input = $('titleInput');
    input.value = meta?.title || '';
    $('title').hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

  let titleClickTimer = null;
  // Press and drag the title to move the note; a press without movement stays a click / double-click.
  const TITLE_DRAG_PX = 4;
  let titleDrag = null;
  let titleDragged = false;
  $('title').addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    titleDrag = { id: event.pointerId, sx: event.screenX, sy: event.screenY, wx: window.screenX, wy: window.screenY, moving: false, frame: 0, x: 0, y: 0 };
    titleDragged = false;
    // Capture right away: a fast move out of the window must still report the release here.
    try { $('title').setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
  });
  $('title').addEventListener('pointermove', (event) => {
    const d = titleDrag;
    if (!d || event.pointerId !== d.id) return;
    // The button was released where we could not see it: never follow a mouse that is not pressed.
    if (!(event.buttons & 1)) {
      cancelTitleDrag();
      return;
    }
    const dx = event.screenX - d.sx;
    const dy = event.screenY - d.sy;
    if (!d.moving) {
      if (Math.abs(dx) < TITLE_DRAG_PX && Math.abs(dy) < TITLE_DRAG_PX) return;
      d.moving = true;
      if (titleClickTimer) clearTimeout(titleClickTimer);
      titleClickTimer = null;
    }
    d.x = d.wx + dx;
    d.y = d.wy + dy;
    if (!d.frame) {
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        api.call('moveTo', { x: d.x, y: d.y });
      });
    }
  });
  const endTitleDrag = (event) => {
    const d = titleDrag;
    if (!d || event.pointerId !== d.id) return;
    titleDrag = null;
    if (d.moving) {
      titleDragged = true; // the click that follows the drag is not a collapse
      if (d.frame) cancelAnimationFrame(d.frame);
      api.call('moveTo', { x: d.x, y: d.y });
    }
  };
  // Stop a press that ended where we could not see it (lost capture, focus moved away, button already up).
  function cancelTitleDrag() {
    const d = titleDrag;
    if (!d) return;
    titleDrag = null;
    if (d.frame) cancelAnimationFrame(d.frame);
    // No click follows these cases, so do not swallow the user's next real click.
    titleDragged = false;
    try { $('title').releasePointerCapture(d.id); } catch { /* not captured */ }
  }
  $('title').addEventListener('pointerup', endTitleDrag);
  $('title').addEventListener('pointercancel', endTitleDrag);
  $('title').addEventListener('lostpointercapture', (event) => {
    if (titleDrag && event.pointerId === titleDrag.id) cancelTitleDrag();
  });
  window.addEventListener('blur', cancelTitleDrag);
  $('title').addEventListener('click', (event) => {
    if (titleClickTimer) clearTimeout(titleClickTimer);
    titleClickTimer = null;
    if (titleDragged) {
      titleDragged = false;
      return;
    }
    if (event.detail >= 2) return;
    if (event.detail === 0) {
      api.call('collapse');
      return;
    }
    titleClickTimer = setTimeout(() => {
      titleClickTimer = null;
      api.call('collapse');
    }, TITLE_CLICK_DELAY_MS);
  });
  $('title').addEventListener('dblclick', () => {
    if (titleClickTimer) clearTimeout(titleClickTimer);
    titleClickTimer = null;
    startRename();
  });

  function endRename(save) {
    const input = $('titleInput');
    if (input.hidden) return;
    input.hidden = true;
    $('title').hidden = false;
    const title = input.value.trim();
    if (save && title && title !== meta?.title) {
      api.call('rename', { title }).then((r) => (r?.ok ? applyMeta(r.meta) : status(r?.message || '이름을 바꾸지 못했습니다.', { error: true })));
    }
  }

  $('titleInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') endRename(true);
    else if (e.key === 'Escape') endRename(false);
  });
  $('titleInput').addEventListener('blur', () => endRename(true));

  // ---- the "정보…" panel (#113): title, where the file is, times, size ----

  const infoTime = (ms) => (ms == null ? '-' : new Date(ms).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }));
  const infoSize = (n) => (n == null ? '-' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

  function showInfo(info) {
    if (!info) return;
    const list = $('infoList');
    list.textContent = '';
    for (const [k, v] of [['제목', info.title], ['위치', info.file], ['만든 때', infoTime(info.created)], ['바뀐 때', infoTime(info.modified)], ['크기', infoSize(info.size)]]) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      list.append(dt, dd);
    }
    $('infoBox').hidden = false;
    $('infoClose').focus();
  }

  function hideInfo() {
    $('infoBox').hidden = true;
    editor.focus();
  }

  $('infoClose').addEventListener('click', hideInfo);
  $('infoCopy').addEventListener('click', () =>
    api.call('copyPath').then((r) => status(r?.ok ? '경로를 복사했습니다.' : r?.message || '복사하지 못했습니다.', { error: !r?.ok, ms: 2000 }))
  );
  $('infoBox').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideInfo();
  });

  // ---- events from the widget ----

  api.on((name, p) => {
    switch (name) {
      case 'reload':
        show(p);
        sentDirty = false;
        if (!conflict) banner(null);
        status('다른 프로그램에서 바뀐 내용을 불러왔습니다.', { ms: 2500 });
        break;
      case 'meta':
        applyMeta(p);
        break;
      case 'style':
        applyStyle(p);
        break;
      case 'saved':
        $('status').classList.remove('error');
        status('저장됨', { ms: 900 });
        break;
      case 'save-error':
        status(p.message, { error: true });
        break;
      case 'conflict':
        conflict = true;
        banner('다른 프로그램에서 이 노트 파일이 바뀌었습니다. 이 창에는 아직 저장하지 않은 내용이 있습니다.', [
          { label: '바뀐 내용 보기', run: () => resolve('theirs') },
          { label: '내 내용으로 저장', run: () => resolve('mine') },
          { label: '내 내용은 사본으로', run: () => resolve('copy') },
        ]);
        break;
      case 'missing':
        banner('노트 파일이 없어졌습니다 (다른 곳에서 지웠거나 옮김).', [
          { label: '이 내용으로 다시 저장', run: () => resolve('mine') },
          { label: '창 닫기', run: () => api.call('close') },
        ]);
        break;
      case 'info':
        showInfo(p);
        break;
      case 'notice':
        status(p.message, { ms: 3500 });
        break;
      case 'rename':
        startRename();
        break;
      case 'dueBox':
        openDueBox(p?.focus);
        break;
      case 'complete':
        complete();
        break;
      default:
        break;
    }
  });

  async function init() {
    document.execCommand('defaultParagraphSeparator', false, 'p');
    const r = await api.call('init');
    if (!r?.ok) {
      editor.textContent = r?.message || '노트를 열 수 없습니다.';
      return;
    }
    applyMeta(r.meta);
    applyStyle(r.style);
    show(r);
    ready = true;
  }

  init();
})();
