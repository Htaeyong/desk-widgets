// Theme hosting for widgets whose look comes from swappable themes: theme windows, the theme preview and the
// theme API. One host per themed widget (#57). The engine answers the window/context calls itself; data calls go
// to the widget.
//
// Two kinds of host:
//   legacy (Dooray, ctx.useThemes({ store, builtinDir, userDir, api })): window.dooray, "theme:*" channels,
//     dooray-theme://, session "dooray-theme", THEME_SPEC.md v1 exactly as published.
//   a widget with its own theme contract (ctx.useThemes({ ..., methods, events })): window.widget,
//     "widget-theme:*" channels, widget-theme://<themeId>.<widgetId>/, session "widget-theme-<widgetId>".
const path = require('path');
const { app, ipcMain, shell } = require('electron');
const { createRegistry } = require('./theme-registry');
const { effectiveOpacity, clampPercent } = require('./theme-background');
const { normalizeMethods, normalizeEvents, describe, dispatch } = require('./theme-calls');
const { ThemeWindows } = require('./windows');
const { ThemePreview } = require('./preview');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const LEGACY_KEY = '#legacy';
// The drag region raises both system-context-menu and a DOM contextmenu for one right click: show one menu.
const MENU_DEDUPE_MS = 400;
// widget id (or LEGACY_KEY) -> its host. A widget that is loaded again gets a new host in place of the old one.
const hosts = new Map();

/**
 * Data calls of the Dooray theme API v1 and the widget `api` method that answers each one.
 * Each method gets the calling window entry first ({ preview, mode, projectId, ... }).
 * A method the widget does not provide resolves to null.
 */
const DATA_CALLS = {
  'theme:get-snapshot': 'getSnapshot',
  'theme:refresh': 'refresh',
  'theme:open-url': 'openUrl',
  'theme:set-project-order': 'setProjectOrder',
  'theme:categories': 'categories',
  'theme:open-category-manager': 'openCategoryManager',
};

/** Every channel a Dooray theme page uses (kept by tests: renaming one breaks published themes). */
const LEGACY_CHANNELS = [
  ...Object.keys(DATA_CALLS),
  'theme:add-to-todo',
  'theme:get-context',
  'theme:open-settings',
  'theme:open-project',
  'theme:window-close',
  'theme:window-toggle-pin',
  'theme:window-state',
  'theme:window-set-size',
];

function findHost(sender, legacy) {
  for (const host of hosts.values()) {
    if (host.legacy !== legacy) continue;
    const entry = host.windows.fromSender(sender);
    if (entry) return { host, entry };
  }
  return null;
}

let ipcReady = false;
function registerIpc() {
  if (ipcReady) return;
  ipcReady = true;

  // --- Dooray (legacy) theme pages: window.dooray ---
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      const found = findHost(event.sender, true);
      if (!found) throw new Error('Not a theme window');
      return fn(found.host, found.entry, ...args);
    });

  for (const [channel, method] of Object.entries(DATA_CALLS)) {
    handle(channel, (host, entry, ...args) => (typeof host.api[method] === 'function' ? host.api[method](entry, ...args) : null));
  }
  handle('theme:add-to-todo', (host, entry, taskId, activated) =>
    activated === true && !entry.preview && typeof host.api.addToTodo === 'function'
      ? host.api.addToTodo(entry, taskId)
      : { ok: false, message: '클릭이나 키 입력으로만 할 수 있습니다.' });
  handle('theme:get-context', (host, entry) => {
    const theme = entry.theme || host.windows.theme;
    return {
      mode: entry.mode,
      projectId: entry.projectId,
      theme: { id: theme.id, name: theme.name, version: theme.version },
      // v1.8 (#55): null when the theme does not declare "background" in theme.json.
      background: theme.background ? { opacity: host.backgroundOf(theme) } : null,
      locale: app.getLocale() || 'ko-KR',
    };
  });
  handle('theme:open-settings', (host, entry) => !entry.preview && host.openSettings());
  handle('theme:open-project', (host, entry, projectId) => {
    if (entry.preview || !/^[\w-]{1,64}$/.test(projectId)) return;
    host.windows.openProject(projectId);
  });
  // The preview frame owns its theme page: close / pin / size act on the preview, not on a widget.
  handle('theme:window-close', (host, entry) => host.closeWindow(entry));
  handle('theme:window-toggle-pin', (host, entry) => (entry.preview ? false : host.windows.togglePin(entry)));
  handle('theme:window-state', (host, entry) => ({ pinned: entry.preview ? false : entry.win.isAlwaysOnTop() }));
  handle('theme:window-set-size', (host, entry, width, height) => host.setWindowSize(entry, width, height));

  // --- Theme pages of widgets with their own contract: window.widget (#57) ---
  const wHandle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      const found = findHost(event.sender, false);
      if (!found) throw new Error('Not a widget theme window');
      return fn(found.host, found.entry, ...args);
    });
  wHandle('widget-theme:context', (host, entry) => host.contextOf(entry));
  wHandle('widget-theme:call', (host, entry, name, args, activated) =>
    dispatch(host.methods, name, args, host.entryView(entry), { activated: activated === true })
  );
  wHandle('widget-theme:open-settings', (host, entry) => {
    if (!entry.preview) host.openSettings();
  });
  wHandle('widget-theme:window', (host, entry, action, width, height) => {
    switch (action) {
      case 'close':
        return host.closeWindow(entry);
      case 'toggle-pin':
        return entry.preview ? false : host.windows.togglePin(entry);
      case 'state':
        return { pinned: entry.preview ? false : entry.win.isAlwaysOnTop() };
      case 'set-size':
        return host.setWindowSize(entry, width, height);
      case 'menu':
        return host.openMenu(entry);
      default:
        return null;
    }
  });

  // Preview frame (top bar) calls.
  const previewHandle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      const host = [...hosts.values()].find((h) => h.preview.win && h.preview.win.webContents === event.sender);
      if (!host) throw new Error('Not the theme preview');
      return fn(host, ...args);
    });
  previewHandle('preview:get-state', (host) => host.preview.state());
  previewHandle('preview:step', (host, delta) => host.preview.step(Number(delta) < 0 ? -1 : 1));
  previewHandle('preview:apply', (host) => host.preview.apply());
  previewHandle('preview:close', (host) => host.preview.close());
}

class ThemeHost {
  /**
   * @param {object} opts
   * @param {{ load(): object, save(p: object): object }} opts.store  the widget's settings: themeId, alwaysOnTop and
   *   (Dooray) windowBounds / projectWidgets or (others) themeBounds / themeFrames; themeOpacity: { [themeId]: 0..100 } (#55).
   * @param {string} opts.builtinDir  built-in themes (in the widget package)
   * @param {string} opts.userDir  the user's themes (in the widget's data folder)
   * @param {object} [opts.api]  Dooray only: the data calls of window.dooray (DATA_CALLS)
   * @param {object} [opts.methods]  #57: what window.widget.api offers (theme-calls.js); its presence selects the new kind
   * @param {string[]} [opts.events]  #57: events the widget may send with emit()
   * @param {string} [opts.widgetId], [opts.widgetName]  the widget (given by the engine)
   * @param {string} [opts.contract]  name of the widget's theme contract (default: the widget id)
   * @param {number[]} [opts.contractVersions]  theme contract versions the widget supports (default [1])
   * @param {string} [opts.defaultTheme]  default theme id (Dooray: glass)
   * @param {string} [opts.kitDir]  files every theme can load (looked up after the theme and its bases)
   * @param {object} [opts.frames]  { main: { width, height, minWidth, minHeight, variants? }, ... }: the first is the main window
   * @param {(frame: string) => string|null} [opts.variant]  current size variant (e.g. 'tools')
   * @param {(entry: object) => object[]} [opts.menuItems]  the widget's items of the theme window's right-click menu
   */
  constructor(opts) {
    const { store, builtinDir, userDir, api, devtools = false, devThemeDir, openSettings, onQuitRequest, beforeFocus, onThemeApplied } = opts;
    registerIpc();
    this.legacy = !opts.methods;
    this.widgetId = this.legacy ? 'dooray' : opts.widgetId;
    this.widgetName = opts.widgetName || this.widgetId;
    this.contract = opts.contract || this.widgetId;
    if (!this.legacy) {
      this.methods = normalizeMethods(opts.methods);
      this.events = normalizeEvents(opts.events);
      this.menuItems = typeof opts.menuItems === 'function' ? opts.menuItems : () => [];
      this.popupMenu = opts.popupMenu;
    }
    const frames = this.legacy ? null : opts.frames || { main: {} };
    this.registry = createRegistry({
      widgetId: this.widgetId,
      legacy: this.legacy,
      builtinDir,
      userDir,
      kitDir: this.legacy ? null : opts.kitDir,
      defaultTheme: opts.defaultTheme,
      contractVersions: opts.contractVersions,
      frames,
    });
    this.registry.setDevThemeDir(devThemeDir);
    this.store = store;
    this.api = api || {};
    this.openSettings = openSettings;
    this.onThemeApplied = onThemeApplied;
    // { themeId, value } while the settings window's opacity slider moves and is not saved yet (#55).
    this.liveOpacity = null;
    this.lastMenuAt = 0;
    this.windows = new ThemeWindows({
      settings: store,
      devtools,
      onQuitRequest,
      backgroundOf: (theme) => this.backgroundOf(theme),
      registry: this.registry,
      frames: frames && Object.keys(frames),
      getVariant: typeof opts.variant === 'function' ? (frame) => opts.variant(frame) || null : undefined,
      additionalArguments: this.legacy ? [] : [`--widget-theme-api=${encodeURIComponent(JSON.stringify(describe(this.methods, this.events)))}`],
      onMenu: (entry) => this.openMenu(entry),
    });
    this.windows.beforeFocus = beforeFocus;
    this.preview = new ThemePreview({
      windows: this.windows,
      getCurrentThemeId: () => store.load().themeId,
      onApply: (id) => this.applyTheme(id),
      rendererDir: RENDERER_DIR,
    });
    // A widget loaded again (or the legacy host created again) replaces its earlier host; the old instance's
    // stop() has closed its windows already.
    hosts.set(this.legacy ? LEGACY_KEY : this.widgetId, this);
  }

  /** Opens the main window (Dooray: overview) and the remembered extra windows. */
  open() {
    this.windows.openAll();
  }

  /** Closes every window of this host (the widget was turned off or the app quits). */
  close() {
    this.preview.close();
    // quitting keeps the remembered project widgets while their windows go away.
    this.windows.quitting = true;
    for (const e of this.windows.entries()) e.win.destroy();
    this.windows.quitting = false;
  }

  /** Switches the widgets to a theme right away (preview "use this theme"). */
  applyTheme(themeId) {
    if (this.store.load().themeId === themeId) return;
    this.store.save({ themeId });
    this.windows.reloadAll();
    this.onThemeApplied?.(themeId);
  }

  /** Recreates the theme windows (e.g. after the widget saved another themeId). */
  reload() {
    this.windows.reloadAll();
  }

  /** The widget's size variant changed: windows take the size saved for the new variant (#57). */
  applyVariant() {
    this.windows.applyVariant();
  }

  /** Always on top for the main window, saved as alwaysOnTop (e.g. from the widget's right-click menu). */
  setPinned(pinned) {
    this.store.save({ alwaysOnTop: Boolean(pinned) });
    this.windows.setOverviewPinned(Boolean(pinned));
  }

  /** Opens (or brings forward) another declared frame of a widget with its own contract. */
  openFrame(frame, instanceId = null) {
    if (this.legacy || frame === this.windows.mainFrame || !this.windows.frames.includes(frame)) return false;
    if (instanceId !== null && !/^[\w-]{1,64}$/.test(String(instanceId))) return false;
    this.windows.openFrame(frame, instanceId === null ? null : String(instanceId));
    return true;
  }

  /** Background opacity (0..1) a theme is drawn with: slider being moved, saved choice, theme default; null = not supported. */
  backgroundOf(theme) {
    return effectiveOpacity(theme, this.store.load().themeOpacity, this.liveOpacity);
  }

  /** Re-reads the saved opacities and applies them to every theme page (call after saving themeOpacity). */
  applyBackground() {
    this.windows.applyBackgroundAll();
  }

  /** Shows a slider value (0..100) on the theme's open pages without saving it; null goes back to what is saved. */
  setLiveOpacity(themeId, value) {
    const pct = clampPercent(value);
    const next = pct === null ? null : { themeId: String(themeId || ''), value: pct };
    if (!next && !this.liveOpacity) return;
    this.liveOpacity = next;
    this.applyBackground();
  }

  /** Dooray: sends a "theme:*" event (e.g. theme:snapshot) to every theme page. */
  broadcast(channel, payload) {
    this.windows.broadcast(channel, payload);
  }

  /** #57: sends a declared event to every theme page of this widget (window.widget.on(name, ...)). */
  emit(name, payload) {
    if (this.legacy || !this.events.includes(name)) return false;
    this.windows.broadcast('widget-theme:event', name, payload);
    return true;
  }

  desktopWindows() {
    return this.windows.entries().map((e) => e.win);
  }

  focus() {
    const main = this.windows.overview();
    if (main) this.windows.focus(main.win);
    return Boolean(main);
  }

  closeWindow(entry) {
    return entry.preview ? this.preview.close() : this.windows.close(entry);
  }

  setWindowSize(entry, width, height) {
    return entry.preview ? this.preview.setSize(width, height) : this.windows.setSize(entry, width, height);
  }

  /** What a widget's method sees of the calling page. */
  entryView(entry) {
    const theme = entry.theme || this.windows.theme;
    return {
      frame: entry.mode,
      instanceId: entry.projectId ?? null,
      preview: Boolean(entry.preview),
      theme: theme ? { id: theme.id, name: theme.name, version: theme.version, features: theme.features || [] } : null,
    };
  }

  /** window.widget.getContext() */
  contextOf(entry) {
    const theme = entry.theme || this.windows.theme;
    return {
      widget: { id: this.widgetId, name: this.widgetName },
      contract: { name: this.contract, version: theme?.contractVersion ?? null },
      frame: entry.mode,
      instanceId: entry.projectId ?? null,
      preview: Boolean(entry.preview),
      theme: { id: theme.id, name: theme.name, version: theme.version },
      background: theme.background ? { opacity: this.backgroundOf(theme) } : null,
      locale: app.getLocale() || 'ko-KR',
    };
  }

  /** The theme window's right-click menu: the widget's items, then the engine's (not in the preview). */
  openMenu(entry) {
    if (this.legacy || entry.preview || !this.popupMenu || entry.win.isDestroyed()) return false;
    if (Date.now() - this.lastMenuAt < MENU_DEDUPE_MS) return false;
    this.lastMenuAt = Date.now();
    let items = [];
    try {
      items = this.menuItems(this.entryView(entry)) || [];
    } catch (err) {
      console.error(`Theme menu of ${this.widgetId} failed: ${err.message}`);
    }
    this.popupMenu(entry.win, items);
    return true;
  }

  /** Settings-window calls a themed widget can hand to its settings panel. */
  settingsHandlers() {
    return {
      themes: () => this.registry.listThemes(),
      previewTheme: (themeId) => this.preview.open(String(themeId || '')),
      openThemeFolder: () => shell.openPath(this.registry.userDir()),
      // Background opacity slider (#55): live value while dragging; (themeId, null) ends it.
      liveOpacity: (themeId, value) => this.setLiveOpacity(themeId, value),
    };
  }
}

module.exports = { ThemeHost, DATA_CALLS, LEGACY_CHANNELS };
