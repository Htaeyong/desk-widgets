// Calendar sources: the type registry and the manager that refreshes sources, keeps the last result of each
// in a cache file (shown instantly at start and offline) and expands cached events for a time range.
//
// A source (settings entry) is { id, type, name, color, enabled, ...type fields }.
//   ics:    { url }
//   caldav: { provider, server, username, calendars: [{ id (collection URL), name, color, enabled, canWrite }] }
//           (the password is kept encrypted apart from the settings, lib/secrets.js)
// A type is { label, writable, secret?, windowed?, fetch(source, opts) } where fetch resolves to
//   { notModified: true }  or  { validators, calendars: [{ id, name, color?, readOnly, components }], error? }
// (components are lib/ical.js parseIcs() events). opts: { fetch, prev (last validators), previous (last
// calendars), password (types with secret), window ({ from, to } ms, types with windowed) }.
//
// #48 writes (lib/writer.js): an event is editable when its type is writable, its calendar's canWrite is not
// false, and it is a plain single event of the account's own (lib/editable.js).
const fs = require('fs');
const path = require('path');
const { fetchIcs } = require('./ics-source');
const { fetchCalDav, cachedWindow, covers } = require('./caldav-source');
const { occurrences } = require('./ical');
const { readOnlyReason } = require('./editable');

const DAY = 86400000;
const MAX_WINDOW = 3 * 366 * DAY;

const TYPES = {
  ics: { label: 'ICS 구독', writable: false, fetch: (source, opts) => fetchIcs(source, opts) },
  caldav: { label: 'CalDAV 계정', writable: true, secret: true, windowed: true, fetch: (source, opts) => fetchCalDav(source, opts) },
};

/** Cache identity: a different address or account starts over (calendar on/off does not). */
const cacheKey = (source) => JSON.stringify(source.type === 'caldav' ? [source.type, source.server, source.username] : [source.type, source.url]);

/** Previous month to the month after next (displayed month ± 1 and the upcoming range), local midnights. */
function baseWindow(now = new Date()) {
  return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), to: new Date(now.getFullYear(), now.getMonth() + 2, 8).getTime() };
}

/** A window holding all ranges with a month's margin; when that is too long, only the first (the grid). */
function windowFor(ranges) {
  const lo = Math.min(...ranges.map((r) => r.from)) - 31 * DAY;
  const hi = Math.max(...ranges.map((r) => r.to)) + 31 * DAY;
  if (hi - lo <= MAX_WINDOW) return { from: lo, to: hi };
  return { from: ranges[0].from - 31 * DAY, to: ranges[0].to + 31 * DAY };
}

class SourceManager {
  /**
   * @param {{ dataDir: string, fetch?: Function, now?: () => number, onChange?: () => void, types?: object,
   *           getSecret?: (id: string) => string, onWindow?: (ids: string[]) => void }} opts
   * onWindow: the displayed range moved past what windowed sources hold; the owner refreshes those ids.
   */
  constructor({ dataDir, fetch, now = Date.now, onChange = () => {}, types = TYPES, getSecret = () => '', onWindow = null }) {
    this.dir = path.join(dataDir, 'cache');
    this.fetch = fetch;
    this.now = now;
    this.onChange = onChange;
    this.types = types;
    this.getSecret = getSecret;
    this.onWindow = onWindow || ((ids) => this.refresh(ids));
    this.sources = [];
    this.state = new Map(); // id -> { key, fetchedAt, validators, calendars, error, lastAttempt }
    this.inFlight = new Map();
    this.window = baseWindow(new Date(now()));
    this.windowTimer = null;
    this.pending = new Set();
    this.asked = new Map(); // id -> window key already requested for it (a failing server is not asked in a loop)
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  readCache(source) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(source.id), 'utf8'));
      return raw && raw.key === cacheKey(source) ? raw : null;
    } catch {
      return null;
    }
  }

  writeCache(id, st) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file(id)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st));
      fs.renameSync(tmp, this.file(id));
    } catch {
      // The cache only speeds up the next start; a failed write is not an error for the user.
    }
  }

  /** Applies the settings' source list: new sources read their cache, removed ones lose it, a changed address starts over. */
  setSources(list) {
    const ids = new Set(list.map((s) => s.id));
    for (const id of [...this.state.keys()]) {
      if (!ids.has(id)) {
        this.state.delete(id);
        fs.rmSync(this.file(id), { force: true });
      }
    }
    for (const s of list) {
      const st = this.state.get(s.id);
      if (st && st.key === cacheKey(s)) continue;
      this.state.set(s.id, this.readCache(s) || { key: cacheKey(s), fetchedAt: 0, validators: {}, calendars: [], error: null, lastAttempt: 0 });
    }
    this.sources = list;
  }

  /** Forgets one source's cache (e.g. its password changed: the next read starts clean). */
  forget(id) {
    const s = this.sources.find((x) => x.id === id);
    if (!s) return;
    fs.rmSync(this.file(id), { force: true });
    this.state.set(id, { key: cacheKey(s), fetchedAt: 0, validators: {}, calendars: [], error: null, lastAttempt: 0 });
  }

  /** Fetches the enabled sources (or the given ids); resolves when all are done. Never rejects. */
  refresh(ids = null) {
    const list = this.sources.filter((s) => s.enabled && (!ids || ids.includes(s.id)));
    return Promise.all(list.map((s) => this.refreshOne(s)));
  }

  refreshOne(source) {
    if (this.inFlight.has(source.id)) return this.inFlight.get(source.id);
    const run = this.doRefresh(source).finally(() => this.inFlight.delete(source.id));
    this.inFlight.set(source.id, run);
    this.onChange();
    return run;
  }

  async doRefresh(source) {
    const type = this.types[source.type];
    const st = this.state.get(source.id);
    if (!type || !st) return;
    const key = st.key;
    let next;
    try {
      const opts = { fetch: this.fetch, prev: st.validators || {}, previous: st.calendars || [] };
      if (type.secret) opts.password = this.getSecret(source.id);
      if (type.windowed) opts.window = { ...this.window };
      const res = await type.fetch(source, opts);
      next = res.notModified
        ? { ...st, error: null, lastAttempt: this.now(), fetchedAt: this.now() }
        : { key, validators: res.validators || {}, calendars: res.calendars || [], error: res.error || null, lastAttempt: this.now(), fetchedAt: this.now() };
    } catch (err) {
      next = { ...st, error: String(err?.message || err).slice(0, 500), errorCode: err?.code || null, lastAttempt: this.now() };
    }
    // The source may have been removed or changed while the request ran.
    if (this.state.get(source.id)?.key !== key) return;
    this.state.set(source.id, next);
    this.writeCache(source.id, next);
    this.onChange();
  }

  get refreshing() {
    return this.inFlight.size > 0;
  }

  /**
   * The page shows these ranges: when a windowed source's cache does not hold them, widen the window and
   * ask for a refresh of those sources (debounced; a refresh in flight is not repeated).
   */
  ensureWindow(ranges) {
    const valid = ranges.filter((r) => r && Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from);
    if (!valid.length) return;
    const stale = this.sources.filter((s) => {
      if (!s.enabled || !this.types[s.type]?.windowed || this.inFlight.has(s.id)) return false;
      const st = this.state.get(s.id);
      if (!st?.fetchedAt && !st?.lastAttempt) return false; // its first refresh is coming anyway
      const held = cachedWindow(st.validators, s);
      return !valid.every((r) => covers(held, r));
    });
    if (!valid.every((r) => covers(this.window, r))) this.window = windowFor(valid);
    const key = `${this.window.from}-${this.window.to}`;
    const ids = stale.map((s) => s.id).filter((id) => this.asked.get(id) !== key);
    if (!ids.length) return;
    for (const id of ids) {
      this.asked.set(id, key);
      this.pending.add(id);
    }
    clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => {
      const list = [...this.pending];
      this.pending.clear();
      this.onWindow(list);
    }, 300);
  }

  /** Normalized events of enabled sources (and calendars) overlapping [fromMs, toMs), each with its calendar's color. */
  events(fromMs, toMs) {
    const out = [];
    for (const s of this.sources) {
      if (!s.enabled) continue;
      const st = this.state.get(s.id);
      const writable = Boolean(this.types[s.type]?.writable);
      for (const cal of st?.calendars || []) {
        const conf = s.calendars?.find((c) => c.id === cal.id);
        if (s.calendars && (!conf || conf.enabled === false)) continue;
        const color = conf?.color || cal.color || s.color;
        const comps = cal.components || [];
        const list = occurrences(comps, fromMs, toMs, { sourceId: s.id, calendarId: cal.id, readOnly: true });
        const sourceName = s.type === 'caldav' ? `${s.name} · ${conf?.name || cal.name}` : s.name;
        const reasons = new Map();
        for (const e of list) {
          if (!reasons.has(e.uid)) reasons.set(e.uid, readOnlyReason({ writable, source: s, calendar: conf || cal, components: comps, uid: e.uid }));
          const reason = reasons.get(e.uid);
          out.push({ ...e, color, sourceName, readOnly: Boolean(reason), readOnlyReason: reason });
        }
      }
    }
    return out;
  }

  /** Per-source status for the settings window and the widget footer. */
  status() {
    return this.sources.map((s) => {
      const st = this.state.get(s.id) || {};
      return {
        id: s.id,
        fetchedAt: st.fetchedAt || 0,
        lastAttempt: st.lastAttempt || 0,
        error: s.enabled ? st.error || null : null,
        errorCode: s.enabled && st.error ? st.errorCode || null : null,
        calendarName: st.calendars?.[0]?.name || '',
        count: (st.calendars || []).reduce((n, c) => n + (c.components?.length || 0), 0),
        refreshing: this.inFlight.has(s.id),
      };
    });
  }

  /** Oldest successful fetch among enabled sources (0 when one never succeeded). */
  lastUpdated() {
    const times = this.sources.filter((s) => s.enabled).map((s) => this.state.get(s.id)?.fetchedAt || 0);
    return times.length ? Math.min(...times) : 0;
  }

  /** Refreshes one source after a write: waits for a read already running (it may predate the write), then reads. */
  async refreshAfterWrite(id) {
    if (this.inFlight.has(id)) await this.inFlight.get(id);
    const s = this.sources.find((x) => x.id === id);
    if (s?.enabled) await this.refreshOne(s);
  }

  /** Cached components of one calendar (for writes). */
  components(sourceId, calendarId) {
    return this.state.get(sourceId)?.calendars?.find((c) => c.id === calendarId)?.components || [];
  }

  /** Makes the next refresh read this calendar again (after a write), even if its change tag looks the same. */
  invalidateCalendar(sourceId, calendarId) {
    const st = this.state.get(sourceId);
    if (st?.validators?.tags) delete st.validators.tags[calendarId];
  }

  stop() {
    clearTimeout(this.windowTimer);
    this.windowTimer = null;
  }
}

module.exports = { TYPES, SourceManager, cacheKey, baseWindow, windowFor };
