// iCalendar (RFC 5545) reader for the VEVENT subset a desktop calendar shows, written in-house so the
// widget package needs no node_modules. parseIcs() turns a document into plain JSON-able components
// (kept in the cache); occurrences() expands them into normalized events for a time range.
const { resolveZone, parseOffset, wallToUtc } = require('./tz');
const R = require('./rrule');

const MAX_TEXT = 4000;

/** Splits lines and joins folded continuation lines (a line starting with a space or tab). */
function unfold(text) {
  const lines = [];
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else if (raw.length) lines.push(raw);
  }
  return lines;
}

/** "DTSTART;TZID=\"Asia/Seoul\":20261018T090000" -> { name, params, value }. Colons inside quotes are not separators. */
function parseLine(line) {
  let quoted = false;
  let colon = -1;
  const semis = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === ';') semis.push(i);
    else if (!quoted && c === ':') {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const cuts = semis.filter((i) => i < colon);
  const name = (cuts.length ? head.slice(0, cuts[0]) : head).trim().toUpperCase();
  const params = {};
  cuts.forEach((at, k) => {
    const part = head.slice(at + 1, k + 1 < cuts.length ? cuts[k + 1] : head.length);
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
  });
  return { name, params, value: line.slice(colon + 1) };
}

/** TEXT unescaping: \n \N \, \; \\ . */
const unescapeText = (v) => String(v).replace(/\\([nN,;\\])/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** Descriptions from Outlook/Exchange are sometimes HTML; the widget shows plain text only. */
function plainText(text) {
  let t = String(text || '');
  if (/<\/?[a-z][^>]*>/i.test(t)) {
    t = t
      .replace(/<(br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

/**
 * One DATE or DATE-TIME value -> time object:
 *   { allDay: true, date: 'YYYY-MM-DD' } or { allDay: false, wall: {y,m,d,h,mi,s}, zone } (zone null = floating).
 */
function parseTime(value, params = {}, vtimezones = {}) {
  const v = String(value || '').trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || params.VALUE === 'DATE') {
    const m = date || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const wall = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  const zone = m[7] ? { iana: 'UTC' } : resolveZone(params.TZID, vtimezones);
  return { allDay: false, wall, zone };
}

const pad = (n) => String(n).padStart(2, '0');
const dateParts = (date) => date.split('-').map(Number);
const dateDay = (date) => R.dayNum(...dateParts(date));
const dayDate = (day) => {
  const { y, m, d } = R.fromDayNum(day);
  return `${y}-${pad(m)}-${pad(d)}`;
};

/** Start instant of a time object; all-day dates start at the PC's local midnight. */
function timeMs(t) {
  if (t.allDay) {
    const [y, m, d] = dateParts(t.date);
    return new Date(y, m - 1, d).getTime();
  }
  return wallToUtc(t.wall, t.zone);
}

/** "P1DT2H", "-PT15M", "P2W" -> { days, ms } (days nominal, the rest exact). */
function parseDuration(text) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const days = sign * ((+m[2] || 0) * 7 + (+m[3] || 0));
  const ms = sign * (((+m[4] || 0) * 60 + (+m[5] || 0)) * 60 + (+m[6] || 0)) * 1000;
  return { days, ms };
}

/** Parses a document into { name, events } (events: JSON-able VEVENT components). Never throws on bad lines. */
function parseIcs(text) {
  const lines = unfold(text);
  const vtimezones = {};
  const raws = [];
  let calName = '';
  const stack = [];
  let cur = null;
  let tz = null;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const kind = p.value.trim().toUpperCase();
      stack.push(kind);
      if (kind === 'VEVENT' && stack.length <= 3) cur = { props: [] };
      else if (kind === 'VTIMEZONE') tz = { id: '', location: '', standardOffset: null, daylight: false };
      continue;
    }
    if (p.name === 'END') {
      const kind = stack.pop();
      if (kind === 'VEVENT' && cur) {
        raws.push(cur);
        cur = null;
      } else if (kind === 'VTIMEZONE' && tz) {
        if (tz.id) vtimezones[tz.id] = { location: tz.location, standardOffset: tz.standardOffset };
        tz = null;
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (cur && top === 'VEVENT') cur.props.push(p);
    else if (tz) {
      if (top === 'VTIMEZONE' && p.name === 'TZID') tz.id = p.value.trim();
      else if (top === 'VTIMEZONE' && p.name === 'X-LIC-LOCATION') tz.location = p.value.trim();
      else if (top === 'STANDARD' && p.name === 'TZOFFSETTO') tz.standardOffset = parseOffset(p.value);
    } else if (top === 'VCALENDAR' && p.name === 'X-WR-CALNAME') calName = unescapeText(p.value).trim();
  }
  const events = raws.map((r) => component(r.props, vtimezones)).filter(Boolean);
  return { name: calName.slice(0, 100), events };
}

/** Raw VEVENT properties -> component, or null when it has no usable DTSTART. */
function component(props, vtimezones) {
  const one = (name) => props.find((p) => p.name === name);
  const text = (name) => (one(name) ? unescapeText(one(name).value).trim() : '');
  const dt = one('DTSTART');
  const start = dt && parseTime(dt.value, dt.params, vtimezones);
  if (!start) return null;
  const de = one('DTEND') || one('DUE');
  let end = de ? parseTime(de.value, de.params, vtimezones) : null;
  if (end && end.allDay !== start.allDay) end = null;
  const duration = !end && one('DURATION') ? parseDuration(one('DURATION').value) : null;
  const rid = one('RECURRENCE-ID');
  const rr = one('RRULE');
  const times = (name) =>
    props
      .filter((p) => p.name === name && p.params.VALUE !== 'PERIOD')
      .flatMap((p) => p.value.split(',').map((v) => parseTime(v, p.params, vtimezones)))
      .filter(Boolean);
  const rule = rr ? R.parseRrule(rr.value) : null;
  let until = null;
  if (rule?.until) until = parseTime(rule.until, {}, vtimezones);
  const url = text('URL');
  return {
    uid: text('UID') || `no-uid-${text('SUMMARY')}-${dt.value}`,
    title: text('SUMMARY').slice(0, 300),
    location: text('LOCATION').slice(0, 300),
    description: plainText(text('DESCRIPTION')),
    url: /^https?:\/\//i.test(url) ? url.slice(0, 2000) : '',
    status: text('STATUS').toUpperCase(),
    start,
    end,
    duration,
    recurrenceId: rid ? parseTime(rid.value, rid.params, vtimezones) : null,
    rrule: rule ? { ...rule, until } : null,
    rdates: times('RDATE'),
    exdates: times('EXDATE'),
    // Who sent it and to whom: a meeting someone else organizes is read-only in the widget (#48).
    organizer: one('ORGANIZER') ? one('ORGANIZER').value.trim().slice(0, 300) : '',
    attendees: props.filter((p) => p.name === 'ATTENDEE').length,
  };
}

// ---- occurrences ----

/** Length of the event: { days } for all-day, { ms } for timed. */
function lengthOf(c) {
  if (c.start.allDay) {
    if (c.end) return { days: Math.max(1, dateDay(c.end.date) - dateDay(c.start.date)) };
    if (c.duration) return { days: Math.max(1, c.duration.days + Math.floor(c.duration.ms / R.DAY_MS)) };
    return { days: 1 };
  }
  if (c.end) return { ms: Math.max(0, timeMs(c.end) - timeMs(c.start)) };
  if (c.duration) {
    // Days are nominal (same wall time n days later), the rest exact.
    const s = c.start.wall;
    const shifted = c.duration.days ? wallToUtc({ ...s, d: s.d + c.duration.days }, c.start.zone) : timeMs(c.start);
    return { ms: Math.max(0, shifted + c.duration.ms - timeMs(c.start)) };
  }
  return { ms: 0 };
}

/** A key identifying an instance of a series by its original start (RECURRENCE-ID / EXDATE matching). */
function instanceKey(t, seriesAllDay) {
  if (seriesAllDay || t.allDay) return `d:${t.allDay ? t.date : dayDate(R.dayNum(t.wall.y, t.wall.m, t.wall.d))}`;
  return `t:${timeMs(t)}`;
}

/** Occurrence start (time object) of a series on a given day number. */
function onDay(start, day) {
  if (start.allDay) return { allDay: true, date: dayDate(day) };
  const { y, m, d } = R.fromDayNum(day);
  return { allDay: false, wall: { ...start.wall, y, m, d }, zone: start.zone };
}

/** Start times (time objects) of a component's instances that may touch [fromMs, toMs). */
function instanceStarts(c, fromMs, toMs, len) {
  if (!c.rrule && !c.rdates.length) return [c.start];
  const startDay = c.start.allDay ? dateDay(c.start.date) : R.dayNum(c.start.wall.y, c.start.wall.m, c.start.wall.d);
  // Day numbers bounding the range, with a margin for zones and the event length.
  const spanDays = (len.days || 0) + Math.ceil((len.ms || 0) / R.DAY_MS) + 2;
  const fromDay = Math.floor(fromMs / R.DAY_MS) - spanDays;
  const toDay = Math.ceil(toMs / R.DAY_MS) + 2;
  const out = [];
  if (c.rrule) {
    const rule = c.rrule;
    const untilMs = rule.until ? (rule.until.allDay ? timeMs({ allDay: true, date: dayDate(dateDay(rule.until.date) + 1) }) - 1 : timeMs(rule.until)) : Infinity;
    let n = 0;
    for (const day of R.iterate(rule, startDay, { maxDay: toDay, skipToDay: fromDay })) {
      const t = onDay(c.start, day);
      if (timeMs(t) > untilMs) break;
      n++;
      if (rule.count && n > rule.count) break;
      if (day >= fromDay) out.push(t);
    }
  } else out.push(c.start);
  for (const r of c.rdates) {
    if (r.allDay === c.start.allDay) out.push(r);
    else if (!c.start.allDay && r.allDay) out.push(onDay(c.start, dateDay(r.date)));
  }
  return out;
}

const isoUtc = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Normalized event (the shape every source returns) for one instance. */
function normalized(c, startT, len, ctx, recurrenceId) {
  const base = {
    uid: c.uid,
    sourceId: ctx.sourceId,
    calendarId: ctx.calendarId,
    title: c.title || '(제목 없음)',
    location: c.location,
    description: c.description,
    url: c.url,
    readOnly: ctx.readOnly !== false,
    recurrenceId: recurrenceId || null,
  };
  if (startT.allDay) {
    const day = dateDay(startT.date);
    const days = len.days || 1;
    return { ...base, allDay: true, start: startT.date, end: dayDate(day + days) };
  }
  const s = timeMs(startT);
  return { ...base, allDay: false, start: isoUtc(s), end: isoUtc(s + (len.ms || 0)) };
}

/** Instant range [startMs, endMs) of a normalized event. */
function eventRange(e) {
  if (e.allDay) return [timeMs({ allDay: true, date: e.start }), timeMs({ allDay: true, date: e.end })];
  return [Date.parse(e.start), Date.parse(e.end)];
}

const overlaps = (e, fromMs, toMs) => {
  const [s, en] = eventRange(e);
  return s < toMs && (en > fromMs || (en === s && s >= fromMs));
};

/**
 * Expands components into normalized events overlapping [fromMs, toMs): RRULE/RDATE instances minus EXDATE,
 * instances replaced by their RECURRENCE-ID override, cancelled series and instances dropped.
 * ctx: { sourceId, calendarId, readOnly }.
 */
function occurrences(components, fromMs, toMs, ctx = {}) {
  const masters = new Map();
  const overrides = new Map();
  for (const c of components) {
    if (c.recurrenceId) {
      if (!overrides.has(c.uid)) overrides.set(c.uid, []);
      overrides.get(c.uid).push(c);
    } else {
      // Some feeds reuse a UID for unrelated events; keep them all (overrides attach to the first).
      let key = c.uid;
      for (let n = 2; masters.has(key); n++) key = `${c.uid}#${n}`;
      masters.set(key, c);
    }
  }
  const out = [];
  for (const [uid, c] of masters) {
    if (c.status === 'CANCELLED') continue;
    const len = lengthOf(c);
    const allDay = c.start.allDay;
    const skip = new Set(c.exdates.map((t) => instanceKey(t, allDay)));
    const replaced = new Set((overrides.get(uid) || []).map((o) => instanceKey(o.recurrenceId, allDay)));
    const recurring = Boolean(c.rrule || c.rdates.length);
    const seen = new Set();
    for (const t of instanceStarts(c, fromMs, toMs, len)) {
      const key = instanceKey(t, allDay);
      if (seen.has(key) || skip.has(key) || replaced.has(key)) continue;
      seen.add(key);
      const e = normalized(c, t, len, ctx, recurring ? key : null);
      if (overlaps(e, fromMs, toMs)) out.push(e);
    }
  }
  for (const [uid, list] of overrides) {
    const master = masters.get(uid);
    if (master?.status === 'CANCELLED') continue;
    for (const o of list) {
      if (o.status === 'CANCELLED') continue;
      const e = normalized(o, o.start, lengthOf(o), ctx, instanceKey(o.recurrenceId, master ? master.start.allDay : o.start.allDay));
      if (overlaps(e, fromMs, toMs)) out.push(e);
    }
  }
  return out;
}

/**
 * The fields the widget shows and edits, in a comparable form (#48 write verification):
 * { title, allDay, start, end, location, description } with dates (all-day) or instants in ms (timed).
 */
function componentFields(c) {
  const len = lengthOf(c);
  if (c.start.allDay) {
    return { title: c.title, allDay: true, start: c.start.date, end: dayDate(dateDay(c.start.date) + (len.days || 1)), location: c.location, description: c.description };
  }
  const s = timeMs(c.start);
  return { title: c.title, allDay: false, start: s, end: s + (len.ms || 0), location: c.location, description: c.description };
}

module.exports = { unfold, parseLine, unescapeText, plainText, parseTime, parseDuration, parseIcs, timeMs, lengthOf, componentFields, occurrences, eventRange };
