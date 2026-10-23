// Mail categories (#69), like the Dooray widget's 분류: kept on this PC only (<dataDir>\categories.json),
// never written to a mail server. A message is identified by account id + Message-ID, so a re-sync, a new
// UIDVALIDITY or the same mail seen again keeps its categories; without a Message-ID the fallback is
// account + folder + UIDVALIDITY + UID.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CATEGORIES = 50;
const MAX_NAME = 30;
const MAX_ASSIGNMENTS = 20000;
const COLOR = /^#[0-9a-f]{6}$/i;
const PALETTE = ['#7aa7ff', '#52d6a4', '#ffbd59', '#ff7272', '#c792ea', '#5ad1e6', '#f78fb3', '#a3b18a'];
const NONE = '__none__'; // the "분류 없음" filter

class CategoryError extends Error {}

function cleanName(name) {
  const value = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!value) throw new CategoryError('분류 이름을 넣어 주세요.');
  if (value.length > MAX_NAME) throw new CategoryError(`분류 이름은 ${MAX_NAME}자까지입니다.`);
  return value;
}

/** The key of a message: account + Message-ID, else account + INBOX + UIDVALIDITY + UID. */
function messageKey(accountId, h, uidValidity) {
  const mid = String(h?.messageId || '').trim().replace(/^<|>$/g, '').toLowerCase();
  if (mid) return `${accountId}|mid:${mid}`;
  // A chosen mailbox's message (#80) has its own folder key and UIDVALIDITY.
  return h?.folderKey ? `${accountId}|uid:${h.folderKey}:${h.uidValidity ?? 0}:${h.uid}` : `${accountId}|uid:INBOX:${uidValidity ?? 0}:${h?.uid}`;
}

class CategoryStore {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const categories = (Array.isArray(raw.categories) ? raw.categories : [])
        .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
        .map((c) => ({ id: c.id, name: c.name.slice(0, MAX_NAME), color: COLOR.test(c.color) ? c.color.toLowerCase() : PALETTE[0] }))
        .slice(0, MAX_CATEGORIES);
      this.data = { version: 1, categories, assignments: raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {} };
    } catch {
      this.data = { version: 1, categories: [], assignments: {} };
    }
    return this.data;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.load().categories.map((c) => ({ ...c }));
  }

  find(id) {
    const c = this.load().categories.find((x) => x.id === id);
    if (!c) throw new CategoryError('분류를 찾지 못했습니다.');
    return c;
  }

  create(name, color) {
    const data = this.load();
    const clean = cleanName(name);
    if (data.categories.length >= MAX_CATEGORIES) throw new CategoryError(`분류는 ${MAX_CATEGORIES}개까지입니다.`);
    if (data.categories.some((c) => c.name === clean)) throw new CategoryError('같은 이름의 분류가 이미 있습니다.');
    const category = { id: `c${crypto.randomBytes(5).toString('hex')}`, name: clean, color: COLOR.test(color) ? color.toLowerCase() : PALETTE[data.categories.length % PALETTE.length] };
    data.categories.push(category);
    this.persist();
    return { ...category };
  }

  rename(id, name) {
    const clean = cleanName(name);
    const c = this.find(id);
    if (this.load().categories.some((x) => x.id !== id && x.name === clean)) throw new CategoryError('같은 이름의 분류가 이미 있습니다.');
    c.name = clean;
    this.persist();
  }

  recolor(id, color) {
    if (!COLOR.test(color)) throw new CategoryError('색이 올바르지 않습니다.');
    this.find(id).color = color.toLowerCase();
    this.persist();
  }

  /** Deletes a category and takes it off every message. */
  remove(id) {
    const data = this.load();
    this.find(id);
    data.categories = data.categories.filter((c) => c.id !== id);
    for (const [key, a] of Object.entries(data.assignments)) {
      a.categoryIds = (a.categoryIds || []).filter((x) => x !== id);
      if (!a.categoryIds.length) delete data.assignments[key];
    }
    this.persist();
  }

  /** The categories of a message (known ids only, in the categories' order). */
  idsFor(key) {
    const data = this.load();
    const set = new Set(data.assignments[key]?.categoryIds || []);
    return data.categories.filter((c) => set.has(c.id)).map((c) => c.id);
  }

  /** Puts a message in exactly these categories (unknown ids are dropped); returns the ids kept. */
  set(key, ids, info = {}) {
    const data = this.load();
    const known = new Set(data.categories.map((c) => c.id));
    const keep = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => known.has(id)))];
    if (keep.length) {
      data.assignments[key] = { categoryIds: keep, at: Date.now(), subject: String(info.subject || '').slice(0, 120) };
      const keys = Object.keys(data.assignments);
      if (keys.length > MAX_ASSIGNMENTS) {
        // Oldest assignments go first when the file grows beyond reason.
        keys.sort((a, b) => (data.assignments[a].at || 0) - (data.assignments[b].at || 0));
        for (const k of keys.slice(0, keys.length - MAX_ASSIGNMENTS)) delete data.assignments[k];
      }
    } else delete data.assignments[key];
    this.persist();
    return this.idsFor(key);
  }

  /** Applies the settings window's list: renames / recolors, new ones (no id), deletes the missing. */
  replaceAll(list) {
    const data = this.load();
    const incoming = Array.isArray(list) ? list.slice(0, MAX_CATEGORIES) : [];
    const keepIds = new Set(incoming.filter((c) => c?.id).map((c) => c.id));
    for (const c of [...data.categories]) if (!keepIds.has(c.id)) this.remove(c.id);
    const seen = new Set();
    for (const c of incoming) {
      const name = cleanName(c?.name);
      if (seen.has(name)) throw new CategoryError(`같은 이름의 분류가 두 개 있습니다: ${name}`);
      seen.add(name);
    }
    for (const c of incoming) {
      if (c.id && data.categories.some((x) => x.id === c.id)) {
        const cur = this.find(c.id);
        cur.name = cleanName(c.name);
        if (COLOR.test(c.color)) cur.color = c.color.toLowerCase();
      } else {
        data.categories.push({ id: `c${crypto.randomBytes(5).toString('hex')}`, name: cleanName(c.name), color: COLOR.test(c.color) ? c.color.toLowerCase() : PALETTE[data.categories.length % PALETTE.length] });
      }
    }
    // Keep the order the user gave.
    const order = incoming.map((c) => cleanName(c.name));
    data.categories.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    this.persist();
    return this.list();
  }
}

module.exports = { CategoryStore, CategoryError, messageKey, NONE, PALETTE, MAX_CATEGORIES, MAX_NAME };
