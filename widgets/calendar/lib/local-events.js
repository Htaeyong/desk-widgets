// Locally owned events. They never leave this widget or become CalDAV/ICS writes.
const crypto = require('crypto');
const path = require('path');
const { validateFields } = require('./event-fields');

const SOURCE_ID = 'local';
const CALENDAR_ID = 'local';
const MAX_EVENTS = 10000;
const COLOR = '#4f8cff';
const rangeStart = (e) => e.allDay ? new Date(`${e.start}T00:00:00`).getTime() : e.start;
const rangeEnd = (e) => e.allDay ? new Date(`${e.end}T00:00:00`).getTime() : e.end;

/**
 * The uid of the copy "일정 유지" makes of a note's deadline (#128). The same note and due always give the same uid:
 * a repeated request cannot make a second copy, and the calendar can tell the copy of a note that came back.
 */
const keepUid = (task) => `local:${crypto.createHash('sha256').update(`note-keep:${task.id}:${task.dueAt}:${task.dateOnly === true}`).digest('hex').slice(0, 24)}`;

function sanitize(raw) {
  const events = [];
  for (const item of Array.isArray(raw?.events) ? raw.events : []) {
    if (!item || !/^local:[a-f0-9]{24}$/.test(String(item.uid)) || events.some((e) => e.uid === item.uid)) continue;
    const check = validateFields(item);
    if (check.error) continue;
    events.push({ uid: item.uid, ...check.fields });
    if (events.length >= MAX_EVENTS) break;
  }
  return { events };
}

function createLocalEvents(ctx, onChange) {
  const message = (ko, en) => String(ctx.app?.locale?.() || '').startsWith('en') ? en : ko;
  const store = ctx.createStore({
    file: path.join(ctx.dataDir, 'local-events.json'), defaults: { events: [] }, sanitize,
    sync: {
      name: 'local-events',
      collections: { events: { id: 'uid' } },
      shared: [],
      describe: (_kind, value, locale) => [{ label: /^en\b/i.test(locale) ? 'Title' : '제목', text: value?.title || '' }],
    },
  });
  store.onRemoteChange?.(onChange);
  const all = () => sanitize(store.load()).events;
  const find = (uid) => all().find((e) => e.uid === uid) || null;
  const list = (from, to, locale = 'ko-KR') => all().filter((e) => rangeStart(e) < to && rangeEnd(e) > from).map((e) => ({
    ...e, sourceId: SOURCE_ID, calendarId: CALENDAR_ID, sourceName: String(locale).startsWith('en') ? 'My Calendar' : '내 캘린더',
    color: COLOR, readOnly: false, hasUrl: false,
  }));
  function write(op, uid, input) {
    const events = all();
    const index = events.findIndex((e) => e.uid === uid);
    if (op !== 'create' && index < 0) return { ok: false, message: message('일정을 찾지 못했습니다.', 'Event not found.') };
    if (op === 'delete') events.splice(index, 1);
    else {
      const checked = validateFields(input);
      if (checked.error) return { ok: false, message: checked.error };
      if (op === 'create') {
        if (events.length >= MAX_EVENTS) return { ok: false, message: message('로컬 일정을 더 만들 수 없습니다.', 'The local calendar is full.') };
        uid = `local:${crypto.randomBytes(12).toString('hex')}`;
        events.push({ uid, ...checked.fields });
      } else events[index] = { uid, ...checked.fields };
    }
    store.save({ events });
    onChange();
    return { ok: true, uid, applied: true };
  }
  /** Stores a copy under its own uid (see keepUid); one already there stays as the user left it. */
  function keep(uid, input) {
    if (find(uid)) return { ok: true, uid, existing: true };
    const checked = validateFields(input);
    if (checked.error) return { ok: false, message: checked.error };
    const events = all();
    if (events.length >= MAX_EVENTS) return { ok: false, message: message('로컬 일정을 더 만들 수 없습니다.', 'The local calendar is full.') };
    events.push({ uid, ...checked.fields });
    store.save({ events });
    onChange();
    return { ok: true, uid, existing: false };
  }
  return { all, find, list, write, keep };
}

module.exports = { SOURCE_ID, CALENDAR_ID, COLOR, sanitize, createLocalEvents, keepUid };
