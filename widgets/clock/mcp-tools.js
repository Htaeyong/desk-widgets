// "AI 도우미 연결 (MCP)" (#121, engine API 1.10): the pure parts of the clock's MCP tools. The tool declarations
// (names, descriptions, input schemas) and what the results look like. Writing goes through index.js, the same
// functions the alarm / timer tabs use (addAlarm, toggleAlarm, timerAction); nothing here touches the store.
// Not in kit/: kit files are served to the theme pages, these are main-process only.
const AM = require('./kit/alarm-model');
const TM = require('./kit/timer-model');

// Weekday names for the tools (index = Date#getDay, 0 = Sunday), like the alarm model's `days`.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const pad = (n) => String(n).padStart(2, '0');
/** Local wall-clock time 'YYYY-MM-DD HH:mm' (the PC's time zone, like the alarms). */
function stampOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const stampOrNull = (ms) => (Number.isFinite(ms) ? stampOf(ms) : null);

/** 'HH:mm' or 'H:mm' -> { hour, minute }, or null. */
function parseTime(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** ['mon', 'fri'] -> [1, 5]; null when an entry is not a day key. Duplicates are fine (the model drops them). */
function parseDays(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const v of list) {
    const i = DAY_KEYS.indexOf(String(v).trim().toLowerCase());
    if (i < 0) return null;
    out.push(i);
  }
  return [...new Set(out)].sort();
}

/** One alarm as the tools show it. */
function alarmOf(a, now) {
  return {
    id: a.id,
    time: AM.formatHM(a.hour, a.minute),
    name: a.name,
    days: a.days.map((d) => DAY_KEYS[d]),
    repeat: AM.daysText(a.days),
    enabled: a.on,
    snoozed_until: a.snoozeUntil && a.snoozeUntil > now ? stampOf(a.snoozeUntil) : null,
    next: stampOrNull(AM.nextDue(a, now)),
  };
}

/** clock_list_alarms */
function listAlarms(alarms, now) {
  return { now: stampOf(now), max_alarms: AM.MAX_ALARMS, alarms: alarms.map((a) => alarmOf(a, now)) };
}

const seconds = (ms) => Math.round(ms / 1000);

/** The timer as the tools show it: status idle / running / paused / done (done = finished and rang). */
function timerOf(t, timerSeconds, now) {
  const status = TM.tmStatus(t);
  const remaining = TM.tmRemaining(t, now);
  return {
    status,
    duration_seconds: seconds(t.duration),
    duration_text: TM.formatDuration(t.duration / 1000),
    remaining_seconds: Math.ceil(remaining / 1000),
    remaining_text: TM.formatRemaining(remaining),
    ends_at: status === 'running' ? stampOf(now + remaining) : null,
    // The set time the timer tab shows for its next start.
    set_seconds: timerSeconds,
  };
}

/** clock_get_timers. The stopwatch has no laps in this widget. */
function getTimers(state, now) {
  const sw = state.stopwatch;
  const elapsed = TM.swElapsed(sw, now);
  return {
    now: stampOf(now),
    timer: timerOf(state.timer, state.timerSeconds, now),
    stopwatch: {
      status: TM.swRunning(sw) ? 'running' : elapsed > 0 ? 'paused' : 'idle',
      elapsed_seconds: Math.floor(elapsed / 1000),
      elapsed_text: TM.formatStopwatch(elapsed),
    },
  };
}

const ID = { type: 'string', minLength: 1, maxLength: 24, description: 'Alarm id from list_alarms.' };

/** The tool declarations; `run` functions are added by index.js. No tool deletes an alarm. */
const TOOLS = [
  {
    name: 'list_alarms',
    title: '알람 보기',
    description: 'List the user\'s clock alarms: id, time (HH:mm, PC local time), name, repeat days (empty = rings once, then turns itself off), enabled, and the next ring time ("YYYY-MM-DD HH:mm", null when off). Includes "now".',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'get_timers',
    title: '타이머 보기',
    description: 'Show the clock widget\'s timer (status idle/running/paused/done, set duration, remaining time, end time) and stopwatch (status, elapsed time). Includes "now".',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'add_alarm',
    title: '알람 추가',
    write: true,
    description: `Add an alarm (turned on). "time" is "HH:mm" in 24-hour PC local time. "days" are the repeat weekdays; empty or omitted = once (rings at the next such time, then turns off). At most ${AM.MAX_ALARMS} alarms; there is no delete tool, so check list_alarms first and prefer set_alarm_enabled for an existing one.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['time'], properties: {
      time: { type: 'string', minLength: 3, maxLength: 5, description: '"HH:mm", 24-hour, e.g. "07:30".' },
      days: { type: 'array', maxItems: 7, items: { type: 'string', enum: DAY_KEYS }, description: 'Repeat weekdays, e.g. ["mon","tue","wed","thu","fri"]. Empty = once.' },
      name: { type: 'string', maxLength: AM.MAX_NAME, description: `Label shown when it rings (up to ${AM.MAX_NAME} characters).` },
    } },
  },
  {
    name: 'set_alarm_enabled',
    title: '알람 켜기/끄기',
    write: true,
    idempotent: true,
    description: 'Turn one alarm on or off by id. Turning a one-time alarm on schedules it for the next such time.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'enabled'], properties: {
      id: ID,
      enabled: { type: 'boolean' },
    } },
  },
  {
    name: 'start_timer',
    title: '타이머 시작',
    write: true,
    description: 'Start the clock widget\'s countdown timer for minutes and/or seconds (total 1 second to 23:59:59); a sound card shows when it ends. Refused while the timer is running. A paused or finished timer is replaced.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      minutes: { type: 'integer', minimum: 0, maximum: Math.floor(TM.MAX_SECONDS / 60) },
      seconds: { type: 'integer', minimum: 0, maximum: 59 },
    } },
  },
];

module.exports = { TOOLS, DAY_KEYS, stampOf, parseTime, parseDays, alarmOf, listAlarms, getTimers };
