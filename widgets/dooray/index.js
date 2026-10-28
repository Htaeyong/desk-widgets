// Dooray dashboard widget: polls Dooray, shows the dashboard through themes (THEME_SPEC.md),
// raises notification cards and owns the category manager and condition alert windows.
const path = require('path');
const { createDooraySettings, normalizeApiBase, normalizeDomain } = require('./settings');
const { DashboardService } = require('./backend/service');
const { createClient } = require('./backend/dooray');
const { describeApiError } = require('./backend/errors');
const { webUrlOf } = require('./backend/aggregate');
const categoriesModule = require('./backend/categories');
const rulesModule = require('./backend/rules');
const { CategoryStore, CategoryError } = categoriesModule;
const { RuleStore, RuleError } = rulesModule;
const { createCategoryMenu } = require('./card-menu');
const { todoDeadline, todoTargetOf, TARGETS } = require('./todo-integration');

const TEST_TYPES = ['mention', 'comment', 'assigned', 'created', 'status', 'closed', 'overdue'];

function create(ctx) {
  const mockData = Boolean(ctx.flags?.mockData);
  const store = createDooraySettings({
    dir: ctx.dataDir,
    createStore: ctx.createStore,
    // Development only: the repository's .env (the widget source sits in <repo>/widgets/dooray).
    envFile: ctx.app?.isPackaged ? null : path.join(ctx.dir, '..', '..', '.env'),
  });
  // Engine item stores (#108): this PC's files; with mock data nothing is offered for sync.
  const engineStore = (module, file) => (ctx.createStore ? ctx.createStore(module.storeOptions(file, { sync: !mockData })) : null);
  const rulesFile = path.join(ctx.dataDir, 'rules.json');
  const categoriesFile = path.join(ctx.dataDir, 'categories.json');
  const ruleStore = new RuleStore(rulesFile, { store: engineStore(rulesModule, rulesFile) });
  const categoryStore = new CategoryStore(categoriesFile, { store: engineStore(categoriesModule, categoriesFile) });
  const service = new DashboardService({
    getSettings: () => store.load(),
    isConfigured: () => store.isConfigured(),
    categories: categoryStore,
    rules: ruleStore,
    useMock: mockData,
  });
  const integrationText = (ko, en) => /^en\b/i.test(ctx.app?.locale?.() || '') ? en : ko;

  let running = false;
  let managerWindow = null;
  let rulesWindow = null;
  // Another PC's categories or rules arrived through the engine: refresh the open windows.
  categoryStore.onRemoteChange(() => managerWindow?.webContents.send('manager:snapshot', managerState()));
  ruleStore.onRemoteChange(() => rulesWindow?.webContents.send('rules:changed'));

  // #111: "할 일에 추가" makes a note in 할 일 노트 (todonote) when it can take it (engine API 1.7); otherwise it
  // goes to the to-do list widget as before. With both installed, the setting decides (todo-integration.js).
  const target = () => todoTargetOf(ctx.integrations, store.load().todoTarget);
  const integrationStatus = () => {
    const t = target();
    return { ...(ctx.integrations?.status(t.id) || { installed: false, brokerAvailable: false }), target: t.id, both: t.both };
  };
  const integrationDetails = () => ({ ...integrationStatus(), receiveConsent: Boolean(integrationStatus().peerEnabled) });
  const themeSnapshot = (snapshot = service.getSnapshot()) => {
    const peer = integrationStatus();
    return { ...snapshot, integrations: { todoEnabled: Boolean(store.load().todoIntegration && ctx.integrations?.call
      && peer?.running && peer?.peerEnabled && peer?.capabilities?.includes(TARGETS[peer.target].capability)) } };
  };

  async function addTaskToTodo(taskId) {
    if (!store.load().todoIntegration) return { ok: false, message: integrationText('설정에서 할 일 연동을 켜 주세요.', 'Enable Todo integration in settings.') };
    const task = service.findTask(String(taskId || ''));
    if (!task) return { ok: false, message: integrationText('업무를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.', 'Task not found. Refresh and try again.') };
    const peer = integrationStatus();
    const { method, missing } = TARGETS[peer.target];
    if (!peer.running || !peer.capabilities?.includes(method)) return { ok: false, message: integrationText(missing, 'Install and enable the widget that receives tasks.') };
    const source = { widgetId: 'dooray', itemId: task.id, url: task.url, label: task.projectName || 'Dooray' };
    if (peer.target === 'todo') return ctx.integrations.call('todo', method, { title: task.subject, ...todoDeadline(task), source });
    // A note gets the task's text (decision 2 of #110): fetched for this one click only.
    let body = null;
    try {
      body = await service.taskBody(task.id);
    } catch {
      // the note is made without the text; the link is in it
    }
    const dueDay = task.dueDate ? new Date(task.deadline || task.dueDate) : null;
    return ctx.integrations.call('todonote', method, {
      title: task.subject,
      ...todoDeadline(task),
      body: body?.content || '',
      bodyFormat: body?.html ? 'html' : 'markdown',
      details: [
        task.projectName ? `프로젝트 ${task.projectName}` : '',
        task.assignees?.length ? `담당 ${task.assignees.map((a) => a.name).join(', ')}` : '',
        dueDay && Number.isFinite(dueDay.getTime()) ? `마감 ${dueDay.getMonth() + 1}/${dueDay.getDate()}` : '',
      ].filter(Boolean),
      source,
    });
  }

  /** Opens a link only if it points at the user's own Dooray tenant. */
  async function openDoorayUrl(url) {
    const base = webUrlOf(store.load().doorayDomain || (mockData ? 'example.dooray.com' : ''));
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!base || parsed.origin !== new URL(base).origin) return false;
    if (mockData) return false;
    await ctx.openExternal(parsed.toString());
    return true;
  }

  // "분류" menu on the cards (engine API 1.1).
  const cardMenu = createCategoryMenu({ categories: categoryStore, service });

  // The engine's card knows no "comment-edit" label: show it as a comment whose author reads "<name> (수정)".
  const forCard = (e) =>
    e.type === 'comment-edit' ? { ...e, type: 'comment', comment: { ...e.comment, author: `${e.comment.author} (수정)`, count: 1 } } : e;

  // Cards follow this widget's notification settings; `force` (test buttons) skips them.
  function notify(events, { force = false } = {}) {
    const s = store.load();
    if (!force && !s.notifyEnabled) return;
    const wanted = (force ? events : events.filter((e) => (e.type === 'comment-edit' ? s.notifyTypes?.[e.type] === true : s.notifyTypes?.[e.type] !== false))).map(forCard);
    ctx.notify(wanted, { openUrl: openDoorayUrl, showWidget: () => host.focus(), menu: cardMenu });
  }

  /** Applies one category change. Returns { ok, result } or { ok: false, message } for user errors. */
  function runCategoryAction(action, payload = {}) {
    try {
      const result = service.updateCategories((cats) => {
        switch (action) {
          case 'create':
            return cats.create(payload);
          case 'update':
            return cats.update(String(payload.id), payload);
          case 'move':
            return cats.move(String(payload.id), Number(payload.delta));
          case 'remove':
            return cats.remove(String(payload.id));
          case 'setTaskCategories': {
            const task = service.findTask(String(payload.taskId));
            if (!task) throw new CategoryError('업무를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
            return cats.setTaskCategories(task, Array.isArray(payload.categoryIds) ? payload.categoryIds : []);
          }
          case 'removeClosed':
            return cats.removeClosed(payload.id ? String(payload.id) : null);
          default:
            throw new CategoryError(`Unknown action: ${action}`);
        }
      });
      return { ok: true, result: result ?? null };
    } catch (err) {
      if (err instanceof CategoryError) return { ok: false, message: err.message };
      throw err;
    }
  }

  // --- Category manager window (app-owned, works with every theme) ---

  function managerState() {
    const snap = service.getSnapshot();
    return { categories: snap.categories, webUrl: snap.dooray.webUrl };
  }

  function openCategoryManager(selectId) {
    if (!running) return false;
    const select = typeof selectId === 'string' && /^[\w-]{1,64}$/.test(selectId) ? selectId : '';
    if (managerWindow) {
      if (select) managerWindow.webContents.send('manager:select', select);
      managerWindow.show();
      managerWindow.focus();
      return true;
    }
    managerWindow = ctx.openAppWindow({
      html: path.join(ctx.dir, 'renderer', 'categories.html'),
      preload: path.join(ctx.dir, 'preload', 'categories.js'),
      query: { select },
      title: '분류 관리',
      width: 760,
      height: 580,
      minWidth: 560,
      minHeight: 400,
    });
    managerWindow.on('closed', () => {
      managerWindow = null;
    });
    return true;
  }

  // --- Condition alert (rule) manager window ---

  function openRulesWindow() {
    if (!running) return false;
    if (rulesWindow) {
      rulesWindow.show();
      rulesWindow.focus();
      return true;
    }
    rulesWindow = ctx.openAppWindow({
      html: path.join(ctx.dir, 'renderer', 'rules.html'),
      preload: path.join(ctx.dir, 'preload', 'rules.js'),
      title: '조건 알림',
      width: 820,
      height: 640,
      minWidth: 620,
      minHeight: 460,
    });
    rulesWindow.on('closed', () => {
      rulesWindow = null;
    });
    return true;
  }

  function registerIpc() {
    const managerHandler = (channel, fn) =>
      ctx.handle(channel, (event, ...args) => {
        if (!managerWindow || event.sender !== managerWindow.webContents) throw new Error('Not the category manager');
        return fn(...args);
      });
    managerHandler('manager:get', () => managerState());
    managerHandler('manager:action', (action, payload) => runCategoryAction(action, payload));
    managerHandler('manager:open-url', (url) => openDoorayUrl(String(url)));
    managerHandler('manager:confirm', async (message, detail) => {
      const response = await ctx.confirm(managerWindow, {
        type: 'warning',
        buttons: ['삭제', '취소'],
        defaultId: 1,
        cancelId: 1,
        title: '분류 관리',
        message: String(message),
        detail: detail ? String(detail) : undefined,
      });
      return response === 0;
    });

    const rulesHandler = (channel, fn) =>
      ctx.handle(channel, async (event, ...args) => {
        if (!rulesWindow || event.sender !== rulesWindow.webContents) throw new Error('Not the rule manager');
        try {
          return { ok: true, result: (await fn(...args)) ?? null };
        } catch (err) {
          if (err instanceof RuleError || !(err instanceof TypeError)) return { ok: false, message: err.message };
          throw err;
        }
      });
    rulesHandler('rules:get', async () => {
      if (!service.getProjects().length && store.isConfigured()) await service.refresh();
      return {
        rules: ruleStore.rules(),
        states: Object.fromEntries(ruleStore.rules().map((r) => [r.id, ruleStore.stateOf(r.id)])),
        projects: service.getProjects(),
      };
    });
    rulesHandler('rules:save', (rule) => ruleStore.save(rule));
    rulesHandler('rules:remove', (id) => ruleStore.remove(String(id)));
    // Evaluates one rule right away; shows the alert card too so the user sees what it looks like.
    rulesHandler('rules:run', async (id) => {
      const { state, events } = await service.runRuleNow(String(id));
      if (events.length) notify(events, { force: true });
      return state;
    });
  }

  // --- Theme API data calls (contract v1); the engine answers the window calls ---

  const host = ctx.useThemes({
    store,
    builtinDir: path.join(ctx.dir, 'themes'),
    userDir: path.join(ctx.dataDir, 'themes'),
    api: {
      getSnapshot: () => themeSnapshot(),
      // Manual refresh always re-reads everything instead of trusting change detection.
      refresh: async () => {
        await service.refresh({ force: true });
      },
      openUrl: (_entry, url) => openDoorayUrl(url),
      // Saves the user's project order and republishes; no Dooray request needed.
      setProjectOrder: (entry, ids) => {
        if (entry.preview || !Array.isArray(ids)) return false;
        store.save({ projectOrder: ids.map(String) });
        service.publish();
        return true;
      },
      // Inputs are validated by CategoryStore.
      categories: (entry, action, payload) =>
        entry.preview ? { ok: false, message: '미리보기에서는 분류를 바꿀 수 없습니다.' } : runCategoryAction(action, payload),
      openCategoryManager: (entry, categoryId) => !entry.preview && openCategoryManager(categoryId),
      addToTodo: (entry, taskId) => entry.preview ? { ok: false, message: integrationText('미리보기에서는 할 일에 추가할 수 없습니다.', 'Cannot add to Todo from a theme preview.') } : addTaskToTodo(taskId),
    },
  });

  service.on('events', (events) => notify(events));
  service.on('snapshot', (snapshot) => {
    host.broadcast('theme:snapshot', themeSnapshot(snapshot));
    managerWindow?.webContents.send('manager:snapshot', managerState());
    rulesWindow?.webContents.send('rules:changed');
  });

  // --- Settings section ---

  // Shows sample cards (one per type) using real tasks when available. Ignores type filters.
  function testNotification() {
    const snap = service.getSnapshot();
    const tasks = snap.projects.flatMap((p) => p.tasks.open);
    const sample = (i) =>
      tasks[i] || {
        id: `test-${i}`,
        key: 'TEST/1',
        subject: '알림 테스트 업무입니다',
        url: snap.dooray.webUrl,
        projectName: '테스트 프로젝트',
        workflowName: '진행 중',
        assignees: [],
        deadline: null,
      };
    const at = new Date().toISOString();
    notify(
      TEST_TYPES.map((type, i) => ({
        id: `test:${type}:${Date.now()}`,
        type,
        task: sample(i),
        url: sample(i).url,
        from: type === 'status' || type === 'closed' ? '접수' : null,
        comment:
          type === 'mention' || type === 'comment'
            ? { id: null, author: '홍길동', text: type === 'mention' ? '@나 확인 부탁드립니다' : '자료 공유드립니다', count: type === 'comment' ? 2 : 1 }
            : null,
        at,
      })),
      { force: true }
    );
  }

  async function saveSettings(values = {}) {
    const before = store.load();
    const patch = { ...values };
    if (!patch.apiToken) delete patch.apiToken;
    const next = { ...before, ...patch };
    // Mock runs need no connection.
    if (!mockData && (!normalizeDomain(next.doorayDomain) || !String(next.apiToken || '').trim())) {
      return { ok: false, message: '두레이 도메인과 API 토큰을 입력해 주세요.' };
    }
    // A new token is saved only encrypted (#97); nothing is saved then.
    const saved = store.saveChecked(patch);
    if (!saved.ok) return saved;
    const s = saved.settings;
    ctx.integrations?.setEnabled?.('todo', Boolean(s.todoIntegration));
    ctx.integrations?.setEnabled?.('todonote', Boolean(s.todoIntegration));
    if (!running) return { ok: true };

    const credentialsChanged = s.doorayDomain !== before.doorayDomain || s.apiBase !== before.apiBase || s.apiToken !== before.apiToken;
    const dataChanged =
      credentialsChanged ||
      s.pollIntervalSec !== before.pollIntervalSec ||
      s.dueSoonDays !== before.dueSoonDays ||
      s.hiddenProjectIds.join() !== before.hiddenProjectIds.join();

    host.windows.setOverviewPinned(s.alwaysOnTop);
    if (s.themeId !== before.themeId) host.windows.reloadAll();
    // Background opacity per theme (#55); engines before API 1.3 have no applyBackground.
    else if (JSON.stringify(s.themeOpacity) !== JSON.stringify(before.themeOpacity)) host.applyBackground?.();
    if (!dataChanged && s.projectOrder.join() !== before.projectOrder.join()) service.publish();
    if (s.todoIntegration !== before.todoIntegration || s.todoTarget !== before.todoTarget) service.publish();
    if (dataChanged) service.reconfigure({ credentialsChanged });
    return { ok: true };
  }

  const themeCalls = host.settingsHandlers();

  return {
    start() {
      running = true;
      ctx.integrations?.setEnabled?.('todo', Boolean(store.load().todoIntegration));
      ctx.integrations?.setEnabled?.('todonote', Boolean(store.load().todoIntegration));
      for (const peer of ['todo', 'todonote']) {
        ctx.integrations?.onStatus?.(peer, () => {
          ctx.sendToSettings?.('integration-status', integrationStatus());
          service.publish();
        });
      }
      registerIpc();
      host.open();
      service.start();
    },
    stop() {
      running = false;
      service.stop();
      host.close();
    },
    setPaused: (reason) => service.setPaused(reason),
    focus: () => host.focus(),
    desktopWindows: () => host.desktopWindows(),
    needsSetup: () => !store.isConfigured(),
    settings: {
      get: () => ({ ...store.toPublic(), mockData, todoStatus: integrationStatus() }),
      save: saveSettings,
      handlers: {
        test: async (values = {}) => {
          try {
            const client = createClient({
              apiBase: normalizeApiBase(values.apiBase),
              token: String(values.apiToken || '').trim() || store.load().apiToken,
            });
            const me = await client.getMyMember();
            return { ok: true, name: me?.result?.name || '알 수 없음' };
          } catch (err) {
            return { ok: false, message: describeApiError(err) };
          }
        },
        projects: async () => {
          if (!service.getProjects().length && (store.isConfigured() || mockData)) await service.refresh();
          return service.getProjects();
        },
        themes: themeCalls.themes,
        previewTheme: (themeId) => running && themeCalls.previewTheme(themeId),
        openThemeFolder: themeCalls.openThemeFolder,
        // Slider value shown on the theme while dragging (#55); a no-op on engines before API 1.3.
        liveOpacity: (themeId, value) => themeCalls.liveOpacity?.(themeId, value ?? null),
        openCategoryManager: () => openCategoryManager(),
        openRules: () => openRulesWindow(),
        testNotification: () => testNotification(),
        todoStatus: () => integrationDetails(),
        setTodoTarget: (value) => {
          store.save({ todoTarget: value === 'todo' ? 'todo' : 'todonote' });
          service.publish();
          return true;
        },
      },
    },
  };
}

module.exports = { create };
