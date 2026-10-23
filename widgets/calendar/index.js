// Calendar widget: a desktop month calendar with upcoming events from subscribed calendars.
// #49: ICS subscriptions (read-only), #47: CalDAV accounts, #48: creating, editing and deleting events on
// writable CalDAV calendars (lib/writer.js), #63: those writes in the background. Sources are pluggable
// (lib/sources.js). #61: the look is a theme package (themes/<id>/) on the engine's theme host; this code keeps
// the data, accounts, writes and their safety rules, and answers the calendar theme contract (THEME_METHODS).
const path = require('path');
const crypto = require('crypto');
const { DEFAULTS, PALETTE, sanitize, upgrade, sanitizeSource, newId } = require('./lib/settings');
const { MOCK_SOURCES, MOCK_PASSWORD, createMockFetch } = require('./lib/mock');
const { SourceManager, TYPES } = require('./lib/sources');
const { createSecrets } = require('./lib/secrets');
const { PROVIDERS, serverOf, providerList } = require('./lib/providers');
const { CalDavClient, checkServer } = require('./lib/caldav');
const { validateFields } = require('./lib/event-fields');
const { writeEvent, satisfied } = require('./lib/writer');
const { readOnlyReason } = require('./lib/editable');
const { applyOverlays, createQueue } = require('./lib/optimistic');
const { componentFields } = require('./lib/ical');
const { createLocalEvents, SOURCE_ID: LOCAL_ID, CALENDAR_ID: LOCAL_CALENDAR, COLOR: LOCAL_COLOR } = require('./lib/local-events');

// The main window's size when a theme does not give one (theme.json window.main does: 기본 300x460, 큰 달력 800x640).
const FRAMES = { main: { width: 300, height: 460, minWidth: 240, minHeight: 320 } };
const MAX_RANGES = 4;
const MAX_RANGE_MS = 400 * 86400000;
const DRAFT_TTL_MS = 30 * 60000;
const SECRET_UNAVAILABLE =
  '이 PC에서 암호화 저장(Windows 데이터 보호)을 쓸 수 없어 비밀번호를 저장할 수 없습니다. 비밀번호를 평문으로 저장하지 않으므로 CalDAV 계정을 추가할 수 없습니다.';

/** What a source fetches: when it changes, the source is read again right away. */
const fetchKey = (s) =>
  JSON.stringify(s.type === 'caldav' ? [s.server, s.username, (s.calendars || []).filter((c) => c.enabled).map((c) => c.id)] : [s.url]);

// deps.fetch and deps.crypto (a safeStorage stand-in) are seams for tests.
function create(ctx, deps = {}) {
  const store = ctx.createStore({ file: path.join(ctx.dataDir, 'settings.json'), defaults: DEFAULTS, sanitize, upgrade });
  const settings = () => sanitize(store.load());
  // --mock-data (#61): fictional calendars on an in-memory server instead of the user's sources (lib/mock.js).
  const mock = Boolean(ctx.flags?.mockData) && !deps.fetch;
  const fetch = deps.fetch || (mock ? createMockFetch() : undefined);
  /** The sources the widget shows: the user's, or the mock ones. */
  const sourcesOf = (s) => (mock ? MOCK_SOURCES : s.sources);
  const passwordOf = (id) => (mock ? MOCK_PASSWORD : secrets.get(id));
  let running = false;
  let paused = false;
  let refreshTimer = null;
  let notifyTimer = null;
  let todoTasks = [];
  let todoUnsubscribe = null;
  let todoStatusUnsubscribe = null;
  let todoRefreshTimer = null;
  let todoRevision = 0;
  const localEvents = createLocalEvents(ctx, () => changed());
  const localized = (ko, en) => String(ctx.app?.locale?.() || '').startsWith('en') ? en : ko;
  const localName = () => String(ctx.app?.locale?.() || '').startsWith('en') ? 'My Calendar' : '내 캘린더';
  const todoName = () => String(ctx.app?.locale?.() || '').startsWith('en') ? 'Task due' : '할 일 마감';

  const todoStatus = () => ctx.integrations?.status('todo') || { installed: false, enabled: false, running: false, capabilities: [] };
  const todoReady = () => {
    const st = todoStatus();
    return Boolean(settings().todoIntegration && st.running && st.peerEnabled && st.capabilities?.includes('calendar-share'));
  };
  async function refreshTodos() {
    const seq = ++todoRevision;
    if (!todoReady()) {
      todoTasks = [];
      changed();
      return;
    }
    const answer = await ctx.integrations.call('todo', 'tasks.snapshot', {});
    if (seq !== todoRevision) return;
    todoTasks = answer?.ok && Array.isArray(answer.result?.tasks) ? answer.result.tasks : [];
    changed();
  }
  const todoEvents = (from, to) => {
    if (!todoReady()) return [];
    return todoTasks.filter((task) => {
      if (!Number.isFinite(task.dueAt) || (task.completedAt && settings().completedTodos === 'hide')) return false;
      return task.dueAt >= from && task.dueAt < to;
    }).map((task) => {
      const allDay = Boolean(task.dateOnly);
      const start = allDay ? localKey(task.dueAt) : task.dueAt;
      return {
        sourceId: 'todo', calendarId: 'todo', uid: `todo:${task.id}`, taskId: task.id,
        sourceName: todoName(), title: task.title, color: task.completedAt ? '#8290a7' : '#f7ad52',
        allDay, start, end: allDay ? nextLocalKey(start) : task.dueAt,
        completed: Boolean(task.completedAt), readOnly: false, hasUrl: false,
      };
    });
  };

  // CalDAV passwords: encrypted (safeStorage) in their own file, never in settings.json, never logged.
  const secrets = createSecrets({ file: path.join(ctx.dataDir, 'secrets.json'), crypto: deps.crypto });
  // Passwords typed in the settings window for "연결 확인", kept in memory until saved (token -> draft).
  const drafts = new Map();
  // Writes run in the background (#63): overlays show them until the server has answered (id -> overlay, in
  // order), one queue per event keeps an edit and a delete of it in order. Writes the server's listing did not
  // confirm (uid -> { sourceId, calendarId, expect, message }) show as "반영 확인 안 됨" (#48).
  const overlays = new Map();
  const queue = createQueue();
  let writeSeq = 0;
  const unconfirmed = new Map();

  const manager = new SourceManager({
    dataDir: ctx.dataDir,
    fetch,
    onChange: () => changed(),
    getSecret: (id) => passwordOf(id),
    // The page moved to a range the CalDAV accounts do not hold yet.
    onWindow: (ids) => {
      if (running && !paused) manager.refresh(ids);
    },
  });

  /** The calendar contract's state (getState() and the "changed" event): what a theme needs besides the events. */
  const view = () => {
    const s = settings();
    const status = manager.status();
    return {
      weekStart: s.weekStart,
      upcomingDays: s.upcomingDays,
      locale: ctx.app?.locale?.() || 'ko-KR',
      sources: [
        ...(s.localEnabled ? [{ id: LOCAL_ID, name: localName(), color: LOCAL_COLOR, enabled: true }] : []),
        ...(s.todoIntegration && todoReady() ? [{ id: 'todo', name: todoName(), color: '#f7ad52', enabled: true }] : []),
        ...sourcesOf(s).map(({ id, name, color, enabled }) => ({ id, name, color, enabled })),
      ],
      lastUpdated: manager.lastUpdated(),
      errorCount: status.filter((x) => x.error).length,
      refreshing: manager.refreshing,
      calendars: writableCalendars(s),
      lastCalendar: s.lastCalendar,
      pending: [...new Set([...overlays.values()].map((o) => o.uid))],
      unconfirmed: Object.fromEntries([...unconfirmed].map(([uid, u]) => [uid, u.message])),
    };
  };

  /** Calendars an event can be created in: enabled CalDAV accounts' enabled calendars the server lets us write. */
  function writableCalendars(s) {
    const out = s.localEnabled ? [{ sourceId: LOCAL_ID, calendarId: LOCAL_CALENDAR, name: localName(), color: LOCAL_COLOR }] : [];
    for (const src of sourcesOf(s)) {
      if (!src.enabled || !TYPES[src.type]?.writable) continue;
      for (const cal of src.calendars || []) {
        if (cal.enabled && cal.canWrite !== false) out.push({ sourceId: src.id, calendarId: cal.id, name: `${cal.name} (${src.name})`, color: cal.color || src.color });
      }
    }
    return out;
  }

  /** Drops "반영 확인 안 됨" marks once the cache shows the intended state (a later refresh may confirm a write). */
  function reconcile() {
    for (const [uid, u] of unconfirmed) {
      if (satisfied(manager.components(u.sourceId, u.calendarId), uid, u.expect)) unconfirmed.delete(uid);
    }
  }

  /** Settings window values: the sources with their state, and the CalDAV providers. */
  const settingsView = () => {
    const s = settings();
    if (!running) manager.setSources(sourcesOf(s)); // a turned-off widget still shows its cached state
    return {
      weekStart: s.weekStart,
      // For the engine's theme section (#59): the picker reads and saves these.
      themeId: s.themeId,
      themeOpacity: s.themeOpacity,
      mock,
      refreshMinutes: s.refreshMinutes,
      upcomingDays: s.upcomingDays,
      alwaysOnTop: s.alwaysOnTop,
      localEnabled: s.localEnabled,
      todoIntegration: s.todoIntegration,
      completedTodos: s.completedTodos,
      todoStatus: todoStatus(),
      locale: ctx.app?.locale?.() || 'ko-KR',
      sources: s.sources,
      types: Object.fromEntries(Object.entries(TYPES).map(([id, t]) => [id, t.label])),
      providers: providerList(),
      palette: PALETTE,
      secretAvailable: secrets.available(),
      status: manager.status(),
    };
  };

  /** Tells the page and an open settings window that data or status changed (coalesced). */
  function changed() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      reconcile();
      if (running) host.emit('changed', view());
      ctx.sendToSettings?.('status', manager.status());
    }, 150);
  }

  function schedule() {
    clearInterval(refreshTimer);
    refreshTimer = null;
    if (!running || paused) return;
    refreshTimer = setInterval(() => manager.refresh(), settings().refreshMinutes * 60000);
  }

  function refreshNow(ids) {
    if (!running) return Promise.resolve();
    schedule(); // the next automatic refresh counts from now
    return manager.refresh(ids);
  }

  function apply(input, forceIds = []) {
    const values = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const prev = settings();
    const before = sourcesOf(prev);
    store.save(values);
    const s = settings();
    if (s.todoIntegration !== prev.todoIntegration) ctx.integrations?.setEnabled?.('todo', s.todoIntegration);
    if (s.todoIntegration !== prev.todoIntegration || s.completedTodos !== prev.completedTodos) refreshTodos();
    manager.setSources(sourcesOf(s));
    if (running) {
      // The theme host owns the windows: always on top, the theme (new windows) and its background opacity.
      if (s.alwaysOnTop !== prev.alwaysOnTop) host.setPinned(s.alwaysOnTop);
      if (s.themeId !== prev.themeId) host.reload();
      else if (JSON.stringify(s.themeOpacity) !== JSON.stringify(prev.themeOpacity)) host.applyBackground();
    }
    // The right-click menu can change these while the settings window is open.
    ctx.sendToSettings?.('display', { weekStart: s.weekStart, alwaysOnTop: s.alwaysOnTop });
    changed();
    if (!running) return;
    // New, changed, re-enabled or re-connected sources are fetched right away.
    const fresh = sourcesOf(s).filter((src) => {
      const old = before.find((b) => b.id === src.id);
      return src.enabled && (!old || fetchKey(old) !== fetchKey(src) || !old.enabled || forceIds.includes(src.id));
    });
    if (fresh.length && !paused) manager.refresh(fresh.map((src) => src.id));
    if (values.refreshMinutes !== undefined) schedule();
  }

  /**
   * "연결 확인" in the settings window: discovery with the typed password, or the saved one of an existing
   * account with the same login. A new password stays in this process as a draft (token) until the settings
   * are saved, and is only sent to the account's own server.
   */
  async function discover(input = {}) {
    try {
      const provider = PROVIDERS[input.provider];
      if (!provider) return { ok: false, message: '캘린더 서비스를 고르세요.' };
      const username = String(input.username || '').trim();
      if (!username) return { ok: false, message: `${provider.userLabel}를 넣으세요.` };
      const server = serverOf(input.provider, input.server, checkServer);
      if (server.error) return { ok: false, message: server.error };
      const typed = String(input.password || '');
      let password = typed;
      if (!password) {
        const saved = settings().sources.find((x) => x.id === input.accountId && x.type === 'caldav');
        if (saved && saved.username === username && saved.server === server.url) password = secrets.get(saved.id);
      }
      if (!password) return { ok: false, message: `${provider.passwordLabel}를 넣으세요.` };
      if (typed && !secrets.available()) return { ok: false, message: SECRET_UNAVAILABLE };
      const client = new CalDavClient({ username, password, fetch, authHint: provider.authHint });
      const found = await client.discover(server.url);
      let token = null;
      if (typed) {
        const now = Date.now();
        for (const [k, d] of drafts) if (now - d.at > DRAFT_TTL_MS) drafts.delete(k);
        token = crypto.randomBytes(12).toString('hex');
        drafts.set(token, { server: server.url, username, password: typed, at: now });
      }
      return {
        ok: true,
        token,
        server: server.url,
        calendars: found.map((c, i) => ({ id: c.url, name: c.name, color: c.color || PALETTE[i % PALETTE.length], canWrite: c.canWrite })),
      };
    } catch (err) {
      return { ok: false, message: String(err?.message || err), code: err?.code || null };
    }
  }

  /** settings.save: checks every source, stores new CalDAV passwords (encrypted only), then applies. */
  function saveSettings(values) {
    const before = settings().sources;
    const list = (Array.isArray(values.sources) ? values.sources : before).map((src) => ({ ...src }));
    const bad = list.findIndex((src, i) => !sanitizeSource(src, i));
    if (bad >= 0) {
      const nth = list.slice(0, bad + 1).filter((x) => (x?.type === 'caldav') === (list[bad]?.type === 'caldav')).length;
      return {
        ok: false,
        message:
          list[bad]?.type === 'caldav'
            ? `${nth}번째 계정의 정보(서비스·아이디·서버 주소)가 올바르지 않습니다.`
            : `${nth}번째 구독의 주소가 올바르지 않습니다. http(s):// 또는 webcal:// 주소를 넣으세요.`,
      };
    }
    // Every CalDAV account needs a password: a fresh "연결 확인" (draft) or the saved one of the same login.
    const toStore = [];
    for (const [i, src] of list.entries()) {
      const draft = src.draft ? drafts.get(src.draft) : null;
      delete src.draft;
      if (src.type !== 'caldav') continue;
      const clean = sanitizeSource(src, i);
      const old = before.find((b) => b.id === src.id && b.type === 'caldav');
      if (!old) src.id = newId();
      if (draft) {
        if (draft.username !== clean.username || draft.server !== clean.server) {
          return { ok: false, message: `${clean.name}: 연결 확인 뒤에 아이디나 서버가 바뀌었습니다. 연결 확인을 다시 누르세요.` };
        }
        toStore.push({ id: src.id, password: draft.password });
      } else if (!old || old.username !== clean.username || old.server !== clean.server || !secrets.has(old.id)) {
        return { ok: false, message: `${clean.name}: 비밀번호를 넣고 연결 확인을 눌러 주세요.` };
      }
      if (!clean.calendars.length) return { ok: false, message: `${clean.name}: 연결 확인으로 캘린더를 찾은 뒤 저장하세요.` };
    }
    if (toStore.length && !secrets.available()) return { ok: false, message: SECRET_UNAVAILABLE };
    try {
      for (const { id, password } of toStore) secrets.set(id, password);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    for (const { id } of toStore) manager.forget(id);
    apply(
      {
        sources: list,
        weekStart: values.weekStart,
        refreshMinutes: values.refreshMinutes,
        upcomingDays: values.upcomingDays,
        alwaysOnTop: values.alwaysOnTop,
        localEnabled: values.localEnabled,
        todoIntegration: values.todoIntegration,
        completedTodos: values.completedTodos,
        // From the engine's theme section (#59).
        themeId: typeof values.themeId === 'string' && values.themeId ? values.themeId : undefined,
        themeOpacity: values.themeOpacity && typeof values.themeOpacity === 'object' ? values.themeOpacity : undefined,
      },
      toStore.map((x) => x.id),
    );
    // Removed accounts lose their password (their cache went with setSources).
    secrets.prune(settings().sources.filter((x) => x.type === 'caldav').map((x) => x.id));
    return { ok: true };
  }

  const NOT_CONFIRMED = '저장 요청은 서버가 받았지만, 다시 읽었을 때 바뀐 내용이 보이지 않습니다(반영 확인 안 됨). 원래 캘린더 앱에서 확인하세요. 위젯은 서버에 있는 내용을 그대로 보여 줍니다.';

  /** The account, calendar and (for edits) the event's read-only reason; throws a Korean Error when not writable. */
  function writeTarget(sourceId, calendarId, uid) {
    const source = sourcesOf(settings()).find((x) => x.id === sourceId);
    if (!source || !source.enabled || !TYPES[source.type]?.writable) throw new Error('이 캘린더에는 일정을 쓸 수 없습니다(구독 캘린더는 읽기 전용).');
    const calendar = (source.calendars || []).find((c) => c.id === calendarId);
    if (!calendar || !calendar.enabled) throw new Error('캘린더를 찾지 못했습니다. 설정에서 캘린더가 켜져 있는지 확인하세요.');
    if (calendar.canWrite === false) throw new Error('쓰기 권한이 없는 캘린더입니다.');
    if (uid) {
      const reason = readOnlyReason({ writable: true, source, calendar, components: manager.components(sourceId, calendarId), uid });
      if (reason) throw new Error(reason);
    }
    return { source, calendar };
  }

  /** Runs one write: the conditional write and its verification, then a fresh read of that account. */
  async function runWrite({ op, sourceId, calendarId, uid, fields }) {
    let target;
    try {
      target = writeTarget(sourceId, calendarId, op === 'create' ? null : uid);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    try {
      const res = await writeEvent({
        op,
        source: target.source,
        calendarId,
        uid,
        fields,
        components: manager.components(sourceId, calendarId),
        password: passwordOf(sourceId),
        fetch,
      });
      if (res.applied) unconfirmed.delete(res.uid);
      else unconfirmed.set(res.uid, { sourceId, calendarId, expect: op === 'delete' ? null : res.expect, message: NOT_CONFIRMED });
      if (op === 'create') store.save({ lastCalendar: { sourceId, calendarId } });
      return { ok: true, applied: res.applied, uid: res.uid, message: res.applied ? null : NOT_CONFIRMED };
    } catch (err) {
      return { ok: false, conflict: err?.code === 'conflict' || err?.code === 'gone', message: String(err?.message || err) };
    } finally {
      manager.invalidateCalendar(sourceId, calendarId);
      if (running) await manager.refreshAfterWrite(sourceId);
      changed();
    }
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const localKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const nextLocalKey = (key) => {
    const [year, month, day] = key.split('-').map(Number);
    const next = new Date(year, month - 1, day + 1);
    return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())}`;
  };
  const dayOf = (f) => (f ? (f.allDay ? f.start : localKey(f.start)) : null);

  /**
   * 저장 / 삭제 from the widget (#63): checks what can be checked at once, shows the change right away
   * (overlay) and runs the write in the background. Resolves { ok: true, queued: true } or { ok: false, message }.
   */
  function startWrite(job) {
    let target;
    try {
      target = writeTarget(job.sourceId, job.calendarId, job.op === 'create' ? null : job.uid);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    const id = ++writeSeq;
    const master = job.uid ? manager.components(job.sourceId, job.calendarId).find((c) => c.uid === job.uid && !c.recurrenceId) : null;
    const before = master ? componentFields(master) : null;
    const title = job.fields?.title || before?.title || job.title || '일정';
    const overlay = {
      id,
      op: job.op,
      sourceId: job.sourceId,
      calendarId: job.calendarId,
      uid: job.uid || `pending:${id}`,
      fields: job.fields || null,
      color: target.calendar.color || target.source.color,
      sourceName: `${target.source.name} · ${target.calendar.name}`,
      title,
    };
    const info = { ...job, title, day: dayOf(job.fields) || dayOf(before) };
    overlays.set(id, overlay);
    changed();
    const key = job.uid ? JSON.stringify([job.sourceId, job.calendarId, job.uid]) : `create:${id}`;
    queue.run(key, async () => {
      // Turned off before it started: dropped (nothing was sent).
      if (!running) return overlays.delete(id);
      const res = await runWrite(job);
      overlays.delete(id);
      changed();
      if (running) report({ ...info, uid: res.uid || job.uid }, res);
      return res;
    });
    return { ok: true, queued: true };
  }

  /** No card on success; a sticky card (one per event) when the write failed or was not confirmed. */
  function report(info, res) {
    if (res.ok && res.applied) return;
    const quoted = `"${String(info.title).slice(0, 80)}"`;
    let card;
    if (res.ok) {
      card = {
        title: '반영 확인 안 됨',
        body: `${quoted} — 서버가 요청을 받았지만 다시 읽었을 때 바뀐 내용이 보이지 않습니다. 원래 캘린더 앱에서 확인하세요.`,
        icon: 'calendar',
        actions: [{ id: 'open', label: '열기' }],
      };
    } else {
      const conflict = Boolean(res.conflict);
      card = {
        title: info.op === 'delete' ? '일정 삭제 실패' : '일정 저장 실패',
        body: `${quoted} — ${res.message}`,
        icon: 'warning',
        // A conflict is never retried blindly: an edit reopens with the server's version, a delete shows it first.
        actions: [
          { id: conflict ? (info.op === 'edit' ? 'reopen' : 'open') : 'retry', label: '다시 시도' },
          ...(conflict && info.op !== 'edit' ? [] : [{ id: 'open', label: '열기' }]),
        ],
      };
    }
    if (card.body.length > 300) card.body = `${card.body.slice(0, 299)}…`; // the engine's card limit (widget-dev.md)
    ctx.notify?.([{ type: 'card', sticky: true, tag: `calendar-write:${info.sourceId}:${info.calendarId}:${info.uid || info.title}`, ...card }], {
      onAction: (_event, actionId) => {
        if (!running) return undefined;
        if (actionId === 'retry') {
          const again = startWrite({ op: info.op, sourceId: info.sourceId, calendarId: info.calendarId, uid: info.op === 'create' ? null : info.uid, fields: info.fields, title: info.title });
          if (!again.ok) throw new Error(again.message);
        } else if (actionId === 'reopen') {
          showInWidget('open-editor', info);
        } else if (actionId === 'open') {
          showInWidget('reveal', info);
        }
        return undefined;
      },
    });
  }

  /** Brings the widget forward and asks the theme to show the event (detail, or the editor with the server's version). */
  function showInWidget(event, info) {
    if (!running) return;
    host.focus();
    host.emit(event, { sourceId: info.sourceId, calendarId: info.calendarId, uid: info.uid, day: info.day });
  }

  // ---- the calendar theme contract v1 (#61, docs/theme-guide.md) ----

  const str = (v, max = 2000) => (typeof v === 'string' && v.length <= max ? v : '');
  /** { sourceId, calendarId, uid? } from a theme; anything else is dropped. */
  const targetOf = (t) => ({ sourceId: str(t?.sourceId, 64), calendarId: str(t?.calendarId), uid: str(t?.uid, 1000) || null });

  /** A normalized event as a theme sees it: no URL (only hasUrl), so a theme cannot hand one back to be opened. */
  function forTheme(e) {
    const { url, ...rest } = e;
    return { ...rest, hasUrl: Boolean(url) };
  }

  /** events.list([{ from, to }, ...]): events of each range (at most 4); CalDAV accounts widen their window to them. */
  function listEvents(ranges) {
    const list = Array.isArray(ranges) ? ranges.slice(0, MAX_RANGES) : [];
    const clean = list.map((r) => {
      const from = Number(r?.from);
      const to = Number(r?.to);
      return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to: Math.min(to, from + MAX_RANGE_MS) } : null;
    });
    manager.ensureWindow(clean.filter(Boolean));
    const pending = [...overlays.values()];
    return clean.map((r) => {
      if (!r) return [];
      const external = applyOverlays(manager.events(r.from, r.to), pending, r.from, r.to).map(forTheme);
      const local = settings().localEnabled ? localEvents.list(r.from, r.to, ctx.app?.locale?.()) : [];
      return [...external, ...local, ...todoEvents(r.from, r.to)];
    });
  }

  /** The cached event of a target (series master), for titles and links. */
  const cachedOf = (t) => t.sourceId === LOCAL_ID ? localEvents.find(t.uid) : (t.uid ? manager.components(t.sourceId, t.calendarId).find((c) => c.uid === t.uid && !c.recurrenceId) : null);

  /** events.remove: the widget's own confirm dialog (a theme cannot skip it), then the background delete (#63). */
  async function removeEvent(t) {
    if (t.sourceId === 'todo') return { ok: false, message: localized('할 일은 할 일 위젯에서 삭제하세요.', 'Delete this task in the Todo widget.') };
    if (!t.uid) return { ok: false, message: '지울 일정을 찾지 못했습니다.' };
    const title = String(cachedOf(t)?.title || '일정').slice(0, 100);
    const isLocal = t.sourceId === LOCAL_ID;
    const answer = await ctx.confirm(host.desktopWindows()[0] || null, {
      type: 'warning',
      title: isLocal ? localized('로컬 일정 삭제', 'Delete local event') : '일정 삭제',
      message: isLocal ? localized(`"${title}" 일정을 삭제할까요?`, `Delete "${title}"?`) : `"${title}" 일정을 삭제할까요?`,
      detail: isLocal ? localized('내 캘린더에서 삭제되며 되돌릴 수 없습니다.', 'This event will be removed from My Calendar and cannot be restored.') : '원래 캘린더(서버)에서도 삭제되며 되돌릴 수 없습니다.',
      buttons: isLocal ? [localized('삭제', 'Delete'), localized('취소', 'Cancel')] : ['삭제', '취소'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer !== 0) return { ok: false, cancelled: true };
    if (isLocal) return localEvents.write('delete', t.uid);
    return startWrite({ op: 'delete', ...t, title });
  }

  /** events.openLink: that event's own link, http(s) only; a theme names the event, never the address. */
  function openLink(t) {
    const event = cachedOf(t);
    let u;
    try {
      u = new URL(String(event?.url || ''));
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    ctx.openExternal(u.href);
    return true;
  }

  function saveFromTheme(t, input, op) {
    if (t.sourceId === 'todo') return { ok: false, message: localized('할 일의 목표 날짜 편집을 사용하세요.', 'Use the task due date editor.') };
    const checked = validateFields(input);
    if (checked.error) return { ok: false, message: checked.error };
    if (op === 'edit' && !t.uid) return { ok: false, message: '고칠 일정을 찾지 못했습니다.' };
    if (t.sourceId === LOCAL_ID) {
      if (!settings().localEnabled) return { ok: false, message: localized('내 캘린더가 꺼져 있습니다.', 'My Calendar is turned off.') };
      return localEvents.write(op, t.uid, checked.fields);
    }
    return startWrite({ op, sourceId: t.sourceId, calendarId: t.calendarId, uid: op === 'edit' ? t.uid : null, fields: checked.fields });
  }

  async function updateTodoDue(input) {
    if (!todoReady()) return { ok: false, message: localized('할 일 연동 조건을 확인하세요.', 'Check the Todo integration requirements.') };
    const taskId = str(input?.taskId, 128);
    const dueAt = Number(input?.dueAt);
    if (!taskId || !Number.isFinite(dueAt)) return { ok: false, message: localized('목표 날짜가 올바르지 않습니다.', 'Enter a valid due date.') };
    const answer = await ctx.integrations.call('todo', 'tasks.updateDue', { taskId, dueAt, dateOnly: input?.dateOnly === true });
    if (answer?.ok) await refreshTodos();
    return answer?.ok ? { ok: true } : { ok: false, message: answer?.message || localized('할 일 날짜를 저장하지 못했습니다.', 'Could not save the task due date.') };
  }

  // What a calendar theme may call (theme-host-design 5.3). Writes need a click or key press in the theme and
  // are refused in the theme preview; reading is allowed there.
  const THEME_METHODS = {
    getState: { run: () => view(), preview: 'allow' },
    'events.list': { run: (_entry, ranges) => listEvents(ranges), preview: 'allow' },
    // Asks every enabled source again (CalDAV checks each calendar's change tag, ICS sends its ETag) and answers
    // when that is done (#81), so a theme can show the button turning until then.
    refresh: {
      run: async () => {
        await refreshNow();
        return { ok: true, lastUpdated: manager.lastUpdated(), errorCount: manager.status().filter((x) => x.error).length };
      },
      preview: 'allow',
    },
    'events.create': { run: (_entry, t, fields) => saveFromTheme(targetOf(t), fields, 'create'), gesture: true },
    'events.update': { run: (_entry, t, fields) => saveFromTheme(targetOf(t), fields, 'edit'), gesture: true },
    'events.remove': { run: (_entry, t) => removeEvent(targetOf(t)), gesture: true },
    'events.openLink': { run: (_entry, t) => openLink(targetOf(t)), gesture: true },
    'tasks.updateDue': { run: (_entry, input) => updateTodoDue(input), gesture: true },
  };
  // changed: getState() again; reveal / open-editor: a notification card's 열기 / 다시 시도 (#63).
  const THEME_EVENTS = ['changed', 'reveal', 'open-editor'];

  /** The widget's items of the theme window's right-click menu (the engine adds settings / manager / off / quit). */
  function menuItems() {
    const s = settings();
    const themes = host.settingsHandlers().themes().filter((t) => t.usable);
    return [
      { label: '지금 새로고침', enabled: sourcesOf(s).some((x) => x.enabled), click: () => refreshNow() },
      { label: '항상 위에 표시', type: 'checkbox', checked: s.alwaysOnTop, click: (item) => apply({ alwaysOnTop: item.checked }) },
      {
        label: '테마',
        submenu: themes.map((t) => ({ label: t.name, type: 'radio', checked: t.id === s.themeId, click: () => apply({ themeId: t.id }) })),
      },
      {
        label: '한 주의 시작',
        submenu: [
          { label: '일요일', type: 'radio', checked: s.weekStart === 0, click: () => apply({ weekStart: 0 }) },
          { label: '월요일', type: 'radio', checked: s.weekStart === 1, click: () => apply({ weekStart: 1 }) },
        ],
      },
    ];
  }

  // The theme host (engine API 1.3): theme windows, Win+D, always on top, bounds per theme layout, background
  // opacity and the preview. Built-in themes in the package, the user's own in <dataDir>\themes (decision 3).
  const host = ctx.useThemes({
    store,
    builtinDir: path.join(ctx.dir, 'themes'),
    userDir: path.join(ctx.dataDir, 'themes'),
    // model.js (month grid, day placement, week bars) for every theme: <script src="model.js">.
    kitDir: path.join(ctx.dir, 'kit'),
    defaultTheme: 'default',
    contractVersions: [1],
    frames: FRAMES,
    methods: THEME_METHODS,
    events: THEME_EVENTS,
    menuItems,
  });

  return {
    start() {
      running = true;
      ctx.integrations?.setEnabled?.('todo', settings().todoIntegration);
      manager.setSources(sourcesOf(settings()));
      todoUnsubscribe = ctx.integrations?.onEvent('todo', 'tasks.changed', () => refreshTodos()) || null;
      todoStatusUnsubscribe = ctx.integrations?.onStatus('todo', () => refreshTodos()) || null;
      refreshTodos();
      todoRefreshTimer = setInterval(() => refreshTodos(), settings().refreshMinutes * 60000);
      host.open();
      if (!paused) manager.refresh();
      schedule();
    },
    stop() {
      // Writes already sent finish on their own (no card, no refresh); queued ones are dropped (#63).
      running = false;
      overlays.clear();
      clearInterval(refreshTimer);
      clearInterval(todoRefreshTimer);
      if (typeof todoUnsubscribe === 'function') todoUnsubscribe();
      if (typeof todoStatusUnsubscribe === 'function') todoStatusUnsubscribe();
      todoUnsubscribe = null;
      todoStatusUnsubscribe = null;
      todoRefreshTimer = null;
      clearTimeout(notifyTimer);
      manager.stop();
      refreshTimer = null;
      notifyTimer = null;
      host.close();
    },
    focus: () => host.focus(),
    desktopWindows: () => host.desktopWindows(),
    // Locked, asleep or away: no requests at all; back: refresh at once (same rule as Dooray, #6).
    setPaused(reason) {
      const next = Boolean(reason);
      if (next === paused) return;
      paused = next;
      if (paused) schedule();
      else refreshNow();
    },
    settings: {
      get: () => settingsView(),
      save(values = {}) {
        const result = saveSettings(values);
        if (result.ok) drafts.clear(); // a refused save keeps them so the user can fix and save again
        return result;
      },
      handlers: {
        // The engine's theme section (#59): themes / previewTheme / openThemeFolder / liveOpacity.
        ...host.settingsHandlers(),
        // "지금 새로고침" in the settings window refreshes the saved sources.
        refresh: async () => {
          await refreshNow();
          return manager.status();
        },
        status: () => manager.status(),
        todoPrerequisites: async () => ({ status: todoStatus(), access: await ctx.integrations?.call('todo', 'tasks.snapshot', {}) }),
        caldavDiscover: (input) => discover(input),
      },
    },
  };
}

module.exports = { create };
