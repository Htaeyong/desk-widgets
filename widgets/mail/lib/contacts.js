// The mail widget's address book (#70), on this PC only (<dataDir>\contacts.json): addresses learned from
// received and sent mail headers (name, last used, how often), names the user edited, and contacts imported
// from vCard (.vcf) or CSV files. Feeds the composer's recipient autocomplete. Nothing is sent anywhere.
// The file is an engine item store (#108): the engine may exchange address and name with the user's other PCs;
// how often and when an address was used, the learned-mail list and the removed list stay on this PC.
const fs = require('fs');
const path = require('path');
const { isAddress } = require('../composer/addresses');

const MAX_CONTACTS = 5000;
const MAX_LEARNED = 5000; // message keys already counted (so a re-sync does not count a mail twice)
const NOISE = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?)([+._-]|@)/i;

// ---- Korean initial consonants (초성) for search: "ㅎㄱㄷ" finds 홍길동 ----
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
function initials(s) {
  let out = '';
  for (const ch of String(s || '')) {
    const c = ch.charCodeAt(0) - 0xac00;
    out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch.toLowerCase();
  }
  return out;
}
const isChoseongQuery = (q) => /^[ㄱ-ㅎ]+$/.test(q);

/** Normalizes the file (also entries another PC sent): addresses only, keyed by the lower-case address. */
function sanitizeData(raw = {}) {
  const contacts = {};
  for (const [key, c] of Object.entries(raw.contacts && typeof raw.contacts === 'object' ? raw.contacts : {})) {
    if (Object.keys(contacts).length >= MAX_CONTACTS) break;
    if (!c || typeof c !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(key) || !isAddress(key) ||
        String(c.address || '').toLowerCase() !== key) continue;
    contacts[key] = { ...c, address: String(c.address).slice(0, 320), name: String(c.name || '').replace(/[\r\n<>"]+/g, ' ').slice(0, 100),
      imported: Boolean(c.imported), edited: Boolean(c.edited) };
  }
  return {
    version: 1,
    contacts,
    removed: Array.isArray(raw.removed) ? raw.removed.filter((x) => typeof x === 'string').slice(-MAX_CONTACTS) : [],
    learned: Array.isArray(raw.learned) ? raw.learned.filter((x) => typeof x === 'string').slice(-MAX_LEARNED) : [],
  };
}

/** The engine item store declaration (#108); without `sync` (mock data) the file stays on this PC only. */
function storeOptions(file, { sync = true } = {}) {
  return {
    file,
    defaults: { version: 1, contacts: {}, removed: [], learned: [] },
    sanitize: sanitizeData,
    ...(sync ? { sync: { name: 'contacts', collections: { contacts: { map: true, shared: ['address', 'name', 'imported', 'edited'] } } } } : {}),
  };
}

function fileBacking(file) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    },
    save(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    },
  };
}

class ContactBook {
  /** @param {string} file  @param {{ store?: { load(), save(next), onRemoteChange?(fn) } }} opts  the engine store */
  constructor(file, { store = null } = {}) {
    this.file = file;
    this.backing = store || fileBacking(file);
    this.data = null;
    this.backing.onRemoteChange?.(() => { this.data = null; });
  }

  onRemoteChange(listener) {
    return this.backing.onRemoteChange?.(listener) || (() => {});
  }

  load() {
    if (this.data) return this.data;
    this.data = structuredClone(sanitizeData(this.backing.load() || {}));
    this.learnedSet = new Set(this.data.learned);
    return this.data;
  }

  persist() {
    this.backing.save(structuredClone(this.data));
  }

  /** Adds or updates one address; returns 'added' | 'updated' | null (not an address / removed by the user). */
  touch({ name, address }, { kind, at = Date.now(), force = false } = {}) {
    const data = this.load();
    const addr = String(address || '').trim();
    if (!isAddress(addr)) return null;
    const key = addr.toLowerCase();
    // An address the user deleted comes back only by import or by sending to it.
    if (!force && kind === 'received' && data.removed.includes(key)) return null;
    if (force || kind === 'sent') data.removed = data.removed.filter((x) => x !== key);
    const cleanName = String(name || '').replace(/[\r\n<>"]+/g, ' ').trim().slice(0, 100);
    const cur = data.contacts[key];
    if (!cur) {
      if (Object.keys(data.contacts).length >= MAX_CONTACTS) this.dropOldest();
      data.contacts[key] = { address: addr, name: cleanName, sent: kind === 'sent' ? 1 : 0, received: kind === 'received' ? 1 : 0, lastUsed: at, imported: kind === 'import', edited: false };
      return 'added';
    }
    if (cleanName && (!cur.edited || force) && (!cur.name || kind !== 'received' || !cur.imported)) cur.name = cleanName;
    if (kind === 'sent') cur.sent = (cur.sent || 0) + 1;
    if (kind === 'received') cur.received = (cur.received || 0) + 1;
    if (kind === 'import') cur.imported = true;
    cur.lastUsed = Math.max(cur.lastUsed || 0, at);
    return 'updated';
  }

  dropOldest() {
    const data = this.data;
    const oldest = Object.entries(data.contacts).sort((a, b) => score(a[1]) - score(b[1]) || (a[1].lastUsed || 0) - (b[1].lastUsed || 0))[0];
    if (oldest) delete data.contacts[oldest[0]];
  }

  /**
   * Received mail: From, To and Cc of each header once (by message key), without the own addresses and
   * automated senders. Returns how many contacts changed.
   */
  learnHeaders(items, ownAddresses = []) {
    this.load();
    const own = new Set(ownAddresses.map((a) => String(a).toLowerCase()));
    let changed = 0;
    for (const { key, h } of items) {
      if (!key || this.learnedSet.has(key)) continue;
      this.learnedSet.add(key);
      this.data.learned.push(key);
      for (const a of [h.from, ...(h.to || []), ...(h.cc || [])].filter(Boolean)) {
        const addr = String(a.address || '').toLowerCase();
        if (own.has(addr) || NOISE.test(addr)) continue;
        if (this.touch(a, { kind: 'received', at: h.date || Date.now() })) changed++;
      }
    }
    if (this.data.learned.length > MAX_LEARNED) {
      this.data.learned = this.data.learned.slice(-MAX_LEARNED);
      this.learnedSet = new Set(this.data.learned);
    }
    if (changed) this.persist();
    return changed;
  }

  /** Sent mail: every recipient (Bcc too) counts as used now. */
  learnSent(recipients, at = Date.now()) {
    let changed = 0;
    for (const r of recipients) if (this.touch(r, { kind: 'sent', at })) changed++;
    if (changed) this.persist();
    return changed;
  }

  /** Imported contacts (vCard / CSV): names from the file win unless the user edited them here. */
  importContacts(list) {
    let added = 0;
    let updated = 0;
    for (const c of list) {
      const r = this.touch(c, { kind: 'import', at: 0, force: true });
      if (r === 'added') added++;
      else if (r === 'updated') updated++;
    }
    if (added || updated) this.persist();
    return { added, updated };
  }

  rename(address, name) {
    const c = this.load().contacts[String(address || '').toLowerCase()];
    if (!c) throw new Error('주소록에 없는 주소입니다.');
    c.name = String(name || '').replace(/[\r\n<>"]+/g, ' ').trim().slice(0, 100);
    c.edited = true;
    this.persist();
    return { ...c };
  }

  remove(address) {
    const data = this.load();
    const key = String(address || '').toLowerCase();
    if (!data.contacts[key]) return false;
    delete data.contacts[key];
    if (!data.removed.includes(key)) data.removed.push(key);
    this.persist();
    return true;
  }

  /**
   * Search for autocomplete and the 주소록 list: name / address contains the query (or 초성 of the name);
   * those starting with it first, then by use (sent counts more than received), then last used.
   */
  search(query = '', limit = 8, exclude = []) {
    const q = String(query || '').trim().toLowerCase();
    const skip = new Set(exclude.map((a) => String(a).toLowerCase()));
    const out = [];
    for (const c of Object.values(this.load().contacts)) {
      if (skip.has(c.address.toLowerCase())) continue;
      const name = (c.name || '').toLowerCase();
      const addr = c.address.toLowerCase();
      let rank;
      if (!q) rank = 2;
      else if (name.startsWith(q) || addr.startsWith(q)) rank = 0;
      else if (name.includes(q) || addr.includes(q)) rank = 1;
      else if (isChoseongQuery(q) && initials(c.name).includes(q)) rank = 1;
      else continue;
      out.push({ c, rank });
    }
    out.sort((a, b) => a.rank - b.rank || score(b.c) - score(a.c) || (b.c.lastUsed || 0) - (a.c.lastUsed || 0) || a.c.address.localeCompare(b.c.address));
    return out.slice(0, limit).map(({ c }) => ({ name: c.name || '', address: c.address, sent: c.sent || 0, received: c.received || 0, lastUsed: c.lastUsed || 0, imported: Boolean(c.imported) }));
  }

  size() {
    return Object.keys(this.load().contacts).length;
  }
}

const score = (c) => (c.sent || 0) * 3 + (c.received || 0) + (c.imported ? 2 : 0);

// ---- import: vCard (.vcf, 2.1 / 3.0 / 4.0) and CSV (Google, Outlook, Naver, Daum, plain) ----

/** File bytes -> text: UTF-8 (BOM or valid), else EUC-KR (Korean webmail exports). */
function decodeFile(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

function qpDecode(s, charset = 'utf-8') {
  const bytes = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      bytes.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(t[i], 'utf8'));
  }
  try {
    return new TextDecoder(charset).decode(Buffer.from(bytes));
  } catch {
    return Buffer.from(bytes).toString('utf8');
  }
}

/** vCard text -> [{ name, address }] (one entry per EMAIL of each card). */
function parseVcard(text) {
  // Unfold (RFC 6350: a line starting with space / tab continues the previous); QP soft breaks too.
  const lines = String(text).replace(/\r\n/g, '\n').replace(/=\n/g, '').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  let card = null;
  const value = (line) => {
    const colon = line.indexOf(':');
    const params = line.slice(0, colon).toUpperCase();
    let v = line.slice(colon + 1);
    if (/ENCODING=QUOTED-PRINTABLE|;QUOTED-PRINTABLE/.test(params)) v = qpDecode(v, (/CHARSET=([^;:]+)/.exec(params) || [])[1] || 'utf-8');
    return v.replace(/\\([,;\\nN])/g, (_m, c) => (c === 'n' || c === 'N' ? ' ' : c)).trim();
  };
  for (const line of lines) {
    const up = line.toUpperCase();
    if (up.startsWith('BEGIN:VCARD')) card = { fn: '', n: '', emails: [] };
    else if (up.startsWith('END:VCARD')) {
      if (card) {
        const name = card.fn || card.n;
        for (const e of card.emails) if (isAddress(e)) out.push({ name, address: e });
      }
      card = null;
    } else if (card) {
      const prop = up.split(/[;:]/)[0].replace(/^ITEM\d+\./, '');
      if (prop === 'FN') card.fn = value(line);
      else if (prop === 'N' && !card.n) {
        const [family = '', given = ''] = value(line).split(';');
        card.n = /[가-힣]/.test(family + given) ? `${family}${given}`.trim() : `${given} ${family}`.trim();
      } else if (prop === 'EMAIL') card.emails.push(value(line).replace(/^mailto:/i, ''));
    }
  }
  return out;
}

/** One CSV text -> rows (quotes, doubled quotes, commas and line breaks inside quotes). */
function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const t = String(text);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * CSV -> [{ name, address }]. The header row decides: e-mail columns ("E-mail Address", "E-mail 1 - Value",
 * "이메일", "메일 주소" ...) and name columns ("Name", "이름", First / Last, 성 / 이름). Without a header,
 * any cell that is an address with the first non-address cell as the name.
 */
function parseCsv(text) {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const emailCols = head.map((h, i) => (/(e-?mail|메일|이메일)/.test(h) && !/(type|유형|label|종류)/.test(h) ? i : -1)).filter((i) => i >= 0);
  const out = [];
  if (emailCols.length) {
    const col = (re) => head.findIndex((h) => re.test(h));
    const full = col(/^(name|display name|이름|성명|표시 이름)$/);
    const first = col(/^(first name|given name|이름\(名\)|이름 \(이름\))$/);
    const last = col(/^(last name|family name|성)$/);
    for (const r of rows.slice(1)) {
      let name = full >= 0 ? r[full] : '';
      if (!name && (first >= 0 || last >= 0)) {
        const f = first >= 0 ? r[first] || '' : '';
        const l = last >= 0 ? r[last] || '' : '';
        name = /[가-힣]/.test(f + l) ? `${l}${f}` : `${f} ${l}`;
      }
      for (const i of emailCols) for (const e of String(r[i] || '').split(/\s*:::\s*|\s+/)) if (isAddress(e)) out.push({ name: (name || '').trim(), address: e });
    }
    return out;
  }
  for (const r of rows) {
    const name = r.find((c) => c.trim() && !isAddress(c.trim())) || '';
    for (const c of r) if (isAddress(c.trim())) out.push({ name: name.trim(), address: c.trim() });
  }
  return out;
}

/** A file picked for import -> contacts (by extension, else by content). */
function parseContactsFile(name, buf) {
  const text = decodeFile(buf);
  if (/\.vcf$|\.vcard$/i.test(name) || /BEGIN:VCARD/i.test(text)) return parseVcard(text);
  return parseCsv(text);
}

module.exports = { ContactBook, parseVcard, parseCsv, parseContactsFile, decodeFile, initials, MAX_CONTACTS, sanitizeData, storeOptions };
