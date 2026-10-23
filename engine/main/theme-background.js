// Per-theme background opacity (theme contract v1.8, #55). No Electron dependency (unit-testable).
// A theme opts in with theme.json "background": { "opacity": 0..1 } (its default). The user's choice
// is stored by the themed widget as { [themeId]: 0..100 } and reaches the theme page as the CSS
// custom property --theme-bg-alpha (0..1) on the document root, plus the onBackground event.

const CSS_VAR = '--theme-bg-alpha';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ENTRIES = 500;

/** Reads theme.json "background"; anything other than { opacity: 0..1 } means the theme does not support it. */
function parseBackground(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const n = raw.opacity;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
  return { opacity: Math.round(n * 100) / 100 };
}

/** Clamps one stored value to an integer percent; null when it is not a number. */
function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** { themeId: 0..100 } with valid ids and numbers only; everything else is dropped (the theme default applies). */
function sanitizeOpacityMap(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [id, n] of Object.entries(src).slice(0, MAX_ENTRIES)) {
    const pct = clampPercent(n);
    if (ID_PATTERN.test(id) && pct !== null) out[id] = pct;
  }
  return out;
}

/**
 * The background opacity (0..1) a theme is drawn with, or null when the theme does not declare
 * "background" (then nothing is injected and the theme looks exactly as before).
 * Order: the value being dragged in the settings window, the user's saved value, the theme default.
 * @param {{ id: string, background?: { opacity: number } | null }} theme
 * @param {object} saved   stored { themeId: 0..100 } (sanitized here)
 * @param {{ themeId: string, value: number } | null} live
 */
function effectiveOpacity(theme, saved, live = null) {
  if (!theme?.background) return null;
  if (live && live.themeId === theme.id && clampPercent(live.value) !== null) return clampPercent(live.value) / 100;
  const pct = sanitizeOpacityMap(saved)[theme.id];
  return pct === undefined ? theme.background.opacity : pct / 100;
}

/** The stylesheet the engine inserts into a theme page. `html:root` outranks a theme's own `:root`. */
function cssFor(alpha) {
  return `html:root { ${CSS_VAR}: ${Number(alpha).toFixed(2).replace(/\.?0+$/, '') || '0'}; }`;
}

module.exports = { CSS_VAR, parseBackground, sanitizeOpacityMap, effectiveOpacity, cssFor, clampPercent };
