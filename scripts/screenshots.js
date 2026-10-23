// Dev-only: renders the README screenshots (#98) from fictional data. Not part of the product.
//   npx electron scripts/screenshots.js [--out <folder>] [--list]
// Starts the engine from this repository with --mock-data and a throw-away data folder (a fresh temp folder,
// never the real settings), seeds fake content for the widgets that have no mock mode (todo, memo, clock),
// captures each widget window with webContents.capturePage (the app's own windows only, alpha kept) and
// composes the hero image in an offscreen window. --list prints the windows found instead of capturing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, dialog, screen } = require('electron');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = path.resolve(argValue('--out') || path.join(ROOT, 'docs', 'images'));
const LIST_ONLY = argv.includes('--list');
const HERO = argv.includes('--hero');
const ONLY = argValue('--scenario') || (process.argv.find((a) => a.startsWith('--scenario=')) || '').slice(11) || undefined;

// What each run shows. themes: widget id -> theme id (the default theme when missing); settings: widget id -> extra
// settings (an object, or a function called while seeding for values that depend on the time); shots: widgets to capture.
// The clock is one window per run, so every clock look (#102) is a scenario of its own.
// A widget "match" is found by its window url; size resizes the window first (the theme's own size otherwise).
const SCENARIOS = {
  main: {
    themes: {},
    shots: [
      { file: 'dooray', widget: 'dooray', size: [380, 540] },
      { file: 'calendar', widget: 'calendar' },
      { file: 'mail', widget: 'mail', size: [580, 520] },
      { file: 'clock', widget: 'clock' },
      { file: 'system-monitor', widget: 'system-monitor', size: [380, 620] },
      { file: 'todo', widget: 'todo' },
      // Several windows of one widget: told apart by their text (one file name each).
      { widget: 'memo', pick: { '회의 메모': 'memo-meeting', 장보기: 'memo-shopping', 아이디어: 'memo-ideas' } },
      { widget: 'card', pick: { '할 일 알림': 'card-todo', 메일: 'card-mail' } },
    ],
  },
  alt: {
    themes: { mail: 'dashboard', clock: 'light', dooray: 'paper' },
    shots: [
      { file: 'dooray-paper', widget: 'dooray', size: [380, 540] },
      { file: 'mail-dashboard', widget: 'mail' },
      { file: 'clock-light', widget: 'clock' },
    ],
  },
  // Clock: seconds on + 12-hour, neon, analog with a second hand, stopwatch/timer tabs (timer running), alarm tab.
  'clock-12h': { themes: {}, settings: { clock: { showSeconds: true, hour12: true } }, shots: [{ file: 'clock-seconds-12h', widget: 'clock', size: [260, 96] }] },
  'clock-neon': { themes: { clock: 'neon' }, settings: { clock: { showSeconds: true } }, shots: [{ file: 'clock-neon', widget: 'clock' }] },
  'clock-analog': { themes: { clock: 'analog' }, settings: { clock: { showSeconds: true } }, shots: [{ file: 'clock-analog', widget: 'clock' }] },
  'clock-timer': {
    themes: {},
    settings: { clock: () => ({ tools: true, lastTab: 'timer', timer: { duration: 600000, startedAt: Date.now() - 197000, elapsed: 0, done: false } }) },
    shots: [{ file: 'clock-timer', widget: 'clock' }],
  },
  'clock-alarm': {
    themes: { clock: 'light' },
    settings: {
      clock: () => ({
        tools: true,
        lastTab: 'alarm',
        alarms: [
          { id: 'a1', hour: 7, minute: 30, name: '기상', days: [1, 2, 3, 4, 5], on: true, snoozeUntil: null, since: Date.now() },
          { id: 'a2', hour: 12, minute: 0, name: '점심', days: [1, 2, 3, 4, 5], on: true, snoozeUntil: null, since: Date.now() },
          { id: 'a3', hour: 18, minute: 30, name: '운동', days: [], on: false, snoozeUntil: null, since: Date.now() },
        ],
      }),
    },
    shots: [{ file: 'clock-alarm', widget: 'clock' }],
  },
  // Other widgets: features the main shots do not show.
  'monitor-ocean': { themes: { 'system-monitor': 'ocean' }, settings: { 'system-monitor': { showCores: true } }, shots: [{ file: 'system-monitor-ocean', widget: 'system-monitor', size: [380, 620] }] },
  'mail-compact': { themes: { mail: 'compact' }, shots: [{ file: 'mail-compact', widget: 'mail' }] },
};
const scenarioNames = ONLY ? [ONLY] : Object.keys(SCENARIOS);

/** The download page shows the images listed in site/public/showcase.json: keeps its img folder in step (#102). */
function copyShowcaseImages() {
  const siteDir = path.join(ROOT, 'site', 'public');
  const showcase = JSON.parse(fs.readFileSync(path.join(siteDir, 'showcase.json'), 'utf8'));
  const files = new Set(Object.values(showcase).flatMap((w) => (w.images || []).map((i) => path.basename(i.src))));
  fs.mkdirSync(path.join(siteDir, 'img'), { recursive: true });
  for (const file of files) if (fs.existsSync(path.join(OUT, file))) fs.copyFileSync(path.join(OUT, file), path.join(siteDir, "img", file));
  console.log(`site/public/img: ${files.size} images copied`);
}

// Without its own data folder this process starts a copy of itself that has one, so nothing can reach the
// real settings of the installed app or of a development run.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-widgets-shots-'));
  let status = 0;
  for (const name of LIST_ONLY ? ['main'] : scenarioNames) {
    const dir = path.join(tmp, name);
    const run = spawnSync(process.execPath, [__filename, `--user-data-dir=${path.join(dir, 'data')}`, `--scenario=${name}`, ...argv], { stdio: 'inherit' });
    if (run.status) status = run.status;
  }
  if (!LIST_ONLY && !ONLY && !status) {
    const run = spawnSync(process.execPath, [__filename, `--user-data-dir=${path.join(tmp, 'hero', 'data')}`, '--hero', ...argv], { stdio: 'inherit' });
    if (run.status) status = run.status;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!LIST_ONLY && !ONLY && !status) copyShowcaseImages();
  process.exit(status);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = 86400000;

// ---- fictional content ----

const widgetDir = (dataDir, id) => path.join(dataDir, 'widgets', id);
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** Settings each widget starts with: theme choices, fake todo list, fake notes. */
function seed(dataDir, notesDir, themes, extra = {}) {
  const ids = ['dooray', 'calendar', 'mail', 'clock', 'system-monitor', 'todo', 'memo'];
  writeJson(path.join(dataDir, 'settings.json'), {
    desktopMode: 'off',
    idleMinutes: 0,
    widgets: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
  });
  const at = (days, h, m) => {
    const d = new Date(Date.now() + days * DAY);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const task = (id, title, extra = {}) => ({ id, listId: 'inbox', title, dueAt: null, dateOnly: false, repeatWeekday: null, completedAt: null, remindedFor: null, snoozedUntil: null, createdAt: Date.now() - DAY, source: null, ...extra });
  writeJson(path.join(widgetDir(dataDir, 'todo'), 'settings.json'), {
    themeId: 'default',
    tasks: [
      task('t1', '분기 보고서 초안 작성', { dueAt: at(0, 15, 0) }),
      task('t2', '디자인 시안 검토', { dueAt: at(1, 0, 0), dateOnly: true }),
      task('t3', '팀 회식 장소 예약', { dueAt: at(2, 0, 0), dateOnly: true }),
      task('t4', '주간 회의 자료 정리', { dueAt: at(3, 10, 30) }),
      task('t5', '운동하기', { dueAt: at(1, 19, 0), repeatWeekday: new Date(at(1, 19, 0)).getDay() }),
      task('t6', '도서관 책 반납', { completedAt: Date.now() - 3600000 }),
      task('t7', '청구서 확인', { completedAt: Date.now() - 7200000 }),
    ],
  });
  fs.mkdirSync(notesDir, { recursive: true });
  const notes = [
    ['t0000001', '회의 메모', 'yellow', '## 주간 회의\n\n- 일정 공유\n- **금요일**까지 시안 확정\n- 다음 회의: 월요일 10시\n'],
    ['t0000002', '장보기', 'green', '- [ ] 우유\n- [x] 달걀\n- [ ] 사과\n- [ ] 커피 원두\n'],
    ['t0000003', '아이디어', 'pink', '### 위젯 아이디어\n\n바탕화면에 *한눈에* 보이는 일정 요약.\n\n1. 오늘 할 일\n2. 다가오는 일정\n'],
  ];
  const memos = {};
  notes.forEach(([id, title, color, body], i) => {
    fs.writeFileSync(path.join(notesDir, `${title}.md`), `---\ndesk-widgets-memo: ${id}\n---\n${body}`, 'utf8');
    memos[id] = { color, open: true, bounds: { x: 80 + i * 40, y: 80 + i * 40, width: 260, height: 240 } };
  });
  writeJson(path.join(widgetDir(dataDir, 'memo'), 'settings.json'), { notesDir, folderMigrated: true, listOpen: false, memos });
  writeJson(path.join(widgetDir(dataDir, 'clock'), 'settings.json'), { themeId: 'dark-glass', showSeconds: false });
  for (const [id, themeId] of Object.entries(themes)) {
    const file = path.join(widgetDir(dataDir, id), 'settings.json');
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* no seed for this widget */ }
    writeJson(file, { ...current, themeId });
  }
  for (const [id, values] of Object.entries(extra)) {
    const file = path.join(widgetDir(dataDir, id), 'settings.json');
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* no seed for this widget */ }
    writeJson(file, { ...current, ...(typeof values === 'function' ? values() : values) });
  }
}

// ---- hero image: widget shots on a generated wallpaper, drawn in an offscreen window ----

const HERO_SIZE = { width: 2120, height: 1000 };
// file, x, y (the shots are drawn at their own size; later entries are on top)
const HERO_LAYOUT = [
  ['dooray', 30, 60],
  ['calendar', 425, 60],
  ['clock', 425, 560],
  ['mail', 740, 70],
  ['todo', 1335, 40],
  ['system-monitor', 1710, 60],
  ['memo-meeting', 760, 650],
  ['memo-shopping', 1040, 650],
  ['card-todo', 1750, 850],
];

function heroHtml() {
  const shots = HERO_LAYOUT.map(([file, x, y]) => {
    const data = fs.readFileSync(path.join(OUT, `${file}.png`)).toString('base64');
    return `<img style="left:${x}px;top:${y}px" src="data:image/png;base64,${data}">`;
  }).join('');
  // A generated abstract wallpaper (gradients only), so no third-party image is involved.
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${HERO_SIZE.width}px; height: ${HERO_SIZE.height}px; overflow: hidden; }
    body {
      background:
        radial-gradient(900px 600px at 15% 10%, rgba(110, 140, 255, .55), transparent 70%),
        radial-gradient(800px 700px at 90% 85%, rgba(255, 130, 110, .5), transparent 70%),
        radial-gradient(700px 500px at 60% 40%, rgba(150, 90, 200, .45), transparent 70%),
        linear-gradient(135deg, #16213e 0%, #2b2d5e 45%, #4a3470 100%);
    }
    img { position: absolute; filter: drop-shadow(0 14px 26px rgba(0, 0, 0, .38)); }
  </style>${shots}`;
}

async function renderHero() {
  await app.whenReady();
  const win = new BrowserWindow({ width: HERO_SIZE.width, height: HERO_SIZE.height, useContentSize: true, show: false, frame: false, webPreferences: { offscreen: true, sandbox: true } });
  await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(heroHtml()).toString('base64')}`);
  await sleep(800);
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.writeFileSync(path.join(OUT, 'hero.png'), png);
  console.log(`hero.png ${image.getSize().width}x${image.getSize().height} ${(png.length / 1024).toFixed(0)} KB`);
}

const windows = new Set();
const scenarioName = ONLY || 'main';

const OFFSCREEN = 12000; // the capture windows live this far left of the screen: nothing appears on the desktop

/** Keeps a window off the visible desktop, whoever moves it later (widget code, notification stacking). */
function keepOffscreen(win) {
  const shift = (x) => (Number.isFinite(x) && x > -OFFSCREEN / 2 ? x - OFFSCREEN : x);
  const setBounds = win.setBounds.bind(win);
  const setPosition = win.setPosition.bind(win);
  win.setBounds = (b, animate) => setBounds({ ...b, x: shift(b.x) }, animate);
  win.setPosition = (x, y, animate) => setPosition(shift(x), y, animate);
  win.setPosition(win.getPosition()[0], win.getPosition()[1]);
}

/** Fixed, round numbers for the system monitor (this PC's real sizes stay out of the pictures). */
function fakeSystemMetrics() {
  const { SystemMetrics } = require('../engine/main/system-metrics.js');
  const GB = 1024 ** 3;
  const wave = (i) => 22 + 9 * Math.sin(i / 3) + 5 * Math.sin(i / 1.3 + 1) + (i > 22 ? 0 : 0);
  SystemMetrics.prototype.read = function read() {
    const now = Date.now();
    const history = Array.from({ length: 30 }, (_, i) => ({ at: now - (29 - i) * 2000, percent: Math.max(4, wave(i)) }));
    history[29].percent = 23;
    return {
      at: now,
      intervalMs: this.intervalMs,
      cpu: { percent: 23, cores: [18, 31, 22, 25, 15, 28, 20, 24], history },
      memory: { total: 32 * GB, free: 20.8 * GB, used: 11.2 * GB, percent: 35 },
      disks: [
        { drive: 'C:\\', total: 512 * GB, free: 298 * GB, used: 214 * GB, percent: 41.8 },
        { drive: 'D:\\', total: 2048 * GB, free: 1168 * GB, used: 880 * GB, percent: 43 },
      ],
      diskIo: { readBytesPerSec: 2.4 * 1024 * 1024, writeBytesPerSec: 640 * 1024 },
      network: { downBytesPerSec: 1.8 * 1024 * 1024, upBytesPerSec: 210 * 1024 },
      gpu: { percent: 12 },
      battery: { percent: 82, charging: true },
      uptimeSeconds: 3 * 86400 + 4 * 3600 + 25 * 60,
    };
  };
}

/** The mail mock keeps an account in an error state for development; the pictures show five healthy accounts. */
function dropMockErrorAccount() {
  const { MOCK_ACCOUNTS } = require('../widgets/mail/lib/mock.js');
  for (let i = MOCK_ACCOUNTS.length - 1; i >= 0; i--) if (MOCK_ACCOUNTS[i].mockError || MOCK_ACCOUNTS[i].id === 'mock-shop') MOCK_ACCOUNTS.splice(i, 1);
}

/** Starts the engine with a throw-away data folder (main.js appends -mock to it for --mock-data). */
function bootEngine() {
  const dataDir = `${app.commandLine.getSwitchValue('user-data-dir')}-mock`;
  seed(dataDir, path.join(path.dirname(dataDir), 'notes'), SCENARIOS[scenarioName].themes, SCENARIOS[scenarioName].settings);
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  fakeSystemMetrics();
  dropMockErrorAccount();
  process.argv.push('--mock-data');
  app.on('browser-window-created', (_event, win) => {
    windows.add(win);
    keepOffscreen(win);
  });
  require('../engine/main/main.js');
}

// ---- capturing the widget windows ----

const urlOf = (win) => win.webContents.getURL();

/** Visible windows of one widget (the notification cards and memo notes are told apart by their page). */
function windowsOf(widget) {
  const live = [...windows].filter((w) => !w.isDestroyed() && w.isVisible());
  if (widget === 'dooray') return live.filter((w) => urlOf(w).startsWith('dooray-theme://'));
  if (widget === 'card') return live.filter((w) => /renderer\/notification/.test(urlOf(w)));
  if (widget === 'memo') return live.filter((w) => /memo\/memo\.html/.test(urlOf(w)));
  return live.filter((w) => urlOf(w).startsWith('widget-theme://') && urlOf(w).includes(`.${widget}/`));
}

async function capture(win, file, size) {
  if (size) win.setBounds({ ...win.getBounds(), width: size[0], height: size[1] });
  await sleep(900);
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${file}.png`), png);
  const dim = image.getSize();
  console.log(`${file}.png ${dim.width}x${dim.height} ${(png.length / 1024).toFixed(0)} KB`);
}

async function shoot() {
  await app.whenReady();
  await sleep(15000); // the engine starts, mock data loads, the new-mail and reminder cards appear
  if (LIST_ONLY) {
    console.log('workArea', JSON.stringify(screen.getPrimaryDisplay().workArea));
    for (const win of windows) if (!win.isDestroyed()) console.log(JSON.stringify({ url: urlOf(win), bounds: win.getBounds() }));
    return;
  }
  for (const shot of SCENARIOS[scenarioName].shots) {
    // A theme with its own page can swap the window right after start (the old one is destroyed): look again.
    for (let attempt = 0; ; attempt++) {
      try {
        const found = windowsOf(shot.widget);
        if (!found.length) throw new Error(`no window for ${shot.widget}`);
        for (const win of found) {
          let file = shot.file;
          if (shot.pick) {
            const text = await win.webContents.executeJavaScript('document.body.innerText');
            file = Object.entries(shot.pick).find(([needle]) => text.includes(needle))?.[1];
            if (!file) continue;
          }
          await capture(win, file, shot.size);
        }
        break;
      } catch (err) {
        if (attempt >= 3 || !/destroyed|no window/.test(String(err))) throw err;
        await sleep(2000);
      }
    }
  }
}

// Errors go to stderr with an exit code, never to Electron's error dialog on the desktop.
dialog.showErrorBox = () => {};
const fail = (err) => {
  console.error(err);
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const run = HERO ? renderHero : () => (bootEngine(), shoot());
run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => app.exit(process.exitCode || 0), 300));
