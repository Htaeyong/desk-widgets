// Checks the editor's values (#48) in the main process; messages are shown in the widget's editor.
// fields: { title, allDay, start, end, location, description } where all-day start/end are 'YYYY-MM-DD'
// (end exclusive) and timed start/end are instants in ms.
const DAY = 86400000;
const MAX_SPAN = 366 * DAY;

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** Returns { fields } (cleaned) or { error } (Korean). */
function validateFields(input = {}) {
  const title = String(input.title ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) return { error: '제목을 넣으세요.' };
  if (title.length > 300) return { error: '제목은 300자까지입니다.' };
  const location = String(input.location ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (location.length > 300) return { error: '장소는 300자까지입니다.' };
  const description = String(input.description ?? '').replace(/\s+$/, '');
  if (description.length > 4000) return { error: '설명은 4000자까지입니다.' };
  const allDay = input.allDay === true;
  if (allDay) {
    if (!isDate(input.start) || !isDate(input.end)) return { error: '날짜가 올바르지 않습니다.' };
    const span = Date.parse(`${input.end}T00:00:00Z`) - Date.parse(`${input.start}T00:00:00Z`);
    if (span <= 0) return { error: '끝 날짜가 시작 날짜보다 앞설 수 없습니다.' };
    if (span > MAX_SPAN) return { error: '일정은 1년까지 만들 수 있습니다.' };
    return { fields: { title, allDay, start: input.start, end: input.end, location, description } };
  }
  const start = Number(input.start);
  const end = Number(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: '날짜와 시간을 넣으세요.' };
  if (end <= start) return { error: '끝 시간이 시작 시간보다 뒤여야 합니다.' };
  if (end - start > MAX_SPAN) return { error: '일정은 1년까지 만들 수 있습니다.' };
  return { fields: { title, allDay, start: Math.round(start / 60000) * 60000, end: Math.round(end / 60000) * 60000, location, description } };
}

/** What changed between the event's current fields and the edited ones: { title?, location?, description?, time? }. */
function diffFields(original, next) {
  const changes = {};
  if (String(original.title || '').trim() !== next.title) changes.title = next.title;
  if (String(original.location || '').trim() !== next.location) changes.location = next.location;
  if (String(original.description || '').replace(/\s+$/, '') !== next.description) changes.description = next.description;
  if (original.allDay !== next.allDay || original.start !== next.start || original.end !== next.end) {
    changes.time = { allDay: next.allDay, start: next.start, end: next.end };
  }
  return changes;
}

module.exports = { validateFields, diffFields };
