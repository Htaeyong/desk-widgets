// The memo widget with a fake engine (#75): windows per memo, the list, calls from the pages, saving on stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { create } = require('../index');
const S = require('../lib/settings');
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
    webContents: { id: wcSeq++, send: (_ch, name, payload) => sent.push([name, payload]) },
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

function setup({ initial = {} } = {}) {
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-notes-'));
  // Like the real layout: %APPDATA%chilgong88desk-widgetswidgetsmemo
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memo-data-')), 'chilgong88', 'desk-widgets', 'widgets', 'memo');
  fs.mkdirSync(dataDir, { recursive: true });
  let state = S.sanitize({ ...S.DEFAULTS, notesDir: notes, ...initial });
  const windows = [];
  const handlers = {};
  const opened = [];
  const ctx = {
    id: 'memo',
    dir: path.join(__dirname, '..'),
    dataDir,
    createStore: () => ({ load: () => state, save: (v) => (state = S.sanitize({ ...state, ...v })) }),
    handle: (ch, fn) => (handlers[ch] = fn),
    createWidgetWindow: (opts) => {
      const w = fakeWindow(opts);
      windows.push(w);
      return w;
    },
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
  return { notes, dataDir, w, ctx, electron, call, memoWindows, listWindow, state: () => state, opened, trashed };
}

const tree = (html) => parseHtml(html);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (file) => fs.readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');

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

test('new memo from the list: a file, a window, typing saved as Markdown, renamed from its first line', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  assert.ok(win);
  const init = await t.call(win, 'init');
  assert.equal(init.meta.title, '새 노트');
  assert.equal(init.meta.color, 'yellow');
  assert.ok(fs.existsSync(path.join(t.notes, '새 노트.md')));
  await t.call(win, 'dirty');
  await t.call(win, 'update', { tree: tree('<h1>장보기</h1><ul class="task"><li class="task"><input type="checkbox" checked>우유</li><li class="task"><input type="checkbox">빵</li></ul>') });
  await t.call(win, 'flush');
  assert.equal(body(path.join(t.notes, '새 노트.md')), '# 장보기\n\n- [x] 우유\n- [ ] 빵\n');
  // Losing focus names it after the first line.
  win.emit('blur');
  // The rename runs in the background: wait for it however long the disk takes (no fixed sleep).
  const renamed = () => win.sent.some(([n, p]) => n === 'meta' && p.title === '장보기');
  for (const end = Date.now() + 5000; !renamed() && Date.now() < end; ) await wait(5);
  assert.ok(fs.existsSync(path.join(t.notes, '장보기.md')));
  assert.ok(!fs.existsSync(path.join(t.notes, '새 노트.md')));
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
  assert.deepEqual(fs.readdirSync(t.notes), ['남길 내용.md']);
  assert.equal(t.state().memos[meta.id].open, false);
  t.w.stop();
});

test('stop writes what was typed even before the save delay', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  await t.call(win, 'init');
  await t.call(win, 'update', { tree: tree('<p>바로 끔</p>') });
  t.w.stop();
  assert.equal(body(path.join(t.notes, '새 노트.md')), '바로 끔\n');
});

test('images and files: pasted bytes and dropped files go to the memo assets folder', async () => {
  const t = setup();
  await t.w.start();
  await t.call(t.listWindow(), 'new');
  const [win] = t.memoWindows();
  await t.call(win, 'init');
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
  assert.ok(fs.existsSync(path.join(t.notes, '새 노트.assets', '견적서.pdf')));
  // Saved as relative links; shown again with the image as a data URL.
  await t.call(win, 'update', { tree: tree(`<p><img data-asset="${img.name}" src="${img.src}" alt="그림"><a class="attach" data-asset="견적서.pdf">견적서.pdf</a></p>`) });
  await t.call(win, 'flush');
  assert.equal(body(path.join(t.notes, '새 노트.md')), `![그림](새%20노트.assets/${img.name})[견적서.pdf](새%20노트.assets/견적서.pdf)\n`);
  const again = await t.call(win, 'init');
  assert.match(again.html, /<img src="data:image\/png;base64,[^"]+" alt="그림" data-asset="image-/);
  // Attachments open with the default app, only from this memo's assets folder.
  assert.equal((await t.call(win, 'openAsset', { name: '견적서.pdf' })).ok, true);
  assert.equal(t.opened.pop(), path.join(t.notes, '새 노트.assets', '견적서.pdf'));
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
  await t.call(win, 'init');
  await t.call(win, 'update', { tree: tree('<p>첫 내용</p>') });
  await t.call(win, 'flush');
  const file = path.join(t.notes, '새 노트.md');
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
  assert.equal(body(path.join(t.notes, '새 노트 (내 사본).md')), '내 버전\n');
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
  await t.call(t.listWindow(), 'archive', { id: meta.id });
  assert.equal(t.memoWindows().length, 0, 'the window closes');
  assert.ok(fs.existsSync(path.join(t.notes, '보관함', '새 노트.md')));
  await t.call(t.listWindow(), 'open', { id: meta.id });
  assert.equal(t.memoWindows().length, 0, 'archived memos do not open');
  await t.call(t.listWindow(), 'restore', { id: meta.id });
  assert.ok(fs.existsSync(path.join(t.notes, '새 노트.md')));
  await t.call(t.listWindow(), 'trash', { id: meta.id });
  assert.deepEqual(t.trashed.map((p) => path.basename(p)), ['새 노트.md']);
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

test('settings: the notes folder cannot be inside the program or settings folders', () => {
  const t = setup();
  const save = t.w.settings.save;
  assert.equal(save({ notesDir: path.join(t.dataDir, '노트') }).ok, false);
  assert.equal(save({ notesDir: path.join(t.ctx.dir, '노트') }).ok, false);
  assert.equal(save({ notesDir: 'relative\\dir' }).ok, false);
  assert.equal(save({ notesDir: t.notes, opacity: 50 }).ok, true);
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
  assert.ok(fs.existsSync(path.join(t.notes, '새 계획.md')));
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

test('#95 first start after the update: the old default folder is renamed once and the list says so once', async () => {
  const t = setup({ initial: { notesDir: '' } });
  const documents = path.join(t.notes, 'Documents');
  const oldDir = path.join(documents, 'Desk Widgets', '메모');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, '장보기.md'), '---\ndesk-widgets-memo: shop01\n---\n우유\n');
  t.state().memos.shop01 = { open: true, color: 'pink' };
  await t.w.start();
  const newDir = path.join(documents, 'Desk Widgets', '스티키 노트');
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
