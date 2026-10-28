// One open memo (#75): keeps what the window typed until it is on disk, and decides what an outside change means.
//
// - The page sends its content often (about 4 times a second while typing); the session writes it after a short
//   pause (debounce) and at the latest after maxWaitMs, atomically (library.write). flushSync() on shutdown.
// - A change on disk that the widget did not write: shown in the window when it has no unsaved edits; otherwise the
//   window gets a conflict and the user chooses (theirs / mine / keep mine as a copy). Nothing is overwritten silently.
const F = require('./files');

// Real time; tests pass their own clock so save timing does not depend on how busy the machine is.
const REAL_CLOCK = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

class MemoSession {
  /**
   * @param {object} o
   * @param {import('./library').Library} o.library
   * @param {string} o.id
   * @param {(name: string, payload?: object) => void} o.send  event to the memo window
   * @param {(error: Error) => void} [o.onError]
   * @param {{ now(): number, setTimeout(fn, ms): any, clearTimeout(h): void }} [o.clock]  save timers (tests)
   */
  constructor({ library, id, send, onError = () => {}, debounceMs = 600, maxWaitMs = 3000, retryMs = 5000, clock = REAL_CLOCK }) {
    this.clock = clock;
    this.retryMs = retryMs;
    this.library = library;
    this.id = id;
    this.send = send;
    this.onError = onError;
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.diskHash = null; // hash of the file as last read or written by us
    this.diskBody = null; // its body
    this.pending = null; // body typed but not written yet
    this.dirty = false; // the page said it has edits it has not sent yet
    this.conflict = null; // { body } of the outside version while the user decides
    this.missing = false; // the file disappeared
    this.timer = null;
    this.firstPendingAt = 0;
    this.writing = null;
  }

  /** Reads the file (window opening or reloading): { body }. */
  async load() {
    const r = await this.library.read(this.id);
    this.diskHash = r.hash;
    this.diskBody = r.body;
    this.missing = false;
    return { body: r.body };
  }

  hasLocalEdits() {
    return this.dirty || this.pending !== null || Boolean(this.writing);
  }

  /** The page started editing (sent before its throttled content arrives). */
  markDirty() {
    this.dirty = true;
  }

  /** New content from the page. */
  update(body) {
    this.dirty = false;
    if (typeof body !== 'string') return;
    if (body === (this.pending ?? this.diskBody) && !this.conflict) return;
    if (this.pending === null) this.firstPendingAt = this.clock.now();
    this.pending = body;
    if (this.conflict || this.missing) return; // kept until the user decides
    this.clock.clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPendingAt + this.maxWaitMs - this.clock.now()));
    this.timer = this.clock.setTimeout(() => this.flush().catch(() => {}), wait);
  }

  /** Writes pending content now (unless there is a conflict). */
  async flush() {
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.writing) await this.writing.catch(() => {});
    if (this.pending === null || this.conflict || this.missing) return false;
    const body = this.pending;
    this.pending = null;
    if (body === this.diskBody) return false;
    let wrote = true;
    this.writing = (async () => {
      try {
        // Another program may have changed the file after our last read and before the folder watcher said so:
        // never write over that. It becomes the same conflict the watcher would have raised.
        const now = await this.library.read(this.id).catch(() => null);
        // The watcher may have raised a conflict while we read: then nothing is written until the user answers.
        if (this.conflict) {
          if (this.pending === null) this.pending = body;
          wrote = false;
          return;
        }
        if (now && now.hash !== this.diskHash && now.body !== this.diskBody) {
          if (this.pending === null) this.pending = body;
          this.conflict = { body: now.body, hash: now.hash };
          this.send('conflict', {});
          wrote = false;
          return;
        }
        this.diskHash = await this.library.write(this.id, body);
        this.diskBody = body;
        this.send('saved', { at: this.clock.now() });
      } catch (err) {
        // Keep the text: it is written with the next change or at shutdown, and the window shows the error.
        if (this.pending === null) this.pending = body;
        this.send('save-error', { message: saveMessage(err) });
        this.clock.clearTimeout(this.timer);
        this.timer = this.clock.setTimeout(() => this.flush().catch(() => {}), this.retryMs);
        this.onError(err);
        throw err;
      }
    })();
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
    return wrote;
  }

  /** Shutdown: write what is pending synchronously (also during a conflict, to a copy, so nothing is lost). */
  flushSync() {
    this.clock.clearTimeout(this.timer);
    if (this.pending === null || this.pending === this.diskBody) return false;
    try {
      if (this.conflict || this.missing) return this.saveCopySync(this.pending);
      this.diskHash = this.library.writeSync(this.id, this.pending);
      this.diskBody = this.pending;
      this.pending = null;
      return true;
    } catch (err) {
      this.onError(err);
      return false;
    }
  }

  saveCopySync(body) {
    // A conflict at shutdown: the outside version stays in the file, our text goes into a new file next to it.
    const m = this.library.get(this.id);
    if (!m) return false;
    const path = require('path');
    const { file } = F.uniqueFileName(path.dirname(m.file), `${m.title} (내 사본)`, m.ext);
    F.writeFileAtomicSync(file, body);
    this.pending = null;
    return true;
  }

  /**
   * The file changed or vanished on disk (folder watcher). Returns what happened:
   * 'same' (our own write), 'reloaded' (shown in the window), 'conflict', 'missing'.
   */
  async external() {
    if (this.writing) await this.writing.catch(() => {});
    const m = this.library.get(this.id);
    if (!m) {
      this.missing = true;
      this.send('missing', {});
      return 'missing';
    }
    let r;
    try {
      r = await this.library.read(this.id);
    } catch (err) {
      return 'unreadable';
    }
    if (r.hash === this.diskHash) return 'same';
    if (this.missing) this.missing = false;
    if (r.body === this.diskBody) {
      this.diskHash = r.hash; // only front matter or line endings changed
      return 'same';
    }
    if (this.hasLocalEdits() || this.conflict) {
      this.clock.clearTimeout(this.timer);
      this.conflict = { body: r.body, hash: r.hash };
      this.send('conflict', {});
      return 'conflict';
    }
    this.diskHash = r.hash;
    this.diskBody = r.body;
    this.send('reload', { body: r.body });
    return 'reloaded';
  }

  /**
   * The user's answer to a conflict (or to a missing file):
   * 'theirs' shows the outside version, 'mine' writes ours over it, 'copy' writes ours to a new memo and shows theirs.
   * `body` is the page's latest content. Returns { body?, copyId? }.
   */
  async resolve(choice, body, { createCopy } = {}) {
    // A save already checking the disk finishes first (it sees the conflict and writes nothing); otherwise it could
    // compare against the outside version accepted here and write ours over it.
    if (this.writing) await this.writing.catch(() => {});
    const mine = typeof body === 'string' ? body : this.pending ?? this.diskBody ?? '';
    if (this.missing && !this.conflict) {
      if (choice !== 'mine') return {};
      // Write the file again under its name.
      this.missing = false;
      this.pending = mine;
      this.diskBody = null;
      await this.flush();
      return {};
    }
    const c = this.conflict;
    if (!c) return {};
    this.conflict = null;
    this.dirty = false;
    if (choice === 'mine') {
      this.diskHash = c.hash;
      this.diskBody = c.body;
      this.pending = mine;
      await this.flush();
      return {};
    }
    let copyId = null;
    if (choice === 'copy' && createCopy) copyId = await createCopy(mine);
    this.pending = null;
    this.diskHash = c.hash;
    this.diskBody = c.body;
    this.send('reload', { body: c.body });
    return { body: c.body, copyId };
  }

  dispose() {
    this.clock.clearTimeout(this.timer);
  }
}

function saveMessage(err) {
  if (err?.code === 'ENOENT') return '노트 폴더를 찾을 수 없어 저장하지 못했습니다.';
  if (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY') return '다른 프로그램이 파일을 쓰고 있어 저장하지 못했습니다. 잠시 뒤 다시 저장합니다.';
  if (err?.code === 'ENOSPC') return '디스크 공간이 부족해 저장하지 못했습니다.';
  return `저장하지 못했습니다: ${err?.message || err}`;
}

module.exports = { MemoSession };
