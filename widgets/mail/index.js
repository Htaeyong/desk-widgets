// Mail widget (#65): a unified inbox of IMAP accounts on the desktop. Its own IMAP client (lib/imap-*.js),
// MIME decoding (lib/mime.js), one sync per account (lib/account.js: IDLE, reconnect, new mail, paging),
// new-mail cards (lib/notify.js), an isolated reader for the original HTML (lib/preview.js) and writing
// handed off to the PC's mail program or webmail (lib/handoff.js) — the widget never sends mail.
// The look is a theme package on the engine's theme host (mail theme contract v1, THEME_METHODS below);
// accounts, passwords and servers never reach a theme.
const path = require('path');
const crypto = require('crypto');
const { DEFAULTS, sanitize, sanitizeAccount, newId, loginKey, upgrade } = require('./lib/settings');
const { PROVIDERS, providerList, loginHint } = require('./lib/providers');
const { createSecrets } = require('./lib/secrets');
const { fileCache, pruneCaches } = require('./lib/cache');
const { AccountSync, MARKED_STEP } = require('./lib/account');
const { MockAccount, MOCK_ACCOUNTS } = require('./lib/mock');
const { ImapClient } = require('./lib/imap-client');
const { merge, needsMore, parseId, messageId } = require('./lib/inbox');
const { createNotifier } = require('./lib/notify');
const { mailtoFor, webmailFor, isAddress, replyRecipients, composeBody, prefixed } = require('./lib/handoff');
const { createComposer, newDraftId, attachedBytes, MAX_ATTACH, safe, checkList } = require('./lib/composer');
const { sendMail, checkSmtp } = require('./lib/sender');
const { sanitizeHtml, htmlToText } = require('./lib/sanitize');
const { createReader } = require('./lib/preview');
const { CategoryStore, CategoryError, messageKey, NONE } = require('./lib/categories');
const { ContactBook, parseContactsFile } = require('./lib/contacts');
const { pickerFolders } = require('./lib/folders');

const FRAMES = { main: { width: 340, height: 500, minWidth: 260, minHeight: 140 } };
const DRAFT_TTL_MS = 30 * 60000;
const BODY_CACHE = 20; // message bodies kept in memory (never on disk)
const MAX_TEXT = 50000;
const SECRET_UNAVAILABLE =
  '이 PC에서 암호화 저장(Windows 데이터 보호)을 쓸 수 없어 비밀번호를 저장할 수 없습니다. 비밀번호를 평문으로 저장하지 않으므로 메일 계정을 추가할 수 없습니다.';

/**
 * deps (tests): imap — { connect, upgrade } for ImapClient / AccountSync; crypto — safeStorage stand-in;
 * electron — for the reader; mock — MockAccount options; notifier — { setTimeout, clearTimeout }.
 */
function create(ctx, deps = {}) {
  const store = ctx.createStore({ file: path.join(ctx.dataDir, 'settings.json'), defaults: DEFAULTS, sanitize, upgrade });
  const settings = () => sanitize(store.load());
  const integrationStatus = () => ctx.integrations?.status('todo') || { installed: false, brokerAvailable: false };
  const integrationDetails = () => ({ ...integrationStatus(), receiveConsent: Boolean(integrationStatus().peerEnabled) });
  const integrationText = (ko, en) => /^en\b/i.test(ctx.app?.locale?.() || '') ? en : ko;
  const mock = Boolean(ctx.flags?.mockData) && !deps.imap;
  const accountsOf = (s) => (mock ? MOCK_ACCOUNTS : s.accounts);
  const cacheDir = path.join(ctx.dataDir, 'cache');
  // Passwords: encrypted (safeStorage) in their own file, never in settings.json, never logged or sent to a theme.
  const secrets = createSecrets({ file: path.join(ctx.dataDir, 'secrets.json'), crypto: deps.crypto });
  const drafts = new Map(); // "연결 확인" token -> { key, password, at } until the settings are saved
  const syncs = new Map(); // account id -> { key, sync }
  const bodies = new Map(); // message id -> body (LRU, memory only)
  const allowImages = new Set(); // message ids whose remote images the user allowed (this run only)
  const cardIds = new Map(); // card tag -> message ids (the engine keeps only known card fields)
  let running = false;
  let paused = false;
  let limit = settings().pageSize;
  let notifyTimer = null;
  let lastListKey = '';
  // #69: categories on this PC only; the list can be filtered by one ('' = all, NONE = 분류 없음).
  const categories = new CategoryStore(path.join(ctx.dataDir, mock ? 'categories-mock.json' : 'categories.json'));
  // #72: the list filter: category ('' all, NONE, id), one account, unread only, flagged only.
  let filterState = { category: '', accountId: '', unread: false, flagged: false };
  // #70: the address book on this PC (learned from mail headers and sends, imported vCard / CSV).
  const contacts = new ContactBook(path.join(ctx.dataDir, mock ? 'contacts-mock.json' : 'contacts.json'));

  /** Learns the addresses of loaded mail once per message (own addresses and automated senders left out). */
  function learnFromMail() {
    const own = accountsOf(settings()).map((a) => a.email).filter(Boolean);
    const items = [];
    for (const s of sources()) for (const h of s.headers) items.push({ key: messageKey(s.account.id, h, s.uidValidity), h });
    if (items.length) contacts.learnHeaders(items, own);
  }

  const notifier = createNotifier({
    enabled: (accountId) => settings().notify && Boolean(accountOf(accountId)?.notify),
    send: safe('new-mail cards', (cards) => sendCards(cards)),
    ...(deps.notifier || {}),
  });

  const accountOf = (id) => accountsOf(settings()).find((a) => a.id === id) || null;

  // ---- accounts ----

  function makeSync(a) {
    const s = settings();
    const sync = mock
      ? new MockAccount({ account: a, ...(deps.mock || {}) })
      : new AccountSync({
          account: a,
          password: () => secrets.get(a.id),
          cache: fileCache(cacheDir, a.id),
          deps: deps.imap || {},
          cacheSize: s.cacheSize,
          pageSize: s.pageSize,
          refreshMinutes: s.refreshMinutes,
        });
    sync.on('changed', () => changed());
    sync.on('new', (list) => {
      if (!running) return;
      notifier.add(list.map((h) => ({ id: messageId(a.id, h.uid, h.folderKey), accountId: a.id, accountName: h.folder ? `${sync.account.name} · ${h.folder}` : sync.account.name, from: h.from, subject: h.subject })));
      changed();
    });
    return sync;
  }

  /** Starts, stops or rebuilds account syncs to match the settings (a changed login rebuilds and drops the cache). */
  function reconcile() {
    const list = accountsOf(settings()).filter((a) => a.enabled);
    const want = new Map(list.map((a) => [a.id, a]));
    for (const [id, entry] of syncs) {
      const a = want.get(id);
      if (!a || entry.key !== loginKey(a) || (!mock && !secrets.has(id))) {
        entry.sync.stop();
        syncs.delete(id);
        if (a && entry.key !== loginKey(a)) fileCache(cacheDir, id).remove();
      } else entry.sync.account = a; // name, color, switches
    }
    for (const a of list) {
      if (syncs.has(a.id) || (!mock && !secrets.has(a.id))) continue;
      const sync = makeSync(a);
      syncs.set(a.id, { key: loginKey(a), sync });
      if (running) {
        sync.start();
        if (paused) sync.setPaused(true);
        const kinds = markedKinds();
        if (kinds && sync.demandMarked && (!filterState.accountId || filterState.accountId === a.id)) Promise.resolve(sync.demandMarked(kinds, markedStep || MARKED_STEP)).catch(() => {});
      }
    }
    changed();
  }

  // #83: while 안 읽음 / 중요 is on, a source is the server's list of those messages (the same one the counts
  // come from), not the loaded headers filtered.
  const markedKinds = (f = filterState) => (f.unread || f.flagged ? { unread: f.unread, flagged: f.flagged } : null);
  let markedStep = 0; // headers wanted per mailbox for the open 안 읽음 / 중요 list (MARKED_STEP at a time)
  const sources = (kinds = null) =>
    accountsOf(settings())
      .filter((a) => syncs.has(a.id))
      .map((a) => {
        const sync = syncs.get(a.id).sync;
        if (kinds && sync.markedList) {
          const m = sync.markedList(kinds);
          return { account: sync.account, headers: m.headers, hasMore: m.missing, uidValidity: sync.uidValidity, marked: m };
        }
        return { account: sync.account, headers: sync.list(), hasMore: sync.hasMore, uidValidity: sync.uidValidity };
      });

  /** Asks the accounts in view for the headers of their 안 읽음 / 중요 lists (n per mailbox; 0 closes them). */
  function demandMarked(kinds, n) {
    const ids = filterState.accountId ? [filterState.accountId] : [...syncs.keys()];
    for (const [id, { sync }] of syncs) {
      if (!sync.demandMarked) continue;
      const want = kinds && ids.includes(id) ? n : 0;
      Promise.resolve(sync.demandMarked(kinds || {}, want))
        .then((added) => added && changed())
        .catch(() => {});
    }
  }

  /** The header of a message id, with its account and sync, or null. */
  function lookup(id) {
    const ref = parseId(id);
    const entry = ref && syncs.get(ref.accountId);
    const h = entry?.sync.find(ref.uid, ref.folderKey);
    return h ? { ref, sync: entry.sync, account: entry.sync.account, h } : null;
  }

  // ---- theme state ----

  function accountState(a) {
    const entry = syncs.get(a.id);
    if (!a.enabled || !running) return { state: 'off', error: null, lastSync: entry?.sync.status.lastSync || null };
    if (!entry) return { state: 'error', error: '비밀번호가 없습니다. 설정에서 연결 확인 후 저장하세요.' };
    const st = entry.sync.status;
    return { state: st.state, error: st.error, lastSync: st.lastSync };
  }

  /** The mail contract's state (getState() and the "changed" event). */
  function view() {
    const s = settings();
    const accounts = accountsOf(s).map((a) => {
      const st = accountState(a);
      const sync = syncs.get(a.id)?.sync;
      return { id: a.id, name: a.name, color: a.color, email: a.email || '', enabled: a.enabled, ...accountStats(a, sync), state: st.state, error: st.error || null, lastSync: st.lastSync || null, canCompose: true, hasWebmail: Boolean(a.webmail) };
    });
    const live = accounts.filter((a) => a.enabled);
    return {
      locale: ctx.app?.locale?.() || 'ko-KR',
      mock,
      accounts,
      totalUnread: live.reduce((n, a) => n + a.unread, 0),
      refreshing: live.some((a) => a.state === 'connecting' || a.state === 'syncing'),
      errorCount: live.filter((a) => a.state === 'error').length,
      lastUpdated: Math.max(0, ...live.map((a) => a.lastSync || 0)),
      paused,
      categories: categoryView(),
      categoryFilter: filterState.category,
      filter: { ...filterState },
      // Where each count comes from: the server (whole INBOX) or the headers loaded in the widget.
      counts: { unread: 'server', flagged: 'server', categories: 'loaded' },
      // #68: messages being sent in the background ("보내는 중"), and the last result for a short note.
      sending: outbox.size,
      lastSent: lastSent,
      mailProgram: mailProgram(),
      notify: s.notify,
      todoIntegration: s.todoIntegration,
      markReadOnOpen: s.markReadOnOpen,
    };
  }

  const keyOf = (found) => messageKey(found.account.id, found.h, found.sync.uidValidity);

  /** Whether a list item passes the filter (pure apart from the state). */
  function passes(f, m) {
    if (f.unread && !m.unread) return false;
    if (f.flagged && !m.flagged) return false;
    if (f.category === NONE) return m.categoryIds.length === 0;
    if (f.category) return m.categoryIds.includes(f.category);
    return true;
  }

  function listView() {
    const f = filterState;
    // One account: only its mail, and "more" means more of that account.
    const kinds = markedKinds(f);
    const srcs = (f.accountId ? sources(kinds).filter((s) => s.account.id === f.accountId) : sources(kinds));
    const active = f.unread || f.flagged || f.category;
    const res = merge(srcs, limit, {
      categoryIds: (s, h) => categories.idsFor(messageKey(s.account.id, h, s.uidValidity)),
      keep: active ? (m) => passes(f, m) : null,
    });
    return { items: res.items, hasMore: res.hasMore, limit, category: f.category, filter: { ...f } };
  }

  /** The categories with how many loaded messages carry each (for chips and filters). */
  function categoryView() {
    const counts = new Map();
    for (const s of sources()) for (const h of s.headers) for (const id of categories.idsFor(messageKey(s.account.id, h, s.uidValidity))) counts.set(id, (counts.get(id) || 0) + 1);
    return categories.list().map((c) => ({ ...c, count: counts.get(c.id) || 0 }));
  }

  /** setCategories: exactly these categories on a message (local only). */
  function setMessageCategories(id, ids) {
    const found = need(id);
    const kept = categories.set(keyOf(found), Array.isArray(ids) ? ids.map(String).slice(0, 50) : [], { subject: found.h.subject });
    changed();
    return { ok: true, categoryIds: kept };
  }

  function createCategory(name, color) {
    try {
      const c = categories.create(name, typeof color === 'string' ? color : undefined);
      changed();
      return { ok: true, category: c, categories: categories.list() };
    } catch (err) {
      if (err instanceof CategoryError) return { ok: false, message: err.message };
      throw err;
    }
  }

  /**
   * filter(category) as in #69 (a string: the category alone, other parts cleared), or (#72)
   * filter({ category?, accountId?, unread?, flagged? }). Unknown values mean "all".
   */
  function setFilter(arg) {
    const o = typeof arg === 'string' ? { category: arg } : arg && typeof arg === 'object' ? arg : {};
    const c = typeof o.category === 'string' ? o.category : '';
    const acc = typeof o.accountId === 'string' && accountsOf(settings()).some((a) => a.id === o.accountId) ? o.accountId : '';
    const next = { category: c === NONE || categories.list().some((x) => x.id === c) ? c : '', accountId: acc, unread: o.unread === true, flagged: o.flagged === true };
    if (JSON.stringify(next) !== JSON.stringify(filterState)) limit = settings().pageSize; // a new view starts at one page
    filterState = next;
    // #83: 안 읽음 / 중요 shows the server's list: fetch the headers it needs (or let the old ones go).
    const kinds = markedKinds(next);
    markedStep = kinds ? MARKED_STEP : 0;
    demandMarked(kinds, markedStep);
    lastListKey = '';
    changed();
    return listView();
  }

  /** Per-account numbers for dashboards (#72): server counts where cheap, the rest over loaded headers. */
  function accountStats(a, sync) {
    const list = sync ? sync.list() : [];
    const cats = {};
    for (const h of list) for (const id of categories.idsFor(messageKey(a.id, h, sync.uidValidity))) cats[id] = (cats[id] || 0) + 1;
    return {
      // #83: UID SEARCH UNSEEN / FLAGGED of INBOX and the chosen mailboxes: the lists 안 읽음 / 중요 show.
      unread: sync ? (sync.totalUnread ? sync.totalUnread() : sync.unread) : 0,
      flagged: sync ? (sync.totalFlagged ? sync.totalFlagged() : sync.flagged || 0) : 0,
      folders: sync?.folderInfo ? sync.folderInfo() : [],
      loaded: list.length,
      categories: cats, // loaded headers only
      latest: list.slice(0, 3).map((h) => ({ id: messageId(a.id, h.uid, h.folderKey), folder: h.folder || 'INBOX', subject: h.subject || '', from: h.from ? { name: h.from.name || '', address: h.from.address || '' } : null, date: h.date || 0, unread: Boolean(h.unread), flagged: Boolean(h.flagged) })),
    };
  }

  /** Tells themes and an open settings window that something changed (coalesced). */
  function changed() {
    if (notifyTimer) return;
    // Timer callbacks run outside any caller: safe() keeps an error from becoming a main-process dialog.
    notifyTimer = setTimeout(safe('changed', () => {
      notifyTimer = null;
      if (!running) return;
      learnFromMail();
      host.emit('changed', view());
      const list = listView();
      const key = JSON.stringify(list.items.map((m) => [m.id, m.unread, m.flagged, m.snippet, m.categoryIds])) + list.hasMore + JSON.stringify(list.filter);
      if (key !== lastListKey) {
        lastListKey = key;
        host.emit('messages', { count: list.items.length, hasMore: list.hasMore });
      }
      ctx.sendToSettings?.('status', statusList());
    }), 150);
  }

  const statusList = () => accountsOf(settings()).map((a) => ({ id: a.id, ...accountState(a), unread: syncs.get(a.id) ? syncs.get(a.id).sync.totalUnread?.() ?? syncs.get(a.id).sync.unread : null, folders: syncs.get(a.id)?.sync.folderInfo?.() || [] }));

  // ---- messages ----

  async function bodyOf(found) {
    const id = messageId(found.account.id, found.h.uid, found.h.folderKey);
    if (bodies.has(id)) {
      const b = bodies.get(id);
      bodies.delete(id);
      bodies.set(id, b);
      return b;
    }
    const b = await found.sync.body(found.h.uid, found.h.folderKey);
    bodies.set(id, b);
    while (bodies.size > BODY_CACHE) bodies.delete(bodies.keys().next().value);
    return b;
  }

  /** A message as a theme sees it: header, plain text, attachment names (no HTML, no Message-ID). */
  async function detailOf(found) {
    const b = await bodyOf(found);
    const id = messageId(found.account.id, found.h.uid, found.h.folderKey);
    const text = (b.text || htmlToText(b.html || '')).slice(0, MAX_TEXT);
    const remote = b.html ? sanitizeHtml(b.html, { cid: b.cid }).remoteImages : 0;
    const h = found.h;
    return {
      id,
      accountId: found.account.id,
      accountName: found.account.name,
      folder: found.h.folder || 'INBOX', // #80
      color: found.account.color,
      from: h.from,
      to: h.to || [],
      cc: h.cc || [],
      subject: h.subject || '',
      date: h.date,
      unread: h.unread,
      flagged: h.flagged,
      hasAttachments: h.hasAttachments,
      attachments: b.attachments || [],
      text,
      hasHtml: Boolean(b.html),
      remoteImages: remote,
      allowRemote: allowImages.has(id),
      truncated: Boolean(b.truncated),
      hasWebmail: Boolean(found.account.webmail),
      categoryIds: categories.idsFor(keyOf(found)),
      categories: categories.list(),
    };
  }

  const need = (id) => {
    const found = lookup(id);
    if (!found) throw new Error('메일을 찾지 못했습니다(목록이 바뀌었을 수 있습니다). 새로고침해 보세요.');
    return found;
  };

  /** Copies only the selected header and source identity; bodies and attachments stay in Mail. */
  async function addToTodo(id) {
    if (!settings().todoIntegration) return { ok: false, message: integrationText('설정에서 할 일 연동을 켜 주세요.', 'Enable Todo integration in settings.') };
    const found = lookup(id);
    if (!found) return { ok: false, message: integrationText('메일을 찾지 못했습니다. 새로고침 후 다시 시도해 주세요.', 'Message not found. Refresh and try again.') };
    const target = integrationStatus();
    if (!target.running || !target.capabilities?.includes('tasks.addExternal')) return { ok: false, message: integrationText('할 일 위젯을 설치하고 사용 상태로 켜 주세요.', 'Install and enable the Todo widget.') };
    return ctx.integrations.call('todo', 'tasks.addExternal', {
      title: found.h.subject || integrationText('(제목 없음)', '(No subject)'),
      source: { widgetId: 'mail', itemId: keyOf(found), label: found.account.name },
    });
  }

  async function setSeen(id, seen) {
    const found = need(id);
    await found.sync.setSeen(found.h.uid, seen, found.h.folderKey);
    changed();
    return { ok: true };
  }

  /** select: the theme shows this message; marks it read (setting) except in the theme preview. */
  async function select(entry, id) {
    const found = need(id);
    const detail = await detailOf(found);
    if (!entry?.preview && settings().markReadOnOpen && found.h.unread) {
      found.sync.setSeen(found.h.uid, true, found.h.folderKey).catch(() => {});
      detail.unread = false;
    }
    return { ok: true, message: detail };
  }

  /** The reader window: the original HTML, sanitized, in the isolated view. */
  async function openPreview(id) {
    const found = need(id);
    const detail = await detailOf(found);
    const b = await bodyOf(found);
    const full = { ...detail };
    if (b.html) {
      full.html = sanitizeHtml(b.html, { cid: b.cid }).html;
      full.htmlNoCid = sanitizeHtml(b.html, {}).html;
    } else {
      full.html = null;
    }
    full.text = b.text || htmlToText(b.html || '');
    if (!full.html) delete full.html;
    reader.show(full);
    if (settings().markReadOnOpen && found.h.unread) found.sync.setSeen(found.h.uid, true, found.h.folderKey).catch(() => {});
    return { ok: true };
  }

  /**
   * Hands a URL to Windows (default browser / mail program) and waits for the answer: shell.openExternal
   * rejects when no program is registered for it (e.g. no default mail app for mailto:). Returns null or the
   * error text (never logged: a mailto: link holds the quoted mail).
   */
  async function launch(url) {
    try {
      await ctx.openExternal(url);
      return null;
    } catch (err) {
      return String(err?.message || err || '').slice(0, 200) || '알 수 없는 오류';
    }
  }

  async function openUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'mailto:') return '열 수 없는 주소입니다.';
    } catch {
      return '열 수 없는 주소입니다.';
    }
    return launch(url);
  }

  async function openWebmail(target = {}) {
    const found = target.id ? lookup(target.id) : null;
    const account = found ? found.account : accountOf(target.accountId) || accountsOf(settings()).find((a) => a.enabled && a.webmail);
    if (!account?.webmail) return { ok: false, message: '이 계정의 웹메일 주소가 없습니다. 설정 → 계정에서 웹메일 주소를 넣으세요.' };
    const failed = await openUrl(webmailFor(account, found ? 'open' : 'home', { msg: found?.h }) || account.webmail);
    if (failed) return { ok: false, message: `브라우저를 열지 못했습니다(${failed}).` };
    return { ok: true };
  }

  const MAILTO_HINT = 'Windows 설정 → 앱 → 기본 앱 → "링크 유형별 기본값 선택"(또는 검색 창에 mailto) → MAILTO에서 Outlook 클래식·Thunderbird 등을 고르세요.';
  const MAILTO_FAILED = `메일 프로그램을 열지 못했습니다. ${MAILTO_HINT}`;
  const NO_MAILTO = `Windows에 mailto 링크를 열 기본 메일 프로그램이 없습니다. ${MAILTO_HINT}`;

  /**
   * The program Windows opens mailto: links with (Electron app.getApplicationNameForProtocol: a plain API
   * call, no process or registry tool), or null when none is registered. A registered program may still
   * open nothing (e.g. the discontinued Windows Mail app); that cannot be detected, so the success
   * message says what to do then.
   */
  function mailProgram() {
    try {
      const fn = deps.mailtoHandler || (() => require('electron').app.getApplicationNameForProtocol('mailto:'));
      return String(fn() || '').trim() || null;
    } catch {
      return null;
    }
  }

  /** 새 메일 / 답장 / 전체 답장 / 전달: the account's mail program (mailto:) or its webmail. */
  async function handoff(action, target = {}) {
    let found = null;
    let account;
    if (action === 'compose') {
      account = accountOf(target.accountId) || accountsOf(settings()).find((a) => a.enabled) || null;
    } else {
      found = need(target.id);
      account = found.account;
    }
    const to = typeof target.to === 'string' && isAddress(target.to) ? target.to : '';
    // target.via: 'widget' | 'webmail' | 'mailto' overrides the account's choice once (e.g. "웹메일로 쓰기").
    const VIAS = ['widget', 'webmail', 'mailto'];
    let via = VIAS.includes(target.via) ? target.via : account?.compose || 'widget';
    if (via === 'widget') return openComposer(action, { account, found, to });
    const program = mailProgram();
    let note = null;
    if (via === 'mailto' && !program && target.via !== 'mailto') {
      // No mail program at all: the account's webmail instead of a link that cannot open; else say how to set one.
      if (!account?.webmail) return { ok: false, message: `${NO_MAILTO} 계정 설정에 웹메일 주소를 넣으면 웹메일로 쓸 수 있습니다.` };
      via = 'webmail';
      note = '기본 메일 프로그램이 없어 웹메일로 열었습니다.';
    }
    if (via === 'webmail') {
      if (!account?.webmail) return { ok: false, message: '이 계정의 웹메일 주소가 없습니다. 설정 → 계정에서 웹메일 주소를 넣으세요.' };
      const failed = await openUrl(webmailFor(account, action, { msg: found?.h, to }) || account.webmail);
      if (failed) return { ok: false, message: `브라우저를 열지 못했습니다(${failed}).`, ...(account ? { fallback: 'mailto' } : {}) };
      return { ok: true, via: 'webmail', ...(note ? { note } : {}) };
    }
    let text = '';
    if (found) {
      try {
        const b = await bodyOf(found);
        text = b.text || htmlToText(b.html || '');
      } catch {
        text = found.h.snippet || '';
      }
    }
    const url = mailtoFor(action, { msg: found?.h, text, self: account?.email || '', to });
    const failed = await launch(url);
    if (failed) {
      const web = Boolean(account?.webmail);
      return { ok: false, message: `${MAILTO_FAILED}${web ? ' 또는 "웹메일로 쓰기"를 누르세요.' : ' 계정 설정에서 쓰기를 웹메일로 바꿀 수도 있습니다.'}`, ...(web ? { fallback: 'webmail' } : {}) };
    }
    return { ok: true, via: 'mailto', program, note: `${program || '메일 프로그램'}(으)로 넘겼습니다. 아무 창도 뜨지 않으면 ${account?.webmail ? '"웹메일"을 누르거나 ' : ''}${MAILTO_HINT}` };
  }

  /** "더 보기": a bigger page, and older mail from the accounts that need it. */
  async function loadMore() {
    const s = settings();
    limit += s.pageSize;
    const kinds = markedKinds();
    if (kinds) {
      // #83: more of the server's 안 읽음 / 중요 list once the fetched headers run short.
      const srcs = sources(kinds).filter((x) => !filterState.accountId || x.account.id === filterState.accountId);
      const shown = srcs.reduce((n, x) => n + x.headers.length, 0);
      if (srcs.some((x) => x.hasMore) && shown < limit + s.pageSize) {
        markedStep += MARKED_STEP;
        await Promise.all(srcs.filter((x) => x.hasMore).map((x) => Promise.resolve(syncs.get(x.account.id)?.sync.demandMarked?.(kinds, markedStep)).catch(() => 0)));
      }
      changed();
      return listView();
    }
    const ids = filterState.accountId ? (syncs.get(filterState.accountId)?.sync.hasMore ? [filterState.accountId] : []) : needsMore(sources(), limit);
    await Promise.all(
      ids.map((id) =>
        syncs
          .get(id)
          ?.sync.loadMore(s.pageSize)
          .catch(() => 0),
      ),
    );
    changed();
    return listView();
  }

  /**
   * 지금 새로고침 (#79): every account checks the server now (IDLE ones too) and the answer comes when they
   * are done: { ok, newMail, errors: [{ name, message }], at }. An account that takes too long counts as
   * an error so the button never spins forever.
   */
  async function refreshAll() {
    const runs = [...syncs.values()].map(({ sync }) => ({ sync, p: Promise.resolve(sync.refresh()) }));
    changed();
    const limitMs = deps.refreshTimeoutMs ?? 45000;
    const results = await Promise.all(
      runs.map(({ sync, p }) => {
        let timer;
        const late = new Promise((r) => (timer = setTimeout(() => r({ ok: false, message: '시간이 오래 걸려 기다리지 않았습니다(뒤에서 계속 확인).' }), limitMs)));
        return Promise.race([p.catch((err) => ({ ok: false, message: String(err?.message || err) })), late]).then((r) => {
          clearTimeout(timer);
          return { name: sync.account.name, ...r };
        });
      }),
    );
    changed();
    return {
      ok: true,
      accounts: results.length,
      newMail: results.reduce((n, r) => n + (r.fresh || 0), 0),
      errors: results.filter((r) => r.ok === false).map((r) => ({ name: r.name, message: String(r.message || '').slice(0, 200) })),
      at: Date.now(),
    };
  }

  // ---- the reader window's buttons ----

  async function readerAction(name, id, arg = {}) {
    try {
      if (name === 'reply' || name === 'replyAll' || name === 'forward') return await handoff(name, { id, via: arg.via });
      if (name === 'markUnread') return await setSeen(id, false);
      if (name === 'setCategories') {
        const res = setMessageCategories(id, arg.ids);
        reader.update({ ...reader.current(), categoryIds: res.categoryIds, categories: categories.list() });
        return res;
      }
      if (name === 'createCategory') {
        const res = createCategory(arg.label, arg.color);
        if (res.ok) reader.update({ ...reader.current(), categories: categories.list() });
        return res;
      }
      if (name === 'webmail') return await openWebmail({ id });
      if (name === 'showImages') {
        allowImages.add(id);
        const found = need(id);
        const b = await bodyOf(found);
        const detail = await detailOf(found);
        reader.update({ ...detail, html: b.html ? sanitizeHtml(b.html, { cid: b.cid }).html : undefined, htmlNoCid: b.html ? sanitizeHtml(b.html, {}).html : undefined, text: b.text || htmlToText(b.html || '') });
        return { ok: true };
      }
      if (name === 'copyId') {
        const found = need(id);
        const mid = String(found.h.messageId || '').replace(/^<|>$/g, '');
        if (!mid) return { ok: false, message: '이 메일에는 Message-ID가 없습니다.' };
        (deps.clipboard || require('electron').clipboard).writeText(mid);
        return { ok: true, messageId: mid };
      }
      return { ok: false, message: '알 수 없는 동작입니다.' };
    } catch (err) {
      return { ok: false, message: String(err?.message || err) };
    }
  }

  const reader = createReader({ ctx, onAction: readerAction, electron: deps.electron });

  // ---- sending from the widget (#68) ----

  const outbox = new Map(); // draft id -> { subject }
  let lastSent = null; // { ok, subject, at, message? }

  /** Accounts in the composer's 보내는 계정 list, and whether each can send. */
  function senders() {
    return accountsOf(settings())
      .filter((a) => a.enabled)
      .map((a) => {
        const reason = !a.email ? '보내는 주소 없음(설정에서 내 메일 주소)' : !a.smtpHost ? 'SMTP 서버 없음(설정)' : !mock && !secrets.has(a.id) ? '비밀번호 없음' : '';
        return { id: a.id, label: `${a.name} <${a.email || a.username}>`, canSend: !reason, reason, signature: a.signature || '' };
      });
  }

  const composer = createComposer({
    ctx,
    accounts: senders,
    onSend: (d) => queueSend(d),
    // Autocomplete of the recipient chips: the address book on this PC (#70).
    suggest: (q, exclude) => contacts.search(q, 8, exclude),
    dialog: deps.dialog,
    fsMod: deps.fs,
  });

  /** Opens the composer with a new draft (reply / forward filled from the original). */
  async function openComposer(action, { account, found, to }) {
    const mode = action === 'compose' ? 'new' : action;
    let text = '';
    let references = [];
    if (found) {
      try {
        const b = await bodyOf(found);
        text = b.text || htmlToText(b.html || '');
        references = b.references || [];
      } catch {
        text = found.h.snippet || '';
      }
    }
    const h = found?.h;
    const rcpt = h && (mode === 'reply' || mode === 'replyAll') ? replyRecipients(mode, h, account?.email) : { to: [], cc: [] };
    let forward = null;
    if (h && mode === 'forward' && h.hasAttachments) {
      const names = (await bodyOf(found).catch(() => ({ attachments: [] }))).attachments || [];
      const size = names.reduce((n, a) => n + (a.size || 0), 0);
      forward = { names: names.map((a) => a.name), size, tooBig: size > MAX_ATTACH, include: size <= MAX_ATTACH };
    }
    const draft = {
      id: newDraftId(),
      mode,
      // The account the original came to sends the reply (a widget-wide guess would be the wrong sender).
      accountId: account?.id || senders().find((a) => a.canSend)?.id || '',
      // Recipients as lists of { name, address } (chips in the composer), never one string.
      to: mode === 'new' ? (to ? [{ name: '', address: to }] : []) : rcpt.to.map(({ name, address }) => ({ name: name || '', address })),
      cc: rcpt.cc.map(({ name, address }) => ({ name: name || '', address })),
      bcc: [],
      subject: h ? (mode === 'forward' ? prefixed('Fwd', h.subject) : prefixed('Re', h.subject)) : '',
      body: composeBody(action === 'compose' ? 'compose' : mode, { msg: h, text, signature: account?.signature || '' }),
      files: [],
      forward,
      original: h ? { id: messageId(found.account.id, h.uid, h.folderKey), accountId: found.account.id, uid: h.uid, messageId: h.messageId || '', references } : null,
      dirty: false,
    };
    composer.open(draft);
    return { ok: true, via: 'widget' };
  }

  /** 보내기: checks what can be checked at once; the window closes and the send runs in the background. */
  function queueSend(d) {
    const account = accountOf(d.accountId);
    const who = senders().find((a) => a.id === d.accountId);
    if (!account || !who) return { ok: false, message: '보내는 계정을 고르세요.' };
    if (!who.canSend) return { ok: false, message: `${account.name}: ${who.reason}` };
    const fields = {};
    for (const k of ['to', 'cc', 'bcc']) {
      const checked = checkList(d[k]);
      if (checked.error) return { ok: false, field: k, message: checked.error };
      fields[k] = checked.list;
    }
    if (!fields.to.length && !fields.cc.length && !fields.bcc.length) return { ok: false, field: 'to', message: '받는 사람을 넣으세요.' };
    if (fields.to.length + fields.cc.length + fields.bcc.length > 100) return { ok: false, field: 'to', message: '받는 사람은 모두 100명까지입니다.' };
    if (attachedBytes(d) > MAX_ATTACH) return { ok: false, message: '첨부가 너무 큽니다(모두 합쳐 20MB까지).' };
    if (!running) return { ok: false, message: '메일 위젯이 꺼져 있습니다.' };
    outbox.set(d.id, { subject: d.subject });
    changed();
    runSend(d, account, fields).catch(() => {});
    return { ok: true, queued: true };
  }

  async function runSend(d, account, fields) {
    try {
      let attachments = composer.readFiles(d);
      if (d.forward?.include && d.original) {
        const found = lookup(d.original.id);
        const orig = found ? await found.sync.attachmentsOf(found.h.uid, MAX_ATTACH - attachedBytes({ ...d, forward: null }), found.h.folderKey) : { parts: [], skipped: d.forward.names };
        if (orig.skipped.length) throw new Error(`원본 첨부를 가져오지 못했습니다(${orig.skipped.join(', ')}). "원본 첨부 함께 보냄"을 끄고 다시 보내거나 파일 첨부로 넣으세요.`);
        attachments = [...attachments, ...orig.parts];
      }
      const res = mock ? await mockSend(d) : await sendMail({
        account,
        password: mock ? 'mock' : secrets.get(account.id),
        msg: {
          from: { name: account.senderName || '', address: account.email },
          to: fields.to,
          cc: fields.cc,
          bcc: fields.bcc,
          subject: d.subject,
          text: d.body,
          attachments,
          inReplyTo: d.original && d.mode !== 'forward' ? d.original.messageId : '',
          references: d.original && d.mode !== 'forward' ? d.original.references : [],
        },
        deps: { smtp: deps.smtp, imap: deps.imap, setTimeout: deps.sendTimer },
        waitMs: deps.sentWaitMs,
      });
      composer.done(d.id);
      contacts.learnSent([...fields.to, ...fields.cc, ...fields.bcc]);
      lastSent = { ok: true, subject: d.subject, at: Date.now(), sentFolder: res.sent.saved ? res.sent.box : null, note: res.sent.reason && res.sent.reason !== 'off' ? res.sent.reason : null };
      // A reply marks the original as answered (server flag \Answered).
      if (d.original && (d.mode === 'reply' || d.mode === 'replyAll')) {
        const found = lookup(d.original.id);
        if (found) found.sync.setFlag(found.h.uid, '\\Answered', true, found.h.folderKey).catch(() => {});
      }
    } catch (err) {
      const message = String(err?.message || err).slice(0, 240);
      lastSent = { ok: false, subject: d.subject, at: Date.now(), message };
      failCard(d, message);
    } finally {
      outbox.delete(d.id);
      changed();
    }
  }

  /** --mock-data: nothing leaves the PC; a subject containing "실패" fails so the card can be seen. */
  async function mockSend(d) {
    await new Promise((r) => setTimeout(r, deps.mockSendMs ?? 1500));
    if (/실패/.test(d.subject)) throw new Error('보내는 메일 서버가 로그인을 거절했습니다 (535 예시 오류, --mock-data)');
    return { sent: { saved: true, box: '보낸편지함' } };
  }

  function failCard(d, message) {
    if (!running || !ctx.notify) return;
    const subject = d.subject ? `"${String(d.subject).slice(0, 60)}"` : '(제목 없음)';
    ctx.notify([{ type: 'card', sticky: true, title: '메일 보내기 실패', body: `${subject} — ${message}`.slice(0, 300), icon: 'warning', tag: `mail-send:${d.id}`, actions: [{ id: 'reopen', label: '다시 열기' }] }], {
      onAction: (_e, id) => {
        if (id === 'reopen') composer.reopen(d.id, message);
        return undefined;
      },
    });
  }

  // ---- notifications ----

  // ---- 분류 on new-mail cards (#71, the #69 categories) ----

  /** The message of a single-message card: its tag is "mail:<message id>" (summary cards have none). */
  const cardMessage = (event) => {
    const tag = String(event?.tag || '');
    return tag.startsWith('mail:') ? lookup(tag.slice(5)) : null;
  };
  const cardItems = (event) => {
    const found = cardMessage(event);
    const on = new Set(found ? categories.idsFor(keyOf(found)) : []);
    return categories.list().map((c) => ({ id: c.id, label: c.name, color: c.color, checked: on.has(c.id) }));
  };
  const cardMenu = {
    label: '분류',
    appliesTo: (event) => String(event?.tag || '').startsWith('mail:'),
    items: (event) => cardItems(event),
    toggle(event, id, checked) {
      const found = cardMessage(event);
      if (!found) throw new Error('메일을 찾지 못했습니다(목록이 바뀌었을 수 있습니다).');
      const ids = new Set(categories.idsFor(keyOf(found)));
      if (checked) ids.add(id);
      else ids.delete(id);
      setMessageCategories(messageId(found.account.id, found.h.uid, found.h.folderKey), [...ids]);
      return cardItems(event);
    },
    create: {
      placeholder: '새 분류 이름',
      run(event, text) {
        const found = cardMessage(event);
        if (!found) throw new Error('메일을 찾지 못했습니다(목록이 바뀌었을 수 있습니다).');
        const res = createCategory(text);
        if (!res.ok) throw new Error(res.message);
        setMessageCategories(messageId(found.account.id, found.h.uid, found.h.folderKey), [...categories.idsFor(keyOf(found)), res.category.id]);
        return cardItems(event);
      },
    },
  };

  function sendCards(cards) {
    if (!running || !ctx.notify) return;
    const out = cards.map(({ ids, ...card }) => {
      cardIds.set(card.tag, ids);
      return card;
    });
    while (cardIds.size > 200) cardIds.delete(cardIds.keys().next().value);
    ctx.notify(out, {
      // #71: 분류 on a new-mail card (engine API 1.4 draws it; an older engine ignores it, no harm).
      menu: cardMenu,
      onAction: async (event, actionId) => {
        const ids = cardIds.get(event.tag) || [];
        if (actionId === 'read') {
          for (const id of ids) await setSeen(id, true).catch(() => {});
          return undefined;
        }
        if (actionId === 'open') {
          if (ids.length === 1) {
            const found = lookup(ids[0]);
            if (found?.account.openWith === 'webmail' && found.account.webmail) {
              await openWebmail({ id: ids[0] });
              return undefined;
            }
            if (settings().markReadOnOpen) await setSeen(ids[0], true).catch(() => {});
            host.focus();
            host.emit('reveal', { id: ids[0] });
          } else {
            host.focus();
            host.emit('reveal', { id: ids[ids.length - 1] || null });
          }
        }
        return undefined;
      },
    });
  }

  // ---- the mail theme contract v1 (docs/THEME_SPEC-mail.md) ----

  const idArg = (v) => (typeof v === 'string' && v.length <= 64 ? v : '');
  const wrap = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { ok: false, message: String(err?.message || err) };
    }
  };

  // Reading is allowed in the theme preview; anything that changes the mailbox or opens something needs a
  // click / key press and is refused there (theme-host-design 5.3).
  const THEME_METHODS = {
    getState: { run: () => view(), preview: 'allow' },
    list: { run: () => listView(), preview: 'allow' },
    loadMore: { run: () => loadMore(), preview: 'allow' },
    refresh: { run: () => refreshAll(), preview: 'allow' },
    get: { run: wrap(async (_e, id) => ({ ok: true, message: await detailOf(need(idArg(id))) })), preview: 'allow' },
    select: { run: wrap((entry, id) => select(entry, idArg(id))), preview: 'allow', gesture: true },
    markRead: { run: wrap((_e, id) => setSeen(idArg(id), true)), gesture: true },
    markUnread: { run: wrap((_e, id) => setSeen(idArg(id), false)), gesture: true },
    openPreview: { run: wrap((_e, id) => openPreview(idArg(id))), gesture: true },
    openWebmail: { run: wrap((_e, t) => openWebmail({ id: idArg(t?.id), accountId: idArg(t?.accountId) })), gesture: true },
    compose: { run: wrap((_e, t) => handoff('compose', { accountId: idArg(t?.accountId), to: typeof t?.to === 'string' ? t.to.slice(0, 200) : '', via: t?.via })), gesture: true },
    // #69 categories (this PC only).
    setCategories: { run: wrap((_e, id, ids) => setMessageCategories(idArg(id), ids)), gesture: true },
    createCategory: { run: wrap((_e, name, color) => createCategory(typeof name === 'string' ? name.slice(0, 60) : '', color)), gesture: true },
    filter: { run: (_e, category) => setFilter(category), preview: 'allow' },
    reply: { run: wrap((_e, id, opts) => handoff(opts?.all ? 'replyAll' : 'reply', { id: idArg(id), via: opts?.via })), gesture: true },
    forward: { run: wrap((_e, id, opts) => handoff('forward', { id: idArg(id), via: opts?.via })), gesture: true },
    addToTodo: { run: wrap((_e, id) => addToTodo(idArg(id))), gesture: true },
  };
  // changed: getState() again; messages: list() again; reveal: a card's 열기 ({ id }).
  const THEME_EVENTS = ['changed', 'messages', 'reveal'];

  /** 새 메일 쓰기 from the right-click menu: no theme to show a failure, so it becomes a card. */
  async function composeFromMenu() {
    const res = await handoff('compose', {}).catch((err) => ({ ok: false, message: String(err?.message || err) }));
    if (res.ok || !running || !ctx.notify) return;
    const account = accountsOf(settings()).find((a) => a.enabled);
    ctx.notify([{ type: 'card', title: '새 메일을 쓸 수 없습니다', body: res.message.slice(0, 300), icon: 'warning', tag: 'mail-compose', actions: res.fallback === 'webmail' ? [{ id: 'webmail', label: '웹메일로 쓰기' }] : [] }], {
      onAction: (_e, id) => (id === 'webmail' ? handoff('compose', { accountId: account?.id, via: 'webmail' }).then(() => undefined) : undefined),
    });
  }

  function menuItems() {
    const s = settings();
    const themes = host.settingsHandlers().themes().filter((t) => t.usable);
    return [
      { label: '지금 새로고침', enabled: syncs.size > 0, click: safe('menu refresh', () => refreshAll()) },
      { label: '새 메일 쓰기', enabled: accountsOf(s).some((a) => a.enabled), click: safe('menu compose', () => composeFromMenu()) },
      { type: 'separator' },
      { label: '새 메일 알림', type: 'checkbox', checked: s.notify, click: (item) => apply({ notify: item.checked }) },
      { label: '항상 위에 표시', type: 'checkbox', checked: s.alwaysOnTop, click: (item) => apply({ alwaysOnTop: item.checked }) },
      { label: '테마', submenu: themes.map((t) => ({ label: t.name, type: 'radio', checked: t.id === s.themeId, click: () => apply({ themeId: t.id }) })) },
    ];
  }

  const host = ctx.useThemes({
    store,
    builtinDir: path.join(ctx.dir, 'themes'),
    userDir: path.join(ctx.dataDir, 'themes'),
    kitDir: path.join(ctx.dir, 'kit'),
    defaultTheme: 'default',
    contractVersions: [1],
    frames: FRAMES,
    methods: THEME_METHODS,
    events: THEME_EVENTS,
    menuItems,
  });

  // ---- settings ----

  function apply(input) {
    const values = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const prev = settings();
    store.save(values);
    const s = settings();
    if (s.todoIntegration !== prev.todoIntegration) ctx.integrations?.setEnabled?.('todo', s.todoIntegration);
    if (running) {
      if (s.alwaysOnTop !== prev.alwaysOnTop) host.setPinned(s.alwaysOnTop);
      if (s.themeId !== prev.themeId) host.reload();
      else if (JSON.stringify(s.themeOpacity) !== JSON.stringify(prev.themeOpacity)) host.applyBackground();
    }
    if (s.pageSize !== prev.pageSize) limit = s.pageSize;
    ctx.sendToSettings?.('display', { alwaysOnTop: s.alwaysOnTop, notify: s.notify });
    reconcile();
  }

  const draftKey = (a) => loginKey(a);

  /**
   * "연결 확인": logs in with the typed password (or the saved one of the same login) and reads INBOX.
   * A typed password is kept in this process (token) until the settings are saved; it is only sent to the
   * account's own server, over TLS.
   */
  async function check(input = {}) {
    const provider = PROVIDERS[input.provider];
    if (!provider) return { ok: false, message: '메일 서비스를 고르세요.' };
    const a = sanitizeAccount({ ...input, id: input.accountId || undefined });
    if (!a) return { ok: false, message: provider.server === 'required' ? '아이디와 서버 이름(IMAP)을 넣으세요.' : `${provider.userLabel}를 넣으세요.` };
    const typed = String(input.password || '');
    let password = typed;
    if (!password) {
      const saved = settings().accounts.find((x) => x.id === input.accountId);
      if (saved && loginKey(saved) === loginKey(a)) password = secrets.get(saved.id);
    }
    if (!password) return { ok: false, message: `${provider.passwordLabel}를 넣으세요.` };
    if (typed && !secrets.available()) return { ok: false, message: SECRET_UNAVAILABLE };
    const client = new ImapClient({ host: a.host, port: a.port, security: a.security, username: a.username, password, deps: deps.imap || {} });
    try {
      await client.open();
      const box = await client.select('INBOX', { readOnly: true });
      const unseen = await client.count('UNSEEN').catch(() => null);
      let token = null;
      if (typed) {
        const now = Date.now();
        for (const [k, d] of drafts) if (now - d.at > DRAFT_TTL_MS) drafts.delete(k);
        token = crypto.randomBytes(12).toString('hex');
        drafts.set(token, { key: draftKey(a), password: typed, at: now });
      }
      // #68: the same login on the account's SMTP server (no mail is sent).
      const smtp = a.smtpHost ? await checkSmtp({ account: a, password, deps: { smtp: deps.smtp } }) : { ok: false, message: '보내는 메일 서버(SMTP)가 없어 위젯에서 보낼 수 없습니다.' };
      if (smtp.kind === 'auth') smtp.message = `${smtp.message} ${loginHint(input.provider, smtp)}`;
      return { ok: true, token, host: a.host, port: a.port, security: a.security, exists: box.exists, unseen, idle: client.has('IDLE'), smtp };
    } catch (err) {
      const kind = err?.kind || 'network';
      const server = kind === 'auth' && err.message ? ` (서버 응답: ${String(err.message).slice(0, 160)})` : '';
      return { ok: false, kind, message: kind === 'auth' ? `${loginHint(input.provider, err)}${server}` : String(err?.message || err) };
    } finally {
      client.logout().catch(() => {});
    }
  }

  function saveSettings(values) {
    const before = settings().accounts;
    const list = (Array.isArray(values.accounts) ? values.accounts : before).map((x) => ({ ...x }));
    const toStore = [];
    for (const [i, raw] of list.entries()) {
      const draft = raw.draft ? drafts.get(raw.draft) : null;
      delete raw.draft;
      const clean = sanitizeAccount(raw, i);
      if (!clean) return { ok: false, message: `${i + 1}번째 계정의 정보(서비스·아이디·서버)가 올바르지 않습니다.` };
      const old = before.find((b) => b.id === raw.id);
      if (!old) raw.id = newId();
      clean.id = raw.id;
      if (draft) {
        if (draft.key !== loginKey(clean)) return { ok: false, message: `${clean.name}: 연결 확인 뒤에 아이디나 서버가 바뀌었습니다. 연결 확인을 다시 누르세요.` };
        toStore.push({ id: raw.id, password: draft.password });
      } else if (!old || loginKey(old) !== loginKey(clean) || !secrets.has(old.id)) {
        return { ok: false, message: `${clean.name}: 비밀번호를 넣고 연결 확인을 눌러 주세요.` };
      }
    }
    if (toStore.length && !secrets.available()) return { ok: false, message: SECRET_UNAVAILABLE };
    // #69: the settings window's category list (names, colors, order; removed ones leave every message).
    if (Array.isArray(values.categories)) {
      try {
        categories.replaceAll(values.categories);
      } catch (err) {
        return { ok: false, message: err.message };
      }
    }
    try {
      for (const { id, password } of toStore) secrets.set(id, password);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    // A new password means a fresh login: rebuild that account's sync.
    for (const { id } of toStore) {
      const entry = syncs.get(id);
      if (entry) {
        entry.sync.stop();
        syncs.delete(id);
      }
    }
    apply({
      accounts: list,
      refreshMinutes: values.refreshMinutes,
      pageSize: values.pageSize,
      markReadOnOpen: values.markReadOnOpen,
      notify: values.notify,
      alwaysOnTop: values.alwaysOnTop,
      todoIntegration: values.todoIntegration,
      themeId: typeof values.themeId === 'string' && values.themeId ? values.themeId : undefined,
      themeOpacity: values.themeOpacity && typeof values.themeOpacity === 'object' ? values.themeOpacity : undefined,
    });
    const ids = settings().accounts.map((x) => x.id);
    secrets.prune(ids);
    pruneCaches(cacheDir, ids);
    return { ok: true };
  }

  /**
   * The account's mailboxes (LIST) for the picker (#80). Uses the password typed for 연결 확인 (its token) or
   * the saved one of the same login; nothing is stored here.
   */
  async function listFolders(input = {}) {
    const a = sanitizeAccount({ ...input, id: input.accountId || undefined });
    if (!a) return { ok: false, message: '아이디와 서버를 먼저 넣으세요.' };
    let password = '';
    const draft = input.draft ? drafts.get(input.draft) : null;
    if (draft && draft.key === draftKey(a)) password = draft.password;
    if (!password) {
      const saved = settings().accounts.find((x) => x.id === input.accountId);
      if (saved && loginKey(saved) === loginKey(a)) password = secrets.get(saved.id);
    }
    if (!password) return { ok: false, message: '먼저 연결 확인을 눌러 주세요.' };
    const client = new ImapClient({ host: a.host, port: a.port, security: a.security, username: a.username, password, deps: deps.imap || {} });
    try {
      await client.open();
      return { ok: true, folders: pickerFolders(await client.list()) };
    } catch (err) {
      return { ok: false, message: String(err?.message || err).slice(0, 200) };
    } finally {
      client.logout().catch(() => {});
    }
  }

  /** 가져오기: vCard / CSV files picked by the user (read here, never uploaded). */
  async function importContacts() {
    const dlg = deps.dialog || require('electron').dialog;
    const res = await dlg.showOpenDialog({ title: '주소록 가져오기 (vCard·CSV)', properties: ['openFile', 'multiSelections'], filters: [{ name: '주소록', extensions: ['vcf', 'vcard', 'csv', 'txt'] }] });
    if (!res || res.canceled || !res.filePaths?.length) return { ok: true, added: 0, updated: 0, cancelled: true };
    const fsMod = deps.fs || require('fs');
    let found = [];
    const failed = [];
    for (const file of res.filePaths) {
      try {
        const st = fsMod.statSync(file);
        if (st.size > 20 * 1024 * 1024) throw new Error('20MB보다 큼');
        found = found.concat(parseContactsFile(file, fsMod.readFileSync(file)));
      } catch (err) {
        failed.push(`${path.basename(file)}(${String(err?.message || err).slice(0, 60)})`);
      }
    }
    const r = contacts.importContacts(found);
    return { ok: true, ...r, found: found.length, failed, total: contacts.size() };
  }

  const settingsView = () => {
    const s = settings();
    return {
      themeId: s.themeId,
      themeOpacity: s.themeOpacity,
      mock,
      accounts: s.accounts,
      refreshMinutes: s.refreshMinutes,
      pageSize: s.pageSize,
      markReadOnOpen: s.markReadOnOpen,
      notify: s.notify,
      alwaysOnTop: s.alwaysOnTop,
      todoIntegration: s.todoIntegration,
      todoStatus: integrationStatus(),
      providers: providerList(),
      secretAvailable: secrets.available(),
      mailProgram: mailProgram(),
      categories: categories.list(),
      contactsCount: contacts.size(),
      status: statusList(),
    };
  };

  return {
    start() {
      running = true;
      ctx.integrations?.setEnabled?.('todo', settings().todoIntegration);
      ctx.integrations?.onStatus?.('todo', () => ctx.sendToSettings?.('integration-status', integrationStatus()));
      limit = settings().pageSize;
      lastListKey = '';
      ctx.handle('mail-reader', (event, name, arg) => reader.handle(event, name, arg));
      ctx.handle('mail-composer', (event, name, arg) => composer.handle(event, name, arg));
      reconcile();
      for (const { sync } of syncs.values()) sync.start();
      host.open();
    },
    stop() {
      running = false;
      notifier.cancel();
      clearTimeout(notifyTimer);
      notifyTimer = null;
      for (const { sync } of syncs.values()) sync.stop();
      syncs.clear();
      bodies.clear();
      reader.close();
      composer.closeAll();
      host.close();
    },
    focus: () => host.focus(),
    desktopWindows: () => host.desktopWindows(),
    // Locked, asleep or away: connections are closed; back: reconnect, and mail that came meanwhile gets cards.
    setPaused(reason) {
      const next = Boolean(reason);
      if (next === paused) return;
      paused = next;
      for (const { sync } of syncs.values()) sync.setPaused(paused);
      changed();
    },
    needsSetup: () => !mock && settings().accounts.length === 0,
    settings: {
      get: () => settingsView(),
      save(values = {}) {
        const result = saveSettings(values);
        if (result.ok) drafts.clear();
        return result;
      },
      handlers: {
        ...host.settingsHandlers(),
        check: (input) => check(input),
        // #70 주소록 in the settings window (applied at once, not on 저장).
        contactsSearch: (q) => ({ total: contacts.size(), list: contacts.search(typeof q === 'string' ? q.slice(0, 100) : '', 200) }),
        contactsRename: (address, name) => {
          try {
            return { ok: true, contact: contacts.rename(address, name) };
          } catch (err) {
            return { ok: false, message: err.message };
          }
        },
        contactsRemove: (address) => ({ ok: contacts.remove(address) }),
        contactsImport: () => importContacts(),
        // #80: the server's mailboxes for the "함께 볼 메일함" picker.
        listFolders: (input) => listFolders(input),
        status: () => statusList(),
        todoStatus: () => integrationDetails(),
        refresh: async () => {
          await refreshAll();
          return statusList();
        },
      },
    },
    // For tests.
    _internals: { syncs, view, listView, notifier, reader, cardIds, composer, outbox },
  };
}

module.exports = { create };
