// AI chat widget (#129, docs/ai-chat-design.md): sends a task to the Claude Code installed on this PC with the user's own
// API key. Off by default and quiet: it opens only from the tray, and without consent and a key it starts no process at all.
// The key stays in this file's process: the windows get only whether there is one and its last 4 characters.
const fs = require('fs');
const path = require('path');
const S = require('./lib/settings');
const { CONSENT, CONSENT_VERSION, consentGiven } = require('./lib/consent');
const { KEY_ID, keyProblem, checkConnection } = require('./lib/key');
const { createClaudeRunner } = require('./lib/claude-runner');
const { createSessionStore } = require('./lib/sessions');
const { createChatController } = require('./lib/chat-controller');
const { createBudget } = require('./lib/budget');
const { createRecipeStore } = require('./lib/recipes');
const { scanSecrets } = require('./lib/recipe-safety');
const { createMemoryStore } = require('./lib/memory');
const { createAttachmentStore } = require('./lib/attachments');

const CHANNEL = 'ai-chat-widget';

// Pages the screens may open, by id; the windows never pass a URL.
const LINKS = {
  aup: 'https://www.anthropic.com/legal/aup',
  install: 'https://code.claude.com/docs/en/overview',
  keys: 'https://platform.claude.com/settings/keys',
  workspaces: 'https://platform.claude.com/settings/workspaces',
  billing: 'https://platform.claude.com/settings/billing',
};

/**
 * On start nothing runs yet, so any run file there is from a run the app did not see end (crash, taskkill): its MCP config holds
 * a dead token and its instructions the user's memories. Both go; nothing else in that folder is touched.
 */
function clearRunFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^(?:mcp-[0-9a-f]{16}\.json|note-[0-9a-f]{16}\.md)$/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * @param {object} ctx  the engine's widget context
 * @param {object} [deps]  for tests: { resolve, env, exe, fetchImpl, documents, confirmQuitDialog, pickFolderDialog, inspect, widgetTools, mcpDir, appPath, bridgeExe, now, undoMs, thumbnail, pickFilesDialog }
 */
function create(ctx, deps = {}) {
  const E = () => require('electron');
  const store = ctx.createStore({ file: path.join(ctx.dataDir, 'settings.json'), defaults: S.DEFAULTS, sanitize: S.sanitize });
  const documents = () => deps.documents || E().app.getPath('documents');
  const defaultDir = () => S.defaultWorkDir(documents());
  const workDir = () => store.load().workDir || defaultDir();
  let secretBox = null;
  const secrets = () => (secretBox ||= ctx.secrets.open('secrets'));
  const runner = createClaudeRunner({
    configDir: path.join(ctx.dataDir, 'claude-config', 'check'),
    binDir: path.join(ctx.dir, 'bin'),
    ...(deps.exe ? { exe: deps.exe } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  if (deps.inspect) runner.inspect = deps.inspect;
  let win = null;
  let quitAsking = false;
  let quitDecided = false;

  function send(name, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(`${CHANNEL}:event`, name, payload);
  }

  /**
   * The widget tools (calendar, mail, notes ...) come through the engine's existing MCP bridge, which works only while the user has
   * "AI 도우미 연결 (MCP)" on: the engine writes endpoint.json then, and tools.json with the tools the user lets out. Off is the
   * engine's default, and a run without the bridge has no widget tools at all, so the state is told, never silently dropped.
   * { state: 'on' | 'empty' | 'off' | 'unavailable', tools: [exported names], server? }. Everything about writes, cards and
   * undo stays the engine's (design 13).
   */
  function widgetTools() {
    if (deps.widgetTools) return deps.widgetTools();
    const dir = deps.mcpDir || path.join(E().app.getPath('userData'), 'mcp');
    if (!fs.existsSync(path.join(dir, 'endpoint.json'))) return { state: 'off', tools: [] };
    const base = deps.appPath || E().app.getAppPath();
    const file = path.join(base.endsWith('.asar') ? `${base}.unpacked` : base, 'engine', 'mcp', 'bridge.js');
    if (!fs.existsSync(file)) return { state: 'unavailable', tools: [] };
    let tools = [];
    const titles = {};
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'tools.json'), 'utf8'));
      const listed = (Array.isArray(raw?.tools) ? raw.tools : []).filter((t) => typeof t?.name === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(t.name)).slice(0, 200);
      tools = listed.map((t) => t.name);
      // A tool's title is only words for the screen: one line, short.
      for (const t of listed) if (typeof t.title === 'string' && t.title.trim()) titles[t.name] = t.title.replace(/\s+/g, ' ').trim().slice(0, 40);
    } catch { /* no list yet: the bridge still answers */ }
    return { state: tools.length ? 'on' : 'empty', tools, titles, server: { command: deps.bridgeExe || process.execPath, args: [file, `--dir=${dir}`], env: { ELECTRON_RUN_AS_NODE: '1' } } };
  }

  const toolsView = () => {
    const t = widgetTools();
    return { state: t.state, count: t.tools.length, titles: t.titles || {} };
  };

  /** A card and no window to show it in: says only that one waits. The content is never in a notification, and neither are buttons that answer it. */
  function alertCard(session, view) {
    if (win && !win.isDestroyed() && win.isVisible?.() && !win.isMinimized?.()) return;
    ctx.notify?.(
      [{ type: 'card', title: view.kind === 'approval' ? 'AI Widgets: 승인이 필요합니다' : 'AI Widgets: 질문이 있습니다', body: session?.title || '', icon: 'warning', sticky: true, sound: true, tag: `ai-chat-card-${session?.id}`, actions: [{ id: 'open', label: '열기' }] }],
      { onAction: () => { openChat(); send('focusSession', session?.id); } },
    );
  }

  const sessions = createSessionStore({ dir: path.join(ctx.dataDir, 'sessions'), configRoot: path.join(ctx.dataDir, 'claude-config') });

  const budget = createBudget({ file: path.join(ctx.dataDir, 'budget.json'), settings: () => store.load(), ...(deps.now ? { now: deps.now } : {}) });

  const recipes = createRecipeStore({ dir: path.join(ctx.dataDir, 'recipes') });
  const memory = createMemoryStore({ file: path.join(ctx.dataDir, 'memory.json') });
  /** A small preview of an image for the composer, made here from the file itself: a data: URL the page may show. */
  function thumbnailOf({ path: file, data }) {
    try {
      const { nativeImage } = E();
      const image = file ? nativeImage.createFromPath(file) : nativeImage.createFromBuffer(data);
      if (image.isEmpty()) return null;
      return image.resize({ height: 72, quality: 'good' }).toDataURL();
    } catch {
      return null;
    }
  }
  const attachments = createAttachmentStore({ getKey: () => secrets().get(KEY_ID), thumbnail: deps.thumbnail || thumbnailOf });
  const UNDO_MS = deps.undoMs ?? 10000; // how long a deleted recipe can come back
  const trashTimers = new Map();

  function gate() {
    if (!consentGiven(store.load().consent)) return { code: 'consent', message: '먼저 안내를 확인해 주세요.' };
    if (!secrets().get(KEY_ID)) return { code: 'no-key', message: 'API 키를 먼저 넣어 주세요.' };
    if (!store.load().modelChosen) return { code: 'model', message: '먼저 모델을 골라 주세요.' };
    if (budget.view().level === 'over') return { code: 'budget', message: `이번 달 예산 $${store.load().monthlyBudgetUsd}에 닿아 새 작업을 시작하지 않습니다(추정). 설정에서 예산을 바꾸면 이어서 쓸 수 있습니다.` };
    return null;
  }

  const controller = createChatController({
    runner,
    sessions,
    getKey: () => secrets().get(KEY_ID),
    settings: () => store.load(),
    knowsFolder: (dir) => store.load().knownFolders.includes(S.folderKey(dir)),
    rememberFolder: (dir) => store.save({ knownFolders: [...store.load().knownFolders, S.folderKey(dir)] }),
    gate,
    emit: send,
    defaultDir,
    runsFile: path.join(ctx.dataDir, 'runs.json'),
    // The Dooray widget saves the originals it fetches in its own data folder, next to this one.
    mcp: { dir: path.join(ctx.dataDir, 'run'), hostScript: path.join(ctx.dir, 'host', 'ai-chat-host.js'), widgetTools, fetchedDir: deps.fetchedDir || path.join(path.dirname(ctx.dataDir), 'dooray', 'fetched') },
    alert: alertCard,
    budget,
    recipes,
    memory,
    attachments,
    attachNoticeSeen: () => store.load().attachNoticeSeen,
  });

  const clock = () => (deps.now ? deps.now() : Date.now());
  /** The notices put off until later than now: { kind: true }. */
  function snoozedNow() {
    const until = store.load().noticeSnooze || {};
    return Object.fromEntries(S.SNOOZABLE.filter((k) => until[k] > clock()).map((k) => [k, true]));
  }

  /** "이번 주 그만 보기": that one notice, for 7 days, on this PC only. */
  function snoozeNotice(kind) {
    if (!S.SNOOZABLE.includes(kind)) return false;
    store.save({ noticeSnooze: { ...store.load().noticeSnooze, [kind]: clock() + S.SNOOZE_MS } });
    return true;
  }

  /** "안내 다시 보기" in the settings: every put-off notice comes back. */
  function resetNotices() {
    store.save({ noticeSnooze: {} });
    send('noticesReset', null);
    send('changed', null);
    return { ok: true, message: '숨겨 둔 안내를 다시 보이게 했습니다.' };
  }

  function keyStatus() {
    const value = secrets().get(KEY_ID);
    return { has: Boolean(value), tail: value ? value.slice(-4) : '', encryption: secrets().available() };
  }

  function saveKey(raw) {
    const value = String(raw ?? '').trim();
    const problem = keyProblem(value);
    if (problem) return { ok: false, message: problem, status: keyStatus() };
    if (!secrets().available()) return { ok: false, code: 'secret-unavailable', message: '이 PC에서 암호화 저장(Windows 데이터 보호)을 쓸 수 없어 키를 저장하지 않았습니다. 평문으로는 저장하지 않습니다.', status: keyStatus() };
    try {
      secrets().set(KEY_ID, value);
    } catch (err) {
      return { ok: false, code: err.code || 'save-failed', message: '키를 저장하지 못했습니다. 평문으로는 저장하지 않습니다.', status: keyStatus() };
    }
    send('changed', null);
    return { ok: true, message: '저장했습니다.', status: keyStatus() };
  }

  function deleteKey() {
    secrets().delete(KEY_ID);
    send('changed', null);
    return { ok: true, message: '삭제했습니다. Console의 키는 그대로이니 필요하면 Console에서 폐기해 주세요.', status: keyStatus() };
  }

  async function testKey() {
    const value = secrets().get(KEY_ID);
    if (!value) return { ok: false, kind: 'no-key', message: '저장된 키가 없습니다.' };
    return checkConnection(value, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  }

  function openLink(id) {
    if (!Object.hasOwn(LINKS, id)) return false;
    ctx.openExternal(LINKS[id]);
    return true;
  }

  function settingsView() {
    const { model, workDir: stored, mode, keepDays, maxConcurrent, writeGuard, cardTimeoutMinutes, monthlyBudgetUsd, taskCapUsd, resetDay } = store.load();
    return { model, workDir: stored, mode, keepDays, maxConcurrent, writeGuard, cardTimeoutMinutes, monthlyBudgetUsd, taskCapUsd, resetDay, defaultWorkDir: defaultDir(), models: S.MODELS, modes: S.MODES };
  }

  function saveSettings(values = {}) {
    const dir = String(values.workDir ?? '').trim();
    if (dir && !path.isAbsolute(dir)) return { ok: false, message: '작업 폴더는 전체 경로로 적어 주세요.' };
    store.save({
      model: values.model, modelChosen: true, workDir: dir, mode: values.mode, keepDays: Number(values.keepDays), maxConcurrent: Number(values.maxConcurrent), writeGuard: values.writeGuard !== false, cardTimeoutMinutes: Number(values.cardTimeoutMinutes), monthlyBudgetUsd: values.monthlyBudgetUsd, taskCapUsd: values.taskCapUsd, resetDay: Number(values.resetDay),
    });
    controller.prune();
    send('changed', null);
    return { ok: true };
  }

  async function pickFolder() {
    if (deps.pickFolderDialog) return deps.pickFolderDialog();
    const res = await E().dialog.showOpenDialog({ title: '작업 폴더 고르기', defaultPath: workDir(), properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0] || null;
  }

  /** What the chat window shows. `claude --version` runs only with consent and a key. */
  async function state() {
    const s = store.load();
    const given = consentGiven(s.consent);
    const key = keyStatus();
    return {
      consent: given ? null : CONSENT,
      key: { has: key.has, tail: key.tail },
      needsModel: !s.modelChosen,
      models: S.MODELS,
      model: s.model,
      mode: s.mode,
      keepDays: s.keepDays,
      workDir: workDir(),
      configDirNote: path.join(ctx.dataDir, 'claude-config'),
      notices: controller.notices(),
      list: controller.list(),
      cards: controller.cards(),
      widgetTools: toolsView(),
      snoozed: snoozedNow(),
      layout: { sideWidth: s.sideWidth, sideCollapsed: s.sideCollapsed, ...S.SIDE_WIDTH },
      budget: budget.view(),
      prerequisites: given && key.has ? await runner.check() : null,
    };
  }

  const calls = {
    state,
    acceptConsent() {
      store.save({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } });
      return true;
    },
    chooseModel(id) {
      if (!S.MODELS.some((m) => m.id === id)) return false;
      store.save({ model: id, modelChosen: true });
      return true;
    },
    list: () => controller.list(),
    open: (id) => controller.open(String(id)),
    send: (arg) => controller.send(arg),
    /** A file dropped or pasted: by its path when it has one, else its bytes (an image, or long text). */
    addAttachment(arg) {
      const res = typeof arg?.path === 'string' && arg.path ? attachments.addPath(arg.path) : attachments.addData({ name: arg?.name, data: arg?.data, text: arg?.text });
      return res.ok ? { ...res, needsNotice: !store.load().attachNoticeSeen } : res;
    },
    async pickAttachments() {
      let files = [];
      if (deps.pickFilesDialog) files = await deps.pickFilesDialog();
      else {
        const res = await E().dialog.showOpenDialog(win, { title: '첨부할 파일', properties: ['openFile', 'multiSelections'] });
        files = res.canceled ? [] : res.filePaths;
      }
      const added = [];
      for (const file of files) added.push(attachments.addPath(file));
      return { results: added, needsNotice: !store.load().attachNoticeSeen };
    },
    removeAttachment: (id) => attachments.remove(String(id)),
    snoozeNotice: (kind) => snoozeNotice(String(kind)),
    ackAttachNotice() {
      store.save({ attachNoticeSeen: true });
      return true;
    },
    stop: (id) => controller.stop(String(id), 'user'),
    cancelQueued: (id) => controller.cancelQueued(String(id)),
    remove: (id) => controller.remove(String(id)),
    clearRecord: (id) => controller.clearRecord(String(id)),
    setPinned: (arg) => controller.setPinned(String(arg?.id), arg?.pinned),
    confirmFolder: (dir) => controller.confirmFolder(dir),
    dismissNotices: () => controller.dismissNotices(),
    cardShown: (id) => controller.cardShown(String(id)),
    answerCard: (arg) => controller.answerCard(arg),
    feedback: (arg) => controller.feedback(arg?.sessionId, arg),
    requestSummary: (id) => controller.requestSummary(id),
    scanRecipe: (fields) => controller.scanFields(fields),
    saveRecipe: (arg) => controller.saveRecipe(arg),
    discardDraft: (id) => controller.discardDraft(id),
    excludeRecipe: (arg) => controller.excludeRecipe(arg?.sessionId, arg?.recipeId),
    recipes: () => recipes.list(),
    recipe(id) {
      const meta = recipes.get(String(id));
      const text = meta && recipes.read(meta.id);
      return text ? { ...meta, ...text, versions: recipes.versions(meta.id) } : null;
    },
    restoreRecipe: (arg) => Boolean(recipes.get(String(arg?.id)) && recipes.restore(String(arg.id), Number(arg.version))),
    /** Out of the list at once; gone for good after a short while unless undone. Every version goes with it. */
    removeRecipe(id) {
      const key = String(id);
      if (!recipes.trash(key)) return false;
      const timer = setTimeout(() => {
        trashTimers.delete(key);
        recipes.purge(key);
      }, UNDO_MS);
      timer.unref?.();
      trashTimers.set(key, timer);
      return { ok: true, undoMs: UNDO_MS };
    },
    undoRemoveRecipe(id) {
      const key = String(id);
      if (!trashTimers.has(key)) return false;
      clearTimeout(trashTimers.get(key));
      trashTimers.delete(key);
      return recipes.untrash(key);
    },
    renameRecipe: (arg) => controller.renameRecipe(arg),
    setRecipePinned: (arg) => Boolean(recipes.setPinned(String(arg?.id), arg?.pinned === true)),
    renameSession: (arg) => controller.renameSession(arg),
    /** The list's width and whether it is folded, kept for the next time the window opens. Checked like every other setting. */
    setLayout(arg) {
      const next = {};
      if (Number.isFinite(arg?.sideWidth)) next.sideWidth = arg.sideWidth;
      if (typeof arg?.sideCollapsed === 'boolean') next.sideCollapsed = arg.sideCollapsed;
      const saved = store.save(next) || store.load();
      return { sideWidth: saved.sideWidth, sideCollapsed: saved.sideCollapsed };
    },
    useManualMode() {
      store.save({ mode: 'default' });
      send('changed', null);
      return true;
    },
    pickFolder,
    openSettings: () => ctx.openSettings(),
    /** A web address from an answer, after the user saw it in full and clicked: http and https only, nothing else ever. */
    openUrl(arg) {
      if (arg?.trusted !== true || typeof arg.url !== 'string' || arg.url.length > 2048) return false;
      let url;
      try {
        url = new URL(arg.url);
      } catch {
        return false;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      ctx.openExternal(url.href);
      return true;
    },
    openManager: () => {
      ctx.openManager?.();
      return true;
    },
    widgetTools: toolsView,
    openLink,
  };

  function openChat() {
    if (win && !win.isDestroyed()) {
      ctx.beforeFocus?.(win);
      win.show();
      win.focus();
      return win;
    }
    win = ctx.openAppWindow({
      html: path.join(ctx.dir, 'chat', 'chat.html'),
      preload: path.join(ctx.dir, 'preload.js'),
      title: 'AI Widgets',
      width: 880,
      height: 660,
      minWidth: 620,
      minHeight: 460,
    });
    win.once('closed', () => {
      win = null;
      attachments.clear(); // a draft's attachments go with its window
    });
    return win;
  }

  return {
    start() {
      ctx.handle(CHANNEL, (event, name, arg) => {
        if (!win || event.sender !== win.webContents) throw new Error('Not the AI chat window');
        if (!Object.hasOwn(calls, name)) throw new Error(`Unknown call: ${String(name)}`);
        return calls[name](arg);
      });
      ctx.setTrayItems?.([{ id: 'open', label: 'AI Widgets', click: openChat }]);
      controller.prune();
      recipes.purge(); // deletions the last run could not finish: their undo time is long past
      clearRunFiles(path.join(ctx.dataDir, 'run'));
      // After a crash: reads only and tells the user; it is a no-op (no process) when nothing was running.
      this.leftovers = controller.checkLeftovers().then((found) => {
        if (found.length) ctx.notify?.([{ type: 'card', title: 'AI Widgets: 지난번 작업이 남아 있습니다', body: found[0].message, icon: 'warning', sticky: true, tag: 'ai-chat-leftover' }]);
      }).catch(() => {});
    },
    stop() {
      for (const [key, timer] of trashTimers) {
        clearTimeout(timer);
        recipes.purge(key);
      }
      trashTimers.clear();
      controller.stopAll();
      win = null;
    },
    /**
     * Asked by the engine when a person quits, before anything has stopped. It answers at once and never blocks the main process,
     * so a question left open cannot hold up anything else: with work in progress it keeps the app running, asks, and quits again
     * on yes. With nothing in progress it does not ask. The engine does not ask at all when it quits for its installer.
     */
    confirmQuit() {
      if (quitDecided || !controller.anyRunning()) return true;
      if (quitAsking) return false;
      quitAsking = true;
      const ask = deps.confirmQuitDialog || (() => E().dialog.showMessageBox({
        type: 'warning', title: 'AI Widgets', message: '작업이 진행 중입니다.', detail: '종료하면 작업을 중단합니다. 일부 변경은 이미 적용되었을 수 있습니다.', buttons: ['중단하고 종료', '취소'], defaultId: 1, cancelId: 1, noLink: true,
      }).then((res) => res.response === 0));
      Promise.resolve().then(ask).catch(() => false).then((yes) => {
        quitAsking = false;
        if (!yes) return;
        quitDecided = true;
        ctx.quit();
      });
      return false;
    },
    focus: () => Boolean(openChat()),
    desktopWindows: () => [],
    needsSetup: () => false, // quiet after install (design 8.1): the chat window leads to the settings
    settings: {
      get: settingsView,
      save: saveSettings,
      handlers: {
        keyStatus, saveKey, deleteKey, testKey, openLink, pickFolder, resetNotices,
        // The memory list: look, fix, switch off, delete. A fix is checked like a new one.
        memoryList: () => memory.list(),
        memoryUpdate(arg) {
          const text = String(arg?.text ?? '');
          const scan = [...scanSecrets(text, secrets().get(KEY_ID)), ...scanSecrets(arg?.title ?? '', secrets().get(KEY_ID))];
          if (scan.some((s) => s.hard)) return { ok: false, message: '이 위젯의 API 키가 들어 있어 저장할 수 없습니다.' };
          if (scan.length && arg?.allowFlags !== true) return { ok: false, code: 'secrets', message: `비밀처럼 보이는 값(${[...new Set(scan.map((s) => s.label))].join(', ')})이 있습니다. 지우거나 다시 눌러 그대로 저장하세요.` };
          const got = memory.update(String(arg?.id), { text, title: arg?.title });
          return got.error ? { ok: false, message: got.error.message } : { ok: true, memory: got.memory };
        },
        memorySetEnabled: (arg) => memory.setEnabled(String(arg?.id), arg?.enabled === true),
        memoryRemove: (id) => memory.remove(String(id)),
      },
    },
  };
}

module.exports = { create, CHANNEL, LINKS };
