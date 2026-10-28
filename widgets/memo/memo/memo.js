// Memo window (#75): WYSIWYG editing in a contenteditable. The page never writes files: it sends its content as a
// plain tree (the widget turns it into Markdown and saves it) and asks the widget to store pasted / dropped files.
(() => {
  const api = window.memo;
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const SEND_MS = 200;

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
    $('title').title = m.conflictCopy ? '같은 노트의 다른 사본입니다(예: OneDrive 충돌 사본). 내용을 비교해 필요 없는 쪽을 휴지통으로 옮기세요.' : m.title;
    document.title = m.title;
  }

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

  // ---- keys ----

  addEventListener('keydown', (e) => document.body.classList.toggle('ctrl', e.ctrlKey));
  addEventListener('keyup', (e) => document.body.classList.toggle('ctrl', e.ctrlKey));

  editor.addEventListener('keydown', (e) => {
    if (wikiKeydown(e)) return;
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
    }
    changed();
  });
  editor.addEventListener('blur', () => setTimeout(hideWiki, 150));

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
    const input = $('titleInput');
    input.value = meta?.title || '';
    $('title').hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

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
