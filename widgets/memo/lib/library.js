// The memo folder (#75): one memo = "<제목>.md" (or an imported "<제목>.txt") in the notes folder, its images and
// attachments in "<제목>.assets" next to it, archived memos in the "보관함" subfolder. This file only knows files;
// windows and editing sessions are in index.js / session.js.
//
// Memo ids: a Markdown memo keeps its id in front matter ("desk-widgets-memo: <id>", written with the first save by
// the widget), so it survives renames by other programs. Files without one (a new .md from another app, .txt) get an
// id remembered by path in the widget's settings until the widget writes the file.
const fs = require('fs');
const path = require('path');
const md = require('./markdown');
const F = require('./files');

const ARCHIVE = '보관함';
const MAX_READ = 5 * 1024 * 1024; // larger files are listed but not opened
const SEARCH_CHARS = 200000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE = 20 * 1024 * 1024; // an image pasted or dropped
const MAX_ATTACHMENT = 200 * 1024 * 1024; // any other dropped file

const extOf = (file) => path.extname(file).slice(1).toLowerCase();
const lower = (p) => path.resolve(p).toLowerCase();

class Library {
  /**
   * @param {object} o
   * @param {string} o.dir  the notes folder
   * @param {{ load(): object, save(map: object): void }} o.ids  remembered ids of files without front matter, by path
   * @param {(file: string) => Promise<void>} [o.trash]  moves a file or folder to the Recycle Bin (shell.trashItem)
   */
  constructor({ dir, ids, trash }) {
    this.dir = path.resolve(dir);
    this.ids = ids;
    this.trashItem = trash;
    this.memos = new Map(); // id -> memo
    this.cache = new Map(); // lower(path) -> { mtimeMs, size, fmId, preview, search }
  }

  get archiveDir() {
    return path.join(this.dir, ARCHIVE);
  }

  async ensureDir() {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  /** Reads what the cache needs of a file: its front matter id and text for the list. */
  async inspect(file, st) {
    const key = lower(file);
    const hit = this.cache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    let info = { mtimeMs: st.mtimeMs, size: st.size, fmId: null, preview: '', search: '', links: [], tooBig: st.size > MAX_READ };
    if (!info.tooBig) {
      try {
        const text = await fs.promises.readFile(file, 'utf8');
        const ext = extOf(file);
        const fm = ext === 'md' ? md.splitFrontMatter(text) : { body: text, id: null };
        const plain = ext === 'md' ? safePlain(fm.body) : fm.body;
        info = { ...info, fmId: fm.id, preview: plain.replace(/\s+/g, ' ').trim().slice(0, 160), search: plain.slice(0, SEARCH_CHARS).toLowerCase(), links: ext === 'md' ? safeLinks(fm.body) : [] };
      } catch {
        // unreadable for now (locked, syncing): listed without text
      }
    }
    this.cache.set(key, info);
    return info;
  }

  async listFiles(dir, archived) {
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (name.startsWith('.') || !/\.(md|txt)$/i.test(name)) continue;
      const file = path.join(dir, name);
      let st;
      try {
        st = await fs.promises.stat(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({ file, st, archived });
    }
    return out;
  }

  /**
   * Reads the folder again. Returns what changed since the last scan:
   * { added: id[], removed: id[], changed: id[] (content may differ), moved: id[] (other file name) }.
   */
  async scan() {
    const found = [...(await this.listFiles(this.dir, false)), ...(await this.listFiles(this.archiveDir, true))];
    found.sort((a, b) => a.file.localeCompare(b.file));
    const remembered = { ...(this.ids.load() || {}) };
    const next = new Map();
    const withFm = new Map(); // front matter id -> entries
    for (const f of found) {
      f.info = await this.inspect(f.file, f.st);
      if (f.info.fmId) withFm.set(f.info.fmId, [...(withFm.get(f.info.fmId) || []), f]);
    }
    // The same front matter id in several files: a copy (OneDrive conflict copy, a file copied in Explorer).
    // The file that had the id before keeps it, else the shortest name; the others are marked as conflict copies.
    const owner = new Map();
    for (const [id, list] of withFm) {
      const prev = this.memos.get(id);
      const keep = list.find((f) => prev && lower(f.file) === lower(prev.file)) || [...list].sort((a, b) => path.basename(a.file).length - path.basename(b.file).length)[0];
      owner.set(id, keep);
    }
    const usedPaths = {};
    for (const f of found) {
      const key = lower(f.file);
      let id = f.info.fmId;
      let conflictOf = null;
      if (id && owner.get(id) !== f) {
        conflictOf = id;
        id = null;
      }
      if (!id) {
        id = remembered[key] && !withFm.has(remembered[key]) && !next.has(remembered[key]) ? remembered[key] : F.newId();
        usedPaths[key] = id;
      }
      const ext = extOf(f.file);
      next.set(id, {
        id,
        file: f.file,
        title: path.basename(f.file, path.extname(f.file)),
        ext,
        archived: f.archived,
        mtimeMs: f.st.mtimeMs,
        size: f.st.size,
        tooBig: f.info.tooBig,
        hasFmId: Boolean(f.info.fmId) && !conflictOf,
        conflictOf,
        preview: f.info.preview,
        search: f.info.search,
        links: f.info.links || [],
      });
    }
    // Remember ids of files without our front matter; forget files that are gone.
    if (JSON.stringify(usedPaths) !== JSON.stringify(remembered)) this.ids.save(usedPaths);
    for (const key of [...this.cache.keys()]) if (!found.some((f) => lower(f.file) === key)) this.cache.delete(key);

    const changes = { added: [], removed: [], changed: [], moved: [] };
    for (const [id, m] of next) {
      const prev = this.memos.get(id);
      if (!prev) changes.added.push(id);
      else {
        if (lower(prev.file) !== lower(m.file)) changes.moved.push(id);
        if (prev.mtimeMs !== m.mtimeMs || prev.size !== m.size) changes.changed.push(id);
      }
    }
    for (const id of this.memos.keys()) if (!next.has(id)) changes.removed.push(id);
    this.memos = next;
    return changes;
  }

  get(id) {
    return this.memos.get(id) || null;
  }

  list() {
    return [...this.memos.values()];
  }

  assetsName(memo) {
    return `${memo.title}.assets`;
  }

  assetsDir(memo) {
    return path.join(path.dirname(memo.file), this.assetsName(memo));
  }

  /** { text, body, fmLines, hash }: body without front matter (a .txt memo: the whole text). */
  async read(id) {
    const m = this.must(id);
    if (m.tooBig) throw new Error('노트 파일이 너무 커서 열 수 없습니다 (5MB까지).');
    const text = await fs.promises.readFile(m.file, 'utf8');
    if (m.ext !== 'md') return { text, body: text.replace(/^﻿/, ''), fmLines: null, hash: F.hashText(text) };
    const fm = md.splitFrontMatter(text);
    m.fmLines = fm.lines;
    return { text, body: fm.body, fmLines: fm.lines, hash: F.hashText(text) };
  }

  must(id) {
    const m = this.memos.get(id);
    if (!m) throw new Error('노트를 찾을 수 없습니다.');
    return m;
  }

  /** The file's whole text for a body: our front matter id on .md memos (other front matter lines kept). */
  compose(m, body) {
    return m.ext === 'md' ? md.joinFrontMatter(m.fmLines, m.id, body) : body;
  }

  afterWrite(m, text) {
    try {
      const st = fs.statSync(m.file);
      m.mtimeMs = st.mtimeMs;
      m.size = st.size;
    } catch {}
    m.hasFmId = m.ext === 'md';
    m.conflictOf = null;
    const plain = m.ext === 'md' ? safePlain(md.splitFrontMatter(text).body) : text;
    m.preview = plain.replace(/\s+/g, ' ').trim().slice(0, 160);
    m.search = plain.slice(0, SEARCH_CHARS).toLowerCase();
    m.links = m.ext === 'md' ? safeLinks(md.splitFrontMatter(text).body) : [];
    this.cache.set(lower(m.file), { mtimeMs: m.mtimeMs, size: m.size, fmId: m.ext === 'md' ? m.id : null, preview: m.preview, search: m.search, links: m.links, tooBig: false });
    return F.hashText(text);
  }

  /** Saves a memo's body atomically; returns the hash of the written file. */
  async write(id, body) {
    const m = this.must(id);
    const text = this.compose(m, body);
    await F.writeFileAtomic(m.file, text);
    return this.afterWrite(m, text);
  }

  writeSync(id, body) {
    const m = this.must(id);
    const text = this.compose(m, body);
    F.writeFileAtomicSync(m.file, text);
    return this.afterWrite(m, text);
  }

  /** A new memo file (front matter id included) and its record. */
  async create({ title = F.DEFAULT_TITLE, body = '', id = F.newId() } = {}) {
    await this.ensureDir();
    const { title: t, file } = F.uniqueFileName(this.dir, title, 'md');
    const m = { id, file, title: t, ext: 'md', archived: false, mtimeMs: 0, size: 0, fmLines: [], hasFmId: true, conflictOf: null, preview: '', search: '' };
    const text = this.compose(m, body);
    await F.writeFileAtomic(file, text);
    this.memos.set(id, m);
    this.afterWrite(m, text);
    return m;
  }

  /**
   * Renames a memo (its file and assets folder) and points the file's links at the new assets folder.
   * Returns the memo; nothing happens when the name stays the same.
   */
  async rename(id, title) {
    const m = this.must(id);
    const dir = path.dirname(m.file);
    const wanted = F.sanitizeTitle(title);
    if (wanted === m.title) return m;
    const { title: t, file } = F.uniqueFileName(dir, wanted, m.ext, { keep: m.file });
    if (t === m.title && file === m.file) return m;
    const oldAssets = this.assetsDir(m);
    const oldName = this.assetsName(m);
    const oldFile = m.file;
    await F.renameRetry(m.file, file);
    m.file = file;
    m.title = t;
    this.cache.delete(lower(oldFile));
    if (fs.existsSync(oldAssets)) {
      try {
        await F.renameRetry(oldAssets, this.assetsDir(m));
      } catch (err) {
        // The memo keeps working with the old folder name until the next rename: put the file name back.
        await F.renameRetry(file, oldFile).catch(() => {});
        m.file = oldFile;
        m.title = path.basename(oldFile, path.extname(oldFile));
        throw err;
      }
      if (m.ext === 'md') {
        const { body } = await this.read(id);
        const next = relinkAssets(body, oldName, this.assetsName(m));
        if (next !== body) await this.write(id, next);
      }
    }
    return m;
  }

  /** Moves a memo (and its assets) between the notes folder and the archive folder. */
  async move(id, toArchive) {
    const m = this.must(id);
    if (m.archived === toArchive) return m;
    const target = toArchive ? this.archiveDir : this.dir;
    await fs.promises.mkdir(target, { recursive: true });
    const oldAssets = this.assetsDir(m);
    const oldName = this.assetsName(m);
    const { title: t, file } = F.uniqueFileName(target, m.title, m.ext);
    await F.renameRetry(m.file, file);
    this.cache.delete(lower(m.file));
    m.file = file;
    m.title = t;
    m.archived = toArchive;
    if (fs.existsSync(oldAssets)) {
      await F.renameRetry(oldAssets, this.assetsDir(m));
      if (m.ext === 'md' && oldName !== this.assetsName(m)) {
        const { body } = await this.read(id);
        const next = relinkAssets(body, oldName, this.assetsName(m));
        if (next !== body) await this.write(id, next);
      }
    }
    return m;
  }

  archive(id) {
    return this.move(id, true);
  }

  restore(id) {
    return this.move(id, false);
  }

  /** Moves the memo file and its assets folder to the Recycle Bin (never a permanent delete). */
  async trash(id) {
    const m = this.must(id);
    if (!this.trashItem) throw new Error('휴지통을 쓸 수 없습니다.');
    const assets = this.assetsDir(m);
    await this.trashItem(m.file);
    if (fs.existsSync(assets)) await this.trashItem(assets);
    this.cache.delete(lower(m.file));
    this.memos.delete(id);
  }

  /**
   * A .txt memo becomes "<제목>.md" with the same id (its text kept line by line, nothing interpreted); the .txt
   * file moves to the archive folder. Returns the new memo.
   */
  async convertToMd(id) {
    const m = this.must(id);
    if (m.ext !== 'txt') return m;
    const { body } = await this.read(id);
    const { title: t, file } = F.uniqueFileName(path.dirname(m.file), m.title, 'md', {
      // The .txt file itself does not block the .md name; its assets folder (if any) is shared.
      exists: (p) => fs.existsSync(p) && !(p.toLowerCase().endsWith('.assets') && lower(p) === lower(this.assetsDir(m))),
    });
    const txt = { ...m };
    const next = { ...m, file, title: t, ext: 'md', fmLines: [] };
    const text = this.compose(next, md.textToMarkdown(body));
    await F.writeFileAtomic(file, text);
    this.memos.set(id, next);
    this.afterWrite(next, text);
    // Keep the original: into the archive folder under a free name.
    await fs.promises.mkdir(this.archiveDir, { recursive: true });
    const { file: archived } = F.uniqueFileName(this.archiveDir, txt.title, 'txt');
    await F.renameRetry(txt.file, archived);
    this.cache.delete(lower(txt.file));
    return next;
  }

  /** Path of an asset of this memo, or null when the name would leave the assets folder or does not exist. */
  resolveAsset(id, name) {
    const m = this.memos.get(id);
    if (!m || typeof name !== 'string' || !name || /[\\/]/.test(name) || name === '.' || name === '..') return null;
    const dir = this.assetsDir(m);
    const file = path.join(dir, name);
    if (!F.isInside(dir, file)) return null;
    try {
      if (!fs.statSync(file).isFile()) return null;
    } catch {
      return null;
    }
    return file;
  }

  /** A relative link of a memo (e.g. an image Obsidian put next to it), only inside the memo's own folder. */
  resolveRelative(id, rel) {
    const m = this.memos.get(id);
    if (!m || typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
    const dir = path.dirname(m.file);
    const file = path.resolve(dir, rel);
    if (!F.isInside(dir, file)) return null;
    try {
      if (!fs.statSync(file).isFile()) return null;
    } catch {
      return null;
    }
    return file;
  }

  /** Saves bytes (a pasted image) into the memo's assets folder under a free name; returns the name. */
  async addAssetBytes(id, wanted, bytes) {
    const m = this.must(id);
    const buf = Buffer.from(bytes);
    const ext = path.extname(wanted).toLowerCase();
    if (!IMAGE_TYPES[ext]) throw new Error('붙여넣을 수 있는 이미지는 PNG·JPEG·GIF·WebP입니다.');
    if (buf.length > MAX_IMAGE) throw new Error('이미지가 너무 큽니다 (20MB까지).');
    const dir = this.assetsDir(m);
    await fs.promises.mkdir(dir, { recursive: true });
    const name = F.uniqueAssetName(dir, wanted);
    await F.writeFileAtomic(path.join(dir, name), buf);
    return name;
  }

  /**
   * Copies a dropped file into the memo's assets folder; returns { name, image }. Only regular files; images up to
   * 20MB, other files up to 200MB. A file already in this memo's assets folder is linked, not copied again.
   */
  async addAssetFile(id, source) {
    const m = this.must(id);
    const src = path.resolve(String(source || ''));
    const st = await fs.promises.stat(src);
    if (!st.isFile()) throw new Error(`${path.basename(src)}: 폴더는 넣을 수 없습니다.`);
    const image = Boolean(IMAGE_TYPES[path.extname(src).toLowerCase()]);
    if (st.size > (image ? MAX_IMAGE : MAX_ATTACHMENT)) throw new Error(`${path.basename(src)}: 파일이 너무 큽니다 (${image ? '이미지 20MB' : '200MB'}까지).`);
    const dir = this.assetsDir(m);
    if (F.isInside(dir, src)) return { name: path.basename(src), image };
    await fs.promises.mkdir(dir, { recursive: true });
    const name = F.uniqueAssetName(dir, path.basename(src));
    const tmp = path.join(dir, `.${name}.copy.tmp`);
    await fs.promises.copyFile(src, tmp, fs.constants.COPYFILE_EXCL);
    await F.renameRetry(tmp, path.join(dir, name));
    return { name, image };
  }

  /** Does the memo own any file other programs would see as its attachment folder? */
  /**
   * The memo a [[link]] means (by title, case-insensitive, like Obsidian): an open-able memo first, then a
   * conflict copy, then an archived one. null when there is none.
   */
  findByTitle(target) {
    const key = md.wikiKey(target);
    if (!key) return null;
    const rank = (m) => (m.archived ? 2 : 0) + (m.conflictOf ? 1 : 0);
    return this.list()
      .filter((m) => m.title.normalize('NFC').toLowerCase() === key)
      .sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  /** Memos whose text links to this one ([[제목]] or a relative link to its file). */
  backlinks(id) {
    const m = this.memos.get(id);
    if (!m) return [];
    const key = m.title.normalize('NFC').toLowerCase();
    return this.list().filter((o) => o.id !== id && (o.links || []).includes(key));
  }

  hasAssets(id) {
    const m = this.memos.get(id);
    return Boolean(m && fs.existsSync(this.assetsDir(m)));
  }
}

function safeLinks(body) {
  try {
    return md.collectLinks(body);
  } catch {
    return [];
  }
}

function safePlain(body) {
  try {
    return md.toPlainText(body);
  } catch {
    return String(body);
  }
}

/** Rewrites link destinations "<old>.assets/..." to the new assets folder name (plain and percent-encoded forms). */
function relinkAssets(body, oldName, newName) {
  if (oldName === newName) return body;
  const forms = [...new Set([oldName, md.encodeDest(oldName), encodeURI(oldName)])];
  let out = body;
  for (const f of forms) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(\\]\\(<?)(?:\\./)?${esc}/`, 'g'), `$1${md.encodeDest(newName)}/`);
  }
  return out;
}

module.exports = { Library, relinkAssets, IMAGE_TYPES, ARCHIVE, MAX_IMAGE };
