// The mail composer (#68): widget-owned windows (composer/composer.html, trusted widget UI like the reader),
// one per draft. Drafts live in memory only (never on disk) until they are sent or discarded; attached PC
// files are kept as paths and read when sending. Themes never see this: they only ask to compose / reply /
// forward and the widget opens a window here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { checkList } = require('../composer/addresses');

const MAX_ATTACH = 20 * 1024 * 1024; // all attachments of one message (PC files + forwarded originals)
const MAX_FILES = 30;

const newDraftId = () => `d${crypto.randomBytes(6).toString('hex')}`;
/**
 * Wraps a window / IPC callback so an error in widget code is logged (without mail content) instead of
 * reaching Electron's "A JavaScript error occurred in the main process" dialog.
 */
function safe(label, fn) {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') return r.catch((err) => console.error(`mail widget: ${label}: ${err?.message || err}`));
      return r;
    } catch (err) {
      console.error(`mail widget: ${label}: ${err?.message || err}`);
      return undefined;
    }
  };
}

/**
 * Closes a composer window from an IPC call. destroy() runs the window's 'closed' listeners synchronously,
 * so an error there would turn the IPC answer into a rejection although the send was already queued
 * (#68: the page saw a failed 보내기 for a mail that went out). The answer must not depend on it.
 */
function destroyQuietly(win) {
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch (err) {
    console.error(`mail widget: composer destroy: ${err?.message || err}`);
  }
}

const sizeLabel = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** What the composer page sees of a draft (no file paths). */
function publicDraft(d) {
  return {
    id: d.id,
    mode: d.mode,
    accountId: d.accountId,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    body: d.body,
    files: d.files.map((f) => ({ id: f.id, name: f.name, size: f.size })),
    // Recipients as lists of { name, address } (chips in the page).
    forward: d.forward ? { names: d.forward.names, size: d.forward.size, include: d.forward.include, tooBig: d.forward.tooBig } : null,
    error: d.error || null,
    maxBytes: MAX_ATTACH,
  };
}

/** Bytes of all attachments of a draft (forwarded originals counted only when included). */
const attachedBytes = (d) => d.files.reduce((n, f) => n + f.size, 0) + (d.forward?.include ? d.forward.size : 0);

/**
 * @param {object} o
 * @param {object} o.ctx       openAppWindow, handle, confirm, dir
 * @param {() => object[]} o.accounts   accounts that can send: [{ id, label }]
 * @param {(draft) => { ok, message? }} o.onSend   validates and queues; the window closes on ok
 * @param {object} [o.dialog]  seam: showOpenDialog(win, opts) -> { canceled, filePaths }
 */
function createComposer({ ctx, accounts, onSend, suggest = () => [], dialog = null, fsMod = fs }) {
  const drafts = new Map(); // id -> draft
  const windows = new Map(); // draft id -> window
  const byContents = new Map(); // webContents -> draft id
  const dlg = () => dialog || require('electron').dialog;

  function open(draft) {
    if (!drafts.has(draft.id)) drafts.set(draft.id, draft);
    const existing = windows.get(draft.id);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return existing;
    }
    const win = ctx.openAppWindow({
      html: path.join(ctx.dir, 'composer', 'composer.html'),
      preload: path.join(ctx.dir, 'composer', 'preload.js'),
      title: titleOf(draft),
      width: 680,
      height: 640,
      minWidth: 460,
      minHeight: 420,
    });
    // Kept now: after 'closed' the window's webContents getter throws ("Object has been destroyed").
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    windows.set(draft.id, win);
    byContents.set(wc, draft.id);
    let confirmed = false;
    let asking = false;
    win.on(
      'close',
      safe('composer close', (event) => {
        const d = drafts.get(draft.id);
        if (confirmed || !d || d.sent || d.queued || !d.dirty) return;
        // Closing with unsent text: ask (the draft is in memory only, so it would be gone).
        event.preventDefault();
        if (asking) return;
        asking = true;
        Promise.resolve(
          ctx.confirm?.(win, { type: 'question', title: '메일 쓰기', message: '보내지 않은 메일을 버릴까요?', detail: '쓰던 내용은 저장되지 않습니다.', buttons: ['버리기', '계속 쓰기'], defaultId: 1, cancelId: 1, noLink: true }) ?? 0,
        )
          .then((answer) => {
            asking = false;
            if (answer !== 0) return;
            confirmed = true;
            drafts.delete(draft.id);
            // The window may have died meanwhile (widget turned off): nothing more to close.
            if (!win.isDestroyed()) win.close();
          })
          .catch((err) => {
            asking = false;
            console.error(`mail widget: composer confirm: ${err?.message || err}`);
          });
      }),
    );
    win.on(
      'closed',
      safe('composer closed', () => {
        windows.delete(draft.id);
        byContents.delete(wc);
        const d = drafts.get(draft.id);
        if (d && !d.queued && !d.dirty) drafts.delete(draft.id);
      }),
    );
    return win;
  }

  const titleOf = (d) => `${{ new: '새 메일', reply: '답장', replyAll: '전체 답장', forward: '전달' }[d.mode] || '메일 쓰기'}${d.subject ? ` - ${d.subject}` : ''}`;

  /** Fields typed in the page (kept so a failed send can reopen with everything). */
  function update(d, fields = {}) {
    for (const k of ['subject', 'body']) if (typeof fields[k] === 'string') d[k] = fields[k].slice(0, k === 'body' ? 500000 : 4000);
    // Recipient chips: [{ name, address, invalid? }] kept as given (checked when sending), at most 200 each.
    for (const k of ['to', 'cc', 'bcc']) {
      if (!Array.isArray(fields[k])) continue;
      d[k] = fields[k].slice(0, 200).map((r) => ({ name: String(r?.name || '').slice(0, 200), address: String(r?.address || '').slice(0, 300), ...(r?.invalid ? { invalid: true } : {}) }));
    }
    if (typeof fields.accountId === 'string') d.accountId = fields.accountId;
    if (d.forward && typeof fields.includeForward === 'boolean' && !d.forward.tooBig) d.forward.include = fields.includeForward;
    d.dirty = true;
  }

  async function pickFiles(d, win) {
    if (!win || win.isDestroyed()) return { ok: false, message: '쓰기 창이 닫혔습니다.' };
    const res = await dlg().showOpenDialog(win, { title: '첨부할 파일', properties: ['openFile', 'multiSelections'] });
    if (!res || res.canceled) return { ok: true, files: publicDraft(d).files };
    let used = attachedBytes(d);
    const skipped = [];
    for (const file of res.filePaths || []) {
      let size;
      try {
        const st = fsMod.statSync(file);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        skipped.push(`${path.basename(file)}(읽을 수 없음)`);
        continue;
      }
      if (d.files.length >= MAX_FILES || used + size > MAX_ATTACH) {
        skipped.push(`${path.basename(file)}(${sizeLabel(size)})`);
        continue;
      }
      used += size;
      d.files.push({ id: crypto.randomBytes(4).toString('hex'), name: path.basename(file), size, path: file });
    }
    d.dirty = true;
    return {
      ok: true,
      files: publicDraft(d).files,
      message: skipped.length ? `첨부는 모두 합쳐 ${sizeLabel(MAX_ATTACH)}까지입니다. 넣지 못한 파일: ${skipped.join(', ')}` : null,
    };
  }

  /** IPC from a composer page (ctx.handle('mail-composer', ...)); only that draft's window is answered. */
  async function handle(event, name, arg = {}) {
    const id = byContents.get(event.sender);
    const d = id && drafts.get(id);
    const win = id && windows.get(id);
    if (!d || !win || win.isDestroyed()) return null;
    if (name === 'init') return { draft: publicDraft(d), accounts: accounts() };
    if (name === 'update') {
      update(d, arg);
      if (!win.isDestroyed()) win.setTitle(titleOf(d));
      return true;
    }
    if (name === 'pickFiles') return pickFiles(d, win);
    if (name === 'suggest') {
      const q = typeof arg.q === 'string' ? arg.q.slice(0, 100) : '';
      const exclude = Array.isArray(arg.exclude) ? arg.exclude.map(String).slice(0, 300) : [];
      return q.trim() ? suggest(q, exclude).map(({ name: n, address }) => ({ name: n, address })) : [];
    }
    if (name === 'removeFile') {
      d.files = d.files.filter((f) => f.id !== arg.id);
      return { ok: true, files: publicDraft(d).files };
    }
    if (name === 'send') {
      update(d, arg);
      const res = await onSend(d);
      if (res?.ok) {
        d.queued = true;
        d.error = null;
        destroyQuietly(win); // the send is queued: the page gets { ok: true } whatever closing does
      }
      return res;
    }
    if (name === 'discard') {
      drafts.delete(d.id);
      destroyQuietly(win);
      return true;
    }
    return null;
  }

  /** Reads the PC files of a draft at send time (a file may have changed or gone since it was picked). */
  function readFiles(d) {
    return d.files.map((f) => {
      try {
        return { name: f.name, data: fsMod.readFileSync(f.path) };
      } catch {
        throw new Error(`첨부 파일 "${f.name}"을 읽지 못했습니다(옮겨졌거나 지워졌을 수 있습니다).`);
      }
    });
  }

  return {
    open,
    handle,
    readFiles,
    drafts,
    get: (id) => drafts.get(id) || null,
    /** After a successful send: the draft is gone. */
    done(id) {
      drafts.delete(id);
    },
    /** After a failed send: reopen with everything kept, with the reason on top. */
    reopen(id, message) {
      const d = drafts.get(id);
      if (!d) return false;
      d.queued = false;
      d.error = message || null;
      open(d);
      return true;
    },
    closeAll() {
      for (const w of windows.values()) if (!w.isDestroyed()) w.destroy();
      windows.clear();
    },
  };
}

module.exports = { createComposer, publicDraft, attachedBytes, newDraftId, MAX_ATTACH, sizeLabel, safe, checkList };
