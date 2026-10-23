// iCalendar writing for CalDAV (#48): a new event, and an edit merged into the server's own document.
// Lessons ported from my_calendar_sync (ICalendar.kt, issues #81 #100 #106):
//   - an edit rewrites only the properties the user changed on the series' VEVENT; everything else
//     (VALARM, ATTENDEE, X- properties, other VEVENTs, VTIMEZONE) is copied back as it arrived, folding and all;
//   - the top-level METHOD is dropped (a stored resource must not carry one; Dooray answers 2xx and keeps
//     nothing when it is echoed) and PRODID becomes ours (Dooray drops a body carrying its own PRODID);
//   - SEQUENCE goes up by one, except when the event has attendees (a rising SEQUENCE asks every attendee to
//     re-confirm, and the widget is not sending a scheduling message).
// Times are written in UTC ("…Z") and all-day events as DATE values (#48).
const { plainText } = require('./ical');

const PRODID = '-//chilgong88//Desk Widgets Calendar 1.0//KO';
const CRLF = '\r\n';

/** TEXT escaping (RFC 5545 §3.3.11): \\ ; , and line breaks; other control characters are dropped. */
function escapeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Folds a content line at 75 octets without splitting a UTF-8 character (RFC 5545 §3.1). */
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join(`${CRLF} `);
}

const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' -> 'YYYYMMDD' */
const icalDate = (date) => date.replace(/-/g, '');
/** ms -> 'YYYYMMDDTHHMMSSZ' */
const icalUtc = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

/** DTSTART / DTEND lines for { allDay, start, end } (dates, or instants in ms). */
function timeLines(f) {
  if (f.allDay) return [`DTSTART;VALUE=DATE:${icalDate(f.start)}`, `DTEND;VALUE=DATE:${icalDate(f.end)}`];
  return [`DTSTART:${icalUtc(f.start)}`, `DTEND:${icalUtc(f.end)}`];
}

/** A new calendar object resource for one event. fields: { title, allDay, start, end, location, description }. */
function serializeNew(uid, f, now = Date.now()) {
  const stamp = icalUtc(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `CREATED:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    ...timeLines(f),
    `SUMMARY:${escapeText(f.title)}`,
  ];
  if (f.location) lines.push(`LOCATION:${escapeText(f.location)}`);
  if (f.description) lines.push(`DESCRIPTION:${escapeText(f.description)}`);
  lines.push('SEQUENCE:0', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join(CRLF) + CRLF;
}

/** Splits a document into logical lines that keep their raw (folded) form, with name and nesting path. */
function chunks(text) {
  const out = [];
  const stack = [];
  for (const raw of String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) {
      out[out.length - 1].raw.push(raw);
      out[out.length - 1].logical += raw.slice(1);
      continue;
    }
    if (!raw.length) continue;
    const name = raw.split(/[;:]/, 1)[0].trim().toUpperCase();
    const value = raw.slice(raw.indexOf(':') + 1).trim();
    const c = { name, raw: [raw], logical: raw, depth: stack.length, parent: stack[stack.length - 1] || null };
    if (name === 'BEGIN') {
      c.depth = stack.length;
      stack.push(value.toUpperCase());
    } else if (name === 'END') {
      stack.pop();
      c.depth = stack.length;
    }
    out.push(c);
  }
  return out;
}

const valueOf = (c) => c.logical.slice(c.logical.indexOf(':') + 1).trim();

/**
 * The [begin, end] chunk indexes of the series VEVENT for uid (no RECURRENCE-ID) directly in VCALENDAR,
 * or null when there is none or more than one.
 */
function findMaster(list, uid) {
  const found = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.name !== 'BEGIN' || valueOf(c).toUpperCase() !== 'VEVENT' || c.depth !== 1) continue;
    let j = i + 1;
    while (j < list.length && !(list[j].name === 'END' && list[j].depth === 1)) j++;
    const own = list.slice(i + 1, j).filter((x) => x.depth === 2);
    const id = own.find((x) => x.name === 'UID');
    if (id && valueOf(id) === uid && !own.some((x) => x.name === 'RECURRENCE-ID')) found.push([i, j]);
    i = j;
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * Merges an edit into the server's document. changes holds only what the user changed:
 * { title?, location?, description?, time?: { allDay, start, end } }. Returns the new text, or null when the
 * document has no single series VEVENT for uid (the caller must not write then).
 */
function mergeEdit(existing, uid, changes, now = Date.now()) {
  const list = chunks(existing);
  const target = findMaster(list, uid);
  if (!target) return null;
  const [begin, end] = target;
  const inTarget = (i) => i > begin && i < end && list[i].depth === 2;
  const own = list.filter((_, i) => inTarget(i));
  const hasAttendees = own.some((c) => c.name === 'ATTENDEE');
  const seqLine = own.find((c) => c.name === 'SEQUENCE');
  const current = seqLine ? Number.parseInt(valueOf(seqLine), 10) : 0; // absent = 0 (RFC 5545 §3.8.7.4)
  const sequence = hasAttendees ? null : (Number.isFinite(current) ? current : 0) + 1;

  const replaced = new Set(['DTSTAMP', 'LAST-MODIFIED']);
  if (sequence !== null) replaced.add('SEQUENCE');
  const added = [`DTSTAMP:${icalUtc(now)}`, `LAST-MODIFIED:${icalUtc(now)}`];
  if (changes.title !== undefined) {
    replaced.add('SUMMARY');
    added.push(`SUMMARY:${escapeText(changes.title)}`);
  }
  if (changes.location !== undefined) {
    replaced.add('LOCATION');
    if (changes.location) added.push(`LOCATION:${escapeText(changes.location)}`);
  }
  if (changes.description !== undefined) {
    // The HTML copy (Outlook) would otherwise keep showing the old text.
    replaced.add('DESCRIPTION').add('X-ALT-DESC');
    if (changes.description) added.push(`DESCRIPTION:${escapeText(changes.description)}`);
  }
  if (changes.time) {
    replaced.add('DTSTART').add('DTEND').add('DURATION');
    added.push(...timeLines(changes.time));
  }
  if (sequence !== null) added.push(`SEQUENCE:${sequence}`);

  const out = [];
  let hasProdid = false;
  list.forEach((c, i) => {
    if (c.depth === 1 && c.parent === 'VCALENDAR' && c.name === 'METHOD') return;
    if (c.depth === 1 && c.parent === 'VCALENDAR' && c.name === 'PRODID') {
      hasProdid = true;
      out.push(`PRODID:${PRODID}`);
      return;
    }
    if (inTarget(i) && replaced.has(c.name)) return;
    out.push(...c.raw);
    if (i === begin) out.push(...added.map(fold));
  });
  if (!hasProdid) out.splice(out.findIndex((l) => /^BEGIN:VCALENDAR/i.test(l)) + 1, 0, `PRODID:${PRODID}`);
  return out.join(CRLF) + CRLF;
}

/** Comparable form of event fields (what the user meant), for verifying a write against what the server holds. */
function fingerprint(f) {
  return JSON.stringify([
    String(f.title || '').trim(),
    Boolean(f.allDay),
    f.allDay ? f.start : Math.round(Number(f.start) / 1000),
    f.allDay ? f.end : Math.round(Number(f.end) / 1000),
    String(f.location || '').trim(),
    plainText(f.description || ''),
  ]);
}

module.exports = { PRODID, escapeText, fold, icalUtc, serializeNew, mergeEdit, fingerprint, chunks };
