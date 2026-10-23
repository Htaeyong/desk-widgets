// Theme preview: an app window whose top bar names the theme (prev / next / use it) and whose
// lower part runs the theme itself, isolated like a widget, on the user's own data.
const path = require('path');
const { BrowserWindow, WebContentsView, screen } = require('electron');

const BAR_HEIGHT = 64;
const PAD = 20;

class ThemePreview {
  /**
   * @param {{ windows: import('./windows').ThemeWindows, getCurrentThemeId: () => string,
   *           onApply: (themeId: string) => void, rendererDir: string }} opts
   *   The preview runs the widget's main frame (Dooray: overview) with the widget's own registry and preload.
   */
  constructor({ windows, getCurrentThemeId, onApply, rendererDir }) {
    this.windows = windows;
    this.registry = windows.registry;
    this.getCurrentThemeId = getCurrentThemeId;
    this.onApply = onApply;
    this.rendererDir = rendererDir;
    this.win = null;
    this.view = null;
    this.entry = null;
    this.list = [];
    this.index = 0;
  }

  /** Opens the preview on a theme (or brings it forward and switches to that theme). */
  open(themeId) {
    this.list = this.registry.listThemes().filter((t) => t.usable);
    const at = this.list.findIndex((t) => t.id === themeId);
    this.index = at >= 0 ? at : 0;
    if (this.win) {
      this.show();
      this.win.focus();
      return;
    }

    this.win = new BrowserWindow({
      width: 480,
      height: 640,
      title: '테마 미리보기',
      autoHideMenuBar: true,
      backgroundColor: '#16181d',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preview.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win.setMenu(null);
    this.win.loadFile(path.join(this.rendererDir, 'preview.html'));
    this.win.once('ready-to-show', () => this.win?.show());
    this.win.on('resize', () => this.layout());
    this.win.on('closed', () => {
      this.win = null;
      this.view = null;
      this.entry = null;
    });

    // The theme page: same isolated session and preload as a widget window.
    this.view = new WebContentsView({ webPreferences: this.windows.webPreferences() });
    this.view.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.view);
    const wc = this.view.webContents;
    this.entry = { preview: true, win: this.win, webContents: wc, mode: this.windows.mainFrame, projectId: null, theme: null, size: null };
    this.windows.register(wc, this.entry);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => {
      if (!this.registry.isThemeUrl(this.entry?.theme, url)) event.preventDefault();
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    // Each theme shows with the user's background opacity for that theme (#55).
    this.windows.watchBackground(wc, this.entry);
    this.show();
  }

  step(delta) {
    if (!this.list.length) return;
    this.index = (this.index + delta + this.list.length) % this.list.length;
    this.show();
  }

  apply() {
    const t = this.list[this.index];
    if (!t) return;
    this.onApply(t.id);
    this.sendState();
  }

  close() {
    this.win?.close();
  }

  /** Loads the current theme into the view and sizes the window around it. */
  show() {
    const meta = this.list[this.index];
    const theme = meta && this.registry.getTheme(meta.id);
    if (!this.win || !theme) return;
    this.entry.theme = theme;
    const size = this.frameSize(theme);
    this.entry.size = { width: size.width, height: size.height };
    this.fitWindow();
    this.view.webContents.loadURL(this.registry.themeUrl(theme));
    this.sendState();
  }

  /** Theme API setSize from inside the preview: resize the frame around it. */
  setSize(width, height) {
    if (!this.entry) return null;
    const min = this.frameSize(this.entry.theme);
    this.entry.size = { width: Math.max(Math.round(width) || min.width, min.minWidth), height: Math.max(Math.round(height) || min.height, min.minHeight) };
    this.fitWindow();
    return this.entry.size;
  }

  /** The previewed theme's size of the widget's main window (with the widget's current size variant). */
  frameSize(theme) {
    return this.windows.sizeOf(theme, this.windows.mainFrame);
  }

  fitWindow() {
    const wa = screen.getDisplayMatching(this.win.getBounds()).workArea;
    const width = Math.min(Math.max(this.entry.size.width + PAD * 2, 460), wa.width);
    const height = Math.min(this.entry.size.height + BAR_HEIGHT + PAD * 2, wa.height);
    this.win.setContentSize(width, height);
    const b = this.win.getBounds();
    // Keep the whole window on screen after growing.
    this.win.setPosition(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width), Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height));
    this.layout();
  }

  /** Centers the theme in the area under the bar. */
  layout() {
    if (!this.win || !this.view || !this.entry?.size) return;
    const [cw, ch] = this.win.getContentSize();
    const w = Math.min(this.entry.size.width, cw - PAD * 2);
    const h = Math.min(this.entry.size.height, ch - BAR_HEIGHT - PAD * 2);
    this.view.setBounds({ x: Math.round((cw - w) / 2), y: BAR_HEIGHT + PAD, width: w, height: h });
  }

  state() {
    const t = this.list[this.index];
    if (!t) return null;
    // The default theme (Dooray: glass) and its color skins share one layout; a theme with its own page has another.
    const base = this.registry.defaultTheme;
    const kind = t.id === base ? '기본 테마' : t.layout === base ? '기본 구성 · 색만 다름' : t.layout === t.id ? '화면 구성이 다른 테마' : '';
    return {
      index: this.index,
      total: this.list.length,
      current: this.getCurrentThemeId(),
      theme: { id: t.id, name: t.name, description: t.description, author: t.author, version: t.version, kind },
    };
  }

  sendState() {
    const s = this.state();
    if (this.win && s) this.win.webContents.send('preview:state', s);
  }
}

module.exports = { ThemePreview, BAR_HEIGHT };
