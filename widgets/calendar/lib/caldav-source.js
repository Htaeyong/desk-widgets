// CalDAV account source: one account = several calendars. Writes (#48) are in lib/writer.js.
// Each refresh reads the enabled calendars' change tags first and reuses the cached events of a calendar
// whose tag did not change and whose cached window covers the one asked for.
const { CalDavClient } = require('./caldav');
const { PROVIDERS } = require('./providers');
const { parseIcs } = require('./ical');
const { SourceError } = require('./http');

const covers = (w, need) => Boolean(w && need && w.from <= need.from && w.to >= need.to);

/**
 * Components of the read resources, each knowing where it lives ({ href, etag }) so it can be edited (#48).
 * A resource holding events with different UIDs is marked shared: writing it would touch the others too.
 */
function componentsOf(resources) {
  return resources.flatMap((r) => {
    const events = parseIcs(r.ics).events;
    const shared = new Set(events.map((e) => e.uid)).size > 1;
    return events.map((e) => ({ ...e, href: r.href || null, etag: r.etag || null, shared }));
  });
}

/**
 * source: { provider, server, username, calendars: [{ id (collection URL), name, color, enabled, canWrite }] }.
 * opts: { fetch, prev: { tags, windows }, previous: last calendars [{ id, components }], password, window: { from, to } }.
 * Resolves { validators, calendars, error? }; throws when the account cannot be read at all (auth, network).
 */
async function fetchCalDav(source, { fetch, prev = {}, previous = [], password, window, Client = CalDavClient } = {}) {
  if (!password) throw new SourceError('저장된 비밀번호가 없습니다. 설정에서 이 계정의 연결 확인을 다시 하세요.', 'no-secret');
  if (!window) throw new SourceError('읽을 기간이 없습니다.', 'no-window');
  const client = new Client({ username: source.username, password, fetch, authHint: PROVIDERS[source.provider]?.authHint });
  const tags = {};
  const windows = {};
  const calendars = [];
  const errors = [];
  const enabled = (source.calendars || []).filter((c) => c.enabled !== false);
  for (const cal of enabled) {
    const before = previous.find((p) => p.id === cal.id);
    try {
      const tag = await client.collectionTag(cal.id);
      const oldWindow = prev.windows?.[cal.id];
      if (tag && before && prev.tags?.[cal.id] === tag && covers(oldWindow, window)) {
        tags[cal.id] = tag;
        windows[cal.id] = oldWindow;
        calendars.push({ ...before, name: cal.name, readOnly: cal.canWrite === false });
        continue;
      }
      const resources = await client.readResources(cal.id, window.from, window.to);
      if (tag) tags[cal.id] = tag;
      windows[cal.id] = { ...window };
      calendars.push({ id: cal.id, name: cal.name, readOnly: cal.canWrite === false, components: componentsOf(resources) });
    } catch (err) {
      // A login problem concerns the whole account; one calendar's failure keeps the others (and its old events).
      if (err.code === 'auth' || err.code === 'untrusted' || err.code === 'network' || err.code === 'timeout') throw err;
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

/** The window the account's cache holds (the narrowest of its calendars), for "is a refetch needed". */
function cachedWindow(validators, source) {
  const ids = (source.calendars || []).filter((c) => c.enabled !== false).map((c) => c.id);
  let out = null;
  for (const id of ids) {
    const w = validators?.windows?.[id];
    if (!w) return null;
    out = out ? { from: Math.max(out.from, w.from), to: Math.min(out.to, w.to) } : { ...w };
  }
  return out;
}

module.exports = { fetchCalDav, cachedWindow, covers, componentsOf };
