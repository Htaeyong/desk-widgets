// Pure calendar view logic in the calendar's theme kit (#61: any calendar theme loads it with <script src="model.js">,
// window.CalendarModel) and the tests (require):
// the month grid, which days an event covers, ordering, the upcoming list and time labels. Dates are
// local "YYYY-MM-DD" keys; normalized events carry all-day dates or UTC ISO instants.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CalendarModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
  const pad = (n) => String(n).padStart(2, '0');

  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const addDays = (key, n) => {
    const d = parseKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  };

  /** 6 weeks x 7 days starting on weekStart (0 Sunday, 1 Monday) around month (1-12) of year. */
  function monthGrid(year, month, weekStart = 0) {
    const first = new Date(year, month - 1, 1);
    const lead = (first.getDay() - weekStart + 7) % 7;
    const start = new Date(year, month - 1, 1 - lead);
    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      days.push({ key: dateKey(d), day: d.getDate(), weekday: d.getDay(), inMonth: d.getMonth() === month - 1 });
    }
    return { days, from: days[0].key, to: addDays(days[41].key, 1) };
  }

  /** Weekday header labels in grid order. */
  const weekdayLabels = (weekStart = 0) => WEEKDAY_NAMES.map((_, i) => WEEKDAY_NAMES[(i + weekStart) % 7]);

  /** Start / end as local Date objects. */
  function bounds(e) {
    if (e.allDay) return [parseKey(e.start), parseKey(e.end)];
    return [new Date(e.start), new Date(e.end)];
  }

  /** Local day keys an event covers (all-day end is exclusive; a timed event ending at 00:00 does not reach that day). */
  function eventDays(e, limit = 400) {
    const [s, en] = bounds(e);
    const first = dateKey(s);
    let last;
    if (e.allDay) last = addDays(e.end, -1);
    else last = en > s ? dateKey(new Date(en.getTime() - 1)) : first;
    if (last < first) last = first;
    const out = [];
    for (let k = first; k <= last && out.length < limit; k = addDays(k, 1)) out.push(k);
    return out;
  }

  /** All-day first, then by start, then longer first, then title. */
  function compareEvents(a, b) {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const [as, ae] = bounds(a);
    const [bs, be] = bounds(b);
    return as - bs || be - ae || String(a.title).localeCompare(String(b.title), 'ko');
  }

  /** Map day key -> sorted events, for days in [fromKey, toKey). */
  function byDay(events, fromKey, toKey) {
    const map = new Map();
    for (const e of events) {
      for (const k of eventDays(e)) {
        if ((fromKey && k < fromKey) || (toKey && k >= toKey)) continue;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(e);
      }
    }
    for (const list of map.values()) list.sort(compareEvents);
    return map;
  }

  /** Days from today for `days` days that have events not yet over at `now`: [{ key, events }]. */
  function upcoming(events, now, days) {
    const today = dateKey(now);
    const end = addDays(today, days);
    const live = events.filter((e) => bounds(e)[1] > now || (!e.allDay && e.start === e.end && new Date(e.start) >= now));
    const map = byDay(live, today, end);
    return [...map.keys()].sort().map((key) => ({ key, events: map.get(key) }));
  }

  /** Up to `max` distinct colors of a day's events (for the dots under the day number). */
  function dayColors(list, max = 3) {
    const out = [];
    for (const e of list || []) {
      if (e.color && !out.includes(e.color)) out.push(e.color);
      if (out.length >= max) break;
    }
    return out;
  }

  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  /** Time label of an event as shown on day `key`: 종일 / 09:00 – 10:00 / 09:00 ~ / ~ 10:00 / 계속. */
  function timeLabel(e, key) {
    if (e.allDay) return '종일';
    const [s, en] = bounds(e);
    const startsToday = dateKey(s) === key;
    const endsToday = en > s ? dateKey(new Date(en.getTime() - 1)) === key : startsToday;
    if (startsToday && endsToday) return en > s ? `${hm(s)} – ${hm(en)}` : hm(s);
    if (startsToday) return `${hm(s)} ~`;
    if (endsToday) return `~ ${hm(en)}`;
    return '종일';
  }

  /** "10월 18일 (일)" */
  function dayTitle(key) {
    const d = parseKey(key);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_NAMES[d.getDay()]})`;
  }

  /** Detail time text: "2026-10-18 (일) 09:00 – 10:00", over several days with both ends. */
  function detailTime(e) {
    const [s, en] = bounds(e);
    const day = (d) => `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${WEEKDAY_NAMES[d.getDay()]})`;
    if (e.allDay) {
      const last = parseKey(addDays(e.end, -1));
      return dateKey(last) === dateKey(s) ? `${day(s)} 종일` : `${day(s)} – ${day(last)} 종일`;
    }
    if (en <= s) return `${day(s)} ${hm(s)}`;
    const endDay = new Date(en.getTime() - 1);
    return dateKey(endDay) === dateKey(s) ? `${day(s)} ${hm(s)} – ${hm(en)}` : `${day(s)} ${hm(s)} – ${day(en)} ${hm(en)}`;
  }

  // ---- big month calendar (#52) ----

  /** Drawn as a bar across days: all-day events and events over more than one day. */
  const isBar = (e) => e.allDay || eventDays(e).length > 1;

  /**
   * Layout of one week row of the big calendar. dayKeys: the 7 day keys; capacity: rows that fit in a cell.
   * Bars (all-day / multi-day) get a lane per week — the same row on every day they cover, split at the week's
   * edges — and single-day timed events fill the free rows below in time order. When a day has more than fits,
   * it shows capacity - 1 rows and `more` counts the rest ("+N개").
   * Returns [{ key, rows, more }] with rows: null (empty, keeps bar rows aligned) |
   *   { type: 'bar', event, lane, head (title shown here), first (starts this day), last (ends this day) } |
   *   { type: 'item', event }.
   */
  function weekLayout(dayKeys, events, capacity) {
    const index = new Map(dayKeys.map((k, i) => [k, i]));
    const segments = [];
    const items = dayKeys.map(() => []);
    for (const e of events) {
      const days = eventDays(e);
      const cols = days.map((k) => index.get(k)).filter((i) => i !== undefined);
      if (!cols.length) continue;
      if (!isBar(e)) {
        items[cols[0]].push(e);
        continue;
      }
      segments.push({ event: e, from: Math.min(...cols), to: Math.max(...cols), before: days[0] < dayKeys[0], after: days[days.length - 1] > dayKeys[6] });
    }
    segments.sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from) || compareEvents(a.event, b.event));
    const laneEnds = [];
    for (const s of segments) {
      let lane = laneEnds.findIndex((end) => end < s.from);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = s.to;
      s.lane = lane;
    }
    const cap = Math.max(1, Math.floor(capacity) || 1);
    return dayKeys.map((key, d) => {
      const rows = [];
      for (const s of segments) {
        if (d < s.from || d > s.to) continue;
        rows[s.lane] = { type: 'bar', event: s.event, lane: s.lane, head: d === s.from, first: d === s.from && !s.before, last: d === s.to && !s.after };
      }
      for (const e of items[d].sort(compareEvents)) {
        let free = 0;
        while (rows[free]) free++;
        rows[free] = { type: 'item', event: e };
      }
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = null;
      const total = rows.filter(Boolean).length;
      if (rows.length <= cap) return { key, rows, more: 0 };
      const visible = rows.slice(0, cap - 1);
      while (visible.length && !visible[visible.length - 1]) visible.pop();
      return { key, rows: visible, more: total - visible.filter(Boolean).length };
    });
  }

  /** The grid's days in weeks of 7. */
  const weeks = (days) => Array.from({ length: Math.ceil(days.length / 7) }, (_, w) => days.slice(w * 7, w * 7 + 7));

  return { isBar, weekLayout, weeks, WEEKDAY_NAMES, dateKey, parseKey, addDays, monthGrid, weekdayLabels, eventDays, compareEvents, byDay, upcoming, dayColors, timeLabel, dayTitle, detailTime };
});
