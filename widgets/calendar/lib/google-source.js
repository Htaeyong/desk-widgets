// Google account source (#114): one account = several calendars, read with the Calendar API v3.
// Google's events become the same components lib/ical.js parses from iCalendar, so occurrences, the
// read-only rules (lib/editable.js) and the caches work unchanged:
//   - recurring series come expanded (singleEvents); each instance is a component with recurrenceId set,
//     which makes it read-only like CalDAV recurring events;
//   - uid is Google's event id, href the event's API address, etag its ETag (edits are conditional);
//   - events that are not plain events (birthdays, Gmail, working location, focus time, out of office) are
//     read-only (locked); working-location entries are not shown at all.
// A calendar whose cached window covers the one asked for is asked with If-None-Match first.
const { GoogleClient, eventUrl } = require('./google-api');
const { plainText } = require('./ical');
const { SourceError } = require('./http');
const { covers } = require('./caldav-source');

const UTC = { iana: 'UTC' };

/** A Google start/end ({ date } or { dateTime }) -> lib/ical.js time object, or null. */
function timeOf(t) {
  if (t?.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) return { allDay: true, date: t.date };
  const ms = Date.parse(t?.dateTime || '');
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return { allDay: false, wall: { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }, zone: UTC };
}

const LOCKED = {
  birthday: '생일 일정은 Google 연락처에서 바꾸세요.',
  fromGmail: 'Gmail에서 만든 일정은 여기서 바꿀 수 없습니다. Google 캘린더에서 바꾸세요.',
  focusTime: '집중 시간 일정은 Google 캘린더에서 바꾸세요.',
  outOfOffice: '부재중 일정은 Google 캘린더에서 바꾸세요.',
};

/** One Google event -> component (or null when it is not shown). account: the Google email. */
function componentOf(e, calUrl, account) {
  if (!e?.id || e.status === 'cancelled' || e.eventType === 'workingLocation') return null;
  const start = timeOf(e.start);
  if (!start) return null;
  let end = timeOf(e.end);
  if (end && end.allDay !== start.allDay) end = null;
  const organizer = e.organizer?.self ? account : String(e.organizer?.email || '');
  const type = e.eventType && e.eventType !== 'default' ? e.eventType : null;
  return {
    uid: String(e.id),
    title: String(e.summary || '').trim().slice(0, 300),
    location: String(e.location || '').trim().slice(0, 300),
    description: plainText(e.description || ''),
    url: /^https:\/\//i.test(e.htmlLink || '') ? String(e.htmlLink).slice(0, 2000) : '',
    status: String(e.status || '').toUpperCase(),
    start,
    end,
    duration: null,
    // An instance of a series: its original start, so it is read-only and never mistaken for the series.
    recurrenceId: e.recurringEventId ? timeOf(e.originalStartTime) || start : null,
    rrule: null,
    rdates: [],
    exdates: [],
    organizer: organizer.slice(0, 300),
    attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
    locked: type ? LOCKED[type] || '이 종류의 Google 일정은 여기서 바꿀 수 없습니다.' : e.locked ? '잠긴 일정입니다. Google 캘린더에서 바꾸세요.' : null,
    href: eventUrl(calUrl, e.id),
    etag: e.etag ? String(e.etag).replace(/^W\//, '').replace(/^"|"$/g, '') : null,
    shared: false,
  };
}

const componentsOf = (items, calUrl, account) => items.map((e) => componentOf(e, calUrl, account)).filter(Boolean);

/**
 * source: { email, calendars: [{ id (API calendar URL), name, color, enabled, canWrite }] }.
 * opts: { fetch, prev: { tags, windows }, previous, tokens, window, Client }.
 * Resolves { validators, calendars, error? }; throws when the account cannot be read at all (login, network).
 */
async function fetchGoogle(source, { fetch, prev = {}, previous = [], tokens, window, Client = GoogleClient } = {}) {
  if (!tokens) throw new SourceError('이 빌드에는 Google 로그인 설정이 없어 Google 계정을 읽을 수 없습니다.', 'no-client');
  if (!window) throw new SourceError('읽을 기간이 없습니다.', 'no-window');
  const client = new Client({ tokens, accountId: source.id, fetch });
  const tags = {};
  const windows = {};
  const calendars = [];
  const errors = [];
  const enabled = (source.calendars || []).filter((c) => c.enabled !== false);
  for (const cal of enabled) {
    const before = previous.find((p) => p.id === cal.id);
    try {
      const oldWindow = prev.windows?.[cal.id];
      const reuse = before && prev.tags?.[cal.id] && covers(oldWindow, window);
      // Same window as last time: Google answers 304 when nothing in it changed.
      const asked = reuse ? oldWindow : window;
      const res = await client.listEvents(cal.id, asked.from, asked.to, { ifNoneMatch: reuse ? prev.tags[cal.id] : undefined });
      if (res.notModified) {
        tags[cal.id] = prev.tags[cal.id];
        windows[cal.id] = oldWindow;
        calendars.push({ ...before, name: cal.name, readOnly: cal.canWrite === false });
        continue;
      }
      if (res.etag) tags[cal.id] = res.etag;
      windows[cal.id] = { ...asked };
      calendars.push({ id: cal.id, name: cal.name, readOnly: cal.canWrite === false, components: componentsOf(res.items, cal.id, source.email) });
    } catch (err) {
      if (['auth', 'reauth', 'untrusted', 'network', 'timeout', 'no-client', 'oauth-client'].includes(err.code)) throw err;
      errors.push(`${cal.name}: ${err.message}`);
      if (before) {
        calendars.push(before);
        if (prev.tags?.[cal.id]) tags[cal.id] = prev.tags[cal.id];
        if (prev.windows?.[cal.id]) windows[cal.id] = prev.windows[cal.id];
      }
    }
  }
  if (enabled.length && errors.length === enabled.length) throw new SourceError(errors.join(' / '), 'calendars');
  return { validators: { tags, windows }, calendars, error: errors.length ? errors.join(' / ') : null };
}

module.exports = { fetchGoogle, componentOf, componentsOf, timeOf };
