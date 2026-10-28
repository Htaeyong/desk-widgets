// Dooray widget settings in <userData>/widgets/dooray/settings.json.
// The API token is encrypted with the OS keychain (DPAPI on Windows) via safeStorage, and never stored as
// plain text: without OS encryption a new token is refused (#97).
// The store comes from the engine (ctx.createStore): a widget is installed apart from the engine
// and must not require engine files.
const path = require('path');

/** Clamps a number into [min, max]; falls back when it is not a number. */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

const DEFAULTS = {
  doorayDomain: '',
  apiBase: 'https://api.dooray.com',
  pollIntervalSec: 45,
  alwaysOnTop: false,
  themeId: 'glass',
  hiddenProjectIds: [],
  dueSoonDays: 3,
  // Which changes become notification cards
  notifyEnabled: true,
  notifyTypes: { mention: true, assigned: true, comment: true, created: true, status: true, closed: true, overdue: true, 'comment-edit': false },
  // Which tasks count as "mine" for status/closed/overdue/comment notifications
  notifyScope: { assignee: true, cc: true, author: true },
  // Window positions keyed by 'overview' or 'project:<id>' (per theme layout, see ThemeWindows)
  windowBounds: {},
  // Project dashboards detached into their own widget windows
  projectWidgets: [],
  // User-defined project order (ids); projects not listed go last
  projectOrder: [],
  // Background opacity in % per theme id (#55); a theme without an entry uses its theme.json default
  themeOpacity: {},
  todoIntegration: false,
  // #111: where "할 일에 추가" goes when both 할 일 노트 and the to-do list widget can take it.
  todoTarget: 'todonote',
};

const LIMITS = { MIN_POLL_SEC: 15, MAX_POLL_SEC: 3600, MAX_DUE_SOON_DAYS: 30 };

const TOKEN_UNAVAILABLE_MESSAGE =
  '이 PC에서 암호화 저장(Windows 데이터 보호)을 쓸 수 없어 API 토큰을 저장하지 않았습니다. 토큰을 평문으로 저장하지 않기 때문에 이 상태에서는 두레이에 연결할 수 없습니다.';

// "https://Foo.dooray.com/" -> "foo.dooray.com"
function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function normalizeApiBase(value) {
  const v = String(value || '').trim().replace(/\/+$/, '');
  return v || DEFAULTS.apiBase;
}

function sanitizeBounds(value) {
  const out = {};
  for (const [key, b] of Object.entries(value || {})) {
    if (b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]))) {
      out[key] = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    }
  }
  return out;
}

/** { themeId: 0..100 }: valid theme ids and numbers only (the engine theme host checks again when it reads). */
function sanitizeThemeOpacity(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [id, n] of Object.entries(src).slice(0, 500)) {
    if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && typeof n === 'number' && Number.isFinite(n)) out[id] = Math.min(100, Math.max(0, Math.round(n)));
  }
  return out;
}

const flags = (defaults, value) => Object.fromEntries(Object.keys(defaults).map((k) => [k, value?.[k] !== undefined ? Boolean(value[k]) : defaults[k]]));

function sanitize(next) {
  return {
    ...next,
    doorayDomain: normalizeDomain(next.doorayDomain),
    apiBase: normalizeApiBase(next.apiBase),
    apiToken: String(next.apiToken || '').trim(),
    pollIntervalSec: clampInt(next.pollIntervalSec, LIMITS.MIN_POLL_SEC, LIMITS.MAX_POLL_SEC, DEFAULTS.pollIntervalSec),
    alwaysOnTop: Boolean(next.alwaysOnTop),
    themeId: /^[a-z0-9][a-z0-9-]{0,63}$/.test(next.themeId) ? next.themeId : DEFAULTS.themeId,
    hiddenProjectIds: [...new Set((next.hiddenProjectIds || []).map(String))],
    dueSoonDays: clampInt(next.dueSoonDays, 0, LIMITS.MAX_DUE_SOON_DAYS, DEFAULTS.dueSoonDays),
    notifyEnabled: Boolean(next.notifyEnabled),
    notifyTypes: flags(DEFAULTS.notifyTypes, next.notifyTypes),
    notifyScope: flags(DEFAULTS.notifyScope, next.notifyScope),
    windowBounds: sanitizeBounds(next.windowBounds),
    projectWidgets: (next.projectWidgets || []).filter((w) => w && w.projectId).map((w) => ({ projectId: String(w.projectId), pinned: Boolean(w.pinned) })),
    themeOpacity: sanitizeThemeOpacity(next.themeOpacity),
    todoIntegration: Boolean(next.todoIntegration),
    todoTarget: next.todoTarget === 'todo' ? 'todo' : 'todonote',
    projectOrder: [...new Set((Array.isArray(next.projectOrder) ? next.projectOrder : []).map(String))].filter((id) => /^[\w-]{1,64}$/.test(id)).slice(0, 1000),
  };
}

/**
 * @param {{ dir: string, createStore: Function, envFile?: string | null, crypto?: object }} opts
 *   createStore: ctx.createStore; envFile: development .env used to prefill a missing settings file
 */
function createDooraySettings({ dir, createStore, envFile = null, crypto }) {
  const seed = () => {
    if (!envFile) return null;
    require('dotenv').config({ path: envFile, quiet: true });
    const { DOORAY_URL, DOORAY_API_KEY, DOORAY_API_BASE, POLL_INTERVAL_SEC } = process.env;
    if (!DOORAY_URL && !DOORAY_API_KEY) return null;
    return {
      doorayDomain: normalizeDomain(DOORAY_URL),
      apiToken: DOORAY_API_KEY || '',
      apiBase: normalizeApiBase(DOORAY_API_BASE),
      pollIntervalSec: clampInt(POLL_INTERVAL_SEC, LIMITS.MIN_POLL_SEC, LIMITS.MAX_POLL_SEC, DEFAULTS.pollIntervalSec),
    };
  };
  const store = createStore({
    file: path.join(dir, 'settings.json'),
    defaults: DEFAULTS,
    sanitize,
    seed,
    secret: { field: 'apiToken', enc: 'tokenEnc', plain: 'tokenPlain' },
    crypto,
  });

  const isConfigured = (s = store.load()) => Boolean(s.doorayDomain && s.apiToken);

  /**
   * Whether a new token can be saved encrypted. Engines before #97 have no store.secretAvailable() and fall
   * back to plain text, so the widget checks safeStorage itself there.
   */
  function canEncrypt() {
    try {
      if (crypto) return Boolean(crypto.available());
      if (typeof store.secretAvailable === 'function') return store.secretAvailable();
      return Boolean(require('electron').safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  // Safe view for the settings window: never send the token itself back.
  function toPublic(s = store.load()) {
    const { apiToken, windowBounds, ...visible } = s;
    return { ...visible, hasToken: Boolean(apiToken), isConfigured: isConfigured(s), limits: LIMITS };
  }

  /**
   * Saves settings from the settings window. A new token is saved only encrypted; without OS encryption
   * nothing is saved and the window shows why. -> { ok: true, settings } | { ok: false, message }
   */
  function saveChecked(patch) {
    const before = store.load();
    if (patch.apiToken && String(patch.apiToken).trim() !== before.apiToken && !canEncrypt()) {
      return { ok: false, message: TOKEN_UNAVAILABLE_MESSAGE };
    }
    try {
      return { ok: true, settings: store.save(patch) };
    } catch (err) {
      if (err?.code === 'secret-unavailable') return { ok: false, message: TOKEN_UNAVAILABLE_MESSAGE };
      throw err;
    }
  }

  return { ...store, isConfigured, toPublic, canEncrypt, saveChecked };
}

module.exports = { createDooraySettings, TOKEN_UNAVAILABLE_MESSAGE, normalizeDomain, normalizeApiBase, sanitizeThemeOpacity, DEFAULTS, LIMITS };
