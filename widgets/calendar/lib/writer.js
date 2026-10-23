// Event writes on CalDAV calendars (#48): create, edit, delete, each conditional and then verified.
//   create: new UID, resource named by the percent-encoded UID, PUT with If-None-Match: *
//   edit:   fresh GET of the server's document; if its ETag is not the one the user saw, someone changed it ->
//           conflict; otherwise merge only the changed properties (lib/ical-write.js) and PUT with If-Match
//   delete: DELETE with If-Match (already gone counts as done)
// A 2xx is not trusted on its own (Dooray answered 2xx and stored nothing, my_calendar_sync #100/#106): the
// calendar is listed again (calendar-query, not a GET of the resource, which Dooray echoes) and the write
// counts as applied only when the event's content matches what was written (or is gone, for a delete).
// Nothing is retried, deleted and recreated, or written without a condition to force a change through.
const crypto = require('crypto');
const { CalDavClient, sameService } = require('./caldav');
const { PROVIDERS } = require('./providers');
const { componentFields, timeMs } = require('./ical');
const { serializeNew, mergeEdit, fingerprint } = require('./ical-write');
const { componentsOf } = require('./caldav-source');
const { diffFields } = require('./event-fields');
const { SourceError } = require('./http');

const DAY = 86400000;

/** [from, to] ms of event fields. */
function rangeOf(f) {
  if (f.allDay) return [timeMs({ allDay: true, date: f.start }), timeMs({ allDay: true, date: f.end })];
  return [f.start, f.end];
}

const newUid = () => `${crypto.randomUUID()}@desk-widgets`;
const resourceUrl = (calendarUrl, uid) => `${calendarUrl.replace(/\/+$/, '')}/${encodeURIComponent(uid)}.ics`;

/**
 * op: 'create' | 'edit' | 'delete'. source: the CalDAV account; calendarId: collection URL; components: the
 * calendar's cached components (edit/delete find the event's href/etag there); fields: validated editor values.
 * Resolves { uid, applied, unchanged?, expect } — applied false = sent but not confirmed by the server's listing.
 * Throws SourceError ('conflict' when it changed elsewhere, 'gone', 'auth', ...).
 */
async function writeEvent({ op, source, calendarId, uid, fields, components = [], password, fetch, now = Date.now(), Client = CalDavClient }) {
  if (!password) throw new SourceError('저장된 비밀번호가 없습니다. 설정에서 이 계정의 연결 확인을 다시 하세요.', 'no-secret');
  const client = new Client({ username: source.username, password, fetch, authHint: PROVIDERS[source.provider]?.authHint });
  const master = uid ? components.find((c) => c.uid === uid && !c.recurrenceId) : null;
  if (op !== 'create') {
    if (!master) throw new SourceError('이 일정을 다시 찾지 못했습니다. 새로고침한 뒤 다시 시도하세요.', 'gone');
    if (!master.href || !sameService(calendarId, master.href)) throw new SourceError('이 일정의 서버 주소가 계정 서버와 달라 바꾸지 않았습니다.', 'untrusted');
  }

  let expect = null;
  let ranges = [];
  if (op === 'create') {
    uid = newUid();
    await client.putResource(resourceUrl(calendarId, uid), serializeNew(uid, fields, now), { ifNoneMatch: '*' });
    expect = fields;
    ranges = [rangeOf(fields)];
  } else if (op === 'edit') {
    const original = componentFields(master);
    const changes = diffFields(original, fields);
    if (!Object.keys(changes).length) return { uid, applied: true, unchanged: true, expect: original };
    const current = await client.getResource(master.href);
    if (!current) throw new SourceError('다른 곳에서 이 일정이 삭제되었습니다.', 'gone');
    if (current.etag && master.etag && current.etag !== master.etag) {
      throw new SourceError('다른 곳(다른 기기나 캘린더 앱)에서 이 일정이 바뀌었습니다. 새로 받은 내용을 확인한 뒤 다시 시도하세요.', 'conflict', 412);
    }
    const merged = mergeEdit(current.ics, uid, changes, now);
    if (!merged) throw new SourceError('서버의 일정 파일 구조가 예상과 달라 바꾸지 않았습니다.', 'no-merge');
    await client.putResource(master.href, merged, { ifMatch: current.etag || master.etag });
    expect = { ...original, ...fields };
    ranges = [rangeOf(original), rangeOf(fields)];
  } else if (op === 'delete') {
    await client.deleteResource(master.href, { ifMatch: master.etag });
    ranges = [rangeOf(componentFields(master))];
  } else {
    throw new SourceError('알 수 없는 작업입니다.', 'bad-op');
  }

  const applied = await verify(client, calendarId, uid, expect, ranges);
  return { uid, applied, expect };
}

/** Lists the calendar around the event and checks that the server holds what was written (null expect = gone). */
async function verify(client, calendarId, uid, expect, ranges) {
  const from = Math.min(...ranges.map((r) => r[0])) - DAY;
  const to = Math.max(...ranges.map((r) => r[1])) + DAY;
  let comps;
  try {
    comps = componentsOf(await client.readResources(calendarId, from, to));
  } catch {
    return false; // could not check = not confirmed
  }
  const found = comps.find((c) => c.uid === uid && !c.recurrenceId);
  if (!expect) return !found;
  return Boolean(found) && fingerprint(componentFields(found)) === fingerprint(expect);
}

/** Whether cached components now show what a write expected (null = gone), for clearing "반영 확인 안 됨". */
function satisfied(components, uid, expect) {
  const found = components.find((c) => c.uid === uid && !c.recurrenceId);
  if (!expect) return !found;
  return Boolean(found) && fingerprint(componentFields(found)) === fingerprint(expect);
}

module.exports = { writeEvent, verify, satisfied, resourceUrl, newUid, rangeOf };
