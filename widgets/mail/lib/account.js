// One IMAP account's INBOX kept in sync (#65): connect → SELECT → initial or incremental sync → IDLE (re-IDLE
// every 25 minutes) or polling, reconnect with backoff, new-mail detection, paging to older mail, bodies on
// demand. Commands from the widget (bodies, flags, paging) run between IDLE rounds, one at a time.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { ImapClient } = require('./imap-client');
const { str, compactSet } = require('./imap-parser');
const { parseEnvelope, parseBodyStructure, attachments, displayParts, snippetPart, sectionOf, partText, decodeTransfer, leaves: leavesOf, isAttachment, parseHeaders } = require('./mime');
const { htmlToText, snippetOf } = require('./sanitize');

const HEADER_ITEMS = 'UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE';
const IDLE_MS = 25 * 60000; // RFC 2177: servers may drop an IDLE after 30 minutes
const BACKOFF_S = [5, 15, 30, 60, 120, 300, 600, 900];
const NOTIFY_MAX_AGE = 12 * 3600000; // older arrivals (moved in from another folder, late delivery) get no card
// #109: older pages ("더 보기") drop back to the newest cacheSize messages after this long without paging.
const TRIM_AFTER_MS = 30 * 60000;
const SNIPPET_BYTES = 1200;
const MAX_TEXT_PART = 2 * 1024 * 1024;
const MAX_IMAGES = 1024 * 1024;
// #80: extra mailboxes (rule-sorted folders) are checked with STATUS this often and opened only when changed.
const FOLDER_POLL_MS = 3 * 60000;
// #83: headers fetched per mailbox for the 안 읽음 / 중요 lists at a time (더 보기 asks for the next step).
const MARKED_STEP = 200;
const KINDS = { unread: 'unseenUids', flagged: 'flaggedUids' };

/** A short stable key of a mailbox (its raw LIST name), used in message ids: "acc:<key>:<uid>". */
const folderKeyOf = (raw) => crypto.createHash('sha1').update(String(raw)).digest('hex').slice(0, 8);

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** INTERNALDATE "17-Jul-1996 02:44:25 -0700" -> ms (null when not that shape). */
function parseInternalDate(v) {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(str(v));
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  const off = (Number(m[8]) * 60 + Number(m[9])) * 60000 * (m[7] === '+' ? 1 : -1);
  return utc - off;
}

/** FETCH attributes -> the header record the widget keeps (no body). */
function headerOf(a) {
  const env = parseEnvelope(a.ENVELOPE) || { from: [], to: [], cc: [], replyTo: [], subject: '', date: null, messageId: '', inReplyTo: '' };
  const tree = parseBodyStructure(a.BODYSTRUCTURE);
  const flags = (Array.isArray(a.FLAGS) ? a.FLAGS : []).map((f) => str(f));
  const internal = parseInternalDate(a.INTERNALDATE);
  return {
    uid: a.UID,
    date: internal || env.date || 0,
    sentDate: env.date,
    subject: env.subject,
    from: env.from[0] || env.sender?.[0] || null,
    to: env.to,
    cc: env.cc,
    replyTo: env.replyTo,
    messageId: env.messageId,
    unread: !flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    answered: flags.includes('\\Answered'),
    hasAttachments: tree ? attachments(tree).length > 0 : false,
    size: Number(str(a['RFC822.SIZE'])) || 0,
    structure: tree,
    snippet: null,
  };
}

class AccountSync extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.account   sanitized account (host, port, security, username, ...)
   * @param {() => string} o.password
   * @param {{ load(): object|null, save(obj): void }} o.cache
   * @param {object} [o.deps]    { connect, upgrade, now, setTimeout, clearTimeout } seams for tests
   */
  constructor({ account, password, cache, deps = {}, cacheSize = 50, pageSize = 30, refreshMinutes = 10 }) {
    super();
    this.account = account;
    this.password = password;
    this.cache = cache;
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.cacheSize = cacheSize;
    this.pageSize = pageSize;
    this.refreshMs = refreshMinutes * 60000;
    this.client = null;
    this.running = false;
    this.paused = false;
    this.ops = [];
    this.wakeFn = null;
    this.dirty = false;
    this.firstSync = true; // the first sync of this run is silent (no cards)
    this.backoff = 0;
    this.status = { state: 'off', error: null, kind: null, lastSync: null };
    this.unread = 0;
    this.flagged = 0; // #72: \Flagged in INBOX, counted by the server
    this.messages = new Map(); // uid -> header
    this.uidValidity = null;
    this.highest = 0;
    this.hasMore = false;
    this.loadedMoreAt = 0; // #109: when "더 보기" last added older mail (trimLoaded)
    this.exists = 0;
    this.loopDone = null;
    this.refreshWaiters = []; // #79: refresh() calls waiting for the next sync
    this.known = false; // whether this mailbox (UIDVALIDITY) was looked at before: then only newer UIDs are fetched
    // #83: the server's UNSEEN / FLAGGED UIDs (UID SEARCH), the one source of the counts and the 안 읽음 / 중요
    // lists; headers of those UIDs outside the loaded range, fetched while such a list is open.
    this.unseenUids = null;
    this.flaggedUids = null;
    this.marked = new Map();
    this.markedWant = { unread: 0, flagged: 0 };
    // #80: the account's extra mailboxes: key -> { key, raw, name, uidValidity, highest, sig, unseen, flagged,
    // known, firstSync, messages: Map(uid -> header), error }. INBOX stays in the fields above.
    this.folders = new Map();
    this.folderCache = [];
    this.forceFolders = false;
    this.folderDue = false;
    this.lastFullSync = 0;
    this.restore();
  }

  // ---- cache (headers only; snippets and bodies are never written) ----

  restore() {
    const c = this.cache?.load?.();
    if (!c || typeof c !== 'object' || !Array.isArray(c.messages)) return;
    this.uidValidity = c.uidValidity ?? null;
    this.known = this.uidValidity !== null;
    this.highest = Number(c.highest) || 0;
    this.hasMore = Boolean(c.hasMore);
    this.unread = Number(c.unread) || 0;
    this.flagged = Number(c.flagged) || 0;
    for (const m of c.messages) if (m && Number.isInteger(m.uid)) this.messages.set(m.uid, { ...m, snippet: null });
    if (c.lastSync) this.status.lastSync = c.lastSync;
    this.folderCache = Array.isArray(c.folders) ? c.folders : [];
    this.syncFolderList();
  }

  persist() {
    const strip = ({ snippet, ...rest }) => rest;
    const list = this.inboxList().slice(0, this.cacheSize).map(strip);
    const folders = [...this.folders.values()].map((f) => ({
      key: f.key,
      raw: f.raw,
      name: f.name,
      uidValidity: f.uidValidity,
      highest: f.highest,
      sig: f.sig,
      unseen: f.unseen,
      flagged: f.flagged,
      known: f.known,
      messages: [...f.messages.values()].sort((a, b) => b.date - a.date).slice(0, this.cacheSize).map(strip),
    }));
    try {
      this.cache?.save?.({ uidValidity: this.uidValidity, highest: this.highest, hasMore: this.hasMore || this.messages.size > list.length, unread: this.unread, flagged: this.flagged, lastSync: this.status.lastSync, messages: list, folders });
    } catch {
      // the cache is only for a fast start
    }
  }

  /** INBOX headers newest first (by arrival). */
  inboxList() {
    return [...this.messages.values()].sort((a, b) => b.date - a.date || b.uid - a.uid);
  }

  /**
   * Every header the account shows, newest first: INBOX and the chosen mailboxes (#80). A message that is in
   * INBOX and in a folder too (Gmail labels) shows once, from INBOX.
   */
  list() {
    const inbox = this.inboxList();
    if (!this.folders.size) return inbox;
    const ids = new Set(inbox.map((m) => m.messageId).filter(Boolean));
    const extra = [];
    for (const f of this.folders.values()) for (const m of f.messages.values()) if (!m.messageId || !ids.has(m.messageId)) extra.push(m);
    return [...inbox, ...extra].sort((a, b) => b.date - a.date || b.uid - a.uid);
  }

  /** The header of a message: INBOX (folderKey '') or a chosen mailbox. */
  find(uid, folderKey = '') {
    const box = folderKey ? this.folders.get(folderKey) : this;
    return box ? box.messages.get(uid) || box.marked.get(uid) || null : null;
  }

  /** INBOX (key '') and the chosen mailboxes, each { key, state, fallbackUnread, fallbackFlagged }. */
  boxes() {
    return [{ key: '', state: this, unread: this.unread, flagged: this.flagged || 0 }, ...[...this.folders.values()].map((f) => ({ key: f.key, state: f, unread: f.unseen || 0, flagged: f.flagged || 0 }))];
  }

  /**
   * #83: the messages the server marks unread and / or flagged, across INBOX and the chosen mailboxes:
   * { headers (loaded ones, newest first, flags from the server's lists), total, missing }. total counts the
   * server's UIDs (a message in INBOX and in a folder, known by its Message-ID, once); missing: some of them
   * have no header here yet (fetchMarked / 더 보기). Before the first sync the cached counts stand in.
   */
  markedList(kinds = {}) {
    const want = Object.keys(KINDS).filter((k) => kinds[k]);
    const out = [];
    let total = 0;
    let missing = false;
    for (const b of this.boxes()) {
      const sets = want.map((k) => b.state[KINDS[k]]);
      if (sets.some((x) => !x)) {
        // Not looked at on this run yet: the loaded headers and the cached server count.
        const loaded = [...b.state.messages.values()].filter((h) => want.every((k) => (k === 'unread' ? h.unread : h.flagged)));
        out.push(...loaded);
        total += want.length === 1 ? Math.max(b[want[0]], loaded.length) : loaded.length;
        if (want.length === 1 && b[want[0]] > loaded.length) missing = true;
        continue;
      }
      const [first, ...rest] = sets;
      for (const uid of first) {
        if (!rest.every((x) => x.has(uid))) continue;
        total++;
        const h = b.state.messages.get(uid) || b.state.marked.get(uid);
        if (!h) {
          missing = true;
          continue;
        }
        if (b.state.unseenUids) h.unread = b.state.unseenUids.has(uid);
        if (b.state.flaggedUids) h.flagged = b.state.flaggedUids.has(uid);
        out.push(h);
      }
    }
    // Gmail labels: the same message in INBOX and a folder shows (and counts) once.
    const seen = new Set();
    const headers = [];
    for (const h of out) {
      const id = h.messageId ? String(h.messageId).toLowerCase() : '';
      if (id && seen.has(id)) {
        total--;
        continue;
      }
      if (id) seen.add(id);
      headers.push(h);
    }
    headers.sort((a, b) => b.date - a.date || b.uid - a.uid);
    return { headers, total, missing };
  }

  /** Unread / flagged of INBOX and the chosen mailboxes: the same server lists the 안 읽음 / 중요 views show (#83). */
  totalUnread() {
    return this.markedList({ unread: true }).total;
  }

  totalFlagged() {
    return this.markedList({ flagged: true }).total;
  }

  /**
   * #83: an 안 읽음 / 중요 list is open (n = how many per mailbox to have headers for, 0 = closed). Fetches the
   * missing headers now (and after each sync while open). Resolves when they are here.
   */
  demandMarked(kinds = {}, n = MARKED_STEP) {
    for (const k of Object.keys(KINDS)) this.markedWant[k] = kinds[k] ? Math.max(0, n) : 0;
    if (!this.markedWant.unread && !this.markedWant.flagged) {
      this.marked.clear();
      for (const f of this.folders.values()) f.marked.clear();
      return Promise.resolve(0);
    }
    return this.exec((c) => this.fetchMarked(c));
  }

  /** Headers of the newest wanted UNSEEN / FLAGGED UIDs that are not loaded yet, per mailbox. */
  async fetchMarked(c) {
    const kinds = Object.keys(KINDS).filter((k) => this.markedWant[k] > 0);
    if (!kinds.length) return 0;
    let added = 0;
    for (const b of this.boxes()) {
      const st = b.state;
      const need = new Set();
      for (const k of kinds) {
        const set = st[KINDS[k]];
        if (!set) continue;
        for (const uid of [...set].sort((x, y) => y - x).slice(0, this.markedWant[k])) if (!st.messages.has(uid) && !st.marked.has(uid)) need.add(uid);
      }
      if (!need.size) continue;
      const run = async () => {
        const rows = await c.fetch(compactSet([...need].sort((x, y) => x - y)), HEADER_ITEMS);
        const got = rows.map((r) => (b.key ? { ...headerOf(r), folder: st.name, folderKey: st.key, uidValidity: st.uidValidity } : headerOf(r)));
        for (const h of got) st.marked.set(h.uid, h);
        await this.fetchSnippets(c, got);
        added += got.length;
      };
      try {
        if (b.key) await this.inFolder(c, st, run);
        else await run();
      } catch (err) {
        if (c.closed) throw err;
        if (b.key) st.error = String(err?.message || err).slice(0, 200);
      }
    }
    if (added) this.emit('changed');
    return added;
  }

  /** The server's UNSEEN / FLAGGED UIDs of the selected mailbox into a state (INBOX or a folder). */
  async markLists(c, st) {
    st.unseenUids = new Set(await c.uidSearch('UNSEEN'));
    st.flaggedUids = new Set(await c.uidSearch('FLAGGED'));
    // Headers fetched for a list that are now in the loaded range are kept once.
    for (const uid of st.marked.keys()) if (st.messages.has(uid)) st.marked.delete(uid);
  }

  /** The chosen mailboxes for views: [{ key, name, unread, error }]. */
  folderInfo() {
    return [...this.folders.values()].map((f) => ({ key: f.key, name: f.name, unread: f.unseen || 0, error: f.error || null }));
  }

  /** Lines the folder states up with account.folders (added ones start silent, removed ones go). */
  syncFolderList() {
    const wanted = Array.isArray(this.account.folders) ? this.account.folders : [];
    const keys = new Set();
    for (const w of wanted) {
      const key = folderKeyOf(w.raw);
      keys.add(key);
      let f = this.folders.get(key);
      if (!f) {
        const cached = this.folderCache.find((x) => x && x.key === key);
        f = {
          key,
          raw: w.raw,
          name: w.name || w.raw,
          uidValidity: cached?.uidValidity ?? null,
          highest: Number(cached?.highest) || 0,
          sig: cached?.sig || '',
          unseen: Number(cached?.unseen) || 0,
          flagged: Number(cached?.flagged) || 0,
          known: Boolean(cached?.known),
          firstSync: true,
          messages: new Map(),
          unseenUids: null,
          flaggedUids: null,
          marked: new Map(),
          error: null,
          lastCheck: 0,
        };
        for (const m of Array.isArray(cached?.messages) ? cached.messages : []) if (m && Number.isInteger(m.uid)) f.messages.set(m.uid, { ...m, snippet: null, folder: f.name, folderKey: key });
        this.folders.set(key, f);
      }
      f.name = w.name || w.raw;
    }
    for (const key of [...this.folders.keys()]) if (!keys.has(key)) this.folders.delete(key);
  }

  setStatus(state, error = null, kind = null) {
    this.status = { ...this.status, state, error, kind };
    this.emit('changed');
  }

  // ---- lifecycle ----

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.loopDone = this.loop();
  }

  async stop() {
    this.running = false;
    this.settleRefresh([...(this.syncWaiters || []), ...this.refreshWaiters.splice(0)], { ok: false, message: '계정 동기화를 멈췄습니다.' });
    this.wake();
    const c = this.client;
    this.client = null;
    if (c) c.logout().catch(() => {});
    for (const op of this.ops.splice(0)) op.reject(new Error('계정 동기화를 멈췄습니다.'));
    this.setStatus('off');
    await this.loopDone?.catch(() => {});
  }

  /** Locked / asleep / away: disconnect but keep what we know; back: reconnect (arrivals meanwhile get cards). */
  setPaused(on) {
    if (on === this.paused) return;
    this.paused = on;
    if (on) {
      this.settleRefresh(this.refreshWaiters.splice(0), { ok: true, paused: true, fresh: 0 });
      const c = this.client;
      this.client = null;
      c?.logout().catch(() => {});
      this.setStatus('paused');
    }
    this.wake();
  }

  /**
   * "새로고침": a full check now, IDLE accounts too (the IDLE round ends at once). Resolves after a sync that
   * started after this call: { ok: true, fresh } (new messages found), or { ok: false, message } when it
   * failed, { ok: true, paused: true } while away. Also retries after a refused login.
   */
  refresh() {
    if (!this.running) return Promise.resolve({ ok: false, message: '계정이 꺼져 있습니다.' });
    if (this.paused) return Promise.resolve({ ok: true, paused: true, fresh: 0 });
    const done = new Promise((resolve) => this.refreshWaiters.push(resolve));
    this.dirty = true;
    this.forceFolders = true; // 새로고침 opens the chosen mailboxes too, changed or not (#80)
    this.authBlocked = false;
    this.backoff = 0;
    this.wake();
    return done;
  }

  /** Answers the refresh calls that a finished (or failed) sync covers. */
  settleRefresh(waiters, result) {
    for (const w of waiters) w(result);
  }

  wake() {
    const w = this.wakeFn;
    this.wakeFn = null;
    if (w) w();
    else this.wakePending = true; // nobody is waiting yet (e.g. IDLE is starting): the next sleep returns at once
  }

  sleep(ms) {
    const st = this.deps.setTimeout || setTimeout;
    const ct = this.deps.clearTimeout || clearTimeout;
    return new Promise((resolve) => {
      if (this.wakePending) {
        this.wakePending = false;
        resolve('wake');
        return;
      }
      const t = st(() => {
        this.wakeFn = null;
        resolve('timer');
      }, ms);
      this.wakeFn = () => {
        ct(t);
        resolve('wake');
      };
    });
  }

  async loop() {
    while (this.running) {
      if (this.paused || this.authBlocked) {
        await this.sleep(3600000);
        continue;
      }
      try {
        if (!this.client || this.client.closed) await this.connect();
        await this.runOps();
        await this.sync();
        this.backoff = 0;
        while (this.running && !this.paused && this.client && !this.client.closed) {
          await this.runOps();
          if (this.dirty) {
            await this.sync();
            continue;
          }
          if (this.folderDue) {
            // #80: the few-minute check of the chosen mailboxes (STATUS; opened only when changed).
            this.folderDue = false;
            const r = await this.syncFolders(this.client, { force: false, silent: false });
            await this.fetchMarked(this.client);
            this.persist();
            this.emit('changed');
            if (r.arrivals.length) this.emit('new', r.arrivals);
            continue;
          }
          await this.waitForChange();
        }
      } catch (err) {
        if (!this.running) break;
        const c = this.client;
        this.client = null;
        c?.close();
        if (this.paused) continue;
        const kind = err?.kind || 'network';
        this.setStatus('error', String(err?.message || err), kind);
        // Refresh calls waiting for this round get the reason (#79).
        this.settleRefresh([...(this.syncWaiters || []), ...this.refreshWaiters.splice(0)], { ok: false, message: String(err?.message || err) });
        this.syncWaiters = [];
        for (const op of this.ops.splice(0)) op.reject(err);
        if (kind === 'auth' || kind === 'starttls' || kind === 'tls') {
          // Do not retry a refused login on our own: repeated failures can lock the account.
          this.authBlocked = true;
          continue;
        }
        const wait = BACKOFF_S[Math.min(this.backoff, BACKOFF_S.length - 1)] * 1000;
        this.backoff++;
        await this.sleep(wait);
      }
    }
  }

  async connect() {
    this.setStatus('connecting');
    const a = this.account;
    const client = new ImapClient({ host: a.host, port: a.port, security: a.security, username: a.username, password: this.password(), deps: this.deps });
    client.on('mailbox', (res) => this.onMailbox(res));
    client.on('close', () => this.wake());
    await client.open();
    const box = await client.select('INBOX');
    this.client = client;
    this.exists = box.exists;
    if (this.uidValidity !== null && box.uidValidity !== this.uidValidity) {
      // UIDVALIDITY changed: every UID we know is meaningless. Start over silently.
      this.messages.clear();
      this.marked.clear();
      this.unseenUids = null;
      this.flaggedUids = null;
      this.highest = 0;
      this.known = false;
      this.firstSync = true;
    }
    this.uidValidity = box.uidValidity;
    this.dirty = true;
  }

  onMailbox(res) {
    if (this.inFolderNow) return; // a chosen mailbox is selected for a moment (#80): not INBOX news
    if (res.type === 'EXISTS') this.exists = res.num;
    else if (res.type === 'EXPUNGE') this.exists = Math.max(0, this.exists - 1);
    this.dirty = true;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.wake(), 300);
  }

  /** IDLE until something happens (server event, a widget command, refresh, 25 minutes), or poll. */
  async waitForChange() {
    const c = this.client;
    // With chosen mailboxes (#80) the wait is cut into folder-check rounds; the full check keeps its pace.
    const fullMs = c.has('IDLE') ? IDLE_MS : this.refreshMs;
    const waitMs = this.folders.size ? Math.min(fullMs, FOLDER_POLL_MS) : fullMs;
    const onTimer = () => {
      if (!this.folders.size || this.now() - this.lastFullSync >= fullMs) this.dirty = true;
      else this.folderDue = true;
    };
    if (!c.has('IDLE')) {
      const why = await this.sleep(waitMs);
      if (why === 'timer') onTimer();
      return;
    }
    if (this.ops.length || this.dirty) return;
    this.wakePending = false;
    const handle = await c.idle();
    const why = await Promise.race([this.sleep(waitMs), handle.ended.then(() => 'ended')]);
    if (why === 'timer') onTimer(); // a periodic full check as well
    if (why !== 'ended' && !c.closed) await handle.done();
  }

  /** Runs a widget command on the connection (between IDLE rounds). */
  exec(fn) {
    if (!this.running) return Promise.reject(new Error('계정이 꺼져 있습니다.'));
    if (this.status.state === 'error' && (!this.client || this.client.closed)) {
      return Promise.reject(new Error(`서버에 연결되어 있지 않습니다: ${this.status.error}`));
    }
    return new Promise((resolve, reject) => {
      this.ops.push({ fn, resolve, reject });
      this.wake();
    });
  }

  async runOps() {
    while (this.ops.length && this.client && !this.client.closed) {
      const op = this.ops.shift();
      try {
        op.resolve(await op.fn(this.client));
      } catch (err) {
        op.reject(err);
        if (this.client?.closed) throw err;
      }
    }
  }

  // ---- sync ----

  async sync() {
    const c = this.client;
    this.dirty = false;
    // Refresh calls made before this sync started are answered when it ends (#79).
    this.syncWaiters = this.refreshWaiters;
    this.refreshWaiters = [];
    this.setStatus('syncing');
    const silent = this.firstSync;
    const fresh = [];
    if (!this.known) {
      // First look at this mailbox: the newest cacheSize messages by sequence number.
      if (this.exists > 0) {
        const from = Math.max(1, this.exists - this.cacheSize + 1);
        const rows = await c.fetch(`${from}:${this.exists}`, HEADER_ITEMS, { uid: false });
        for (const r of rows) this.messages.set(r.UID, headerOf(r));
        this.hasMore = from > 1;
      } else this.hasMore = false;
    } else {
      this.trimLoaded();
      const newer = (await c.uidSearch(`UID ${this.highest + 1}:*`)).filter((u) => u > this.highest);
      let take = newer;
      if (newer.length > this.cacheSize) {
        // Far behind (cache from long ago): keep only the newest page, older ones come with "더 보기".
        take = newer.slice(-this.cacheSize);
        this.messages.clear();
        this.hasMore = true;
      }
      if (take.length) {
        const rows = await c.fetch(compactSet(take), HEADER_ITEMS);
        for (const r of rows) {
          const h = headerOf(r);
          this.messages.set(h.uid, h);
          fresh.push(h);
        }
      }
      await this.syncFlags(c, new Set(take));
    }
    for (const uid of this.messages.keys()) this.highest = Math.max(this.highest, uid);
    // #72 / #83: the 안 읽음 / 중요 numbers of the whole INBOX, as UID lists so the lists show the same mail.
    await this.markLists(c, this);
    this.unread = this.unseenUids.size;
    this.flagged = this.flaggedUids.size;
    await this.fetchSnippets(c, this.inboxList().filter((m) => m.snippet === null));
    // #80: the chosen mailboxes (the first look at one is silent, like the first sync).
    const folderRes = await this.syncFolders(c, { force: this.forceFolders, silent });
    await this.fetchMarked(c);
    this.forceFolders = false;
    this.lastFullSync = this.now();
    this.firstSync = false;
    this.known = true;
    this.status.lastSync = this.now();
    this.setStatus('ok');
    this.persist();
    this.settleRefresh(this.syncWaiters || [], { ok: true, fresh: fresh.length + folderRes.fresh });
    this.syncWaiters = [];
    const cutoff = this.now() - NOTIFY_MAX_AGE;
    const arrivals = [...(silent ? [] : fresh.filter((m) => m.unread && m.date >= cutoff)), ...folderRes.arrivals].sort((a, b) => a.date - b.date);
    if (arrivals.length) this.emit('new', arrivals);
  }

  // ---- #80 chosen mailboxes ----

  /**
   * Runs fn with a chosen mailbox selected on this connection, then selects INBOX again (IDLE stays on INBOX;
   * no second connection). Mailbox events meanwhile are about that folder and are ignored.
   */
  async inFolder(c, f, fn) {
    this.inFolderNow = true;
    try {
      const box = await c.select(f.raw, { raw: true });
      return await fn(box);
    } finally {
      try {
        const inbox = await c.select('INBOX');
        // INBOX mail that came (or went) while the folder was selected: its EXISTS was not ours to see.
        if (inbox.exists !== this.exists) this.dirty = true;
        this.exists = inbox.exists;
        if (this.uidValidity !== null && inbox.uidValidity !== this.uidValidity) this.dirty = true;
      } finally {
        this.inFolderNow = false;
      }
    }
  }

  /** Runs fn on the mailbox of a message (INBOX: as is). */
  onFolderOf(c, folderKey, fn) {
    if (!folderKey) return fn();
    const f = this.folders.get(folderKey);
    if (!f) throw new Error('이 메일함은 더 이상 함께 보지 않습니다.');
    return this.inFolder(c, f, fn);
  }

  /**
   * Checks every chosen mailbox with STATUS and opens one only when it changed (or force): new mail, flags,
   * deletes, its unread / flagged counts. Returns { fresh, arrivals } (arrivals: unread, recent, not silent).
   */
  async syncFolders(c, { force = false, silent = false } = {}) {
    this.syncFolderList();
    let fresh = 0;
    const arrivals = [];
    const cutoff = this.now() - NOTIFY_MAX_AGE;
    for (const f of this.folders.values()) {
      try {
        const got = await this.syncFolder(c, f, force);
        fresh += got.length;
        if (!silent && !got.silent) arrivals.push(...got.filter((m) => m.unread && m.date >= cutoff));
        f.error = null;
      } catch (err) {
        if (c.closed) throw err;
        f.error = String(err?.message || err).slice(0, 200); // e.g. the folder was deleted on the server
      }
      f.lastCheck = this.now();
    }
    return { fresh, arrivals };
  }

  async syncFolder(c, f, force) {
    const st = await c.status(f.raw, ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN']);
    f.unseen = st.UNSEEN || 0;
    if (f.uidValidity !== null && st.UIDVALIDITY && st.UIDVALIDITY !== f.uidValidity) {
      f.messages.clear();
      f.marked.clear();
      f.unseenUids = null;
      f.flaggedUids = null;
      f.highest = 0;
      f.known = false;
      f.firstSync = true;
    }
    const sig = `${st.UIDVALIDITY}:${st.UIDNEXT}:${st.MESSAGES}:${st.UNSEEN}`;
    const out = [];
    out.silent = f.firstSync;
    if (!force && f.known && sig === f.sig) {
      f.firstSync = false;
      return out;
    }
    f.uidValidity = st.UIDVALIDITY ?? f.uidValidity;
    const mark = (r) => ({ ...headerOf(r), folder: f.name, folderKey: f.key, uidValidity: f.uidValidity });
    await this.inFolder(c, f, async (box) => {
      if (!f.known) {
        if (box.exists > 0) {
          const from = Math.max(1, box.exists - this.cacheSize + 1);
          for (const r of await c.fetch(`${from}:${box.exists}`, HEADER_ITEMS, { uid: false })) f.messages.set(r.UID, mark(r));
        }
      } else {
        const newer = (await c.uidSearch(`UID ${f.highest + 1}:*`)).filter((u) => u > f.highest);
        const take = newer.length > this.cacheSize ? newer.slice(-this.cacheSize) : newer;
        if (newer.length > this.cacheSize) f.messages.clear();
        if (take.length) {
          for (const r of await c.fetch(compactSet(take), HEADER_ITEMS)) {
            const h = mark(r);
            f.messages.set(h.uid, h);
            out.push(h);
          }
        }
        await this.syncFlags(c, new Set(take), f.messages);
      }
      for (const uid of f.messages.keys()) f.highest = Math.max(f.highest, uid);
      await this.markLists(c, f);
      f.flagged = f.flaggedUids.size;
      f.unseen = f.unseenUids.size;
      await this.fetchSnippets(c, [...f.messages.values()].filter((m) => m.snippet === null));
    });
    f.sig = sig;
    f.known = true;
    f.firstSync = false;
    return out;
  }

  /** Flags of the loaded range again (other clients read / flag / delete mail); gone UIDs are dropped. */
  async syncFlags(c, skip, map = this.messages) {
    const known = [...map.keys()].filter((u) => !skip.has(u));
    if (!known.length) return;
    const min = Math.min(...known);
    const max = Math.max(...known);
    const rows = await c.fetch(`${min}:${max}`, 'UID FLAGS');
    const seen = new Set();
    for (const r of rows) {
      seen.add(r.UID);
      const m = map.get(r.UID);
      if (!m) continue;
      const flags = (r.FLAGS || []).map((f) => str(f));
      m.unread = !flags.includes('\\Seen');
      m.flagged = flags.includes('\\Flagged');
      m.answered = flags.includes('\\Answered');
    }
    for (const uid of known) if (!seen.has(uid)) map.delete(uid);
  }

  /** One short text per message, from a partial fetch of its first text part (kept in memory only). */
  async fetchSnippets(c, list) {
    const groups = new Map(); // section -> [header]
    for (const m of list) {
      const part = m.structure ? snippetPart(m.structure) : null;
      if (!part) {
        m.snippet = '';
        continue;
      }
      const sec = sectionOf(part);
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec).push({ m, part });
    }
    for (const [sec, items] of groups) {
      const rows = await c.fetch(compactSet(items.map((x) => x.m.uid)), `BODY.PEEK[${sec}]<0.${SNIPPET_BYTES}>`);
      const byUid = new Map(rows.map((r) => [r.UID, r]));
      for (const { m, part } of items) {
        const r = byUid.get(m.uid);
        const raw = r ? Object.entries(r).find(([k]) => k.startsWith(`BODY[${sec}]`))?.[1] : null;
        let text = raw ? partText(part, Buffer.isBuffer(raw) ? raw : Buffer.from(str(raw))) : '';
        if (part.subtype === 'html') text = htmlToText(text);
        m.snippet = snippetOf(text);
      }
    }
  }

  // ---- commands from the widget ----

  /**
   * #109: older mail loaded with "더 보기" stays only while it is being looked at. When nobody paged for
   * TRIM_AFTER_MS, the list goes back to the newest cacheSize messages (the rest comes again with "더 보기"), so a long
   * run does not keep every page in memory and does not check its flags on every sync. Returns whether it trimmed.
   */
  trimLoaded() {
    if (this.messages.size <= this.cacheSize || this.now() - this.loadedMoreAt < TRIM_AFTER_MS) return false;
    const keep = new Set(this.inboxList().slice(0, this.cacheSize).map((h) => h.uid));
    for (const uid of [...this.messages.keys()]) if (!keep.has(uid)) this.messages.delete(uid);
    this.hasMore = true;
    return true;
  }

  /** Older messages ("더 보기"): the next `count` below the oldest loaded UID. */
  loadMore(count = this.pageSize) {
    return this.exec(async (c) => {
      const loaded = [...this.messages.keys()];
      const min = loaded.length ? Math.min(...loaded) : this.highest + 1;
      if (min <= 1) {
        this.hasMore = false;
        this.emit('changed');
        return 0;
      }
      const older = await c.uidSearch(`UID 1:${min - 1}`);
      const take = older.filter((u) => u < min).slice(-count);
      this.loadedMoreAt = this.now();
      if (take.length) {
        const rows = await c.fetch(compactSet(take), HEADER_ITEMS);
        const added = rows.map(headerOf);
        for (const h of added) {
          this.messages.set(h.uid, h);
          this.marked.delete(h.uid);
        }
        await this.fetchSnippets(c, added.filter((h) => h.snippet === null));
      }
      this.hasMore = older.length > take.length;
      this.emit('changed');
      return take.length;
    });
  }

  /** The parts needed to show a message: decoded html / text and cid images (sizes capped). */
  body(uid, folderKey = '') {
    return this.exec((c) => this.onFolderOf(c, folderKey, () => this.bodyIn(c, uid, folderKey)));
  }

  async bodyIn(c, uid, folderKey) {
    {
      const m = this.find(uid, folderKey);
      if (!m) throw new Error('메일을 찾지 못했습니다(다른 곳에서 지워졌을 수 있습니다).');
      if (!m.structure) {
        const [row] = await c.fetch(String(uid), 'UID BODYSTRUCTURE');
        m.structure = row ? parseBodyStructure(row.BODYSTRUCTURE) : null;
      }
      const { html, text, images } = displayParts(m.structure);
      let truncated = false;
      const textParts = [...html, ...text].filter((p) => {
        if (p.size > MAX_TEXT_PART) truncated = true;
        return p.size <= MAX_TEXT_PART;
      });
      let budget = MAX_IMAGES;
      const imageParts = images.filter((p) => {
        if (p.size > budget) return false;
        budget -= p.size;
        return true;
      });
      const parts = [...textParts, ...imageParts];
      const out = { html: '', text: '', cid: {}, attachments: m.structure ? attachments(m.structure) : [], truncated, references: [] };
      const items = [...parts.map((p) => `BODY.PEEK[${sectionOf(p)}]`), 'BODY.PEEK[HEADER.FIELDS (REFERENCES)]'].join(' ');
      const [row] = await c.fetch(String(uid), `UID ${items}`, { timeoutMs: 180000 });
      if (!row) throw new Error('메일을 찾지 못했습니다(다른 곳에서 지워졌을 수 있습니다).');
      const raw = (p) => {
        const v = row[`BODY[${sectionOf(p)}]`];
        return Buffer.isBuffer(v) ? v : Buffer.from(str(v), 'latin1');
      };
      const refs = Object.entries(row).find(([k]) => k.startsWith('BODY[HEADER.FIELDS'))?.[1];
      if (refs) out.references = ((parseHeaders(Buffer.isBuffer(refs) ? refs : Buffer.from(str(refs))).get('references') || [''])[0].match(/<[^<>\s]+>/g) || []).slice(-20);
      out.html = html.filter((p) => textParts.includes(p)).map((p) => partText(p, raw(p))).join('\n<hr>\n');
      out.text = text.filter((p) => textParts.includes(p)).map((p) => partText(p, raw(p))).join('\n\n');
      for (const p of imageParts) {
        const bytes = decodeTransfer(raw(p), p.encoding);
        out.cid[p.id] = `data:${p.type}/${p.subtype};base64,${bytes.toString('base64')}`;
      }
      return out;
    }
  }

  /** A flag on the server (e.g. \Answered after a reply sent from the widget). */
  async setFlag(uid, flag, on = true, folderKey = '') {
    await this.exec((c) => this.onFolderOf(c, folderKey, () => c.store(String(uid), on, [flag])));
    const m = this.find(uid, folderKey);
    if (m && flag === '\\Answered') m.answered = on;
    if (m && flag === '\\Flagged') m.flagged = on;
    const fl = (folderKey ? this.folders.get(folderKey) : this)?.flaggedUids;
    if (fl && flag === '\\Flagged') {
      if (on) fl.add(uid);
      else fl.delete(uid);
      if (folderKey) this.folders.get(folderKey).flagged = fl.size;
      else this.flagged = fl.size;
    }
    this.emit('changed');
  }

  /**
   * The original attachments of a message for forwarding (#68): decoded bytes of each attachment part, as
   * long as they fit in maxBytes together; otherwise { parts: [], skipped: [...names] }.
   */
  attachmentsOf(uid, maxBytes, folderKey = '') {
    return this.exec((c) => this.onFolderOf(c, folderKey, () => this.attachmentsIn(c, uid, maxBytes, folderKey)));
  }

  async attachmentsIn(c, uid, maxBytes, folderKey) {
    {
      const m = this.find(uid, folderKey);
      if (!m?.structure) return { parts: [], skipped: [] };
      const leaves = leavesOf(m.structure).filter(isAttachment);
      const names = attachments(m.structure).map((a) => a.name);
      const total = leaves.reduce((n, p) => n + (p.encoding === 'base64' ? Math.floor((p.size * 3) / 4) : p.size), 0);
      if (!leaves.length) return { parts: [], skipped: [] };
      if (total > maxBytes) return { parts: [], skipped: names };
      const items = leaves.map((p) => `BODY.PEEK[${p.part}]`).join(' ');
      const [row] = await c.fetch(String(uid), `UID ${items}`, { timeoutMs: 300000 });
      if (!row) return { parts: [], skipped: names };
      const parts = leaves.map((p, i) => {
        const v = row[`BODY[${p.part}]`];
        const raw = Buffer.isBuffer(v) ? v : Buffer.from(str(v), 'latin1');
        const message = p.type === 'message' && p.subtype === 'rfc822';
        return { name: names[i], type: `${p.type}/${p.subtype}`, data: message ? raw : decodeTransfer(raw, p.encoding) };
      });
      return { parts, skipped: [] };
    }
  }

  /** \Seen on / off (optimistic: the list changes at once, reverted when the server refuses). */
  async setSeen(uid, seen, folderKey = '') {
    const m = this.find(uid, folderKey);
    if (!m) throw new Error('메일을 찾지 못했습니다.');
    if (m.unread === !seen) return;
    const f = folderKey ? this.folders.get(folderKey) : null;
    const set = (f || this).unseenUids;
    const bump = (d) => {
      if (f) f.unseen = Math.max(0, (f.unseen || 0) + d);
      else this.unread = Math.max(0, this.unread + d);
      if (set) {
        if (d > 0) set.add(uid);
        else set.delete(uid);
      }
    };
    m.unread = !seen;
    bump(seen ? -1 : 1);
    this.emit('changed');
    try {
      await this.exec((c) => this.onFolderOf(c, folderKey, () => c.store(String(uid), seen, ['\\Seen'])));
      // Our own change: the folder's STATUS signature follows, so the next check does not reopen it.
      if (f && f.sig) f.sig = f.sig.replace(/:\d+$/, `:${f.unseen}`);
      this.persist();
    } catch (err) {
      m.unread = seen;
      bump(seen ? 1 : -1);
      this.emit('changed');
      throw err;
    }
  }
}

module.exports = { AccountSync, headerOf, parseInternalDate, folderKeyOf, HEADER_ITEMS, IDLE_MS, NOTIFY_MAX_AGE, BACKOFF_S, FOLDER_POLL_MS, MARKED_STEP };
