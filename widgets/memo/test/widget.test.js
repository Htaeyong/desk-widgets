// The memo widget with a fake engine (#75): windows per memo, the list, calls from the pages, saving on stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpec, sharedPart } = require('../../../engine/main/sync-store');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { create } = require('../index');
const S = require('../lib/settings');
const TM = require('../lib/title-migration');
const { parseHtml } = require('../lib/html');

let wcSeq = 1;
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

function setup({ initial = {}, shared = false } = {}) {
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-notes-'));
  // Like the real layout: %APPDATA%chilgong88desk-widgetswidgetsmemo
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memo-data-')), 'chilgong88', 'desk-widgets', 'widgets', 'memo');
  fs.mkdirSync(dataDir, { recursive: true });
  // The #113 one-time tidy-up is marked done for this folder (title-migration.test.js tests it); a test can pass
  // initial: { titleFormat: {} } to have it run.
  let state = S.sanitize({ ...S.DEFAULTS, notesDir: notes, titleFormat: { [notes.toLowerCase()]: TM.FORMAT }, ...initial });
  const windows = [];
  const handlers = {};
  const opened = [];
  let syncFolder = null;
  let storeSync = null;
  const ctx = {
    id: 'memo',
    dir: path.join(__dirname, '..'),
    dataDir,
    createStore: (options) => {
      storeSync = options.sync;
      return { load: () => state, save: (v) => (state = S.sanitize({ ...state, ...v })) };
    },
    files: { open: (spec) => { syncFolder = spec; } },
    handle: (ch, fn) => (handlers[ch] = fn),
    createWidgetWindow: (opts) => {
      if (shared) throw new Error('a shared window was expected');
      const w = fakeWindow(opts);
      windows.push(w);
      return w;
    },
    // #109: the engine's shared renderer process; the window arrives a moment later.
    ...(shared
      ? {
          createSharedWidgetWindow: async (opts) => {
            await new Promise((r) => setTimeout(r, 5));
            const w = fakeWindow(opts);
            w.shared = true;
            windows.push(w);
            return w;
          },
        }
      : {}),
    popupMenu: () => {},
    confirm: async () => 0,
    openExternal: async (url) => opened.push(url),
    openSettings() {},
    beforeFocus() {},
  };
  const trashed = [];
  const electron = {
    app: { getPath: () => path.join(notes, 'Documents') },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    shell: { trashItem: async (p) => (trashed.push(p), fs.rmSync(p, { recursive: true, force: true })), openPath: async (p) => (opened.push(p), ''), showItemInFolder() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    BrowserWindow: { fromWebContents: (wc) => windows.find((w) => w.webContents === wc) || null },
  };
  const w = create(ctx, { electron });
  const call = (win, name, arg) => handlers['memo-widget']({ sender: win.webContents }, name, arg);
  const memoWindows = () => windows.filter((x) => x.opts.html.endsWith('memo.html') && !x.isDestroyed());
  const listWindow = () => windows.find((x) => x.opts.html.endsWith('list.html') && !x.isDestroyed());
  return { notes, dataDir, w, ctx, electron, call, memoWindows, listWindow, state: () => state, opened, trashed, syncFolder, storeSync };
}

test('the file store admits note files and attachments but refuses unrelated paths', () => {
  const t = setup();
  const spec = t.syncFolder;
  assert.equal(spec.dir(), t.notes);
  assert.equal(spec.include('보관함/회의.md'), true);
  assert.equal(spec.include('회의.assets/image.png'), true);
  assert.equal(spec.include('../outside.md'), false);
  assert.equal(spec.include('settings.json'), false);
  assert.equal(spec.idOf('회의.md', '---\ndesk-widgets-memo: note-1234\n---\nbody'), 'note-1234');
  assert.equal(spec.maxFileBytes, 20 * 1024 * 1024);
});

test('sync settings share note colors without per-PC window state or folder paths', () => {
  const { storeSync } = setup();
  assert.deepEqual(sharedPart({ color: 'midnight', open: true, bounds: { x: 1 } }, normalizeSpec(storeSync).collections.memos), { color: 'midnight' });
  for (const key of ['notesDir', 'pathIds', 'listOpen', 'listBounds', 'listAlwaysOnTop']) {
    assert.ok(!storeSync.shared.includes(key), key);
  }
});

const tree = (html) => parseHtml(html);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (file) => fs.readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
/** The file of a note by its front matter id, in dir (the notes folder or its archive); null when none. */
const noteFile = (dir, id) => {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)) : [];
  const name = names.find((f) => new RegExp(`^---\\n[\\s\\S]*?^desk-widgets-memo: ${id}$`, 'm').test(fs.readFileSync(path.join(dir, f), 'utf8')));
  return name ? path.join(dir, name) : null;
};
/** The front matter title of a note file (#113). */
const fmTitle = (file) => (/^---\n[\s\S]*?^title: (.*)$/m.exec(fs.readFileSync(file, 'utf8')) || [])[1];
/** "YYYYMMDD-HHmmss-<id>.md": the name a note made by the widget keeps for good (#113). */
const idName = (id) => new RegExp(`^\\d{8}-\\d{6}-${id}\\.md$`);

test('first start: the notes folder is created and the list window opens', async () => {
  const t = setup();
  fs.rmSync(t.notes, { recursive: true });
  await t.w.start();
  assert.ok(fs.existsSync(t.notes));
  assert.ok(t.listWindow());
  const r = await t.call(t.listWindow(), 'init');
  assert.deepEqual(r.items, []);
  assert.equal(r.dir, t.notes);
  t.w.stop();
});

test('the test.3 default moves back to yellow once without recoloring saved notes', () => {
  const old = { defaultColor: 'midnight', colorDefaultMigrated: true, memos: { 'saved-note': { color: 'midnight' } } };
  const upgraded = S.upgrade(old);
  assert.equal(upgraded.defaultColor, 'yellow');
  assert.equal(upgraded.memos['saved-note'].color, 'midnight');
  assert.equal(S.upgrade({ ...upgraded, defaultColor: 'midnight' }).defaultColor, 'midnight');
  assert.equal(S.upgrade({ defaultColor: 'yellow' }).defaultColor, 'yellow');
  assert.equal(S.upgrade({ defaultColor: 'pink' }).defaultColor, 'pink');
});

test('new memo from the list: a file, a window, typing saved as Markdown, renamed from its first line', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  assert.ok(win);
  const init = await t.call(win, 'init');
  assert.equal(init.meta.title, '새 노트');
  assert.equal(init.meta.color, 'yellow');
  const file = noteFile(t.notes, init.meta.id);
  assert.ok(file);
  assert.match(path.basename(file), idName(init.meta.id));
  assert.equal(fmTitle(file), '새 노트');
  await t.call(win, 'dirty');
  await t.call(win, 'update', { tree: tree('<h1>장보기</h1><ul class="task"><li class="task"><input type="checkbox" checked>우유</li><li class="task"><input type="checkbox">빵</li></ul>') });
  await t.call(win, 'flush');
  assert.equal(body(file), '# 장보기\n\n- [x] 우유\n- [ ] 빵\n');
  // Losing focus names it after the first line.
  win.emit('blur');
  // The rename runs in the background: wait for it however long the disk takes (no fixed sleep).
  const renamed = () => win.sent.some(([n, p]) => n === 'meta' && p.title === '장보기');
  for (const end = Date.now() + 5000; !renamed() && Date.now() < end; ) await wait(5);
  // Only the front matter title changes; the file keeps its name (#113).
  assert.equal(fmTitle(file), '장보기');
  assert.deepEqual(fs.readdirSync(t.notes), [path.basename(file)]);
  assert.equal(body(file), '# 장보기\n\n- [x] 우유\n- [ ] 빵\n');
  assert.equal(win.sent.filter(([n]) => n === 'meta').pop()[1].title, '장보기');
  // The list shows it as open.
  const list = await t.call(t.listWindow(), 'init');
  assert.equal(list.items[0].title, '장보기');
  assert.equal(list.items[0].open, true);
  assert.equal(list.items[0].preview, '장보기 우유 빵');
  t.w.stop();
});

test('open memos come back after a restart with their color, place and pin', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  const { meta } = await t.call(win, 'init');
  t.w.stop();
  for (const x of t.memoWindows()) x.destroy();
  t.listWindow()?.destroy();
  // The page wrote nothing: an untouched new memo stays (only closing it by the user removes it).
  const st = t.state().memos[meta.id];
  assert.equal(st.open, true);
  t.state().memos[meta.id] = { ...st, color: 'blue', alwaysOnTop: true, bounds: { x: 10, y: 20, width: 300, height: 200 } };
  const t2 = { ...t, w: create(t.ctx, { electron: t.electron }) };
  await t2.w.start();
  const again = t.memoWindows();
  assert.equal(again.length, 1);
  assert.equal(again[0].onTop, true);
  assert.deepEqual(again[0].getBounds(), { x: 10, y: 20, width: 300, height: 200 });
  assert.equal((await t.call(again[0], 'init')).meta.color, 'blue');
  t2.w.stop();
});

test('closing an untouched new memo removes its empty file; closing a written one keeps it', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  let [win] = t.memoWindows();
  await t.call(win, 'init');
  await t.call(win, 'close');
  assert.deepEqual(fs.readdirSync(t.notes), []);
  await t.call(t.listWindow(), 'new');
  [win] = t.memoWindows();
  const { meta } = await t.call(win, 'init');
  await t.call(win, 'update', { tree: tree('<p>남길 내용</p>') });
  await t.call(win, 'close');
  assert.equal(t.memoWindows().length, 0);
  // Kept under its id name; the first line became its front matter title (#113).
  const kept = fs.readdirSync(t.notes);
  assert.equal(kept.length, 1);
  assert.match(kept[0], idName(meta.id));
  assert.equal(fmTitle(path.join(t.notes, kept[0])), '남길 내용');
  assert.equal(t.state().memos[meta.id].open, false);
  t.w.stop();
});

test('stop writes what was typed even before the save delay', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  const { meta } = await t.call(win, 'init');
  await t.call(win, 'update', { tree: tree('<p>바로 끔</p>') });
  t.w.stop();
  assert.equal(body(noteFile(t.notes, meta.id)), '바로 끔\n');
});

test('images and files: pasted bytes and dropped files go to the memo assets folder', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  const { meta } = await t.call(win, 'init');
  const file = noteFile(t.notes, meta.id);
  const stem = path.basename(file, '.md');
  const assets = path.join(t.notes, `${stem}.assets`); // the assets folder is named after the id file name (#113)
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const img = await t.call(win, 'addImage', { type: 'image/png', bytes: png });
  assert.equal(img.ok, true);
  assert.match(img.name, /^image-\d{8}-\d{6}\.png$/);
  assert.match(img.src, /^data:image\/png;base64,/);
  assert.equal((await t.call(win, 'addImage', { type: 'image/svg+xml', bytes: png })).ok, false);
  const src = path.join(t.dataDir, '견적서.pdf');
  fs.writeFileSync(src, 'pdf');
  const r = await t.call(win, 'addFiles', { paths: [src, path.join(t.dataDir, '없음.txt'), t.dataDir] });
  assert.deepEqual(r.added.map((a) => a.name), ['견적서.pdf']);
  assert.equal(r.errors.length, 2);
  assert.ok(fs.existsSync(path.join(assets, '견적서.pdf')));
  // Saved as relative links; shown again with the image as a data URL.
  await t.call(win, 'update', { tree: tree(`<p><img data-asset="${img.name}" src="${img.src}" alt="그림"><a class="attach" data-asset="견적서.pdf">견적서.pdf</a></p>`) });
  await t.call(win, 'flush');
  assert.equal(body(file), `![그림](${stem}.assets/${img.name})[견적서.pdf](${stem}.assets/견적서.pdf)\n`);
  const again = await t.call(win, 'init');
  assert.match(again.html, /<img src="data:image\/png;base64,[^"]+" alt="그림" data-asset="image-/);
  // Attachments open with the default app, only from this memo's assets folder.
  assert.equal((await t.call(win, 'openAsset', { name: '견적서.pdf' })).ok, true);
  assert.equal(t.opened.pop(), path.join(assets, '견적서.pdf'));
  assert.equal((await t.call(win, 'openAsset', { name: '..\\..\\x.pdf' })).ok, false);
  // Links: only http(s)/mailto go to the browser.
  assert.equal((await t.call(win, 'openLink', { href: 'https://example.com' })).ok, true);
  assert.equal(t.opened.pop(), 'https://example.com');
  assert.equal((await t.call(win, 'openLink', { href: 'javascript:alert(1)' })).ok, false);
  assert.equal((await t.call(win, 'openLink', { href: 'file:///C:/Windows/System32/calc.exe' })).ok, false);
  t.w.stop();
});

test('an outside edit reaches the open window; with unsaved edits it becomes a conflict', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  const { meta } = await t.call(win, 'init');
  await t.call(win, 'update', { tree: tree('<p>첫 내용</p>') });
  await t.call(win, 'flush');
  const file = noteFile(t.notes, meta.id);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('첫 내용', '**Obsidian**에서 고침'));
  await t.call(t.listWindow(), 'refresh');
  const reload = win.sent.filter(([n]) => n === 'reload').pop();
  assert.ok(reload, 'reloaded');
  assert.match(reload[1].html, /<strong>Obsidian<\/strong>에서 고침/);
  // Now with an unsaved edit.
  await t.call(win, 'dirty');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('에서 고침', '에서 또 고침'));
  await t.call(t.listWindow(), 'refresh');
  assert.equal(win.sent.pop()[0] === 'conflict' || win.sent.some(([n]) => n === 'conflict'), true);
  const r = await t.call(win, 'resolve', { choice: 'copy', tree: tree('<p>내 버전</p>') });
  assert.ok(r.copyId);
  // The copy is a new note with its own id name; "(내 사본)" is in its title (#113).
  const copy = noteFile(t.notes, r.copyId);
  assert.match(path.basename(copy), idName(r.copyId));
  assert.equal(fmTitle(copy), '새 노트 (내 사본)');
  assert.equal(body(copy), '내 버전\n');
  assert.match(body(file), /또 고침/);
  t.w.stop();
});

test('archive, restore and trash from the list', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  const { meta } = await t.call(win, 'init');
  await t.call(win, 'update', { tree: tree('<p>보관</p>') });
  await t.call(win, 'flush');
  const name = path.basename(noteFile(t.notes, meta.id));
  await t.call(t.listWindow(), 'archive', { id: meta.id });
  assert.equal(t.memoWindows().length, 0, 'the window closes');
  // Archive and restore keep the file name (#113).
  assert.ok(fs.existsSync(path.join(t.notes, '보관함', name)));
  assert.ok(!fs.existsSync(path.join(t.notes, name)));
  await t.call(t.listWindow(), 'open', { id: meta.id });
  assert.equal(t.memoWindows().length, 0, 'archived memos do not open');
  await t.call(t.listWindow(), 'restore', { id: meta.id });
  assert.ok(fs.existsSync(path.join(t.notes, name)));
  await t.call(t.listWindow(), 'trash', { id: meta.id });
  assert.deepEqual(t.trashed.map((p) => path.basename(p)), [name]);
  assert.equal(t.state().memos[meta.id], undefined);
  t.w.stop();
});

test('search finds text inside memos; a .txt memo is edited as plain text', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.notes, '옛 노트.txt'), '전화번호 010-1234\n**별표 그대로**\n');
  fs.writeFileSync(path.join(t.notes, '다른 노트.md'), '# 회의\n');
  await t.w.start();
  const r = await t.call(t.listWindow(), 'search', { q: '전화' });
  assert.deepEqual(r.items.map((i) => i.title), ['옛 노트']);
  await t.call(t.listWindow(), 'open', { id: r.items[0].id });
  const [win] = t.memoWindows();
  const init = await t.call(win, 'init');
  assert.equal(init.meta.ext, 'txt');
  assert.equal(init.text, '전화번호 010-1234\n**별표 그대로**\n');
  await t.call(win, 'update', { text: '전화번호 010-9999\r\n**별표 그대로**' });
  await t.call(win, 'flush');
  assert.equal(fs.readFileSync(path.join(t.notes, '옛 노트.txt'), 'utf8'), '전화번호 010-9999\n**별표 그대로**');
  t.w.stop();
});

test('unknown windows and bad calls are refused', async () => {
  const t = setup();
  await t.w.start();
  assert.equal((await t.call({ webContents: { id: 9999 } }, 'init')).ok, false);
  assert.equal((await t.call(t.listWindow(), 'nope')).ok, false);
  t.w.stop();
});

test('settings: the notes folder cannot be inside the program or settings folders', async () => {
  const t = setup();
  const save = t.w.settings.save;
  assert.equal((await save({ notesDir: path.join(t.dataDir, '노트') })).ok, false);
  assert.equal((await save({ notesDir: path.join(t.ctx.dir, '노트') })).ok, false);
  assert.equal((await save({ notesDir: 'relative\\dir' })).ok, false);
  assert.equal((await save({ notesDir: t.notes, opacity: 50 })).ok, true);
  assert.equal(t.state().opacity, 50);
});

test('[[ links: suggestions, Ctrl+click opens or creates, renames follow in other memos, list shows backlinks', async () => {
  const t = setup();
  const fm = (id, text) => `---\ndesk-widgets-memo: ${id}\n---\n${text}`;
  fs.writeFileSync(path.join(t.notes, '회의록.md'), fm('meet01', '안건\n'));
  fs.writeFileSync(path.join(t.notes, '회의 준비.md'), fm('prep01', '자료\n'));
  fs.writeFileSync(path.join(t.notes, '할 일.md'), fm('todo01', '- [ ] [[회의록]] 정리\n'));
  fs.writeFileSync(path.join(t.notes, '일기.md'), fm('diary1', '[[회의록|오늘 회의]] 끝\n'));
  await t.w.start();
  await t.call(t.listWindow(), 'open', { id: 'todo01' });
  const [todo] = t.memoWindows();
  const init = await t.call(todo, 'init');
  assert.match(init.html, /<a class="wiki" data-wiki="회의록">회의록<\/a>/);

  // Suggestions: titles containing the text (the memo itself excluded), plus "create" for a new name.
  let r = await t.call(todo, 'suggest', { q: '회의' });
  assert.deepEqual(r.items.slice(0, 2).map((i) => i.title).sort(), ['회의 준비', '회의록']); // newest first
  assert.equal(r.items[2].title, '회의');
  assert.equal(r.items[2].create, true);
  r = await t.call(todo, 'suggest', { q: '회의록' });
  assert.deepEqual(r.items.map((i) => i.title), ['회의록']);

  // Backlinks in the list.
  const list = await t.call(t.listWindow(), 'init');
  assert.deepEqual(list.items.find((i) => i.id === 'meet01').backlinks.map((b) => b.title).sort(), ['일기', '할 일']);

  // Ctrl+click: an existing memo opens; a missing one is created and opened.
  assert.equal((await t.call(todo, 'openWiki', { target: '회의록#안건' })).ok, true);
  assert.equal(t.memoWindows().length, 2);
  const made = await t.call(todo, 'openWiki', { target: '새 계획' });
  assert.equal(made.created, true);
  // The new note has an id file name; the link text is its title (#113).
  const plan = fs.readdirSync(t.notes).filter((f) => f.endsWith('.md') && fmTitle(path.join(t.notes, f)) === '새 계획');
  assert.equal(plan.length, 1);
  assert.match(plan[0], /^\d{8}-\d{6}-[0-9a-f]+\.md$/);
  assert.ok(!fs.existsSync(path.join(t.notes, '새 계획.md')));
  assert.equal(t.memoWindows().length, 3);

  // Renaming 회의록 rewrites the links in 할 일 (open window) and 일기 (closed file).
  const meeting = t.memoWindows()[1];
  await t.call(meeting, 'init');
  await t.call(meeting, 'rename', { title: '주간 회의' });
  assert.equal(body(path.join(t.notes, '일기.md')), '[[주간 회의|오늘 회의]] 끝\n');
  assert.equal(body(path.join(t.notes, '할 일.md')), '- [ ] [[주간 회의]] 정리\n');
  assert.match(todo.sent.filter(([n]) => n === 'reload').pop()[1].html, /data-wiki="주간 회의"/);
  assert.match(meeting.sent.filter(([n]) => n === 'notice').pop()[1].message, /2개/);
  const after = await t.call(t.listWindow(), 'init');
  assert.equal(after.items.find((i) => i.id === 'meet01').backlinks.length, 2);
  t.w.stop();
});

test('#113 the same title twice: [[제목]] means the newer one; renaming the other leaves those links alone', async () => {
  const t = setup();
  const nl = String.fromCharCode(10);
  const fm = (id, title, text) => ['---', ...(title ? [`title: ${title}`] : []), `desk-widgets-memo: ${id}`, '---', text].join(nl);
  fs.writeFileSync(path.join(t.notes, '회의.md'), fm('old001', '회의', `옛 회의${nl}`));
  fs.writeFileSync(path.join(t.notes, '회의 (2).md'), fm('new001', '회의', `새 회의${nl}`));
  fs.writeFileSync(path.join(t.notes, '메모.md'), fm('link01', null, `[[회의]] [[회의 (2)|둘째]] [x](회의.md)${nl}`));
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(t.notes, '회의.md'), past, past);
  await t.w.start();
  const list = await t.call(t.listWindow(), 'init');
  assert.deepEqual(list.items.filter((i) => i.title === '회의').map((i) => i.id).sort(), ['new001', 'old001']);
  assert.deepEqual(list.items.find((i) => i.id === 'new001').backlinks.map((b) => b.title), ['메모']);

  // Renaming the older 회의: only its front matter title changes, the file keeps its name (#113); [[회의]] means the
  // other one and stays, and the relative link still points at the same file.
  await t.call(t.listWindow(), 'open', { id: 'old001' });
  const [old] = t.memoWindows();
  await t.call(old, 'init');
  await t.call(old, 'rename', { title: '지난 회의' });
  assert.equal(fmTitle(path.join(t.notes, '회의.md')), '지난 회의');
  assert.ok(!fs.existsSync(path.join(t.notes, '지난 회의.md')));
  assert.equal(body(path.join(t.notes, '메모.md')), `[[회의]] [[회의 (2)|둘째]] [x](회의.md)${nl}`);

  // Ctrl+click on [[회의]] opens the other note; renaming it fixes [[회의]]; [[회의 (2)]] names its file, which keeps
  // its name, so that link stays.
  await t.call(t.listWindow(), 'open', { id: 'link01' });
  const linkWin = t.memoWindows()[1];
  await t.call(linkWin, 'init');
  assert.equal((await t.call(linkWin, 'openWiki', { target: '회의' })).ok, true);
  assert.equal(t.memoWindows().length, 3);
  const meeting = t.memoWindows()[2];
  assert.equal((await t.call(meeting, 'init')).meta.title, '회의');
  await t.call(meeting, 'rename', { title: '주간 회의' });
  assert.equal(fmTitle(path.join(t.notes, '회의 (2).md')), '주간 회의');
  assert.ok(!fs.existsSync(path.join(t.notes, '주간 회의.md')));
  assert.equal(body(path.join(t.notes, '메모.md')), `[[주간 회의]] [[회의 (2)|둘째]] [x](회의.md)${nl}`);
  t.w.stop();
});

test('#95 first start after the update: the old default folder is renamed once and the list says so once', async () => {
  const t = setup({ initial: { notesDir: '' } });
  const documents = path.join(t.notes, 'Documents');
  const oldDir = path.join(documents, 'Desk Widgets', '메모');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, '장보기.md'), '---\ndesk-widgets-memo: shop01\n---\n우유\n');
  t.state().memos.shop01 = { open: true, color: 'pink' };
  const newDir = path.join(documents, 'Desk Widgets', '스티키 노트');
  // The #113 tidy-up is not what this test is about: mark it done for the default folder too.
  t.state().titleFormat = { [newDir.toLowerCase()]: TM.FORMAT };
  await t.w.start();
  assert.ok(fs.existsSync(path.join(newDir, '장보기.md')));
  assert.ok(!fs.existsSync(oldDir));
  assert.equal(t.state().notesDir, '', 'still the default folder');
  assert.equal(t.state().folderMigrated, true);
  // The note keeps its window and color (same id).
  const [win] = t.memoWindows();
  assert.equal((await t.call(win, 'init')).meta.color, 'pink');
  const first = await t.call(t.listWindow(), 'init');
  assert.match(first.notice, /스티키 노트/);
  assert.equal(first.dir, newDir);
  assert.equal((await t.call(t.listWindow(), 'init')).notice, null, 'shown once');
  t.w.stop();
  // A later start does not look again (an old folder made again stays as it is).
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'x.md'), 'x');
  const again = create(t.ctx, { electron: t.electron });
  await again.start();
  assert.ok(fs.existsSync(path.join(oldDir, 'x.md')));
  again.stop();
});

test('#95 a folder the user chose is never moved', async () => {
  const t = setup(); // notesDir is a custom folder
  const documents = path.join(t.notes, 'Documents');
  const oldDir = path.join(documents, 'Desk Widgets', '메모');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'a.md'), 'a');
  await t.w.start();
  assert.ok(fs.existsSync(path.join(oldDir, 'a.md')));
  assert.ok(!fs.existsSync(path.join(documents, 'Desk Widgets', '스티키 노트')));
  assert.equal(t.state().notesDir, t.notes);
  assert.equal((await t.call(t.listWindow(), 'init')).notice, null);
  t.w.stop();
});

test('#95 both default folders have notes: the old one stays in use and is saved as the chosen folder', async () => {
  const t = setup({ initial: { notesDir: '' } });
  const documents = path.join(t.notes, 'Documents');
  const oldDir = path.join(documents, 'Desk Widgets', '메모');
  const newDir = path.join(documents, 'Desk Widgets', '스티키 노트');
  for (const [d, f] of [[oldDir, '옛.md'], [newDir, '새.md']]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, f), f);
  }
  await t.w.start();
  assert.equal(t.state().notesDir, oldDir);
  const r = await t.call(t.listWindow(), 'init');
  assert.equal(r.dir, oldDir);
  assert.deepEqual(r.items.map((i) => i.title), ['옛']);
  assert.match(r.notice, /합치지 않고/);
  assert.deepEqual(fs.readdirSync(newDir), ['새.md']);
  t.w.stop();
});

// ---- #109: memo windows in the engine's shared renderer process ----

/** Waits until cond() holds (windows arrive a moment after they are asked for). */
async function until(cond, ms = 3000) {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

test('#109 shared process: notes and the list open through createSharedWidgetWindow and work as before', async () => {
  const t = setup({ shared: true });
  await t.w.start();
  await until(() => t.listWindow());
  assert.ok(t.listWindow().shared);
  await t.call(t.listWindow(), 'new');
  await until(() => t.memoWindows().length === 1);
  const [win] = t.memoWindows();
  assert.ok(win.shared);
  const init = await t.call(win, 'init');
  assert.equal(init.meta.title, '새 노트');
  await t.call(win, 'dirty');
  await t.call(win, 'update', { tree: tree('<p>공유 프로세스</p>') });
  await t.call(win, 'flush');
  assert.equal(body(noteFile(t.notes, init.meta.id)), '공유 프로세스\n');
  await t.call(win, 'pin');
  assert.equal(win.onTop, true);
  t.w.stop();
});

test('#109 shared process: a note closed before its window arrived gets no window; opening twice makes one', async () => {
  const t = setup({ shared: true });
  await t.w.start();
  await until(() => t.listWindow());
  await t.call(t.listWindow(), 'new');
  await until(() => t.memoWindows().length === 1);
  const id = (await t.call(t.memoWindows()[0], 'init')).meta.id;
  await t.call(t.memoWindows()[0], 'dirty');
  await t.call(t.memoWindows()[0], 'update', { tree: tree('<p>남김</p>') });
  await t.call(t.memoWindows()[0], 'flush');
  await t.call(t.memoWindows()[0], 'close');
  await until(() => t.memoWindows().length === 0);
  // Open from the list twice at once, then hide it at once: no window stays.
  await t.call(t.listWindow(), 'open', { id });
  await t.call(t.listWindow(), 'open', { id });
  await t.call(t.listWindow(), 'hide', { id });
  await wait(30);
  assert.equal(t.memoWindows().length, 0);
  assert.equal(t.state().memos[id].open, false);
  // Open twice: one window.
  await t.call(t.listWindow(), 'open', { id });
  await t.call(t.listWindow(), 'open', { id });
  await until(() => t.memoWindows().length === 1);
  await wait(30);
  assert.equal(t.memoWindows().length, 1);
  t.w.stop();
});

test('#109 shared process crash: what the pages sent is saved, every note and the list come back in place', async () => {
  const t = setup({ shared: true });
  await t.w.start();
  await until(() => t.listWindow());
  await t.call(t.listWindow(), 'new');
  await t.call(t.listWindow(), 'new');
  await until(() => t.memoWindows().length === 2);
  const [a, b] = t.memoWindows();
  const idA = (await t.call(a, 'init')).meta.id;
  await t.call(b, 'init');
  a.setBounds({ x: 300, y: 200, width: 280, height: 260 });
  t.state().memos[idA] = { ...t.state().memos[idA], bounds: a.getBounds() };
  await t.call(a, 'dirty');
  await t.call(a, 'update', { tree: tree('<p>크래시 직전</p>') }); // sent, not saved yet (save delay)
  const list = t.listWindow();
  // The process dies: every window of the group reports it.
  for (const w of [a, b, list]) w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.ok(a.isDestroyed() && b.isDestroyed() && list.isDestroyed());
  const file = fs.readdirSync(t.notes).map((f) => path.join(t.notes, f)).find((f) => body(f) === '크래시 직전\n');
  assert.ok(file, 'the last update was saved');
  await until(() => t.memoWindows().length === 2 && t.listWindow());
  const again = t.memoWindows().find((w) => w.opts.getBounds().x === 300);
  assert.ok(again, 'the note opens at its place');
  assert.equal((await t.call(again, 'init')).html.includes('크래시 직전'), true);
  assert.ok(Object.values(t.state().memos).every((m) => m.open));
  t.w.stop();
});

test('#109 shared process crash loop: after 3 crashes in a minute the notes are not reopened (they come back next start)', async () => {
  const t = setup({ shared: true });
  await t.w.start();
  await until(() => t.listWindow());
  await t.call(t.listWindow(), 'new');
  for (let i = 0; i < 4; i++) {
    await until(() => t.memoWindows().length === 1);
    t.memoWindows()[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  }
  await wait(700);
  assert.equal(t.memoWindows().length, 0);
  assert.ok(Object.values(t.state().memos).every((m) => m.open));
  t.w.stop();
});

test('#109 shared process crash while a note window is on its way: the note opens again in a live window', async () => {
  const t = setup({ shared: true });
  // The first note window arrives from a process that has already died (its crash report came before the widget had it).
  const shared = t.ctx.createSharedWidgetWindow;
  let first = true;
  t.ctx.createSharedWidgetWindow = async (opts) => {
    const w = await shared(opts);
    if (first && opts.html.endsWith('memo.html')) {
      first = false;
      w.webContents.isCrashed = () => true;
    }
    return w;
  };
  await t.w.start();
  await until(() => t.listWindow());
  await t.call(t.listWindow(), 'new');
  await until(() => t.memoWindows().length === 1 && !t.memoWindows()[0].webContents.isCrashed);
  assert.equal((await t.call(t.memoWindows()[0], 'init')).meta.title, '새 노트');
  t.w.stop();
});

test('settings: changing the note folder with "옮기기" moves the notes, then switches (#108)', async () => {
  const t = setup();
  await t.w.start();
  fs.writeFileSync(path.join(t.notes, '회의.md'), '---\ndesk-widgets-memo: m1\n---\n회의록\n');
  fs.writeFileSync(path.join(t.notes, '글.txt'), '그냥 글');
  await t.call(t.listWindow(), 'init');
  const oldTxt = path.join(t.notes, '글.txt').toLowerCase();
  t.state().pathIds = { [oldTxt]: 'txt-1' };
  const target = path.join(path.dirname(t.notes), `${path.basename(t.notes)}-moved`);
  const r = await t.w.settings.save({ notesDir: target, moveNotes: true });
  assert.equal(r.ok, true, r.message);
  assert.equal(t.state().notesDir, target);
  assert.ok(fs.existsSync(path.join(target, '회의.md')));
  assert.ok(fs.existsSync(path.join(target, '글.txt')));
  assert.equal(fs.existsSync(path.join(t.notes, '회의.md')), false, 'the original went to the trash');
  assert.ok(t.trashed.some((p) => p.endsWith('회의.md')));
  assert.equal(t.state().pathIds[path.join(target, '글.txt').toLowerCase()], 'txt-1', 'the remembered id follows the file');
  assert.match(t.state().notice, /노트 2개를 새 폴더로 옮겼습니다/);
  t.w.stop();
  fs.rmSync(target, { recursive: true, force: true });
});

test('settings: "옮기지 않기" only switches, and a refused move changes nothing (#108)', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.notes, '회의.md'), '---\ndesk-widgets-memo: m1\n---\n회의록\n');
  fs.mkdirSync(path.join(t.notes, '회의.assets'));
  fs.writeFileSync(path.join(t.notes, '회의.assets', 'a.png'), 'png');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-other-'));
  fs.writeFileSync(path.join(other, '회의.md'), '다른 내용');
  const refused = await t.w.settings.save({ notesDir: other, moveNotes: true });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /첨부 파일이 있어/);
  assert.equal(t.state().notesDir, t.notes, 'the folder was not switched');
  assert.ok(fs.existsSync(path.join(t.notes, '회의.md')));
  const r = await t.w.settings.save({ notesDir: other, moveNotes: false });
  assert.equal(r.ok, true);
  assert.equal(t.state().notesDir, other);
  assert.ok(fs.existsSync(path.join(t.notes, '회의.md')), 'nothing moved');
  assert.equal(fs.readFileSync(path.join(other, '회의.md'), 'utf8'), '다른 내용');
  fs.rmSync(other, { recursive: true, force: true });
});

test('#113 정보…: the note menu shows title, path, created, modified and size; 경로 복사 copies the path; renaming keeps the file', async () => {
  const t = setup();
  const menus = [];
  t.ctx.popupMenu = (_win, items) => menus.push(items);
  let copied = null;
  t.electron.clipboard = { writeText: (s) => (copied = s) };
  await t.w.start();
  const before = Date.now();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  const { meta } = await t.call(win, 'init');
  const file = noteFile(t.notes, meta.id);
  const { info } = await t.call(win, 'info');
  const st = fs.statSync(file);
  assert.deepEqual(info, { title: '새 노트', file, created: info.created, modified: Math.round(st.mtimeMs), size: st.size });
  assert.ok(info.created >= before - 1000 && info.created <= Date.now(), 'created: from the front matter');
  await t.call(win, 'menu', {});
  const items = menus.at(-1);
  const labels = items.map((i) => i.label).filter(Boolean);
  assert.ok(labels.includes('정보…') && labels.includes('탐색기에서 보기'));
  win.sent.length = 0;
  items.find((i) => i.label === '정보…').click();
  assert.deepEqual(win.sent.find(([n]) => n === 'info')[1], info);
  assert.deepEqual(await t.call(win, 'copyPath'), { ok: true });
  assert.equal(copied, file);
  await t.call(win, 'rename', { title: '다른 제목' });
  assert.equal((await t.call(win, 'info')).info.file, file, 'a new title, the same file');
  assert.equal(fmTitle(file), '다른 제목');
  t.w.stop();
});
