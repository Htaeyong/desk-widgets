// First-run widget picker (#96): choose widgets and install them one after another through the in-app update path
// (UpdateManager.install: allowed hosts, size and SHA-256 check, then the installer opens and Windows shows UAC).
// Nothing installs without the user's click. Design: docs/bundle-install-design.md.
// No Electron here: main.js passes the dialog, the launcher and the settings, so everything can be unit-tested.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { FILE_RE, MAX_INSTALLER_BYTES, UpdateError, hashFile, verifyPublisher } = require('./updates');

// Checked by default: widgets that need no account (docs/policies.md, #96). Only used when they are offered.
// #117: 할 일 노트 instead of 스티키 노트, which was merged into it.
const DEFAULT_CHECKED = ['clock', 'calendar', 'todonote'];
const WIDGET_FILE_RE = /^DeskWidgets-(?!Setup-)[A-Za-z0-9]+-Setup-\d+\.\d+\.\d+\.exe$/;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1000;
const SETTLED = ['done', 'failed', 'stalled', 'skipped'];

const STATE_TEXT = {
  queued: '대기 중',
  working: '내려받는 중',
  waiting: '관리자 확인 창에서 "예"를 눌러 설치하세요. 설치가 끝나면 자동으로 나타납니다.',
  done: '설치했습니다',
  failed: '실패',
  stalled: '설치가 끝나지 않았습니다. 관리자 확인 창을 취소했다면 다시 시도하세요.',
  skipped: '건너뜀',
};

/**
 * deps: {
 *   updates: UpdateManager, listWidgets(),
 *   isFirstRun() -> bool       (no widget installed and not asked before),
 *   pickFile() -> Promise<string|null>, confirmUnverified() -> Promise<bool>  (installer file from disk),
 *   sleep(ms), waitTimeoutMs, pollMs, log
 * }
 */
class WidgetPicker extends EventEmitter {
  constructor({ updates, listWidgets, isFirstRun = () => false, pickFile = async () => null, confirmUnverified = async () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitTimeoutMs = WAIT_TIMEOUT_MS, pollMs = POLL_MS, log = (m) => console.error(m) }) {
    super();
    Object.assign(this, { updates, listWidgets, isFirstRun, pickFile, confirmUnverified, sleep, waitTimeoutMs, pollMs, log });
    this.queue = []; // { id, name, state, message }
    this.running = null;
    this.loading = false;
    this.loaded = false;
    this.localMessage = '';
    this.skips = new Set();
    updates.on('change', () => this.changed());
  }

  /** Fetches products.json (same request as the update check) so the rows are current. */
  async load() {
    this.loading = true;
    this.changed();
    try {
      await this.updates.check({ manual: true });
    } finally {
      this.loading = false;
      this.loaded = true;
      this.changed();
    }
    return this.snapshot();
  }

  installed(id) {
    return this.listWidgets().some((w) => w?.id === id);
  }

  /** Installs the chosen widgets one at a time (one UAC each). Ids that are not offerable are ignored. */
  start(ids) {
    const offered = new Map(this.updates.catalog().filter((r) => r.status === 'available').map((r) => [r.id, r]));
    for (const id of [...new Set(ids.map(String))]) {
      const row = offered.get(id);
      if (!row) continue;
      const existing = this.queue.find((q) => q.id === id);
      if (existing && !SETTLED.includes(existing.state)) continue;
      if (existing) Object.assign(existing, { state: 'queued', message: '' });
      else this.queue.push({ id, name: row.name, state: 'queued', message: '' });
    }
    this.changed();
    return this.run();
  }

  retry(id) {
    return this.start([String(id)]);
  }

  /** Stops waiting for the installer of this widget (the user cancelled UAC) and goes on with the next one. */
  skip(id) {
    const item = this.queue.find((q) => q.id === String(id));
    if (!item) return;
    if (item.state === 'queued') {
      item.state = 'skipped';
      this.changed();
    } else if (item.state === 'waiting') {
      this.skips.add(item.id);
    }
  }

  run() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        for (let item; (item = this.queue.find((q) => q.state === 'queued')); ) await this.installOne(item);
      } finally {
        this.running = null;
        this.changed();
      }
    })();
    return this.running;
  }

  async installOne(item) {
    this.skips.delete(item.id);
    item.state = 'working';
    item.message = '';
    this.changed();
    const result = await this.updates.install(item.id);
    if (!result.ok) {
      item.state = 'failed';
      item.message = result.message;
      this.changed();
      return;
    }
    item.state = 'waiting';
    this.changed();
    // The installer reports itself (--widget-installed) and the engine's folder watcher loads the widget.
    for (let waited = 0; ; waited += this.pollMs) {
      if (this.installed(item.id)) {
        item.state = 'done';
        break;
      }
      if (this.skips.delete(item.id)) {
        item.state = 'skipped';
        break;
      }
      if (waited >= this.waitTimeoutMs) {
        item.state = 'stalled';
        break;
      }
      await this.sleep(this.pollMs);
    }
    this.changed();
  }

  /**
   * An installer file the user already downloaded (no internet needed). Only a widget installer by its file name.
   * With a current products.json it must be the published file (SHA-256); without one the file cannot be checked
   * and the user must confirm. The file is copied first so what was checked is what runs.
   */
  async openLocalInstaller() {
    const picked = await this.pickFile();
    if (!picked) return { ok: false, cancelled: true };
    const fail = (message) => {
      this.localMessage = message;
      this.changed();
      return { ok: false, message };
    };
    let dir = null;
    try {
      const base = path.basename(picked);
      if (!WIDGET_FILE_RE.test(base) || !FILE_RE.test(base)) return fail('위젯 설치 파일(DeskWidgets-<위젯>-Setup-<버전>.exe)이 아닙니다.');
      const stat = fs.statSync(picked);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_INSTALLER_BYTES) return fail('설치 파일 크기가 올바르지 않습니다.');
      fs.mkdirSync(this.updates.tempRoot, { recursive: true });
      dir = fs.mkdtempSync(path.join(this.updates.tempRoot, 'local-'));
      const copy = path.join(dir, base);
      fs.copyFileSync(picked, copy, fs.constants.COPYFILE_EXCL);
      const { sha256 } = await hashFile(copy);
      const known = this.updates.products ? [...this.updates.products.widgets.values()] : null;
      if (known) {
        if (!known.some((w) => w.download.sha256 === sha256)) {
          fs.rmSync(dir, { recursive: true, force: true });
          return fail('이 파일은 현재 게시된 위젯 설치 파일과 다릅니다. 다운로드 페이지의 최신 파일을 받으세요.');
        }
      } else if (!(await this.confirmUnverified())) {
        fs.rmSync(dir, { recursive: true, force: true });
        return fail('게시된 파일과 비교할 수 없어 설치하지 않았습니다.');
      }
      await verifyPublisher(copy);
      const problem = await this.updates.launch(copy, { kind: 'widget', id: 'local' });
      if (problem) return fail(problem);
      this.localMessage = '설치 프로그램을 실행했습니다. 설치가 끝나면 위젯이 나타납니다.';
      this.changed();
      return { ok: true };
    } catch (err) {
      this.log(`picker local installer: ${err.message}`);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      return fail(err instanceof UpdateError ? err.message : `설치 파일을 열지 못했습니다(${err.message}).`);
    }
  }

  snapshot() {
    const rows = this.updates.products ? this.updates.catalog().map((r) => ({ ...r, checked: DEFAULT_CHECKED.includes(r.id) && r.status === 'available' })) : [];
    return {
      firstRun: this.isFirstRun(),
      loading: this.loading,
      loaded: this.loaded,
      error: this.updates.products ? null : this.updates.error,
      rows,
      queue: this.queue.map((q) => ({ ...q, text: STATE_TEXT[q.state] })),
      running: Boolean(this.running),
      localMessage: this.localMessage,
    };
  }

  changed() {
    this.emit('change', this.snapshot());
  }
}

module.exports = { WidgetPicker, DEFAULT_CHECKED, WIDGET_FILE_RE, STATE_TEXT };
