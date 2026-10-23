// The mail widget's main code with a fake engine context (#65): the theme contract allow-list, mock data,
// accounts through "연결 확인" with passwords only in the encrypted secrets file, new-mail cards and their
// buttons, the writing handoff, the isolated preview's settings, and the package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packageWidget } = require('../../../tools/widget-kit/build');
const { validateManifest } = require('../../../engine/main/theme-manifest');
const { create } = require('../index');
const { DEFAULTS, sanitize } = require('../lib/settings');
const { withThemeHost } = require('./theme-host');
const { FakeImap, textMessage, altMessage } = require('./fake-imap');

const mailDir = path.join(__dirname, '..');
const fakeCrypto = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };
const NOW = Date.now();

/** Electron stand-in for the reader: records the body view's webPreferences and session rules. */
function fakeElectron() {
  const rec = { views: [], session: {}, loaded: [] };
  class WebContentsView {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.webContents = {
        id: 77,
        setWindowOpenHandler: (fn) => (this.openHandler = fn),
        on: (ev, fn) => (this.handlers[ev] = fn),
        loadURL: async (url) => rec.loaded.push(url),
        close: () => {},
        isDestroyed: () => false,
      };
      rec.views.push(this);
    }
    setBounds(b) {
      this.bounds = b;
    }
  }
  const ses = {
    webRequest: { onBeforeRequest: (fn) => (rec.session.filter = fn), onBeforeSendHeaders: (fn) => (rec.session.send = fn), onHeadersReceived: (fn) => (rec.session.recv = fn) },
    setPermissionRequestHandler: (fn) => (rec.session.perm = fn),
    setPermissionCheckHandler: (fn) => (rec.session.permCheck = fn),
    on: (ev, fn) => (rec.session[ev] = fn),
  };
  return { rec, electron: { WebContentsView, session: { fromPartition: (p) => ((rec.partition = p), ses) } } };
}

function setup({ initial = {}, flags = {}, imap, fake, openFails = null, mailProgram = 'Outlook', smtp = null, dialog = null, files = null, integrations = null } = {}) {
  let state = sanitize({ ...DEFAULTS, ...initial });
  const opened = [];
  const cards = [];
  const handlers = new Map();
  const windows = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-w-'));
  const { ctx, th } = withThemeHost({
    id: 'mail',
    dir: mailDir,
    dataDir,
    flags,
    app: { locale: () => 'ko-KR' },
    createStore: () => ({ load: () => state, save: (v) => (state = sanitize({ ...state, ...v })) }),
    integrations,
    // Like shell.openExternal: a promise that rejects when Windows has no program for the link.
    openExternal: async (url) => {
      opened.push(url);
      if (openFails && openFails(url)) throw new Error('No application is associated with the specified file for this operation.');
    },
    sendToSettings: () => {},
    handle: (ch, fn) => handlers.set(ch, fn),
    notify: (list, opts) => cards.push({ list, opts }),
    openAppWindow: (o) => {
      const win = {
        o,
        destroyed: false,
        title: '',
        isDestroyed: () => win.destroyed,
        destroy: () => {
          if (win.destroyed) return;
          win.destroyed = true;
          win.handlers.closed?.();
        },
        setTitle: (t) => (win.title = t),
        show: () => {},
        focus: () => {},
        handlers: {},
        on: (ev, fn) => (win.handlers[ev] = fn),
        close: () => {
          const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
          win.handlers.close?.(event);
          if (event.defaultPrevented) return;
          win.destroy();
        },
        contentView: { addChildView: (v) => (win.child = v) },
      };
      // The real webContents getter throws "Object has been destroyed" after the window is gone (#68 crash).
      const wc = { setWindowOpenHandler: () => {}, on: () => {}, send: (...a) => (win.sent ||= []).push(a), isDestroyed: () => win.destroyed };
      win.wc = wc;
      Object.defineProperty(win, 'webContents', {
        get() {
          if (win.destroyed) throw new TypeError('Object has been destroyed');
          return wc;
        },
      });
      windows.push(win);
      return win;
    },
    confirm: async () => 0,
  });
  const fe = fakeElectron();
  const clip = [];
  const widget = create(ctx, { crypto: fakeCrypto, imap: imap || fake?.deps(), electron: fe.electron, mailtoHandler: () => mailProgram, smtp: smtp?.deps(), dialog, fs: files, sentWaitMs: 0, mockSendMs: 5, clipboard: { writeText: (t) => clip.push(t) }, mock: { arriveAfterMs: 0 }, notifier: { setTimeout: (fn) => setTimeout(fn, 5) } });
  return { widget, th, opened, cards, handlers, windows, fe, clip, dataDir, getState: () => state };
}

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out');
}

test('theme contract v1: declared calls, gesture and preview rules, events', () => {
  const { th } = setup({ flags: { mockData: true } });
  assert.equal(th.opts.defaultTheme, 'default');
  assert.deepEqual(th.opts.contractVersions, [1]);
  assert.equal(th.opts.kitDir, path.join(mailDir, 'kit'));
  assert.equal(th.opts.builtinDir, path.join(mailDir, 'themes'));
  assert.deepEqual(Object.keys(th.opts.methods).sort(), ['addToTodo', 'compose', 'createCategory', 'filter', 'forward', 'get', 'getState', 'list', 'loadMore', 'markRead', 'markUnread', 'openPreview', 'openWebmail', 'refresh', 'reply', 'select', 'setCategories']);
  assert.deepEqual(th.opts.events, ['changed', 'messages', 'reveal']);
  for (const n of ['markRead', 'markUnread', 'openPreview', 'openWebmail', 'compose', 'reply', 'forward', 'addToTodo', 'setCategories', 'createCategory']) {
    assert.equal(th.opts.methods[n].gesture, true, n);
    assert.equal(th.opts.methods[n].preview, undefined, `${n}: refused in the preview`);
  }
  assert.equal(th.opts.methods.select.gesture, true);
  for (const n of ['getState', 'list', 'get', 'loadMore', 'refresh', 'select', 'filter']) assert.equal(th.opts.methods[n].preview, 'allow', n);
});

test('Todo import is opt-in, uses a selected message identity, and sends no body', async (t) => {
  const calls = [];
  const integrations = {
    status: () => ({ installed: true, enabled: true, running: true, capabilities: ['tasks.addExternal'] }),
    call: async (target, method, payload) => { calls.push({ target, method, payload }); return { ok: true }; },
  };
  const { widget, th } = setup({ flags: { mockData: true }, integrations });
  widget.start();
  t.after(() => widget.stop());
  const id = (await th.call('list')).items[0].id;
  assert.equal((await th.call('addToTodo', [id])).ok, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(widget.settings.save({ todoIntegration: true }), { ok: true });
  assert.equal((await th.call('addToTodo', [id], { preview: true })).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await th.call('addToTodo', [id])).ok, true);
  assert.equal(calls[0].target, 'todo');
  assert.equal(calls[0].method, 'tasks.addExternal');
  assert.equal(calls[0].payload.source.widgetId, 'mail');
  assert.ok(calls[0].payload.source.itemId);
  assert.equal('body' in calls[0].payload, false);
  assert.equal('attachments' in calls[0].payload, false);
});

test('--mock-data: example accounts and mail, nothing secret in what a theme sees', async (t) => {
  const { widget, th } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const view = await th.call('getState');
  assert.equal(view.mock, true);
  assert.deepEqual(view.accounts.map((a) => a.name), ['회사 (두레이)', '개인 (네이버)', 'Gmail', '다음 메일', '팀 공용 (두레이)', '쇼핑 (Gmail)', '예전 회사 (기타 IMAP)']);
  assert.ok(view.totalUnread >= 4);
  const json = JSON.stringify(view);
  for (const secret of ['username', 'host', 'password', 'imap.', 'security']) assert.ok(!json.includes(secret), `${secret} not in the state`);
  const list = await th.call('list');
  assert.ok(list.items.length >= 8);
  for (let i = 1; i < list.items.length; i++) assert.ok(list.items[i - 1].date >= list.items[i].date, 'newest first');
  assert.equal(list.hasMore, true, 'mock accounts have more on "the server"');
  const more = await th.call('loadMore');
  assert.ok(more.items.length > list.items.length);
  assert.ok(!JSON.stringify(list).includes('messageId'), 'no Message-ID for themes');
});

test('select: text body, attachments, marks read; the preview does not; writes need a click', async (t) => {
  const { widget, th } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const list = await th.call('list');
  const html = list.items.find((m) => m.subject.includes('업무'));
  assert.equal(html.unread, true);
  const inPreview = await th.call('select', [html.id], { preview: true });
  assert.equal(inPreview.ok, true);
  assert.equal(inPreview.message.unread, true, 'theme preview: read only');
  const res = await th.call('select', [html.id]);
  assert.equal(res.ok, true);
  assert.match(res.message.text, /다크 글래스 시안 좋습니다/);
  assert.equal(res.message.hasHtml, true);
  assert.equal(res.message.remoteImages, 2);
  assert.equal(res.message.unread, false);
  assert.ok(!('html' in res.message), 'a theme never gets the HTML');
  const withFile = list.items.find((m) => m.hasAttachments && m.subject.startsWith('주간 보고서'));
  const d = await th.call('get', [withFile.id]);
  assert.deepEqual(d.message.attachments.map((a) => a.name), ['주간보고_10월3주.xlsx', '그래프.png']);
  assert.match((await th.call('markUnread', [html.id], { activated: false })).message, /클릭/);
  assert.match((await th.call('markUnread', [html.id], { preview: true })).message, /미리보기/);
  assert.equal((await th.call('select', ['../../etc:1'])).ok, false);
  assert.equal((await th.call('select', [{ toString: () => 'x' }])).ok, false);
});

test('openPreview: the isolated view (JS off, own in-memory session, no preload), sanitized HTML, images per message', async (t) => {
  const { widget, th, fe, windows, handlers } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const list = await th.call('list');
  const html = list.items.find((m) => m.subject.includes('업무'));
  assert.deepEqual(await th.call('openPreview', [html.id]), { ok: true });
  const win = windows[0];
  assert.equal(path.basename(win.o.html), 'reader.html');
  const view = fe.rec.views[0];
  const wp = view.opts.webPreferences;
  assert.deepEqual([wp.javascript, wp.sandbox, wp.contextIsolation, wp.nodeIntegration, wp.partition, wp.preload], [false, true, true, false, 'mail-preview', undefined]);
  assert.equal(fe.rec.partition, 'mail-preview', 'not "persist:": memory only');
  // The reader page asks for the content.
  const sender = win.webContents;
  const shown = await handlers.get('mail-reader')({ sender }, 'ready');
  assert.equal(shown.subject, html.subject);
  assert.ok(!('html' in shown), 'the reader page never holds the HTML');
  const doc = Buffer.from(fe.rec.loaded[0].split(',')[1], 'base64').toString();
  assert.match(doc, /img-src data:;/);
  assert.doesNotMatch(doc, /<script|onclick/i);
  assert.equal(fe.rec.session.filter ? 'set' : 'none', 'set');
  let decision;
  fe.rec.session.filter({ url: 'https://cdn.example.com/banner.png', resourceType: 'image', webContentsId: 77 }, (d) => (decision = d));
  assert.deepEqual(decision, { cancel: true }, 'remote images blocked by default');
  // Another window's IPC is ignored.
  assert.equal(await handlers.get('mail-reader')({ sender: {} }, 'ready'), null);
  // "이 메일만 이미지 표시"
  assert.deepEqual(await handlers.get('mail-reader')({ sender }, 'action', { name: 'showImages' }), { ok: true });
  fe.rec.session.filter({ url: 'https://cdn.example.com/banner.png', resourceType: 'image', webContentsId: 77 }, (d) => (decision = d));
  assert.deepEqual(decision, { cancel: false });
  assert.match(Buffer.from(fe.rec.loaded.at(-1).split(',')[1], 'base64').toString(), /img-src data: https: http:;/);
  // Links: only http(s) / mailto, to the default browser.
  const opened = [];
  widget._internals; // eslint quiet
  view.handlers['will-navigate']({ preventDefault: () => opened.push('prevented') }, 'javascript:alert(1)');
  assert.deepEqual(opened, ['prevented']);
  assert.deepEqual(view.openHandler({ url: 'file:///c:/x' }), { action: 'deny' });
  // Message-ID copy for Thunderbird (no automation, the user pastes it).
  const copied = await handlers.get('mail-reader')({ sender }, 'action', { name: 'copyId' });
  assert.equal(copied.messageId, `mock-${html.id.split(':')[1]}@desk-widgets.invalid`);
});

test('handoff: reply to the program (mailto with quote) or Gmail webmail compose; compose with to', async (t) => {
  const { widget, th, opened } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const list = await th.call('list');
  const work = list.items.find((m) => m.accountId === 'mock-work' && m.subject.startsWith('[긴급]'));
  const replied = await th.call('reply', [work.id]);
  assert.deepEqual([replied.ok, replied.via, replied.program], [true, 'mailto', 'Outlook']);
  assert.match(replied.note, /아무 창도 뜨지 않으면 "웹메일"을 누르거나 .*링크 유형별 기본값 선택.*MAILTO/, 'Windows may accept the link and open nothing');
  assert.match(opened.at(-1), /^mailto:boss@company\.example\?subject=Re%3A%20/);
  assert.match(decodeURIComponent(opened.at(-1)), /> 내일 오전 10시 고객사 회의에 쓸 자료/);
  const gmail = list.items.find((m) => m.accountId === 'mock-gmail');
  assert.deepEqual(await th.call('forward', [gmail.id]), { ok: true, via: 'webmail' });
  assert.match(opened.at(-1), /^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
  assert.equal((await th.call('compose', [{ accountId: 'mock-work', to: 'a@b.test' }])).via, 'mailto');
  assert.equal(opened.at(-1), 'mailto:a@b.test');
  await th.call('compose', [{ accountId: 'mock-work', to: 'x@y.test?bcc=evil@z.test' }]);
  assert.equal(opened.at(-1), 'mailto:', 'an unsafe address is dropped');
  assert.deepEqual(await th.call('openWebmail', [{ accountId: 'mock-naver' }]), { ok: true });
  assert.equal(opened.at(-1), 'https://mail.naver.com/');
});

test('accounts: 연결 확인 with provider hints, password only encrypted in secrets.json, then real sync and cards', async (t) => {
  const fake = new FakeImap({ messages: [textMessage(1, { date: NOW - 3600000, subject: '기존 메일' })], user: 'me@x.test', pass: 'app-pass' });
  await fake.listen();
  t.after(() => fake.close());
  const { widget, th, cards, dataDir, getState } = setup({ fake });
  const acc = { provider: 'other', host: 'imap.x.test', port: 993, security: 'tls', username: 'me@x.test', name: '테스트' };
  assert.equal(widget.needsSetup(), true);
  // Saving without a check is refused.
  assert.match(widget.settings.save({ accounts: [acc] }).message, /연결 확인/);
  const wrong = await widget.settings.handlers.check({ ...acc, password: 'nope' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /거절/);
  const gmailWrong = await widget.settings.handlers.check({ ...acc, provider: 'gmail', password: 'nope' });
  assert.match(gmailWrong.message, /앱 비밀번호/, 'Gmail hint');
  const ok = await widget.settings.handlers.check({ ...acc, password: 'app-pass' });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.exists, 1);
  assert.ok(ok.token);
  // The token is bound to the login it was checked with.
  assert.match(widget.settings.save({ accounts: [{ ...acc, username: 'other@x.test', draft: ok.token }] }).message, /바뀌었습니다/);
  assert.deepEqual(widget.settings.save({ accounts: [{ ...acc, draft: ok.token }] }), { ok: true });
  const settingsFile = JSON.stringify(getState());
  assert.ok(!settingsFile.includes('app-pass'), 'no password in settings');
  const secretFile = fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8');
  assert.ok(!secretFile.includes('app-pass'), 'secrets.json holds ciphertext only');
  const id = getState().accounts[0].id;
  assert.equal(fakeCrypto.decrypt(JSON.parse(secretFile)[id]), 'app-pass');
  assert.equal(widget.needsSetup(), false);

  widget.start();
  t.after(() => widget.stop());
  // The first list can arrive before the account finishes its initial sync.
  await waitFor(async () => (await th.call('list')).items.length === 1 && (await th.call('getState')).accounts[0].state === 'ok');
  assert.equal((await th.call('getState')).accounts[0].state, 'ok');
  assert.equal(cards.length, 0, 'first sync: no cards');
  await waitFor(() => fake.log.some((l) => / IDLE$/.test(l)));
  fake.deliver(textMessage(2, { date: NOW, subject: '회의 안내', from: { name: '김부장', address: 'boss@x.test' } }));
  await waitFor(() => cards.length === 1);
  const [card] = cards[0].list;
  assert.deepEqual([card.type, card.title, card.body, card.icon, card.tag], ['card', '김부장', '회의 안내 · 테스트', 'mail', `mail:${id}:2`]);
  assert.equal('ids' in card, false, 'only engine card fields');
  // 읽음 on the card marks it read on the server.
  await cards[0].opts.onAction({ ...card }, 'read');
  assert.ok(fake.messages[1].flags.includes('\\Seen'));
  // 열기 brings the widget forward and shows that message.
  await cards[0].opts.onAction({ ...card }, 'open');
  assert.ok(th.focused >= 1);
  assert.deepEqual(th.emitted.filter(([n]) => n === 'reveal').at(-1), ['reveal', { id: `${id}:2` }]);
  // Turning the account's notifications off: no more cards.
  widget.settings.save({ accounts: [{ ...getState().accounts[0], notify: false }] });
  fake.deliver(textMessage(3, { date: NOW, subject: '조용히' }));
  await waitFor(async () => (await th.call('list')).items.length === 3);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cards.length, 1);
  // Removing the account removes its password and cache.
  widget.settings.save({ accounts: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')), {});
  assert.deepEqual(fs.existsSync(path.join(dataDir, 'cache')) ? fs.readdirSync(path.join(dataDir, 'cache')) : [], []);
});

test('many arrivals at once: one summary card', async (t) => {
  const fake = new FakeImap({ messages: [], user: 'me', pass: 'pw' });
  await fake.listen();
  t.after(() => fake.close());
  const { widget, cards } = setup({ fake });
  const acc = { provider: 'other', host: 'imap.x.test', port: 993, security: 'tls', username: 'me' };
  const ok = await widget.settings.handlers.check({ ...acc, password: 'pw' });
  widget.settings.save({ accounts: [{ ...acc, draft: ok.token }] });
  widget.start();
  t.after(() => widget.stop());
  await waitFor(() => fake.log.some((l) => / IDLE$/.test(l)));
  fake.messages.push(...[1, 2, 3, 4, 5].map((u) => textMessage(u, { date: NOW, subject: `메일 ${u}`, from: { name: `사람${u}`, address: `p${u}@x.test` } })));
  for (const c of fake.conns) c.send('* 5 EXISTS');
  await waitFor(() => cards.length === 1);
  assert.equal(cards[0].list.length, 1);
  assert.equal(cards[0].list[0].title, '새 메일 5통');
});

test('theme packages: manifests valid for the mail contract, CSS follows the host opacity, pages load only theme/kit files', () => {
  const themesDir = path.join(mailDir, 'themes');
  for (const [id, base, opacity] of [['default', undefined, 0.8], ['compact', 'default', 0.82]]) {
    const m = JSON.parse(fs.readFileSync(path.join(themesDir, id, 'theme.json'), 'utf8'));
    assert.deepEqual([m.id, m.widget, m.contractVersion, m.extends, m.background.opacity], [id, 'mail', 1, base, opacity]);
    const { errors, compatible } = validateManifest(m, id, { widgetId: 'mail', contractVersions: [1], frames: { main: {} } });
    assert.deepEqual(errors, [], id);
    assert.ok(compatible);
    const page = fs.readFileSync(path.join(themesDir, id, 'index.html'), 'utf8');
    for (const ref of [...page.matchAll(/(?:href|src)="([^"]+)"/g)].map((x) => x[1])) {
      const found = [path.join(themesDir, id, ref), path.join(themesDir, 'default', ref), path.join(mailDir, 'kit', ref)].some((f) => fs.existsSync(f));
      assert.ok(found, `${id}: ${ref}`);
    }
  }
  assert.match(fs.readFileSync(path.join(themesDir, 'default', 'mail.css'), 'utf8'), /--card-alpha: var\(--theme-bg-alpha, 0\.8\);/);
  assert.match(fs.readFileSync(path.join(themesDir, 'compact', 'compact.css'), 'utf8'), /--card-alpha: var\(--theme-bg-alpha, 0\.82\);/);
  for (const f of ['default/mail.js', 'compact/compact.js']) {
    const js = fs.readFileSync(path.join(themesDir, f), 'utf8');
    assert.doesNotMatch(js, /window\.dooray|require\(|innerHTML|insertAdjacentHTML|eval\(/, f);
  }
});

test('package: widget.json 0.0.1, reader / kit / themes inside, tests left out', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(mailDir, 'widget.json'), 'utf8'));
  assert.deepEqual([manifest.id, manifest.name, manifest.version, manifest.engineApi, manifest.package.productName], ['mail', '메일', '1.0.1', '1.3', 'MailWidget']);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-mail-')), 'mail');
  const pkg = packageWidget(mailDir, out);
  for (const f of ['index.js', 'lib/imap-client.js', 'lib/preview.js', 'reader/reader.html', 'reader/preload.js', 'kit/mail-model.js', 'themes/default/theme.json', 'themes/compact/theme.json', 'settings/panel.js']) {
    assert.ok(fs.existsSync(path.join(pkg, f)), f);
  }
  assert.equal(fs.existsSync(path.join(pkg, 'test')), false);
  assert.equal(fs.existsSync(path.join(pkg, 'package.json')), false);
  // The package needs nothing outside itself (no node_modules).
  for (const f of fs.readdirSync(path.join(pkg, 'lib'))) {
    const src = fs.readFileSync(path.join(pkg, 'lib', f), 'utf8');
    for (const m of src.matchAll(/require\('([^']+)'\)/g)) {
      const inside = m[1].startsWith('.') && fs.existsSync(`${path.resolve(pkg, 'lib', m[1])}.js`) && path.resolve(pkg, 'lib', m[1]).startsWith(pkg);
      assert.ok(inside || ['fs', 'path', 'tls', 'net', 'events', 'crypto', 'electron'].includes(m[1]), `${f}: ${m[1]}`);
    }
  }
});

test('no encryption available: a typed password is refused before anything is stored or sent', async (t) => {
  const fake = new FakeImap({ messages: [] });
  await fake.listen();
  t.after(() => fake.close());
  const { ctx } = withThemeHost({
    id: 'mail',
    dir: mailDir,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mail-ns-')),
    flags: {},
    createStore: () => {
      let s = sanitize({ ...DEFAULTS });
      return { load: () => s, save: (v) => (s = sanitize({ ...s, ...v })) };
    },
    sendToSettings: () => {},
  });
  const widget = create(ctx, { crypto: { available: () => false, encrypt: () => '', decrypt: () => '' }, imap: fake.deps() });
  const res = await widget.settings.handlers.check({ provider: 'other', host: 'imap.x.test', port: 993, security: 'tls', username: 'me', password: 'pw' });
  assert.equal(res.ok, false);
  assert.match(res.message, /암호화 저장/);
  assert.equal(fake.logins, 0, 'the password was not sent either');
  assert.equal(widget.settings.get().secretAvailable, false);
});

test('#65 bug 2: no default mail program -> a visible message and a "웹메일로 쓰기" fallback, never silence', async (t) => {
  const { widget, th, opened, windows, handlers, cards } = setup({ flags: { mockData: true }, openFails: (url) => url.startsWith('mailto:') });
  widget.start();
  t.after(() => widget.stop());
  const list = await th.call('list');
  const work = list.items.find((m) => m.accountId === 'mock-work' && m.subject.startsWith('[긴급]'));
  // The click must count as a user gesture (engine rule); without one the theme gets a message, not silence.
  assert.match((await th.call('reply', [work.id], { activated: false })).message, /클릭/);
  const res = await th.call('reply', [work.id]);
  assert.equal(res.ok, false, 'a rejected mailto: is reported');
  assert.match(res.message, /메일 프로그램을 열지 못했습니다/);
  assert.match(res.message, /기본 앱 → "링크 유형별 기본값 선택".*MAILTO/);
  assert.equal(res.fallback, 'webmail', 'this account has a webmail address');
  assert.ok(!res.message.includes('mailto:'), 'the link (with the quoted mail) is not echoed');
  const again = await th.call('reply', [work.id, { via: 'webmail' }]);
  assert.deepEqual(again, { ok: true, via: 'webmail' });
  assert.equal(opened.at(-1), 'https://company.dooray.com/mail');
  for (const name of ['forward', 'compose']) {
    const r = name === 'compose' ? await th.call('compose', [{ accountId: 'mock-work' }]) : await th.call(name, [work.id]);
    assert.equal(r.ok, false, name);
    assert.equal(r.fallback, 'webmail', name);
  }
  // Same in the reader window: the error comes back to the page with the fallback.
  await th.call('openPreview', [work.id]);
  const sender = windows[0].webContents;
  await handlers.get('mail-reader')({ sender }, 'ready');
  const inReader = await handlers.get('mail-reader')({ sender }, 'action', { name: 'reply' });
  assert.equal(inReader.fallback, 'webmail');
  assert.deepEqual(await handlers.get('mail-reader')({ sender }, 'action', { name: 'reply', via: 'webmail' }), { ok: true, via: 'webmail' });
  // The right-click menu has no page: its failure becomes a card.
  const menu = th.opts.menuItems({ frame: 'main', preview: false });
  await menu.find((i) => i.label === '새 메일 쓰기').click();
  await waitFor(() => cards.length === 1);
  assert.equal(cards[0].list[0].title, '새 메일을 쓸 수 없습니다');
  assert.deepEqual(cards[0].list[0].actions, [{ id: 'webmail', label: '웹메일로 쓰기' }]);
});

test('#65 bug 2: a failing webmail launch is reported, and a webmail account is offered the mail program', async (t) => {
  const { widget, th } = setup({ flags: { mockData: true }, openFails: () => true });
  widget.start();
  t.after(() => widget.stop());
  const res = await th.call('openWebmail', [{ accountId: 'mock-naver' }]);
  assert.equal(res.ok, false);
  assert.match(res.message, /브라우저를 열지 못했습니다/);
  const gmail = (await th.call('list')).items.find((m) => m.accountId === 'mock-gmail');
  const r = await th.call('forward', [gmail.id]);
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'mailto', 'webmail account: offer the mail program instead');
});

test('#65 bug 2: no mailto handler registered in Windows -> webmail at once (with a note), or the 기본 앱 hint', async (t) => {
  const { widget, th, opened } = setup({ flags: { mockData: true }, mailProgram: '' });
  widget.start();
  t.after(() => widget.stop());
  assert.equal((await th.call('getState')).mailProgram, null);
  assert.equal(widget.settings.get().mailProgram, null);
  const work = (await th.call('list')).items.find((m) => m.accountId === 'mock-work');
  const res = await th.call('reply', [work.id]);
  assert.deepEqual([res.ok, res.via], [true, 'webmail']);
  assert.match(res.note, /기본 메일 프로그램이 없어 웹메일로/);
  assert.ok(!opened.some((u) => u.startsWith('mailto:')), 'no link that cannot open');
  // The user can still ask for the mail program explicitly.
  await th.call('reply', [work.id, { via: 'mailto' }]);
  assert.match(opened.at(-1), /^mailto:/);
});

test('#65 bug 2: no handler and no webmail address -> the 기본 앱 hint, nothing launched', async (t) => {
  const fake = new FakeImap({ messages: [textMessage(1, { date: NOW })], user: 'me', pass: 'pw' });
  await fake.listen();
  t.after(() => fake.close());
  const { widget, th, opened } = setup({ fake, mailProgram: '' });
  const acc = { provider: 'other', host: 'imap.x.test', port: 993, security: 'tls', username: 'me', compose: 'mailto' };
  const ok = await widget.settings.handlers.check({ ...acc, password: 'pw' });
  widget.settings.save({ accounts: [{ ...acc, draft: ok.token }] });
  widget.start();
  t.after(() => widget.stop());
  const res = await th.call('compose', [{}]);
  assert.equal(res.ok, false);
  assert.match(res.message, /기본 메일 프로그램이 없습니다.*MAILTO.*웹메일 주소를 넣으면/);
  assert.equal(res.fallback, undefined);
  assert.deepEqual(opened, []);
});

test('reader window: back goes to the previous message, then closes; forward; side buttons and Alt+←', async (t) => {
  const { widget, th, windows, handlers, fe } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const [a, b] = (await th.call('list')).items;
  await th.call('openPreview', [a.id]);
  const win = windows[0];
  const sender = win.webContents;
  assert.equal((await handlers.get('mail-reader')({ sender }, 'ready')).id, a.id);
  await th.call('openPreview', [b.id]);
  assert.equal(windows.length, 1, 'the same window shows the next message');
  assert.equal(win.title, `${b.subject} - 메일`);
  // Mouse side button "back" (Windows app command) -> the first message.
  win.handlers['app-command']({}, 'browser-backward');
  assert.equal(win.title, `${a.subject} - 메일`);
  assert.equal(win.destroyed, false);
  // Forward again from the page (its Alt+→).
  assert.equal(await handlers.get('mail-reader')({ sender }, 'navigate', { action: 'forward' }), true);
  assert.equal(win.title, `${b.subject} - 메일`);
  // Alt+← with the keyboard in the message body view.
  let prevented = false;
  fe.rec.views[0].handlers['before-input-event']({ preventDefault: () => (prevented = true) }, { type: 'keyDown', alt: true, key: 'ArrowLeft' });
  assert.equal(prevented, true);
  assert.equal(win.title, `${a.subject} - 메일`);
  // Nothing before the first message: back closes the reader window.
  win.handlers['app-command']({}, 'browser-backward');
  assert.equal(win.destroyed, true);
});

const { FakeSmtp } = require('./fake-smtp');

/** An "other" IMAP + SMTP account on the fake servers, saved through 연결 확인. */
async function sendSetup(t, { smtpOpts = {}, sentBox = true, dialog = null, files = null } = {}) {
  const imap = new FakeImap({ messages: [textMessage(1, { date: NOW - 3600000, subject: '회의 자료', from: { name: '김부장', address: 'boss@y.test' }, to: [{ name: '나', address: 'me@x.test' }, { name: '', address: 'kim@y.test' }], text: '자료를 부탁합니다.' })], user: 'me@x.test', pass: 'pw' });
  if (sentBox) imap.boxes['Sent'] = { flags: ['\\Sent'], messages: [] };
  await imap.listen();
  const smtp = new FakeSmtp({ user: 'me@x.test', pass: 'pw', ...smtpOpts });
  await smtp.listen();
  t.after(async () => {
    await imap.close();
    await smtp.close();
  });
  const env = setup({ fake: imap, smtp, dialog, files });
  const acc = { provider: 'other', name: '회사', host: 'imap.x.test', port: 993, security: 'tls', smtpHost: 'smtp.x.test', smtpPort: 465, smtpSecurity: 'tls', username: 'me@x.test', senderName: '나', signature: '나 드림' };
  const ok = await env.widget.settings.handlers.check({ ...acc, password: 'pw' });
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(ok.smtp, { ok: true }, '연결 확인 also logs in to SMTP');
  assert.deepEqual(env.widget.settings.save({ accounts: [{ ...acc, draft: ok.token }] }), { ok: true });
  env.widget.start();
  t.after(() => env.widget.stop());
  await waitFor(async () => (await env.th.call('list')).items.length === 1);
  const id = (await env.th.call('list')).items[0].id;
  return { ...env, imap, smtp, id, accountId: env.getState().accounts[0].id };
}

const composerCall = (env, win, name, arg) => env.handlers.get('mail-composer')({ sender: win.wc }, name, arg);

test('#68 reply in the widget: composer from the right account, quote and threading, background send, Sent copy, \\Answered', async (t) => {
  const env = await sendSetup(t);
  assert.equal(env.getState().accounts[0].compose, 'widget', 'new default: 위젯에서 보내기');
  assert.deepEqual(await env.th.call('reply', [env.id]), { ok: true, via: 'widget' });
  const win = env.windows.at(-1);
  assert.equal(path.basename(win.o.html), 'composer.html');
  const { draft, accounts } = await composerCall(env, win, 'init');
  assert.equal(draft.accountId, env.accountId, 'the account the original came to');
  assert.deepEqual(accounts.map((a) => [a.label, a.canSend]), [['회사 <me@x.test>', true]]);
  assert.deepEqual(draft.to, [{ name: '김부장', address: 'boss@y.test' }], 'chips prefilled from the original');
  assert.deepEqual(draft.cc, []);
  assert.equal(draft.subject, 'Re: 회의 자료');
  assert.match(draft.body, /^\n\n\n-- \n나 드림\n\n.* 김부장 <boss@y\.test> 님이 작성:\n> 자료를 부탁합니다\.$/);
  assert.ok(!JSON.stringify(draft).includes('path'), 'no file paths for the page');
  // Address check before anything is sent; the window stays.
  const bad = await composerCall(env, win, 'send', { ...draft, cc: [{ name: '', address: 'not an address', invalid: true }] });
  assert.deepEqual([bad.ok, bad.field], [false, 'cc']);
  assert.equal(win.destroyed, false);
  // 보내기: the window closes at once, the widget shows "보내는 중", the send runs in the background.
  const res = await composerCall(env, win, 'send', { ...draft, body: `고맙습니다.${draft.body}` });
  assert.deepEqual(res, { ok: true, queued: true });
  assert.equal(win.destroyed, true);
  assert.equal(env.widget._internals.outbox.size, 1);
  await waitFor(() => env.smtp.messages.length === 1 && env.widget._internals.outbox.size === 0);
  const sent = env.smtp.messages[0];
  assert.equal(sent.from, 'me@x.test', 'the right sender');
  assert.deepEqual(sent.rcpts, ['boss@y.test']);
  assert.match(sent.data, /^From: =\?UTF-8\?B\?/m);
  assert.match(sent.data, /^In-Reply-To: <m1@x\.test>$/m);
  assert.match(sent.data, /^References: <m1@x\.test>$/m);
  await waitFor(() => env.imap.appends.length === 1);
  assert.equal(env.imap.appends[0].box, 'Sent');
  await waitFor(() => env.imap.messages[0].flags.includes('\\Answered'));
  const view = await env.th.call('getState');
  assert.equal(view.sending, 0);
  assert.equal(view.lastSent.ok, true);
  assert.equal(view.lastSent.sentFolder, 'Sent');
  assert.ok(!env.cards.some((c) => c.list[0].title === '메일 보내기 실패'));
  assert.equal(env.widget._internals.composer.drafts.size, 0, 'the draft is gone after sending');
});

test('#68 failed send: sticky card, 다시 열기 reopens the composer with everything kept', async (t) => {
  const env = await sendSetup(t, { smtpOpts: { refuse: ['nobody@y.test'] } });
  await env.th.call('compose', [{ accountId: env.accountId }]);
  const win = env.windows.at(-1);
  const { draft } = await composerCall(env, win, 'init');
  assert.equal(draft.subject, '');
  assert.match(draft.body, /^\n\n\n-- \n나 드림$/, 'a new mail starts with the signature');
  await composerCall(env, win, 'send', { ...draft, to: [{ name: '', address: 'nobody@y.test' }], subject: '실패할 메일', body: '내용 그대로' });
  await waitFor(() => env.cards.some((c) => c.list[0].title === '메일 보내기 실패'));
  const card = env.cards.find((c) => c.list[0].title === '메일 보내기 실패');
  assert.equal(card.list[0].sticky, true);
  assert.match(card.list[0].body, /"실패할 메일" — 받는 사람 nobody@y\.test: 서버가 받는 사람을 거절했습니다/);
  assert.deepEqual(card.list[0].actions, [{ id: 'reopen', label: '다시 열기' }]);
  assert.equal(env.smtp.messages.length, 0);
  card.opts.onAction({ ...card.list[0] }, 'reopen');
  const again = env.windows.at(-1);
  assert.notEqual(again, win);
  const reopened = (await composerCall(env, again, 'init')).draft;
  assert.deepEqual([reopened.to, reopened.subject, reopened.body], [[{ name: '', address: 'nobody@y.test' }], '실패할 메일', '내용 그대로']);
  assert.match(reopened.error, /거절/);
  assert.equal((await env.th.call('getState')).lastSent.ok, false);
});

test('#68 attachments from the PC (size cap, remove) are sent as files with their Korean names', async (t) => {
  const store = { 'C:\\docs\\보고서.pdf': Buffer.from('%PDF-1.4 test'), 'C:\\docs\\big.zip': { size: 21 * 1024 * 1024 } };
  const files = {
    statSync: (f) => ({ isFile: () => true, size: Buffer.isBuffer(store[f]) ? store[f].length : store[f].size }),
    readFileSync: (f) => store[f],
  };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: Object.keys(store) }) };
  const env = await sendSetup(t, { dialog, files });
  await env.th.call('compose', [{ accountId: env.accountId, to: 'a@y.test' }]);
  const win = env.windows.at(-1);
  const { draft } = await composerCall(env, win, 'init');
  assert.deepEqual(draft.to, [{ name: '', address: 'a@y.test' }]);
  const picked = await composerCall(env, win, 'pickFiles');
  assert.deepEqual(picked.files.map((f) => f.name), ['보고서.pdf']);
  assert.match(picked.message, /20\.0MB까지.*big\.zip/);
  await composerCall(env, win, 'send', { ...draft, subject: '파일', body: '첨부합니다' });
  await waitFor(() => env.smtp.messages.length === 1);
  assert.match(env.smtp.messages[0].data, /Content-Disposition: attachment; filename\*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C\.pdf/);
  assert.match(env.smtp.messages[0].data, /JVBERi0xLjQgdGVzdA==/);
});

test('#68 migration: accounts saved with the old default (mailto) now send from the widget, once', () => {
  const { upgrade } = require('../lib/settings');
  const old = { accounts: [{ id: 'a', compose: 'mailto' }, { id: 'b', compose: 'webmail' }] };
  const up = upgrade(old);
  assert.deepEqual(up.accounts.map((a) => a.compose), ['widget', 'webmail']);
  assert.equal(up.composeDefault, 2);
  assert.equal(upgrade({ ...up, accounts: [{ id: 'a', compose: 'mailto' }] }).accounts[0].compose, 'mailto', 'a later choice of mailto stays');
});

test('#68 --mock-data: reply sends without network and a "실패" subject shows the failure card', async (t) => {
  const { widget, th, windows, handlers, cards } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const work = (await th.call('list')).items.find((m) => m.accountId === 'mock-work' && m.subject.startsWith('[긴급]'));
  assert.equal((await th.call('reply', [work.id, { via: 'widget' }])).via, 'widget');
  const win = windows.at(-1);
  const init = await handlers.get('mail-composer')({ sender: win.wc }, 'init');
  assert.match(init.draft.body, /-- \n나\n회사 개발팀/);
  await handlers.get('mail-composer')({ sender: win.wc }, 'send', { ...init.draft, subject: '테스트 실패' });
  await waitFor(() => cards.some((c) => c.list[0].title === '메일 보내기 실패'));
});

test('#68 forward: the original attachment is fetched from the server and sent along (or reported when too big)', async (t) => {
  const env = await sendSetup(t);
  await waitFor(() => env.imap.log.some((l) => / IDLE$/.test(l)));
  env.imap.deliver(altMessage(2, { date: NOW, subject: '계약서', html: '<p>첨부 확인</p>', text: '첨부 확인', attachment: 'contract.pdf' }));
  await waitFor(async () => (await env.th.call('list')).items.length === 2);
  const fwdId = (await env.th.call('list')).items[0].id;
  await env.th.call('forward', [fwdId]);
  const win = env.windows.at(-1);
  const { draft } = await composerCall(env, win, 'init');
  assert.equal(draft.subject, 'Fwd: 계약서');
  assert.deepEqual([draft.forward.names, draft.forward.include, draft.forward.tooBig], [['contract.pdf'], true, false]);
  assert.match(draft.body, /---------- 전달된 메일 ----------/);
  assert.deepEqual(draft.to, [], 'a forward starts without recipients');
  await composerCall(env, win, 'send', { ...draft, to: [{ name: '친구', address: 'friend@y.test' }], includeForward: true });
  await waitFor(() => env.smtp.messages.length === 1);
  assert.match(env.smtp.messages[0].data, /filename="contract\.pdf"/);
  assert.ok(env.imap.log.some((l) => /BODY\.PEEK\[2\]/.test(l)), 'the attachment part was fetched');
  assert.doesNotMatch(env.smtp.messages[0].data, /^In-Reply-To:/m, 'a forward is not a reply');
});

test('#68 crash regression: closing / cancelling a composer never touches a destroyed window', async (t) => {
  const { widget, th, windows, handlers } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const work = (await th.call('list')).items.find((m) => m.accountId === 'mock-work');
  const call = (win, name, arg) => handlers.get('mail-composer')({ sender: win.wc }, name, arg);
  // 1) 답장 then close the window untouched (the user's crash: 'closed' read win.webContents).
  await th.call('reply', [work.id, { via: 'widget' }]);
  const a = windows.at(-1);
  assert.doesNotThrow(() => a.close());
  assert.equal(a.destroyed, true);
  assert.equal(await call(a, 'init'), null, 'a closed window gets no answers');
  // 2) 버리기 (discard).
  await th.call('reply', [work.id, { via: 'widget' }]);
  const b = windows.at(-1);
  assert.equal(await call(b, 'discard'), true);
  assert.equal(b.destroyed, true);
  // 3) typed text, close -> confirm; the widget is turned off before the answer: nothing throws.
  await th.call('reply', [work.id, { via: 'widget' }]);
  const c = windows.at(-1);
  await call(c, 'update', { body: '쓰던 내용' });
  assert.doesNotThrow(() => c.close());
  assert.equal(c.destroyed, false, 'asked first (the draft is only in memory)');
  widget.stop();
  assert.equal(c.destroyed, true);
  // The confirm (answered 0 = 버리기 by the fake) resolves after the window died: no error, no dialog.
  await new Promise((r) => setTimeout(r, 10));
  // 4) The reader window closes the same way.
  widget.start();
  await th.call('openPreview', [work.id]);
  const r = windows.at(-1);
  assert.doesNotThrow(() => r.close());
  assert.doesNotThrow(() => widget._internals.reader.navigate('back'));
});

test('#68 crash regression: 보내기 -> destroy -> closed, the queued send answers ok and goes out', async (t) => {
  const env = await sendSetup(t);
  await env.th.call('reply', [env.id]);
  const win = env.windows.at(-1);
  const { draft } = await composerCall(env, win, 'init');
  // Any 'closed' listener added after the composer's own (e.g. a future one) throwing inside destroy().
  const own = win.handlers.closed;
  win.handlers.closed = () => {
    own();
    throw new TypeError('Object has been destroyed');
  };
  const res = await composerCall(env, win, 'send', { ...draft, body: '보냅니다' });
  assert.deepEqual(res, { ok: true, queued: true }, 'the page never sees a rejected send for a queued mail');
  assert.equal(win.destroyed, true);
  assert.equal(env.widget._internals.composer.drafts.get(draft.id)?.queued, true);
  await waitFor(() => env.smtp.messages.length === 1);
  await waitFor(() => env.widget._internals.composer.drafts.size === 0);
  // 버리기 through the same throwing close.
  await env.th.call('reply', [env.id]);
  const w2 = env.windows.at(-1);
  const own2 = w2.handlers.closed;
  w2.handlers.closed = () => {
    own2();
    throw new TypeError('Object has been destroyed');
  };
  assert.equal(await composerCall(env, w2, 'discard'), true);
  assert.equal(w2.destroyed, true);
});

test('#69 categories: create, put a message in several, chips in the list, filter (and 분류 없음), kept across a restart', async (t) => {
  const env = setup({ flags: { mockData: true } });
  env.widget.start();
  t.after(() => env.widget.stop());
  const { th } = env;
  const a = await th.call('createCategory', ['중요']);
  const b = await th.call('createCategory', ['결재', '#ff0000']);
  assert.equal(a.ok, true);
  assert.equal(b.category.color, '#ff0000');
  assert.match((await th.call('createCategory', ['중요'])).message, /같은 이름/);
  assert.match((await th.call('createCategory', ['x'], { preview: true })).message, /미리보기/);
  assert.match((await th.call('setCategories', ['mock-work:108', [a.category.id]], { activated: false })).message, /클릭/);
  const list = await th.call('list');
  const [m1, m2] = list.items;
  assert.deepEqual(m1.categoryIds, []);
  assert.deepEqual((await th.call('setCategories', [m1.id, [b.category.id, a.category.id, 'nope']])).categoryIds, [a.category.id, b.category.id], 'categories order, unknown ids dropped');
  await th.call('setCategories', [m2.id, [b.category.id]]);
  const view = await th.call('getState');
  assert.deepEqual(view.categories.map((c) => [c.name, c.count]), [['중요', 1], ['결재', 2]]);
  assert.deepEqual((await th.call('list')).items[0].categoryIds, [a.category.id, b.category.id]);
  const onlyB = await th.call('filter', [b.category.id]);
  assert.deepEqual(onlyB.items.map((m) => m.id), [m1.id, m2.id]);
  assert.equal((await th.call('getState')).categoryFilter, b.category.id, 'the widget keeps the filter (더 보기, other windows)');
  const none = await th.call('filter', ['__none__']);
  assert.ok(none.items.every((m) => m.categoryIds.length === 0) && none.items.length === list.items.length - 2);
  assert.equal((await th.call('filter', ['bogus'])).category, '', 'unknown filter = all');
  // The detail and the reader carry them.
  assert.deepEqual((await th.call('get', [m1.id])).message.categoryIds, [a.category.id, b.category.id]);
  // Nothing on the server: the mock "server" has no category field; the file is in the data dir.
  const file = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'categories-mock.json'), 'utf8'));
  assert.equal(Object.keys(file.assignments).length, 2);
  assert.ok(Object.keys(file.assignments).every((k) => k.startsWith('mock-work|mid:') || k.includes('|mid:')), 'keyed by account + Message-ID');
  // Restart: same categories on the same mail.
  env.widget.stop();
  env.widget.start();
  assert.deepEqual((await th.call('list')).items.find((m) => m.id === m1.id).categoryIds, [a.category.id, b.category.id]);
  // Settings: rename, recolor, delete (the deleted one leaves every message).
  const cats = env.widget.settings.get().categories;
  assert.deepEqual(env.widget.settings.save({ categories: [{ ...cats[1], name: '결재 대기', color: '#00ff00' }] }), { ok: true });
  const after = await th.call('getState');
  assert.deepEqual(after.categories.map((c) => [c.name, c.color]), [['결재 대기', '#00ff00']]);
  assert.deepEqual((await th.call('list')).items.find((m) => m.id === m1.id).categoryIds, [b.category.id]);
  assert.match(env.widget.settings.save({ categories: [{ name: 'a' }, { name: 'a' }] }).message, /같은 이름/);
});

test('#69 reader window: 분류 from the message view', async (t) => {
  const { widget, th, windows, handlers } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const [m] = (await th.call('list')).items;
  await th.call('openPreview', [m.id]);
  const sender = windows.at(-1).wc;
  const shown = await handlers.get('mail-reader')({ sender }, 'ready');
  assert.deepEqual([shown.categoryIds, shown.categories], [[], []]);
  const made = await handlers.get('mail-reader')({ sender }, 'action', { name: 'createCategory', label: '나중에' });
  assert.equal(made.ok, true);
  const set = await handlers.get('mail-reader')({ sender }, 'action', { name: 'setCategories', ids: [made.category.id] });
  assert.deepEqual(set.categoryIds, [made.category.id]);
  assert.deepEqual((await th.call('list')).items[0].categoryIds, [made.category.id]);
});

test('#70 address book: learned from mail, autocomplete in the composer, import vCard / CSV, sent recipients', async (t) => {
  const store = { 'C:/x/contacts.vcf': Buffer.from('BEGIN:VCARD\r\nFN:이대리\r\nEMAIL:lee@y.test\r\nEND:VCARD\r\n') };
  const files = { statSync: (f) => ({ isFile: () => true, size: store[f].length }), readFileSync: (f) => store[f] };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: Object.keys(store) }) };
  const env = await sendSetup(t, { dialog, files });
  await waitFor(() => env.widget.settings.handlers.contactsSearch('').total >= 2);
  const learned = env.widget.settings.handlers.contactsSearch('');
  assert.deepEqual(learned.list.map((c) => c.address).sort(), ['boss@y.test', 'kim@y.test'], 'From / To of received mail, not the own address');
  const imp = await env.widget.settings.handlers.contactsImport();
  assert.deepEqual([imp.found, imp.added], [1, 1]);
  // Autocomplete in the composer (already-chosen addresses left out).
  await env.th.call('compose', [{ accountId: env.accountId }]);
  const win = env.windows.at(-1);
  await composerCall(env, win, 'init');
  assert.deepEqual(await composerCall(env, win, 'suggest', { q: '이', exclude: [] }), [{ name: '이대리', address: 'lee@y.test' }]);
  assert.deepEqual(await composerCall(env, win, 'suggest', { q: 'y.test', exclude: ['boss@y.test'] }).then((l) => l.map((c) => c.address).sort()), ['kim@y.test', 'lee@y.test']);
  assert.deepEqual(await composerCall(env, win, 'suggest', { q: '  ', exclude: [] }), []);
  // Editing and deleting from the settings window.
  assert.equal(env.widget.settings.handlers.contactsRename('kim@y.test', '김과장').ok, true);
  assert.equal(env.widget.settings.handlers.contactsSearch('김과').list[0].address, 'kim@y.test');
  assert.deepEqual(env.widget.settings.handlers.contactsRemove('lee@y.test'), { ok: true });
  // A sent recipient goes into the book.
  const { draft } = await composerCall(env, win, 'init');
  await composerCall(env, win, 'send', { ...draft, to: [{ name: '새 고객', address: 'new@z.test' }], subject: 's', body: 'b' });
  await waitFor(() => env.widget.settings.handlers.contactsSearch('new@').list.length === 1);
  assert.equal(env.widget.settings.handlers.contactsSearch('new@').list[0].sent, 1);
});

test('#71 new-mail card: 분류 menu (items with the message\'s categories, toggle, create); none on a summary card', async (t) => {
  const fake = new FakeImap({ messages: [textMessage(1, { date: NOW - 3600000 })], user: 'me', pass: 'pw' });
  await fake.listen();
  t.after(() => fake.close());
  const { widget, th, cards } = setup({ fake });
  const acc = { provider: 'other', host: 'imap.x.test', port: 993, security: 'tls', username: 'me' };
  const ok = await widget.settings.handlers.check({ ...acc, password: 'pw' });
  widget.settings.save({ accounts: [{ ...acc, draft: ok.token }] });
  widget.start();
  t.after(() => widget.stop());
  await waitFor(() => fake.log.some((l) => / IDLE$/.test(l)));
  const a = await th.call('createCategory', ['중요']);
  fake.deliver(textMessage(2, { date: NOW, subject: '회의', from: { name: '김부장', address: 'boss@x.test' } }));
  await waitFor(() => cards.length === 1);
  const [card] = cards[0].list;
  const { menu } = cards[0].opts;
  assert.equal(menu.label, '분류');
  const event = { ...card }; // what the engine passes: the cleaned card
  assert.equal(menu.appliesTo(event), true);
  assert.equal(menu.appliesTo({ ...event, tag: 'mail-summary' }), false, 'a summary card has no single message');
  assert.deepEqual(menu.items(event), [{ id: a.category.id, label: '중요', color: a.category.color, checked: false }]);
  assert.equal(menu.toggle(event, a.category.id, true)[0].checked, true);
  const id = (await th.call('list')).items.find((m) => m.subject === '회의').id;
  assert.deepEqual((await th.call('get', [id])).message.categoryIds, [a.category.id], 'same storage as the widget (#69)');
  const after = menu.create.run(event, '결재');
  assert.deepEqual(after.map((i) => [i.label, i.checked]), [['중요', true], ['결재', true]]);
  assert.throws(() => menu.create.run(event, '중요'), /같은 이름/);
  assert.throws(() => menu.toggle({ tag: 'mail:zz:9' }, a.category.id, true), /찾지 못했습니다/);
});

test('#72 per-account stats in the state and the filter by account / unread / flagged / category', async (t) => {
  const { widget, th } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const view = await th.call('getState');
  assert.equal(view.accounts.length, 7);
  assert.deepEqual(view.counts, { unread: 'server', flagged: 'server', categories: 'loaded' });
  const team = view.accounts.find((a) => a.id === 'mock-team');
  assert.deepEqual([team.unread, team.flagged, team.loaded, team.email], [3, 1, 4, 'team@company.example']);
  assert.deepEqual(team.latest.map((m) => [m.subject, m.unread]), [['[배포] 메일 위젯 0.0.1 빌드 완료', true], ['대시보드 시안 공유드립니다', true], ['회의록 (10/19)', false]]);
  assert.equal(view.accounts.find((a) => a.id === 'mock-old').state, 'error');
  // Account only, then unread / flagged inside it.
  const all = await th.call('filter', [{ accountId: 'mock-team' }]);
  assert.ok(all.items.length === 4 && all.items.every((m) => m.accountId === 'mock-team'));
  assert.deepEqual(all.filter, { category: '', accountId: 'mock-team', unread: false, flagged: false });
  assert.deepEqual((await th.call('filter', [{ accountId: 'mock-team', unread: true }])).items.map((m) => m.unread), [true, true, true]);
  assert.deepEqual((await th.call('filter', [{ accountId: 'mock-team', flagged: true }])).items.map((m) => m.subject), ['대시보드 시안 공유드립니다']);
  // Category counts on the card (loaded headers) and the category filter inside the account.
  const c = await th.call('createCategory', ['시안']);
  await th.call('setCategories', [all.items[1].id, [c.category.id]]);
  assert.deepEqual((await th.call('getState')).accounts.find((a) => a.id === 'mock-team').categories, { [c.category.id]: 1 });
  assert.deepEqual((await th.call('filter', [{ accountId: 'mock-team', category: c.category.id }])).items.map((m) => m.id), [all.items[1].id]);
  // list() keeps the filter; a string filter (#69) clears the account part.
  assert.equal((await th.call('list')).items.length, 1);
  const back = await th.call('filter', ['']);
  assert.ok(back.items.some((m) => m.accountId !== 'mock-team'));
  // Unknown account / values = all.
  assert.deepEqual((await th.call('filter', [{ accountId: 'nope', unread: 'yes' }])).filter, { category: '', accountId: '', unread: false, flagged: false });
});

test('#72 더 보기 in one account loads more of that account only', async (t) => {
  const { widget, th } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const first = await th.call('filter', [{ accountId: 'mock-work' }]);
  assert.equal(first.items.length, 4, 'the mock account shows 4 of 5 at first');
  assert.equal(first.hasMore, true);
  const more = await th.call('loadMore');
  assert.equal(more.items.length, 5);
  assert.ok(more.items.every((m) => m.accountId === 'mock-work'));
  assert.equal(more.hasMore, false);
});

test('#79 api.refresh(): waits for every account and returns new mail and errors', async (t) => {
  const { widget, th } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const res = await th.call('refresh');
  assert.equal(res.ok, true);
  assert.equal(res.accounts, 7);
  assert.equal(res.newMail, 0);
  assert.deepEqual(res.errors.map((e) => e.name), ['예전 회사 (기타 IMAP)']);
  assert.ok(res.at > 0);
});

test('#80 함께 볼 메일함: 메일함 불러오기 (after 연결 확인), folder mail in the list, state and cards, read in its folder', async (t) => {
  const utf7 = require('../lib/utf7');
  const fake = new FakeImap({ messages: [textMessage(1, { date: NOW - 7200000, subject: '받은 메일' })], user: 'me@x.test', pass: 'app-pass' });
  fake.boxes['카페 알림'] = { flags: [], messages: [textMessage(10, { date: NOW - 3600000, subject: '카페 새 글' })], uidValidity: 9 };
  fake.boxes['보낸편지함'] = { flags: ['\\Sent'], messages: [] };
  await fake.listen();
  t.after(() => fake.close());
  const { widget, th, cards, getState } = setup({ fake });
  const acc = { provider: 'other', host: 'imap.x.test', port: 993, security: 'tls', username: 'me@x.test', name: '테스트' };
  // Without a checked password there is nothing to log in with.
  assert.match((await widget.settings.handlers.listFolders(acc)).message, /연결 확인/);
  const ok = await widget.settings.handlers.check({ ...acc, password: 'app-pass' });
  const listed = await widget.settings.handlers.listFolders({ ...acc, draft: ok.token });
  assert.equal(listed.ok, true, listed.message);
  const cafe = listed.folders.find((f) => f.name === '카페 알림');
  assert.deepEqual([cafe.raw, cafe.selectable], [utf7.encode('카페 알림'), true]);
  assert.equal(listed.folders.find((f) => f.name === '보낸편지함').selectable, false);
  assert.equal(listed.folders.some((f) => f.name === 'INBOX'), false);
  assert.deepEqual(widget.settings.save({ accounts: [{ ...acc, draft: ok.token, folders: [{ raw: cafe.raw, name: cafe.name }] }] }), { ok: true });
  assert.deepEqual(getState().accounts[0].folders, [{ raw: cafe.raw, name: '카페 알림' }]);
  const id = getState().accounts[0].id;
  // A saved account lists with its stored password.
  assert.equal((await widget.settings.handlers.listFolders({ ...getState().accounts[0], accountId: id })).ok, true);

  widget.start();
  t.after(() => widget.stop());
  await waitFor(async () => (await th.call('list')).items.length === 2);
  const items = (await th.call('list')).items;
  const folderItem = items.find((m) => m.subject === '카페 새 글');
  assert.equal(folderItem.folder, '카페 알림');
  assert.match(folderItem.id, new RegExp(`^${id}:[0-9a-f]{8}:10$`));
  assert.equal(items.find((m) => m.subject === '받은 메일').folder, 'INBOX');
  const st = await th.call('getState');
  assert.equal(st.accounts[0].unread, 2);
  assert.equal(st.totalUnread, 2);
  assert.deepEqual(st.accounts[0].folders.map((f) => [f.name, f.unread]), [['카페 알림', 1]]);
  assert.equal(cards.length, 0, 'first look: no cards');
  // Opening it marks it read in its folder, not in INBOX.
  const shown = await th.call('select', [folderItem.id]);
  assert.equal(shown.ok, true, shown.message);
  assert.equal(shown.message.folder, '카페 알림');
  await waitFor(() => fake.boxes['카페 알림'].messages[0].flags.includes('\\Seen'));
  assert.ok(!fake.messages[0].flags.includes('\\Seen'));
  // A server rule sorts new mail into the folder: 새로고침 finds it and the card names the folder.
  fake.deliverTo('카페 알림', textMessage(11, { date: NOW, subject: '규칙 메일', from: { name: '카페', address: 'cafe@x.test' } }));
  const res = await th.call('refresh');
  assert.equal(res.newMail, 1);
  await waitFor(() => cards.length === 1);
  const [card] = cards[0].list;
  assert.equal(card.body, '규칙 메일 · 테스트 · 카페 알림');
  await cards[0].opts.onAction({ ...card }, 'read');
  assert.ok(fake.boxes['카페 알림'].messages[1].flags.includes('\\Seen'));
});

test('#80 --mock-data: a mock account shows mail from a chosen mailbox with its name', async (t) => {
  const { widget, th } = setup({ flags: { mockData: true } });
  widget.start();
  t.after(() => widget.stop());
  const all = await th.call('filter', [{ accountId: 'mock-daum' }]);
  const inFolder = all.items.filter((m) => m.folder !== 'INBOX');
  assert.ok(inFolder.length >= 1);
  assert.ok(inFolder.every((m) => m.folder === '카페 알림' && /^mock-daum:[0-9a-f]{8}:\d+$/.test(m.id)));
  const st = (await th.call('getState')).accounts.find((a) => a.id === 'mock-daum');
  assert.deepEqual(st.folders.map((f) => f.name), ['카페 알림']);
  const body = await th.call('select', [inFolder[0].id]);
  assert.equal(body.ok, true);
});

test('#83 중요 / 안 읽음 filters list exactly what the counts count (INBOX + chosen mailbox, old mail too), 더 보기 pages', async (t) => {
  const utf7 = require('../lib/utf7');
  const flaggedIn = [2, 5, 9, 14, 20, 33, 47, 61, 70, 88, 99, 110];
  const inbox = Array.from({ length: 120 }, (_, i) => textMessage(i + 1, { date: NOW - (121 - i) * 3600000, subject: `in${i + 1}`, messageId: `<in${i + 1}@x.test>`, flags: [...(i + 1 > 3 ? ['\\Seen'] : []), ...(flaggedIn.includes(i + 1) ? ['\\Flagged'] : [])] }));
  const folder = Array.from({ length: 70 }, (_, i) => textMessage(i + 1, { date: NOW - (500 - i) * 3600000, subject: `cafe${i + 1}`, messageId: `<cafe${i + 1}@x.test>`, flags: [...(i + 1 === 4 ? [] : ['\\Seen']), ...([1, 3].includes(i + 1) ? ['\\Flagged'] : [])] }));
  const fake = new FakeImap({ messages: inbox, user: 'me@x.test', pass: 'app-pass' });
  fake.boxes['카페 알림'] = { flags: [], messages: folder, uidValidity: 9 };
  await fake.listen();
  t.after(() => fake.close());
  const { widget, th } = setup({ fake, initial: { pageSize: 10 } });
  const acc = { provider: 'other', host: 'imap.x.test', port: 993, security: 'tls', username: 'me@x.test', name: '테스트' };
  const ok = await widget.settings.handlers.check({ ...acc, password: 'app-pass' });
  assert.deepEqual(widget.settings.save({ accounts: [{ ...acc, draft: ok.token, folders: [{ raw: utf7.encode('카페 알림'), name: '카페 알림' }] }] }), { ok: true });
  widget.start();
  t.after(() => widget.stop());
  await waitFor(async () => (await th.call('getState')).accounts[0].state === 'ok' && (await th.call('getState')).accounts[0].folders[0]?.unread === 1);
  const st = await th.call('getState');
  assert.equal(st.accounts[0].flagged, 14, '12 in INBOX + 2 in the folder, most older than the loaded mail');
  assert.equal(st.accounts[0].unread, 4);
  // 중요: page by page until everything the count counts is listed.
  let view = await th.call('filter', [{ accountId: st.accounts[0].id, flagged: true }]);
  await waitFor(async () => (await th.call('list')).items.length === 10);
  view = await th.call('list');
  assert.equal(view.hasMore, true);
  view = await th.call('loadMore');
  assert.equal(view.items.length, 14);
  assert.equal(view.hasMore, false);
  assert.equal(view.items.length, (await th.call('getState')).accounts[0].flagged);
  assert.ok(view.items.every((m) => m.flagged));
  assert.deepEqual(view.items.filter((m) => m.folder === '카페 알림').map((m) => m.subject), ['cafe3', 'cafe1']);
  // An old one (fetched only for this list) opens like any other.
  const old = view.items.find((m) => m.subject === 'in2');
  assert.equal((await th.call('get', [old.id])).ok, true);
  // 안 읽음: the 3 old unread INBOX mails and the folder's one.
  view = await th.call('filter', [{ unread: true }]);
  await waitFor(async () => (await th.call('list')).items.length === 4);
  view = await th.call('list');
  assert.deepEqual(view.items.map((m) => m.subject).sort(), ['cafe4', 'in1', 'in2', 'in3']);
  assert.equal(view.hasMore, false);
  assert.equal((await th.call('getState')).totalUnread, 4);
  // Reading one moves the count and the list together.
  await th.call('select', [view.items.find((m) => m.subject === 'in1').id]);
  await waitFor(async () => (await th.call('list')).items.length === 3 && (await th.call('getState')).totalUnread === 3);
});
