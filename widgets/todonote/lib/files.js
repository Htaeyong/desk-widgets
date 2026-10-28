// File helpers of the memo widget (#75): memo file names, atomic writes and paths that must stay inside a folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TITLE = 80;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const DEFAULT_TITLE = '새 노트';

/** A title usable as a Windows file name: no \ / : * ? " < > | or control characters, no trailing dot or space. */
function sanitizeTitle(raw, fallback = DEFAULT_TITLE) {
  let s = String(raw ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = [...s].slice(0, MAX_TITLE).join('');
  s = s.replace(/[. ]+$/, '').trim();
  if (!s || /^\.+$/.test(s)) return fallback;
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** Title of a new memo from its first line of text (plain text, at most 40 characters). */
function titleFromText(plain) {
  const line = String(plain || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return DEFAULT_TITLE;
  return sanitizeTitle([...line].slice(0, 40).join(''));
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * A free "<name>.<ext>" in dir: "name.md", then "name (2).md", ... A name is taken when the file or its
 * "<name>.assets" folder exists. `keep` (an existing file of the same memo) counts as free. Notes are named by id
 * (#113), so this is the fallback for a clash that should not happen, and for .txt notes and copies.
 */
function uniqueFileName(dir, title, ext, { keep = null, exists = fs.existsSync } = {}) {
  const base = sanitizeTitle(title);
  for (let n = 1; n < 10000; n++) {
    const t = n === 1 ? base : `${base} (${n})`;
    const file = path.join(dir, `${t}.${ext}`);
    if (keep && sameName(file, keep)) return { title: t, file };
    if (!exists(file) && !exists(path.join(dir, `${t}.assets`))) return { title: t, file };
  }
  throw new Error('같은 이름의 노트가 너무 많습니다.');
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The file name (without extension) of a note made by the widget (#113): "YYYYMMDD-HHmmss-<id>", the local time it
 * was made. It never changes after that (titles live in front matter). Without a time (a note from before #113 whose
 * time no two PCs agree on): "<id>".
 */
function idFileStem(id, created = null) {
  const safe = sanitizeTitle(id, 'note');
  if (created == null || !Number.isFinite(Number(created))) return safe;
  const d = new Date(Number(created));
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}-${safe}`;
}

/** Is a file name (without extension) already an id name of this note ("<id>" or "YYYYMMDD-HHmmss-<id>")? */
function isIdFileStem(stem, id) {
  const safe = sanitizeTitle(id, 'note');
  return sameName(stem, safe) || (stem.length === safe.length + 16 && /^\d{8}-\d{6}-/.test(stem) && sameName(stem.slice(16), safe));
}

/** A free file name inside a folder for an asset ("image.png", "image (2).png", ...). */
function uniqueAssetName(dir, wanted, { exists = fs.existsSync } = {}) {
  // The last path segment only (a pasted name may hold "\", "/" or a drive-like "x:").
  const base = String(wanted).split(/[\\/]/).pop();
  const ext = (base.match(/\.[^.\s]{1,16}$/) || [''])[0];
  const stem = sanitizeTitle(base.slice(0, base.length - ext.length), 'file');
  const cleanExt = ext.replace(/[^\w.-]/g, '');
  for (let n = 1; n < 10000; n++) {
    const name = `${n === 1 ? stem : `${stem} (${n})`}${cleanExt}`;
    if (!exists(path.join(dir, name))) return name;
  }
  throw new Error('같은 이름의 파일이 너무 많습니다.');
}

/** Is `child` the folder itself or inside it (after resolving ".." and case)? */
function isInside(dir, child, { orSame = false } = {}) {
  const rel = path.relative(path.resolve(dir), path.resolve(child));
  if (rel === '') return orSame;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const tmpName = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);

/**
 * Writes a file so that it is either the old or the new content, never half: a temporary file in the same
 * folder, flushed to disk, then renamed over the target. Retries the rename while another program (antivirus,
 * OneDrive, an editor) holds the file for a moment.
 */
async function writeFileAtomic(file, data, { retries = 6, fsp = fs.promises } = {}) {
  const tmp = tmpName(file);
  const fh = await fsp.open(tmp, 'wx');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (let n = 0; ; n++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (n >= retries || !RETRY_CODES.has(err.code)) {
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 40 * 2 ** n));
    }
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** writeFileAtomic for shutdown, when nothing asynchronous runs any more. */
function writeFileAtomicSync(file, data, { retries = 4 } = {}) {
  const tmp = tmpName(file);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let n = 0; ; n++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (n >= retries || !RETRY_CODES.has(err.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        throw err;
      }
      sleepSync(30 * 2 ** n);
    }
  }
}

/** fs.renameSync with the same short retries (a folder that is being scanned can refuse a moment). */
async function renameRetry(from, to, { retries = 5 } = {}) {
  for (let n = 0; ; n++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (n >= retries || !RETRY_CODES.has(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 40 * 2 ** n));
    }
  }
}

const hashText = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const newId = () => crypto.randomBytes(6).toString('hex');

module.exports = { sanitizeTitle, titleFromText, uniqueFileName, idFileStem, isIdFileStem, uniqueAssetName, isInside, writeFileAtomic, writeFileAtomicSync, renameRetry, hashText, newId, DEFAULT_TITLE };
