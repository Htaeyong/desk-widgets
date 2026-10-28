// Local-first todo widget. The engine owns windows, theme isolation, and reminder cards.
const path = require('path');
const crypto = require('crypto');
const M = require('./lib/model');
const I18n = require('./kit/i18n');

const FRAMES = { main: { width: 360, height: 480, minWidth: 290, minHeight: 260 } };
const REMINDERS = { checkMs: 30_000, lateMs: 12 * 60 * 60 * 1000 };
const id = () => crypto.randomUUID();

function create(ctx) {
  const locale = ctx.app?.locale?.() || 'ko-KR';
  const labels = I18n.messages[I18n.language(locale)];
  const store = ctx.createStore({
    file: path.join(ctx.dataDir, 'settings.json'), defaults: M.DEFAULTS, sanitize: M.sanitize,
    sync: {
      name: 'todo',
      collections: {
        lists: { id: 'id' },
        tasks: {
          id: 'id',
          // Reminder delivery and snoozing are local to the device that displayed them.
          local: ['remindedFor', 'snoozedUntil'],
        },
      },
      shared: ['themeId', 'themeOpacity', 'snoozeMinutes'],
      describe: (kind, value, language) => [{ label: /^en\b/i.test(language) ? 'Title' : '제목', text: value?.title || value?.name || '' }],
      copy: (value) => ({ ...value, id: id() }),
    },
  });
  let running = false;
  let timer = null;
  let host = null;
  const data = () => M.sanitize(store.load());
  function integrationStatus(peerId, capability) {
    const broker = ctx.integrations;
    const peer = broker?.status?.(peerId);
    let reason = 'integrationReady';
    if (!broker?.expose || !broker?.call || !peer?.brokerAvailable) reason = 'integrationEngine';
    else if (!peer.installed) reason = 'integrationMissing';
    else if (!peer.enabled || !peer.running) reason = 'integrationOff';
    else if (!peer.capabilities?.includes(capability)) reason = 'integrationIncompatible';
    else if (!peer.peerEnabled) reason = 'integrationPeerSetting';
    return { reason, ready: reason === 'integrationReady', engineVersion: peer?.engineVersion || '',
      engineApi: peer?.engineApi || '', widgetVersion: peer?.version || '',
      brokerAvailable: Boolean(broker?.expose && broker?.call && peer?.brokerAvailable),
      installed: Boolean(peer?.installed), enabled: Boolean(peer?.enabled), running: Boolean(peer?.running),
      compatible: Boolean(peer?.capabilities?.includes(capability)), peerEnabled: Boolean(peer?.peerEnabled) };
  }
  const view = () => {
    const s = data();
    return { lists: s.lists.map((list) => ({ ...list, name: list.name || labels.defaultList })),
      tasks: s.tasks, selectedListId: s.selectedListId, snoozeMinutes: s.snoozeMinutes,
      alwaysOnTop: s.alwaysOnTop, themeId: s.themeId, themeOpacity: s.themeOpacity, locale, labels,
      receiveDooray: s.receiveDooray, receiveMail: s.receiveMail, shareCalendar: s.shareCalendar,
      integrationStatus: { dooray: integrationStatus('dooray', 'todo-add-source'),
        mail: integrationStatus('mail', 'todo-add-source'), calendar: integrationStatus('calendar', 'todo-calendar-view') } };
  };
  const publish = () => {
    if (running) host?.emit('state', view());
    ctx.sendToSettings?.('settings-changed', view());
  };
  function save(result) {
    if (!result.ok) return result;
    store.save(result.state);
    publish();
    schedule();
    ctx.integrations?.publish?.('tasks.changed', {});
    return { ok: true, result: { ...view(), ...(result.task ? { task: result.task } : {}),
      ...(result.existing !== undefined ? { existing: result.existing } : {}) } };
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!running) return;
    const now = Date.now();
    const next = data().tasks.filter((task) => !task.completedAt && !task.dateOnly && task.dueAt)
      .map((task) => Math.max(task.dueAt, task.snoozedUntil || 0))
      .filter((at) => at > now).sort((a, b) => a - b)[0];
    const wait = next ? Math.min(REMINDERS.checkMs, next - now) : REMINDERS.checkMs;
    timer = setTimeout(() => { checkReminders(); schedule(); }, Math.max(20, wait));
    timer.unref?.();
  }

  function checkReminders(now = Date.now()) {
    if (!running || !ctx.notify) return;
    const due = data().tasks.filter((task) => {
      const at = Math.max(task.dueAt || 0, task.snoozedUntil || 0);
      return !task.completedAt && !task.dateOnly && at && at <= now && at > now - REMINDERS.lateMs && task.remindedFor !== at;
    });
    for (const task of due) {
      const current = data();
      const at = Math.max(task.dueAt, task.snoozedUntil || 0);
      // Mark before sending, so a second tick or restart cannot duplicate a card.
      store.save({ tasks: current.tasks.map((item) => item.id === task.id ? { ...item, remindedFor: at, snoozedUntil: null } : item) });
      ctx.notify([{ type: 'card', title: labels.reminderTitle, body: task.title, icon: 'check', sticky: true, sound: true,
        tag: `todo-${task.id}`, actions: [{ id: 'snooze', label: I18n.t(locale, 'snooze', { minutes: current.snoozeMinutes }) },
          { id: 'done', label: labels.done }] }], {
        onAction: (_event, actionId) => {
          if (!running) return;
          if (actionId === 'done') save(M.toggleTask(data(), task.id, Date.now(), locale));
          if (actionId === 'snooze') {
            const s = data();
            store.save({ tasks: s.tasks.map((item) => item.id === task.id ? { ...item,
              snoozedUntil: Date.now() + s.snoozeMinutes * 60_000, remindedFor: null } : item) });
            publish();
            schedule();
          }
        },
      });
    }
    if (due.length) publish();
  }

  function changeSettings(values = {}) {
    const before = data();
    const patch = {};
    if (values.alwaysOnTop !== undefined) patch.alwaysOnTop = Boolean(values.alwaysOnTop);
    if (values.snoozeMinutes !== undefined) patch.snoozeMinutes = values.snoozeMinutes;
    for (const name of ['receiveDooray', 'receiveMail', 'shareCalendar']) {
      if (values[name] !== undefined) patch[name] = Boolean(values[name]);
    }
    if (typeof values.themeId === 'string') patch.themeId = values.themeId;
    if (values.themeOpacity && typeof values.themeOpacity === 'object') patch.themeOpacity = values.themeOpacity;
    store.save(patch);
    const after = data();
    if (running) {
      ctx.integrations?.setEnabled?.('dooray', after.receiveDooray);
      ctx.integrations?.setEnabled?.('mail', after.receiveMail);
      ctx.integrations?.setEnabled?.('calendar', after.shareCalendar);
    }
    if (running) {
      if (after.alwaysOnTop !== before.alwaysOnTop) host.setPinned(after.alwaysOnTop);
      if (after.themeId !== before.themeId) host.reload();
      if (JSON.stringify(after.themeOpacity) !== JSON.stringify(before.themeOpacity)) host.applyBackground();
    }
    publish();
    if (after.shareCalendar !== before.shareCalendar) ctx.integrations?.publish?.('tasks.changed', {});
    return { ok: true };
  }

  function addExternal(input, meta) {
    const sourceId = meta?.sourceId;
    if (!['dooray', 'mail'].includes(sourceId) || input?.source?.widgetId !== sourceId) return { ok: false, message: labels.invalidSource };
    const s = data();
    if (!s[sourceId === 'dooray' ? 'receiveDooray' : 'receiveMail']) return { ok: false, message: labels.integrationDisabled };
    const result = M.addExternalTask(s, input, Date.now(), locale, id());
    if (result.existing) return { ok: true, result: { task: result.task, existing: true } };
    const saved = save(result);
    return saved.ok ? { ok: true, result: { task: result.task, existing: false } } : saved;
  }

  function snapshot(_input, meta) {
    if (meta?.sourceId !== 'calendar') return { ok: false, message: labels.integrationDisabled };
    const s = data();
    if (!s.shareCalendar) return { ok: false, message: labels.integrationDisabled };
    return { ok: true, result: { tasks: s.tasks.filter((task) => task.dueAt).map((task) => ({
      id: task.id, title: task.title, dueAt: task.dueAt, dateOnly: task.dateOnly,
      completedAt: task.completedAt, source: task.source,
    })) } };
  }

  function updateDue(input, meta) {
    if (meta?.sourceId !== 'calendar' || !data().shareCalendar) return { ok: false, message: labels.integrationDisabled };
    const result = M.updateTaskDue(data(), input?.taskId, input?.dueAt, input?.dateOnly, locale);
    if (!result.ok) return result;
    const saved = save(result);
    return saved.ok ? { ok: true, result: { task: result.task } } : saved;
  }

  const methods = {
    getState: { run: () => ({ ok: true, result: view() }), preview: 'allow' },
    'tasks.add': { run: (_entry, input) => save(M.addTask(data(), input, Date.now(), locale, id())), preview: 'noop', gesture: true },
    'tasks.toggle': { run: (_entry, taskId) => save(M.toggleTask(data(), taskId, Date.now(), locale)), preview: 'noop', gesture: true },
    'tasks.remove': { run: (_entry, taskId) => save(M.removeTask(data(), taskId, locale)), preview: 'noop', gesture: true },
    'tasks.reorder': { run: (_entry, taskId, beforeId) => save(M.reorderTask(data(), taskId, beforeId || null, locale)), preview: 'noop' },
    'lists.add': { run: (_entry, name) => save(M.addList(data(), name, locale, id())), preview: 'noop', gesture: true },
    'lists.rename': { run: (_entry, listId, name) => save(M.renameList(data(), listId, name, locale)), preview: 'noop', gesture: true },
    'lists.remove': { run: (_entry, listId) => save(M.removeList(data(), listId, locale)), preview: 'noop', gesture: true },
    'lists.select': { run: (_entry, listId) => save(M.selectList(data(), listId, locale)), preview: 'noop' },
  };

  host = ctx.useThemes({ store, builtinDir: path.join(ctx.dir, 'themes'), userDir: path.join(ctx.dataDir, 'themes'),
    kitDir: path.join(ctx.dir, 'kit'), defaultTheme: 'default', contractVersions: [1], frames: FRAMES,
    methods, events: ['state'],
    menuItems: () => [{ label: labels.alwaysOnTop, type: 'checkbox', checked: data().alwaysOnTop,
      click: (item) => changeSettings({ alwaysOnTop: item.checked }) }],
  });

  store.onRemoteChange?.(() => {
    if (running) host.reload();
    publish();
    schedule();
  });

  return {
    start() {
      running = true;
      const s = data();
      ctx.integrations?.setEnabled?.('dooray', s.receiveDooray);
      ctx.integrations?.setEnabled?.('mail', s.receiveMail);
      ctx.integrations?.setEnabled?.('calendar', s.shareCalendar);
      ctx.integrations?.expose?.('tasks.addExternal', addExternal);
      ctx.integrations?.expose?.('tasks.snapshot', snapshot);
      ctx.integrations?.expose?.('tasks.updateDue', updateDue);
      for (const peer of ['dooray', 'mail', 'calendar']) {
        ctx.integrations?.onStatus?.(peer, () => ctx.sendToSettings?.('integration-status', view().integrationStatus));
      }
      host.open(); checkReminders(); schedule();
    },
    stop() { running = false; clearTimeout(timer); timer = null; host.close(); },
    focus: () => host.focus(),
    desktopWindows: () => host.desktopWindows(),
    settings: { get: view, save: (values) => { const result = changeSettings(values); host.setLiveOpacity?.(null, null); return result; },
      handlers: host.settingsHandlers() },
  };
}

module.exports = { create, FRAMES, REMINDERS };
