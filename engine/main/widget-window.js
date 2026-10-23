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
function createWidgetWindow({ html, preload, size, getBounds, saveBounds, transparent = true }) {
  const win = new BrowserWindow({
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
  });
  let timer = null;
  const saveLater = () => {
    clearTimeout(timer);
    timer = setTimeout(() => !win.isDestroyed() && saveBounds(win.getBounds()), 500);
  };
  win.on('moved', saveLater);
  win.on('resized', saveLater);
  win.on('closed', () => clearTimeout(timer));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.showInactive());
  win.loadFile(html);
  return win;
}

module.exports = { createWidgetWindow, placeWindow };
