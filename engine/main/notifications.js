// Notification cards: one small always-on-top window per card, stacked at the bottom-right corner
// without overlapping. The newest card is on top; when there are too many, the oldest visible card
// leaves the screen and waits until a slot frees up. A waiting card keeps only its data: its window
// is destroyed and made again when the card comes back.
// Since #109 the card windows share one renderer process (engine/main/window-group.js): one more card costs ~2 MB
// instead of ~18 MB. If that process crashes, the cards on screen get new windows; after CRASH_LIMIT crashes in a
// minute the cards go back to a process each.
const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { WindowGroup } = require('./window-group');

const CARD_HTML = path.join(__dirname, '..', 'renderer', 'notification.html');
const CRASH_LIMIT = 3;

const CARD = { width: 340, height: 128, gap: 8, margin: 12 };
// A card with its widget menu open grows upwards by the menu's height, up to this much.
const MAX_MENU_HEIGHT = 260;
// More events than this in one cycle collapse into a single summary card.
const SUMMARY_THRESHOLD = 10;

// ---------- generic cards (engine API 1.2) ----------
// Any widget can push { type: 'card', title, body?, icon?, actions?, sticky?, sound?, tag? }.
// The card page is engine-owned, so everything is checked here and rendered as text or a capped
// data URL image; nothing from a widget is loaded as a file or URL.

// Built-in icon names; the renderer maps them to glyphs.
const CARD_ICONS = ['bell', 'alarm', 'timer', 'clock', 'info', 'warning', 'error', 'check', 'calendar', 'mail', 'star'];
const ICON_DATA_RE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_ICON_DATA = 64 * 1024;
const MAX_ACTIONS = 3;
const LIMITS = { title: 120, body: 300, tag: 64, actionId: 64, actionLabel: 20, emoji: 16 };

const clip = (value, max) => String(value).replace(/\s+/g, ' ').trim().slice(0, max);

/** A built-in icon name, an emoji (short text) or an image data URL; anything else -> null. */
function normalizeIcon(icon) {
  if (typeof icon !== 'string' || !icon) return null;
  if (CARD_ICONS.includes(icon)) return { name: icon };
  if (icon.startsWith('data:')) return icon.length <= MAX_ICON_DATA && ICON_DATA_RE.test(icon) ? { src: icon } : null;
  const text = icon.trim();
  // A short glyph without letters, digits or URL characters; shown with textContent only.
  return text && text.length <= LIMITS.emoji && !/[A-Za-z0-9/:\\]/.test(text) ? { emoji: text } : null;
}

/**
 * Checks a generic card event from a widget. Pure function so it can be unit-tested.
 * @returns the cleaned event, or null when it cannot be shown (no title).
 */
function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object' || raw.type !== 'card') return null;
  const title = raw.title == null ? '' : clip(raw.title, LIMITS.title);
  if (!title) return null;
  const seen = new Set();
  const actions = (Array.isArray(raw.actions) ? raw.actions : [])
    .map((a) => ({ id: a && a.id != null ? clip(a.id, LIMITS.actionId) : '', label: a && a.label != null ? clip(a.label, LIMITS.actionLabel) : '' }))
    .filter((a) => a.id && a.label && !seen.has(a.id) && seen.add(a.id))
    .slice(0, MAX_ACTIONS);
  return {
    type: 'card',
    title,
    body: raw.body == null ? '' : clip(raw.body, LIMITS.body),
    icon: normalizeIcon(raw.icon),
    actions,
    sticky: raw.sticky === true,
    sound: raw.sound === true,
    tag: raw.tag == null ? null : clip(raw.tag, LIMITS.tag) || null,
  };
}

/**
 * Turns one push into cards. Pure function so it can be unit-tested.
 * Condition alerts (rule) and generic cards always get their own card; the other (Dooray task)
 * events collapse into one summary card when there are more than SUMMARY_THRESHOLD.
 * Generic events that fail normalizeCard() are dropped.
 */
function planCards(events) {
  const own = [];
  const changes = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'card') {
      const card = normalizeCard(e);
      if (card) own.push({ kind: 'card', event: card });
    } else if (e.type === 'rule') own.push({ kind: 'event', event: e });
    else changes.push(e);
  }
  return [
    ...own,
    ...(changes.length > SUMMARY_THRESHOLD
      ? [{ kind: 'summary', count: changes.length, samples: changes.slice(0, 3).map((e) => e.task?.subject || '') }]
      : changes.map((e) => ({ kind: 'event', event: e }))),
  ];
}

/** Auto-close time for a card: a sticky generic card stays until confirmed (0). */
function autoCloseMs(card, notifyDurationSec) {
  if (card.kind === 'card' && card.event.sticky) return 0;
  const sec = Number(notifyDurationSec) || 0;
  return sec > 0 ? sec * 1000 : 0;
}

/** The action of a generic card with this id, or null (stale or forged ids are ignored). */
function findAction(card, actionId) {
  if (card.kind !== 'card') return null;
  return card.event.actions.find((a) => a.id === actionId) || null;
}

/** Whether an onAction result asks to keep the card open ({ keepOpen: true }). */
function keepsOpen(result) {
  return Boolean(result && typeof result === 'object' && result.keepOpen === true);
}

/**
 * Screen bounds for cards of the given heights; index 0 is the card at the bottom (the oldest
 * visible one). A taller card (menu open) pushes the cards above it upwards.
 * Pure function so the stacking rule can be unit-tested.
 */
function stackLayout(heights, workArea, card = CARD) {
  const x = workArea.x + workArea.width - card.width - card.margin;
  let top = workArea.y + workArea.height - card.margin;
  return heights.map((height, i) => {
    top -= height + (i ? card.gap : 0);
    return { x, y: top, width: card.width, height };
  });
}

/** Positions for `count` cards of the standard height. */
function stackPositions(count, workArea, card = CARD) {
  return stackLayout(Array(count).fill(card.height), workArea, card).map(({ x, y }) => ({ x, y }));
}

/** How many cards fit on screen, capped by the user's maximum. */
function capacity(maxVisible, workArea, card = CARD) {
  const fit = Math.max(1, Math.floor((workArea.height - card.margin + card.gap) / (card.height + card.gap)));
  return Math.max(1, Math.min(maxVisible, fit));
}

/** Vertical space a stack of cards with these heights needs, including the bottom margin. */
function stackHeight(heights, card = CARD) {
  return heights.reduce((sum, h) => sum + h, 0) + Math.max(0, heights.length - 1) * card.gap + card.margin;
}

/**
 * The overflow rule. Pure function so it can be unit-tested; the inputs are not changed.
 * Items are { seq, height, menuOpen }; a higher seq is a newer card.
 * - visible: on screen, oldest first (bottom of the stack upwards)
 * - waiting: off screen; the last item is the most recently hidden one and comes back first
 * - incoming: new cards, oldest first; they always go on top right away
 * Too many (more than `max`, or taller than `room`): the oldest visible card without an open menu
 * leaves the screen. Room left: the most recently hidden card comes back in age order (normally at
 * the bottom, since every visible card is newer).
 * @returns {{ visible: object[], waiting: object[] }}
 */
function arrange({ visible = [], waiting = [], incoming = [], max, room = Infinity, card = CARD }) {
  let shown = [...visible, ...incoming];
  const wait = [...waiting];
  const fits = (list) => list.length <= max && (list.length <= 1 || stackHeight(list.map((i) => i.height), card) <= room);
  while (!fits(shown)) {
    const i = shown.findIndex((item) => !item.menuOpen);
    if (i < 0) break; // every card on screen has its menu open: leave them
    wait.push(...shown.splice(i, 1));
  }
  while (wait.length) {
    const next = [...shown, wait[wait.length - 1]].sort((a, b) => a.seq - b.seq);
    if (!fits(next)) break;
    wait.pop();
    shown = next;
  }
  return { visible: shown, waiting: wait };
}

class NotificationCenter {
  /**
   * @param {{ getSettings: () => { notifyDurationSec: number, notifyMaxVisible: number }, ipc?: object }} opts
   *   Engine card settings; which events to show is up to the widget that pushes them.
   */
  constructor({ getSettings, ipc = ipcMain }) {
    this.getSettings = getSettings;
    this.ipc = ipc;
    this.windowGroup = null; // the card windows' shared process (#109), started with the first card
    this.shared = true; // false after repeated crashes: a window (process) per card, as before #109
    this.crashes = [];
    this.stopped = false; // the app is quitting: no new card windows (stop())
    this.visible = []; // on screen, oldest first; the oldest is drawn at the bottom
    this.waiting = []; // off screen; the last one comes back first
    this.sources = new Map(); // card id -> { openUrl, showWidget, menu } of the widget that pushed it
    this.away = false;
    this.seq = 0;
    this.registerIpc();
  }

  // ---------- input ----------

  /**
   * Shows cards for events (already filtered by the widget's own notification settings).
   * openUrl opens an event's link; showWidget brings the widget forward (summary card).
   * menu (engine API 1.1, optional): a toggle list the card offers for its event, e.g. categories (generic
   *   cards too since engine API 1.4, #71; their event is the cleaned card, so tag identifies it):
   *   { label, appliesTo?(event), items(event) -> [{ id, label, color?, checked }],
   *     toggle(event, id, checked) -> items, create?: { placeholder, run(event, text) -> items } }
   * Throwing (e.g. a duplicate name) shows the error's message on the card.
   * onAction (engine API 1.2, optional): onAction(event, actionId) for a generic card's buttons;
   *   the card closes afterwards unless it returns { keepOpen: true }.
   * widget: { id, name } of the sender, set by the engine (main.js), never by the widget.
   */
  push(wanted, { openUrl = async () => false, showWidget = () => {}, menu = null, onAction = null, widget = null } = {}) {
    if (!Array.isArray(wanted) || !wanted.length) return;
    const cards = planCards(wanted);
    if (!cards.length) return;
    // A generic card with a tag replaces the same widget's earlier card with that tag.
    for (const card of cards) if (card.kind === 'card' && card.event.tag) this.dropTagged(widget?.id ?? null, card.event.tag);

    const incoming = cards.map((card) => {
      const seq = ++this.seq;
      const id = `n${seq}`;
      this.sources.set(id, { openUrl, showWidget, menu, onAction, widget });
      const extra = card.kind === 'card' ? { widgetName: widget?.name ? String(widget.name) : '' } : {};
      return this.newEntry({ ...card, ...extra, id }, seq);
    });
    this.rearrange(incoming);
  }

  /** Removes the cards (on screen or waiting) a widget pushed earlier with this tag. */
  dropTagged(widgetId, tag) {
    const match = (e) => e.card.kind === 'card' && e.card.event.tag === tag && (this.sources.get(e.card.id)?.widget?.id ?? null) === widgetId;
    const waiting = this.waiting.filter(match);
    if (waiting.length) {
      this.waiting = this.waiting.filter((e) => !match(e));
      for (const e of waiting) this.sources.delete(e.card.id);
    }
    for (const e of this.visible.filter(match)) this.dismiss(e);
  }

  newEntry(card, seq) {
    // soundPending: a generic card with sound: true beeps once, the first time it is on screen.
    const soundPending = card.kind === 'card' && card.event.sound;
    return { seq, card, win: null, ready: false, timer: null, remaining: null, startedAt: 0, hovered: false, menuOpen: false, height: CARD.height, soundPending };
  }

  // ---------- display ----------

  workArea() {
    return screen.getPrimaryDisplay().workArea;
  }

  /** Applies the overflow rule: hides cards that leave the screen, shows the ones that join it. */
  rearrange(incoming = []) {
    const before = new Set(this.visible);
    const workArea = this.workArea();
    const next = arrange({
      visible: this.visible,
      waiting: this.waiting,
      incoming,
      max: capacity(this.getSettings().notifyMaxVisible || 3, workArea),
      room: workArea.height,
    });
    this.visible = next.visible;
    this.waiting = next.waiting;
    for (const entry of this.waiting) if (before.has(entry)) this.hide(entry);
    const joined = this.visible.filter((entry) => !before.has(entry));
    for (const entry of joined) if (!entry.win && !entry.opening) this.openWindow(entry);
    this.layout();
    for (const entry of joined) this.reveal(entry);
    this.broadcastQueue();
  }

  /**
   * Gives a card its window. createWindow resolves to it a moment later (the shared process, #109); by then the card
   * may have left the screen or been closed, and the late window is thrown away.
   */
  openWindow(entry) {
    if (this.stopped) return;
    const ticket = (entry.ticket = (entry.ticket || 0) + 1);
    const made = this.createWindow(entry);
    if (!made || typeof made.then !== 'function') {
      entry.win = made; // made at once (a window of its own)
      return;
    }
    entry.opening = true;
    made.then(
      (win) => {
        if (entry.ticket !== ticket || !this.visible.includes(entry)) {
          if (!win.isDestroyed()) win.destroy();
          return;
        }
        entry.opening = false;
        entry.win = win;
        // The shared process died between making this window and here: its crash report was not this card's yet.
        if (win.webContents.isCrashed()) return this.rendererGone();
        this.layout();
        this.broadcastQueue();
        this.reveal(entry);
      },
      (err) => {
        if (entry.ticket !== ticket) return;
        entry.opening = false;
        console.error(`notification card window: ${err.message}`);
        this.shared = false; // the next try gets a window of its own
        if (this.visible.includes(entry)) this.openWindow(entry);
      }
    );
  }

  cardWindowOptions(standalone) {
    return {
      width: CARD.width,
      height: CARD.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false, // never steal focus from what the user is typing
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'notification.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required', // a generic card's alert sound (engine API 1.2)
        ...(standalone ? {} : { spellcheck: false }),
      },
    };
  }

  /** A card window: in the cards' shared process (a promise), or on its own after repeated crashes. */
  createWindow(entry) {
    if (!this.shared) {
      const win = new BrowserWindow(this.cardWindowOptions(true));
      win.loadFile(CARD_HTML);
      this.wireWindow(entry, win);
      return win;
    }
    if (!this.windowGroup) this.windowGroup = new WindowGroup({ name: 'notifications' });
    return this.windowGroup.open(CARD_HTML, { options: this.cardWindowOptions(false) }).then((win) => this.wireWindow(entry, win));
  }

  wireWindow(entry, win) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.once('ready-to-show', () => {
      if (entry.win && entry.win !== win) return; // replaced meanwhile
      entry.ready = true;
      // It may have been pushed out while loading; it then shows when it comes back.
      if (entry.win === win && this.visible.includes(entry)) this.reveal(entry);
    });
    // Only a real dismissal removes the card; hide() detaches the window before destroying it.
    win.on('closed', () => {
      if (entry.win === win) this.removeEntry(entry);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (entry.win === win && !this.stopped && details?.reason !== 'clean-exit') this.rendererGone();
    });
    return win;
  }

  /**
   * A card renderer crashed. In the shared process every card on screen is blank: each gets a new window with a fresh
   * countdown, in a new process. Every card window reports it; the first report replaces them all.
   */
  rendererGone() {
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60000), now];
    if (this.shared && this.crashes.length >= CRASH_LIMIT) this.shared = false;
    const cards = this.visible.filter((e) => e.win && (e.win.isDestroyed() || e.win.webContents.isCrashed()));
    for (const entry of cards) {
      this.hide(entry);
      this.openWindow(entry);
    }
  }

  /** Puts a card on screen with a fresh countdown (once its page has loaded). */
  reveal(entry) {
    if (!entry.ready || !entry.win || entry.win.isDestroyed()) return;
    entry.win.showInactive();
    entry.remaining = null;
    this.startTimer(entry);
    this.playSound(entry);
  }

  /**
   * Beeps once for a card with sound: true, when it is first on screen. Not while the user is away
   * (locked, suspended, idle): the beep then waits until they are back, if the card is still shown.
   */
  playSound(entry) {
    if (!entry.soundPending || this.away || !entry.ready || !entry.win || entry.win.isDestroyed()) return;
    entry.soundPending = false;
    entry.win.webContents.send('notification:sound');
  }

  /**
   * Takes a card off screen: its window is destroyed (the waiting pile can grow large with
   * "until confirmed" cards), the card data and its widget source stay. Its countdown starts over
   * in a new window when it comes back.
   */
  hide(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = null;
    entry.hovered = false;
    entry.menuOpen = false;
    entry.height = CARD.height;
    entry.ready = false;
    entry.ticket = (entry.ticket || 0) + 1; // a window still on its way is not used
    entry.opening = false;
    const win = entry.win;
    entry.win = null; // detach first so the 'closed' handler does not drop the card
    if (win && !win.isDestroyed()) win.destroy();
  }

  layout() {
    // visible is oldest-first, and position 0 is the bottom of the stack.
    const bounds = stackLayout(
      this.visible.map((e) => e.height),
      this.workArea()
    );
    this.visible.forEach((entry, i) => {
      if (entry.win && !entry.win.isDestroyed()) entry.win.setBounds(bounds[i]);
    });
  }

  removeEntry(entry) {
    clearTimeout(entry.timer);
    entry.ticket = (entry.ticket || 0) + 1;
    entry.opening = false;
    if (this.stopped) return; // closing for the quit: nothing moves up from the waiting pile
    this.sources.delete(entry.card.id);
    const list = this.visible.includes(entry) ? this.visible : this.waiting;
    const i = list.indexOf(entry);
    if (i < 0) return;
    list.splice(i, 1);
    this.rearrange();
  }

  dismiss(entry) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.close();
    else this.removeEntry(entry);
  }

  dismissAll() {
    const waiting = this.waiting;
    this.waiting = [];
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      this.sources.delete(entry.card.id);
      if (entry.win && !entry.win.isDestroyed()) entry.win.close();
    }
    for (const entry of [...this.visible]) this.dismiss(entry);
  }

  // Only the bottom card (next to the waiting pile) shows "+N 대기" and "모두 확인".
  broadcastQueue() {
    const bottom = this.visible[0];
    for (const e of this.visible) {
      if (e.win && !e.win.isDestroyed()) e.win.webContents.send('notification:queue', e === bottom ? this.waiting.length : 0);
    }
  }

  /**
   * The app is quitting (#109): card windows close without a waiting card taking their place. A new window opened
   * while the app quits kept the process alive (no quit) when cards were waiting.
   */
  stop() {
    this.stopped = true;
    for (const entry of [...this.visible, ...this.waiting]) {
      clearTimeout(entry.timer);
      entry.ticket = (entry.ticket || 0) + 1;
      const win = entry.win;
      entry.win = null;
      if (win && !win.isDestroyed()) win.destroy();
    }
    this.windowGroup?.destroy();
    this.windowGroup = null;
  }

  // ---------- auto-close timer ----------
  // Runs only while the card is not hovered and the user is at the desk.

  durationMs(entry) {
    return autoCloseMs(entry.card, this.getSettings().notifyDurationSec);
  }

  startTimer(entry) {
    const duration = this.durationMs(entry);
    if (!duration) return this.sendTimer(entry, null);
    if (entry.remaining === null) entry.remaining = duration;
    if (this.away || entry.hovered || entry.menuOpen) return this.sendTimer(entry, false);
    clearTimeout(entry.timer);
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => this.dismiss(entry), entry.remaining);
    this.sendTimer(entry, true);
  }

  pauseTimer(entry) {
    if (!entry.timer) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
    this.sendTimer(entry, false);
  }

  sendTimer(entry, running) {
    if (!entry.win || entry.win.isDestroyed()) return;
    entry.win.webContents.send('notification:timer', {
      running,
      remainingMs: entry.remaining,
      durationMs: this.durationMs(entry),
    });
  }

  /** Pauses countdowns while the PC is locked or the user is away (only visible cards count down). */
  setAway(away) {
    if (away === this.away) return;
    this.away = away;
    for (const entry of this.visible) {
      if (away) this.pauseTimer(entry);
      else {
        this.startTimer(entry);
        this.playSound(entry);
      }
    }
  }

  // ---------- IPC from card windows ----------

  entryFor(sender) {
    // A waiting card's page may still be loading and asking for its data.
    return [...this.visible, ...this.waiting].find((e) => e.win && !e.win.isDestroyed() && e.win.webContents === sender) || null;
  }

  // ---------- widget card menu (engine API 1.1) ----------

  /** The menu the pushing widget offers for this card, or null. */
  menuOf(entry) {
    const menu = this.sources.get(entry.card.id)?.menu;
    // Dooray task events (1.1) and, since 1.4, generic cards (#71); never on summary cards. appliesTo decides
    // per card (a generic card's event is the cleaned card: title, body, tag, ...).
    if (!menu || (entry.card.kind !== 'event' && entry.card.kind !== 'card')) return null;
    try {
      return menu.appliesTo && !menu.appliesTo(entry.card.event) ? null : menu;
    } catch {
      return null;
    }
  }

  /** Runs a widget menu call; errors become { ok: false, message } shown on the card. */
  async runMenu(entry, fn) {
    const menu = this.menuOf(entry);
    if (!menu) return { ok: false, message: '이 알림에는 메뉴가 없습니다.' };
    try {
      return { ok: true, items: (await fn(menu, entry.card.event)) || [] };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  /**
   * Opens or closes the menu panel: the card grows by `panelHeight` and may take focus (a text
   * field needs it), its countdown pauses; closing gives focus back and resumes the countdown.
   * A card with its menu open is never pushed off screen; growing may push older cards out instead.
   */
  setMenuOpen(entry, open, panelHeight = 0) {
    if (open && !this.visible.includes(entry)) return entry.height; // hidden cards cannot open menus
    entry.menuOpen = Boolean(open);
    entry.height = CARD.height + (entry.menuOpen ? Math.max(0, Math.min(MAX_MENU_HEIGHT, Math.round(Number(panelHeight) || 0))) : 0);
    if (entry.win && !entry.win.isDestroyed()) {
      entry.win.setFocusable(entry.menuOpen);
      if (entry.menuOpen) entry.win.focus();
    }
    this.rearrange();
    if (entry.menuOpen) this.pauseTimer(entry);
    else if (this.visible.includes(entry)) this.startTimer(entry);
    return entry.height;
  }

  registerIpc() {
    const handle = (channel, fn) =>
      this.ipc.handle(channel, (event, ...args) => {
        const entry = this.entryFor(event.sender);
        if (!entry) throw new Error('Not a notification window');
        return fn(entry, ...args);
      });

    handle('notification:get', async (entry) => {
      const menu = this.menuOf(entry);
      const items = menu ? await this.runMenu(entry, (m, ev) => m.items(ev)) : null;
      return {
        card: entry.card,
        waiting: entry === this.visible[0] ? this.waiting.length : 0,
        menu: menu ? { label: String(menu.label || '메뉴'), placeholder: menu.create ? String(menu.create.placeholder || '') : null, items: items.ok ? items.items : [] } : null,
      };
    });
    handle('notification:menu-open', (entry, open, panelHeight) => this.setMenuOpen(entry, open, panelHeight));
    handle('notification:menu-items', (entry) => this.runMenu(entry, (m, ev) => m.items(ev)));
    handle('notification:menu-toggle', (entry, id, checked) => this.runMenu(entry, (m, ev) => m.toggle(ev, String(id), Boolean(checked))));
    handle('notification:menu-create', (entry, text) =>
      this.runMenu(entry, (m, ev) => {
        const name = String(text || '').trim();
        if (!m.create) throw new Error('새로 만들 수 없습니다.');
        if (!name) throw new Error('이름을 입력하세요.');
        return m.create.run(ev, name);
      })
    );
    handle('notification:open', async (entry) => {
      if (entry.card.kind === 'card') return; // generic cards have no link; their buttons are actions
      const source = this.sources.get(entry.card.id);
      if (entry.card.kind === 'summary') source?.showWidget();
      else await source?.openUrl(entry.card.event.url || entry.card.event.task?.url);
      this.dismiss(entry);
    });
    // Generic card button (engine API 1.2): call the widget, then close unless it keeps the card.
    handle('notification:action', async (entry, actionId) => {
      const action = findAction(entry.card, String(actionId));
      if (!action) return { ok: false, message: '이 알림에는 그 버튼이 없습니다.' };
      const onAction = this.sources.get(entry.card.id)?.onAction;
      let result;
      try {
        result = typeof onAction === 'function' ? await onAction({ ...entry.card.event }, action.id) : undefined;
      } catch (err) {
        return { ok: false, message: err.message || '처리하지 못했습니다.' };
      }
      if (keepsOpen(result)) return { ok: true, keepOpen: true };
      this.dismiss(entry);
      return { ok: true, keepOpen: false };
    });
    handle('notification:dismiss', (entry) => this.dismiss(entry));
    handle('notification:dismiss-all', () => this.dismissAll());
    handle('notification:hover', (entry, hovered) => {
      if (!this.visible.includes(entry)) return; // e.g. mouseleave as a card is pushed off screen
      entry.hovered = Boolean(hovered);
      if (entry.hovered) this.pauseTimer(entry);
      else this.startTimer(entry);
    });
  }
}

module.exports = {
  NotificationCenter,
  arrange,
  stackLayout,
  stackHeight,
  stackPositions,
  capacity,
  normalizeCard,
  normalizeIcon,
  planCards,
  autoCloseMs,
  findAction,
  keepsOpen,
  CARD,
  CARD_ICONS,
  SUMMARY_THRESHOLD,
  MAX_MENU_HEIGHT,
  MAX_ICON_DATA,
};
