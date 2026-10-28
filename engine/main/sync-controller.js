// Owns the local sync configuration and the manager's review-before-apply workflow. Widgets keep their data in
// this PC's stores; the sync folder is an exchange folder that only the engine reads and writes (#108).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createStore } = require('./store');
const { SyncManager, CLOUD_FOLDER } = require('./sync');

// How often the engine checks the sync folder (minutes); folder watching adds quicker checks where it works.
const INTERVALS = Object.freeze([1, 2, 5, 10, 30]);
const DEFAULT_INTERVAL = 2;
const DEFAULT_WIDGETS = Object.freeze({ engine: true, todo: true, calendar: true, clock: true, memo: true, todonote: true, dooray: false, mail: false });

function inside(base, target) {
  const from = path.resolve(base).toLowerCase();
  const to = path.resolve(target).toLowerCase();
  const relative = path.relative(from, to);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createSyncController({ userData, widgetList = () => [], locale = () => 'ko-KR', onChanged = () => {}, forbiddenDirs = () => [], secretGuard = () => false, extraWarnings = () => [] }) {
  const message = (ko, en) => /^en(?:-|$)/i.test(locale()) ? en : ko;
  const configStore = createStore({
    file: path.join(userData, 'sync', 'config.json'),
    defaults: { folder: '', deviceId: '', deviceName: os.hostname(), widgets: DEFAULT_WIDGETS, alwaysConfirm: false, intervalMinutes: DEFAULT_INTERVAL },
    sanitize: (value) => ({
      folder: typeof value.folder === 'string' ? value.folder : '',
      deviceId: /^d-[a-f0-9]{8,64}$/.test(value.deviceId) ? value.deviceId : '',
      deviceName: String(value.deviceName || os.hostname()).trim().slice(0, 80),
      widgets: Object.fromEntries(Object.entries(DEFAULT_WIDGETS).map(([id, enabled]) => [id, typeof value.widgets?.[id] === 'boolean' ? value.widgets[id] : enabled])),
      alwaysConfirm: Boolean(value.alwaysConfirm),
      intervalMinutes: INTERVALS.includes(Number(value.intervalMinutes)) ? Number(value.intervalMinutes) : DEFAULT_INTERVAL,
    }),
  });
  const config = () => configStore.load();
  const saved = config();
  let deviceId = saved.deviceId;
  if (!deviceId) {
    try {
      const previous = JSON.parse(fs.readFileSync(path.join(userData, 'sync', 'state.json'), 'utf8')).deviceId;
      if (/^d-[a-f0-9]{8,64}$/.test(previous)) deviceId = previous;
    } catch { /* A fresh installation has no sync state. */ }
  }
  if (!deviceId) deviceId = `d-${crypto.randomBytes(8).toString('hex')}`;
  let folder = saved.folder;
  if (folder && !fs.existsSync(path.join(folder, 'format.json'))) {
    const legacy = path.join(folder, CLOUD_FOLDER);
    try {
      if (JSON.parse(fs.readFileSync(path.join(legacy, 'format.json'), 'utf8')).format === 1) folder = legacy;
    } catch { /* The selected folder is already the data root. */ }
  }
  if (deviceId !== saved.deviceId || folder !== saved.folder) configStore.save({ deviceId, folder });
  const manager = new SyncManager({ localDir: path.join(userData, 'sync'), folder: config().folder || null, deviceId, deviceName: config().deviceName, secretGuard,
    log: (text) => console.error(`sync: ${text}`) });
  // Each adapter belongs to one widget (the engine's own settings adapter has none).
  const widgetOf = (name, adapter) => adapter?.widgetId || Object.keys(DEFAULT_WIDGETS).find((widget) => name === widget || name.startsWith(`${widget}-`));
  const selected = (name, widgets = config().widgets, adapter = manager.adapters.get(name)) => {
    const id = widgetOf(name, adapter);
    return Boolean(id && widgets[id]);
  };
  manager.isEnabled = (name, adapter) => selected(name, config().widgets, adapter);
  let pending = null;
  let checks = Promise.resolve(); // automatic checks, "sync now", connecting and applying choices, one at a time
  let timer = null;
  let watcher = null;
  let watchDelay = null;
  // What the sync tab shows about automatic checks: last and next check, and whether the folder is watched or
  // only polled (network shares and some cloud drives cannot be watched).
  const schedule = { lastCheck: null, nextCheck: null, watch: 'off', checking: false };
  const intervalMs = () => config().intervalMinutes * 60000;
  // A note folder change is reported for a day, not only until the next automatic check replaces the warnings.
  const relocations = new Map(); // source -> when
  manager.onChange((status) => {
    for (const warning of status.warnings || []) if (warning.code === 'store-relocated') relocations.set(warning.source, Date.now());
    onChanged(state());
  });
  const recentRelocations = () => [...relocations].filter(([, at]) => Date.now() - at < 24 * 3600000)
    .map(([source]) => ({ code: 'store-relocated', source }));

  function state() {
    const saved = config();
    const status = manager.status();
    const installed = widgetList();
    const available = (id) => [...manager.adapters.entries()].some(([name, adapter]) => widgetOf(name, adapter) === id);
    const widgets = [{ id: 'engine', name: 'Desk Widgets', enabled: saved.widgets.engine, available: available('engine') }, ...installed.map((item) => ({
      id: item.id, name: item.name, enabled: Boolean(saved.widgets[item.id]), available: available(item.id),
    }))];
    return {
      enabled: Boolean(saved.folder), folder: saved.folder, deviceName: saved.deviceName,
      lastSync: status.lastSync, status: status.conflicts?.length ? 'pending' : status.warnings?.length ? 'error' : saved.folder ? 'ready' : 'disabled',
      error: status.warnings?.find((warning) => warning.code === 'sync-error') ? message('동기화 폴더를 확인하지 못했습니다.', 'Could not check the sync folder.') : '',
      notices: noticesOf([...(status.warnings || []), ...recentRelocations(), ...extraWarnings()]),
      alwaysConfirm: saved.alwaysConfirm, widgets,
      intervalMinutes: saved.intervalMinutes, intervals: [...INTERVALS],
      schedule: { ...schedule, intervalMinutes: saved.intervalMinutes },
      ...(pending ? { pending: pendingView(pending) } : {}),
    };
  }

  // What the manager window shows besides the status line: short, without paths or values.
  function noticesOf(warnings) {
    const texts = warnings.map((warning) => {
      if (warning.code === 'store-relocated') return message(`${warning.source}: 노트 폴더가 바뀌어 처음 연결처럼 다시 맞췄습니다. 새 폴더에 없는 노트는 삭제로 보내지 않고 다른 PC에서 받아옵니다.`, `${warning.source}: the note folder changed, so it was matched again like a first connect; notes missing there are fetched, not deleted elsewhere.`);
      if (warning.code === 'source-error' && warning.reason === 'FOLDER_UNAVAILABLE') return message(`${warning.source}: 노트 폴더를 찾을 수 없어 이번에는 건너뛰었습니다(이동식 드라이브 등). 폴더가 돌아오면 다시 맞춥니다.`, `${warning.source}: the note folder is not available, so it was skipped this time (removable drive etc.).`);
      if (warning.code === 'secret-blocked') return message(`${warning.source}: 비밀 값이 들어 있어 내보내지 않았습니다.`, `${warning.source}: not exported because it contains a secret.`);
      if (warning.code === 'already-cloud-managed') return message(`${warning.source}: 노트 폴더가 이미 클라우드 폴더 안에 있어 그 프로그램이 옮깁니다.`, `${warning.source}: the note folder is already in a cloud folder; that program moves it.`);
      if (warning.code === 'remote-not-ready') return message('다른 PC의 데이터를 아직 받는 중입니다.', 'Still receiving data from another PC.');
      if (warning.code === 'legacy-migration') return message(`${warning.source}: 테스트 판 데이터를 되돌리지 못했습니다. 다음 시작 때 다시 시도합니다.`, `${warning.source}: could not bring back test-build data; retrying at the next start.`);
      return null;
    });
    return [...new Set(texts.filter(Boolean))];
  }

  function validateFolder(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error(message('동기화 폴더의 전체 경로를 골라 주세요.', 'Choose an absolute sync folder path.'));
    const target = path.resolve(folder);
    if (target === path.parse(target).root) {
      // A drive root (also a mapped network drive such as Y:\) would scatter sync files at the top level.
      const error = new Error(message(
        `드라이브 맨 위(${target})는 동기화 폴더로 고를 수 없습니다. 그 안에 폴더를 만들어 고르거나 "폴더 만들어 쓰기"를 누르세요("${CLOUD_FOLDER}" 폴더를 만들어 고릅니다).`,
        `A drive root (${target}) cannot be the sync folder. Choose a folder inside it, or press "Create folder" to create and use "${CLOUD_FOLDER}".`,
      ));
      error.code = 'drive-root';
      throw error;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(message('존재하는 동기화 폴더를 골라 주세요.', 'Choose an existing sync folder.'));
    if ([userData, ...forbiddenDirs()].some((dir) => dir && inside(dir, target))) throw new Error(message('설정·설치·노트 폴더 안에는 동기화 폴더를 만들 수 없습니다.', 'The sync folder cannot be inside the app, settings, or notes folder.'));
    return target;
  }

  function normalizeWidgets(values) {
    const result = { ...config().widgets };
    for (const id of Object.keys(DEFAULT_WIDGETS)) {
      if (typeof values?.[id] === 'boolean') result[id] = values[id];
    }
    // Business data starts off on each PC and cannot be enabled by remote data.
    return result;
  }

  // When a side was last edited: the item's own edit time when it has one, otherwise when its PC's engine first
  // saw that version (a record's updatedAt; on a first connect that is the connection time, not the edit time).
  function editedAt(side) {
    if (!side) return 0;
    const own = side.deleted ? null : side.value?.updatedAt ?? side.value?.modifiedAt ?? side.value?.editedAt;
    const time = typeof own === 'number' ? own : typeof own === 'string' ? Date.parse(own) : NaN;
    return Number.isFinite(time) ? time : Number(side.updatedAt) || 0;
  }

  function compareItem(item, kind) {
    const local = kind === 'import' ? null : item.local || item.record || null;
    const remote = kind === 'upload' ? null : item.remote || item.record || null;
    const value = local?.value || remote?.value;
    const title = value && typeof value === 'object' ? value.title || value.name || value.summary || item.key : item.key;
    const source = manager.adapters.get(item.source);
    const widgetId = widgetOf(item.source, source) || 'engine';
    const widget = widgetId === 'engine' ? 'Desk Widgets' : widgetList().find((w) => w.id === widgetId)?.name || widgetId;
    return {
      key: item.key, title: String(title), kind, group: widgetId, groupName: widget,
      local: local ? { value: local.deleted ? null : local.value, updatedAt: local.updatedAt, editedAt: editedAt(local) } : null,
      remote: remote ? { value: remote.deleted ? null : remote.value, updatedAt: remote.updatedAt, editedAt: editedAt(remote) } : null,
      // For "use the newest value everywhere": ties keep this PC's value.
      newer: editedAt(remote) > editedAt(local) ? 'remote' : 'local',
      canCopy: kind === 'conflict' && !item.key.includes('/@settings/') && typeof source?.copy === 'function',
    };
  }

  function pendingView(request) {
    const { plan } = request;
    return {
      previewId: request.id,
      requiresReconnect: Boolean(plan.requiresReconnect),
      reconnectReason: plan.reconnectReason || null,
      changes: [
        ...plan.imports.map((item) => compareItem(item, 'import')),
        ...plan.uploads.map((item) => compareItem(item, 'upload')),
        ...plan.conflicts.map((item) => compareItem(item, 'conflict')),
      ],
    };
  }

  function validateDecisions(request, choices = {}) {
    if (!request || !choices || typeof choices !== 'object') throw new Error(message('비교 항목이 만료됐습니다. 다시 확인해 주세요.', 'The review expired. Check again.'));
    for (const conflict of request.plan.conflicts) {
      const choice = choices[conflict.key];
      if (!['local', 'remote', 'both'].includes(choice)) throw new Error(message('충돌 항목마다 사용할 값을 골라 주세요.', 'Choose a value for each conflict.'));
      if (choice === 'both' && (!manager.adapters.get(conflict.source)?.copy || conflict.key.includes('/@settings/'))) throw new Error(message('이 항목은 둘 다 남길 수 없습니다.', 'This item cannot keep both values.'));
    }
    return Object.fromEntries(request.plan.conflicts.map((item) => [item.key, choices[item.key]]));
  }

  async function previewConnect(values = {}) {
    try {
      const folder = validateFolder(values.folder);
      const widgets = normalizeWidgets(values.widgets);
      // Preview only the selected adapters; restore the current selection afterward.
      manager.isEnabled = (name, adapter) => selected(name, widgets, adapter);
      let plan;
      try {
        plan = await manager.preview(folder);
        if (plan.cloudRoot !== folder) plan = await manager.preview(plan.cloudRoot);
      }
      finally { manager.isEnabled = (name, adapter) => selected(name, config().widgets, adapter); }
      if (plan.readOnly) throw new Error(message('이 폴더는 더 새 동기화 형식이라 현재 버전에서 쓸 수 없습니다.', 'This folder uses a newer sync format and is read-only here.'));
      pending = { id: crypto.randomUUID(), kind: 'connect', plan, values: { folder: plan.cloudRoot, deviceId, deviceName: String(values.deviceName || os.hostname()).slice(0, 80), widgets, alwaysConfirm: Boolean(values.alwaysConfirm),
        intervalMinutes: INTERVALS.includes(Number(values.intervalMinutes)) ? Number(values.intervalMinutes) : config().intervalMinutes } };
      onChanged(state());
      return { ok: true, pending: pendingView(pending) };
    } catch (error) { return { ok: false, message: error.message, ...(error.code === 'drive-root' ? { code: 'drive-root' } : {}) }; }
  }

  /** Creates CLOUD_FOLDER inside a chosen drive root and returns it as the folder to use. Roots only. */
  function createFolderInRoot(root) {
    try {
      if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error(message('동기화 폴더의 전체 경로를 골라 주세요.', 'Choose an absolute sync folder path.'));
      const base = path.resolve(root);
      if (base !== path.parse(base).root) throw new Error(message('드라이브 맨 위를 고른 경우에만 폴더를 만들어 쓸 수 있습니다.', 'Creating a folder is only offered for a drive root.'));
      if (!fs.existsSync(base)) throw new Error(message('드라이브를 찾을 수 없습니다. 연결 상태를 확인해 주세요.', 'The drive is not available. Check its connection.'));
      const target = path.join(base, CLOUD_FOLDER);
      fs.mkdirSync(target, { recursive: true });
      return { ok: true, folder: validateFolder(target) };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  // In the same queue as the automatic checks.
  function applyConnect(...args) {
    const run = checks.then(() => applyConnectNow(...args), () => applyConnectNow(...args));
    checks = run.catch(() => {});
    return run;
  }

  async function applyConnectNow({ previewId, resolutions, acknowledgeReconnect = false } = {}) {
    try {
      if (!pending || pending.kind !== 'connect' || pending.id !== previewId) throw new Error(message('연결 미리보기가 만료됐습니다. 다시 비교해 주세요.', 'Connection preview expired. Review again.'));
      const choices = validateDecisions(pending, resolutions);
      if (pending.plan.requiresReconnect && !acknowledgeReconnect) throw new Error(message('재연결 결과를 확인해 주세요.', 'Review and acknowledge the reconnection.'));
      const oldFolder = config().folder;
      const oldName = manager.deviceName;
      const restore = () => { manager.isEnabled = (name, adapter) => selected(name, config().widgets, adapter); };
      manager.connect(pending.values.folder);
      manager.deviceName = pending.values.deviceName;
      const chosenWidgets = pending.values.widgets;
      manager.isEnabled = (name, adapter) => selected(name, chosenWidgets, adapter);
      try { await manager.sync({ resolutions: choices, approveReconnect: acknowledgeReconnect }); }
      catch (error) { manager.connect(oldFolder || null); manager.deviceName = oldName; restore(); throw error; }
      configStore.save(pending.values);
      restore();
      pending = null;
      start();
      return { ok: true, state: state() };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  // The timer, the folder watcher and "지금 동기화" can ask at the same time: one check after another, so each
  // caller gets a result computed after its request.
  function syncNow() {
    const run = checks.then(checkNow, checkNow);
    checks = run.catch(() => {});
    return run;
  }

  async function checkNow() {
    try {
      if (!config().folder) throw new Error(message('먼저 동기화 폴더를 연결해 주세요.', 'Connect a sync folder first.'));
      if (pending?.kind === 'connect') return { ok: true, pending: pendingView(pending) };
      const plan = await manager.preview();
      // Nothing is applied before review when the user asked for that, or after a long break / folder change.
      if (plan.requiresReconnect || (config().alwaysConfirm && (plan.imports.length || plan.conflicts.length))) {
        if (!pending) pending = { id: crypto.randomUUID(), kind: 'sync', plan };
        return { ok: true, pending: pendingView(pending) };
      }
      // Otherwise only the conflicting items wait for the comparison screen; everything else (other items,
      // notes, other widgets) keeps moving, also while the user has not answered yet (design 5.3, field test).
      await manager.sync();
      // A connection review the user opened meanwhile is theirs; a check never replaces or clears it.
      if (pending?.kind === 'connect') return { ok: true, pending: pendingView(pending) };
      const held = manager.status().conflicts || [];
      if (!held.length) {
        pending = null;
        return { ok: true, state: state() };
      }
      const sameKeys = (a, b) => a.length === b.length && a.every((c) => b.some((d) => d.key === c.key));
      if (!pending || !sameKeys(pending.plan.conflicts, held)) pending = { id: crypto.randomUUID(), kind: 'sync', plan: await manager.preview() };
      return { ok: true, pending: pendingView(pending) };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  // In the same queue as the automatic checks.
  function resolve(...args) {
    const run = checks.then(() => resolveNow(...args), () => resolveNow(...args));
    checks = run.catch(() => {});
    return run;
  }

  async function resolveNow({ previewId, resolutions, acknowledgeReconnect = false } = {}) {
    try {
      if (!pending || pending.kind !== 'sync' || pending.id !== previewId) throw new Error(message('비교 결과가 만료됐습니다. 다시 확인해 주세요.', 'Review expired. Check again.'));
      const choices = validateDecisions(pending, resolutions);
      if (pending.plan.requiresReconnect && !acknowledgeReconnect) throw new Error(message('재연결 결과를 확인해 주세요.', 'Review and acknowledge the reconnection.'));
      await manager.sync({ resolutions: choices, approveReconnect: acknowledgeReconnect });
      pending = null;
      return { ok: true, state: state() };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  async function configure(values = {}) {
    try {
      if (!config().folder) throw new Error(message('먼저 동기화 폴더를 연결해 주세요.', 'Connect a sync folder first.'));
      const before = config();
      const widgets = normalizeWidgets(values.widgets);
      if (Object.keys(widgets).some((id) => widgets[id] && !before.widgets[id])) {
        return previewConnect({ folder: before.folder, deviceName: values.deviceName || before.deviceName, widgets, alwaysConfirm: values.alwaysConfirm, intervalMinutes: values.intervalMinutes });
      }
      configStore.save({ deviceName: String(values.deviceName || before.deviceName).slice(0, 80), widgets, alwaysConfirm: Boolean(values.alwaysConfirm),
        ...(values.intervalMinutes !== undefined ? { intervalMinutes: values.intervalMinutes } : {}) });
      // A new interval applies to the running timer at once.
      if (timer && config().intervalMinutes !== before.intervalMinutes) start();
      manager.deviceName = config().deviceName;
      pending = null;
      onChanged(state());
      scheduleLocalSync();
      return { ok: true, state: state() };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  async function disable() {
    try {
      // Widget data never left this PC, so turning sync off only stops the exchange.
      stop();
      manager.connect(null);
      configStore.save({ folder: '' });
      pending = null;
      return { ok: true, state: state() };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  function start() {
    stop();
    if (!config().folder) return;
    manager.connect(config().folder);
    const poll = () => {
      schedule.lastCheck = Date.now();
      schedule.nextCheck = schedule.lastCheck + intervalMs();
      schedule.checking = true;
      onChanged(state());
      return syncNow().catch(() => {}).finally(() => {
        schedule.checking = false;
        onChanged(state());
      });
    };
    timer = setInterval(poll, intervalMs());
    timer.unref?.();
    poll().then(() => {
      if (!timer || watcher) return;
      try {
        // A folder no PC has written to yet has no state folder; watch it from the start anyway.
        fs.mkdirSync(path.join(config().folder, 'state'), { recursive: true });
        watcher = fs.watch(path.join(config().folder, 'state'), { recursive: true }, (_kind, name) => {
          const parts = String(name || '').split(/[\\/]/);
          if (!name || parts[0] === manager.deviceId) return;
          if (watchDelay) clearTimeout(watchDelay);
          watchDelay = setTimeout(poll, 1500);
          watchDelay.unref?.();
        });
        // Network shares (SMB) and some cloud drives report watch errors (e.g. UNKNOWN) later;
        // an unhandled 'error' would crash the main process. Polling keeps working without it.
        const failed = watcher;
        schedule.watch = 'watching';
        watcher.on('error', () => {
          try { failed.close(); } catch { /* already closed */ }
          if (watcher === failed) watcher = null;
          schedule.watch = 'polling';
          onChanged(state());
        });
      } catch {
        schedule.watch = 'polling'; // Polling remains available when cloud folder watching is unsupported.
      }
      onChanged(state());
    });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    watcher?.close();
    watcher = null;
    if (watchDelay) clearTimeout(watchDelay);
    watchDelay = null;
    schedule.nextCheck = null;
    schedule.watch = 'off';
    manager.stop();
  }

  async function listUndo() {
    try {
      const items = await manager.listUndo();
      return { ok: true, items: items.map(({ id, key, source, createdAt, expiresAt }) => ({ id, key, source, createdAt, expiresAt })) };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  async function undo({ id } = {}) {
    try {
      if (!config().folder) throw new Error(message('먼저 동기화 폴더를 연결해 주세요.', 'Connect a sync folder first.'));
      if (pending) throw new Error(message('먼저 동기화 비교 항목을 처리해 주세요.', 'Resolve the pending sync review first.'));
      await manager.undo(id);
      scheduleLocalSync();
      return { ok: true, state: state() };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  function scheduleLocalSync() {
    if (!config().folder || pending) return;
    if (scheduleLocalSync.timer) clearTimeout(scheduleLocalSync.timer);
    scheduleLocalSync.timer = setTimeout(() => { scheduleLocalSync.timer = null; syncNow().catch(() => {}); }, 10000);
    scheduleLocalSync.timer.unref?.();
  }

  return { manager, state, previewConnect, createFolderInRoot, applyConnect, syncNow, resolve, configure, disable, start, stop, validateFolder, scheduleLocalSync, listUndo, undo, folder: () => config().folder || null };
}

module.exports = { createSyncController, DEFAULT_WIDGETS, INTERVALS, inside };
