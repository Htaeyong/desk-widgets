// Settings file shape of the calendar widget: defaults and sanitizing (also of the subscription list).
const crypto = require('crypto');
const { PROVIDERS, PROVIDER_IDS } = require('./providers');
const { checkServer } = require('./caldav');
const { googleIdOf } = require('./google-api');

// Themes are packages on the engine's theme host (#61, widgets/calendar/themes/<id>/). Before that the two
// built-in looks lived in the widget (#52, #54) and saved windowBounds { compact, month } and opacity { id: % };
// those keys stay (an older widget version still finds them) and upgrade() copies them to the host's keys.
const DEFAULT_THEME = 'default';
const LAYOUTS = ['compact', 'month'];
const BUILTIN_THEMES = [
  { id: 'default', opacity: 80, boundsKey: 'main', layout: 'compact' },
  { id: 'big', opacity: 84, boundsKey: 'big/main', layout: 'month' },
];
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Colors given to new subscriptions in turn.
const PALETTE = ['#4f8cff', '#3ccf8e', '#ff9f43', '#ff6b6b', '#a78bfa', '#2dd4bf', '#f472b6', '#facc15'];
const SOURCE_TYPES = ['ics', 'caldav', 'google'];
const MAX_SOURCES = 30;
const MAX_CALENDARS = 50;

const DEFAULTS = {
  weekStart: 0, // 0 = Sunday (Korean wall calendars), 1 = Monday
  refreshMinutes: 15,
  upcomingDays: 7,
  alwaysOnTop: false,
  themeId: DEFAULT_THEME, // a theme package id (#61): 'default' (기본), 'big' (큰 달력) or a user theme
  themeOpacity: {}, // #61: background opacity in % per theme id, kept by the engine's theme host (#55)
  themeBounds: {}, // #61: window bounds per host key ('main', 'big/main', ...)
  themeFrames: [],
  opacity: {}, // #54: background opacity in % per theme id; missing = the theme's default
  windowBounds: Object.fromEntries(LAYOUTS.map((l) => [l, null])), // per layout (#52)
  sources: [],
  localEnabled: true,
  todoIntegration: false,
  // #111: due dates of 할 일 노트 (todonote). On by default: nothing
  // shows until 할 일 노트 itself shares them (its own switch, off by default, #94).
  notesIntegration: true,
  // Colours of the to-do overlays on the calendar (user-chosen; were fixed before).
  notesColor: '#e8b923',
  todoColor: '#f7ad52',
  completedTodos: 'hide',
  newEventAllDay: false, // #78: the new-event window opens with 종일 checked
  // #76 D-day. Shown by default (nothing appears until one is made). Reminders are a per-PC switch (not synced),
  // so two PCs do not both show the same card.
  ddayEnabled: true,
  ddayMax: 3, // rows of the default theme's D-day line (1-10)
  ddayArchiveDays: 7, // a one-time D-day moves to the archive this many days after its date (0 = never)
  ddayRemind: false,
  lastCalendar: null, // { sourceId, calendarId } last used in the event editor (#48)
};

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** http(s) or webcal(s) subscription address -> https/http URL string, or null when it is not one. */
function normalizeUrl(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  text = text.replace(/^webcals?:\/\//i, 'https://');
  try {
    const u = new URL(text);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const newId = () => `s${crypto.randomBytes(5).toString('hex')}`;

const httpsUrl = (v) => {
  try {
    const u = new URL(String(v || ''));
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};

/** Calendars chosen for a CalDAV account (ids are the collection URLs found by discovery). */
function sanitizeCalendars(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const id = c && httpsUrl(c.id);
    if (!id || out.some((x) => x.id === id)) continue;
    out.push({
      id,
      name: String(c.name || '').trim().slice(0, 100) || '캘린더',
      color: isColor(c.color) ? c.color.toLowerCase() : PALETTE[out.length % PALETTE.length],
      enabled: c.enabled !== false,
      canWrite: c.canWrite === true ? true : c.canWrite === false ? false : null,
    });
    if (out.length >= MAX_CALENDARS) break;
  }
  return out;
}

/** A CalDAV account entry (no password here: lib/secrets.js); null when it cannot be used. */
function sanitizeCalDav(s, index) {
  const provider = PROVIDER_IDS.includes(s.provider) ? s.provider : null;
  const username = String(s.username || '').trim().slice(0, 200);
  if (!provider || !username) return null;
  let server = '';
  if (PROVIDERS[provider].server !== 'fixed' && String(s.server || '').trim()) {
    const checked = checkServer(s.server);
    if (checked.error) return null;
    server = checked.url;
  }
  if (PROVIDERS[provider].server === 'required' && !server) return null;
  return {
    id: typeof s.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(s.id) ? s.id : newId(),
    type: 'caldav',
    name: String(s.name || '').trim().slice(0, 60) || PROVIDERS[provider].label,
    provider,
    server: server || PROVIDERS[provider].baseUrl,
    username,
    color: isColor(s.color) ? s.color.toLowerCase() : PALETTE[index % PALETTE.length],
    enabled: s.enabled !== false,
    calendars: sanitizeCalendars(s.calendars),
  };
}

const EMAIL = /^[^\s@<>"]{1,100}@[a-z0-9.-]{1,100}\.[a-z]{2,}$/i;

/** A Google account entry (#114): the email and its calendars (Calendar API URLs); no token here. */
function sanitizeGoogle(s, index) {
  const email = String(s.email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) return null;
  return {
    id: typeof s.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(s.id) ? s.id : newId(),
    type: 'google',
    name: String(s.name || '').trim().slice(0, 60) || 'Google',
    email,
    color: isColor(s.color) ? s.color.toLowerCase() : PALETTE[index % PALETTE.length],
    enabled: s.enabled !== false,
    calendars: sanitizeCalendars(s.calendars).filter((c) => googleIdOf(c.id)),
  };
}

/** One source entry; null when it cannot be used (ICS: no valid URL; CalDAV: no provider/user/server; Google: no email). */
function sanitizeSource(s, index = 0) {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'caldav') return sanitizeCalDav(s, index);
  if (s.type === 'google') return sanitizeGoogle(s, index);
  const url = normalizeUrl(s.url);
  if (!url) return null;
  return {
    id: typeof s.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(s.id) ? s.id : newId(),
    type: 'ics',
    name: String(s.name || '').trim().slice(0, 60) || new URL(url).hostname,
    url,
    color: isColor(s.color) ? s.color.toLowerCase() : PALETTE[index % PALETTE.length],
    enabled: s.enabled !== false,
  };
}

function sanitizeSources(list) {
  const out = [];
  const ids = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    const clean = sanitizeSource(s, out.length);
    if (!clean) continue;
    while (ids.has(clean.id)) clean.id = newId();
    ids.add(clean.id);
    out.push(clean);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

const isBounds = (b) => Boolean(b) && typeof b === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]));
const pickBounds = (b) => (isBounds(b) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null);

/** Bounds per layout. Before #52 the file held one bounds object: that is the compact (기본) layout's. */
function sanitizeBounds(value) {
  const src = isBounds(value) ? { compact: value } : value && typeof value === 'object' ? value : {};
  return Object.fromEntries(LAYOUTS.map((l) => [l, pickBounds(src[l])]));
}

/** { themeId: 0-100 } for known themes only; other keys and non-numbers are dropped (= theme default). */
function sanitizeOpacity(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const t of BUILTIN_THEMES) {
    const v = value[t.id];
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[t.id] = Math.min(100, Math.max(0, Math.round(n)));
  }
  return out;
}

/** The background opacity (%) a theme shows with: the user's value or the theme default. */
function opacityOf(settings, themeId) {
  const theme = BUILTIN_THEMES.find((t) => t.id === themeId) || BUILTIN_THEMES[0];
  const v = settings?.opacity?.[theme.id];
  return Number.isFinite(v) ? v : theme.opacity;
}

/** Runs on the raw file before defaults are merged (the store merges nested defaults into an old flat bounds object). */
function upgrade(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let out = raw.windowBounds !== undefined ? { ...raw, windowBounds: sanitizeBounds(raw.windowBounds) } : raw;
  // #61 (theme-host-design 6.3), once: the widget's own opacity / layout bounds become the theme host's keys.
  if (out.themeOpacity === undefined && out.opacity && typeof out.opacity === 'object') {
    out = { ...out, themeOpacity: sanitizeOpacity(out.opacity) };
  }
  if (out.themeBounds === undefined && out.windowBounds) {
    const bounds = {};
    for (const t of BUILTIN_THEMES) if (out.windowBounds[t.layout]) bounds[t.boundsKey] = out.windowBounds[t.layout];
    out = { ...out, themeBounds: bounds };
  }
  return out;
}

function sanitize(next) {
  return {
    ...next,
    weekStart: Number(next.weekStart) === 1 ? 1 : 0,
    refreshMinutes: clampInt(next.refreshMinutes, 5, 1440, DEFAULTS.refreshMinutes),
    upcomingDays: clampInt(next.upcomingDays, 1, 31, DEFAULTS.upcomingDays),
    alwaysOnTop: Boolean(next.alwaysOnTop),
    themeId: THEME_ID.test(String(next.themeId || '')) ? next.themeId : DEFAULT_THEME,
    windowBounds: sanitizeBounds(next.windowBounds),
    opacity: sanitizeOpacity(next.opacity),
    sources: sanitizeSources(next.sources),
    localEnabled: next.localEnabled !== false,
    todoIntegration: next.todoIntegration === true,
    notesIntegration: next.notesIntegration !== false,
    notesColor: isColor(next.notesColor) ? next.notesColor.toLowerCase() : DEFAULTS.notesColor,
    todoColor: isColor(next.todoColor) ? next.todoColor.toLowerCase() : DEFAULTS.todoColor,
    completedTodos: next.completedTodos === 'show' ? 'show' : 'hide',
    newEventAllDay: next.newEventAllDay === true,
    ddayEnabled: next.ddayEnabled !== false,
    ddayMax: clampInt(next.ddayMax, 1, 10, DEFAULTS.ddayMax),
    ddayArchiveDays: clampInt(next.ddayArchiveDays, 0, 365, DEFAULTS.ddayArchiveDays),
    ddayRemind: next.ddayRemind === true,
    lastCalendar:
      next.lastCalendar && typeof next.lastCalendar.sourceId === 'string' && typeof next.lastCalendar.calendarId === 'string'
        ? { sourceId: next.lastCalendar.sourceId.slice(0, 40), calendarId: next.lastCalendar.calendarId.slice(0, 2000) }
        : null,
  };
}

module.exports = { DEFAULT_THEME, BUILTIN_THEMES, sanitizeOpacity, opacityOf, sanitizeBounds, upgrade, DEFAULTS, PALETTE, SOURCE_TYPES, MAX_SOURCES, MAX_CALENDARS, newId, normalizeUrl, sanitizeSource, sanitizeCalendars, sanitizeSources, sanitize };
