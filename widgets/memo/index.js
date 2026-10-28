// Memo widget (#75): sticky notes on the desktop, one window per memo, edited in place (WYSIWYG) and saved as
// Markdown files in the user's Documents folder (Documents\Desk Widgets\스티키 노트 by default). Windows are the widget's
// own pages (ctx.createWidgetWindow), not theme packages: a memo window needs the dropped files' paths, large pasted
// images and per-window close / pin calls, which the theme host's isolated pages and 64KB call limit do not offer.
// Since #109 all memo windows and the list share one renderer process (ctx.createSharedWidgetWindow, when the engine
// has it): one more note costs ~2 MB instead of ~16 MB. If that process crashes, every note is saved and reopened.
//
// The files are the truth: lib/library.js (folder, names, assets, archive), lib/session.js (saving, outside changes),
// lib/markdown.js + lib/html.js (Markdown <-> sanitized HTML). This file wires windows, menus and settings.
const fs = require('fs');
const path = require('path');
const md = require('./lib/markdown');
const { sanitizeHtml, sanitizeTree } = require('./lib/html');
const { Library, IMAGE_TYPES } = require('./lib/library');
const { MemoSession } = require('./lib/session');
const F = require('./lib/files');
const S = require('./lib/settings');
const { migrateDefaultFolder } = require('./lib/migrate');
const { moveNotes } = require('./lib/move-notes');
const TM = require('./lib/title-migration');

const SUBFOLDERS = ['보관함']; // moved along with the notes when the note folder changes

const CHANNEL = 'memo-widget';
const MEMO_SIZE = { width: 260, height: 240, minWidth: 160, minHeight: 34 };
const LIST_SIZE = { width: 300, height: 420, minWidth: 220, minHeight: 200 };
const COLLAPSED_HEIGHT = 34;
const MAX_INLINE_IMAGE = 8 * 1024 * 1024; // shown in the window; larger images are kept but shown as a placeholder
const IMAGE_CACHE_BYTES = 48 * 1024 * 1024;
const MENU_DEDUPE_MS = 400;
// After the shared renderer crashed the windows come back after this delay, at most CRASH_LIMIT times a minute
// (a page that crashes on load must not loop).
const REOPEN_DELAY_MS = 500;
const CRASH_LIMIT = 3;
// Opening these runs a program: ask first.
const RISKY = /\.(exe|msi|msix|appx|bat|cmd|com|scr|pif|cpl|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|jar|msc|inf|scf|application|appref-ms|gadget|iso|img|vhd|vhdx)$/i;

/** @param {object} ctx  the engine context; deps.electron replaces the electron module in tests */
function create(ctx, deps = {}) {
  const E = () => deps.electron || require('electron');
  const store = ctx.createStore({
    file: path.join(ctx.dataDir, 'settings.json'), defaults: S.DEFAULTS, sanitize: S.sanitize, upgrade: S.upgrade,
    sync: {
      name: 'settings',
      // Window state, open and pinned flags stay on this PC; only a note's colour is shared.
      collections: { memos: { map: true, shared: ['color'] } },
      shared: ['opacity', 'defaultColor', 'fontSize'],
    },
  });
  let running = false;
  let stopping = false;
  let library = null;
  let listWin = null;
  const open = new Map(); // id -> { win, wc, session, focus }; win is null while the window is being opened
  const byContents = new Map(); // webContents id -> { kind: 'memo', id } | { kind: 'list' }
  const created = new Set(); // memos made by "새 노트" in this run (an empty one is removed when closed)
  const imageCache = new Map(); // path -> { mtimeMs, url }
  let imageBytes = 0;
  let watchers = [];
  let scanTimer = null;
  let pollTimer = null;
  let scanning = null;
  let lastMenuAt = 0;
  let searchQuery = '';
  let crashes = []; // times the shared renderer was lost (#109)
  let listOpening = null;

  const log = (msg) => console.error(`memo widget: ${msg}`);
  const settings = () => store.load();
  const memoState = (id) => settings().memos[id] || {};
  const setMemoState = (id, patch) => {
    const all = settings().memos;
    store.save({ memos: { ...all, [id]: { ...(all[id] || {}), ...patch } } });
  };
  // The note folder is always on this PC (the user's choice or the default); sync never moves it (#108).
  const notesDir = () => settings().notesDir || S.defaultNotesDir(E().app.getPath('documents'));
  const colorOf = (id) => memoState(id).color || settings().defaultColor;
  const alive = (win) => win && !win.isDestroyed();
  const send = (win, name, payload) => alive(win) && win.webContents.send(`${CHANNEL}:event`, name, payload);

  function newLibrary() {
    library = new Library({
      dir: notesDir(),
      ids: { load: () => settings().pathIds, save: (map) => store.save({ pathIds: map }) },
      trash: (file) => E().shell.trashItem(file),
    });
  }

  // ---- rendering a memo for its window ----

  function imageUrl(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type || st.size > MAX_INLINE_IMAGE) return null;
    const hit = imageCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.url;
    const url = `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
    imageCache.set(file, { mtimeMs: st.mtimeMs, url });
    imageBytes += url.length;
    for (const [k, v] of imageCache) {
      if (imageBytes <= IMAGE_CACHE_BYTES) break;
      imageCache.delete(k);
      imageBytes -= v.url.length;
    }
    return url;
  }

  /** What the window shows of a body: sanitized HTML (Markdown) or the text (.txt). */
  function view(id, body) {
    const m = library.get(id);
    if (!m) return { text: '' };
    if (m.ext !== 'md') return { text: body };
    const assetsDir = library.assetsName(m);
    const ast = md.parse(body);
    const images = new Map();
    for (const ref of md.imageRefs(ast, assetsDir)) {
      const file = ref.kind === 'asset' ? library.resolveAsset(id, ref.value) : library.resolveRelative(id, ref.value);
      const url = file && imageUrl(file);
      if (url) images.set(ref.key, url);
    }
    const wikiExists = (target) => Boolean(library.findByTitle(target));
    return { html: sanitizeHtml(md.renderHtml(ast, { assetsDir, images, wikiExists })) };
  }

  function meta(id) {
    const m = library.get(id);
    const st = memoState(id);
    return {
      id,
      title: m.title,
      ext: m.ext,
      archived: m.archived,
      assetsDir: library.assetsName(m),
      color: colorOf(id),
      alwaysOnTop: Boolean(st.alwaysOnTop),
      collapsed: Boolean(st.collapsed),
      conflictCopy: Boolean(m.conflictOf),
    };
  }

  const style = () => ({ opacity: settings().opacity, fontSize: settings().fontSize });

  // ---- memo windows ----

  function newBounds(near) {
    const { screen } = E();
    if (alive(near)) {
      const b = near.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      const x = Math.min(b.x + 28, wa.x + wa.width - MEMO_SIZE.width);
      const y = Math.min(b.y + 28, wa.y + wa.height - MEMO_SIZE.height);
      return { x, y, width: MEMO_SIZE.width, height: MEMO_SIZE.height };
    }
    const wa = screen.getPrimaryDisplay().workArea;
    const n = open.size % 8;
    return { x: Math.round(wa.x + wa.width / 2 - MEMO_SIZE.width / 2 + n * 28), y: Math.round(wa.y + wa.height / 3 + n * 28), width: MEMO_SIZE.width, height: MEMO_SIZE.height };
  }

  /** A window of this widget: in the shared renderer process when the engine offers it (#109), else on its own. */
  function widgetWindow(opts) {
    if (typeof ctx.createSharedWidgetWindow === 'function') return ctx.createSharedWidgetWindow(opts);
    return Promise.resolve(ctx.createWidgetWindow(opts));
  }

  /**
   * Opens a memo's window (or focuses it). The window arrives a moment later; until then entry.win is null and
   * what is sent to it is dropped (the page asks for its content with 'init' once loaded).
   */
  function openMemo(id, { focus = false, near = null } = {}) {
    const m = library.get(id);
    if (!m || m.archived) return null;
    const existing = open.get(id);
    if (existing) {
      if (focus) {
        if (alive(existing.win)) focusWindow(existing.win);
        else existing.focus = true;
      }
      return existing;
    }
    if (!memoState(id).bounds) setMemoState(id, { bounds: newBounds(near) });
    const entry = { win: null, wc: null, session: null, focus };
    entry.session = new MemoSession({
      library,
      id,
      // The session sends Markdown bodies; the window gets them as sanitized HTML.
      send: (name, payload) => send(entry.win, name, name === 'reload' ? view(id, payload.body) : payload),
      onError: (err) => log(`save ${id}: ${err.message}`),
    });
    open.set(id, entry);
    if (!stopping) setMemoState(id, { open: true });
    widgetWindow({
      html: path.join(ctx.dir, 'memo', 'memo.html'),
      preload: path.join(ctx.dir, 'preload.js'),
      size: MEMO_SIZE,
      getBounds: () => memoState(id).bounds || null,
      saveBounds: (bounds) => setMemoState(id, { bounds }),
    })
      .then((win) => attachMemo(id, entry, win))
      .catch((err) => {
        log(`open ${id}: ${err.message}`);
        if (alive(entry.win)) entry.win.destroy();
        if (open.get(id) !== entry) return;
        open.delete(id);
        entry.session.dispose();
        pushList();
      });
    pushList();
    return entry;
  }

  function attachMemo(id, entry, win) {
    if (open.get(id) !== entry || !running) {
      // Closed, archived or stopped while the window was on its way.
      if (alive(win)) win.destroy();
      return;
    }
    win.setMaximizable(false); // a double click on the title bar must not fill the screen
    const wc = win.webContents;
    entry.win = win;
    entry.wc = wc;
    const { session } = entry;
    byContents.set(wc.id, { kind: 'memo', id });
    if (memoState(id).alwaysOnTop) win.setAlwaysOnTop(true);
    if (entry.focus) win.once('ready-to-show', () => focusWindow(win));
    win.on('system-context-menu', (event) => {
      event.preventDefault();
      memoMenu(id, false);
    });
    win.on('blur', () => autoTitle(id).catch((err) => log(`title ${id}: ${err.message}`)));
    wc.on('render-process-gone', (_event, details) => open.get(id) === entry && rendererGone(details));
    // The shared process died between making this window and here: its crash report came before this listener.
    if (wc.isCrashed?.()) setImmediate(() => open.get(id) === entry && rendererGone({ reason: 'crashed' }));
    win.on('closed', () => {
      byContents.delete(wc.id);
      if (open.get(id) === entry) open.delete(id);
      session.flushSync();
      session.dispose();
      if (!stopping) pushList();
    });
    pushList();
  }

  /**
   * The shared renderer crashed (#109): every memo window and the list show nothing. What the pages sent is saved,
   * the windows close and open again in a new process at the same place ("open" in the settings stays true). Keys
   * typed in the last moment before the crash that the page had not sent yet are lost, as with any crashed page.
   * Every window reports the crash; the first report closes all of them, so the others are no longer current.
   */
  function rendererGone(details) {
    if (!running || stopping || details?.reason === 'clean-exit') return; // a normal end (quitting) reopens nothing
    const now = Date.now();
    crashes = [...crashes.filter((t) => now - t < 60000), now];
    const giveUp = crashes.length > CRASH_LIMIT;
    log(`renderer gone (${details?.reason || 'unknown'}); ${giveUp ? 'not reopening again' : 'reopening the notes'}`);
    const ids = [...open.keys()];
    const hadList = alive(listWin);
    stopping = true; // closing for the restart: "open" stays as it is
    try {
      for (const entry of [...open.values()]) {
        entry.session.flushSync();
        stoppingOne(entry);
      }
      if (hadList) {
        listWin.destroy();
        listWin = null;
      }
    } finally {
      stopping = false;
    }
    if (giveUp) return; // they come back with the next start of the widget
    setTimeout(() => {
      if (!running) return;
      for (const id of ids) openMemo(id);
      if (hadList) showList();
    }, REOPEN_DELAY_MS).unref?.();
  }

  function focusWindow(win) {
    if (!alive(win)) return;
    ctx.beforeFocus?.(win);
    win.show();
    win.focus();
  }

  /** The user closed a memo window: save, rename from the first line if still automatic, forget an empty new memo. */
  async function closeMemo(id) {
    const entry = open.get(id);
    setMemoState(id, { open: false });
    if (!entry) return;
    await entry.session.flush().catch(() => {});
    await autoTitle(id).catch(() => {});
    const m = library.get(id);
    // Only a body the window has read counts as empty: a window closed before its page loaded removes nothing.
    if (m && created.has(id) && !entry.session.pending && entry.session.diskBody !== null && !entry.session.diskBody.trim() && !library.hasAssets(id)) {
      try {
        fs.unlinkSync(m.file); // an untouched new memo: nothing to keep
        library.memos.delete(id);
      } catch {}
    }
    if (alive(entry.win)) entry.win.close();
    else if (open.get(id) === entry) {
      stoppingOne(entry); // closed before its window arrived
      pushList();
    }
  }

  /** A memo still named automatically takes the title of its first line (when the window loses focus or closes). */
  async function autoTitle(id) {
    const entry = open.get(id);
    const m = library.get(id);
    if (!entry || !m || m.ext !== 'md' || !memoState(id).autoTitle || entry.session.conflict || entry.session.missing) return;
    await entry.session.flush();
    const title = F.titleFromText(md.toPlainText(entry.session.diskBody || ''));
    if (title === F.DEFAULT_TITLE || title === m.title || title.toLowerCase() === m.title.replace(/ \(\d+\)$/, '').toLowerCase()) return;
    const before = linkNames(id);
    await library.rename(id, title);
    entry.session.diskHash = (await library.read(id)).hash;
    send(entry.win, 'meta', meta(id));
    await afterRename(id, before);
  }

  /**
   * How other memos link to a memo: its title (null when [[title]] means another memo of the same title, #113) and
   * its file name without extension (relative links; [[file name]] as Obsidian writes it, when it means this memo).
   */
  function linkNames(id) {
    const m = library.get(id);
    if (!m) return null;
    const file = path.basename(m.file, path.extname(m.file));
    const means = (name) => library.findByTitle(name)?.id === id;
    return { title: means(m.title) ? m.title : null, file, wikiFile: means(file) };
  }

  /** After a memo got a new name: links to it in other memos follow ([[옛 이름]] -> [[새 이름]]), the list updates. */
  async function afterRename(id, before) {
    const m = library.get(id);
    const now = m && { title: m.title, file: path.basename(m.file, path.extname(m.file)) };
    if (!m || !before || (now.title === before.title && now.file === before.file)) return pushList();
    const changed = await relinkOthers(before, now, id);
    const entry = open.get(id);
    if (entry && changed) send(entry.win, 'notice', { message: `다른 노트 ${changed}개의 링크를 새 이름으로 고쳤습니다.` });
    pushList();
  }

  /**
   * Rewrites links to a renamed memo in every other Markdown memo (from / to: linkNames()). An open memo is changed
   * through its session (saved first, then shown again); one with keys typed but not sent yet is left alone so nothing
   * typed is lost. Returns how many memos were changed.
   */
  async function relinkOthers(from, to, exceptId) {
    const keys = [from.title, from.file].filter(Boolean).map(md.wikiKey);
    const relink = (body) => md.relinkTitle(body, from.title, to.title, from.file, to.file, from.wikiFile);
    let changed = 0;
    for (const other of library.list()) {
      if (other.id === exceptId || other.ext !== 'md' || other.tooBig || !(other.links || []).some((k) => keys.includes(k))) continue;
      try {
        const entry = open.get(other.id);
        if (entry) {
          await entry.session.flush();
          if (entry.session.hasLocalEdits() || entry.session.conflict || entry.session.missing) continue;
          const before = entry.session.diskBody ?? (await library.read(other.id)).body;
          const after = relink(before);
          if (after === before) continue;
          entry.session.diskHash = await library.write(other.id, after);
          entry.session.diskBody = after;
          send(entry.win, 'reload', view(other.id, after));
        } else {
          const { body } = await library.read(other.id);
          const after = relink(body);
          if (after === body) continue;
          await library.write(other.id, after);
        }
        changed++;
      } catch (err) {
        log(`relink ${other.id}: ${err.message}`);
      }
    }
    return changed;
  }

  async function newMemo(near = null) {
    const m = await library.create({ title: F.DEFAULT_TITLE });
    created.add(m.id);
    setMemoState(m.id, { autoTitle: true, color: settings().defaultColor });
    openMemo(m.id, { focus: true, near });
    pushList();
    return m.id;
  }

  async function renameMemo(id, title) {
    const entry = open.get(id);
    if (entry) await entry.session.flush();
    const before = linkNames(id);
    await library.rename(id, title);
    setMemoState(id, { autoTitle: false });
    if (entry) {
      entry.session.diskHash = (await library.read(id)).hash;
      send(entry.win, 'meta', meta(id));
    }
    await afterRename(id, before);
    return meta(id);
  }

  function setColor(id, color) {
    if (!S.COLORS.includes(color)) return;
    setMemoState(id, { color });
    const entry = open.get(id);
    if (entry) send(entry.win, 'meta', meta(id));
    pushList();
  }

  function setPinned(id, on) {
    setMemoState(id, { alwaysOnTop: Boolean(on) });
    const entry = open.get(id);
    if (entry && alive(entry.win)) {
      entry.win.setAlwaysOnTop(Boolean(on));
      send(entry.win, 'meta', meta(id));
    }
  }

  function setCollapsed(id, on) {
    const entry = open.get(id);
    const st = memoState(id);
    if (!entry || !alive(entry.win) || Boolean(st.collapsed) === Boolean(on)) return;
    const b = entry.win.getBounds();
    if (on) {
      setMemoState(id, { collapsed: true, expandedHeight: b.height });
      entry.win.setBounds({ ...b, height: COLLAPSED_HEIGHT });
    } else {
      setMemoState(id, { collapsed: false });
      entry.win.setBounds({ ...b, height: Math.max(st.expandedHeight || MEMO_SIZE.height, 80) });
    }
    send(entry.win, 'meta', meta(id));
  }

  async function archiveMemo(id) {
    const entry = open.get(id);
    if (entry) {
      await entry.session.flush();
      setMemoState(id, { open: false });
      stoppingOne(entry);
    }
    await library.archive(id);
    pushList();
  }

  // Closes a window without the "user closed it" steps (already saved).
  function stoppingOne(entry) {
    open.delete([...open.entries()].find(([, e]) => e === entry)?.[0]);
    if (entry.wc) byContents.delete(entry.wc.id);
    entry.session.dispose();
    if (alive(entry.win)) entry.win.destroy();
  }

  async function restoreMemo(id) {
    await library.restore(id);
    pushList();
  }

  async function trashMemo(id, parent) {
    const m = library.get(id);
    if (!m) return false;
    const answer = await ctx.confirm(parent, {
      type: 'warning',
      title: '스티키 노트',
      message: `"${m.title}" 노트를 휴지통으로 옮길까요?`,
      detail: library.hasAssets(id) ? '노트 파일과 이미지·첨부 폴더를 휴지통으로 옮깁니다. 휴지통에서 되살릴 수 있습니다.' : '휴지통에서 되살릴 수 있습니다.',
      buttons: ['휴지통으로', '취소'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer !== 0) return false;
    const entry = open.get(id);
    if (entry) {
      await entry.session.flush().catch(() => {});
      stoppingOne(entry);
    }
    await library.trash(id);
    const all = { ...settings().memos };
    delete all[id];
    store.save({ memos: all });
    pushList();
    return true;
  }

  async function convertToMd(id) {
    const entry = open.get(id);
    if (entry) await entry.session.flush();
    await library.convertToMd(id);
    setMemoState(id, { autoTitle: false });
    if (entry) {
      const { body } = await entry.session.load();
      send(entry.win, 'meta', meta(id));
      send(entry.win, 'reload', view(id, body));
    }
    pushList();
  }

  /**
   * What the "정보…" panel of a note shows (#113): its title, where its file is, when it was made (front matter
   * "created:", else the file's own creation time), last changed and its size in bytes.
   */
  function noteInfo(id) {
    const m = library.get(id);
    if (!m) return null;
    let st = null;
    try {
      st = fs.statSync(m.file);
    } catch {}
    return { title: m.title, file: m.file, created: m.created ?? (st ? Math.round(st.birthtimeMs) : null), modified: st ? Math.round(st.mtimeMs) : m.mtimeMs, size: st ? st.size : m.size ?? null };
  }

  // ---- right-click menus ----

  function dedupe() {
    if (Date.now() - lastMenuAt < MENU_DEDUPE_MS) return false;
    lastMenuAt = Date.now();
    return true;
  }

  function memoMenu(id, editing) {
    const entry = open.get(id);
    const m = library.get(id);
    if (!entry || !m || !dedupe()) return;
    const st = memoState(id);
    const items = [
      ...(editing
        ? [
            { label: '잘라내기', role: 'cut' },
            { label: '복사', role: 'copy' },
            { label: '붙여넣기', role: 'paste' },
            { label: '모두 선택', role: 'selectAll' },
            { type: 'separator' },
          ]
        : []),
      { label: '새 노트', click: () => newMemo(entry.win).catch((err) => log(err.message)) },
      { label: '노트 목록', click: () => showList() },
      { type: 'separator' },
      { label: '항상 위에 표시', type: 'checkbox', checked: Boolean(st.alwaysOnTop), click: (item) => setPinned(id, item.checked) },
      { label: '색', submenu: S.COLORS.map((c) => ({ label: S.COLOR_NAMES[c], type: 'radio', checked: colorOf(id) === c, click: () => setColor(id, c) })) },
      { label: st.collapsed ? '펼치기' : '접기', click: () => setCollapsed(id, !st.collapsed) },
      { label: '이름 바꾸기…', click: () => send(entry.win, 'rename', {}) },
      ...(m.ext === 'txt' ? [{ label: 'Markdown 노트로 바꾸기', click: () => convertToMd(id).catch((err) => send(entry.win, 'save-error', { message: err.message })) }] : []),
      { label: '정보…', click: () => send(entry.win, 'info', noteInfo(id)) },
      { label: '탐색기에서 보기', click: () => E().shell.showItemInFolder(m.file) },
      { type: 'separator' },
      { label: '보관함으로 옮기기', click: () => archiveMemo(id).catch((err) => send(entry.win, 'save-error', { message: err.message })) },
      { label: '휴지통으로 옮기기…', click: () => trashMemo(id, entry.win).catch((err) => send(entry.win, 'save-error', { message: err.message })) },
      { label: '노트 닫기', click: () => closeMemo(id) },
    ];
    ctx.popupMenu(entry.win, items);
  }

  function listMenu() {
    if (!alive(listWin) || !dedupe()) return;
    ctx.popupMenu(listWin, [
      { label: '새 노트', click: () => newMemo(listWin).catch((err) => log(err.message)) },
      { label: '항상 위에 표시', type: 'checkbox', checked: settings().listAlwaysOnTop, click: (item) => setListPinned(item.checked) },
      { label: '노트 폴더 열기', click: () => openNotesFolder() },
      { type: 'separator' },
      { label: '목록 닫기', click: () => closeList() },
    ]);
  }

  // ---- list window ----

  function listItems() {
    const q = searchQuery.trim().toLowerCase();
    return library
      .list()
      .filter((m) => !q || m.title.toLowerCase().includes(q) || (m.search || '').includes(q))
      .map((m) => {
        const st = memoState(m.id);
        return {
          id: m.id,
          title: m.title,
          ext: m.ext,
          archived: m.archived,
          preview: m.preview,
          mtimeMs: m.mtimeMs,
          open: open.has(m.id),
          color: colorOf(m.id),
          listPinned: Boolean(st.listPinned),
          conflictCopy: Boolean(m.conflictOf),
          tooBig: Boolean(m.tooBig),
          backlinks: library.backlinks(m.id).map((o) => ({ id: o.id, title: o.title, archived: o.archived })),
        };
      })
      .sort((a, b) => Number(b.listPinned) - Number(a.listPinned) || b.mtimeMs - a.mtimeMs);
  }

  const listView = () => ({ items: listItems(), view: settings().listView, dir: notesDir(), query: searchQuery, alwaysOnTop: settings().listAlwaysOnTop });

  function pushList() {
    if (alive(listWin) && library) send(listWin, 'list', listView());
  }

  /** Shows the list window (the first time it arrives a moment later); resolves to the window. */
  function showList() {
    store.save({ listOpen: true });
    if (alive(listWin)) {
      focusWindow(listWin);
      return Promise.resolve(listWin);
    }
    if (listOpening) return listOpening;
    listOpening = widgetWindow({
      html: path.join(ctx.dir, 'list', 'list.html'),
      preload: path.join(ctx.dir, 'preload.js'),
      size: LIST_SIZE,
      getBounds: () => settings().listBounds,
      saveBounds: (bounds) => store.save({ listBounds: bounds }),
    })
      .then((win) => {
        if (!running || !settings().listOpen) {
          // Stopped, or the list was closed again while its window was on its way.
          if (alive(win)) win.destroy();
          return null;
        }
        listWin = win;
        win.setMaximizable(false);
        const wcId = win.webContents.id;
        byContents.set(wcId, { kind: 'list' });
        if (settings().listAlwaysOnTop) win.setAlwaysOnTop(true);
        win.on('system-context-menu', (event) => {
          event.preventDefault();
          listMenu();
        });
        win.webContents.on('render-process-gone', (_event, details) => listWin === win && rendererGone(details));
        win.on('closed', () => {
          byContents.delete(wcId);
          if (listWin === win) listWin = null;
        });
        return win;
      })
      .catch((err) => {
        log(`list window: ${err.message}`);
        return null;
      })
      .finally(() => {
        listOpening = null;
      });
    return listOpening;
  }

  function closeList() {
    store.save({ listOpen: false });
    if (alive(listWin)) listWin.close();
  }

  function setListPinned(on) {
    store.save({ listAlwaysOnTop: Boolean(on) });
    if (alive(listWin)) listWin.setAlwaysOnTop(Boolean(on));
    pushList();
  }

  function openNotesFolder() {
    fs.mkdirSync(notesDir(), { recursive: true });
    return E().shell.openPath(notesDir());
  }

  // ---- watching the folder ----

  function watch() {
    unwatch();
    // The engine's file store watches the note folder (#108); its own writes from other PCs arrive here too.
    if (notesStore) {
      watchers.push({ close: notesStore.onChange(() => scheduleScan()) });
      return;
    }
    for (const dir of [library.dir, library.archiveDir]) {
      try {
        const w = fs.watch(dir, { persistent: false }, (_type, name) => {
          if (name && String(name).startsWith('.')) return; // our temporary files
          scheduleScan();
        });
        w.on('error', () => scheduleScan());
        watchers.push(w);
      } catch {
        // the archive folder does not exist yet; the periodic scan sees it later
      }
    }
  }

  function unwatch() {
    for (const w of watchers) w.close();
    watchers = [];
  }

  function scheduleScan(delay = 300) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan().catch((err) => log(`scan: ${err.message}`)), delay);
  }

  /** Reads the folder and passes outside changes to the open memos. */
  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      const hadArchive = fs.existsSync(library.archiveDir);
      const changes = await library.scan();
      if (!hadArchive && fs.existsSync(library.archiveDir)) watch();
      const touched = new Set([...changes.changed, ...changes.moved, ...changes.removed, ...changes.added]);
      for (const id of touched) {
        const entry = open.get(id);
        if (!entry) continue;
        const m = library.get(id);
        if (m && m.archived) {
          // Moved into the archive folder from outside: the window closes, the text is there.
          await entry.session.flush().catch(() => {});
          stoppingOne(entry);
          continue;
        }
        if (m && changes.moved.includes(id)) send(entry.win, 'meta', meta(id));
        await entry.session.external();
      }
      pushList();
    })();
    try {
      await scanning;
    } finally {
      scanning = null;
    }
  }

  // ---- calls from the pages ----

  function senderOf(event) {
    return byContents.get(event.sender.id) || null;
  }

  async function addFiles(id, paths) {
    const added = [];
    const errors = [];
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 50)) {
      if (typeof p !== 'string' || !p) continue;
      try {
        const r = await library.addAssetFile(id, p);
        const file = library.resolveAsset(id, r.name);
        added.push({ name: r.name, image: r.image, src: r.image && file ? imageUrl(file) : null });
      } catch (err) {
        errors.push(err.code === 'ENOENT' ? `${path.basename(p)}: 파일을 찾을 수 없습니다.` : err.message);
      }
    }
    return { added, errors };
  }

  async function openAsset(id, name, win) {
    const file = library.resolveAsset(id, name);
    if (!file) return { ok: false, message: '첨부 파일을 찾을 수 없습니다.' };
    if (RISKY.test(file)) {
      const answer = await ctx.confirm(win, {
        type: 'warning',
        title: '첨부 파일 열기',
        message: `"${path.basename(file)}"을(를) 열까요?`,
        detail: '프로그램을 실행하는 파일입니다. 믿을 수 있는 파일만 여세요.',
        buttons: ['열기', '취소'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (answer !== 0) return { ok: false };
    }
    const error = await E().shell.openPath(file);
    return error ? { ok: false, message: error } : { ok: true };
  }

  function openLocalLink(id, href) {
    // A link to another memo in the notes folder opens that memo; anything else stays closed.
    const file = library.resolveRelative(id, href);
    const target = file && library.list().find((m) => path.resolve(m.file).toLowerCase() === path.resolve(file).toLowerCase());
    if (target && !target.archived) {
      openMemo(target.id, { focus: true });
      return { ok: true };
    }
    return { ok: false, message: '노트 안의 링크는 웹 주소(http·https)·메일 주소·다른 노트·첨부 파일만 열 수 있습니다.' };
  }

  /** Memo titles for the [[ autocomplete: titles starting with the text first, then containing it; newest first. */
  function suggestions(selfId, q) {
    const key = q.trim().normalize('NFC').toLowerCase();
    const items = library
      .list()
      .filter((m) => m.id !== selfId && !m.archived && !m.conflictOf)
      .map((m) => ({ m, t: m.title.normalize('NFC').toLowerCase() }))
      .filter(({ t }) => !key || t.includes(key))
      .sort((a, b) => Number(!a.t.startsWith(key)) - Number(!b.t.startsWith(key)) || b.m.mtimeMs - a.m.mtimeMs)
      .slice(0, 8)
      .map(({ m }) => ({ title: m.title, preview: (m.preview || '').slice(0, 60) }));
    const exact = library.findByTitle(q);
    const name = F.sanitizeTitle(q, '');
    if (name && !exact) items.push({ title: name, create: true });
    return items;
  }

  /** Ctrl+click on [[제목]]: open that memo; a missing one is created (like Obsidian); an archived one is not opened. */
  async function openWiki(target, win) {
    if (!md.wikiKey(target)) return { ok: false, message: '링크에 노트 이름이 없습니다.' };
    const m = library.findByTitle(target);
    if (m && m.archived) return { ok: false, message: `"${m.title}" 노트는 보관함에 있습니다. 목록의 보관함에서 꺼내 주세요.` };
    if (m) {
      openMemo(m.id, { focus: true, near: win });
      return { ok: true };
    }
    // "[[폴더/새 노트.md#소제목]]" creates "새 노트" (keeping the case the link was written in).
    const title = F.sanitizeTitle(
      target
        .split('#')[0]
        .split(/[\\/]/)
        .pop()
        .replace(/\.(md|txt)\s*$/i, ''),
    );
    const created = await library.create({ title });
    setMemoState(created.id, { autoTitle: false, color: settings().defaultColor });
    openMemo(created.id, { focus: true, near: win });
    pushList();
    return { ok: true, created: true };
  }

  function bodyFrom(id, arg) {
    const m = library.get(id);
    if (!m) return null;
    if (m.ext !== 'md') return typeof arg?.text === 'string' ? arg.text.replace(/\r\n?/g, '\n') : null;
    if (!arg?.tree) return null;
    return md.toMarkdown(sanitizeTree(arg.tree), { assetsDir: library.assetsName(m) });
  }

  async function memoCall(id, name, arg, win) {
    const entry = open.get(id);
    if (!entry) return { ok: false, message: '노트 창이 닫혔습니다.' };
    const { session } = entry;
    switch (name) {
      case 'init': {
        if (!library.get(id)) return { ok: false, message: '노트 파일이 없습니다.' };
        const { body } = await session.load();
        return { ok: true, meta: meta(id), style: style(), ...view(id, body) };
      }
      case 'dirty':
        session.markDirty();
        return { ok: true };
      case 'update': {
        const body = bodyFrom(id, arg);
        if (body !== null) session.update(body);
        return { ok: true };
      }
      case 'flush':
        await session.flush().catch(() => {});
        return { ok: true };
      case 'resolve': {
        const body = bodyFrom(id, arg);
        const r = await session.resolve(String(arg?.choice || ''), body ?? undefined, {
          createCopy: async (text) => {
            const m = library.get(id);
            const copy = await library.create({ title: `${m.title} (내 사본)`, body: text });
            setMemoState(copy.id, { color: colorOf(id) });
            openMemo(copy.id, { near: win });
            return copy.id;
          },
        });
        pushList();
        return { ok: true, copyId: r.copyId || null };
      }
      case 'addImage': {
        const type = String(arg?.type || '');
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[type];
        if (!ext || !arg?.bytes) return { ok: false, message: '붙여넣을 수 있는 이미지는 PNG·JPEG·GIF·WebP입니다.' };
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        const wanted = arg.name && IMAGE_TYPES[path.extname(String(arg.name)).toLowerCase()] ? String(arg.name) : `image-${stamp}${ext}`;
        const assetName = await library.addAssetBytes(id, wanted, arg.bytes);
        const file = library.resolveAsset(id, assetName);
        return { ok: true, name: assetName, src: file ? imageUrl(file) : null };
      }
      case 'addFiles':
        return { ok: true, ...(await addFiles(id, arg?.paths)) };
      case 'pickFiles': {
        const res = await E().dialog.showOpenDialog(win, { title: '노트에 넣을 파일', properties: ['openFile', 'multiSelections'] });
        if (!res || res.canceled) return { ok: true, added: [], errors: [] };
        return { ok: true, ...(await addFiles(id, res.filePaths)) };
      }
      case 'openAsset':
        return openAsset(id, String(arg?.name || ''), win);
      case 'openLink': {
        const href = String(arg?.href || '').trim();
        if (/^(https?:\/\/|mailto:)/i.test(href) && !/[\s\u0000-\u001f]/.test(href)) {
          await ctx.openExternal(href);
          return { ok: true };
        }
        return openLocalLink(id, href);
      }
      case 'suggest':
        return { ok: true, items: suggestions(id, String(arg?.q || '')) };
      case 'openWiki':
        return openWiki(String(arg?.target || ''), win);
      case 'rename':
        return { ok: true, meta: await renameMemo(id, String(arg?.title || '')) };
      case 'info':
        return { ok: true, info: noteInfo(id) };
      case 'copyPath': {
        const m = library.get(id);
        if (!m) return { ok: false, message: '노트 파일이 없습니다.' };
        E().clipboard.writeText(m.file);
        return { ok: true };
      }
      case 'menu':
        memoMenu(id, Boolean(arg?.editing));
        return { ok: true };
      case 'close':
        await closeMemo(id);
        return { ok: true };
      case 'collapse':
        setCollapsed(id, !memoState(id).collapsed);
        return { ok: true };
      case 'pin':
        setPinned(id, !memoState(id).alwaysOnTop);
        return { ok: true };
      case 'new':
        await newMemo(win);
        return { ok: true };
      case 'list':
        showList();
        return { ok: true };
      default:
        return { ok: false, message: `unknown call ${name}` };
    }
  }

  async function listCall(name, arg, win) {
    const id = typeof arg?.id === 'string' ? arg.id : null;
    switch (name) {
      case 'init': {
        // A one-time message (e.g. the folder rename of #95) is shown once in the list.
        const notice = settings().notice || null;
        if (notice) store.save({ notice: '' });
        return { ok: true, style: style(), notice, ...listView() };
      }
      case 'search':
        searchQuery = String(arg?.q || '').slice(0, 200);
        return { ok: true, ...listView() };
      case 'view':
        store.save({ listView: arg?.view === 'archive' ? 'archive' : 'memos' });
        return { ok: true, ...listView() };
      case 'new':
        await newMemo(win);
        return { ok: true };
      case 'open':
        if (id) openMemo(id, { focus: true, near: win });
        return { ok: true };
      case 'hide':
        if (id) await closeMemo(id);
        pushList();
        return { ok: true };
      case 'pin':
        if (id) setMemoState(id, { listPinned: !memoState(id).listPinned });
        pushList();
        return { ok: true };
      case 'archive':
        if (id) await archiveMemo(id);
        return { ok: true };
      case 'restore':
        if (id) await restoreMemo(id);
        return { ok: true };
      case 'trash':
        if (id) await trashMemo(id, win);
        return { ok: true };
      case 'openFolder':
        await openNotesFolder();
        return { ok: true };
      case 'refresh':
        await scan();
        return { ok: true, ...listView() };
      case 'settings':
        ctx.openSettings();
        return { ok: true };
      case 'menu':
        listMenu();
        return { ok: true };
      case 'close':
        closeList();
        return { ok: true };
      default:
        return { ok: false, message: `unknown call ${name}` };
    }
  }

  async function handle(event, name, arg) {
    const who = senderOf(event);
    if (!who || !library) return { ok: false, message: '알 수 없는 창입니다.' };
    const win = E().BrowserWindow.fromWebContents(event.sender);
    try {
      return who.kind === 'memo' ? await memoCall(who.id, String(name), arg, win) : await listCall(String(name), arg, win);
    } catch (err) {
      log(`${who.kind} ${name}: ${err.stack || err.message}`);
      return { ok: false, message: err.message };
    }
  }

  // ---- start / stop / switching folders ----

  /** #95: once, for users on the default folder, the old "메모" default folder becomes "스티키 노트" (lib/migrate.js). */
  function migrateFolder() {
    const s = settings();
    if (s.notesDir || s.folderMigrated) return;
    let r;
    try {
      r = migrateDefaultFolder({ documents: E().app.getPath('documents'), newDir: notesDir() });
    } catch (err) {
      log(`folder migration: ${err.message}`);
      r = { result: 'error', useDir: null, notice: null };
    }
    log(`folder migration: ${r.result}`);
    store.save({ folderMigrated: true, notesDir: r.useDir || '', notice: r.notice || '' });
  }

  /** A one-line message at the top of the list: now when it is open, else the next time it opens. */
  function listNotice(text) {
    if (alive(listWin)) send(listWin, 'notice', { message: text });
    else store.save({ notice: [settings().notice, text].filter(Boolean).join(' ') }); // several before it opens: all of them
  }

  async function startLibrary() {
    migrateFolder();
    newLibrary();
    try {
      await library.ensureDir();
    } catch (err) {
      log(`notes folder ${library.dir}: ${err.message}`);
    }
    await library.scan();
    await migrateTitles().catch((err) => log(`title tidy-up: ${err.message}`));
    watch();
    for (const m of library.list()) if (memoState(m.id).open && !m.archived) openMemo(m.id);
  }

  /**
   * #113: a note folder from before notes had id file names (or titles in front matter) is tidied once
   * (lib/title-migration.js), before any window opens; the list tells what was done. The folder is marked on this PC only when nothing failed, so a
   * locked note is tried again at the next start. A missing folder (a drive not there yet) is not marked.
   */
  async function migrateTitles() {
    const key = library.dir.toLowerCase();
    if ((settings().titleFormat || {})[key] >= TM.FORMAT || !fs.existsSync(library.dir)) return;
    const items = TM.plan(library);
    let failed = 0;
    if (items.length) {
      const result = await TM.apply(items);
      failed = result.failed.length;
      log(`title tidy-up: ${result.changed} changed, ${failed} failed`);
      await library.scan();
      listNotice(TM.noticeText(result));
    }
    if (!failed) store.save({ titleFormat: { ...settings().titleFormat, [key]: TM.FORMAT } });
  }

  function flushAll() {
    for (const { session } of open.values()) session.flushSync();
  }

  function closeAllMemos() {
    stopping = true;
    try {
      for (const entry of [...open.values()]) stoppingOne(entry);
    } finally {
      stopping = false;
    }
  }

  async function switchFolder() {
    flushAll();
    closeAllMemos();
    unwatch();
    imageCache.clear();
    imageBytes = 0;
    await startLibrary();
    pushList();
  }

  function settingsView() {
    const s = settings();
    return { notesDir: notesDir(), defaultNotesDir: S.defaultNotesDir(E().app.getPath('documents')),
      opacity: s.opacity, defaultColor: s.defaultColor, fontSize: s.fontSize, colors: S.COLORS.map((c) => ({ id: c, name: S.COLOR_NAMES[c] })) };
  }

  async function saveSettings(values = {}) {
    const before = settings();
    const wanted = typeof values.notesDir === 'string' ? values.notesDir.trim() : notesDir();
    const where = { widgetDir: ctx.dir, dataDir: ctx.dataDir };
    const problem = S.checkNotesDir(wanted, where);
    if (problem) return { ok: false, message: problem };
    const isDefault = !wanted || path.resolve(wanted).toLowerCase() === S.defaultNotesDir(E().app.getPath('documents')).toLowerCase();
    const fromDir = notesDir();
    const toDir = isDefault ? S.defaultNotesDir(E().app.getPath('documents')) : path.resolve(wanted);
    // #108: "기존 노트를 새 폴더로 옮길까요?" -> 옮기기. Copy, check, then the originals go to the Recycle Bin
    // (or stay, when the user keeps them); the folder is switched only after that worked (lib/move-notes.js).
    let pathIds = before.pathIds;
    let moveNotice = '';
    if (values.moveNotes && fromDir.toLowerCase() !== toDir.toLowerCase()) {
      if (running) {
        flushAll();
        closeAllMemos();
        unwatch();
      }
      let moved;
      try {
        moved = await moveNotes({ from: fromDir, to: toDir, subfolders: SUBFOLDERS, keepOriginals: Boolean(values.keepOriginals),
          trash: (file) => E().shell.trashItem(file) });
      } catch (error) {
        if (running) await switchFolder().catch((err) => log(`reopen folder: ${err.message}`));
        return { ok: false, message: error.message };
      }
      pathIds = Object.fromEntries(Object.entries(before.pathIds || {}).map(([file, id]) => [moved.pathMap[file] || file, id]));
      moveNotice = [
        `노트 ${moved.moved}개를 새 폴더로 옮겼습니다.`,
        moved.renamed.length ? `같은 이름이 있어 이름을 바꾼 노트: ${moved.renamed.map((r) => r.to).join(', ')}.` : '',
        values.keepOriginals ? '원래 폴더의 파일은 그대로 두었습니다.' : '원래 파일은 휴지통으로 보냈습니다.',
        moved.leftBehind.length ? `휴지통으로 보내지 못해 원래 폴더에 남은 파일: ${moved.leftBehind.join(', ')}.` : '',
      ].filter(Boolean).join(' ');
    }
    store.save({
      notesDir: isDefault ? '' : path.resolve(wanted),
      pathIds,
      ...(moveNotice ? { notice: moveNotice } : {}),
      opacity: values.opacity ?? before.opacity,
      defaultColor: values.defaultColor ?? before.defaultColor,
      fontSize: values.fontSize ?? before.fontSize,
    });
    const after = settings();
    if (running) {
      for (const { win } of open.values()) send(win, 'style', style());
      send(listWin, 'style', style());
      if (after.notesDir !== before.notesDir) switchFolder().catch((err) => log(`switch folder: ${err.message}`));
    }
    return { ok: true };
  }

  // Notes and attachments: the engine's file store (#108). The engine reads this folder and exchanges it with
  // the user's other PCs; the widget keeps editing the files here and never sees the sync folder.
  const notesStore = ctx.files?.open?.({
    name: 'notes',
    dir: notesDir,
    include: (rel) => /^(?:보관함[\\/])?[^\\/]+\.(?:md|txt)$/i.test(rel)
      || /^(?:보관함[\\/])?[^\\/]+\.assets[\\/][^\\/]+$/i.test(rel),
    idOf: (rel, text) => {
      const file = path.resolve(notesDir(), rel);
      return (/\.md$/i.test(rel) ? md.splitFrontMatter(text).id : null)
        || settings().pathIds[file.toLowerCase()] || rel.replace(/\\/g, '/');
    },
    beforeSync: flushAll,
    onRemoteChange: () => library && scan(),
    maxFileBytes: 20 * 1024 * 1024,
  }) || null;

  // Another PC's note colours or display settings arrived through the engine.
  store.onRemoteChange?.(() => {
    if (!running) return;
    for (const { win } of open.values()) send(win, 'style', style());
    send(listWin, 'style', style());
    pushList();
  });

  return {
    async start() {
      running = true;
      stopping = false;
      crashes = [];
      ctx.handle(CHANNEL, handle);
      await startLibrary();
      if (settings().listOpen || settings().notice || !library.list().some((m) => open.has(m.id))) showList();
      pollTimer = setInterval(() => scheduleScan(0), 30000);
      pollTimer.unref?.();
    },
    stop() {
      stopping = true;
      running = false;
      clearTimeout(scanTimer);
      clearInterval(pollTimer);
      unwatch();
      flushAll();
      for (const { session } of open.values()) session.dispose();
      // The engine closes the windows (ctx.onStop); "open" stays as it is so they come back next time.
    },
    focus() {
      if (!running) return false;
      showList().then((win) => win && focusWindow(win));
      return true;
    },
    desktopWindows: () => [...[...open.values()].map((e) => e.win), listWin].filter(alive),
    needsSetup: () => false,
    settings: {
      get: settingsView,
      save: saveSettings,
      handlers: {
        pickFolder: async () => {
          const res = await E().dialog.showOpenDialog({ title: '노트 폴더 고르기', defaultPath: notesDir(), properties: ['openDirectory', 'createDirectory'] });
          return res.canceled ? null : res.filePaths[0] || null;
        },
        openFolder: () => openNotesFolder(),
        check: (dir) => S.checkNotesDir(String(dir || '').trim(), { widgetDir: ctx.dir, dataDir: ctx.dataDir }),
      },
    },
  };
}

module.exports = { create };
