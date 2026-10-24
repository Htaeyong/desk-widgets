// In-app updates (#104): tells the user when the engine or an installed widget has a newer release and, only when
// the user asks, downloads the installer, checks it against products.json and opens it (Windows shows UAC).
// Nothing here installs on its own. Design and the reasons behind it: docs/updates.md.
//
// Source of truth: https://widgets.chilgong88.com/products.json, whose "download" entries (installer file, URL,
// size, SHA-256) scripts/release.js records from the exact file it uploaded to GitHub Releases.
// No Electron here: main.js passes fetch, the launcher and the paths, so everything can be unit-tested.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { checkEngineApi } = require('./widgets');
const { createStore } = require('./store');

const PRODUCTS_URL = 'https://widgets.chilgong88.com/products.json';
// Installers come only from this repository's GitHub releases...
const DOWNLOAD_PREFIX = 'https://github.com/Htaeyong/desk-widgets/releases/download/';
// ...and the hosts GitHub redirects release downloads to.
const REDIRECT_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
// Test mode only (never in packaged builds): a local server stands in for the site and GitHub.
const DEV_HOSTS = ['127.0.0.1', 'localhost'];
const MAX_REDIRECTS = 5;
const MAX_INSTALLER_BYTES = 500 * 1024 * 1024;
const MAX_PRODUCTS_BYTES = 512 * 1024;
const IDLE_TIMEOUT_MS = 60 * 1000;
const FILE_RE = /^DeskWidgets-(?:[A-Za-z0-9]+-)?Setup-\d+\.\d+\.\d+\.exe$/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEMP_FOLDER = 'desk-widgets-update';

// ---- Authenticode publisher check (SignPath, docs/code-signing.md) ----
// Off until the installers are signed. When this is turned on, verifyPublisher() must check the signature and
// the publisher of the downloaded file; until that is implemented, turning it on refuses every install.
const REQUIRE_SIGNATURE = false;
const EXPECTED_PUBLISHER = null; // e.g. the subject of the SignPath Foundation certificate, once approved

class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- versions ----------

function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** <0, 0, >0 like a sort comparator; NaN when either side is not "major.minor.patch". */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const isNewer = (latest, current) => compareVersions(latest, current) > 0;

// ---------- hosts ----------

/**
 * Whether the updater may request this URL. first: the URL from products.json (must be a release download of
 * this repository); otherwise a redirect target (a GitHub download host). dev also allows a local http server.
 */
function isAllowedDownloadUrl(url, { first = false, dev = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (dev && DEV_HOSTS.includes(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:')) return true;
  if (u.protocol !== 'https:' || u.port) return false;
  if (first) return u.href.startsWith(DOWNLOAD_PREFIX);
  return REDIRECT_HOSTS.includes(u.hostname);
}

function isAllowedProductsUrl(url, { dev = false } = {}) {
  if (url === PRODUCTS_URL) return true;
  if (!dev) return false;
  try {
    const u = new URL(url);
    return DEV_HOSTS.includes(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

// ---------- products.json ----------

/** One product entry with a usable "download", or null (no release recorded yet, or bad data). */
function productEntry(raw, { dev = false } = {}) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(raw.id || '')) return null;
  const d = raw.download;
  if (!d || typeof d !== 'object') return null;
  if (!parseVersion(d.version) || !FILE_RE.test(d.file || '')) return null;
  if (!Number.isSafeInteger(d.size) || d.size <= 0 || d.size > MAX_INSTALLER_BYTES) return null;
  if (!/^[0-9a-f]{64}$/.test(d.sha256 || '')) return null;
  if (!isAllowedDownloadUrl(d.url, { first: true, dev })) return null;
  if (decodeURIComponent(new URL(d.url).pathname.split('/').pop()) !== d.file) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    version: d.version,
    engineMin: parseVersion(raw.engineMin) ? raw.engineMin : null,
    engineApi: typeof raw.engineApi === 'string' ? raw.engineApi : null,
    download: { file: d.file, url: d.url, size: d.size, sha256: d.sha256, tag: String(d.tag || '') },
  };
}

/** products.json (parsed) -> { engine: entry | null, widgets: Map<id, entry> }. Throws on a broken shape. */
function parseProducts(json, opts = {}) {
  if (!json || typeof json !== 'object' || !json.engine || !Array.isArray(json.widgets)) {
    throw new UpdateError('products', '업데이트 정보 형식이 올바르지 않습니다.');
  }
  const engine = json.engine.id === 'engine' ? productEntry(json.engine, opts) : null;
  const widgets = new Map();
  for (const w of json.widgets) {
    const entry = productEntry(w, opts);
    if (entry && entry.id !== 'engine') widgets.set(entry.id, entry);
  }
  return { engine, widgets };
}

// ---------- what to offer ----------

/**
 * Update rows for the widget manager.
 * widgets: the engine's widget list ({ id, name, version, source }); dev folders are skipped.
 * status: 'available' | 'needs-engine' (the new widget needs a newer engine) | 'current' | 'unknown'.
 */
function computeUpdates({ products, engineVersion, engineApi, widgets = [] }) {
  const items = [];
  const row = (kind, id, name, current, entry) => {
    let status = 'unknown';
    if (entry && parseVersion(current)) status = isNewer(entry.version, current) ? 'available' : 'current';
    if (status === 'available' && kind === 'widget') {
      const engineTooOld = (entry.engineMin && isNewer(entry.engineMin, engineVersion)) || (entry.engineApi && checkEngineApi(entry.engineApi, engineApi));
      if (engineTooOld) status = 'needs-engine';
    }
    return { id, kind, name: entry?.name && kind === 'widget' ? entry.name : name, current, latest: entry?.version || null, status, engineMin: entry?.engineMin || null, download: status === 'available' ? entry.download : null };
  };
  items.push(row('engine', 'engine', 'Desk Widgets', engineVersion, products?.engine));
  const seen = new Set();
  for (const w of widgets) {
    if (!w?.id || w.source === 'dev' || seen.has(w.id)) continue;
    seen.add(w.id);
    items.push(row('widget', w.id, w.name || w.id, w.version, products?.widgets.get(w.id)));
  }
  return items;
}

// ---------- download and verify ----------

/** SHA-256 (hex) and size of a file on disk. */
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

/** Checks a downloaded file against products.json; deletes it and throws on a mismatch. */
async function verifyFile(file, { size, sha256 }) {
  const actual = await hashFile(file);
  if (actual.size !== size) {
    fs.rmSync(file, { force: true });
    throw new UpdateError('size', `내려받은 파일 크기가 다릅니다(${actual.size} / ${size} 바이트). 파일을 지웠습니다.`);
  }
  if (actual.sha256 !== sha256) {
    fs.rmSync(file, { force: true });
    throw new UpdateError('hash', '내려받은 파일이 게시된 파일과 다릅니다(SHA-256 불일치). 파일을 지웠습니다.');
  }
  return actual;
}

/**
 * Publisher check hook. Does nothing while REQUIRE_SIGNATURE is off. Once installers are signed this must verify
 * the Authenticode signature and that the publisher is EXPECTED_PUBLISHER, without PowerShell or desktop
 * automation (docs/code-signing.md). Until then, turning it on refuses the install.
 */
async function verifyPublisher(_file, { required = REQUIRE_SIGNATURE } = {}) {
  if (!required) return { checked: false };
  throw new UpdateError('signature', `설치 파일의 서명을 확인할 수 없습니다${EXPECTED_PUBLISHER ? `(${EXPECTED_PUBLISHER})` : ''}.`);
}

/**
 * Downloads url to dest (a new file) over the allowed hosts only, following redirects itself so every hop is
 * checked. Stops early when the body is larger than expected.size. Returns the dest path; on failure the partial
 * file is removed.
 */
async function downloadFile({ url, dest, expected, fetchFn = fetch, dev = false, onProgress = () => {}, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
  const controller = new AbortController();
  let idle = null;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), idleTimeoutMs);
  };
  let out = null;
  try {
    let current = url;
    let res = null;
    for (let hop = 0; ; hop++) {
      if (!isAllowedDownloadUrl(current, { first: hop === 0, dev })) {
        throw new UpdateError('host', `허용하지 않는 주소라 내려받지 않았습니다: ${safeHost(current)}`);
      }
      touch();
      try {
        res = await fetchFn(current, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'DeskWidgets-Updater' } });
      } catch (err) {
        throw new UpdateError('network', `내려받지 못했습니다(네트워크 오류: ${err.message}).`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || hop >= MAX_REDIRECTS) throw new UpdateError('http', '내려받기 주소가 올바르지 않습니다(리디렉션).');
        current = new URL(location, current).href;
        continue;
      }
      break;
    }
    if (!res.ok || !res.body) throw new UpdateError('http', `내려받지 못했습니다(HTTP ${res.status}).`);
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > expected.size) throw new UpdateError('size', '내려받을 파일이 게시된 크기보다 큽니다.');

    out = fs.createWriteStream(dest, { flags: 'wx' });
    await once(out, 'open');
    let received = 0;
    for await (const chunk of res.body) {
      touch();
      received += chunk.length;
      if (received > expected.size) throw new UpdateError('size', '내려받은 파일이 게시된 크기보다 큽니다. 파일을 지웠습니다.');
      if (!out.write(chunk)) await once(out, 'drain');
      onProgress(received, expected.size);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    out = null;
    return dest;
  } catch (err) {
    if (out && !out.closed) {
      const closed = once(out, 'close').catch(() => {});
      out.destroy();
      await closed;
    }
    fs.rmSync(dest, { force: true });
    if (err instanceof UpdateError) throw err;
    if (controller.signal.aborted) throw new UpdateError('network', '내려받기가 멈춰 중단했습니다(응답 없음).');
    throw new UpdateError('network', `내려받지 못했습니다(${err.message}).`);
  } finally {
    clearTimeout(idle);
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '알 수 없는 주소';
  }
}

// ---------- schedule ----------

/**
 * Runs check() once a little after startup and then whenever the last check is a day old. It looks every
 * tickMs (an hour) instead of waiting 24 h in one timer, so a PC that slept still checks on time.
 * isEnabled() is the engine setting; the manual button calls check() directly, not through this.
 */
class UpdateScheduler {
  constructor({ check, isEnabled, getLastCheck, initialDelayMs = 2 * 60 * 1000, tickMs = 60 * 60 * 1000, intervalMs = 24 * 60 * 60 * 1000, now = Date.now, timers = globalThis }) {
    Object.assign(this, { check, isEnabled, getLastCheck, initialDelayMs, tickMs, intervalMs, now, timers });
    this.first = null;
    this.interval = null;
  }

  start() {
    this.stop();
    this.first = this.timers.setTimeout(() => this.tick({ startup: true }), this.initialDelayMs);
    this.interval = this.timers.setInterval(() => this.tick(), this.tickMs);
    this.first?.unref?.();
    this.interval?.unref?.();
  }

  /** Whether a check is due now: always once at startup, then after intervalMs. */
  due({ startup = false } = {}) {
    if (!this.isEnabled()) return false;
    if (startup) return true;
    const last = this.getLastCheck();
    return !last || this.now() - last >= this.intervalMs;
  }

  tick(opts) {
    if (!this.due(opts)) return null;
    return Promise.resolve(this.check({ manual: false })).catch(() => {});
  }

  stop() {
    if (this.first) this.timers.clearTimeout(this.first);
    if (this.interval) this.timers.clearInterval(this.interval);
    this.first = null;
    this.interval = null;
  }
}

// ---------- manager ----------

const JOB_TEXT = { downloading: '내려받는 중', verifying: '파일 확인 중', launching: '설치 프로그램 실행 중', launched: '설치 프로그램을 실행했습니다', error: '오류' };

/**
 * Update state for the engine. Emits 'change' with snapshot().
 * deps: {
 *   engineVersion, engineApi, listWidgets() -> [{ id, name, version, source }],
 *   fetchFn, productsUrl, dev, stateFile, tempRoot,
 *   launch(file, item) -> Promise<string>  ('' when started, otherwise the error text; cancelled UAC included),
 *   onNew(items)       new versions seen for the first time (notification card),
 *   now, log
 * }
 */
class UpdateManager extends EventEmitter {
  constructor({ engineVersion, engineApi, listWidgets, fetchFn = fetch, productsUrl = PRODUCTS_URL, dev = false, stateFile, tempRoot = path.join(os.tmpdir(), TEMP_FOLDER), launch, onNew = () => {}, now = Date.now, log = (m) => console.error(m) }) {
    super();
    if (!isAllowedProductsUrl(productsUrl, { dev })) throw new Error(`Update source not allowed: ${productsUrl}`);
    Object.assign(this, { engineVersion, engineApi, listWidgets, fetchFn, productsUrl, dev, tempRoot, launch, onNew, now, log });
    this.store = createStore({ file: stateFile, defaults: { lastCheck: 0, notified: [] }, sanitize: (v) => ({ lastCheck: Number(v.lastCheck) || 0, notified: (Array.isArray(v.notified) ? v.notified : []).map(String).slice(-200) }) });
    this.products = null;
    this.items = [];
    this.error = null;
    this.checking = null;
    this.jobs = new Map(); // id -> { phase, received, total, message }
    this.progressAt = 0;
  }

  lastCheck() {
    return this.store.load().lastCheck;
  }

  /** Fetches products.json and recomputes the rows. manual: from the button (no card for what the user sees). */
  check({ manual = false } = {}) {
    if (this.checking) return this.checking;
    this.checking = this.runCheck(manual)
      .finally(() => {
        this.checking = null;
        this.changed();
      })
      .then(() => this.snapshot());
    this.changed();
    return this.checking;
  }

  async runCheck(manual) {
    try {
      const json = await this.fetchProducts();
      this.products = parseProducts(json, { dev: this.dev });
      this.error = null;
      this.recompute();
      const state = this.store.load();
      this.store.save({ lastCheck: this.now() });
      const pending = this.items.filter((i) => i.status === 'available' || i.status === 'needs-engine');
      const fresh = pending.filter((i) => !state.notified.includes(`${i.id}@${i.latest}`));
      if (fresh.length) {
        this.store.save({ notified: [...state.notified, ...fresh.map((i) => `${i.id}@${i.latest}`)] });
        if (!manual) this.onNew(fresh);
      }
    } catch (err) {
      this.error = err instanceof UpdateError ? err.message : `업데이트를 확인하지 못했습니다(${err.message}).`;
      this.log(`update check: ${err.message}`);
    }
  }

  async fetchProducts() {
    let res;
    try {
      res = await this.fetchFn(this.productsUrl, { redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json', 'User-Agent': 'DeskWidgets-Updater' } });
    } catch (err) {
      throw new UpdateError('network', `업데이트를 확인하지 못했습니다(네트워크 오류: ${err.message}).`);
    }
    if (!res.ok) throw new UpdateError('http', `업데이트를 확인하지 못했습니다(HTTP ${res.status}).`);
    const text = await res.text();
    if (text.length > MAX_PRODUCTS_BYTES) throw new UpdateError('products', '업데이트 정보가 너무 큽니다.');
    try {
      return JSON.parse(text);
    } catch {
      throw new UpdateError('products', '업데이트 정보 형식이 올바르지 않습니다.');
    }
  }

  /** Rows from the last products.json and the widgets installed now (after a widget update, no new request). */
  recompute() {
    if (!this.products) return;
    this.items = computeUpdates({ products: this.products, engineVersion: this.engineVersion, engineApi: this.engineApi, widgets: this.listWidgets() });
    // A job of a product that is now up to date (its installer finished) is done.
    for (const [id, job] of this.jobs) {
      const item = this.items.find((i) => i.id === id);
      if (job.phase === 'launched' && item?.status !== 'available') this.jobs.delete(id);
    }
    this.changed();
  }

  /** Rows with an available or needs-engine status. */
  pending() {
    return this.items.filter((i) => i.status === 'available' || i.status === 'needs-engine');
  }

  busy(id) {
    const phase = this.jobs.get(id)?.phase;
    return phase === 'downloading' || phase === 'verifying' || phase === 'launching';
  }

  /** Downloads, verifies and opens the installer of one product. Only from a user click. */
  async install(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'available' || !item.download) return { ok: false, message: '설치할 업데이트가 없습니다.' };
    if (this.busy(id)) return { ok: false, message: '이미 진행 중입니다.' };
    const job = { phase: 'downloading', received: 0, total: item.download.size, message: '' };
    this.jobs.set(id, job);
    this.changed();
    try {
      fs.mkdirSync(this.tempRoot, { recursive: true });
      const dir = fs.mkdtempSync(path.join(this.tempRoot, `${id}-`));
      const dest = path.join(dir, item.download.file);
      await downloadFile({
        url: item.download.url,
        dest,
        expected: item.download,
        fetchFn: this.fetchFn,
        dev: this.dev,
        onProgress: (received) => {
          job.received = received;
          if (this.now() - this.progressAt > 200) {
            this.progressAt = this.now();
            this.changed();
          }
        },
      });
      job.phase = 'verifying';
      this.changed();
      await verifyFile(dest, item.download);
      await verifyPublisher(dest);
      job.phase = 'launching';
      this.changed();
      const problem = await this.launch(dest, item);
      if (problem) throw new UpdateError('launch', problem);
      job.phase = 'launched';
      this.changed();
      return { ok: true, item, file: dest };
    } catch (err) {
      job.phase = 'error';
      job.message = err instanceof UpdateError ? err.message : `업데이트하지 못했습니다(${err.message}).`;
      this.log(`update ${id}: ${err.message}`);
      this.changed();
      return { ok: false, message: job.message };
    }
  }

  /** Installers of earlier runs (they may still have been running then, so they are removed at the next start). */
  cleanupTemp() {
    try {
      fs.rmSync(this.tempRoot, { recursive: true, force: true });
    } catch (err) {
      this.log(`update temp cleanup: ${err.message}`);
    }
  }

  snapshot() {
    return {
      checking: Boolean(this.checking),
      lastCheck: this.lastCheck() || null,
      error: this.error,
      checked: Boolean(this.products),
      items: this.items.map((i) => {
        const job = this.jobs.get(i.id);
        return { ...i, download: i.download ? { size: i.download.size, file: i.download.file } : null, job: job ? { ...job, text: JOB_TEXT[job.phase] } : null };
      }),
    };
  }

  changed() {
    this.emit('change', this.snapshot());
  }
}

module.exports = {
  PRODUCTS_URL,
  DOWNLOAD_PREFIX,
  REDIRECT_HOSTS,
  REQUIRE_SIGNATURE,
  TEMP_FOLDER,
  UpdateError,
  parseVersion,
  compareVersions,
  isNewer,
  isAllowedDownloadUrl,
  isAllowedProductsUrl,
  productEntry,
  parseProducts,
  computeUpdates,
  hashFile,
  verifyFile,
  verifyPublisher,
  downloadFile,
  UpdateScheduler,
  UpdateManager,
};
