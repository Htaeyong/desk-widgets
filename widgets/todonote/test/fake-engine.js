// A fake engine for the to-do note tests (#111): windows, menus, notification cards and the integrations broker.
// (widget.test.js keeps its own copy of the window parts; this one adds what the to-do features need.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { create } = require('../index');
const S = require('../lib/settings');
const md = require('../lib/markdown');
// The #113 folder tidy-up is already done in a fresh test folder (pass initial: { titleFormat: {} } to run it).
const TM = require('../lib/title-migration');

let wcSeq = 1000;
function fakeWindow(opts) {
  const win = new EventEmitter();
  const sent = [];
  let bounds = opts.getBounds() || { x: 0, y: 0, width: opts.size.width, height: opts.size.height };
  let destroyed = false;
  Object.assign(win, {
    opts,
    sent,
    onTop: false,
    webContents: Object.assign(new EventEmitter(), { id: wcSeq++, send: (_ch, name, payload) => sent.push([name, payload]) }),
    isDestroyed: () => destroyed,
    setAlwaysOnTop: (on) => (win.onTop = on),
    setMaximizable() {},
    getBounds: () => bounds,
    setBounds: (b) => (bounds = b),
    show() {},
    focus() {},
    close() {
      if (destroyed) return;
      destroyed = true;
      win.emit('closed');
    },
    destroy() {
      win.close();
    },
  });
  return win;
}

/**
 * @param {object} o
 * @param {object} [o.initial]  settings
 * @param {object} [o.integrations]  ctx.integrations (default: none, like an engine before API 1.6)
 */
function setup({ initial = {}, integrations = undefined, menus = [] } = {}) {
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-todo-'));
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memo-todo-data-')), 'widgets', 'memo');
  fs.mkdirSync(dataDir, { recursive: true });
  let state = S.sanitize({ ...S.DEFAULTS, notesDir: notes, folderMigrated: true, listOpen: false, titleFormat: { [notes.toLowerCase()]: TM.FORMAT }, ...initial });
  const windows = [];
  const handlers = {};
  const cards = []; // [{ events, opts }]
  const ctx = {
    id: 'todonote',
    dir: path.join(__dirname, '..'),
    dataDir,
    createStore: () => ({ load: () => state, save: (v) => (state = S.sanitize({ ...state, ...v })) }),
    handle: (ch, fn) => (handlers[ch] = fn),
    createWidgetWindow: (opts) => {
      const w = fakeWindow(opts);
      windows.push(w);
      return w;
    },
    popupMenu: (_win, items) => menus.push(items),
    confirm: async () => 0,
    openExternal: async () => {},
    openSettings() {},
    beforeFocus() {},
    notify: (events, opts) => cards.push({ events, opts }),
    sendToSettings() {},
    ...(integrations ? { integrations } : {}),
  };
  const trashed = [];
  const electron = {
    app: { getPath: () => path.join(notes, 'Documents') },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    shell: { trashItem: async (p) => (trashed.push(p), fs.rmSync(p, { recursive: true, force: true })), openPath: async () => '', showItemInFolder() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    BrowserWindow: { fromWebContents: (wc) => windows.find((w) => w.webContents === wc) || null },
  };
  const w = create(ctx, { electron });
  const call = (win, name, arg) => handlers['todonote-widget']({ sender: win.webContents }, name, arg);
  const memoWindows = () => windows.filter((x) => x.opts.html.endsWith('memo.html') && !x.isDestroyed());
  const listWindow = () => windows.find((x) => x.opts.html.endsWith('list.html') && !x.isDestroyed());
  /** Writes a note file with front matter (id + extra lines). */
  const writeNote = (title, { id, fm = [], body = '', dir = notes } = {}) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${title}.md`);
    fs.writeFileSync(file, `---\n${[...fm, ...(id ? [`desk-widgets-memo: ${id}`] : [])].join('\n')}\n---\n${body}`);
    return file;
  };
  const read = (file) => fs.readFileSync(file, 'utf8');
  /** #113: note files are named by id, not title. Finds a note file (notes, 완료, 보관함) by its front matter id or title. */
  const noteFiles = () =>
    ['', '완료', '보관함'].flatMap((sub) => {
      const dir = path.join(notes, sub);
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.(md|txt)$/i.test(n)).map((n) => path.join(dir, n)) : [];
    });
  const fmOf = (file) => {
    const fm = md.splitFrontMatter(read(file));
    return { id: fm.id, title: md.frontMatterTitle(fm.lines) || path.basename(file, path.extname(file)) };
  };
  const fileById = (id) => noteFiles().find((f) => fmOf(f).id === id) || null;
  const fileByTitle = (title) => noteFiles().find((f) => fmOf(f).title === title) || null;
  const until = async (fn, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 5))) if (fn()) return true;
    return false;
  };
  return { notes, dataDir, w, ctx, electron, call, memoWindows, listWindow, state: () => state, setState: (v) => (state = S.sanitize({ ...state, ...v })), cards, trashed, windows, writeNote, read, until, menus, noteFiles, fileById, fileByTitle };
}

module.exports = { setup, fakeWindow };
