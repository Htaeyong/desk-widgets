// Event writes on Google calendars (#114), with the same rules as the CalDAV writes (lib/writer.js, #48):
//   create: events.insert;
//   edit:   only the changed properties (events.patch) with If-Match of the ETag the user saw -> 412 = conflict;
//   delete: events.delete with If-Match (already gone counts as done).
// Each write is checked by reading the event back; "applied" only when Google holds what was written.
// Nothing is retried or forced through without the condition.
const { GoogleClient, googleIdOf } = require('./google-api');
const { componentOf } = require('./google-source');
const { componentFields } = require('./ical');
const { fingerprint } = require('./ical-write');
const { diffFields } = require('./event-fields');
const { SourceError } = require('./http');

/** The PC's IANA zone for new timed events (Google shows the event in it), or undefined. */
function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Google start/end of editor fields. Explicit nulls clear the other form when an event changes between timed and all-day. */
function timesOf(f, zone = localZone()) {
  if (f.allDay) return { start: { date: f.start, dateTime: null, timeZone: null }, end: { date: f.end, dateTime: null, timeZone: null } };
  const at = (ms) => ({ dateTime: new Date(ms).toISOString(), timeZone: zone || null, date: null });
  return { start: at(f.start), end: at(f.end) };
}

/** A new event's resource (only what the editor has). */
function resourceOf(f, zone) {
  const t = timesOf(f, zone);
  const strip = (x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null));
  return { summary: f.title, location: f.location || undefined, description: f.description || undefined, start: strip(t.start), end: strip(t.end) };
}

/** The patch of an edit: only the changed properties. */
function patchOf(changes, zone) {
  const out = {};
  if ('title' in changes) out.summary = changes.title;
  if ('location' in changes) out.location = changes.location;
  if ('description' in changes) out.description = changes.description;
  if (changes.time) Object.assign(out, timesOf(changes.time, zone));
  return out;
}

/**
 * op: 'create' | 'edit' | 'delete'. source: the Google account; calendarId: the calendar's API URL; components:
 * its cached components; fields: validated editor values; tokens: lib/google-oauth.js createTokens().
 * Resolves { uid, applied, unchanged?, expect }. Throws SourceError ('conflict', 'gone', 'reauth', ...).
 */
async function writeGoogle({ op, source, calendarId, uid, fields, components = [], tokens, fetch, zone, Client = GoogleClient }) {
  if (!googleIdOf(calendarId)) throw new SourceError('Google 캘린더 주소가 아니어서 쓰지 않았습니다.', 'untrusted');
  const client = new Client({ tokens, accountId: source.id, fetch });
  const master = uid ? components.find((c) => c.uid === uid && !c.recurrenceId) : null;
  if (op !== 'create' && !master) throw new SourceError('이 일정을 다시 찾지 못했습니다. 새로고침한 뒤 다시 시도하세요.', 'gone');
  if (op !== 'create' && !master.etag) throw new SourceError('Google이 이 일정의 버전(ETag)을 알려 주지 않아 안전하게 바꿀 수 없습니다.', 'no-etag');

  let expect = null;
  if (op === 'create') {
    const made = await client.insertEvent(calendarId, resourceOf(fields, zone));
    if (!made?.id) throw new SourceError('Google이 새 일정의 번호를 알려 주지 않았습니다. Google 캘린더에서 확인하세요.', 'no-id');
    uid = String(made.id);
    expect = fields;
  } else if (op === 'edit') {
    const original = componentFields(master);
    const changes = diffFields(original, fields);
    if (!Object.keys(changes).length) return { uid, applied: true, unchanged: true, expect: original };
    try {
      await client.patchEvent(calendarId, uid, patchOf(changes, zone), { ifMatch: master.etag });
    } catch (err) {
      if (err.code === 'http-404' || err.code === 'http-410') throw new SourceError('다른 곳에서 이 일정이 삭제되었습니다.', 'gone');
      throw err;
    }
    expect = { ...original, ...fields };
  } else if (op === 'delete') {
    await client.deleteEvent(calendarId, uid, { ifMatch: master.etag });
  } else {
    throw new SourceError('알 수 없는 작업입니다.', 'bad-op');
  }
  return { uid, applied: await verify(client, calendarId, uid, expect, source.email), expect };
}

/** Reads the event back: it holds what was written (or is gone, null expect). Could not check = not confirmed. */
async function verify(client, calendarId, uid, expect, account) {
  let now;
  try {
    now = await client.getEvent(calendarId, uid);
  } catch {
    return false;
  }
  if (!expect) return !now;
  const comp = now && componentOf(now, calendarId, account);
  return Boolean(comp) && fingerprint(componentFields(comp)) === fingerprint(expect);
}

module.exports = { writeGoogle, resourceOf, patchOf, timesOf };
