// Date phrases of the sticky notes' to-do features (#110 / #111). Started from the to-do widget's lib/dates.js (the
// to-do widget is frozen and keeps its own copy; widgets share no code, #40) and widened: absolute dates, more relative
// phrases, repeat rules and a few English phrases.
//
// Values:
//   due    { date: 'YYYY-MM-DD', time: 'HH:mm' | null }   floating local time (no time zone), time null = all day
//   rule   { kind: 'daily', n } | { kind: 'weekly', n, days: number[] | null } | { kind: 'monthly', n, day?, nth?, weekday? }
//          | { kind: 'yearly', month?, day? } | { kind: 'after', n, unit: 'day' | 'week' | 'month' }
//          days/day/month null = taken from the current due date.
// parseWhen() reads a whole phrase (the date box, the "/" command), parseSuffix() only the end of a line (the first
// line suggestion), parseRepeat() a repeat rule alone (front matter "repeat"). formatRepeat() writes the normalized
// rule text that goes into the front matter; parseRepeat(formatRepeat(r)) gives r back.
const DAY = 24 * 60 * 60 * 1000;
const WD = '일월화수목금토';
const WD_EN = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const NTH = ['첫째', '둘째', '셋째', '넷째', '다섯째'];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dateStr = (dt) => ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
const parts = (str) => str.split('-').map(Number);
const toDate = (str) => {
  const [y, m, d] = parts(str);
  return new Date(y, m - 1, d);
};
const dayNum = (str) => {
  const [y, m, d] = parts(str);
  return Date.UTC(y, m - 1, d) / DAY;
};
const fromDayNum = (n) => {
  const dt = new Date(n * DAY);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};
const addDays = (str, n) => fromDayNum(dayNum(str) + n);
const daysIn = (y, m) => new Date(y, m, 0).getDate(); // m is 1-based
const weekdayOf = (str) => new Date(dayNum(str) * DAY).getUTCDay();
const validYmd = (y, m, d) => Number.isInteger(y) && y >= 1970 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const todayOf = (now) => dateStr(new Date(now));
const minutesOf = (time) => (time ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) : 0);

/** The date a number of months later; `day` -1 = last day, null = the same day; clamped to the month's length. */
function addMonths(str, n, day = null) {
  const [y, m, d] = parts(str);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const want = day === -1 ? daysIn(ny, nm) : Math.min(day ?? d, daysIn(ny, nm));
  return ymd(ny, nm, want);
}

const monthIndex = (str) => {
  const [y, m] = parts(str);
  return y * 12 + m - 1;
};
const mondayNum = (str) => dayNum(str) - ((weekdayOf(str) + 6) % 7);

/** ms of a due (all day: the start of that day). Spring-forward times move to the next valid minute (Date does that). */
function dueMs(due) {
  const [y, m, d] = parts(due.date);
  if (!due.time) return new Date(y, m - 1, d).getTime();
  return new Date(y, m - 1, d, Number(due.time.slice(0, 2)), Number(due.time.slice(3, 5))).getTime();
}

/** When a due counts as missed: its time, or the next midnight for an all-day due. */
function dueEndMs(due) {
  return due.time ? dueMs(due) : toDate(addDays(due.date, 1)).getTime();
}

// ---------------------------------------------------------------------------------------------------------------
// Front matter values

const DUE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

/** "2026-11-01", "2026-11-01 09:00", "2026-11-01T09:00" -> due, or null. */
function parseDueValue(raw) {
  const m = DUE_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validYmd(y, mo, d)) return null;
  if (m[4] === undefined) return { date: ymd(y, mo, d), time: null };
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (h > 23 || mi > 59) return null;
  return { date: ymd(y, mo, d), time: `${pad(h)}:${pad(mi)}` };
}

const formatDueValue = (due) => (due.time ? `${due.date} ${due.time}` : due.date);

/** "2026-10-25 14:03" (completed, last-done) from ms. */
const stampOf = (ms) => {
  const dt = new Date(ms);
  return `${dateStr(dt)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
};
const parseStamp = (raw) => {
  const due = parseDueValue(raw);
  return due ? dueMs(due) : null;
};

// ---------------------------------------------------------------------------------------------------------------
// Reading phrases. Each reader looks at the start of the text and returns { value, len } or null.

const SP = '\\s*';
const KO_WD = '[월화수목금토일]';
const wdIndex = (ch) => WD.indexOf(ch);
const enWd = (word) => WD_EN.indexOf(word.slice(0, 3).toLowerCase());
const END = '(?=\\s|$|\\d)';

/**
 * A time at the start of s: { time: 'HH:mm', len } or { error: true } for a time-like phrase that is not a time
 * ("25시"), or null. Without 오전/오후, 1시~6시 mean the afternoon ("금요일 5시" = 17:00); "15:30" is as written.
 */
function readTime(s) {
  let m = /^(오전|오후|아침|저녁|밤|새벽|낮)?\s*(\d{1,2})\s*(?::\s*(\d{2})|시(?:\s*(반)|\s*(\d{1,2})\s*분)?)(?=\s|$)/u.exec(s);
  if (m) {
    const marker = m[1] || '';
    let h = Number(m[2]);
    const mi = m[3] !== undefined ? Number(m[3]) : m[4] ? 30 : m[5] !== undefined ? Number(m[5]) : 0;
    if (mi > 59) return { error: true };
    if (marker) {
      if (h < 1 || h > 12) return { error: true };
      if (/오전|아침|새벽/.test(marker)) h %= 12;
      else if (h !== 12) h += 12;
    } else {
      if (h > 23) return { error: true };
      if (m[3] === undefined && h >= 1 && h <= 6) h += 12;
    }
    return { time: `${pad(h)}:${pad(mi)}`, len: m[0].length };
  }
  m = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s|$)/i.exec(s);
  if (m) {
    let h = Number(m[1]);
    const mi = Number(m[2] || 0);
    if (h < 1 || h > 12 || mi > 59) return { error: true };
    h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    return { time: `${pad(h)}:${pad(mi)}`, len: m[0].length };
  }
  m = /^at\s+(\d{1,2}):(\d{2})(?=\s|$)/i.exec(s);
  if (m) {
    if (Number(m[1]) > 23 || Number(m[2]) > 59) return { error: true };
    return { time: `${pad(Number(m[1]))}:${m[2]}`, len: m[0].length };
  }
  m = /^(아침|점심|정오|저녁|밤|자정|noon|midnight)(?=\s|$)/i.exec(s);
  if (m) {
    const t = { 아침: '09:00', 점심: '12:00', 정오: '12:00', 저녁: '18:00', 밤: '21:00', 자정: '00:00', noon: '12:00', midnight: '00:00' }[m[1].toLowerCase()];
    return { time: t, len: m[0].length };
  }
  return null;
}

/** The weekday on or after today (this week counted from today). */
const weekdayOnOrAfter = (today, wd) => addDays(today, (wd - weekdayOf(today) + 7) % 7);
/** The weekday in the week (Monday..Sunday) `weeks` weeks from this one. */
const weekdayInWeek = (today, wd, weeks) => fromDayNum(mondayNum(today) + weeks * 7 + ((wd + 6) % 7));

/** A date at the start of s: { date, len, weekdayOnly? } or { error } or null. */
function readDate(s, today) {
  let m;
  const [ty, tm] = parts(today);
  const hit = (date, len, extra = {}) => ({ date, len, ...extra });
  if ((m = /^(오늘|today)(?=\s|$|\d)/i.exec(s))) return hit(today, m[0].length);
  if ((m = /^(내일|tomorrow|tmr)(?=\s|$|\d)/i.exec(s))) return hit(addDays(today, 1), m[0].length);
  if ((m = /^모레(?=\s|$|\d)/.exec(s))) return hit(addDays(today, 2), m[0].length);
  if ((m = /^글피(?=\s|$|\d)/.exec(s))) return hit(addDays(today, 3), m[0].length);
  if ((m = /^(\d{1,3})\s*(일|주|개월|달)\s*(?:뒤|후)(?=\s|$|\d)/.exec(s)) || (m = /^in\s+(\d{1,3})\s+(day|week|month)s?(?=\s|$)/i.exec(s))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === '일' || unit === 'day') return hit(addDays(today, n), m[0].length);
    if (unit === '주' || unit === 'week') return hit(addDays(today, n * 7), m[0].length);
    return hit(addMonths(today, n), m[0].length);
  }
  if ((m = /^(?:다음\s*달|next\s+month)(?=\s|$|\d)/i.exec(s))) return hit(addMonths(today, 1), m[0].length);
  if ((m = new RegExp(`^다음${SP}주(?:${SP}(${KO_WD})(?:요일)?)?${END}`, 'u').exec(s))) return hit(weekdayInWeek(today, m[1] ? wdIndex(m[1]) : 1, 1), m[0].length);
  if ((m = /^next\s+week(?=\s|$)/i.exec(s))) return hit(weekdayInWeek(today, 1, 1), m[0].length);
  if ((m = new RegExp(`^이번${SP}주${SP}(${KO_WD})(?:요일)?${END}`, 'u').exec(s))) {
    const date = weekdayInWeek(today, wdIndex(m[1]), 0);
    return hit(date < today ? addDays(date, 7) : date, m[0].length); // "이번 주 금" on a Sunday: the coming one
  }
  if ((m = /^(?:이번\s*)?주말(?=\s|$|\d)/.exec(s)) || (m = /^(?:this\s+)?weekend(?=\s|$)/i.exec(s))) return hit(weekdayOnOrAfter(today, 6), m[0].length);
  if ((m = new RegExp(`^(${KO_WD})(?:요일)?${END}`, 'u').exec(s))) return hit(weekdayOnOrAfter(today, wdIndex(m[1])), m[0].length, { weekdayOnly: true });
  if ((m = /^(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*(?=\s|$)/i.exec(s)) && enWd(m[2]) >= 0 && /^(sun|mon|tues?|wed|wednes|thu|thur|thurs|fri|sat|satur)(day)?$/i.test(m[0].replace(/^next\s+/i, ''))) {
    const wd = enWd(m[2]);
    return hit(m[1] ? weekdayInWeek(today, wd, 1) : weekdayOnOrAfter(today, wd), m[0].length, { weekdayOnly: !m[1] });
  }
  if ((m = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?=\s|$|\d)/.exec(s)) || (m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?(?=\s|$)/.exec(s))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? hit(ymd(y, mo, d), m[0].length) : { error: true };
  }
  if ((m = /^(\d{1,2})\s*월\s*(\d{1,2})\s*일(?=\s|$|\d)/.exec(s)) || (m = /^(\d{1,2})\s*[/.]\s*(\d{1,2})\.?(?=\s|$)/.exec(s))) {
    const [mo, d] = [Number(m[1]), Number(m[2])];
    // Month/day, the Korean order. A date already past this year means next year.
    if (!validYmd(2000, mo, d)) return { error: true };
    let y = ty;
    if (!validYmd(y, mo, d) || ymd(y, mo, d) < today) y += 1;
    while (!validYmd(y, mo, d)) y += 1; // 2/29: the next leap year
    return hit(ymd(y, mo, d), m[0].length);
  }
  if ((m = /^(\d{1,2})\s*일(?!\s*(?:뒤|후|마다))(?=\s|$|\d)/.exec(s))) {
    const d = Number(m[1]);
    if (d < 1 || d > 31) return { error: true };
    // This month; already past (or no such day) -> the next month that has it.
    for (let k = 0; k < 13; k++) {
      const total = ty * 12 + (tm - 1) + k;
      const [y, mo] = [Math.floor(total / 12), (total % 12) + 1];
      if (validYmd(y, mo, d) && ymd(y, mo, d) >= today) return hit(ymd(y, mo, d), m[0].length);
    }
    return { error: true };
  }
  return null;
}

/** Weekday letters "월수금", "월, 수, 금", "금요일" -> sorted indexes, or null. */
function readDays(text) {
  const letters = text.replace(/요일/g, '').replace(/[\s,·]+/g, '');
  if (!letters || !/^[월화수목금토일]+$/u.test(letters)) return null;
  return [...new Set([...letters].map(wdIndex))].sort((a, b) => a - b);
}

function readEnDays(text) {
  const words = text.split(/[\s,]+/).filter((w) => w && !/^(and|on)$/i.test(w));
  const days = words.map((w) => (/^(sun|mon|tues?|wed|wednes|thu|thur|thurs|fri|sat|satur)(day)?$/i.test(w) ? enWd(w) : -1));
  if (!days.length || days.includes(-1)) return null;
  return [...new Set(days)].sort((a, b) => a - b);
}

const clampN = (n, max) => (Number.isInteger(n) && n >= 1 && n <= max ? n : null);

/** A repeat rule at the start of s: { rule, len } or { error } or null. `alone`: "주말" alone means every weekend. */
function readRule(s, { alone = false } = {}) {
  let m;
  const ok = (rule, len) => ({ rule, len });
  const DAYS_KO = `(${KO_WD}(?:요일)?(?:[\\s,·]*${KO_WD}(?:요일)?)*)`;
  if ((m = /^(?:매일|every\s*day|daily)(?=\s|$|\d)/i.exec(s))) return ok({ kind: 'daily', n: 1 }, m[0].length);
  if ((m = /^(\d{1,3})\s*일\s*마다(?=\s|$|\d)/.exec(s)) || (m = /^every\s+(\d{1,3})\s+days?(?=\s|$)/i.exec(s))) {
    const n = clampN(Number(m[1]), 365);
    return n ? ok(n === 1 ? { kind: 'daily', n: 1 } : { kind: 'daily', n }, m[0].length) : { error: true };
  }
  if ((m = /^(?:평일(?:마다)?|매\s*평일|every\s*weekday)(?=\s|$|\d)/i.exec(s))) return ok({ kind: 'weekly', n: 1, days: [1, 2, 3, 4, 5] }, m[0].length);
  if ((m = /^(?:주말\s*마다|매\s*주말|every\s*weekend)(?=\s|$|\d)/i.exec(s)) || (alone && (m = /^주말$/.exec(s)))) return ok({ kind: 'weekly', n: 1, days: [0, 6] }, m[0].length);
  if ((m = new RegExp(`^(매주|격주)(?:${SP}${DAYS_KO})?${END}`, 'u').exec(s))) {
    const days = m[2] ? readDays(m[2]) : null;
    return ok({ kind: 'weekly', n: m[1] === '격주' ? 2 : 1, days }, m[0].length);
  }
  if ((m = new RegExp(`^(\\d{1,2})${SP}주${SP}마다(?:${SP}${DAYS_KO})?${END}`, 'u').exec(s))) {
    const n = clampN(Number(m[1]), 52);
    return n ? ok({ kind: 'weekly', n, days: m[2] ? readDays(m[2]) : null }, m[0].length) : { error: true };
  }
  if ((m = /^every\s+(other\s+|(\d{1,2})\s+weeks?\s*(?:on\s+)?)?((?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*[\s,]*(?:and\s+)?)+)(?=\s|$)/i.exec(s))) {
    const days = readEnDays(m[3]);
    if (days) {
      const n = m[1] ? (m[2] ? clampN(Number(m[2]), 52) : 2) : 1;
      return n ? ok({ kind: 'weekly', n, days }, m[0].replace(/[\s,]+$/, '').length) : { error: true };
    }
  }
  if ((m = /^(?:every\s+(\d{1,2})\s+weeks?|every\s*week|weekly)(?=\s|$)/i.exec(s))) {
    const n = m[1] ? clampN(Number(m[1]), 52) : 1;
    return n ? ok({ kind: 'weekly', n, days: null }, m[0].length) : { error: true };
  }
  if ((m = new RegExp(`^(?:매월|매달)(?:${SP}(?:(\\d{1,2})${SP}일|(말일)|(첫째|둘째|셋째|넷째|다섯째|마지막)${SP}(${KO_WD})(?:요일)?))?${END}`, 'u').exec(s))) {
    if (m[1] !== undefined) {
      const day = clampN(Number(m[1]), 31);
      return day ? ok({ kind: 'monthly', n: 1, day }, m[0].length) : { error: true };
    }
    if (m[2]) return ok({ kind: 'monthly', n: 1, day: -1 }, m[0].length);
    if (m[3]) return ok({ kind: 'monthly', n: 1, nth: m[3] === '마지막' ? -1 : NTH.indexOf(m[3]) + 1, weekday: wdIndex(m[4]) }, m[0].length);
    return ok({ kind: 'monthly', n: 1, day: null }, m[0].length);
  }
  if ((m = new RegExp(`^(\\d{1,2})${SP}(?:개월|달)${SP}마다(?:${SP}(?:(\\d{1,2})${SP}일|(말일)))?${END}`, 'u').exec(s))) {
    const n = clampN(Number(m[1]), 24);
    const day = m[2] !== undefined ? clampN(Number(m[2]), 31) : m[3] ? -1 : null;
    if (!n || (m[2] !== undefined && !day)) return { error: true };
    return ok({ kind: 'monthly', n, day }, m[0].length);
  }
  if ((m = /^every\s+(?:(\d{1,2})\s+)?months?(?:\s+on\s+(?:the\s+)?(?:(\d{1,2})(?:st|nd|rd|th)?|(last)(?:\s+day)?))?(?=\s|$)/i.exec(s)) || (m = /^monthly(?=\s|$)/i.exec(s))) {
    const n = m[1] ? clampN(Number(m[1]), 24) : 1;
    const day = m[2] ? clampN(Number(m[2]), 31) : m[3] ? -1 : null;
    if (!n || (m[2] && !day)) return { error: true };
    return ok({ kind: 'monthly', n, day }, m[0].length);
  }
  if ((m = /^(?:매년|매해)(?:\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일)?(?=\s|$|\d)/.exec(s)) || (m = /^(?:every\s*year|yearly)(?=\s|$)/i.exec(s))) {
    if (m[1] === undefined) return ok({ kind: 'yearly', month: null, day: null }, m[0].length);
    const [month, day] = [Number(m[1]), Number(m[2])];
    return validYmd(2000, month, day) ? ok({ kind: 'yearly', month, day }, m[0].length) : { error: true };
  }
  if ((m = /^완료\s*(?:한\s*)?(?:후|뒤)\s*(\d{1,3})\s*(일|주|개월|달)(?=\s|$|\d)/.exec(s)) || (m = /^(?:after|every!)\s*(\d{1,3})\s+(day|week|month)s?(?=\s|$)/i.exec(s))) {
    const unit = { 일: 'day', day: 'day', 주: 'week', week: 'week', 개월: 'month', 달: 'month', month: 'month' }[m[2].toLowerCase()];
    const n = clampN(Number(m[1]), unit === 'day' ? 999 : unit === 'week' ? 104 : 36);
    return n ? ok({ kind: 'after', n, unit }, m[0].length) : { error: true };
  }
  return null;
}

/** A repeat rule alone ("매월 1일", "완료 후 30일"): rule or null. Times after it are not part of a rule. */
function parseRepeat(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const r = readRule(s, { alone: true });
  if (!r || r.error || r.len !== s.length) return null;
  return r.rule;
}

// ---------------------------------------------------------------------------------------------------------------
// Recurrence

/** Does this date belong to the rule? `anchor` is the current due date (interval counting, missing fields). */
function matches(rule, date, anchor) {
  const [y, m, d] = parts(date);
  const [, am, ad] = parts(anchor);
  switch (rule.kind) {
    case 'daily':
      return (dayNum(date) - dayNum(anchor)) % rule.n === 0;
    case 'weekly': {
      const days = rule.days?.length ? rule.days : [weekdayOf(anchor)];
      if (!days.includes(weekdayOf(date))) return false;
      return ((mondayNum(date) - mondayNum(anchor)) / 7) % rule.n === 0;
    }
    case 'monthly': {
      if ((monthIndex(date) - monthIndex(anchor)) % rule.n !== 0) return false;
      if (rule.nth) {
        if (weekdayOf(date) !== rule.weekday) return false;
        return rule.nth === -1 ? d + 7 > daysIn(y, m) : Math.ceil(d / 7) === rule.nth;
      }
      const want = rule.day === -1 ? daysIn(y, m) : Math.min(rule.day ?? ad, daysIn(y, m));
      return d === want;
    }
    case 'yearly': {
      const month = rule.month ?? am;
      const day = rule.day ?? ad;
      return m === month && d === Math.min(day, daysIn(y, m));
    }
    default:
      return false;
  }
}

const SEARCH_DAYS = 366 * 6;

/** The first date after `after` (exclusive) that belongs to the rule, counted from `anchor`. */
function firstAfter(rule, after, anchor) {
  const start = dayNum(after);
  for (let n = start + 1; n <= start + SEARCH_DAYS; n++) {
    const date = fromDayNum(n);
    if (matches(rule, date, anchor)) return date;
  }
  return null;
}

/**
 * The next due after "완료" of a repeating note (design 5.1/5.3). Fixed rules: the first date of the rule after both
 * the current due and today (missed dates are skipped, none is created). "완료 후 N": the completion day + N. The
 * time of day stays.
 */
function nextDue(rule, due, now) {
  if (!rule || !due) return null;
  const today = todayOf(now);
  if (rule.kind === 'after') {
    const date = rule.unit === 'day' ? addDays(today, rule.n) : rule.unit === 'week' ? addDays(today, rule.n * 7) : addMonths(today, rule.n);
    return { date, time: due.time };
  }
  const from = due.date > today ? due.date : today;
  const date = firstAfter(rule, from, due.date);
  return date ? { date, time: due.time } : null;
}

/** How many dates of a repeating note have passed without "완료" (the due itself included); 0 when not overdue. */
function missedCount(rule, due, now) {
  if (!due || dueEndMs(due) > now) return 0;
  if (!rule || rule.kind === 'after') return 1;
  let count = 1;
  let date = due.date;
  while (count < 99) {
    date = firstAfter(rule, date, due.date);
    if (!date || dueEndMs({ date, time: due.time }) > now) break;
    count++;
  }
  return count;
}

/** Is the due a date of the rule? (used when the rule changes: "다음 날짜를 맞출까요?") */
const fitsRule = (rule, due) => !rule || rule.kind === 'after' || matches(rule, due.date, due.date);

/** The first date of the rule on or after the due (the "맞추기" answer). */
function alignDue(rule, due) {
  if (fitsRule(rule, due)) return due;
  // Interval rules count from the due itself, so it always fits them; only explicit days/dates move it.
  const date = firstAfter({ ...rule, n: 1 }, due.date, due.date);
  return date ? { date, time: due.time } : due;
}

// ---------------------------------------------------------------------------------------------------------------
// Whole phrases

/**
 * A whole phrase -> { due, rule } (rule null when not repeating) or { error: 'invalid' } or null (empty).
 * "내일 3시", "10/30", "다음 주 월요일 오후 3시", "매월 1일 오전 9시", "완료 후 30일", "3pm", "every fri".
 */
function parseWhen(raw, now = Date.now()) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const today = todayOf(now);
  let pos = 0;
  let rule = null;
  let date = null;
  let weekdayOnly = false;
  let time = null;
  const rest = () => s.slice(pos).trimStart();
  const skip = (len) => {
    const before = s.length - s.slice(pos).trimStart().length;
    pos = before + len;
  };
  const r = readRule(rest());
  if (r?.error) return { error: 'invalid' };
  if (r) {
    rule = r.rule;
    skip(r.len);
  } else {
    const d = readDate(rest(), today);
    if (d?.error) return { error: 'invalid' };
    if (d) {
      date = d.date;
      weekdayOnly = Boolean(d.weekdayOnly);
      skip(d.len);
    }
  }
  if (rest()) {
    const t = readTime(rest());
    if (!t || t.error) return { error: 'invalid' };
    time = t.time;
    skip(t.len);
  }
  if (rest()) return { error: 'invalid' };
  if (!rule && !date && !time) return { error: 'invalid' };
  const nowMinutes = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const passed = (d) => d === today && time !== null && minutesOf(time) <= nowMinutes;
  if (rule) {
    if (rule.kind === 'after') return { due: { date: today, time }, rule };
    // The first date of the rule from today; today's time already gone -> the next one.
    const first = matches(rule, today, today) && !passed(today) ? today : firstAfter(rule, today, today);
    if (!first) return { error: 'invalid' };
    return { due: { date: first, time }, rule };
  }
  if (!date) {
    // A time alone: today, or tomorrow when it has passed.
    return { due: { date: passed(today) ? addDays(today, 1) : today, time }, rule: null };
  }
  if (weekdayOnly && passed(date)) date = addDays(date, 7);
  return { due: { date, time }, rule: null };
}

/**
 * The end of a line as a date phrase, for the first-line suggestion: { title, due, rule, phrase } or null.
 * "보고서 제출 금요일 5시" -> title "보고서 제출". The longest phrase at the end wins; the title must stay non-empty.
 */
function parseSuffix(line, now = Date.now()) {
  const text = String(line ?? '').trim().replace(/\s+/g, ' ');
  const words = text.split(' ');
  for (let k = Math.min(6, words.length - 1); k >= 1; k--) {
    const phrase = words.slice(words.length - k).join(' ');
    // A weekday letter alone ends too many ordinary lines ("오늘 할 일", "한 달에 한 번 월") to be suggested.
    if (/^[월화수목금토일]$/u.test(phrase)) continue;
    const r = parseWhen(phrase, now);
    if (r && !r.error) return { title: words.slice(0, words.length - k).join(' '), phrase, ...r };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Writing

const dayLetters = (days) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD[d]).join('');

/** The normalized Korean text of a rule (what "repeat" holds). */
function formatRepeat(rule) {
  if (!rule) return '';
  switch (rule.kind) {
    case 'daily':
      return rule.n === 1 ? '매일' : `${rule.n}일마다`;
    case 'weekly': {
      const days = rule.days?.length ? rule.days : null;
      if (rule.n === 1 && days) {
        if (days.join() === '1,2,3,4,5') return '평일';
        if (days.join() === '0,6') return '주말마다';
      }
      if (rule.n === 1) return days ? `매주 ${dayLetters(days)}` : '매주';
      if (rule.n === 2) return days ? `격주 ${dayLetters(days)}` : '격주';
      return days ? `${rule.n}주마다 ${dayLetters(days)}` : `${rule.n}주마다`;
    }
    case 'monthly': {
      const dayText = rule.nth ? `${rule.nth === -1 ? '마지막' : NTH[rule.nth - 1]} ${WD[rule.weekday]}요일` : rule.day === -1 ? '말일' : rule.day ? `${rule.day}일` : '';
      if (rule.n === 1) return dayText ? `매월 ${dayText}` : '매월';
      if (rule.nth) return `${rule.n}개월마다`; // not readable back with a weekday; keeps the interval
      return dayText ? `${rule.n}개월마다 ${dayText}` : `${rule.n}개월마다`;
    }
    case 'yearly':
      return rule.month ? `매년 ${rule.month}월 ${rule.day}일` : '매년';
    case 'after':
      return `완료 후 ${rule.n}${{ day: '일', week: '주', month: '개월' }[rule.unit]}`;
    default:
      return '';
  }
}

/** "remind" values: '마감' (at the due), 'N분 전', 'N시간 전', 'N일 전 HH:mm', '없음'. -> object or null (invalid). */
function parseRemind(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (s === '마감' || s === '마감 시각') return { kind: 'at' };
  if (s === '없음' || s === '끄기') return { kind: 'none' };
  let m = /^(\d{1,4}) ?(분|시간) ?전$/.exec(s);
  if (m) {
    const minutes = Number(m[1]) * (m[2] === '시간' ? 60 : 1);
    return minutes >= 1 && minutes <= 7 * 24 * 60 ? { kind: 'before', minutes } : null;
  }
  m = /^(\d{1,2}) ?일 ?전 (\d{1,2}):(\d{2})$/.exec(s) || /^(전날) (\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const days = m[1] === '전날' ? 1 : Number(m[1]);
    const [h, mi] = [Number(m[2]), Number(m[3])];
    if (days < 1 || days > 30 || h > 23 || mi > 59) return null;
    return { kind: 'daysBefore', days, time: `${pad(h)}:${pad(mi)}` };
  }
  return null;
}

function formatRemind(r) {
  if (!r) return '';
  if (r.kind === 'at') return '마감';
  if (r.kind === 'none') return '없음';
  if (r.kind === 'before') return r.minutes % 60 === 0 ? `${r.minutes / 60}시간 전` : `${r.minutes}분 전`;
  return `${r.days}일 전 ${r.time}`;
}

/**
 * When to remind (ms) or null. A timed due: its time (or before it); an all-day due: `allDayTime` that day
 * ('' = no reminder unless the note says otherwise).
 */
function remindAt(due, remind, allDayTime) {
  if (!due) return null;
  if (remind?.kind === 'none') return null;
  if (remind?.kind === 'daysBefore') return dueMs({ date: addDays(due.date, -remind.days), time: remind.time });
  const base = due.time ? dueMs(due) : allDayTime ? dueMs({ date: due.date, time: allDayTime }) : null;
  if (base === null) return null;
  return remind?.kind === 'before' ? base - remind.minutes * 60000 : base;
}

/** "11월 2일 (월) 오후 3:00" for the date box preview. */
function describeDue(due, now = Date.now()) {
  if (!due) return '';
  const [y, m, d] = parts(due.date);
  let text = `${m}월 ${d}일 (${WD[weekdayOf(due.date)]})`;
  if (y !== new Date(now).getFullYear()) text = `${y}년 ${text}`;
  if (due.time) {
    const h = Number(due.time.slice(0, 2));
    text += ` ${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${due.time.slice(3)}`;
  }
  return text;
}

module.exports = {
  DAY,
  WD,
  parseDueValue,
  formatDueValue,
  parseStamp,
  stampOf,
  parseWhen,
  parseSuffix,
  parseRepeat,
  formatRepeat,
  parseRemind,
  formatRemind,
  remindAt,
  nextDue,
  missedCount,
  fitsRule,
  alignDue,
  matches,
  dueMs,
  dueEndMs,
  describeDue,
  readTime,
  addDays,
  addMonths,
  dayNum,
  todayOf,
  weekdayOf,
};
