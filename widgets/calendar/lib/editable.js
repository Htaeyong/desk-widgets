// Which events the widget lets the user change (#48), and why not. Read-only in this version:
//   - ICS subscriptions, and calendars the server reports without write privilege;
//   - recurring events (RRULE / RDATE, or a series with RECURRENCE-ID overrides): changing one instance
//     or the series needs exception handling this version does not write;
//   - meetings someone else organizes (ORGANIZER is not the account, with attendees): the organizer owns them;
//   - events sharing a resource with other events, or without a server address / version (ETag).

/** Whether an ORGANIZER value names the account (email, or the id part of it for accounts without "@"). */
function isMe(organizer, username) {
  const org = String(organizer || '').replace(/^mailto:/i, '').trim().toLowerCase();
  const user = String(username || '').trim().toLowerCase();
  if (!org || !user) return false;
  if (org === user) return true;
  return !user.includes('@') && org.split('@')[0] === user;
}

/**
 * Korean reason the event cannot be changed here, or null when it can.
 * opts: { writable (type), source, calendar ({ canWrite? , readOnly? }), components (the calendar's), uid }.
 */
function readOnlyReason({ writable, source, calendar, components, uid }) {
  if (!writable) return '구독(ICS) 캘린더는 읽기 전용입니다.';
  if (calendar?.canWrite === false || calendar?.readOnly === true) return '쓰기 권한이 없는 캘린더입니다.';
  const same = components.filter((c) => c.uid === uid);
  const master = same.find((c) => !c.recurrenceId);
  if (!master || same.length > 1 || master.rrule || master.rdates?.length || master.recurrenceId) {
    return '반복 일정은 여기서 바꿀 수 없습니다. 원래 캘린더 앱에서 바꾸세요.';
  }
  if (master.organizer && master.attendees > 0 && !isMe(master.organizer, source?.username || source?.email)) {
    return '다른 사람이 보낸 회의 초대는 여기서 바꿀 수 없습니다. 원래 캘린더 앱에서 바꾸세요.';
  }
  // Google event types that are not plain events (#114, lib/google-source.js).
  if (master.locked) return master.locked;
  if (master.shared) return '다른 일정과 한 파일에 묶여 있어 여기서 바꿀 수 없습니다.';
  if (!master.href || !master.etag) return '서버가 이 일정의 주소나 버전(ETag)을 알려 주지 않아 안전하게 바꿀 수 없습니다.';
  return null;
}

module.exports = { isMe, readOnlyReason };
