// Validates theme.json. No Electron dependency (unit-testable).
// Without options it checks the Dooray theme contract v1 exactly as published (THEME_SPEC.md); a widget with its
// own theme contract (#57) passes { widgetId, contractVersions, frames }.
const { parseBackground } = require('./theme-background');

const SUPPORTED_CONTRACT = 1;
// The widget a theme.json without "widget" belongs to: every theme written before #57 is a Dooray theme.
const LEGACY_WIDGET = 'dooray';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MATERIALS = new Set(['acrylic', 'mica', 'none']);

const DEFAULT_WINDOW = {
  transparent: true,
  material: 'none',
  overview: { width: 380, height: 560, minWidth: 280, minHeight: 240 },
  project: { width: 360, height: 520, minWidth: 280, minHeight: 240 },
};

function sizeOf(input, fallback) {
  const out = { ...fallback };
  for (const key of Object.keys(fallback)) {
    const n = Number(input?.[key]);
    // 32px lets a bar-shaped theme be just one line tall.
    if (Number.isFinite(n) && n >= 32 && n <= 4000) out[key] = Math.round(n);
  }
  return out;
}

const SIZE_KEYS = ['width', 'height', 'minWidth', 'minHeight'];
const DEFAULT_FRAME = { width: 300, height: 300, minWidth: 120, minHeight: 64 };

/**
 * Window sizes of a widget's own frames (#57): window.<frame> and window["<frame>+<variant>"]. A variant the theme
 * does not size uses the widget's default for it, else the theme's size of the frame.
 */
function frameSizes(w, frames) {
  const out = {};
  for (const [frame, def] of Object.entries(frames)) {
    const fallback = Object.fromEntries(SIZE_KEYS.map((k) => [k, Number.isFinite(def?.[k]) ? def[k] : DEFAULT_FRAME[k]]));
    out[frame] = sizeOf(w[frame], fallback);
    for (const [variant, vdef] of Object.entries(def?.variants || {})) {
      const key = `${frame}+${variant}`;
      const vfallback = Object.fromEntries(SIZE_KEYS.map((k) => [k, Number.isFinite(vdef?.[k]) ? vdef[k] : out[frame][k]]));
      out[key] = sizeOf(w[key], vfallback);
    }
  }
  return out;
}

/**
 * @param {object} raw  parsed theme.json
 * @param {string} [folderName]  the theme's folder name (the id must match it)
 * @param {{ widgetId?: string, contractVersions?: number[], frames?: object }} [opts]  the widget's theme contract;
 *   omitted = Dooray (contract v1, overview/project windows)
 * @returns {{ manifest: object|null, errors: string[], compatible: boolean }}
 */
function validateManifest(raw, folderName, opts = {}) {
  const widgetId = opts.widgetId || LEGACY_WIDGET;
  const legacy = widgetId === LEGACY_WIDGET && !opts.frames;
  const versions = Array.isArray(opts.contractVersions) && opts.contractVersions.length ? opts.contractVersions : [SUPPORTED_CONTRACT];
  const errors = [];
  if (!raw || typeof raw !== 'object') return { manifest: null, errors: ['theme.json is not an object'], compatible: false };

  if (!ID_PATTERN.test(raw.id || '')) errors.push('id must be lowercase letters, digits or "-"');
  else if (folderName && raw.id !== folderName) errors.push(`id "${raw.id}" must match folder name "${folderName}"`);
  if (!raw.name || typeof raw.name !== 'string') errors.push('name is required');
  if (!raw.version || typeof raw.version !== 'string') errors.push('version is required');

  const entry = raw.entry || 'index.html';
  if (typeof entry !== 'string' || entry.includes('..') || /^[\\/]/.test(entry) || !/\.html?$/i.test(entry)) {
    errors.push('entry must be a relative .html path inside the theme folder');
  }

  // #57: which widget the theme is for. A theme in another widget's folder is listed but not usable.
  const owner = raw.widget === undefined ? LEGACY_WIDGET : raw.widget;
  if (!ID_PATTERN.test(owner || '')) errors.push('widget must be a widget id');
  else if (owner !== widgetId) errors.push(`theme for another widget ("${owner}")`);

  const compatible = owner === widgetId && versions.includes(raw.contractVersion);
  if (!versions.includes(raw.contractVersion)) errors.push(`contractVersion ${raw.contractVersion} is not supported (expected ${versions.join(' or ')})`);

  // v1.6: borrow every file this theme does not have from another theme (e.g. a color skin of "glass").
  let base = null;
  if (raw.extends !== undefined) {
    if (!ID_PATTERN.test(raw.extends || '')) errors.push('extends must be a theme id');
    else if (raw.extends === raw.id) errors.push('extends must name another theme');
    else base = raw.extends;
  }

  const w = raw.window || {};
  const manifest = {
    id: raw.id,
    name: String(raw.name || raw.id || ''),
    version: String(raw.version || ''),
    author: String(raw.author || ''),
    description: String(raw.description || ''),
    contractVersion: raw.contractVersion,
    entry,
    extends: base,
    // v1.8: a theme that declares its background opacity gets the user's per-theme slider (#55).
    // An invalid value is ignored like an unknown material: the theme stays usable, just without the slider.
    background: parseBackground(raw.background),
    window: {
      transparent: w.transparent !== undefined ? Boolean(w.transparent) : DEFAULT_WINDOW.transparent,
      material: MATERIALS.has(w.material) ? w.material : DEFAULT_WINDOW.material,
      ...(legacy
        ? { overview: sizeOf(w.overview, DEFAULT_WINDOW.overview), project: sizeOf(w.project, DEFAULT_WINDOW.project) }
        : frameSizes(w, opts.frames || { main: DEFAULT_FRAME })),
    },
  };
  // Added only for widgets with their own contract, so a Dooray theme's manifest stays exactly as before.
  if (!legacy) {
    manifest.widget = owner;
    // Optional parts of the widget's contract the theme draws (e.g. the clock's "tools" tabs). Unknown names are kept.
    manifest.features = Array.isArray(raw.features) ? [...new Set(raw.features.filter((f) => typeof f === 'string' && ID_PATTERN.test(f)))].slice(0, 32) : [];
  }
  return { manifest, errors, compatible };
}

module.exports = { SUPPORTED_CONTRACT, LEGACY_WIDGET, validateManifest };
