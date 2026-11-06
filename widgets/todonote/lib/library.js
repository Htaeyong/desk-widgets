// The memo folder (#75): one memo = one .md file (or an imported .txt) in the notes folder, its images and
// attachments in "<file name>.assets" next to it, archived memos in the "보관함" subfolder, completed to-do notes in
// the "완료" subfolder (#111). This file only knows files; windows and editing sessions are in index.js / session.js.
// The index (this.memos) also holds each note's to-do keys from its front matter (lib/frontmatter.js), so reminders
// and the to-do list never read the files again.
//
// File names and titles (#113): a note the widget makes is "YYYYMMDD-HHmmss-<id>.md" (the local time it was made,
// also kept as "created:" in its front matter) and keeps that name for good: a new title, completing, archiving
// only change its front matter or the folder it is in. Its title is the front matter "title:". A file without a title
// line (.txt, or made by another program, e.g. "회의.md") uses its file name, and keeps that name too.
//
// Memo ids: a Markdown memo keeps its id in front matter ("desk-widgets-memo: <id>", written with the first save by
// the widget), so it survives renames by other programs. Files without one (a new .md from another app, .txt) get an
// id remembered by path in the widget's settings until the widget writes the file.
const fs = require('fs');
const path = require('path');
const md = require('./markdown');
const F = require('./files');
const FM = require('./frontmatter');
const L = require('./lock');

const ARCHIVE = '보관함';
const DONE = '완료';
const FOLDERS = { notes: '', archive: ARCHIVE, done: DONE };
const MAX_READ = 5 * 1024 * 1024; // larger files are listed but not opened
const SEARCH_CHARS = 200000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE = 20 * 1024 * 1024; // an image pasted or dropped
const MAX_ATTACHMENT = 200 * 1024 * 1024; // any other dropped file

const extOf = (file) => path.extname(file).slice(1).toLowerCase();
const lower = (p) => path.resolve(p).toLowerCase();
const stemOf = (file) => path.basename(file, path.extname(file));
const keyOf = (s) => String(s).normalize('NFC').toLowerCase();
// Plain versions of a locked note and replaced ciphertext are removed for good: the Recycle Bin would keep the plain text (#124).
const removeForGood = (file) => fs.promises.unlink(file);
const BACKUPS = '.sync-removed'; // the engine's folder of files replaced by a sync (engine/main/files-store.js)

class Library {
  /**
   * @param {object} o
   * @param {string} o.dir  the notes folder
   * @param {{ load(): object, save(map: object): void }} o.ids  remembered ids of files without front matter, by path
   * @param {(file: string) => Promise<void>} [o.trash]  moves a file or folder to the Recycle Bin (shell.trashItem)
   * @param {{ N: number, r: number, p: number }} [o.kdf]  scrypt settings of newly locked notes (tests)
   */
  constructor({ dir, ids, trash, kdf = L.KDF }) {
    this.dir = path.resolve(dir);
    this.ids = ids;
    this.trashItem = trash;
    this.memos = new Map(); // id -> memo
    this.cache = new Map(); // lower(path) -> { mtimeMs, size, fmId, preview, search }
    this.kdf = kdf;
    this.keys = new Map(); // id -> { dek, header }: only the notes whose window is open and unlocked (#124)
  }

  get archiveDir() {
    return path.join(this.dir, ARCHIVE);
  }

  get doneDir() {
    return path.join(this.dir, DONE);
  }

  folderDir(folder) {
    return path.join(this.dir, FOLDERS[folder]);
  }

  async ensureDir() {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  /** Reads what the cache needs of a file: its front matter id and text for the list. */
  async inspect(file, st) {
    const key = lower(file);
    const hit = this.cache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    let info = { mtimeMs: st.mtimeMs, size: st.size, fmId: null, fmTitle: null, created: null, preview: '', search: '', links: [], todo: null, tooBig: st.size > MAX_READ };
    if (!info.tooBig) {
      try {
        const text = await fs.promises.readFile(file, 'utf8');
        const ext = extOf(file);
        const fm = ext === 'md' ? md.splitFrontMatter(text) : { body: text, id: null };
        const locked = ext === 'md' && L.isLocked(fm.body);
        const plain = locked ? '' : ext === 'md' ? safePlain(fm.body) : fm.body;
        // A locked note's front matter is plain; its body stays out of the index (#124).
        info = { ...info, fmId: fm.id, fmTitle: ext === 'md' ? md.frontMatterTitle(fm.lines) : null, created: ext === 'md' ? md.frontMatterCreated(fm.lines) : null, preview: plain.replace(/\s+/g, ' ').trim().slice(0, 160), search: plain.slice(0, SEARCH_CHARS).toLowerCase(), links: ext === 'md' && !locked ? safeLinks(fm.body) : [], todo: todoOf(fm.lines), locked, lockDamaged: locked && !L.parseBody(fm.body) };
      } catch {
        // unreadable for now (locked, syncing): listed without text
      }
    }
    this.cache.set(key, info);
    return info;
  }

  async listFiles(dir, folder) {
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
      out.push({ file, st, folder });
    }
    return out;
  }

  /**
   * Reads the folder again. Returns what changed since the last scan:
   * { added: id[], removed: id[], changed: id[] (content may differ), moved: id[] (other file name) }.
   */
  async scan() {
    const found = [...(await this.listFiles(this.dir, 'notes')), ...(await this.listFiles(this.archiveDir, 'archive')), ...(await this.listFiles(this.doneDir, 'done'))];
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
        title: f.info.fmTitle || stemOf(f.file),
        fmTitle: f.info.fmTitle || null,
        created: f.info.created ?? null,
        ext,
        folder: f.folder,
        archived: f.folder === 'archive',
        done: f.folder === 'done',
        mtimeMs: f.st.mtimeMs,
        size: f.st.size,
        tooBig: f.info.tooBig,
        hasFmId: Boolean(f.info.fmId) && !conflictOf,
        conflictOf,
        preview: f.info.preview,
        search: f.info.search,
        links: f.info.links || [],
        todo: f.info.todo || null,
        locked: Boolean(f.info.locked),
        lockDamaged: Boolean(f.info.lockDamaged),
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
    for (const id of this.memos.keys()) {
      if (next.has(id)) continue;
      changes.removed.push(id);
      this.forget(id);
    }
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
    return `${stemOf(memo.file)}.assets`;
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
    m.locked = L.isLocked(fm.body);
    if (!m.locked) {
      this.forget(id); // unlocked on another PC
      return { text, body: fm.body, fmLines: fm.lines, hash: F.hashText(text) };
    }
    return { text, body: this.openText(m, fm.body), fmLines: fm.lines, hash: F.hashText(text) };
  }

  /** The body of a locked note's file text, with the key this window was unlocked with. */
  openText(m, text) {
    const key = this.keys.get(m.id);
    if (!key) throw L.fail('locked');
    const parsed = L.parseBody(text);
    if (!parsed) throw L.fail('corrupt');
    if (!L.sameWrap(parsed.header, key.header)) throw L.fail('changed');
    const { body, assets } = L.openBody(key.dek, parsed);
    // The file got another name while locked (a name clash, a sync copy): the links follow here, nothing could read them before.
    return assets && assets !== this.assetsName(m) ? relinkAssets(body, assets, this.assetsName(m)) : body;
  }

  /** Is this note open with its password? */
  isUnlocked(id) {
    return this.keys.has(id);
  }

  /** Drops a note's key from memory (its window closed). */
  forget(id) {
    const key = this.keys.get(id);
    if (!key) return;
    key.dek.fill(0);
    this.keys.delete(id);
  }

  forgetAll() {
    for (const id of [...this.keys.keys()]) this.forget(id);
  }

  /** Is the key of this open note still the file's? False: the password was changed on another PC. */
  async keyStillFits(id) {
    const m = this.must(id);
    const key = this.keys.get(id);
    if (!key) return false;
    const parsed = L.parseBody(md.splitFrontMatter(await fs.promises.readFile(m.file, 'utf8')).body);
    return !parsed || L.sameWrap(parsed.header, key.header);
  }

  must(id) {
    const m = this.memos.get(id);
    if (!m) throw new Error('노트를 찾을 수 없습니다.');
    return m;
  }

  /** The file's whole text for a body: our front matter id on .md memos (other front matter lines kept). */
  compose(m, body) {
    return m.ext === 'md' ? md.joinFrontMatter(md.withFrontMatterTitle(m.fmLines, m.title), m.id, m.locked ? this.sealText(m, body) : body) : body;
  }

  /** A locked note's file body for a text. A note that would no longer open (5MB) is refused; the text stays in the window. */
  sealText(m, body, key = this.keys.get(m.id)) {
    if (!key) throw L.fail('locked');
    const sealed = L.sealBody(key.dek, key.header, { body, assets: this.assetsName(m) });
    if (Buffer.byteLength(sealed) > MAX_READ) throw new L.LockError('too-big', '잠긴 노트가 5MB를 넘어 저장하지 못했습니다. 글을 줄여 주세요.');
    return sealed;
  }

  afterWrite(m, text) {
    try {
      const st = fs.statSync(m.file);
      m.mtimeMs = st.mtimeMs;
      m.size = st.size;
    } catch {}
    m.hasFmId = m.ext === 'md';
    m.conflictOf = null;
    const split = m.ext === 'md' ? md.splitFrontMatter(text) : null;
    m.locked = Boolean(split && L.isLocked(split.body));
    m.lockDamaged = false;
    const plain = m.locked ? '' : split ? safePlain(split.body) : text;
    m.preview = plain.replace(/\s+/g, ' ').trim().slice(0, 160);
    m.search = plain.slice(0, SEARCH_CHARS).toLowerCase();
    const fm = m.ext === 'md' ? md.splitFrontMatter(text) : null;
    m.fmTitle = fm ? md.frontMatterTitle(fm.lines) : null;
    m.created = fm ? md.frontMatterCreated(fm.lines) : null;
    m.links = fm && !m.locked ? safeLinks(fm.body) : [];
    m.todo = fm ? todoOf(fm.lines) : null;
    this.cache.set(lower(m.file), { mtimeMs: m.mtimeMs, size: m.size, fmId: m.ext === 'md' ? m.id : null, fmTitle: m.fmTitle, created: m.created, preview: m.preview, search: m.search, links: m.links, todo: m.todo, tooBig: false, locked: m.locked, lockDamaged: false });
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

  /**
   * Changes front matter keys of a Markdown memo (patch { key: value | null }, lib/frontmatter.js) and, when given,
   * its body in the same write. The file is read again first so outside lines (Obsidian properties) are kept.
   * Returns { hash, body }.
   */
  async updateFrontMatter(id, patch, body = undefined) {
    const m = this.must(id);
    if (m.ext !== 'md') throw new Error('날짜는 Markdown 노트에만 걸 수 있습니다.');
    if (m.locked && body === undefined) {
      // Front matter is plain in a locked note: it changes without the password and the ciphertext stays as it is.
      const fm = md.splitFrontMatter(await fs.promises.readFile(m.file, 'utf8'));
      m.fmLines = FM.setValues(fm.lines || [], patch);
      const text = md.joinFrontMatter(md.withFrontMatterTitle(m.fmLines, m.title), m.id, fm.body);
      await F.writeFileAtomic(m.file, text);
      return { hash: this.afterWrite(m, text), body: this.keys.has(id) ? this.openText(m, fm.body) : undefined };
    }
    const current = await this.read(id);
    m.fmLines = FM.setValues(current.fmLines || [], patch);
    const next = body === undefined ? current.body : body;
    const text = this.compose(m, next);
    await F.writeFileAtomic(m.file, text);
    return { hash: this.afterWrite(m, text), body: next };
  }

  /** A new memo file (front matter id included) and its record. `fm`: to-do keys to start with. */
  async create({ title = F.DEFAULT_TITLE, body = '', id = F.newId(), fm = null, folder = 'notes', lockedLike = null } = {}) {
    await this.ensureDir();
    const dir = this.folderDir(folder);
    if (folder !== 'notes') await fs.promises.mkdir(dir, { recursive: true });
    const now = Date.now();
    const fmLines = [`created: ${new Date(now).toISOString()}`, ...(fm ? FM.setValues([], fm) : [])];
    const m = { id, file: newNoteFile(dir, id, now), title: F.sanitizeTitle(title), ext: 'md', folder, archived: folder === 'archive', done: folder === 'done', mtimeMs: 0, size: 0, fmLines, hasFmId: true, conflictOf: null, preview: '', search: '', todo: todoOf(fmLines) };
    if (lockedLike) {
      // A copy of a locked note's text ("내 사본"): locked with the same password.
      const key = this.keys.get(lockedLike);
      if (!key) throw L.fail('locked');
      m.locked = true;
      this.keys.set(id, { dek: Buffer.from(key.dek), header: key.header });
    }
    const text = this.compose(m, body);
    await F.writeFileAtomic(m.file, text);
    this.memos.set(id, m);
    this.afterWrite(m, text);
    return m;
  }

  /**
   * Gives a memo a new title (#113). A Markdown memo: only its front matter "title:" changes; the file, its assets
   * folder and the links to them stay. A .txt memo (no front matter) is renamed: its title is its file name.
   * Returns the memo; nothing happens when the title stays the same.
   */
  async rename(id, title) {
    const m = this.must(id);
    const wanted = F.sanitizeTitle(title);
    if (wanted === m.title) return m;
    if (m.ext === 'md') {
      m.title = wanted;
      if (m.locked) {
        await this.updateFrontMatter(id, {});
        return m;
      }
      const { body } = await this.read(id);
      await this.write(id, body);
      return m;
    }
    const dir = path.dirname(m.file);
    const { title: stem, file } = F.uniqueFileName(dir, wanted, m.ext, { keep: m.file });
    const oldTitle = m.title;
    const oldAssets = this.assetsDir(m);
    const oldFile = m.file;
    if (file !== oldFile) {
      await F.renameRetry(oldFile, file);
      m.file = file;
      this.cache.delete(lower(oldFile));
    }
    m.title = stem;
    if (file !== oldFile && fs.existsSync(oldAssets)) {
      try {
        await F.renameRetry(oldAssets, this.assetsDir(m));
      } catch (err) {
        // The memo keeps working with the old folder name until the next rename: put the file name back.
        await F.renameRetry(file, oldFile).catch(() => {});
        m.file = oldFile;
        m.title = oldTitle;
        throw err;
      }
    }
    return m;
  }

  /** Moves a memo (and its assets) between the notes folder and the archive folder. */
  move(id, toArchive) {
    return this.moveTo(id, toArchive ? 'archive' : 'notes');
  }

  /**
   * Moves a memo (and its assets) into one of the folders: 'notes', 'archive', 'done', under the same file name
   * (#113). Only if that name is taken there (another program's file) it gets " (2)" and its links follow.
   */
  async moveTo(id, folder) {
    const m = this.must(id);
    if ((m.folder || 'notes') === folder) return m;
    const target = this.folderDir(folder);
    await fs.promises.mkdir(target, { recursive: true });
    const oldAssets = this.assetsDir(m);
    const oldName = this.assetsName(m);
    const { title: stem, file } = F.uniqueFileName(target, stemOf(m.file), m.ext);
    await F.renameRetry(m.file, file);
    this.cache.delete(lower(m.file));
    m.file = file;
    if (m.ext !== 'md') m.title = stem; // a .txt memo's title is its file name
    m.folder = folder;
    m.archived = folder === 'archive';
    m.done = folder === 'done';
    let relink = false;
    if (fs.existsSync(oldAssets)) {
      await F.renameRetry(oldAssets, this.assetsDir(m));
      relink = oldName !== this.assetsName(m);
    }
    // A file name that had to change: the title goes into the front matter (it was the old file name), the links too.
    if (m.locked) {
      // The links in the ciphertext follow when it is opened (openText); the title needs no password.
      if (m.fmTitle !== m.title && stemOf(file) !== m.title) await this.updateFrontMatter(id, {});
    } else if (m.ext === 'md' && (relink || (m.fmTitle !== m.title && stemOf(file) !== m.title))) {
      const { body } = await this.read(id);
      await this.write(id, relink ? relinkAssets(body, oldName, this.assetsName(m)) : body);
    }
    return m;
  }

  archive(id) {
    return this.move(id, true);
  }

  restore(id) {
    return this.move(id, false);
  }

  /** A completed to-do note goes into the "완료" folder (#111). */
  complete(id) {
    return this.moveTo(id, 'done');
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
    this.forget(id);
  }

  /**
   * A .txt memo becomes a new id-named .md note with the same id and title (its text kept line by line, nothing
   * interpreted; its assets folder, if any, follows); the .txt file moves to the archive folder. Returns the new memo.
   */
  async convertToMd(id) {
    const m = this.must(id);
    if (m.ext !== 'txt') return m;
    const { body } = await this.read(id);
    const now = Date.now();
    const file = newNoteFile(path.dirname(m.file), id, now);
    const txt = { ...m };
    const next = { ...m, file, ext: 'md', fmLines: [`created: ${new Date(now).toISOString()}`] };
    const text = this.compose(next, md.textToMarkdown(body));
    await F.writeFileAtomic(file, text);
    if (fs.existsSync(this.assetsDir(txt))) await F.renameRetry(this.assetsDir(txt), this.assetsDir(next));
    this.memos.set(id, next);
    this.afterWrite(next, text);
    // Keep the original: into the archive folder under a free name.
    await fs.promises.mkdir(this.archiveDir, { recursive: true });
    const { file: archived } = F.uniqueFileName(this.archiveDir, stemOf(txt.file), 'txt');
    await F.renameRetry(txt.file, archived);
    this.cache.delete(lower(txt.file));
    return next;
  }

  /** Path of an asset of this memo, or null when the name would leave the assets folder or does not exist. */
  resolveAsset(id, name) {
    const m = this.memos.get(id);
    if (!m || typeof name !== 'string' || !name || /[\\/]/.test(name) || name === '.' || name === '..') return null;
    const dir = this.assetsDir(m);
    let file = path.join(dir, name);
    if (m.locked) {
      const key = this.keys.get(id);
      if (!key) return null;
      file = path.join(dir, L.assetFileName(key.dek, name));
    }
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

  /** { name, bytes } of an attachment of an unlocked note, or null. Nothing of it is kept or written (#124). */
  readLockedAsset(id, name) {
    const file = this.resolveAsset(id, name);
    if (!file) return null;
    const asset = L.openAsset(this.keys.get(id).dek, fs.readFileSync(file));
    if (asset.name !== String(name).normalize('NFC')) throw L.fail('corrupt'); // another attachment's file put in its place
    return asset;
  }

  /** Encrypts bytes into a locked note's assets folder under a free name; returns the name. */
  async addLockedAsset(m, dir, wanted, bytes) {
    const key = this.keys.get(m.id);
    if (!key) throw L.fail('locked');
    await fs.promises.mkdir(dir, { recursive: true });
    const name = F.uniqueAssetName(dir, wanted, { exists: (p) => fs.existsSync(path.join(dir, L.assetFileName(key.dek, path.basename(p)))) });
    await F.writeFileAtomic(path.join(dir, L.assetFileName(key.dek, name)), L.sealAsset(key.dek, name, bytes));
    return name;
  }

  /** Saves bytes (a pasted image) into the memo's assets folder under a free name; returns the name. */
  async addAssetBytes(id, wanted, bytes) {
    const m = this.must(id);
    const buf = Buffer.from(bytes);
    const ext = path.extname(wanted).toLowerCase();
    if (!IMAGE_TYPES[ext]) throw new Error('붙여넣을 수 있는 이미지는 PNG·JPEG·GIF·WebP입니다.');
    if (buf.length > MAX_IMAGE) throw new Error('이미지가 너무 큽니다 (20MB까지).');
    const dir = this.assetsDir(m);
    if (m.locked) return this.addLockedAsset(m, dir, wanted, buf);
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
    if (m.locked) return { name: await this.addLockedAsset(m, dir, path.basename(src), await fs.promises.readFile(src)), image };
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
   * The memo a [[link]] means (by title, case-insensitive): an open-able memo first, then a completed one, a
   * conflict copy, an archived one; among the same kind the most recently completed, then the most recently changed
   * (several memos may share a title, #113). With no such title, the file name decides (a link typed by hand to a
   * file name). null when there is none.
   */
  findByTitle(target) {
    const key = md.wikiKey(target);
    if (!key) return null;
    const rank = (m) => (m.archived ? 4 : m.done ? 2 : 0) + (m.conflictOf ? 1 : 0);
    const pick = (list) => list.sort((a, b) => rank(a) - rank(b) || (b.todo?.completedAt || 0) - (a.todo?.completedAt || 0) || b.mtimeMs - a.mtimeMs)[0] || null;
    const all = this.list();
    return pick(all.filter((m) => keyOf(m.title) === key)) || pick(all.filter((m) => keyOf(stemOf(m.file)) === key));
  }

  /**
   * Memos whose text links to this one ([[제목]], [[file name]] or a relative link to its file), counted only when
   * that link means this memo (the same title may belong to another one, #113).
   */
  backlinks(id) {
    const m = this.memos.get(id);
    if (!m) return [];
    const keys = [m.title, stemOf(m.file)].filter((k) => this.findByTitle(k)?.id === id).map(keyOf);
    if (!keys.length) return [];
    return this.list().filter((o) => o.id !== id && (o.links || []).some((k) => keys.includes(k)));
  }

  // ---- locking (#124, docs/todonote-lock-design.md) ----

  /** The plain files of a note's assets folder (a locked note: those that are not encrypted yet). */
  plainAssets(m) {
    let entries = [];
    try {
      entries = fs.readdirSync(this.assetsDir(m), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isFile() && !L.isAssetFile(e.name) && !e.name.startsWith('.')).map((e) => e.name);
  }

  /** Encrypts the plain attachments, each checked by reading it back. Returns [{ plain, sealed }]; nothing is removed yet. */
  async sealAssets(m, dek) {
    const dir = this.assetsDir(m);
    const done = [];
    for (const name of this.plainAssets(m)) {
      const bytes = await fs.promises.readFile(path.join(dir, name));
      const sealed = L.sealAsset(dek, name, bytes);
      const back = L.openAsset(dek, sealed);
      if (back.name !== name.normalize('NFC') || !back.bytes.equals(bytes)) throw new Error('첨부 파일을 암호화하지 못했습니다.');
      const target = path.join(dir, L.assetFileName(dek, name));
      await F.writeFileAtomic(target, sealed);
      done.push({ plain: path.join(dir, name), sealed: target });
    }
    return done;
  }

  /**
   * Locks a Markdown note with a new password. The attachments are encrypted first and the note file is replaced in
   * one atomic step; only then the plain attachments are removed (for good, they do not go to the Recycle Bin).
   * Whatever fails before that leaves the plain note as it was; a crash after it leaves plain attachments that the
   * next unlock encrypts. Returns { hash, left: names of plain attachments that could not be removed }.
   */
  async lock(id, password) {
    const m = this.must(id);
    if (m.ext !== 'md') throw new Error('Markdown 노트만 잠글 수 있습니다.');
    if (m.locked) throw new Error('이미 잠긴 노트입니다.');
    const problem = L.passwordProblem(password);
    if (problem) throw new Error(problem);
    const { body } = await this.read(id);
    const key = await L.newKey(password, this.kdf);
    let assets = [];
    try {
      assets = await this.sealAssets(m, key.dek);
      this.keys.set(id, key);
      m.locked = true;
      const text = this.compose(m, body);
      if (L.openBody(key.dek, L.parseBody(md.splitFrontMatter(text).body)).body !== body) throw new Error('노트를 암호화하지 못했습니다.');
      await F.writeFileAtomic(m.file, text);
      const hash = this.afterWrite(m, text);
      const left = [];
      for (const a of assets) {
        try {
          await removeForGood(a.plain);
        } catch {
          left.push(path.basename(a.plain));
        }
      }
      return { hash, left };
    } catch (err) {
      m.locked = false;
      this.forget(id);
      for (const a of assets) await removeForGood(a.sealed).catch(() => {});
      throw err;
    }
  }

  /** Opens a locked note with its password for as long as its window stays open. LockError: wrong password, damaged. */
  async unlock(id, password) {
    const m = this.must(id);
    const fm = md.splitFrontMatter(await fs.promises.readFile(m.file, 'utf8'));
    if (!L.isLocked(fm.body)) return { sealed: 0 };
    const parsed = L.parseBody(fm.body);
    if (!parsed) throw L.fail('corrupt');
    const dek = await L.openKey(parsed.header, password);
    L.openBody(dek, parsed); // a damaged body says so now, not at the first save
    this.forget(id);
    this.keys.set(id, { dek, header: parsed.header });
    m.locked = true;
    // Plain attachments left by a crash while locking, or put here by another program.
    const loose = await this.sealAssets(m, dek);
    for (const a of loose) await removeForGood(a.plain).catch(() => {});
    return { sealed: loose.length };
  }

  /** Checks the password of a locked note (also while it is open): { parsed, dek }, or throws LockError. */
  async checkPassword(id, password) {
    const m = this.must(id);
    const parsed = L.parseBody(md.splitFrontMatter(await fs.promises.readFile(m.file, 'utf8')).body);
    if (!parsed) throw L.fail('corrupt');
    return { parsed, dek: await L.openKey(parsed.header, password) };
  }

  /** A new password for an open locked note: only the wrapped key changes, the attachments stay. Returns the new hash. */
  async changePassword(id, current, next) {
    const m = this.must(id);
    const problem = L.passwordProblem(next);
    if (problem) throw new Error(problem);
    const { dek } = await this.checkPassword(id, current);
    const { body } = await this.read(id);
    const header = await L.wrapKey(dek, next, this.kdf);
    this.forget(id);
    this.keys.set(id, { dek, header });
    const text = this.compose(m, body);
    await F.writeFileAtomic(m.file, text);
    return this.afterWrite(m, text);
  }

  /**
   * Takes the lock off for good: attachments and text are plain again, under their own names. The plain attachments
   * are written first; only after the note file is plain the encrypted ones are removed. Returns { hash, body }.
   */
  async removeLock(id, password) {
    const m = this.must(id);
    if (!m.locked) throw new Error('잠긴 노트가 아닙니다.');
    const { dek } = await this.checkPassword(id, password);
    if (!this.keys.has(id)) throw L.fail('locked');
    const { body } = await this.read(id);
    const dir = this.assetsDir(m);
    const sealedFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter(L.isAssetFile) : [];
    const written = [];
    try {
      for (const fileName of sealedFiles) {
        const asset = L.openAsset(dek, await fs.promises.readFile(path.join(dir, fileName)));
        const target = path.join(dir, path.basename(asset.name));
        if (!F.isInside(dir, target) || fs.existsSync(target)) throw L.fail('corrupt');
        await F.writeFileAtomic(target, asset.bytes);
        written.push(target);
      }
      m.locked = false;
      const text = this.compose(m, body);
      await F.writeFileAtomic(m.file, text);
      const hash = this.afterWrite(m, text);
      this.forget(id);
      for (const fileName of sealedFiles) await removeForGood(path.join(dir, fileName)).catch(() => {});
      return { hash, body };
    } catch (err) {
      m.locked = true;
      for (const file of written) await removeForGood(file).catch(() => {});
      throw err;
    } finally {
      dek.fill(0);
    }
  }

  /** The conflict copy of a locked note's text at shutdown: a new file, locked with the same key. { file, text } */
  lockedCopy(m, body) {
    const id = F.newId();
    const now = Date.now();
    const copy = { ...m, id, title: F.sanitizeTitle(`${m.title} (내 사본)`), file: newNoteFile(path.dirname(m.file), id, now), fmLines: [`created: ${new Date(now).toISOString()}`] };
    return { file: copy.file, text: md.joinFrontMatter(md.withFrontMatterTitle(copy.fmLines, copy.title), id, this.sealText(copy, body, this.keys.get(m.id))) };
  }

  /**
   * The engine keeps files a sync replaced in ".sync-removed" for 30 days: a note locked on another PC leaves its plain
   * version there. Those of notes that are locked now are removed for good. Returns how many.
   */
  async purgePlainBackups() {
    const root = path.join(this.dir, BACKUPS);
    if (!fs.existsSync(root)) return 0;
    const locked = this.list().filter((m) => m.locked);
    if (!locked.length) return 0;
    const ids = new Set(locked.map((m) => m.id));
    const stems = new Set(locked.map((m) => stemOf(m.file).toLowerCase()));
    const assets = new Set(locked.map((m) => this.assetsName(m).toLowerCase()));
    let removed = 0;
    const walk = async (dir) => {
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile() && !L.isAssetFile(e.name) && (await isPlainBackup(full, e.name, ids, stems, assets))) {
          await removeForGood(full).catch(() => {});
          removed++;
        }
      }
    };
    await walk(root);
    return removed;
  }

  /** Plain copies of this note next to it (OneDrive conflict copies with the same id): how many. */
  conflictCopies(id) {
    return this.list().filter((o) => o.conflictOf === id && !o.locked).length;
  }

  hasAssets(id) {
    const m = this.memos.get(id);
    return Boolean(m && fs.existsSync(this.assetsDir(m)));
  }
}

/** Is this file in the engine's backups the plain version of a note that is locked now? */
async function isPlainBackup(full, name, ids, stems, assets) {
  if (assets.has(path.basename(path.dirname(full)).toLowerCase())) return true;
  if (!/\.(md|txt)$/i.test(name)) return false;
  const fm = md.splitFrontMatter(await fs.promises.readFile(full, 'utf8').catch(() => ''));
  if (L.isLocked(fm.body)) return false;
  return fm.id ? ids.has(fm.id) : stems.has(stemOf(name).toLowerCase());
}

/** The file of a new note in dir: "YYYYMMDD-HHmmss-<id>.md" (#113), " (2)" only for a clash that should not happen. */
function newNoteFile(dir, id, created) {
  return F.uniqueFileName(dir, F.idFileStem(id, created), 'md').file;
}

/** The to-do keys of front matter lines, or null for a plain note (no front matter or none of our keys). */
function todoOf(lines) {
  if (!lines || !FM.hasTodoKeys(lines)) return null;
  try {
    return FM.readTodo(lines);
  } catch {
    return null;
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
  const forms = [...new Set([oldName, md.encodeDest(oldName), encodeURI(oldName), oldName.replace(/ /g, '%20')])];
  let out = body;
  for (const f of forms) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(\\]\\(<?)(?:\\./)?${esc}/`, 'g'), `$1${md.encodeDest(newName)}/`);
  }
  return out;
}

module.exports = { Library, relinkAssets, IMAGE_TYPES, ARCHIVE, DONE, MAX_IMAGE };
