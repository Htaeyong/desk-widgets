// The message reader (#65): a widget-owned app window (reader/reader.html, trusted widget UI: header,
// buttons, attachment names) with the message body in a separate WebContentsView that is isolated from
// everything else: JavaScript off, sandboxed, no preload, its own in-memory session ("mail-preview") that
// cancels every request except data: and — only after "이미지 표시" for that message — remote images;
// CSP meta in the document as well, no permissions, no downloads, no navigation (links go to the default
// browser after a click, http / https / mailto only).
const path = require('path');
const { buildDocument, isOpenableLink, textToHtml } = require('./sanitize');
const { createHistory } = require('../kit/nav');
const { safe } = require('./composer');

const READER_HISTORY = 10; // messages the reader can go back to (their details are in memory anyway)

const PARTITION = 'mail-preview'; // no "persist:" prefix: in memory only, gone when the app quits
const MAX_DATA_URL = 1.9 * 1024 * 1024; // Chromium refuses URLs over 2 MB

/**
 * Whether the preview session lets a request through. Pure (unit-tested).
 * details: { url, resourceType, webContentsId }; allow: { webContentsId, remote } for the shown message.
 */
function requestAllowed(details, allow) {
  const url = String(details?.url || '');
  if (/^data:/i.test(url)) return true;
  if (!allow || !allow.remote) return false;
  if (details.webContentsId !== allow.webContentsId) return false;
  return /^https?:\/\//i.test(url) && details.resourceType === 'image';
}

/** The data: URL of a preview document; falls back to fewer inline images, then to the text. */
function documentUrl(detail, allowRemote) {
  const tries = [detail.html, detail.htmlNoCid, textToHtml(detail.text || '')].filter((x) => typeof x === 'string');
  for (const body of tries) {
    const url = `data:text/html;charset=utf-8;base64,${Buffer.from(buildDocument(body, { allowRemote })).toString('base64')}`;
    if (url.length <= MAX_DATA_URL) return { url, reduced: body !== detail.html };
  }
  return { url: `data:text/html;charset=utf-8;base64,${Buffer.from(buildDocument('<p>메일이 너무 커서 미리 볼 수 없습니다. 웹메일이나 메일 프로그램에서 여세요.</p>')).toString('base64')}`, reduced: true };
}

/** Alt+← / Alt+→ of an Electron before-input-event -> 'back' | 'forward' | null. */
function keyAction(input) {
  if (!input || input.type !== 'keyDown' || !input.alt || input.control || input.shift || input.meta) return null;
  return input.key === 'ArrowLeft' ? 'back' : input.key === 'ArrowRight' ? 'forward' : null;
}

/**
 * @param {object} o
 * @param {object} o.ctx       widget context (openAppWindow, handle, openExternal, dir)
 * @param {(name, id, arg) => any} o.onAction  reader buttons: reply, replyAll, forward, showImages, markUnread, webmail, copyId
 * @param {object} [o.electron] seam (tests never open windows)
 */
function createReader({ ctx, onAction, electron = null }) {
  let win = null;
  let winWc = null; // the window's webContents, kept: its getter throws once the window is destroyed
  let view = null;
  let viewWc = null;
  let current = null; // the detail shown
  let allow = null;
  let sessionReady = false;
  // Back / forward between messages opened in this window; back with nothing before closes the window.
  let history = createHistory({ limit: READER_HISTORY });
  const el = () => electron || require('electron');

  function setupSession() {
    if (sessionReady) return;
    sessionReady = true;
    const ses = el().session.fromPartition(PARTITION);
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !requestAllowed(details, allow) }));
    // Allowed images go out without cookies or a referrer, and set no cookies.
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const k of Object.keys(headers)) if (/^(cookie|referer)$/i.test(k)) delete headers[k];
      callback({ requestHeaders: headers });
    });
    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      for (const k of Object.keys(headers)) if (/^set-cookie$/i.test(k)) delete headers[k];
      callback({ responseHeaders: headers });
    });
    ses.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
  }

  const send = (name, payload) => {
    if (win && !win.isDestroyed() && winWc && !winWc.isDestroyed()) winWc.send('mail-reader:event', name, payload);
  };

  function makeView() {
    setupSession();
    const { WebContentsView } = el();
    view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    const wc = view.webContents;
    viewWc = wc;
    const open = (url) => {
      if (isOpenableLink(url)) Promise.resolve(ctx.openExternal(url)).catch(() => send('error', '링크를 열 프로그램을 찾지 못했습니다.'));
    };
    wc.setWindowOpenHandler(
      safe('reader window open', ({ url }) => {
        open(url);
        return { action: 'deny' };
      }),
    );
    wc.on(
      'will-navigate',
      safe('reader navigate', (event, url) => {
        event.preventDefault();
        open(url);
      }),
    );
    wc.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) event.preventDefault();
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('update-target-url', safe('reader hover', (_e, url) => send('hover', isOpenableLink(url) ? url : '')));
    wc.on('context-menu', (event) => event.preventDefault());
    // Alt+← / Alt+→ while the message body has the keyboard (its page runs no JavaScript).
    wc.on(
      'before-input-event',
      safe('reader keys', (event, input) => {
        const action = keyAction(input);
        if (!action) return;
        event.preventDefault();
        navigate(action);
      }),
    );
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 200, width: 10, height: 10 });
  }

  function load() {
    if (!view || !current || !viewWc || viewWc.isDestroyed()) return;
    allow = { webContentsId: viewWc.id, remote: Boolean(current.allowRemote) };
    const { url, reduced } = documentUrl(current, allow.remote);
    viewWc.loadURL(url).catch(() => {});
    send('show', { ...publicDetail(current), reduced });
  }

  /** What the reader page sees: everything but the HTML. */
  const publicDetail = (d) => {
    const { html, htmlNoCid, text, ...rest } = d;
    return rest;
  };

  function ensureWindow() {
    if (win && !win.isDestroyed()) return false;
    win = ctx.openAppWindow({
      html: path.join(ctx.dir, 'reader', 'reader.html'),
      preload: path.join(ctx.dir, 'reader', 'preload.js'),
      title: '메일 보기',
      width: 820,
      height: 700,
      minWidth: 420,
      minHeight: 360,
    });
    const thisWin = win;
    winWc = win.webContents;
    winWc.setWindowOpenHandler(() => ({ action: 'deny' }));
    winWc.on('will-navigate', (event) => event.preventDefault());
    // Mouse side buttons arrive as Windows app commands, over the header and over the message body alike.
    win.on(
      'app-command',
      safe('reader app-command', (_e, command) => {
        if (command === 'browser-backward') navigate('back');
        else if (command === 'browser-forward') navigate('forward');
      }),
    );
    makeView();
    const thisViewWc = viewWc;
    win.on(
      'closed',
      safe('reader closed', () => {
        try {
          if (thisViewWc && !thisViewWc.isDestroyed()) thisViewWc.close();
        } catch {
          // already gone
        }
        // A newer reader window may exist already: only clear the state of this one.
        if (win !== thisWin) return;
        win = null;
        winWc = null;
        view = null;
        viewWc = null;
        current = null;
        allow = null;
        history = createHistory({ limit: READER_HISTORY });
      }),
    );
    return true;
  }

  /** IPC from the reader page (ctx.handle('mail-reader', ...)); only that window is answered. */
  function handle(event, name, arg) {
    if (!win || win.isDestroyed() || !winWc || event.sender !== winWc) return null;
    if (name === 'ready') {
      load();
      return current ? publicDetail(current) : null;
    }
    if (name === 'layout') {
      const r = arg || {};
      const n = (v) => Math.max(0, Math.round(Number(v) || 0));
      view?.setBounds({ x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) });
      return true;
    }
    if (name === 'navigate') return navigate(arg?.action === 'forward' ? 'forward' : 'back');
    if (name === 'action' && current) return onAction(String(arg?.name || ''), current.id, arg || {});
    return null;
  }

  /** Back: the previous message, or close the window when there is none. Forward: the next one, if any. */
  function navigate(action) {
    if (!win || win.isDestroyed()) return false;
    const target = action === 'forward' ? history.forward(current) : history.back(current);
    if (target) {
      current = target;
      win.setTitle(`${current.subject || '(제목 없음)'} - 메일`);
      load();
      return true;
    }
    if (action === 'back') win.close();
    return false;
  }

  return {
    PARTITION,
    handle,
    navigate,
    /** Shows a message (detail with sanitized html, text, allowRemote, ...). */
    show(detail) {
      const created = ensureWindow();
      if (current && current.id !== detail.id) history.record(current);
      current = detail;
      win.setTitle(`${detail.subject || '(제목 없음)'} - 메일`);
      if (!created) {
        load();
        win.show();
        win.focus();
      }
      // A new window loads once its page says "ready".
    },
    /** The shown message changed (images allowed, flags): reload when it is that message. */
    update(detail) {
      if (current && detail.id === current.id) {
        current = detail;
        load();
      }
    },
    currentId: () => current?.id || null,
    current: () => (current ? { ...current } : null),
    isOpen: () => Boolean(win && !win.isDestroyed()),
    close() {
      if (win && !win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { createReader, requestAllowed, documentUrl, keyAction, PARTITION, MAX_DATA_URL };
