// Writes run in the background (#63): until the server has answered, the widget shows what the user asked
// for. An overlay is { id, op: 'create'|'edit'|'delete', sourceId, calendarId, uid, fields?, color, sourceName,
// title }; overlays are applied in the order they were made, on top of the events read from the server.
// When a write ends the overlay is dropped and the server's state (read again) is what shows.
const { eventRange } = require('./ical');

/** The overlay's event in the normalized shape, marked pending and read-only until the write is done. */
function overlayEvent(o) {
  const f = o.fields;
  const base = {
    uid: o.uid,
    sourceId: o.sourceId,
    calendarId: o.calendarId,
    title: f.title,
    location: f.location || '',
    description: f.description || '',
    url: '',
    recurrenceId: null,
    readOnly: true,
    readOnlyReason: '저장 중입니다. 서버가 답하면 다시 바꿀 수 있습니다.',
    color: o.color,
    sourceName: o.sourceName,
    pending: true,
  };
  if (f.allDay) return { ...base, allDay: true, start: f.start, end: f.end };
  return { ...base, allDay: false, start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString() };
}

const same = (e, o) => e.uid === o.uid && e.sourceId === o.sourceId && e.calendarId === o.calendarId;

/** Events of [fromMs, toMs) with the overlays applied: edits/creates in their new form, deletes gone. */
function applyOverlays(events, overlays, fromMs, toMs) {
  let out = events;
  for (const o of overlays) {
    if (o.op === 'delete' || o.op === 'edit') out = out.filter((e) => !same(e, o));
    if (o.op === 'create' || o.op === 'edit') {
      const e = overlayEvent(o);
      const [s, en] = eventRange(e);
      if (s < toMs && (en > fromMs || (en === s && s >= fromMs))) out = [...out, e];
    }
  }
  return out;
}

/**
 * Runs jobs one after another per key (one event), different keys in parallel: an edit and then a delete of
 * the same event reach the server in that order. run() resolves with the job's result; a job that throws does
 * not stop the jobs queued after it.
 */
function createQueue() {
  const tails = new Map();
  return {
    run(key, job) {
      const prev = tails.get(key) || Promise.resolve();
      const result = prev.then(() => job());
      const tail = result.catch(() => {});
      tails.set(key, tail);
      tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    get size() {
      return tails.size;
    },
  };
}

module.exports = { overlayEvent, applyOverlays, createQueue };
