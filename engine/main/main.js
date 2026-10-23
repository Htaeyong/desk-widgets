// Node's thread pool (file reads, DNS lookups) starts 4 threads that each commit an 8 MB stack on
// Windows (~32 MB). This app does a handful of small reads and one request batch per refresh, so one
// thread is enough. Must be set before anything uses the pool (it starts lazily). Issue #29.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '1';

// Desk Widgets engine: app lifecycle, tray, widget manager and the services widgets share.
// Widgets are installed separately (widgets folder next to the engine) and loaded through
// engine/main/widgets.js; nothing here is specific to one widget.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const settings = require('./settings');
const themes = require('./themes');
const { createStore } = require('./store');
const { ThemeHost } = require('./theme-host');
const { WidgetHost, WidgetWatcher, ENGINE_API } = require('./widgets');
const { createWidgetWindow } = require('./widget-window');
const { PresenceMonitor } = require('./presence');
const { SystemMetrics } = require('./system-metrics');
const { WindowOcclusion } = require('./window-occlusion');
const { NotificationCenter } = require('./notifications');
const { DesktopKeeper, DesktopAnchor } = require('./desktop');
const { migrateLegacy } = require('./migrate');

const APP_ID = 'com.chilgong88.desk-widgets';
// The app before the rename (#33): its data folder is copied in once, its startup entry removed.
const LEGACY_APP_ID = 'com.cap577.dooray-widget';
const LEGACY_DATA_FOLDER = 'dooray-widget';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_DIR = path.join(__dirname, '..', 'preload');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

// --- Command line ---
// --settings                 open the widget manager at launch
// --widgets-dir <folder>     load installed widgets from this folder instead of the default
// --widget <folder>          also load the widget in this source folder (widget development; repeatable)
// --widget-installed=<id>    sent by a widget installer: turn that widget on, show it (and its setup)
// --theme <folder>           load a theme from any folder (theme development)
// --mock-data                use fictional sample data instead of live services
// --devtools                 open DevTools for theme windows (F12 toggles)
// --gpu                      use hardware acceleration (off by default, see below)
// --legacy-data-dir <folder> copy old "Dooray Widget" data from this folder (migration testing)
// --sample-card              show sample generic notification cards at launch (card development)
function argValue(name, argv = process.argv) {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function argValues(name, argv = process.argv) {
  const out = [];
  argv.forEach((a, i) => {
    if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
    else if (a === name && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
}
const flags = {
  settings: process.argv.includes('--settings'),
  widgetsDir: argValue('--widgets-dir'),
  devWidgets: argValues('--widget').map((d) => path.resolve(d)),
  widgetInstalled: argValue('--widget-installed'),
  theme: argValue('--theme'),
  mockData: process.argv.includes('--mock-data'),
  devtools: process.argv.includes('--devtools'),
  gpu: process.argv.includes('--gpu'),
  legacyDataDir: argValue('--legacy-data-dir'),
  sampleCard: process.argv.includes('--sample-card'),
};

/**
 * Installed widgets live next to the engine folder: C:\Program Files\chilgong88\widgets\<id>\.
 * Only an administrator can write there (widget code runs with the app's full rights), and engine
 * updates or uninstalls, which replace the engine folder, leave it alone. In development the
 * repository's widgets/ folder is used.
 */
function widgetsDir() {
  if (flags.widgetsDir) return path.resolve(flags.widgetsDir);
  if (app.isPackaged) return path.join(path.dirname(path.dirname(process.execPath)), 'widgets');
  return path.join(__dirname, '..', '..', 'widgets');
}

// A small, mostly static widget gains nothing from the GPU, and the GPU process alone takes ~80 MB
// (~16 MB with software rendering). Transparency, acrylic and rounded corners still work. Issue #29.
if (!flags.gpu) app.disableHardwareAcceleration();

// One data folder for development runs and the installed app (the product name would otherwise
// give the packaged app a different folder). --user-data-dir=<folder> still wins (tests, support).
const customDataDir = app.commandLine.hasSwitch('user-data-dir');
if (!customDataDir) app.setPath('userData', path.join(app.getPath('appData'), 'chilgong88', 'desk-widgets'));
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Keep mock runs from touching the real user's settings and window layout.
if (flags.mockData) app.setPath('userData', `${app.getPath('userData')}-mock`);

// Copy the old app's data before "ready": Chromium reads the copied "Local State" (the key of the
// encrypted API token) at startup. Only into a fresh folder; the old folder is left untouched.
// The data waits in widgets/dooray/ until the Dooray widget is installed.
{
  const legacyDir = flags.legacyDataDir || (!customDataDir && !flags.mockData ? path.join(app.getPath('appData'), LEGACY_DATA_FOLDER) : null);
  if (legacyDir) {
    try {
      const result = migrateLegacy({ legacyDir, userData: app.getPath('userData') });
      if (result.migrated) console.log(`Migrated ${result.copied.join(', ')} from ${legacyDir}`);
    } catch (err) {
      console.error(`Migration from ${legacyDir} failed: ${err.message}`);
    }
  }
}

themes.registerScheme();

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

let managerWindow;
let tray;
let notifications;
let desktopAnchor;
let desktopKeeper;
let widgets;
let watcher;
const settingsWindows = new Map(); // widget id -> its settings window
const themeHosts = new Map(); // widget id -> its ThemeHost (ctx.useThemes)
const windowOcclusion = new WindowOcclusion();

// --- Engine windows ---

function appWindowOptions({ title, width, height, minWidth, minHeight, preload }) {
  return {
    width,
    height,
    minWidth,
    minHeight,
    title,
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#16181d',
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
}

/** The widget manager: installed widgets (on/off, settings) and engine-wide settings. */
function openManager() {
  if (managerWindow) {
    managerWindow.show();
    managerWindow.focus();
    return;
  }
  managerWindow = new BrowserWindow(
    appWindowOptions({ title: 'Desk Widgets', width: 520, height: 760, minWidth: 420, minHeight: 480, preload: path.join(PRELOAD_DIR, 'settings.js') })
  );
  managerWindow.setMenu(null);
  managerWindow.loadFile(path.join(RENDERER_DIR, 'settings.html'));
  managerWindow.once('ready-to-show', () => managerWindow.show());
  managerWindow.on('closed', () => {
    managerWindow = null;
  });
}

/** A widget's own settings window (its settings/panel.html inside an engine frame). */
function openWidgetSettings(id) {
  const record = widgets.get(id);
  if (!record?.manifest.settings || !record.instance.settings) {
    openManager();
    return;
  }
  const existing = settingsWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow(
    appWindowOptions({ title: `${record.manifest.name} 설정`, width: 500, height: 760, minWidth: 420, minHeight: 480, preload: path.join(PRELOAD_DIR, 'widget-settings.js') })
  );
  win.setMenu(null);
  win.loadFile(path.join(RENDERER_DIR, 'widget-settings.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (settingsWindows.get(id) === win) settingsWindows.delete(id);
    // An opacity slider value that was never saved ends with the window (#55), even if the page could not say so.
    themeHosts.get(id)?.setLiveOpacity(null, null);
  });
  settingsWindows.set(id, win);
}

function closeWidgetSettings(id) {
  const win = settingsWindows.get(id);
  if (win && !win.isDestroyed()) win.close();
}

function widgetOfSettingsWindow(sender) {
  for (const [id, win] of settingsWindows) if (!win.isDestroyed() && win.webContents === sender) return id;
  throw new Error('Not a widget settings window');
}

// --- Tray: the entry point when no widget is open ---

function refreshTray() {
  if (!tray) return;
  const items = widgets.running().filter((r) => r.manifest.settings && r.instance.settings).map((r) => ({ label: `${r.manifest.name} 설정`, click: () => openWidgetSettings(r.manifest.id) }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '위젯 관리 · 설정', click: openManager },
      ...(items.length ? [{ type: 'separator' }, ...items] : []),
      { type: 'separator' },
      { label: 'Desk Widgets 종료', click: () => app.quit() },
    ])
  );
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('Desk Widgets');
  tray.on('click', openManager);
  refreshTray();
}

// --- Engine behavior ---

// Only the chosen Win+D mode runs its timer; leaving anchor mode releases the owner link.
function applyDesktopMode() {
  if (!desktopAnchor || !desktopKeeper) return;
  const mode = settings.load().desktopMode;
  if (mode === 'anchor') desktopAnchor.start();
  else {
    desktopAnchor.stop();
    desktopAnchor.releaseAll();
  }
  if (mode === 'raise') desktopKeeper.start();
  else desktopKeeper.stop();
}

function applyLoginItem(s) {
  // Registering a login item only makes sense for the built exe.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: s.launchAtStartup });
  // The old app's startup entry would launch an exe that is gone (or the old app) after the rename.
  if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: false, name: LEGACY_APP_ID });
}

function managerState() {
  const { migratedFrom, widgets: _w, ...engine } = settings.load();
  return {
    version: app.getVersion(),
    engineApi: ENGINE_API,
    widgetsDir: widgetsDir(),
    engine: { ...engine, limits: settings.LIMITS },
    widgets: widgets.list(),
  };
}

function refreshUi() {
  refreshTray();
  if (managerWindow) managerWindow.webContents.send('engine:changed', managerState());
}

/** After widgets started: a widget that cannot work yet (e.g. no API token) shows its own setup. */
function openSetupFor(ids) {
  if (flags.mockData) return;
  for (const id of ids) if (widgets.needsSetup(id)) openWidgetSettings(id);
}

async function setEnabled(id, enabled) {
  const s = settings.load();
  settings.save({ widgets: { ...s.widgets, [id]: { enabled: Boolean(enabled) } } });
  if (!enabled) closeWidgetSettings(id);
  await widgets.sync();
  if (enabled) openSetupFor([id]);
  refreshUi();
}

/** Re-reads the widgets folder (installer signal or folder change) and applies the result. */
async function reloadWidgets({ installed } = {}) {
  const { added, removed, updated } = widgets.rescan();
  for (const id of removed) closeWidgetSettings(id);
  // An installer said "this one was just installed": use it even if it was turned off before.
  if (installed && widgets.get(installed) && !widgets.isEnabled(installed)) {
    const s = settings.load();
    settings.save({ widgets: { ...s.widgets, [installed]: { enabled: true } } });
  }
  await widgets.sync();
  const fresh = [...new Set([...added, ...updated, ...(installed ? [installed] : [])])];
  openSetupFor(fresh);
  if (installed) widgets.get(installed)?.instance.focus?.();
  if (added.length || removed.length || updated.length || installed) refreshUi();
}

/** Engine features every widget context gets (see engine/main/widgets.js and docs/widget-dev.md). */
function widgetServices(ctx) {
  const openSettings = () => openWidgetSettings(ctx.id);
  const disable = () => setEnabled(ctx.id, false);
  // Right-click menu of a widget window: the widget's items, then the engine's.
  const popupMenu = (win, items = []) =>
    Menu.buildFromTemplate([
      ...items,
      ...(items.length ? [{ type: 'separator' }] : []),
      ...(ctx.manifest.settings ? [{ label: '설정', click: openSettings }] : []),
      { label: '위젯 관리', click: openManager },
      { type: 'separator' },
      { label: '이 위젯 끄기', click: disable },
      { label: 'Desk Widgets 종료', click: () => app.quit() },
    ]).popup({ window: win });
  return {
    engineApi: ENGINE_API,
    flags: { mockData: flags.mockData, devtools: flags.devtools },
    app: { version: app.getVersion(), isPackaged: app.isPackaged, locale: () => app.getLocale() },
    createStore,
    system: { createSampler: (options) => new SystemMetrics(options), isWindowCovered: (window) => windowOcclusion.isCovered(window) },
    openSettings,
    openManager,
    disable,
    quit: () => app.quit(),
    // The engine adds which widget sent the cards (shown on generic cards, engine API 1.2).
    // A button press after the widget was turned off or reloaded is not passed to the old instance.
    notify: (events, opts = {}) =>
      notifications.push(events, {
        ...opts,
        onAction: typeof opts.onAction === 'function' ? (event, actionId) => (widgets.get(ctx.id)?.ctx === ctx && widgets.get(ctx.id).running ? opts.onAction(event, actionId) : undefined) : null,
        widget: { id: ctx.id, name: ctx.manifest.name },
      }),
    beforeFocus: (win) => desktopAnchor?.detach(win),
    sendToSettings: (name, payload) => settingsWindows.get(ctx.id)?.webContents.send('settings:widget-event', ctx.id, name, payload),
    openExternal: (url) => shell.openExternal(url),
    confirm: async (win, options) => (await dialog.showMessageBox(win, options)).response,
    openAppWindow: ({ html, preload, query, title, width, height, minWidth, minHeight }) => {
      const win = new BrowserWindow(appWindowOptions({ title, width, height, minWidth, minHeight, preload }));
      win.setMenu(null);
      win.loadFile(html, query ? { query } : undefined);
      win.once('ready-to-show', () => win.show());
      ctx.onStop(() => !win.isDestroyed() && win.destroy());
      return win;
    },
    createWidgetWindow: (opts) => {
      const win = createWidgetWindow(opts);
      ctx.onStop(() => !win.isDestroyed() && win.destroy());
      return win;
    },
    popupMenu,
    useThemes: (opts) => {
      // widget.json "themes" gives the defaults of a widget with its own theme contract (#57).
      const declared = ctx.manifest.themes || {};
      const host = new ThemeHost({
        contract: declared.contract,
        contractVersions: declared.contractVersions,
        defaultTheme: declared.default,
        ...opts,
        widgetId: ctx.id,
        widgetName: ctx.manifest.name,
        popupMenu,
        devtools: flags.devtools,
        devThemeDir: flags.theme,
        openSettings,
        // The overview's close button turns the widget off; the engine (tray) keeps running.
        onQuitRequest: disable,
        beforeFocus: (win) => desktopAnchor?.detach(win),
        onThemeApplied: (id) => settingsWindows.get(ctx.id)?.webContents.send('settings:widget-event', ctx.id, 'theme-applied', id),
      });
      themeHosts.set(ctx.id, host);
      return host;
    },
  };
}

function panelOf(record) {
  const p = record.manifest.settings;
  return {
    html: fs.readFileSync(path.join(record.dir, p.html), 'utf8'),
    script: pathToFileURL(path.join(record.dir, p.script)).href,
    style: p.style ? pathToFileURL(path.join(record.dir, p.style)).href : null,
  };
}

// --- Widget manager IPC ---

function managerSender(event) {
  if (!managerWindow || event.sender !== managerWindow.webContents) throw new Error('Not the widget manager');
}

ipcMain.handle('engine:get', (event) => {
  managerSender(event);
  return managerState();
});
ipcMain.handle('engine:set-enabled', async (event, id, enabled) => {
  managerSender(event);
  if (!widgets.get(String(id))) return { ok: false, message: '위젯을 찾을 수 없습니다.' };
  await setEnabled(String(id), enabled);
  return { ok: true, state: managerState() };
});
ipcMain.handle('engine:open-widget-settings', (event, id) => {
  managerSender(event);
  openWidgetSettings(String(id));
});
ipcMain.handle('engine:open-widgets-folder', (event) => {
  managerSender(event);
  return fs.existsSync(widgetsDir()) ? shell.openPath(widgetsDir()) : '위젯 폴더가 아직 없습니다.';
});
ipcMain.handle('engine:save', (event, values = {}) => {
  managerSender(event);
  try {
    const before = settings.load();
    const { widgets: _w, migratedFrom, ...engine } = values;
    const s = settings.save(engine);
    applyLoginItem(s);
    if (s.desktopMode !== before.desktopMode) applyDesktopMode();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `저장 실패: ${err.message}` };
  }
});
ipcMain.handle('engine:close', (event) => {
  managerSender(event);
  managerWindow?.close();
});

// --- Widget settings window IPC ---

ipcMain.handle('widget-settings:get', (event) => {
  const id = widgetOfSettingsWindow(event.sender);
  const record = widgets.get(id);
  return {
    widget: { id, name: record.manifest.name, version: record.manifest.version },
    values: record.instance.settings.get?.() ?? null,
    panel: panelOf(record),
  };
});
ipcMain.handle('widget-settings:call', (event, name, ...args) => widgets.callSettings(widgetOfSettingsWindow(event.sender), String(name), args));
ipcMain.handle('widget-settings:save', async (event, values) => {
  const id = widgetOfSettingsWindow(event.sender);
  try {
    const res = await widgets.get(id).instance.settings.save(values);
    if (!res?.ok) return { ok: false, message: res?.message || '저장하지 못했습니다.' };
    closeWidgetSettings(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `저장 실패: ${err.message}` };
  }
});
ipcMain.handle('widget-settings:close', (event) => closeWidgetSettings(widgetOfSettingsWindow(event.sender)));

// --- App lifecycle ---

/** --sample-card: generic cards (engine API 1.2) to check their look without a widget. */
function showSampleCards() {
  notifications.push(
    [
      { type: 'card', title: '샘플 알림입니다', body: '설정한 시간이 지나면 닫힙니다. 아이콘·본문·버튼이 없는 카드도 됩니다.', icon: 'bell' },
      {
        type: 'card',
        title: '타이머 종료 (샘플)',
        body: '25분 타이머가 끝났습니다. 확인할 때까지 남습니다.',
        icon: 'alarm',
        sticky: true,
        sound: true,
        actions: [
          { id: 'snooze', label: '5분 뒤 다시' },
          { id: 'keep', label: '그대로 두기' },
        ],
      },
    ],
    {
      widget: { id: '_sample', name: 'Desk Widgets 샘플' },
      onAction: (_event, id) => (id === 'keep' ? { keepOpen: true } : undefined),
    }
  );
}

// A second launch: from a widget installer (--widget-installed=<id>), from the Start menu, or autostart.
app.on('second-instance', (_event, argv) => {
  if (!widgets) return;
  const installed = argValue('--widget-installed', argv);
  if (installed) {
    reloadWidgets({ installed });
    return;
  }
  if (argv.includes('--settings') || !widgets.focusAny()) openManager();
});

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;

  notifications = new NotificationCenter({ getSettings: () => settings.load() });

  widgets = new WidgetHost({
    sources: () => ({ dirs: [widgetsDir()], folders: flags.devWidgets }),
    dataDir: (id) => path.join(app.getPath('userData'), 'widgets', id),
    getEnabledMap: () => settings.load().widgets,
    services: widgetServices,
    engineVersion: app.getVersion(),
  }).init();

  // Widgets stay on the desktop after "Show desktop" (Win+D): anchor or raise mode (settings).
  const desktopWindows = () => widgets.desktopWindows();
  desktopAnchor = new DesktopAnchor({ getWindows: desktopWindows, isEnabled: () => settings.load().desktopMode === 'anchor' });
  desktopKeeper = new DesktopKeeper({ getWindows: desktopWindows, isEnabled: () => settings.load().desktopMode === 'raise' });

  createTray();
  if (flags.widgetInstalled) await reloadWidgets({ installed: flags.widgetInstalled });
  else await widgets.sync();
  applyDesktopMode();
  refreshUi();

  // Widget installers add and remove folders while the engine runs.
  watcher = new WidgetWatcher({ dirs: [widgetsDir(), ...flags.devWidgets], onChange: () => reloadWidgets() });
  watcher.start();

  // No polling while the screen is locked, the PC sleeps or the user is away.
  const presence = new PresenceMonitor({ getIdleMinutes: () => settings.load().idleMinutes });
  presence.on('change', (reason) => {
    widgets.setPaused(reason);
    notifications.setAway(Boolean(reason));
  });
  presence.start();

  // Keep the Windows startup entry in step with the setting and the current exe location
  // (reinstalling into another folder would otherwise leave a stale path behind).
  applyLoginItem(settings.load());

  if (flags.sampleCard) showSampleCards();
  if (flags.settings || !widgets.list().length) openManager();
  openSetupFor(widgets.running().map((r) => r.manifest.id));
});

app.on('before-quit', () => {
  watcher?.stop();
  desktopAnchor?.releaseAll();
  widgets?.stopAll();
});

// The tray keeps the engine alive with no window open (all widgets off, or none installed).
app.on('window-all-closed', () => {});
