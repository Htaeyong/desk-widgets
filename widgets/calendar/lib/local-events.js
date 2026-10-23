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
  const store = ctx.createStore({ file: path.join(ctx.dataDir, 'local-events.json'), defaults: { events: [] }, sanitize });
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
  return { all, find, list, write };
}

module.exports = { SOURCE_ID, CALENDAR_ID, COLOR, sanitize, createLocalEvents };
