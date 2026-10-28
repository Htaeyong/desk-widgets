// D-day items (#76): sanitizing, day counting and following a linked event. Dates are calendar days
// ('YYYY-MM-DD', local time), so counting never depends on the time of day or daylight saving.
const crypto = require('crypto');
const path = require('path');

const MAX_ITEMS = 500;
const REMIND_BEFORE = [1, 3, 7];
const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const newId = () => `d${crypto.randomBytes(6).toString('hex')}`;

/** 'YYYY-MM-DD' that is a real date, else null. */
function validKey(value) {
  const m = KEY.exec(String(value || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Whole days since 1970-01-01 of a date key (UTC arithmetic: no time zone or DST in the way). */
function dayNumber(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** A yearly D-day's next date on or after today; Feb 29 falls on Feb 28 in a common year. */
function nextYearly(dateKey, todayKey) {
  const [, m, d] = dateKey.split('-').map(Number);
  const year = Number(todayKey.slice(0, 4));
  const at = (y) => `${y}-${pad(m)}-${pad(Math.min(d, daysIn(y, m)))}`;
  const thisYear = at(year);
  return thisYear >= todayKey ? thisYear : at(year + 1);
}

const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

function sanitizeRemind(r) {
  if (!r || typeof r !== 'object') return null;
  const before = [...new Set((Array.isArray(r.before) ? r.before : []).map(Number))].filter((n) => REMIND_BEFORE.includes(n)).sort((a, b) => a - b);
  const sameDay = r.sameDay === true;
  return sameDay || before.length ? { sameDay, before } : null;
}

function sanitizeLink(l) {
  if (!l || typeof l !== 'object') return null;
  const sourceId = typeof l.sourceId === 'string' ? l.sourceId.slice(0, 64) : '';
  const uid = typeof l.uid === 'string' ? l.uid.slice(0, 1000) : '';
  if (!sourceId || !uid) return null;
  return { sourceId, calendarId: typeof l.calendarId === 'string' ? l.calendarId.slice(0, 2000) : '', uid };
}

/** One item; null when it cannot be used. */
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = validKey(raw.date);
  const title = String(raw.title ?? '').trim().slice(0, 100);
  if (!date || !title) return null;
  const link = sanitizeLink(raw.link);
  return {
    id: /^[a-z0-9-]{1,40}$/i.test(String(raw.id)) ? raw.id : newId(),
    title,
    date,
    color: isColor(raw.color) ? raw.color.toLowerCase() : '#ff6b6b',
    inclusive: raw.inclusive === true,
    yearly: raw.yearly === true,
    remind: sanitizeRemind(raw.remind),
    archived: raw.archived === true,
    link,
    ownTitle: link ? raw.ownTitle === true : true, // a linked D-day follows its event's title until the user types one
    // This PC only (sync field mark): the reminder cards already sent, as "<kind>:<date>".
    notifiedFor: (Array.isArray(raw.notifiedFor) ? raw.notifiedFor : []).filter((x) => typeof x === 'string' && x.length <= 40).slice(-30),
  };
}

function sanitize(raw) {
  const items = [];
  const ids = new Set();
  for (const r of Array.isArray(raw?.items) ? raw.items : []) {
    const item = sanitizeItem(r);
    if (!item) continue;
    while (ids.has(item.id)) item.id = newId();
    ids.add(item.id);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return { items };
}

/**
 * Count for today: days = today - target (negative = still to come), the label (D-3 / D-day / D+2) and the date
 * counted against. Yearly items count to their next date and never pass. "Include today" makes the day itself
 * D+1 (day 1 of a count-up, anniversaries); it does not apply to yearly items.
 */
function count(item, todayKey) {
  const target = item.yearly ? nextYearly(item.date, todayKey) : item.date;
  const days = dayNumber(todayKey) - dayNumber(target);
  let label;
  if (days < 0) label = `D-${-days}`;
  else if (item.inclusive && !item.yearly) label = `D+${days + 1}`;
  else label = days === 0 ? 'D-day' : `D+${days}`;
  return { target, days, label };
}

/** True when a one-time D-day passed more than archiveDays ago (0 = never) or was archived by hand. */
function isArchived(item, days, archiveDays) {
  if (item.archived) return true;
  return !item.yearly && archiveDays > 0 && days > archiveDays;
}

/** Nearest first: today and the future by closeness, then the past with the most recent first. */
const compareView = (a, b) => {
  const aFuture = a.days <= 0;
  if (aFuture !== (b.days <= 0)) return aFuture ? -1 : 1;
  return (aFuture ? b.days - a.days : a.days - b.days) || a.title.localeCompare(b.title);
};

/**
 * What a theme sees: { active, archived } with the count of each item.
 * `status[id].missing` marks a linked event that could not be found (the last known date keeps counting).
 */
function present(items, todayKey, archiveDays, status = {}) {
  const views = items.map((item) => {
    const c = count(item, todayKey);
    return {
      id: item.id, title: item.title, date: item.date, target: c.target, color: item.color, label: c.label, days: c.days,
      inclusive: item.inclusive, yearly: item.yearly, remind: item.remind, ownTitle: item.ownTitle,
      link: item.link, linked: Boolean(item.link), missing: Boolean(status[item.id]?.missing),
      archived: isArchived(item, c.days, archiveDays),
    };
  }).sort(compareView);
  return { active: views.filter((v) => !v.archived), archived: views.filter((v) => v.archived) };
}

/**
 * Follows linked events. `found(link)` returns { date, title } of the event's next occurrence (else its last one)
 * or null; undefined when it cannot tell yet. Returns the items (date and followed title updated), which links are missing (their last known date
 * stays) and whether anything changed.
 */
function follow(items, found) {
  const missing = {};
  let changed = false;
  const next = items.map((item) => {
    if (!item.link) return item;
    const hit = found(item.link);
    if (hit === undefined) return item; // not known yet (data still loading): neither moved nor missing
    if (!hit) {
      missing[item.id] = { missing: true };
      return item;
    }
    const title = item.ownTitle ? item.title : String(hit.title || item.title).trim().slice(0, 100) || item.title;
    if (hit.date === item.date && title === item.title) return item;
    changed = true;
    return { ...item, date: hit.date, title };
  });
  return { items: next, missing, changed };
}

/** Reminder cards due now: each (kind, target date) once, from 9:00 on the day (a missed one is only sent that day). */
function dueReminders(items, todayKey, hour, archiveDays) {
  if (hour < 9) return [];
  const out = [];
  for (const item of items) {
    if (!item.remind) continue;
    const c = count(item, todayKey);
    if (isArchived(item, c.days, archiveDays) || c.days > 0) continue;
    const ahead = -c.days;
    const kind = ahead === 0 ? (item.remind.sameDay ? 'd0' : null) : item.remind.before.includes(ahead) ? `d${ahead}` : null;
    if (!kind) continue;
    const mark = `${kind}:${c.target}`;
    if (item.notifiedFor.includes(mark)) continue;
    out.push({ item, kind, mark, label: c.label, target: c.target });
  }
  return out;
}

function createDdays(ctx, onChange) {
  const store = ctx.createStore({
    file: path.join(ctx.dataDir, 'ddays.json'), defaults: { items: [] }, sanitize,
    sync: {
      name: 'ddays',
      // Which reminders this PC already showed is not shared, so another PC does not skip or repeat them.
      collections: { items: { id: 'id', local: ['notifiedFor'] } },
      shared: [],
      describe: (_kind, value, locale) => [{ label: /^en\b/i.test(locale) ? 'Title' : '제목', text: value?.title || '' }],
    },
  });
  store.onRemoteChange?.(onChange);
  const all = () => sanitize(store.load()).items;
  const write = (items) => store.save({ items });
  return { all, write };
}

module.exports = { createDdays, sanitize, sanitizeItem, sanitizeLink, validKey, count, nextYearly, present, follow, dueReminders, isArchived, newId, dayNumber, MAX_ITEMS };
