// Pure alarm math (#51): next ring time, snooze, one-time alarms, missed alarms. Shared by the widget's main code
// (require) and the clock page (<script>). Times are local wall-clock times built with new Date(y, m, d, h, min).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlarmModel = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const MAX_ALARMS = 20;
  const MAX_NAME = 20;
  const SNOOZE_MS = 5 * 60 * 1000;
  // A due alarm rings when its check comes this late at most (a timer woken a bit late); later it counts as missed.
  const GRACE_MS = 2 * 60 * 1000;
  // Missed alarms older than this are dropped silently.
  const MISSED_WINDOW_MS = 12 * 3600 * 1000;
  const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

  const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
  const stamp = (v) => (Number.isFinite(v) && v > 0 ? v : null);

  /** One alarm: { id, hour, minute, name, days: weekday numbers (0 = Sunday, none = once), on, snoozeUntil, since }, or null. */
  function sanitizeAlarm(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[a-z0-9]{1,24}$/.test(raw.id)) return null;
    const hour = int(raw.hour, 0, 23);
    const minute = int(raw.minute, 0, 59);
    if (hour === null || minute === null) return null;
    const days = Array.isArray(raw.days) ? [...new Set(raw.days.filter((d) => int(d, 0, 6) !== null))].sort() : [];
    return {
      id: raw.id,
      hour,
      minute,
      name: typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '',
      days,
      on: raw.on !== false,
      snoozeUntil: stamp(raw.snoozeUntil),
      // Only times after this ring (set when the alarm is added, edited or turned on), so a new alarm is never "missed".
      since: stamp(raw.since),
    };
  }

  function sanitizeAlarms(value) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(value) ? value : []) {
      const a = sanitizeAlarm(raw);
      if (a && !seen.has(a.id) && out.length < MAX_ALARMS) {
        seen.add(a.id);
        out.push(a);
      }
    }
    return out;
  }

  /** The alarm's next regular time strictly after `after` (epoch ms), or null when it is off. */
  function nextOccurrence(alarm, after) {
    if (!alarm.on) return null;
    const floor = Math.max(after, alarm.since || 0);
    const base = new Date(floor);
    for (let i = 0; i <= 8; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, alarm.hour, alarm.minute, 0, 0);
      if (d.getTime() <= floor) continue;
      if (!alarm.days.length || alarm.days.includes(d.getDay())) return d.getTime();
    }
    return null;
  }

  /** When the alarm rings next after `after`: its regular time or a pending snooze, whichever comes first. */
  function nextDue(alarm, after) {
    const regular = nextOccurrence(alarm, after);
    const snooze = alarm.snoozeUntil && alarm.snoozeUntil > after ? alarm.snoozeUntil : null;
    if (regular === null) return snooze;
    return snooze === null ? regular : Math.min(regular, snooze);
  }

  /** The earliest due time over all alarms after `after`: { at, alarm } or null. */
  function nextDueAll(alarms, after) {
    let best = null;
    for (const alarm of alarms) {
      const at = nextDue(alarm, after);
      if (at !== null && (!best || at < best.at)) best = { at, alarm };
    }
    return best;
  }

  /**
   * Everything due in (from, to]: `ring` (due within GRACE_MS of `to`), `missed` (older, within MISSED_WINDOW_MS),
   * and the alarms afterwards (a one-time alarm turns off once its time has come; a snooze is used up).
   */
  function processDue(alarms, from, to) {
    const ring = [];
    const missed = [];
    const next = alarms.map((alarm) => {
      let cur = alarm;
      let t = from;
      for (let guard = 0; guard < 2000; guard++) {
        const at = nextDue(cur, t);
        if (at === null || at > to) break;
        const snooze = cur.snoozeUntil === at;
        const hit = { id: cur.id, hour: cur.hour, minute: cur.minute, name: cur.name, at, snooze };
        if (to - at <= GRACE_MS) ring.push(hit);
        else if (to - at <= MISSED_WINDOW_MS) missed.push(hit);
        cur = snooze ? { ...cur, snoozeUntil: null } : cur.days.length ? cur : { ...cur, on: false };
        t = at;
      }
      return cur;
    });
    // One card per alarm even if a snooze and the regular time fall together.
    const ringOnce = [...new Map(ring.map((h) => [h.id, h])).values()];
    return { alarms: next, ring: ringOnce, missed: missed.sort((a, b) => a.at - b.at) };
  }

  const snooze = (alarm, now) => ({ ...alarm, snoozeUntil: now + SNOOZE_MS });

  // ---- text ----
  const pad = (n) => String(n).padStart(2, '0');
  const formatHM = (hour, minute) => `${pad(hour)}:${pad(minute)}`;
  const timeOf = (at) => {
    const d = new Date(at);
    return formatHM(d.getHours(), d.getMinutes());
  };
  /** 한 번 / 매일 / 평일 / 주말 / 월·수·금 */
  function daysText(days) {
    const key = days.join(',');
    if (!days.length) return '한 번';
    if (days.length === 7) return '매일';
    if (key === '1,2,3,4,5') return '평일';
    if (key === '0,6') return '주말';
    return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join('·');
  }
  /** Body of a ringing card: "07:30 기상". */
  const ringText = (hit) => `${formatHM(hit.hour, hit.minute)} ${hit.name}`.trim();
  /** Body of the "놓친 알람" card: "07:30 기상, 08:00" (max 300 chars like the card). */
  function missedText(hits) {
    const text = hits.map((h) => `${timeOf(h.at)} ${h.name}`.trim()).join(', ');
    return text.length > 300 ? `${text.slice(0, 297)}...` : text;
  }
  /** Badge of the alarm tab: { state: 'next', text: '⏰ 07:30' } for the next ring, or null when nothing is set. */
  function alarmBadge(alarms, now) {
    const next = nextDueAll(alarms, now);
    return next ? { state: 'next', text: `⏰ ${timeOf(next.at)}` } : null;
  }

  return {
    MAX_ALARMS,
    MAX_NAME,
    SNOOZE_MS,
    GRACE_MS,
    MISSED_WINDOW_MS,
    DAY_NAMES,
    sanitizeAlarm,
    sanitizeAlarms,
    nextOccurrence,
    nextDue,
    nextDueAll,
    processDue,
    snooze,
    formatHM,
    timeOf,
    daysText,
    ringText,
    missedText,
    alarmBadge,
  };
});
