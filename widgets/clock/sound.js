// Alarm / timer sound of the clock (#130): the user's sound files and the player.
//
// - Files the user adds are copied into <dataDir>\sounds\<id><ext>, so moving or deleting the original does not
//   silence an alarm. The list ({ id, name, file }) lives in the settings file and is not synced (the files are on
//   this PC only). A sound whose file is gone plays the clock's own chime (sounds/chime.wav).
// - Playing happens in one hidden window made only while a sound plays and destroyed when it stops (the memory
//   policy, docs/memory-review.md: no window is left waiting). Main code cannot play audio itself, and the theme
//   window is the user's replaceable page, so neither is used. One sound at a time: a newer ring replaces the older.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const AM = require('./kit/alarm-model');
const { MAX_SECONDS, DEFAULT_MAX_SECONDS, DEFAULT_VOLUME } = require('./player/plan');

const MAX_SOUNDS = 10;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_NAME = 40;
// What Chromium plays (by extension; a file it cannot decode falls back to the chime when it rings).
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac', '.webm'];
const FILE_NAME = new RegExp(`^[a-z0-9]{1,24}(${AUDIO_EXTENSIONS.map((e) => e.replace('.', '\\.')).join('|')})$`);
const PREVIEW_SECONDS = 20;
const PREVIEW_KEY = 'preview';

// ---- settings values ----
function sanitizeSounds(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, file } = raw;
    if (typeof id !== 'string' || !AM.SOUND_ID.test(id) || id === AM.DEFAULT_SOUND || id === AM.NO_SOUND || seen.has(id)) continue;
    if (typeof file !== 'string' || !FILE_NAME.test(file)) continue;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME) : '알림음';
    seen.add(id);
    out.push({ id, name, file });
    if (out.length >= MAX_SOUNDS) break;
  }
  return out;
}

const sanitizeVolume = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : DEFAULT_VOLUME);
const sanitizeMaxSeconds = (v) => (MAX_SECONDS.includes(v) ? v : DEFAULT_MAX_SECONDS);

/** What the themes and the settings window may see: names only, never paths. */
const choices = (sounds) => [
  { id: AM.DEFAULT_SOUND, name: '기본음' },
  ...sounds.map((s) => ({ id: s.id, name: s.name })),
  { id: AM.NO_SOUND, name: '소리 없음' },
];

// ---- files ----
/**
 * Copies a picked file into the sounds folder. Returns { ok, sound } or { ok: false, message }.
 * `sounds` is the current list; the caller saves [...sounds, sound].
 */
function addSoundFile(dir, sounds, source, { makeId = randomId } = {}) {
  if (sounds.length >= MAX_SOUNDS) return { ok: false, message: `알림음은 ${MAX_SOUNDS}개까지 추가할 수 있습니다.` };
  const ext = path.extname(String(source || '')).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) return { ok: false, message: `소리 파일(${AUDIO_EXTENSIONS.join(', ')})만 쓸 수 있습니다.` };
  let size;
  try {
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    return { ok: false, message: '파일을 읽을 수 없습니다.' };
  }
  if (size > MAX_FILE_BYTES) return { ok: false, message: '30MB보다 큰 파일은 쓸 수 없습니다.' };
  const id = makeId();
  const file = `${id}${ext}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, path.join(dir, file));
  } catch {
    try {
      fs.rmSync(path.join(dir, file), { force: true });
    } catch {
      // nothing more to clean up
    }
    return { ok: false, message: '파일을 복사하지 못했습니다.' };
  }
  const name = path.basename(source, path.extname(source)).trim().slice(0, MAX_NAME) || '알림음';
  return { ok: true, sound: { id, name, file } };
}

function removeSoundFile(dir, sound) {
  try {
    fs.rmSync(path.join(dir, sound.file), { force: true });
  } catch {
    // A file that cannot be deleted now (open elsewhere) only takes space; the list entry goes anyway.
  }
}

function randomId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The file to play for a sound id: { file, fallback } (fallback = the chime when the user's file cannot be played),
 * or null for "소리 없음". An unknown id or a missing file plays the chime.
 */
function resolveSound(id, { sounds, dir, defaultFile, exists = fs.existsSync }) {
  if (id === AM.NO_SOUND) return null;
  const own = id !== AM.DEFAULT_SOUND ? sounds.find((s) => s.id === id) : null;
  if (own) {
    const file = path.join(dir, own.file);
    if (exists(file)) return { file, fallback: defaultFile, missing: false };
    return { file: defaultFile, fallback: null, missing: true };
  }
  return { file: defaultFile, fallback: null, missing: false };
}

// ---- player ----
/**
 * One sound at a time. open({ file, fallback, repeat, volume, until }) makes the window and returns
 * { close(), onClosed(fn) }; the page closes itself when it is done. onChange(key or null) on every change.
 */
function createPlayer({ open, onChange = () => {}, now = Date.now }) {
  let current = null; // { key, handle, timer }

  function end(entry) {
    if (current !== entry) return false;
    current = null;
    clearTimeout(entry.timer);
    try {
      entry.handle.close();
    } catch {
      // already gone
    }
    onChange(null);
    return true;
  }

  return {
    /** Starts a sound for `key` (e.g. "alarm-<id>", "timer"), replacing what plays. False when it could not start. */
    play({ key, file, fallback = null, repeat = 1, volume = DEFAULT_VOLUME, maxSeconds = DEFAULT_MAX_SECONDS }) {
      if (current) end(current);
      const until = now() + maxSeconds * 1000;
      let handle;
      try {
        handle = open({ file, fallback, repeat, volume: sanitizeVolume(volume) / 100, until });
      } catch {
        return false;
      }
      const entry = { key, handle, timer: null };
      current = entry;
      handle.onClosed(() => end(entry));
      // The page stops itself at `until`; this is the backstop if it hangs.
      entry.timer = setTimeout(() => end(entry), maxSeconds * 1000 + 2000);
      entry.timer.unref?.();
      onChange(key);
      return true;
    },
    /** Stops the sound of `key`, or any sound when no key is given. True when something stopped. */
    stop(key) {
      if (!current || (key !== undefined && current.key !== key)) return false;
      return end(current);
    },
    playing: () => current?.key ?? null,
  };
}

/** The real window: hidden, no preload, sandboxed, audible without a click. */
function openSoundWindow({ file, fallback, repeat, volume, until }) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenu?.(null);
  // The page may only load its own files; nothing opens from it.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const query = { src: pathToFileURL(file).href, repeat: String(repeat), volume: String(volume), until: String(until) };
  if (fallback) query.fallback = pathToFileURL(fallback).href;
  win.loadFile(path.join(__dirname, 'player', 'player.html'), { query });
  return {
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
    onClosed: (fn) => win.on('closed', fn),
  };
}

module.exports = {
  MAX_SOUNDS,
  MAX_FILE_BYTES,
  AUDIO_EXTENSIONS,
  PREVIEW_SECONDS,
  PREVIEW_KEY,
  sanitizeSounds,
  sanitizeVolume,
  sanitizeMaxSeconds,
  choices,
  addSoundFile,
  removeSoundFile,
  resolveSound,
  createPlayer,
  openSoundWindow,
};
