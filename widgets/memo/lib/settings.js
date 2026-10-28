// Settings of the memo widget (#75): the widget's settings.json in its data folder. It holds only what the screen
// needs (window places, colors, which memos are open); the memos themselves live in the notes folder (Documents).
const path = require('path');
const { isInside } = require('./files');

const COLORS = ['midnight', 'yellow', 'pink', 'blue', 'green', 'purple', 'gray', 'dark'];
const COLOR_NAMES = { midnight: '미드나잇 글래스', yellow: '노랑', pink: '분홍', blue: '파랑', green: '초록', purple: '보라', gray: '회색', dark: '어두운 색' };

const DEFAULTS = {
  notesDir: '', // empty: Documents\Desk Widgets\스티키 노트
  opacity: 94, // background only (#53-#55): 0..100
  defaultColor: 'yellow',
  colorDefaultRestored: true,
  fontSize: 13,
  listOpen: true,
  listBounds: null,
  listAlwaysOnTop: false,
  listView: 'memos', // or 'archive'
  memos: {}, // id -> { color, bounds, open, alwaysOnTop, collapsed, expandedHeight, listPinned, autoTitle }
  pathIds: {}, // lower-case path -> id, for files without our front matter
  titleFormat: {}, // lower-case note folder -> format of its notes (#113 title tidy-up done); this PC only
  folderMigrated: false, // #95: the old default folder (메모) was looked at once
  notice: '', // a one-time message for the list window
};

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
const validBounds = (b) => (b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null);

function sanitizeMemo(m) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  if (COLORS.includes(m.color)) out.color = m.color;
  const b = validBounds(m.bounds);
  if (b) out.bounds = b;
  for (const k of ['open', 'alwaysOnTop', 'collapsed', 'listPinned', 'autoTitle']) if (m[k] !== undefined) out[k] = Boolean(m[k]);
  if (Number.isFinite(m.expandedHeight)) out.expandedHeight = clamp(m.expandedHeight, 60, 4000, 240);
  return out;
}

function sanitize(s) {
  const memos = {};
  for (const [id, m] of Object.entries(s.memos || {})) if (/^[\w-]{4,80}$/.test(id)) memos[id] = sanitizeMemo(m);
  const pathIds = {};
  for (const [p, id] of Object.entries(s.pathIds || {})) if (typeof p === 'string' && /^[\w-]{4,80}$/.test(String(id))) pathIds[p] = String(id);
  return {
    ...s,
    notesDir: typeof s.notesDir === 'string' ? s.notesDir.trim() : '',
    opacity: clamp(s.opacity, 0, 100, DEFAULTS.opacity),
    defaultColor: COLORS.includes(s.defaultColor) ? s.defaultColor : DEFAULTS.defaultColor,
    colorDefaultRestored: Boolean(s.colorDefaultRestored),
    fontSize: clamp(s.fontSize, 10, 24, DEFAULTS.fontSize),
    listOpen: s.listOpen !== false,
    listBounds: validBounds(s.listBounds),
    listAlwaysOnTop: Boolean(s.listAlwaysOnTop),
    listView: s.listView === 'archive' ? 'archive' : 'memos',
    memos,
    pathIds,
    titleFormat: Object.fromEntries(Object.entries(s.titleFormat && typeof s.titleFormat === 'object' ? s.titleFormat : {}).filter(([p, v]) => typeof p === 'string' && Number.isSafeInteger(v) && v > 0)),
    folderMigrated: Boolean(s.folderMigrated),
    notice: typeof s.notice === 'string' ? s.notice.slice(0, 1000) : '',
  };
}

// Restore test.3's automatic midnight default once; leave every note's stored color unchanged.
function upgrade(s) {
  if (s.colorDefaultRestored) return s;
  return {
    ...s,
    defaultColor: s.colorDefaultMigrated && s.defaultColor === 'midnight' ? DEFAULTS.defaultColor : s.defaultColor,
    colorDefaultRestored: true,
  };
}

/** The default notes folder: Documents\Desk Widgets\스티키 노트. */
const defaultNotesDir = (documents) => path.join(documents, 'Desk Widgets', '스티키 노트');

/**
 * Folders the uninstallers delete (or may delete), so notes must never live there:
 * the widget's install folder and the engine's install root, the widget's data folder and the engine's data root
 * (%APPDATA%\chilgong88\desk-widgets, deleted when the user removes the app with its settings).
 */
function protectedDirs({ widgetDir, dataDir }) {
  const dirs = [];
  if (widgetDir) dirs.push(path.resolve(widgetDir), path.resolve(widgetDir, '..', '..'));
  if (dataDir) dirs.push(path.resolve(dataDir), path.resolve(dataDir, '..', '..'));
  return dirs;
}

/** null when the folder may hold notes, else a message for the settings window. */
function checkNotesDir(dir, where) {
  if (!dir) return null;
  if (!path.isAbsolute(dir) || /^\\\\[?.]\\/.test(dir)) return '노트 폴더는 전체 경로로 적어 주세요 (예: C:\\Users\\이름\\Documents\\스티키 노트).';
  for (const p of protectedDirs(where)) {
    if (isInside(p, dir, { orSame: true })) {
      return '노트 폴더를 프로그램·설정 폴더 안에 둘 수 없습니다. 제거할 때 지워질 수 있습니다. 문서 폴더 같은 곳을 골라 주세요.';
    }
  }
  return null;
}

module.exports = { DEFAULTS, COLORS, COLOR_NAMES, sanitize, sanitizeMemo, upgrade, defaultNotesDir, protectedDirs, checkNotesDir };
