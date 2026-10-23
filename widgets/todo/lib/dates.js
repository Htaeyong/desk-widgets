// Korean quick-entry date parser. The date phrase must be at the end, so normal task titles stay intact.
const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const DATE_PHRASE = /(?:^|\s)(오늘|내일|모레|다음\s*주\s*[월화수목금토일](?:요일)?|매주(?:\s*[월화수목금토일](?:요일)?)?)(?:\s*(오전|오후)?\s*(\d{1,2})(?::(\d{1,2})|시\s*(\d{1,2})?분?)?)?\s*$/u;
const TIME_ONLY = /(?:^|\s)(오전|오후)?\s*(\d{1,2})(?::(\d{1,2})|시\s*(\d{1,2})?분?)\s*$/u;

function localDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function withTime(date, hour, minute) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).getTime(); }
function readTime(marker, rawHour, rawMinute) {
  const hour = Number(rawHour);
  const minute = Number(rawMinute || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59 || hour > (marker ? 12 : 23) || (marker && hour < 1)) return null;
  return { hour: marker === '오후' ? (hour % 12) + 12 : marker === '오전' ? hour % 12 : hour, minute };
}
function nextWeekday(now, weekday, strictlyNextWeek = false) {
  const today = localDay(now);
  const gap = strictlyNextWeek
    ? (7 - (today.getDay() + 6) % 7) + (weekday + 6) % 7
    : (weekday - today.getDay() + 7) % 7;
  today.setDate(today.getDate() + gap);
  return today;
}

/** Returns a plain task when no supported suffix is present; rejects malformed matched times. */
function parseQuickInput(input, now = new Date()) {
  const raw = String(input || '').trim();
  const dateMatch = raw.match(DATE_PHRASE);
  const timeMatch = dateMatch ? null : raw.match(TIME_ONLY);
  if (!dateMatch && !timeMatch) return { title: raw, dueAt: null, dateOnly: false, repeatWeekday: null };
  const match = dateMatch || timeMatch;
  const title = raw.slice(0, match.index).trim();
  if (!title) return { title: raw, dueAt: null, dateOnly: false, repeatWeekday: null };
  const phrase = dateMatch?.[1] || null;
  const marker = dateMatch ? dateMatch[2] : timeMatch[1];
  const hourPart = dateMatch ? dateMatch[3] : timeMatch[2];
  const minutePart = dateMatch ? (dateMatch[4] ?? dateMatch[5]) : (timeMatch[3] ?? timeMatch[4]);
  const explicitTime = hourPart !== undefined;
  const time = explicitTime ? readTime(marker, hourPart, minutePart) : null;
  if (explicitTime && !time) return { error: 'invalidDate' };
  let day = localDay(now);
  let repeatWeekday = null;
  if (phrase === '내일') day.setDate(day.getDate() + 1);
  else if (phrase === '모레') day.setDate(day.getDate() + 2);
  else if (phrase?.startsWith('다음')) day = nextWeekday(now, WEEKDAYS[phrase.match(/[월화수목금토일]/u)[0]], true);
  else if (phrase?.startsWith('매주')) {
    repeatWeekday = WEEKDAYS[phrase.match(/[월화수목금토일]/u)?.[0]] ?? now.getDay();
    day = nextWeekday(now, repeatWeekday);
  }
  if (timeMatch && !dateMatch && withTime(day, time.hour, time.minute) <= now.getTime()) day.setDate(day.getDate() + 1);
  if (repeatWeekday !== null && explicitTime && withTime(day, time.hour, time.minute) <= now.getTime()) day.setDate(day.getDate() + 7);
  return {
    title,
    dueAt: explicitTime ? withTime(day, time.hour, time.minute) : withTime(day, 23, 59),
    dateOnly: !explicitTime,
    repeatWeekday,
  };
}

function nextRepeat(task, now) {
  if (!Number.isInteger(task.repeatWeekday)) return null;
  const old = new Date(task.dueAt || now);
  const next = nextWeekday(new Date(Math.max(now, task.dueAt || now) + DAY), task.repeatWeekday);
  return withTime(next, task.dateOnly ? 23 : old.getHours(), task.dateOnly ? 59 : old.getMinutes());
}

module.exports = { parseQuickInput, nextRepeat, nextWeekday, readTime };
