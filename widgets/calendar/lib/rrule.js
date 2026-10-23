// RRULE (RFC 5545 §3.3.10) date expansion for the parts calendars send in practice:
// FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (with ordinals such as 2MO / -1FR),
// BYMONTHDAY (also negative), BYMONTH, BYSETPOS and WKST. BYHOUR/BYMINUTE/BYWEEKNO/BYYEARDAY are
// ignored (every occurrence keeps the DTSTART time of day). Dates are "day numbers": days since 1970-01-01.

const DAY_MS = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
function fromDayNum(n) {
  const dt = new Date(n * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() };
}
const weekday = (n) => (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const intList = (text, min, max) =>
  String(text)
    .split(',')
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max);

/** "FREQ=MONTHLY;BYDAY=-1FR;COUNT=5" -> rule object, or null when FREQ is missing or unsupported. */
function parseRrule(text) {
  const rule = { freq: null, interval: 1, count: null, until: null, byday: null, bymonthday: null, bymonth: null, bysetpos: null, wkst: 1 };
  for (const part of String(text || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim();
    if (key === 'FREQ') rule.freq = FREQS.includes(value.toUpperCase()) ? value.toUpperCase() : null;
    else if (key === 'INTERVAL') rule.interval = Math.max(1, Number.parseInt(value, 10) || 1);
    else if (key === 'COUNT') rule.count = Math.max(0, Number.parseInt(value, 10) || 0);
    else if (key === 'UNTIL') rule.until = value;
    else if (key === 'BYDAY') {
      rule.byday = value
        .split(',')
        .map((s) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim()))
        .filter(Boolean)
        .map((m) => ({ n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2].toUpperCase()) }));
      if (!rule.byday.length) rule.byday = null;
    } else if (key === 'BYMONTHDAY') rule.bymonthday = intList(value, 1, 31);
    else if (key === 'BYMONTH') rule.bymonth = intList(value, 1, 12).filter((n) => n > 0);
    else if (key === 'BYSETPOS') rule.bysetpos = intList(value, 1, 366);
    else if (key === 'WKST') rule.wkst = Math.max(0, WEEKDAYS.indexOf(value.toUpperCase()));
  }
  for (const k of ['bymonthday', 'bymonth', 'bysetpos']) if (rule[k] && !rule[k].length) rule[k] = null;
  return rule.freq ? rule : null;
}

/** Day numbers in month (y, m) that BYMONTHDAY / BYDAY select; the DTSTART day of month when neither is set. */
function monthDays(y, m, rule, startDom) {
  const last = daysInMonth(y, m);
  const first = dayNum(y, m, 1);
  let byMonthDay = null;
  if (rule.bymonthday) {
    byMonthDay = new Set(rule.bymonthday.map((d) => (d > 0 ? d : last + 1 + d)).filter((d) => d >= 1 && d <= last));
  }
  let byDay = null;
  if (rule.byday) {
    byDay = new Set();
    for (const { n, wd } of rule.byday) {
      const offset = (wd - weekday(first) + 7) % 7;
      const list = [];
      for (let d = 1 + offset; d <= last; d += 7) list.push(d);
      if (!n) list.forEach((d) => byDay.add(d));
      else {
        const pick = n > 0 ? list[n - 1] : list[list.length + n];
        if (pick) byDay.add(pick);
      }
    }
  }
  let days;
  if (byMonthDay && byDay) days = [...byMonthDay].filter((d) => byDay.has(d));
  else if (byMonthDay || byDay) days = [...(byMonthDay || byDay)];
  else days = startDom <= last ? [startDom] : [];
  return days.map((d) => first + d - 1);
}

/** YEARLY with BYDAY and no BYMONTH: weekdays counted through the whole year (20MO = the 20th Monday). */
function yearDays(y, rule) {
  const first = dayNum(y, 1, 1);
  const total = dayNum(y + 1, 1, 1) - first;
  const out = new Set();
  for (const { n, wd } of rule.byday) {
    const list = [];
    for (let i = (wd - weekday(first) + 7) % 7; i < total; i += 7) list.push(first + i);
    if (!n) list.forEach((d) => out.add(d));
    else {
      const pick = n > 0 ? list[n - 1] : list[list.length + n];
      if (pick !== undefined) out.add(pick);
    }
  }
  let days = [...out];
  if (rule.bymonthday) {
    days = days.filter((day) => {
      const { y: yy, m, d } = fromDayNum(day);
      const last = daysInMonth(yy, m);
      return rule.bymonthday.some((x) => (x > 0 ? x : last + 1 + x) === d);
    });
  }
  return days;
}

/** Candidate days of one period (sorted, unique), before BYSETPOS. */
function periodDays(rule, start, p, weekStart) {
  const step = p * rule.interval;
  let days;
  if (rule.freq === 'DAILY') {
    const day = start.day + step;
    const { m, d, wd } = fromDayNum(day);
    const last = daysInMonth(fromDayNum(day).y, m);
    const ok =
      (!rule.byday || rule.byday.some((b) => b.wd === wd)) &&
      (!rule.bymonthday || rule.bymonthday.some((x) => (x > 0 ? x : last + 1 + x) === d));
    days = ok ? [day] : [];
  } else if (rule.freq === 'WEEKLY') {
    const ws = weekStart + step * 7;
    const wds = rule.byday ? rule.byday.map((b) => b.wd) : [start.wd];
    days = wds.map((wd) => ws + ((wd - rule.wkst + 7) % 7));
  } else if (rule.freq === 'MONTHLY') {
    const index = start.y * 12 + (start.m - 1) + step;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    days = monthDays(y, m, rule, start.d);
  } else {
    const y = start.y + step;
    if (rule.byday && !rule.bymonth) days = yearDays(y, rule);
    else {
      const months = rule.bymonth || (rule.bymonthday ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [start.m]);
      days = months.flatMap((m) => monthDays(y, m, rule, start.d));
    }
  }
  if (rule.bymonth && rule.freq !== 'YEARLY') days = days.filter((day) => rule.bymonth.includes(fromDayNum(day).m));
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bysetpos) {
    const picked = rule.bysetpos.map((i) => (i > 0 ? days[i - 1] : days[days.length + i])).filter((d) => d !== undefined);
    days = [...new Set(picked)].sort((a, b) => a - b);
  }
  return days;
}

/** First day of the period with index p (to know when a period lies past the range). */
function periodStart(rule, start, p, weekStart) {
  const step = p * rule.interval;
  if (rule.freq === 'DAILY') return start.day + step;
  if (rule.freq === 'WEEKLY') return weekStart + step * 7;
  if (rule.freq === 'MONTHLY') {
    const index = start.y * 12 + (start.m - 1) + step;
    return dayNum(Math.floor(index / 12), (index % 12) + 1, 1);
  }
  return dayNum(start.y + step, 1, 1);
}

/** Period index from which to start so that periods ending before skipToDay are not walked (no COUNT only). */
function firstPeriod(rule, start, weekStart, skipToDay) {
  if (rule.count || skipToDay === undefined || skipToDay <= start.day) return 0;
  const gap = skipToDay - start.day;
  let periods;
  if (rule.freq === 'DAILY') periods = gap;
  else if (rule.freq === 'WEEKLY') periods = Math.floor((skipToDay - weekStart) / 7);
  else if (rule.freq === 'MONTHLY') {
    const t = fromDayNum(skipToDay);
    periods = t.y * 12 + t.m - (start.y * 12 + start.m);
  } else periods = fromDayNum(skipToDay).y - start.y;
  return Math.max(0, Math.floor(periods / rule.interval) - 1);
}

/**
 * Yields occurrence day numbers in order: the DTSTART day first (RFC 5545 counts it as the first instance),
 * then every later day the rule selects, until the period start passes maxDay. COUNT and UNTIL are left to
 * the caller, which knows the time of day and zone. skipToDay (ignored with COUNT) skips earlier periods.
 */
function* iterate(rule, startDay, { maxDay, skipToDay } = {}) {
  const s = fromDayNum(startDay);
  const start = { ...s, day: startDay };
  const weekStart = startDay - ((s.wd - rule.wkst + 7) % 7);
  let p = firstPeriod(rule, start, weekStart, skipToDay);
  if (p === 0) yield startDay;
  for (let guard = 0; guard < 200000; guard++, p++) {
    if (periodStart(rule, start, p, weekStart) > maxDay) return;
    for (const day of periodDays(rule, start, p, weekStart)) {
      if (day <= startDay) continue;
      if (day > maxDay) return;
      yield day;
    }
  }
}

module.exports = { WEEKDAYS, DAY_MS, dayNum, fromDayNum, weekday, daysInMonth, parseRrule, iterate };
