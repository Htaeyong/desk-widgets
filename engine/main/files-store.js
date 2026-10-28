// Engine file store (#108, ctx.files): a widget's note folder on this PC. The widget lists, reads, writes and
// deletes files in it; the engine watches it and exchanges it with other PCs. Sync state holds hashes and
// immutable blobs in the sync folder hold the bytes. The folder itself never moves into the sync folder.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_BACKUP_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_DIR = '.sync-removed';
const RETRY_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function relativeName(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Invalid note path');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Invalid note path');
  return parts.join('/');
}

async function statNoLink(file) {
  try {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${file}`);
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function safePath(root, relative, { createParent = false } = {}) {
  const name = relativeName(relative);
  const base = path.resolve(root);
  const file = path.resolve(base, ...name.split('/'));
  if (!inside(base, file)) throw new Error('Note path leaves its folder');
  if (createParent) await fsp.mkdir(base, { recursive: true });
  const rootStat = await statNoLink(base);
  if (rootStat && !rootStat.isDirectory()) throw new Error('Note folder is not a directory');
  let current = base;
  const parts = name.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (createParent && i < parts.length - 1) await fsp.mkdir(current, { recursive: false }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await statNoLink(current);
    if (stat && i < parts.length - 1 && !stat.isDirectory()) throw new Error('Note path has a file parent');
  }
  return file;
}

async function readLimited(file, limit) {
  const stat = await statNoLink(file);
  if (!stat || !stat.isFile() || stat.size > limit) throw new Error('Note file is missing, unsafe, or too large');
  const bytes = await fsp.readFile(file);
  if (bytes.length > limit) throw new Error('Note file grew beyond its size limit');
  return bytes;
}

async function atomicBytes(file, bytes) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  const handle = await fsp.open(temp, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(temp, file);
        return;
      } catch (error) {
        if (attempt >= 4 || !RETRY_CODES.has(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 30 * 2 ** attempt));
      }
    }
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

async function atomicNewBytes(file, bytes) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  const handle = await fsp.open(temp, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Publishing a completed hard link fails if another writer created the target meanwhile.
    await fsp.link(temp, file);
  } finally {
    await fsp.unlink(temp).catch(() => {});
  }
}

async function walkFiles(root, include) {
  const result = [];
  if (!(await statNoLink(root))) return result;
  async function visit(folder, prefix = '') {
    for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
      // In-flight temp files (ours and the widgets' atomic saves) are not notes yet.
      if (entry.name === BACKUP_DIR || /^\..*\.tmp(?:-[a-f0-9]+)?$/i.test(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = await safePath(root, rel);
      const stat = await statNoLink(file);
      if (!stat) continue;
      if (stat.isDirectory()) await visit(file, rel);
      else if (stat.isFile() && include(rel)) result.push(rel);
    }
  }
  await visit(root);
  return result;
}

function noteAssetPrefix(notePath) {
  const stem = notePath.replace(/\.(?:md|txt)$/i, '');
  return `${stem}.assets/`;
}

function validValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid note record');
  const notePath = relativeName(value.path);
  if (!/\.(?:md|txt)$/i.test(notePath) || !isHash(value.blob) || !value.assets || typeof value.assets !== 'object' || Array.isArray(value.assets)) throw new Error('Invalid note record');
  const prefix = noteAssetPrefix(notePath).toLowerCase();
  for (const [rel, blob] of Object.entries(value.assets)) {
    if (!relativeName(rel).toLowerCase().startsWith(prefix) || !isHash(blob)) throw new Error('Invalid note attachment');
  }
  return { path: notePath, blob: value.blob, assets: value.assets };
}

function blobPath(cloudRoot, digest) {
  if (!isHash(digest)) throw new Error('Invalid blob hash');
  return `${cloudRoot}/blobs/${digest.slice(0, 2)}/${digest}`;
}

async function readBlob(cloudRoot, digest, limit) {
  const relative = `blobs/${digest.slice(0, 2)}/${digest}`;
  const file = await safePath(cloudRoot, relative);
  if (!(await statNoLink(file))) {
    const error = new Error('Cloud blob has not arrived');
    error.code = 'ENOENT';
    throw error;
  }
  const bytes = await readLimited(file, limit);
  if (hash(bytes) !== digest) {
    const error = new Error('Cloud blob hash mismatch');
    error.code = 'BLOB_MISMATCH';
    throw error;
  }
  return bytes;
}

async function saveBlob(cloudRoot, digest, file, limit) {
  const bytes = await readLimited(file, limit);
  if (hash(bytes) !== digest) throw new Error('Note changed during sync');
  const relative = `blobs/${digest.slice(0, 2)}/${digest}`;
  const target = await safePath(cloudRoot, relative, { createParent: true });
  if (await statNoLink(target)) {
    await readBlob(cloudRoot, digest, limit);
    return;
  }
  try { await atomicBytes(target, bytes); }
  catch (error) {
    // Another PC may have written the same immutable blob between the check and rename.
    if (!(await statNoLink(target))) throw error;
    await readBlob(cloudRoot, digest, limit);
  }
}

async function archive(root, relative) {
  const old = await safePath(root, relative);
  if (!(await statNoLink(old))) return;
  const saved = `${BACKUP_DIR}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}/${relativeName(relative)}`;
  const target = await safePath(root, saved, { createParent: true });
  await fsp.rename(old, target);
}

async function pruneBackups(root, retentionDays) {
  const folder = await safePath(root, BACKUP_DIR);
  const stat = await statNoLink(folder);
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error('Note backup path is not a directory');
  for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
    const match = /^(\d{13})-[a-f0-9]{8}$/.exec(entry.name);
    if (!match) continue;
    const createdAt = Number(match[1]);
    if (createdAt > Date.now() || Date.now() - createdAt < retentionDays * DAY_MS) continue;
    const target = await safePath(root, `${BACKUP_DIR}/${entry.name}`);
    const entryStat = await statNoLink(target);
    if (entryStat?.isDirectory()) await fsp.rm(target, { recursive: true, force: true });
  }
}

/**
 * @param {object|null} manager  the SyncManager (null: no sync; the store still works on this PC)
 * @param {string} widgetId
 * @param {{ name: string, dir: () => string, include: (rel) => boolean, idOf: (rel, text) => string|Promise<string>,
 *   beforeSync?: () => any, onRemoteChange?: (paths: string[]) => any, maxFileBytes?: number, backupRetentionDays?: number }} descriptor
 * @param {{ onLocalChange?: () => void, migrate?: (info: object) => void }} options
 */
function openFileStore(manager, widgetId, descriptor, { onLocalChange = () => {}, migrate = null } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(widgetId) || !descriptor || !/^[a-z0-9][a-z0-9-]*$/.test(descriptor.name) ||
      typeof descriptor.dir !== 'function' || typeof descriptor.include !== 'function' || typeof descriptor.idOf !== 'function') {
    throw new Error('Invalid file store descriptor');
  }
  const name = `${widgetId}-${descriptor.name}`;
  const limit = Number.isSafeInteger(descriptor.maxFileBytes) && descriptor.maxFileBytes > 0 ? descriptor.maxFileBytes : DEFAULT_MAX_FILE_BYTES;
  const backupRetentionDays = Number.isSafeInteger(descriptor.backupRetentionDays) && descriptor.backupRetentionDays > 0 ? descriptor.backupRetentionDays : DEFAULT_BACKUP_RETENTION_DAYS;
  const staged = new Map();
  const listeners = new Set();
  let watcher = null;
  let watchDelay = null;
  let suppressUntil = 0;
  const root = () => path.resolve(descriptor.dir());
  // A note folder that overlaps the sync folder would write every note twice (and export its own exports).
  // Folders inside OneDrive and the like are exchanged normally: Windows often backs up Documents to OneDrive,
  // and that does not move notes to the user's other PC (field test, #108).
  const cloudManaged = (selectedFolder = manager?.folder) => Boolean(selectedFolder) &&
    (inside(selectedFolder, root()) || inside(root(), selectedFolder));
  const recordKey = (id) => `${widgetId}/${descriptor.name}/${hash(Buffer.from(String(id)))}`;

  const notify = (paths, remote) => {
    for (const listener of listeners) {
      try { listener({ paths, remote }); } catch (error) { console.error(`files: ${name} listener: ${error.message}`); }
    }
  };

  function startWatch() {
    if (watcher || !listeners.size) return;
    try {
      fs.mkdirSync(root(), { recursive: true });
      watcher = fs.watch(root(), { recursive: true, persistent: false }, (_kind, filename) => {
        const rel = String(filename || '').replace(/\\/g, '/');
        // Temp files, the removed-files backup and our own writes are not the user's changes.
        if (rel.split('/').some((part) => part.startsWith('.')) || Date.now() < suppressUntil) return;
        if (watchDelay) clearTimeout(watchDelay);
        watchDelay = setTimeout(() => {
          watchDelay = null;
          notify(rel ? [rel] : [], false);
          onLocalChange();
        }, 300);
        watchDelay.unref?.();
      });
      watcher.on('error', () => stopWatch());
    } catch {
      watcher = null; // The widget's own scan still finds changes on cloud drives without watch support.
    }
  }

  function stopWatch() {
    watcher?.close();
    watcher = null;
    if (watchDelay) clearTimeout(watchDelay);
    watchDelay = null;
  }

  async function read({ folder: selectedFolder } = {}) {
    if (cloudManaged(selectedFolder)) return null;
    await descriptor.beforeSync?.();
    const folder = root();
    // A folder that is not there (removable drive, unmapped share) says nothing about the notes: skip this store
    // instead of reading "every note deleted".
    const stat = await statNoLink(folder).catch(() => null);
    if (!stat?.isDirectory()) {
      const error = new Error('The note folder is not available');
      error.code = 'FOLDER_UNAVAILABLE';
      throw error;
    }
    const files = await walkFiles(folder, descriptor.include);
    const notes = files.filter((rel) => /\.(?:md|txt)$/i.test(rel));
    const result = {};
    staged.clear();
    for (const rel of notes) {
      const file = await safePath(folder, rel);
      const bytes = await readLimited(file, limit);
      const digest = hash(bytes);
      const key = recordKey(await descriptor.idOf(rel, bytes.toString('utf8')) || rel);
      if (Object.hasOwn(result, key)) throw new Error('Duplicate note identity');
      staged.set(digest, file);
      const assets = {};
      const prefix = noteAssetPrefix(rel).toLowerCase();
      for (const asset of files) {
        if (!asset.toLowerCase().startsWith(prefix)) continue;
        const assetFile = await safePath(folder, asset);
        const assetBytes = await readLimited(assetFile, limit);
        const assetHash = hash(assetBytes);
        assets[asset] = assetHash;
        staged.set(assetHash, assetFile);
      }
      result[key] = { path: rel, blob: digest, assets };
    }
    return result;
  }

  async function prepare(outgoing, cloudRoot) {
    if (cloudManaged()) throw new Error('Note folder is already cloud managed');
    for (const item of Object.values(outgoing || {})) {
      if (!item || item.deleted) continue;
      const value = validValue(item.value);
      for (const digest of [value.blob, ...Object.values(value.assets)]) {
        const stagedFile = staged.get(digest);
        if (stagedFile) await saveBlob(cloudRoot, digest, stagedFile, limit);
        else await readBlob(cloudRoot, digest, limit);
      }
    }
  }

  async function available(change, { cloudRoot } = {}) {
    if (change?.record?.deleted) return true;
    if (!cloudRoot) throw new Error('Cloud root is required');
    const value = validValue(change?.record?.value);
    for (const digest of [value.blob, ...Object.values(value.assets)]) {
      try {
        await readBlob(cloudRoot, digest, limit);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'BLOB_MISMATCH') return false;
        throw error;
      }
    }
    return true;
  }

  async function apply(changes, { cloudRoot } = {}) {
    if (!cloudRoot || cloudManaged()) throw new Error('Note folder cannot be synced here');
    const folder = root();
    await descriptor.beforeSync?.();
    // Planning already decided this store may receive notes (a new, never-synced folder is created here).
    await fsp.mkdir(folder, { recursive: true });
    const current = await read();
    const paths = new Map(Object.entries(current).map(([key, value]) => [value.path.toLowerCase(), key]));
    const changed = [];
    suppressUntil = Date.now() + 2000;
    // Deletions and renames of known notes first, so a name they free can be taken by a new note in this batch.
    const order = (change) => (change?.deleted ? 0 : current[change?.key] ? 1 : 2);
    for (const change of [...changes].sort((x, y) => order(x) - order(y))) {
      if (!change || typeof change.key !== 'string' || !change.key.startsWith(`${widgetId}/${descriptor.name}/`)) throw new Error('Invalid note change');
      const previous = current[change.key];
      if (change.deleted) {
        if (previous) {
          await archive(folder, previous.path);
          for (const asset of Object.keys(previous.assets)) await archive(folder, asset);
          changed.push(previous.path);
        }
        continue;
      }
      const value = validValue(change.value);
      if (!descriptor.include(value.path) || Object.keys(value.assets).some((asset) => !descriptor.include(asset))) throw new Error('Note path is not included');
      const owner = paths.get(value.path.toLowerCase());
      // A different note already has that file name (both PCs made "새 노트.md"). Every PC decides the same way:
      // the note with the smaller key keeps the name, the other moves to "name (n).md"; the move then travels
      // as an ordinary rename, so the PCs settle instead of renaming back and forth.
      if (owner && owner !== change.key && owner > change.key) {
        const moved = { ...current[owner], ...(await freeName(folder, current[owner])) };
        await fsp.rename(await safePath(folder, current[owner].path), await safePath(folder, moved.path, { createParent: true }));
        const oldFolder = noteAssetPrefix(current[owner].path).slice(0, -1);
        if (Object.keys(current[owner].assets).length && await statNoLink(await safePath(folder, oldFolder))) {
          await fsp.rename(await safePath(folder, oldFolder), await safePath(folder, noteAssetPrefix(moved.path).slice(0, -1)));
        }
        // The blobs this sync exports for the moved note are now read from its new place.
        const from = await safePath(folder, current[owner].path);
        const to = await safePath(folder, moved.path);
        for (const [digest, file] of staged) {
          if (file === from) staged.set(digest, to);
          else if (file.toLowerCase().startsWith(`${path.join(folder, oldFolder)}${path.sep}`.toLowerCase())) {
            staged.set(digest, path.join(folder, noteAssetPrefix(moved.path).slice(0, -1), path.relative(path.join(folder, oldFolder), file)));
          }
        }
        paths.delete(current[owner].path.toLowerCase());
        paths.set(moved.path.toLowerCase(), owner);
        current[owner] = moved;
        changed.push(moved.path);
      } else if ((owner && owner !== change.key) || (!owner && !previous && await statNoLink(await safePath(folder, value.path)))) {
        Object.assign(value, await freeName(folder, value));
      }
      if (previous) paths.delete(previous.path.toLowerCase());
      paths.set(value.path.toLowerCase(), change.key);
      const noteBytes = await readBlob(cloudRoot, value.blob, limit);
      const assetBytes = await Promise.all(Object.entries(value.assets).map(async ([rel, digest]) => [rel, await readBlob(cloudRoot, digest, limit)]));
      const target = await safePath(folder, value.path, { createParent: true });
      if ((!previous || previous.path !== value.path) && await statNoLink(target)) throw new Error('Target note already exists');
      for (const [rel] of assetBytes) {
        const assetTarget = await safePath(folder, rel, { createParent: true });
        if (!previous?.assets[rel] && await statNoLink(assetTarget)) throw new Error('Target attachment already exists');
      }
      if (previous) await archive(folder, previous.path);
      await atomicBytes(target, noteBytes);
      for (const [rel, bytes] of assetBytes) {
        const assetTarget = await safePath(folder, rel, { createParent: true });
        if (previous?.assets[rel]) await archive(folder, rel);
        await atomicBytes(assetTarget, bytes);
      }
      for (const oldAsset of Object.keys(previous?.assets || {})) {
        if (!Object.hasOwn(value.assets, oldAsset)) await archive(folder, oldAsset);
      }
      changed.push(value.path);
    }
    suppressUntil = Date.now() + 1000;
    if (changed.length) {
      await descriptor.onRemoteChange?.(changed);
      notify(changed, true);
    }
    await pruneBackups(folder, backupRetentionDays);
  }

  /** The first "name (n).md" whose file and .assets folder are both unused, with the attachments moved along. */
  async function freeName(folder, value) {
    const extension = path.extname(value.path);
    const stem = value.path.slice(0, -extension.length);
    for (let n = 2; n < 10000; n++) {
      const candidate = `${stem} (${n})${extension}`;
      const assetFolder = noteAssetPrefix(candidate).slice(0, -1);
      if (await statNoLink(await safePath(folder, candidate)) || await statNoLink(await safePath(folder, assetFolder))) continue;
      const oldPrefix = noteAssetPrefix(value.path);
      const newPrefix = noteAssetPrefix(candidate);
      const assets = Object.fromEntries(Object.entries(value.assets).map(([rel, digest]) => [`${newPrefix}${rel.slice(oldPrefix.length)}`, digest]));
      if (!descriptor.include(candidate) || Object.keys(assets).some((rel) => !descriptor.include(rel))) break;
      return { path: candidate, assets };
    }
    throw new Error('No free name for an incoming note');
  }

  async function copy(key, incoming, { cloudRoot } = {}) {
    if (!cloudRoot || cloudManaged()) throw new Error('Note folder cannot be synced here');
    const value = validValue(incoming);
    const folder = root();
    const extension = path.extname(value.path);
    const stem = value.path.slice(0, -extension.length);
    let newPath;
    for (let n = 2; n < 10000; n++) {
      const candidate = `${stem} (${n})${extension}`;
      const assetFolder = noteAssetPrefix(candidate).slice(0, -1);
      if (!(await statNoLink(await safePath(folder, candidate))) && !(await statNoLink(await safePath(folder, assetFolder)))) {
        newPath = candidate;
        break;
      }
    }
    if (!newPath) throw new Error('No available copy name');
    let bytes = await readBlob(cloudRoot, value.blob, limit);
    const newId = crypto.randomBytes(12).toString('hex');
    if (/\.md$/i.test(newPath)) {
      const source = bytes.toString('utf8');
      const head = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(source);
      const rewritten = head
        ? source.replace(head[0], `${head[1]}${/^desk-widgets-memo:\s*[^\r\n]+/im.test(head[2])
          ? head[2].replace(/^desk-widgets-memo:\s*[^\r\n]+/im, `desk-widgets-memo: ${newId}`)
          : `desk-widgets-memo: ${newId}${head[1]}${head[2]}`}${head[3]}`)
        : `---\ndesk-widgets-memo: ${newId}\n---\n${source}`;
      bytes = Buffer.from(rewritten, 'utf8');
    }
    const assets = {};
    const oldPrefix = noteAssetPrefix(value.path);
    const newPrefix = noteAssetPrefix(newPath);
    for (const [rel, digest] of Object.entries(value.assets)) assets[`${newPrefix}${rel.slice(oldPrefix.length)}`] = digest;
    if (!descriptor.include(newPath) || Object.keys(assets).some((rel) => !descriptor.include(rel))) throw new Error('Copied note path is not included');
    const copied = { path: newPath, blob: hash(bytes), assets };
    suppressUntil = Date.now() + 2000;
    staged.set(copied.blob, await safePath(folder, newPath, { createParent: true }));
    await atomicBytes(staged.get(copied.blob), bytes);
    for (const [rel, digest] of Object.entries(assets)) {
      const target = await safePath(folder, rel, { createParent: true });
      await atomicBytes(target, await readBlob(cloudRoot, digest, limit));
      staged.set(digest, target);
    }
    await descriptor.onRemoteChange?.([newPath]);
    notify([newPath], true);
    await pruneBackups(folder, backupRetentionDays);
    const id = await descriptor.idOf(newPath, bytes.toString('utf8')) || newPath;
    return { key: recordKey(id), value: copied };
  }

  // 1.1.3-test notes that lived in the sync folder come back into this folder before the widget scans it.
  migrate?.({ name, widgetId, source: descriptor.name, dir: root(), include: descriptor.include, limit });

  // Which folder this store reads; the sync core matches the store again when it changes.
  const location = () => root().toLowerCase();
  const unregister = manager ? manager.register({ name, widgetId, read, apply, prepare, available, copy, location }) : () => {};

  // What the widget sees: its folder on this PC and plain file operations inside it.
  const handle = {
    dir: () => root(),
    list: () => walkFiles(root(), descriptor.include),
    async read(rel, encoding = null) {
      const bytes = await readLimited(await safePath(root(), rel), limit);
      return encoding ? bytes.toString(encoding) : bytes;
    },
    async write(rel, data) {
      if (!descriptor.include(relativeName(rel))) throw new Error('File is outside this store');
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      if (bytes.length > limit) throw new Error('File is too large for this store');
      await atomicBytes(await safePath(root(), rel, { createParent: true }), bytes);
      onLocalChange();
    },
    async remove(rel) {
      const file = await safePath(root(), rel);
      if (await statNoLink(file)) await fsp.unlink(file);
      onLocalChange();
    },
    /** Call after writing in the folder by other means (the widget's own atomic saves). */
    changed: () => onLocalChange(),
    /** Local edits (engine watcher) and notes received from other PCs: listener({ paths, remote }). */
    onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      startWatch();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stopWatch();
      };
    },
    /** Whether the folder overlaps the sync folder, so the engine does not exchange it. */
    cloudManaged: () => cloudManaged(),
  };
  const close = () => {
    listeners.clear();
    stopWatch();
    unregister();
  };
  return { handle, close };
}

module.exports = { openFileStore, relativeName, validValue, blobPath, inside, walkFiles, safePath, readLimited, atomicNewBytes, hash, BACKUP_DIR };
