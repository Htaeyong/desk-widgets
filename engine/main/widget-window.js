// A plain desktop widget window: frameless, off the taskbar, remembers its position.
// For widgets that draw their own app-owned page instead of using themes (e.g. the clock).
const { BrowserWindow, screen } = require('electron');

const MARGIN = 24;

/** Saved bounds if still visible on a connected display, else the top-right corner of the primary display. */
function placeWindow(saved, size, displays = { matching: (b) => screen.getDisplayMatching(b), primary: () => screen.getPrimaryDisplay() }) {
  if (saved && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(saved[k]))) {
    const wa = displays.matching(saved).workArea;
    const visible = saved.x < wa.x + wa.width - 40 && saved.x + saved.width > wa.x + 40 && saved.y >= wa.y - 10 && saved.y < wa.y + wa.height - 40;
    if (visible) return saved;
  }
  const wa = displays.primary().workArea;
  return { width: size.width, height: size.height, x: wa.x + wa.width - size.width - MARGIN, y: wa.y + wa.height - size.height - MARGIN * 3 };
}

/**
 * @param {{ html: string, preload?: string, size: { width, height, minWidth?, minHeight? },
 *           getBounds: () => object | null, saveBounds: (bounds) => void, transparent?: boolean }} opts
 */
function widgetWindowOptions({ preload, size, getBounds, transparent = true }) {
  return {
    ...placeWindow(getBounds(), size),
    minWidth: size.minWidth || 80,
    minHeight: size.minHeight || 40,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#1b1d22',
    resizable: true,
    skipTaskbar: true,
    hasShadow: !transparent,
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  };
}

/**
 * Remembers the window's position, keeps it on its page, shows it without taking the focus once loaded.
 * A grouped window is kept on its page by its group (its first navigation passes there).
 */
function wireWidgetWindow(win, { saveBounds }, { grouped = false } = {}) {
  let timer = null;
  const saveLater = () => {
    clearTimeout(timer);
    timer = setTimeout(() => !win.isDestroyed() && saveBounds(win.getBounds()), 500);
  };
  win.on('moved', saveLater);
  win.on('resized', saveLater);
  win.on('closed', () => clearTimeout(timer));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (!grouped) win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function createWidgetWindow(opts) {
  const win = new BrowserWindow(widgetWindowOptions(opts));
  wireWidgetWindow(win, opts);
  win.loadFile(opts.html);
  return win;
}

/**
 * The same window, opened in a window group (#109): it shares one renderer process with the group's other windows.
 * @param {import('./window-group').WindowGroup} group
 * @returns {Promise<BrowserWindow>}
 */
async function createSharedWidgetWindow(group, opts) {
  const win = await group.open(opts.html, { options: widgetWindowOptions(opts) });
  return wireWidgetWindow(win, opts, { grouped: true });
}

module.exports = { createWidgetWindow, createSharedWidgetWindow, placeWindow };
