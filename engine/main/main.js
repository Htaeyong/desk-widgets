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
const { createWidgetWindow, createSharedWidgetWindow } = require('./widget-window');
const { WindowGroup } = require('./window-group');
const { PresenceMonitor } = require('./presence');
const { SystemMetrics } = require('./system-metrics');
const { WindowOcclusion } = require('./window-occlusion');
const { NotificationCenter } = require('./notifications');
const { DesktopKeeper, DesktopAnchor } = require('./desktop');
const { migrateLegacy } = require('./migrate');
const { UpdateManager, UpdateScheduler } = require('./updates');
const { WidgetPicker } = require('./widget-picker');
const { createSyncController } = require('./sync-controller');
const { createSyncStore } = require('./sync-store');
const { openFileStore } = require('./files-store');
const { openSecrets, containsSecret } = require('./secrets');
const { createLegacyMigrator } = require('./sync-legacy');

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

// In-app update test mode (#104, docs/updates.md), development runs only: a local products.json and
// installers, and optionally stop before opening the installer. Ignored in the installed app.
const updateTest = app.isPackaged
  ? { url: null, dryRun: false }
  : { url: process.env.DESK_WIDGETS_UPDATE_URL || null, dryRun: process.env.DESK_WIDGETS_UPDATE_DRY_RUN === '1' };

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
let updates;
let updateScheduler;
let picker; // first-run widget picker (#96)
let pickerAutoOpen = false; // this run opened the manager for the first-run picker
let syncController;
let legacyMigrator;
let trayUpdateCount = 0;
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
    pickerAutoOpen = false;
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
  const syncLabel = (ko, en) => /^en(?:-|$)/i.test(app.getLocale()) ? en : ko;
  const items = widgets.running().filter((r) => r.manifest.settings && r.instance.settings).map((r) => ({ label: `${r.manifest.name} 설정`, click: () => openWidgetSettings(r.manifest.id) }));
  trayUpdateCount = updates?.pending().length || 0;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(trayUpdateCount ? [{ label: `업데이트 있음 (${trayUpdateCount})`, click: openManager }, { type: 'separator' }] : []),
      { label: '위젯 관리 · 설정', click: openManager },
      ...(syncController?.state().enabled ? [
        { label: syncLabel('지금 동기화', 'Sync now'), click: () => syncController.syncNow().catch((error) => console.error(`sync: ${error.message}`)) },
        { label: syncController.state().status === 'pending' ? syncLabel('동기화: 확인할 항목', 'Sync: needs review') : syncLabel('동기화: 최신', 'Sync: up to date'), enabled: false },
      ] : []),
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
    updates: updates?.snapshot() || null,
    picker: picker?.snapshot() || null,
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
  if (added.length || removed.length || updated.length || installed) {
    updates?.recompute(); // a widget update just finished: its row becomes current
    refreshUi();
  }
}

// --- In-app updates (#104): notify, and install only when the user clicks ---

/**
 * Opens a verified installer through the Windows shell, which shows UAC (the installers need administrator
 * rights, so spawn/CreateProcess cannot start them). No command string, no arguments. Returns '' when started.
 * The engine installer replaces the running app: the app quits itself so the installer does not have to close it,
 * and the installer starts it again when done. A widget installer reloads its widget in the running engine.
 */
async function launchInstaller(file, item) {
  if (updateTest.dryRun) {
    console.log(`[update test] verified, would open: ${file}`);
    return '';
  }
  const problem = await shell.openPath(file);
  if (problem) return `설치 프로그램을 실행하지 못했습니다. 설치를 취소했다면 다시 누르세요. (${problem})`;
  if (item.kind === 'engine') setTimeout(() => app.quit(), 1500);
  return '';
}

/** First sighting of new versions: one engine card that opens the widget manager. */
function notifyUpdates(items) {
  const names = items.map((i) => `${i.name} ${i.latest}`).join(', ');
  notifications.push(
    [{ type: 'card', title: 'Desk Widgets 업데이트', body: `새 버전이 있습니다: ${names}`, icon: 'info', tag: 'updates', actions: [{ id: 'open', label: '업데이트 보기' }] }],
    { widget: { id: '_engine', name: 'Desk Widgets' }, onAction: (_event, id) => (id === 'open' ? openManager() : undefined) }
  );
}

function startUpdates() {
  updates = new UpdateManager({
    engineVersion: app.getVersion(),
    engineApi: ENGINE_API,
    listWidgets: () => widgets.list(),
    productsUrl: updateTest.url || undefined,
    dev: Boolean(updateTest.url),
    stateFile: path.join(app.getPath('userData'), 'updates.json'),
    launch: launchInstaller,
    onNew: notifyUpdates,
  });
  updates.cleanupTemp();
  updates.on('change', (snapshot) => {
    managerWindow?.webContents.send('engine:updates', snapshot);
    if ((updates.pending().length || 0) !== trayUpdateCount) refreshTray();
  });
  picker = new WidgetPicker({
    updates,
    listWidgets: () => widgets.list(),
    isFirstRun: () => pickerAutoOpen,
    pickFile: async () => {
      const result = await dialog.showOpenDialog(managerWindow, { title: '위젯 설치 파일 선택', properties: ['openFile'], filters: [{ name: '위젯 설치 파일', extensions: ['exe'] }] });
      return result.canceled ? null : result.filePaths[0];
    },
    confirmUnverified: async () => {
      const { response } = await dialog.showMessageBox(managerWindow, {
        type: 'warning', buttons: ['취소', '그래도 설치'], defaultId: 0, cancelId: 0, title: '설치 파일 확인',
        message: '인터넷에 연결되지 않아 이 파일이 게시된 파일과 같은지 확인할 수 없습니다.',
        detail: '다운로드 페이지(widgets.chilgong88.com)나 GitHub 릴리스에서 직접 받은 파일만 설치하세요.',
      });
      return response === 1;
    },
  });
  picker.on('change', (snapshot) => managerWindow?.webContents.send('engine:picker', snapshot));
  updateScheduler = new UpdateScheduler({
    check: (opts) => updates.check(opts),
    isEnabled: () => !flags.mockData && settings.load().updateCheck,
    getLastCheck: () => updates.lastCheck(),
    ...(updateTest.url ? { initialDelayMs: 5000 } : {}),
  });
  updateScheduler.start();
}

/** Engine features every widget context gets (see engine/main/widgets.js and docs/widget-dev.md). */
function widgetServices(ctx) {
  const openSettings = () => openWidgetSettings(ctx.id);
  const disable = () => setEnabled(ctx.id, false);
  let windowGroup = null; // createSharedWidgetWindow's process, started with the first shared window
  // A widget's window closes with the widget; one the user closed earlier takes its cleanup back (#109).
  const untilStop = (win) => {
    const off = ctx.onStop(() => !win.isDestroyed() && win.destroy());
    win.once('closed', off);
    return win;
  };
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
    // Engine-central storage (#108): widgets read and write only these stores on this PC; the engine
    // exchanges their declared shared parts through the sync folder, which widgets never see.
    createStore: (options) => createSyncStore({
      createStore, manager: syncController?.manager, widgetId: ctx.id, options,
      onLocalChange: () => syncController?.scheduleLocalSync(), onStop: ctx.onStop,
      migrate: legacyMigrator ? (info) => legacyMigrator.migrateStore(info) : null,
    }),
    files: {
      open: (descriptor) => {
        const { handle, close } = openFileStore(syncController?.manager || null, ctx.id, descriptor, {
          onLocalChange: () => syncController?.scheduleLocalSync(),
          migrate: legacyMigrator ? (info) => legacyMigrator.migrateFiles(info) : null,
        });
        ctx.onStop(close);
        return handle;
      },
    },
    secrets: {
      open: (name = 'secrets') => {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid secret store name');
        return openSecrets({ file: path.join(ctx.dataDir, `${name}.json`) });
      },
    },
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
      untilStop(win);
      return win;
    },
    createWidgetWindow: (opts) => untilStop(createWidgetWindow(opts)),
    // The same window in one renderer process shared by this widget's shared windows (#109): resolves to the window.
    // If that process crashes, each window's webContents gets 'render-process-gone' and the widget reopens it.
    createSharedWidgetWindow: async (opts) => {
      if (!windowGroup) {
        windowGroup = new WindowGroup({ name: ctx.id });
        ctx.onStop(() => {
          windowGroup.destroy();
          windowGroup = null;
        });
      }
      return untilStop(await createSharedWidgetWindow(windowGroup, opts));
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
ipcMain.handle('engine:sync-get', (event) => {
  managerSender(event);
  return syncController.state();
});
ipcMain.handle('engine:sync-pick-folder', async (event) => {
  managerSender(event);
  const result = await dialog.showOpenDialog(managerWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0] || null;
});
ipcMain.handle('engine:sync-create-folder', (event, root) => {
  managerSender(event);
  return syncController.createFolderInRoot(root);
});
ipcMain.handle('engine:sync-preview-connect', (event, values) => {
  managerSender(event);
  return syncController.previewConnect(values);
});
ipcMain.handle('engine:sync-apply-connect', (event, decision) => {
  managerSender(event);
  return syncController.applyConnect(decision);
});
ipcMain.handle('engine:sync-now', (event) => {
  managerSender(event);
  return syncController.syncNow();
});
ipcMain.handle('engine:sync-resolve', (event, decision) => {
  managerSender(event);
  return syncController.resolve(decision);
});
ipcMain.handle('engine:sync-configure', (event, values) => {
  managerSender(event);
  return syncController.configure(values);
});
ipcMain.handle('engine:sync-disable', (event) => {
  managerSender(event);
  return syncController.disable();
});
ipcMain.handle('engine:sync-undo-list', (event) => {
  managerSender(event);
  return syncController.listUndo();
});
ipcMain.handle('engine:sync-undo', (event, decision) => {
  managerSender(event);
  return syncController.undo(decision);
});
ipcMain.handle('engine:check-updates', async (event) => {
  managerSender(event);
  return updates.check({ manual: true });
});
ipcMain.handle('engine:install-update', async (event, id) => {
  managerSender(event);
  return updates.install(String(id));
});
ipcMain.handle('engine:picker-load', async (event) => {
  managerSender(event);
  return picker.load();
});
ipcMain.handle('engine:picker-start', async (event, ids) => {
  managerSender(event);
  picker.start(Array.isArray(ids) ? ids.map(String) : []);
  return picker.snapshot();
});
ipcMain.handle('engine:picker-retry', async (event, id) => {
  managerSender(event);
  picker.retry(String(id));
  return picker.snapshot();
});
ipcMain.handle('engine:picker-skip', (event, id) => {
  managerSender(event);
  picker.skip(String(id));
  return picker.snapshot();
});
ipcMain.handle('engine:picker-open-file', async (event) => {
  managerSender(event);
  return picker.openLocalInstaller();
});
ipcMain.handle('engine:picker-open-site', (event) => {
  managerSender(event);
  return shell.openExternal('https://widgets.chilgong88.com');
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
  // Reads what a 1.1.3-test build recorded before the controller rewrites the sync config (design 10.5).
  legacyMigrator = createLegacyMigrator({ syncDir: path.join(app.getPath('userData'), 'sync') });
  syncController = createSyncController({
    userData: app.getPath('userData'), widgetList: () => widgets?.list() || [], locale: () => app.getLocale(),
    secretGuard: containsSecret, extraWarnings: () => legacyMigrator.warnings(),
    forbiddenDirs: () => {
      const notes = ['memo', 'todonote'].map((id) => {
        const saved = path.join(app.getPath('userData'), 'widgets', id, 'settings.json');
        try { return JSON.parse(fs.readFileSync(saved, 'utf8')).notesDir || path.join(app.getPath('documents'), 'Desk Widgets', id === 'memo' ? '스티키 노트' : '할 일 노트'); }
        catch { return path.join(app.getPath('documents'), 'Desk Widgets', id === 'memo' ? '스티키 노트' : '할 일 노트'); }
      });
      return [widgetsDir(), ...notes];
    },
    onChanged: (state) => {
      if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send('engine:sync-changed', state);
      refreshTray();
    },
  });
  const engineShared = ['idleMinutes', 'notifyDurationSec', 'notifyMaxVisible'];
  // Like widget settings: a value still at its default is not exported, a removed one means "back to default".
  syncController.manager.register({
    name: 'engine',
    read: () => Object.fromEntries(engineShared.filter((field) => settings.load()[field] !== settings.DEFAULTS[field])
      .map((field) => [`engine/@settings/${field}`, settings.load()[field]])),
    apply: async (changes) => {
      const patch = {};
      for (const change of changes) {
        const field = change.key.slice('engine/@settings/'.length);
        if (!change.key.startsWith('engine/@settings/') || !engineShared.includes(field)) continue;
        patch[field] = change.deleted ? settings.DEFAULTS[field] : change.value;
      }
      if (Object.keys(patch).length) settings.save(patch);
    },
  });

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

  startUpdates();
  createTray();
  if (flags.widgetInstalled) await reloadWidgets({ installed: flags.widgetInstalled });
  else await widgets.sync();
  syncController.start();
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
    if (reason) syncController.stop();
    else syncController.start();
  });
  presence.start();

  // Keep the Windows startup entry in step with the setting and the current exe location
  // (reinstalling into another folder would otherwise leave a stale path behind).
  applyLoginItem(settings.load());

  if (flags.sampleCard) showSampleCards();
  // #96: the widget picker opens by itself only when no widget is installed, and only that one time.
  pickerAutoOpen = !flags.mockData && !settings.load().onboardingDone && !widgets.list().length;
  if (pickerAutoOpen) settings.save({ onboardingDone: true });
  if (flags.settings || !widgets.list().length) openManager();
  openSetupFor(widgets.running().map((r) => r.manifest.id));
});

app.on('before-quit', () => {
  syncController?.stop();
  notifications?.stop();
  updateScheduler?.stop();
  watcher?.stop();
  desktopAnchor?.releaseAll();
  widgets?.stopAll();
});

// The tray keeps the engine alive with no window open (all widgets off, or none installed).
app.on('window-all-closed', () => {});
