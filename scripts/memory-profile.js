// Dev-only: measures the memory of the engine with every widget running (#107). Not part of the product.
//   npx electron scripts/memory-profile.js [--out <file.json>] [--quick] [--notes N] [--cards N] [--crash-check]
// Starts the engine from this repository with --mock-data and a throw-away data folder (like scripts/screenshots.js:
// fictional content, windows 12000 px left of the screen, dialogs suppressed), then reads app.getAppMetrics() and
// the Windows "private working set" (what Task Manager shows) of every process: at startup, after 2 and 10 minutes,
// with the widget manager and one widget settings window open, and after closing them again.
// --quick shortens the waits (script testing only); --switch name[=value] adds a Chromium switch (experiments).
// --notes N opens N sticky notes (default 3); --cards N puts N sticky generic cards on screen at start (#109).
// --crash-check (#109) crashes the notes' and the cards' renderer once after the first reading and checks that every
// window comes back (new process, page loaded); the result is printed and saved with the readings. The readings go to --out (JSON) and a summary to stdout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, BrowserWindow, dialog, webContents } = require('electron');
const { hideTray, runChild, finish } = require('./dev-run');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argValue = (name) => {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = path.resolve(argValue('--out') || path.join(os.tmpdir(), 'desk-widgets-memory.json'));
const QUICK = argv.includes('--quick');
const NOTES = Math.max(0, Number(argValue('--notes') ?? 3) || 0);
const CARDS = Math.max(0, Number(argValue('--cards') ?? 0) || 0);
const CRASH_CHECK = argv.includes('--crash-check');
// #109: a run always ends: the engine quits after this long whatever happens, and the parent kills the child's
// process tree a minute later. No tray icon appears (dev-run.js hideTray).
const LIMIT_MS = (QUICK ? 4 : 16) * 60000;
const IS_PARENT = !app.commandLine.hasSwitch('user-data-dir');

// Without its own data folder this process starts a copy of itself that has one, so nothing can reach the
// real settings of the installed app or of a development run.
if (IS_PARENT) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-widgets-memory-'));
  runChild(process.execPath, [__filename, `--user-data-dir=${path.join(tmp, 'data')}`, ...argv], { limitMs: LIMIT_MS + 60000 }).then((status) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(status);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN = 60000;
const DAY = 86400000;
const OFFSCREEN = 12000;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** Every widget on with its default theme, a short todo list and three open sticky notes. */
function seed(dataDir, notesDir) {
  const ids = ['dooray', 'calendar', 'mail', 'clock', 'system-monitor', 'todo', 'memo'];
  writeJson(path.join(dataDir, 'settings.json'), { desktopMode: 'off', idleMinutes: 0, widgets: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) });
  const task = (id, title, extra = {}) => ({ id, listId: 'inbox', title, dueAt: null, dateOnly: false, repeatWeekday: null, completedAt: null, remindedFor: null, snoozedUntil: null, createdAt: Date.now() - DAY, source: null, ...extra });
  writeJson(path.join(dataDir, 'widgets', 'todo', 'settings.json'), {
    themeId: 'default',
    tasks: [task('t1', '보고서 초안', { dueAt: Date.now() + 3 * 3600000 }), task('t2', '시안 검토', { dueAt: Date.now() + DAY }), task('t3', '책 반납', { completedAt: Date.now() - 3600000 })],
  });
  fs.mkdirSync(notesDir, { recursive: true });
  const memos = {};
  const colors = ['yellow', 'green', 'pink', 'blue', 'purple', 'orange', 'gray'];
  const notes = Array.from({ length: NOTES }, (_, i) => [`m${String(i + 1).padStart(7, '0')}`, `노트 ${i + 1}`, colors[i % colors.length]]);
  notes.forEach(([id, title, color], i) => {
    fs.writeFileSync(path.join(notesDir, `${title}.md`), `---\ndesk-widgets-memo: ${id}\n---\n## ${title}\n\n- 첫째\n- **둘째**\n`, 'utf8');
    memos[id] = { color, open: true, bounds: { x: 80 + (i % 10) * 40, y: 80 + (i % 10) * 30, width: 260, height: 240 } };
  });
  writeJson(path.join(dataDir, 'widgets', 'memo', 'settings.json'), { notesDir, folderMigrated: true, listOpen: false, memos });
}

/** Keeps a window off the visible desktop, whoever moves it later (widget code, notification stacking). */
function keepOffscreen(win) {
  const shift = (x) => (Number.isFinite(x) && x > -OFFSCREEN / 2 ? x - OFFSCREEN : x);
  const setBounds = win.setBounds.bind(win);
  const setPosition = win.setPosition.bind(win);
  win.setBounds = (b, animate) => setBounds({ ...b, x: shift(b.x) }, animate);
  win.setPosition = (x, y, animate) => setPosition(shift(x), y, animate);
  win.setPosition(win.getPosition()[0], win.getPosition()[1]);
}

const windows = new Set();
let notificationCenter = null;

/** Starts the engine with a throw-away data folder (main.js appends -mock to it for --mock-data). */
function bootEngine() {
  hideTray();
  const dataDir = `${app.commandLine.getSwitchValue('user-data-dir')}-mock`;
  seed(dataDir, path.join(path.dirname(dataDir), 'notes'));
  // Offscreen windows would count as covered: Chromium would background them and the engine would pause the
  // system monitor. These keep them behaving like windows on a visible desktop.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  // --switch name[=value] (repeatable): try a Chromium switch, e.g. renderer-process-limit=1 or js-flags=--lite-mode.
  argv.forEach((a, i) => {
    const spec = a === '--switch' ? argv[i + 1] : a.startsWith('--switch=') ? a.slice(9) : null;
    if (!spec) return;
    const [name, ...value] = spec.split('=');
    app.commandLine.appendSwitch(name, value.join('='));
    console.log(`switch: ${name}${value.length ? `=${value.join('=')}` : ''}`);
  });
  // The engine's notification center, to put cards on screen (--cards).
  const { NotificationCenter } = require('../engine/main/notifications.js');
  const registerIpc = NotificationCenter.prototype.registerIpc;
  NotificationCenter.prototype.registerIpc = function capture() {
    notificationCenter = this;
    return registerIpc.call(this);
  };
  const { WindowOcclusion } = require('../engine/main/window-occlusion.js');
  WindowOcclusion.prototype.isCovered = () => false;
  process.argv.push('--mock-data');
  app.on('browser-window-created', (_event, win) => {
    windows.add(win);
    keepOffscreen(win);
    // The manager and settings windows must not take the keyboard focus from what the user is doing.
    win.show = win.showInactive.bind(win);
    win.focus = () => {};
  });
  require('../engine/main/main.js');
}

// ---- readings ----

/** What a page is, from its url: the widget id (or engine page) it belongs to. */
function ownerOf(url) {
  let m;
  if ((m = /^widget-theme:\/\/[^/]*?\.([a-z0-9-]+)\//i.exec(url))) return `${m[1]} (theme)`;
  if (url.startsWith('dooray-theme://')) return 'dooray (theme)';
  if ((m = /\/widgets\/([a-z0-9-]+)\/([^?#]*)/i.exec(url.replace(/\\/g, '/')))) return `${m[1]} (${path.basename(m[2])})`;
  if ((m = /\/engine\/renderer\/([a-z-]+)\.html/.exec(url))) return { settings: 'engine: widget manager', 'widget-settings': 'engine: widget settings', notification: 'engine: notification card', preview: 'engine: theme preview' }[m[1]] || `engine: ${m[1]}`;
  return url.slice(0, 60) || '(blank)';
}

/** Windows' own per-process counters (Task Manager's "Memory" column is the private working set). */
function windowsCounters(pids) {
  const script = 'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,WorkingSetPrivate,WorkingSet,PrivateBytes | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({});
      const rows = [].concat(JSON.parse(stdout || '[]'));
      resolve(Object.fromEntries(rows.filter((r) => pids.includes(r.IDProcess)).map((r) => [r.IDProcess, r])));
    });
  });
}

/** JS heap of a page (Chromium's performance.memory), null when it cannot be read. */
async function jsHeap(wc) {
  try {
    return await Promise.race([wc.executeJavaScript('performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null', true), sleep(2000).then(() => null)]);
  } catch {
    return null;
  }
}

const MB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

async function reading(label) {
  const metrics = app.getAppMetrics();
  const pages = [];
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    const win = BrowserWindow.fromWebContents(wc);
    pages.push({
      pid: wc.getOSProcessId(),
      owner: ownerOf(wc.getURL()),
      url: wc.getURL().slice(0, 120),
      type: wc.getType(),
      visible: win ? win.isVisible() : null,
      throttling: wc.getBackgroundThrottling(),
      heap: await jsHeap(wc),
    });
  }
  const counters = await windowsCounters(metrics.map((m) => m.pid));
  const processes = metrics.map((m) => {
    const c = counters[m.pid] || {};
    const own = pages.filter((p) => p.pid === m.pid);
    return {
      pid: m.pid,
      type: m.type,
      service: m.serviceName || m.name || '',
      owner: m.type === 'Browser' ? 'engine main process' : own.map((p) => p.owner).join(' + ') || m.serviceName || m.type,
      pages: own.length,
      workingSetMB: MB(m.memory.workingSetSize * 1024),
      privateBytesMB: MB((m.memory.privateBytes || 0) * 1024),
      privateWorkingSetMB: c.WorkingSetPrivate != null ? MB(Number(c.WorkingSetPrivate)) : null,
      cpuPercent: Number.isFinite(m.cpu.percentUsage) ? Math.round(m.cpu.percentUsage * 100) / 100 : null,
      cpuSeconds: m.cpu.cumulativeCPUUsage != null ? Math.round(m.cpu.cumulativeCPUUsage * 10) / 10 : null,
      idleWakeups: m.cpu.idleWakeupsPerSecond,
    };
  });
  const sum = (k) => Math.round(processes.reduce((a, p) => a + (p[k] || 0), 0) * 10) / 10;
  const main = process.memoryUsage();
  const result = {
    label,
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    totals: { processes: processes.length, windows: [...windows].filter((w) => !w.isDestroyed()).length, workingSetMB: sum('workingSetMB'), privateBytesMB: sum('privateBytesMB'), privateWorkingSetMB: sum('privateWorkingSetMB') },
    mainHeap: { rssMB: MB(main.rss), heapUsedMB: MB(main.heapUsed), heapTotalMB: MB(main.heapTotal), externalMB: MB(main.external) },
    processes,
    pages,
  };
  const t = result.totals;
  console.log(`\n== ${label} (${result.uptimeSec}s) — ${t.processes} processes, ${t.windows} windows, working set ${t.workingSetMB} MB, private ${t.privateBytesMB} MB, private working set ${t.privateWorkingSetMB} MB`);
  for (const p of [...processes].sort((a, b) => b.privateWorkingSetMB - a.privateWorkingSetMB)) {
    console.log(`  ${String(p.pid).padStart(6)} ${p.type.padEnd(8)} ws ${String(p.workingSetMB).padStart(6)}  priv ${String(p.privateBytesMB).padStart(6)}  pws ${String(p.privateWorkingSetMB).padStart(6)}  cpu ${String(p.cpuPercent).padStart(5)}%  ${p.owner}`);
  }
  return result;
}

// ---- crash check (#109) ----

const pageWindows = (re) => live().filter((w) => re.test(w.webContents.getURL()) && w.isVisible());

/** Crashes the renderer of one window of a kind and waits until as many windows of that kind are back and loaded. */
async function crashOne(label, re) {
  const before = pageWindows(re);
  if (!before.length) return { label, skipped: true };
  const pidsBefore = [...new Set(before.map((w) => w.webContents.getOSProcessId()))];
  before[0].webContents.forcefullyCrashRenderer();
  const deadline = Date.now() + 15000;
  let after = [];
  while (Date.now() < deadline) {
    await sleep(500);
    after = pageWindows(re).filter((w) => !w.webContents.isCrashed() && !w.webContents.isLoading());
    if (after.length >= before.length) break;
  }
  const texts = await Promise.all(after.map((w) => w.webContents.executeJavaScript('document.body.innerText.length', true).catch(() => 0)));
  const result = {
    label,
    before: before.length,
    after: after.length,
    pidsBefore,
    pidsAfter: [...new Set(after.map((w) => w.webContents.getOSProcessId()))],
    pagesWithText: texts.filter((n) => n > 0).length,
    ok: after.length === before.length && texts.every((n) => n > 0),
  };
  console.log(`crash check ${label}: ${JSON.stringify(result)}`);
  return result;
}

async function checkCrashRecovery() {
  return [await crashOne('sticky notes', /widgets\/memo\/memo\/memo\.html/), await crashOne('notification cards', /engine\/renderer\/notification\.html/)];
}

// ---- timeline ----

const live = () => [...windows].filter((w) => !w.isDestroyed());
const byUrl = (re) => live().find((w) => re.test(w.webContents.getURL()));

async function profile() {
  await app.whenReady();
  const wait = (ms) => sleep(QUICK ? Math.min(ms, 15000) : ms);
  const started = Date.now();
  const until = (ms) => wait(Math.max(0, ms - (Date.now() - started)));
  const readings = [];
  let crashCheck = null;
  const save = () => writeJson(OUT, { node: process.versions, electron: process.versions.electron, quick: QUICK, notes: NOTES, cards: CARDS, crashCheck, readings });

  await sleep(3000);
  if (CARDS && notificationCenter) {
    const cards = Array.from({ length: CARDS }, (_, i) => ({ type: 'card', title: `프로파일 카드 ${i + 1}`, body: '메모리 측정용 카드', icon: 'info', sticky: true }));
    notificationCenter.push(cards, { widget: { id: '_profile', name: '측정' } });
  }
  await sleep(17000); // the engine starts, widgets load their mock data, the first notification cards appear
  readings.push(await reading('startup (20 s)'));
  save();
  if (CRASH_CHECK) {
    crashCheck = await checkCrashRecovery();
    save();
  }
  await until(2 * MIN);
  readings.push(await reading('2 min'));
  save();
  await until(10 * MIN);
  readings.push(await reading('10 min'));
  save();

  // The widget manager (a second launch with --settings opens it), then one widget's settings from inside it.
  app.emit('second-instance', {}, [process.execPath, '--settings'], process.cwd());
  await sleep(8000);
  readings.push(await reading('widget manager open'));
  const manager = byUrl(/engine\/renderer\/settings\.html/);
  if (manager) await manager.webContents.executeJavaScript("window.engineApi.openWidgetSettings('dooray')");
  await sleep(8000);
  readings.push(await reading('manager + dooray settings open'));
  save();

  for (const w of live()) if (/engine\/renderer\/(settings|widget-settings)\.html/.test(w.webContents.getURL())) w.close();
  await sleep(10000);
  readings.push(await reading('manager + settings closed (10 s)'));
  await wait(60000);
  readings.push(await reading('manager + settings closed (70 s)'));
  save();
  console.log(`\nReadings: ${OUT}`);
}

// Errors go to stderr with an exit code, never to a dialog on the desktop.
dialog.showErrorBox = () => {};
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
const fail = (err) => {
  console.error(err);
  app.exit(1);
};

/** Before quitting: an engine before #109 gave waiting cards new windows while quitting and never ended. */
function quitCards() {
  if (!notificationCenter) return;
  if (typeof notificationCenter.stop === 'function') notificationCenter.stop();
  else notificationCenter.waiting.length = 0;
}

if (!IS_PARENT) {
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  setTimeout(() => {
    console.error(`memory profile: time limit (${LIMIT_MS / 60000} min) reached, quitting`);
    quitCards();
    finish(app, 2, 5000);
  }, LIMIT_MS).unref();
  bootEngine();
  profile()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => {
      quitCards();
      finish(app, process.exitCode || 0);
    });
}
