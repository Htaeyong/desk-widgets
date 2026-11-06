// Clock widget: a desktop clock with stopwatch, timer and alarms. Since #60 its look comes from theme packages
// (themes/, clock theme contract v1) on the engine theme host; this file keeps the settings, the stopwatch / timer /
// alarm state, their scheduling and notifications, and offers the themes only the calls declared below.
const path = require('path');
const { DEFAULTS, sanitize, upgrade } = require('./clock-settings');
const TM = require('./kit/timer-model');
const AM = require('./kit/alarm-model');
const MT = require('./mcp-tools');

// Window sizes when a theme does not give them (theme.json window.main / window["main+tools"]).
const FRAMES = {
  main: { width: 220, height: 96, minWidth: 140, minHeight: 64, variants: { tools: { width: 260, height: 200, minWidth: 220, minHeight: 180 } } },
};

const ok = (result) => (result === undefined ? { ok: true } : { ok: true, result });
const fail = (message) => ({ ok: false, message });

function create(ctx) {
  const store = ctx.createStore({
    file: path.join(ctx.dataDir, 'settings.json'),
    defaults: DEFAULTS,
    sanitize,
    upgrade,
    sync: {
      name: 'clock',
      collections: { alarms: {
        id: 'id',
        // Snooze and the local activation time are specific to this PC's reminder scheduler.
        local: ['snoozeUntil', 'since'],
      } },
      shared: ['showSeconds', 'hour12', 'tools', 'timerSeconds', 'timerPresets', 'themeId', 'themeOpacity'],
      describe: (_kind, value, locale) => [{ label: /^en\b/i.test(locale) ? 'Alarm' : '알람', text: value?.name || '' }],
    },
  });
  let running = false;
  let timerEnd = null;
  let alarmTimeout = null;
  // Alarms are handled up to this time; kept in memory, saved when alarms ring or change and on stop (#51).
  let alarmCheckedAt = null;
  let host = null;

  /** What the themes get as "settings" (clock contract v1). */
  const settingsView = () => {
    const s = store.load();
    return {
      showSeconds: s.showSeconds,
      hour12: s.hour12,
      locale: ctx.app?.locale?.() || 'ko-KR',
      tools: Boolean(s.tools),
      lastTab: s.lastTab,
      alwaysOnTop: Boolean(s.alwaysOnTop),
    };
  };

  /** What the settings window gets (the engine's theme section reads themeId / themeOpacity). */
  const view = () => {
    const s = store.load();
    return { ...settingsView(), themeId: s.themeId, themeOpacity: s.themeOpacity || {} };
  };

  /**
   * Stores settings and applies them: always on top, theme, window size variant (stopwatch/timer tabs), background
   * opacity, the theme pages and an open settings window. Window changes only while the widget runs.
   */
  function change(values) {
    const before = store.load();
    store.save(values);
    const s = store.load();
    if (running && host) {
      if (s.alwaysOnTop !== before.alwaysOnTop) host.setPinned(s.alwaysOnTop);
      if (s.themeId !== before.themeId) host.reload();
      else if (Boolean(s.tools) !== Boolean(before.tools)) host.applyVariant();
      if (JSON.stringify(s.themeOpacity) !== JSON.stringify(before.themeOpacity)) host.applyBackground();
      host.emit('settings', settingsView());
    }
    ctx.sendToSettings?.('settings-changed', view());
  }

  // ---- stopwatch and timer (#45): state lives here, the pages only draw it ----
  const timersView = () => {
    const s = store.load();
    const now = Date.now();
    return {
      stopwatch: s.stopwatch,
      timer: s.timer,
      timerSeconds: s.timerSeconds,
      timerPresets: s.timerPresets,
      // next: when the alarm rings next (for the theme to show), null when it is off.
      alarms: alarms().map((a) => ({ ...a, next: AM.nextDue(a, now) })),
    };
  };

  function sendTimers() {
    if (running) host?.emit('timers', timersView());
  }

  function updateTimers(values) {
    store.save(values);
    scheduleTimerEnd();
    sendTimers();
  }

  /** One timeout for the running timer's end; it re-checks on wake so an early or late wake is harmless. */
  function scheduleTimerEnd() {
    clearTimeout(timerEnd);
    timerEnd = null;
    const t = store.load().timer;
    if (!running || !TM.tmRunning(t)) return;
    const left = TM.tmRemaining(t, Date.now());
    if (left <= 0) fireTimerEnd(t);
    else timerEnd = setTimeout(scheduleTimerEnd, Math.min(left, 0x7fffffff));
  }

  function fireTimerEnd(t) {
    store.save({ timer: TM.tmFinish(t) });
    sendTimers();
    const seconds = t.duration / 1000;
    ctx.notify?.(
      [
        {
          type: 'card',
          title: '타이머 종료',
          body: `${TM.formatDuration(seconds)} 타이머가 끝났습니다`,
          icon: 'timer',
          sticky: true,
          sound: true,
          tag: 'clock-timer',
          actions: [{ id: 'restart', label: '다시 시작' }],
        },
      ],
      {
        onAction: (_event, actionId) => {
          if (actionId === 'restart' && running) updateTimers({ timer: TM.tmStart(TM.tmReset(store.load().timer), Date.now(), seconds) });
        },
      },
    );
  }

  // ---- alarms (#51): rung from here like the timer, whether or not the tabs are shown ----
  const alarms = () => AM.sanitizeAlarms(store.load().alarms);

  /** One timeout to the next due alarm, at most a minute away so a wake from sleep or a changed clock is noticed. */
  function scheduleAlarms() {
    clearTimeout(alarmTimeout);
    alarmTimeout = null;
    if (!running) return;
    const now = Date.now();
    const next = AM.nextDueAll(alarms(), now);
    const wait = next ? Math.min(next.at - now, 60000) : 60000;
    alarmTimeout = setTimeout(checkAlarms, Math.max(0, wait) + 20);
    // Electron keeps running on its own; unref only lets plain Node (tests) exit.
    alarmTimeout.unref?.();
  }

  /** Rings what came due since the last check; older ones (engine off, sleep) go into one "놓친 알람" card. */
  function checkAlarms() {
    const now = Date.now();
    // A clock set back has nothing to catch up.
    const from = alarmCheckedAt !== null && alarmCheckedAt <= now ? alarmCheckedAt : now;
    const before = alarms();
    const result = AM.processDue(before, from, now);
    alarmCheckedAt = now;
    if (result.ring.length || result.missed.length || JSON.stringify(result.alarms) !== JSON.stringify(before)) {
      store.save({ alarms: result.alarms, alarmCheckedAt: now });
      sendTimers();
      for (const hit of result.ring) ringAlarm(hit);
      if (result.missed.length) notifyMissed(result.missed);
    }
    scheduleAlarms();
  }

  function updateAlarms(list) {
    store.save({ alarms: AM.sanitizeAlarms(list), alarmCheckedAt: alarmCheckedAt || Date.now() });
    sendTimers();
    scheduleAlarms();
  }

  function ringAlarm(hit) {
    ctx.notify?.(
      [
        {
          type: 'card',
          title: '알람',
          body: AM.ringText(hit),
          icon: 'alarm',
          sticky: true,
          sound: true,
          tag: `clock-alarm-${hit.id}`,
          actions: [
            { id: 'snooze', label: '5분 뒤 다시' },
            { id: 'off', label: '끄기' },
          ],
        },
      ],
      {
        onAction: (_event, actionId) => {
          if (!running) return;
          const at = Date.now();
          if (actionId === 'snooze') updateAlarms(alarms().map((a) => (a.id === hit.id ? AM.snooze(a, at) : a)));
          else if (actionId === 'off') updateAlarms(alarms().map((a) => (a.id === hit.id ? { ...a, snoozeUntil: null } : a)));
        },
      },
    );
  }

  function notifyMissed(hits) {
    ctx.notify?.([{ type: 'card', title: '놓친 알람', body: AM.missedText(hits), icon: 'alarm', sticky: true, tag: 'clock-alarm-missed' }]);
  }

  // Alarm tab calls (contract v1 alarms.*). Values are checked here: a theme can send anything.
  const fields = (v) => ({ hour: v?.hour, minute: v?.minute, name: v?.name, days: v?.days });
  const validAlarm = (a) => AM.sanitizeAlarm(a) !== null;
  const known = (id) => alarms().some((a) => a.id === id);

  function addAlarm(values) {
    const list = alarms();
    if (list.length >= AM.MAX_ALARMS) return fail(`알람은 ${AM.MAX_ALARMS}개까지 만들 수 있습니다.`);
    const now = Date.now();
    const alarm = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), ...fields(values), on: true, snoozeUntil: null, since: now };
    if (!validAlarm(alarm)) return fail('알람 시각이 올바르지 않습니다.');
    updateAlarms([...list, alarm]);
    return { ok: true, id: alarm.id };
  }

  function editAlarm(id, values) {
    if (!known(id)) return fail('없는 알람입니다.');
    const now = Date.now();
    const next = alarms().map((a) => (a.id === id ? { ...a, ...fields(values), on: true, snoozeUntil: null, since: now } : a));
    if (!validAlarm(next.find((a) => a.id === id))) return fail('알람 시각이 올바르지 않습니다.');
    updateAlarms(next);
    return ok();
  }

  function removeAlarm(id) {
    if (!known(id)) return fail('없는 알람입니다.');
    updateAlarms(alarms().filter((a) => a.id !== id));
    return ok();
  }

  function toggleAlarm(id, on) {
    if (!known(id)) return fail('없는 알람입니다.');
    const now = Date.now();
    updateAlarms(alarms().map((a) => (a.id !== id ? a : on ? { ...a, on: true, since: now } : { ...a, on: false, snoozeUntil: null })));
    return ok();
  }

  /** Buttons of the stopwatch / timer tabs. Unknown actions are ignored. */
  function timerAction(action, arg) {
    const s = store.load();
    const now = Date.now();
    switch (action) {
      case 'sw-start':
        return updateTimers({ stopwatch: TM.swStart(s.stopwatch, now) });
      case 'sw-pause':
        return updateTimers({ stopwatch: TM.swPause(s.stopwatch, now) });
      case 'sw-reset':
        return updateTimers({ stopwatch: TM.swReset() });
      case 'tm-start': {
        // A paused timer resumes; otherwise the given set time (or the saved one) starts.
        if (TM.tmRunning(s.timer)) return undefined;
        const seconds = TM.clampSeconds(arg, s.timerSeconds);
        const paused = TM.tmStatus(s.timer) === 'paused';
        return updateTimers({ ...(paused ? {} : { timerSeconds: seconds }), timer: TM.tmStart(paused ? s.timer : TM.tmReset(s.timer), now, seconds) });
      }
      case 'tm-pause':
        return updateTimers({ timer: TM.tmPause(s.timer, now) });
      case 'tm-reset':
        return updateTimers({ timer: TM.tmReset(s.timer) });
      case 'tm-preset': {
        const seconds = Number.isInteger(arg) ? s.timerPresets[arg] : undefined;
        if (seconds === undefined) return undefined;
        return updateTimers({ timerSeconds: seconds, timer: TM.tmStart(TM.tmReset(s.timer), now, seconds) });
      }
      case 'tm-set':
        return updateTimers({ timerSeconds: TM.clampSeconds(arg, s.timerSeconds) });
      case 'tm-save-preset': {
        const slot = Number(arg?.slot);
        if (!(slot >= 0 && slot < s.timerPresets.length)) return undefined;
        const presets = s.timerPresets.map((v, i) => (i === slot ? TM.clampSeconds(arg.seconds, v) : v));
        return updateTimers({ timerPresets: presets });
      }
      case 'tab':
        if (!TM.TABS.includes(arg)) return undefined;
        store.save({ lastTab: arg });
        return host?.emit('settings', settingsView());
      default:
        return undefined;
    }
  }

  /** The calls a clock theme may make (clock theme contract v1). The engine refuses anything else. */
  const run = (action) => (_entry, arg) => (timerAction(action, arg), ok());
  const methods = {
    getState: { run: () => ok({ settings: settingsView(), timers: timersView() }), preview: 'allow' },
    'stopwatch.start': { run: run('sw-start'), preview: 'noop' },
    'stopwatch.pause': { run: run('sw-pause'), preview: 'noop' },
    'stopwatch.reset': { run: run('sw-reset'), preview: 'noop' },
    'timer.start': { run: run('tm-start'), preview: 'noop' },
    'timer.pause': { run: run('tm-pause'), preview: 'noop' },
    'timer.reset': { run: run('tm-reset'), preview: 'noop' },
    'timer.set': { run: run('tm-set'), preview: 'noop' },
    'timer.usePreset': { run: run('tm-preset'), preview: 'noop' },
    'timer.savePreset': { run: (_e, slot, seconds) => (timerAction('tm-save-preset', { slot, seconds }), ok()), preview: 'noop' },
    'alarms.add': { run: (_e, values) => addAlarm(values), preview: 'deny' },
    'alarms.edit': { run: (_e, id, values) => editAlarm(id, values), preview: 'deny' },
    'alarms.remove': { run: (_e, id) => removeAlarm(id), preview: 'deny' },
    'alarms.toggle': { run: (_e, id, on) => toggleAlarm(id, Boolean(on)), preview: 'deny' },
    setTab: { run: run('tab'), preview: 'noop' },
  };

  // ---- "AI 도우미 연결 (MCP)" (#121; engine API 1.10, docs/widget-dev.md "MCP 도구") ----
  // The engine decides which tools the user's MCP client sees (writes only when allowed), checks inputs, queues
  // writes, shows a card per write with "되돌리기" and keeps the log. Every write here goes through the same functions
  // as the alarm / timer tabs (addAlarm, toggleAlarm, timerAction), so storage, scheduling and the themes follow.
  // There is no tool that deletes an alarm or touches the stopwatch, settings or themes.
  const mcpAlarm = (id) => {
    const a = alarms().find((x) => x.id === id);
    if (!a) throw new Error('없는 알람입니다. list_alarms의 id를 써 주세요.');
    return a;
  };
  const mcpLive = () => {
    if (!running) throw new Error('시계 위젯이 꺼져 있습니다.');
  };
  const mcpOpen = () => {
    if (running) host.focus();
  };
  const alarmLabel = (a) => `${AM.formatHM(a.hour, a.minute)}${a.name ? ` ${a.name}` : ''}`;
  const checked = (res) => {
    if (!res.ok) throw new Error(res.message);
    return res;
  };

  const MCP_RUN = {
    list_alarms: () => ({ data: MT.listAlarms(alarms(), Date.now()) }),
    get_timers: () => ({ data: MT.getTimers(store.load(), Date.now()) }),
    add_alarm: (input) => {
      mcpLive();
      const time = MT.parseTime(input.time);
      if (!time) throw new Error('시각은 "HH:mm"(00:00~23:59) 형식으로 주세요.');
      const days = MT.parseDays(input.days);
      if (!days) throw new Error(`요일은 ${MT.DAY_KEYS.join(', ')} 중에서 주세요.`);
      const name = typeof input.name === 'string' ? input.name : '';
      const { id } = checked(addAlarm({ ...time, name, days }));
      const a = mcpAlarm(id);
      const now = Date.now();
      return {
        data: { ok: true, now: MT.stampOf(now), alarm: MT.alarmOf(a, now) },
        summary: `알람 추가: ${alarmLabel(a)} (${AM.daysText(a.days)})`,
        // Undo turns the new alarm off instead of removing it: the tools never delete, and an alarm left off is
        // harmless and visible in the alarm tab (the user can delete it there). Nothing to do if it is gone already.
        undo: async () => {
          if (alarms().some((x) => x.id === id)) checked(toggleAlarm(id, false));
        },
        open: mcpOpen,
      };
    },
    set_alarm_enabled: (input) => {
      mcpLive();
      const before = mcpAlarm(input.id);
      const now = Date.now();
      if (before.on === input.enabled) return { data: { ok: true, changed: false, now: MT.stampOf(now), alarm: MT.alarmOf(before, now) }, unchanged: true };
      checked(toggleAlarm(before.id, input.enabled));
      const a = mcpAlarm(before.id);
      return {
        data: { ok: true, changed: true, now: MT.stampOf(now), alarm: MT.alarmOf(a, now) },
        summary: `알람 ${input.enabled ? '켬' : '끔'}: ${alarmLabel(a)}`,
        undo: async () => {
          if (!alarms().some((x) => x.id === before.id)) throw new Error('알람이 없어졌습니다.');
          checked(toggleAlarm(before.id, before.on));
        },
        open: mcpOpen,
      };
    },
    start_timer: (input) => {
      mcpLive();
      const total = (input.minutes || 0) * 60 + (input.seconds || 0);
      if (!Number.isInteger(total) || total < TM.MIN_SECONDS || total > TM.MAX_SECONDS) throw new Error('타이머는 1초부터 23시간 59분 59초까지 정할 수 있습니다.');
      const prev = store.load();
      if (TM.tmRunning(prev.timer)) throw new Error('이미 타이머가 돌고 있습니다. 위젯에서 멈추거나 초기화한 뒤 다시 해 주세요.');
      // The tab's own buttons: a paused / finished timer is reset first so the new time starts (not a resume).
      if (TM.tmStatus(prev.timer) !== 'idle') timerAction('tm-reset');
      timerAction('tm-start', total);
      const started = store.load().timer;
      const now = Date.now();
      return {
        data: { ok: true, ...MT.getTimers(store.load(), now) },
        summary: `타이머 시작: ${TM.formatDuration(total)} (${MT.stampOf(now + TM.tmRemaining(started, now))} 종료)`,
        // Undo puts back the timer as it was (idle, paused or finished) while this run is still the one going.
        undo: async () => {
          const cur = store.load().timer;
          if (cur.startedAt !== started.startedAt || cur.duration !== started.duration) throw new Error('그 뒤 타이머가 바뀌어 되돌리지 않았습니다.');
          updateTimers({ timer: prev.timer, timerSeconds: prev.timerSeconds });
        },
        open: mcpOpen,
      };
    },
  };

  /** Engines before API 1.10 have no ctx.mcp: nothing to do (the widget works as before). The engine drops them on stop. */
  function startMcp() {
    ctx.mcp?.registerTools?.(MT.TOOLS.map((tool) => ({ ...tool, run: (input) => MCP_RUN[tool.name](input || {}) })));
  }

  /** The widget's items of the theme window's right-click menu (the engine adds settings / manager / off / quit). */
  function menuItems() {
    const s = store.load();
    const themes = host.settingsHandlers().themes().filter((t) => t.usable);
    return [
      { label: '항상 위에 표시', type: 'checkbox', checked: Boolean(s.alwaysOnTop), click: (item) => change({ alwaysOnTop: item.checked }) },
      { label: '스톱워치·타이머 사용', type: 'checkbox', checked: Boolean(s.tools), click: (item) => change({ tools: item.checked }) },
      {
        label: '테마',
        submenu: themes.map((t) => ({ label: t.name, type: 'radio', checked: t.id === s.themeId, click: () => change({ themeId: t.id }) })),
      },
    ];
  }

  host = ctx.useThemes({
    store,
    builtinDir: path.join(ctx.dir, 'themes'),
    userDir: path.join(ctx.dataDir, 'themes'),
    kitDir: path.join(ctx.dir, 'kit'),
    defaultTheme: 'dark-glass',
    contractVersions: [1],
    frames: FRAMES,
    // The stopwatch / timer / alarm tabs need a bigger window: its size is kept apart ("main+tools").
    variant: () => (store.load().tools ? 'tools' : null),
    methods,
    events: ['settings', 'timers'],
    menuItems,
  });

  store.onRemoteChange?.(() => {
    if (running) host.reload();
    host.emit('settings', settingsView());
    sendTimers();
    scheduleAlarms();
  });

  return {
    start() {
      running = true;
      host.open();
      // A timer that ran out while the engine was off rings now.
      scheduleTimerEnd();
      // Alarms due while the engine was off: the ones within a minute or two ring, older ones become "놓친 알람".
      alarmCheckedAt = store.load().alarmCheckedAt || Date.now();
      checkAlarms();
      startMcp();
    },
    stop() {
      running = false;
      clearTimeout(timerEnd);
      timerEnd = null;
      clearTimeout(alarmTimeout);
      alarmTimeout = null;
      if (alarmCheckedAt) store.save({ alarmCheckedAt });
      host.close();
    },
    focus: () => host.focus(),
    desktopWindows: () => host.desktopWindows(),
    settings: {
      get: () => view(),
      save(values = {}) {
        change({
          showSeconds: values.showSeconds,
          hour12: values.hour12,
          alwaysOnTop: values.alwaysOnTop,
          tools: values.tools,
          // From the engine's theme section; missing when a panel without it saves.
          ...(typeof values.themeId === 'string' ? { themeId: values.themeId } : {}),
          ...(values.themeOpacity && typeof values.themeOpacity === 'object' ? { themeOpacity: values.themeOpacity } : {}),
        });
        // A slider value that was only being shown ends here (the saved one is applied above).
        host.setLiveOpacity(null, null);
        return { ok: true };
      },
      // themes / previewTheme / openThemeFolder / liveOpacity for the engine's theme section.
      handlers: host.settingsHandlers(),
    },
  };
}

module.exports = { create };
