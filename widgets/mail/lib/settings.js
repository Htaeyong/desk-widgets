// Settings file shape of the mail widget (#65): defaults and sanitizing (accounts without passwords; those
// are in lib/secrets.js). Themes are the engine theme host's (themeId, themeOpacity, themeBounds, themeFrames).
const crypto = require('crypto');
const net = require('net');
const { PROVIDERS, PROVIDER_IDS } = require('./providers');
const { cleanFolders } = require('./folders');

const DEFAULT_THEME = 'default';
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PALETTE = ['#4f8cff', '#3ccf8e', '#ff9f43', '#ff6b6b', '#a78bfa', '#2dd4bf', '#f472b6', '#facc15'];
const MAX_ACCOUNTS = 12;
const SECURITY = ['tls', 'starttls'];
const COMPOSE = ['widget', 'mailto', 'webmail']; // #68: 위젯에서 보내기 (default) / 메일 프로그램 / 웹메일
const SAVE_SENT = ['auto', 'on', 'off'];
const OPEN_WITH = ['widget', 'webmail'];

const DEFAULTS = {
  accounts: [],
  refreshMinutes: 10, // polling for servers without IDLE, and a periodic full check
  pageSize: 30, // messages per "더 보기"
  cacheSize: 50, // headers per account kept on disk for a fast start
  markReadOnOpen: true,
  notify: true, // all new-mail cards (each account has its own switch too)
  alwaysOnTop: false,
  themeId: DEFAULT_THEME,
  themeOpacity: {},
  themeBounds: {},
  themeFrames: [],
  todoIntegration: false,
  todoTarget: 'todonote', // #111: 할 일 노트 or the to-do list widget, when both can take a message
};

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const newId = () => `m${crypto.randomBytes(5).toString('hex')}`;

/** A host name or IP address the user typed -> lower-case host, or null. No scheme, path or port. */
function cleanHost(v) {
  const h = String(v || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253) return null;
  if (net.isIP(h)) return h;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(h) || /^[a-z0-9-]{1,63}$/.test(h) ? h : null;
}

/** https web address (no credentials in it), or ''. */
function cleanWebmail(v) {
  try {
    const u = new URL(String(v || '').trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}

/** One account (no password); null when it cannot be used. */
function sanitizeAccount(a, index = 0) {
  if (!a || typeof a !== 'object') return null;
  const provider = PROVIDER_IDS.includes(a.provider) ? a.provider : null;
  const username = String(a.username || '').trim().slice(0, 200);
  if (!provider || !username || /[\r\n]/.test(username)) return null;
  const p = PROVIDERS[provider];
  let host = p.host;
  let port = p.port;
  let security = p.security;
  if (p.server !== 'fixed') {
    // optional (Dooray: blank = the provider's host) or required (기타 IMAP).
    const typed = cleanHost(a.host);
    if (!typed && (p.server === 'required' || String(a.host || '').trim())) return null;
    if (typed) {
      host = typed;
      port = clampInt(a.port, 1, 65535, p.port);
      security = SECURITY.includes(a.security) ? a.security : p.security;
    }
  }
  const email = String(a.email || '').trim().slice(0, 200);
  // SMTP (#68): the provider's, or what the user typed for servers that are not fixed (기타, 두레이 자체 구축).
  let smtpHost = p.smtp?.host || '';
  let smtpPort = p.smtp?.port || 465;
  let smtpSecurity = p.smtp?.security || 'tls';
  if (p.server !== 'fixed') {
    const typedSmtp = cleanHost(a.smtpHost);
    if (typedSmtp) {
      smtpHost = typedSmtp;
      smtpPort = clampInt(a.smtpPort, 1, 65535, smtpPort);
      smtpSecurity = SECURITY.includes(a.smtpSecurity) ? a.smtpSecurity : smtpSecurity;
    }
  }
  const derived = /@/.test(username) ? username : p.domain ? `${username}@${p.domain}` : '';
  return {
    id: typeof a.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(a.id) ? a.id : newId(),
    name: String(a.name || '').trim().slice(0, 60) || p.label,
    provider,
    host,
    port,
    security,
    username,
    email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : derived,
    senderName: String(a.senderName || '').replace(/[\r\n<>"]/g, ' ').trim().slice(0, 60),
    signature: String(a.signature || '').replace(/\r\n/g, '\n').slice(0, 2000),
    smtpHost,
    smtpPort,
    smtpSecurity,
    saveSent: SAVE_SENT.includes(a.saveSent) ? a.saveSent : 'auto',
    color: isColor(a.color) ? a.color.toLowerCase() : PALETTE[index % PALETTE.length],
    enabled: a.enabled !== false,
    notify: a.notify !== false,
    compose: COMPOSE.includes(a.compose) ? a.compose : 'widget',
    openWith: OPEN_WITH.includes(a.openWith) ? a.openWith : 'widget',
    // #80: mailboxes watched together with INBOX ([{ raw (as LIST gave it), name }], at most 10).
    folders: cleanFolders(a.folders),
    webmail: cleanWebmail(a.webmail) || p.webmail || '',
  };
}

function sanitizeAccounts(list) {
  const out = [];
  const ids = new Set();
  for (const a of Array.isArray(list) ? list : []) {
    const clean = sanitizeAccount(a, out.length);
    if (!clean) continue;
    while (ids.has(clean.id)) clean.id = newId();
    ids.add(clean.id);
    out.push(clean);
    if (out.length >= MAX_ACCOUNTS) break;
  }
  return out;
}

function sanitize(next) {
  return {
    ...next,
    accounts: sanitizeAccounts(next.accounts),
    refreshMinutes: clampInt(next.refreshMinutes, 2, 1440, DEFAULTS.refreshMinutes),
    pageSize: clampInt(next.pageSize, 10, 100, DEFAULTS.pageSize),
    cacheSize: clampInt(next.cacheSize, 20, 200, DEFAULTS.cacheSize),
    markReadOnOpen: next.markReadOnOpen !== false,
    notify: next.notify !== false,
    alwaysOnTop: Boolean(next.alwaysOnTop),
    todoIntegration: Boolean(next.todoIntegration),
    todoTarget: next.todoTarget === 'todo' ? 'todo' : 'todonote',
    themeId: THEME_ID.test(String(next.themeId || '')) ? next.themeId : DEFAULT_THEME,
  };
}

/** What a connection is: when it changes, the account reconnects (and a stored password must be re-checked). */
const loginKey = (a) => JSON.stringify([a.provider, a.host, a.port, a.security, a.username]);

/**
 * #68, once: accounts saved before the widget could send had compose 'mailto' only because it was the
 * default then (mailto: writes from the mail program's own default account, i.e. the wrong sender), so they
 * move to 'widget'. Runs on the raw file; composeDefault: 2 marks it done.
 */
function upgrade(raw) {
  if (!raw || typeof raw !== 'object' || raw.composeDefault === 2) return raw;
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.map((a) => (a && a.compose === 'mailto' ? { ...a, compose: 'widget' } : a)) : raw.accounts;
  return { ...raw, accounts, composeDefault: 2 };
}

module.exports = { upgrade, DEFAULTS, PALETTE, DEFAULT_THEME, MAX_ACCOUNTS, sanitize, sanitizeAccount, sanitizeAccounts, cleanHost, cleanWebmail, newId, loginKey };
