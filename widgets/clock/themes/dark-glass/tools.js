// Stopwatch, timer (#45) and alarm (#51) tabs, shown while "스톱워치·타이머 사용" is on (#46). The widget's main code keeps
// the state (clock theme contract v1, #60); this page only draws it and calls window.widget.api for button presses.
// In the theme preview the engine ignores those calls (or refuses alarm changes), so the buttons do nothing there.
// The stopwatch redraws with requestAnimationFrame only while it runs and its tab is shown; the timer once per second.
// Tabs not shown carry a running indicator (#50), redrawn only when its text changes (at most once per second).
(() => {
  const TM = window.TimerModel;
  const AM = window.AlarmModel;
  const W = window.widget;
  const api = W.api;
  let readOnly = false;
  const $ = (id) => document.getElementById(id);
  const presetButtons = [...document.querySelectorAll('[data-preset]')];
  let state = { stopwatch: TM.STOPWATCH, timer: TM.TIMER, timerSeconds: TM.DEFAULT_TIMER_SECONDS, timerPresets: TM.DEFAULT_PRESETS, lastTab: 'clock', alarms: [] };
  let tab = null;
  let frame = 0;
  let tick = null;
  let badgeTick = null;
  let saving = false;
  // Alarm form: null (list shown), 'new', or the id of the alarm being edited.
  let editing = null;

  const active = () => document.body.dataset.tools === 'on' && document.visibilityState === 'visible';

  W.getContext().then((context) => {
    readOnly = Boolean(context?.preview);
    if (!readOnly) return;
    for (const el of document.querySelectorAll('.m-pane button, .m-pane input')) {
      el.title = '미리보기에서는 동작하지 않습니다';
      if (el.tagName === 'INPUT') el.readOnly = true;
    }
  });

  function showTab(next) {
    tab = TM.TABS.includes(next) ? next : 'clock';
    $('clock').dataset.tab = tab;
    for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
    draw();
  }

  // ---- set time inputs ----
  const field = (id, max) => TM.fieldValue($(id).value, max);
  const readInputs = () => field('tmH', 23) * 3600 + field('tmM', 59) * 60 + field('tmS', 59);
  function fillInputs(seconds) {
    if (document.activeElement?.closest?.('#tmSet')) return; // keep what the user is typing
    const { h, m, s } = TM.splitSeconds(seconds);
    $('tmH').value = String(h).padStart(2, '0');
    $('tmM').value = String(m).padStart(2, '0');
    $('tmS').value = String(s).padStart(2, '0');
  }

  // ---- drawing ----
  function drawStopwatch() {
    const sw = state.stopwatch;
    $('swTime').textContent = TM.formatStopwatch(TM.swElapsed(sw, Date.now()));
    $('swToggle').textContent = TM.swRunning(sw) ? '일시정지' : '시작';
    cancelAnimationFrame(frame);
    if (TM.swRunning(sw) && tab === 'stopwatch' && active()) frame = requestAnimationFrame(drawStopwatch);
  }

  function drawTimer() {
    const t = state.timer;
    const status = TM.tmStatus(t);
    const left = TM.tmRemaining(t, Date.now());
    const pane = document.querySelector('[data-pane="timer"]');
    pane.dataset.status = status;
    $('tmTime').textContent = TM.formatRemaining(left);
    $('tmToggle').textContent = { running: '일시정지', done: '다시 시작' }[status] || '시작';
    presetButtons.forEach((b, i) => {
      const label = TM.formatDuration(state.timerPresets[i]);
      b.textContent = saving ? `→ ${label}` : label;
      b.title = saving ? `여기에 저장 (지금: ${label})` : `${label} 타이머 바로 시작`;
    });
    $('tmSave').textContent = saving ? '취소' : '저장';
    pane.classList.toggle('saving', saving);
    clearTimeout(tick);
    // Next redraw when the shown second changes; main sends the end itself.
    if (status === 'running' && left > 0 && tab === 'timer' && active()) tick = setTimeout(drawTimer, (left % 1000 || 1000) + 5);
  }

  function setBadge(name, badge) {
    const button = document.querySelector(`.m-tabs [data-tab="${name}"]`);
    const label = button.querySelector('.t-label').textContent;
    if (!badge || name === tab) {
      delete button.dataset.badge;
      button.title = '';
      return;
    }
    button.dataset.badge = badge.state;
    button.querySelector('.t-text').textContent = badge.text;
    button.title = badge.state === 'next' ? `다음 알람 ${badge.text.replace('⏰ ', '')}` : `${label} ${badge.state === 'running' ? '동작 중' : '일시정지'} ${badge.text}`;
  }

  function drawBadges() {
    const now = Date.now();
    setBadge('stopwatch', TM.swBadge(state.stopwatch, now));
    setBadge('timer', TM.tmBadge(state.timer, now));
    setBadge('alarm', AM.alarmBadge(state.alarms, now));
    clearTimeout(badgeTick);
    const delay = active() ? TM.badgeDelay(state.stopwatch, state.timer, now) : null;
    if (delay !== null) badgeTick = setTimeout(drawBadges, delay + 5);
  }

  // ---- alarms ----
  function alarmItem(alarm) {
    const li = document.createElement('li');
    li.className = alarm.on ? 'al-item' : 'al-item off';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'al-main';
    main.title = readOnly ? '미리보기에서는 동작하지 않습니다' : '고치기';
    const hm = document.createElement('span');
    hm.className = 'al-hm';
    hm.textContent = AM.formatHM(alarm.hour, alarm.minute);
    const sub = document.createElement('span');
    sub.className = 'al-sub';
    const snoozed = alarm.snoozeUntil && alarm.snoozeUntil > Date.now() ? `다시 ${AM.timeOf(alarm.snoozeUntil)}` : '';
    sub.textContent = [AM.daysText(alarm.days), alarm.name, snoozed].filter(Boolean).join(' · ');
    main.append(hm, sub);
    main.addEventListener('click', () => openForm(alarm));
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'al-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(alarm.on));
    toggle.title = alarm.on ? '끄기' : '켜기';
    toggle.addEventListener('click', () => api.alarms.toggle(alarm.id, !alarm.on));
    li.append(main, toggle);
    return li;
  }

  function drawAlarms() {
    const list = state.alarms || [];
    if (editing !== null && editing !== 'new' && !list.some((a) => a.id === editing)) editing = null;
    document.querySelector('[data-pane="alarm"]').classList.toggle('editing', editing !== null);
    $('alList').replaceChildren(...list.map(alarmItem));
    $('alEmpty').hidden = list.length > 0;
    $('alAdd').disabled = list.length >= AM.MAX_ALARMS;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  function openForm(alarm) {
    if (readOnly) return;
    editing = alarm ? alarm.id : 'new';
    $('alH').value = pad2(alarm ? alarm.hour : 7);
    $('alM').value = pad2(alarm ? alarm.minute : 0);
    $('alName').value = alarm ? alarm.name : '';
    for (const b of $('alDays').children) b.classList.toggle('on', Boolean(alarm?.days.includes(Number(b.dataset.day))));
    $('alDelete').hidden = !alarm;
    drawAlarms();
    $('alH').focus();
  }

  function closeForm() {
    editing = null;
    drawAlarms();
  }

  function saveForm() {
    const values = {
      hour: field('alH', 23),
      minute: field('alM', 59),
      name: $('alName').value,
      days: [...$('alDays').children].filter((b) => b.classList.contains('on')).map((b) => Number(b.dataset.day)),
    };
    if (editing === 'new') api.alarms.add(values);
    else api.alarms.edit(editing, values);
    closeForm();
  }

  function draw() {
    drawStopwatch();
    drawTimer();
    drawAlarms();
    drawBadges();
  }

  function apply(next) {
    state = { ...state, ...next };
    fillInputs(state.timerSeconds);
    if (tab === null) showTab(state.lastTab);
    else draw();
  }

  // Hour / minute / second fields (timer and alarm): two digits while typing, clamped and zero-padded on leaving (#51).
  for (const input of document.querySelectorAll('input[data-max]')) {
    const max = Number(input.dataset.max);
    input.addEventListener('input', () => {
      const digits = TM.typedDigits(input.value);
      if (digits !== input.value) input.value = digits;
    });
    input.addEventListener('blur', () => {
      input.value = TM.fieldText(input.value, max);
    });
  }

  // ---- buttons ----
  for (const b of document.querySelectorAll('[data-tab]')) {
    b.addEventListener('click', () => {
      showTab(b.dataset.tab);
      api.setTab(tab);
    });
  }
  $('swToggle').addEventListener('click', () => (TM.swRunning(state.stopwatch) ? api.stopwatch.pause() : api.stopwatch.start()));
  $('swReset').addEventListener('click', () => api.stopwatch.reset());
  $('tmToggle').addEventListener('click', () => {
    const status = TM.tmStatus(state.timer);
    if (status === 'running') api.timer.pause();
    else if (status === 'done') api.timer.start(state.timer.duration / 1000);
    else if (status === 'paused') api.timer.start();
    else if (readInputs() > 0) api.timer.start(readInputs());
  });
  $('tmReset').addEventListener('click', () => api.timer.reset());
  for (const id of ['tmH', 'tmM', 'tmS']) {
    $(id).addEventListener('change', () => {
      const seconds = readInputs();
      if (seconds > 0) api.timer.set(seconds);
    });
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('tmToggle').click();
    });
  }
  // Save: "저장" turns the preset buttons into slots; clicking one stores the set time there.
  $('tmSave').addEventListener('click', () => {
    saving = !saving && !readOnly;
    drawTimer();
  });
  presetButtons.forEach((b, i) => {
    b.addEventListener('click', () => {
      if (!saving) {
        api.timer.usePreset(i);
        return;
      }
      saving = false;
      const seconds = TM.tmStatus(state.timer) === 'idle' ? readInputs() : state.timerSeconds;
      if (seconds > 0) api.timer.savePreset(i, seconds);
      drawTimer();
    });
  });
  $('alAdd').addEventListener('click', () => openForm(null));
  $('alSave').addEventListener('click', saveForm);
  $('alCancel').addEventListener('click', closeForm);
  $('alDelete').addEventListener('click', () => {
    api.alarms.remove(editing);
    closeForm();
  });
  for (const b of $('alDays').children) b.addEventListener('click', () => b.classList.toggle('on'));
  for (const id of ['alH', 'alM', 'alName']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveForm();
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && saving) {
      saving = false;
      drawTimer();
    }
    if (e.key === 'Escape' && editing !== null) closeForm();
  });

  document.addEventListener('visibilitychange', draw);
  W.on('settings', () => draw()); // the tabs may have been turned on or off (clock.js sets data-tools first)
  W.on('timers', apply);
  window.clockState.then((initial) => {
    if (initial) apply({ ...initial.timers, lastTab: initial.settings.lastTab });
  });
})();
