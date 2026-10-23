// The themes of one themed widget (#57): its built-in and user theme folders, "extends", the shared kit
// folder and the theme URLs. No Electron dependency (unit-testable); themes.js adds the protocol and session.
//
// Two URL shapes:
//   legacy (Dooray, theme contract v1 as published): dooray-theme://<themeId>/<file>
//   every other widget:                              widget-theme://<themeId>.<widgetId>/<file>
// Each theme keeps its own origin either way, and a widget's session only serves that widget's themes.
const fs = require('fs');
const path = require('path');
const { validateManifest, LEGACY_WIDGET } = require('./theme-manifest');

const LEGACY_SCHEME = 'dooray-theme';
const LEGACY_PARTITION = 'dooray-theme';
const SCHEME = 'widget-theme';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BASES = 4;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** Session partition of a widget's theme pages (in memory, one per widget). */
const partitionFor = (widgetId) => `widget-theme-${widgetId}`;

/**
 * @param {{ widgetId?: string, legacy?: boolean, builtinDir?: string, userDir?: string, kitDir?: string,
 *           defaultTheme?: string, contractVersions?: number[], frames?: object }} opts
 *   legacy: the Dooray theme host (dooray-theme://, contract v1, overview/project windows).
 */
function createRegistry({ widgetId, legacy = false, builtinDir = null, userDir = null, kitDir = null, defaultTheme, contractVersions, frames } = {}) {
  const owner = legacy ? LEGACY_WIDGET : widgetId;
  if (!ID_PATTERN.test(owner || '')) throw new Error(`invalid widget id "${owner}"`);
  const manifestOpts = legacy ? { widgetId: LEGACY_WIDGET } : { widgetId: owner, contractVersions: contractVersions || [1], frames };
  const defaultId = defaultTheme || (legacy ? 'glass' : null);
  let devThemeDir = null;
  let themes = new Map();

  function readTheme(dir, source, checkFolderName = true) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'));
      const { manifest, errors, compatible } = validateManifest(raw, checkFolderName ? path.basename(dir) : undefined, manifestOpts);
      if (!manifest) return null;
      return { ...manifest, dir, dirs: [dir], source, errors, usable: compatible && errors.length === 0 };
    } catch (err) {
      return {
        id: path.basename(dir).toLowerCase(),
        name: path.basename(dir),
        version: '',
        author: '',
        description: '',
        dir,
        dirs: [dir],
        source,
        errors: [`theme.json을 읽을 수 없습니다: ${err.message}`],
        usable: false,
      };
    }
  }

  function scan(dir, source) {
    if (!dir || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'theme.json')))
      .map((d) => readTheme(path.join(dir, d.name), source))
      .filter(Boolean);
  }

  /**
   * Resolves "extends": a theme's files are looked up in its own folder first, then in its base themes
   * (up to 4 levels), then in the widget's kit folder. A missing, unusable or circular base makes the theme unusable.
   */
  function linkBases(all) {
    for (const t of all.values()) {
      let cur = t;
      const seen = new Set([t.id]);
      while (cur.extends && t.errors.length === 0) {
        const base = all.get(cur.extends);
        if (!base) t.errors.push(`base theme "${cur.extends}" not found`);
        else if (seen.has(base.id) || seen.size > MAX_BASES) t.errors.push(`base theme chain is circular or too deep`);
        else if (base.errors.some((e) => !e.startsWith('entry file'))) t.errors.push(`base theme "${base.id}" is not usable`);
        else {
          t.dirs.push(base.dir);
          seen.add(base.id);
          cur = base;
          continue;
        }
        break;
      }
      // The theme whose folder holds the entry page decides the layout (window sizes are saved per layout).
      const pageDir = t.dirs.find((d) => fs.existsSync(path.join(d, t.entry || 'index.html')));
      if (!pageDir) t.errors.push(`entry file "${t.entry}" not found`);
      else t.layoutId = [...all.values()].find((x) => x.dir === pageDir)?.id || t.id;
      if (kitDir) t.dirs.push(kitDir);
      t.usable = t.usable && t.errors.length === 0;
    }
  }

  /** Rescans the theme folders. User themes override built-in ones with the same id. */
  function refresh() {
    if (userDir) fs.mkdirSync(userDir, { recursive: true });
    const next = new Map();
    for (const t of scan(builtinDir, 'builtin')) next.set(t.id, t);
    for (const t of scan(userDir, 'user')) next.set(t.id, t);
    if (devThemeDir) {
      const t = readTheme(devThemeDir, 'dev', false);
      // A theme under development only goes to the widget it is written for (theme.json "widget").
      if (t && (t.widget || LEGACY_WIDGET) === owner) next.set(t.id, t);
    }
    linkBases(next);
    themes = next;
    return themes;
  }

  const defaultFirst = (a, b) => (a.id === defaultId ? -1 : b.id === defaultId ? 1 : a.name.localeCompare(b.name));

  return {
    widgetId: owner,
    legacy,
    defaultTheme: defaultId,
    scheme: legacy ? LEGACY_SCHEME : SCHEME,
    partition: legacy ? LEGACY_PARTITION : partitionFor(owner),
    userDir: () => userDir,

    setDevThemeDir(dir) {
      devThemeDir = dir ? path.resolve(dir) : null;
    },

    refresh,

    listThemes() {
      refresh();
      return [...themes.values()].map(({ dir, dirs, layoutId, ...rest }) => ({ ...rest, layout: layoutId || null })).sort(defaultFirst);
    },

    /** A usable theme: the dev theme, else the requested one, else the default, else any usable one. */
    resolveTheme(preferredId) {
      refresh();
      const usable = (id) => themes.get(id)?.usable && themes.get(id);
      if (devThemeDir) {
        const dev = [...themes.values()].find((t) => t.source === 'dev' && t.usable);
        if (dev) return dev;
      }
      return usable(preferredId) || usable(defaultId) || [...themes.values()].sort(defaultFirst).find((t) => t.usable) || null;
    },

    /** The usable theme with exactly this id (no fallback), or null. */
    getTheme(id) {
      refresh();
      const t = themes.get(id);
      return t?.usable ? t : null;
    },

    /** The theme's own origin: dooray-theme://<id> or widget-theme://<id>.<widgetId>. */
    originOf(theme) {
      return legacy ? `${LEGACY_SCHEME}://${theme.id}` : `${SCHEME}://${theme.id}.${owner}`;
    },

    themeUrl(theme) {
      return `${this.originOf(theme)}/${theme.entry.replace(/\\/g, '/')}`;
    },

    /** True when a URL belongs to this theme (in-theme navigation such as a reload). */
    isThemeUrl(theme, url) {
      return Boolean(theme) && String(url).startsWith(`${this.originOf(theme)}/`);
    },

    /** The theme id a URL of this registry points at, or null (wrong scheme, or another widget's theme). */
    themeIdOf(url) {
      let u;
      try {
        u = new URL(String(url));
      } catch {
        return null;
      }
      if (u.protocol !== `${this.scheme}:`) return null;
      if (legacy) return ID_PATTERN.test(u.hostname) ? u.hostname : null;
      const dot = u.hostname.indexOf('.');
      if (dot < 0) return null;
      const themeId = u.hostname.slice(0, dot);
      return u.hostname.slice(dot + 1) === owner && ID_PATTERN.test(themeId) ? themeId : null;
    },

    /**
     * The file a theme URL serves: { file, contentType } or null. Looks in the theme's folder, its bases and the kit
     * folder; anything outside those folders (path traversal) is null.
     */
    async resolveFile(url) {
      const id = this.themeIdOf(url);
      const theme = id && themes.get(id);
      if (!theme) return null;
      const rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '') || theme.entry;
      for (const dir of theme.dirs) {
        const root = path.resolve(dir);
        const file = path.resolve(root, rel);
        if (file === root || !file.startsWith(root + path.sep)) return null;
        try {
          if ((await fs.promises.stat(file)).isFile()) return { file, contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' };
        } catch {
          // not in this folder: try the next one
        }
      }
      return null;
    },
  };
}

module.exports = { createRegistry, partitionFor, LEGACY_SCHEME, LEGACY_PARTITION, SCHEME, MIME };
