// Local display preferences; sampling is always performed by the engine.
const DEFAULTS = {
  intervalMs: 2000,
  historyMs: 60000,
  showCores: false,
  alwaysOnTop: false,
  themeId: 'graph',
  themeOpacity: {},
  themeBounds: {},
  themeFrames: {},
};

function sanitize(raw = {}) {
  const value = { ...DEFAULTS, ...raw };
  value.intervalMs = Number.isFinite(Number(value.intervalMs)) ? Math.max(1000, Math.min(10000, Math.round(Number(value.intervalMs) / 1000) * 1000)) : DEFAULTS.intervalMs;
  value.historyMs = Number.isFinite(Number(value.historyMs)) ? Math.max(10000, Math.min(300000, Math.round(Number(value.historyMs) / 1000) * 1000)) : DEFAULTS.historyMs;
  value.showCores = Boolean(value.showCores);
  value.alwaysOnTop = Boolean(value.alwaysOnTop);
  value.themeId = typeof value.themeId === 'string' ? value.themeId : DEFAULTS.themeId;
  value.themeOpacity = value.themeOpacity && typeof value.themeOpacity === 'object' && !Array.isArray(value.themeOpacity) ? value.themeOpacity : {};
  value.themeBounds = value.themeBounds && typeof value.themeBounds === 'object' && !Array.isArray(value.themeBounds) ? value.themeBounds : {};
  value.themeFrames = value.themeFrames && typeof value.themeFrames === 'object' && !Array.isArray(value.themeFrames) ? value.themeFrames : {};
  return value;
}

module.exports = { DEFAULTS, sanitize };
