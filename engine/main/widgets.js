// Widget loading. Widgets are installed separately from the engine: each one is a folder
//   <widgets folder>/<id>/widget.json   { id, name, engineApi, description?, version?, main?, settings?, package? }
//   <widgets folder>/<id>/index.js      module.exports = { create(ctx) { return instance } }
// The engine scans the widgets folder (and dev folders), watches it while running, and starts,
// stops or reloads widgets as they are installed, removed or updated. See docs/widget-dev.md.
//
// create(ctx) must be cheap (no windows, no timers). start() / stop() follow the on/off setting.
// Instance (all optional except start/stop):
//   start(), stop()                 open / close windows, start / stop work; register IPC in start()
//   setPaused(reason|null)          the user is away (locked, suspended, idle) or back
//   focus() -> boolean              bring the main window forward
//   desktopWindows() -> BrowserWindow[]   windows kept on the desktop after Win+D
//   needsSetup() -> boolean         its settings window opens right after it starts (e.g. no API token yet)
//   settings: { get() -> values, save(values) -> { ok, message? }, handlers?: { name(...args) } }
//
// ctx: { id, dir, dataDir, manifest, handle(channel, fn), onStop(fn), setTrayItems(items), ...engine services (main.js) }
// Handlers, cleanups and tray items registered through ctx are removed when the widget stops.
const fs = require('fs');
const path = require('path');

// Version of the ctx API widgets are written against. Minor = additions only; major = breaking.
// 1.1: notification card menu (ctx.notify(..., { menu })).
// 1.2: generic notification cards (ctx.notify([{ type: 'card', ... }], { onAction })).
// 1.3: per-theme background opacity in ctx.useThemes (settingsHandlers().liveOpacity, host.applyBackground(), #55);
//      a theme host per widget with the widget's own theme contract (ctx.useThemes({ methods, events, ... }), widget.json "themes", #57).
// 1.4: the notification card menu also on generic cards (ctx.notify([{ type: 'card', tag, ... }], { menu }), #71).
// 1.5: ctx.system.createSampler() and isWindowCovered() keep native Windows measurements/occlusion in the engine (#74).
// 1.6: ctx.integrations brokers explicitly allowed widget calls and change events (#94).
// 1.7: the to-do notes widget 할 일 노트 takes the to-do side (#111): routes to "todonote" (notes.addExternal / snapshot / updateDue /
//      open, event notes.changed) next to the to-do widget's, which stay; ctx.integrations.importLegacy('todo')
//      hands the to-do widget's lists and tasks to 할 일 노트 (read only, on the user's click).
// 1.8: engine-central storage for personal cloud sync (#108): ctx.createStore({ sync }) with per-field shared or
//      PC-only marks and store.onRemoteChange, ctx.files.open() for note folders, ctx.secrets.open() for DPAPI secrets.
// 1.9: ctx.setTrayItems([{ id, label, click }], { settings }) adds a running widget's own items to the tray menu (#118);
//      settings: false leaves out its "<name> 설정" item there.
const ENGINE_API = '1.9';
const TRAY_ITEMS_MAX = 3;
const TRAY_LABEL_MAX = 24;

const INTEGRATION_CALLS = Object.freeze({
  dooray: { todo: ['tasks.addExternal'], todonote: ['notes.addExternal', 'notes.open'] },
  mail: { todo: ['tasks.addExternal'], todonote: ['notes.addExternal', 'notes.open'] },
  calendar: { todo: ['tasks.snapshot', 'tasks.updateDue'], todonote: ['notes.snapshot', 'notes.updateDue', 'notes.open'] },
});
const INTEGRATION_EVENTS = Object.freeze({ todo: { calendar: ['tasks.changed'] }, todonote: { calendar: ['notes.changed'] } });
// Imports (#111, design 9.4): which widget may read which other widget's data, through the engine. The engine reads
// the file itself (widgets never read each other's files, #94) and hands over a cleaned copy; it never writes it.
const INTEGRATION_IMPORTS = Object.freeze({ todonote: { todo: legacyTodo } });
const INTEGRATION_MAX_BYTES = 2 * 1024 * 1024;
const INTEGRATION_TIMEOUT_MS = 10000;

/**
 * The to-do widget's settings.json (widgets/todo/lib/model.js shape) as plain lists and tasks, cleaned
 * like that widget does: { lists: [{ id, name }], tasks: [{ id, listId, title, dueAt, dateOnly, repeatWeekday,
 * completedAt, source }] }. Unknown fields (window places, themes, reminder state) are left out.
 */
function legacyTodo(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v) ? v : null);
  const text = (v, n) => String(v ?? '').trim().slice(0, n);
  const time = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
  const lists = [];
  for (const l of Array.isArray(src.lists) ? src.lists : []) {
    if (!id(l?.id) || lists.some((x) => x.id === l.id) || lists.length >= 30) continue;
    lists.push({ id: l.id, name: text(l.name, 60) });
  }
  const tasks = [];
  for (const t of Array.isArray(src.tasks) ? src.tasks : []) {
    if (!id(t?.id) || !lists.some((l) => l.id === t.listId) || tasks.some((x) => x.id === t.id) || tasks.length >= 2000) continue;
    const title = text(t.title, 240);
    if (!title) continue;
    const dueAt = time(t.dueAt);
    const s = t.source;
    const source = s && ['dooray', 'mail'].includes(s.widgetId) && typeof s.itemId === 'string' && s.itemId
      ? { widgetId: s.widgetId, itemId: text(s.itemId, 256), url: typeof s.url === 'string' && /^https:\/\//i.test(s.url) ? s.url.slice(0, 2048) : null }
      : null;
    tasks.push({
      id: t.id,
      listId: t.listId,
      title,
      dueAt,
      dateOnly: Boolean(t.dateOnly && dueAt),
      repeatWeekday: Number.isInteger(t.repeatWeekday) && t.repeatWeekday >= 0 && t.repeatWeekday <= 6 && dueAt ? t.repeatWeekday : null,
      completedAt: time(t.completedAt),
      source,
    });
  }
  return { lists, tasks };
}

function integrationCopy(value) {
  try {
    const json = JSON.stringify(value === undefined ? null : value);
    if (Buffer.byteLength(json, 'utf8') > INTEGRATION_MAX_BYTES) return { code: 'payload-too-large' };
    return { value: JSON.parse(json) };
  } catch {
    return { code: 'invalid-payload' };
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[\w./-]+$/;
const API_RE = /^(\d+)\.(\d+)$/;

/**
 * Checks a widget's "engineApi" ("<major>.<minor>": the API it was written for) against the
 * engine's. Compatible when the majors match and the engine's minor is at least the widget's.
 * @returns {string | null} a message for the user when incompatible
 */
function checkEngineApi(required, engineApi = ENGINE_API) {
  const want = API_RE.exec(String(required ?? ''));
  const have = API_RE.exec(engineApi);
  if (!want) return '위젯 정보(widget.json)에 필요한 엔진 API 버전(engineApi)이 없습니다. 위젯을 업데이트하세요.';
  const [wMajor, wMinor] = [Number(want[1]), Number(want[2])];
  const [hMajor, hMinor] = [Number(have[1]), Number(have[2])];
  if (wMajor > hMajor || (wMajor === hMajor && wMinor > hMinor)) {
    return `이 위젯에는 엔진 API ${required} 이상이 필요합니다(현재 Desk Widgets는 ${engineApi}). Desk Widgets를 업데이트하세요.`;
  }
  if (wMajor < hMajor) {
    return `이 위젯은 이전 엔진 API ${required}용입니다(현재 Desk Widgets는 ${engineApi}). 위젯을 업데이트하세요.`;
  }
  return null;
}

/** Validates widget.json. Returns { manifest, errors }; manifest is null when unusable. */
function validateWidgetManifest(raw, folderName) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { manifest: null, errors: ['widget.json is not an object'] };
  if (!ID_RE.test(raw.id || '')) errors.push('id must be lowercase letters, digits and dashes');
  else if (folderName !== undefined && raw.id !== folderName) errors.push(`id "${raw.id}" must match the folder name "${folderName}"`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push('name is required');
  const main = raw.main ?? 'index.js';
  if (!FILE_RE.test(main) || main.includes('..')) errors.push('main must be a relative file name');
  let settings = null;
  if (raw.settings !== undefined) {
    const s = raw.settings || {};
    if (!s.html || !s.script) errors.push('settings needs html and script');
    for (const k of ['html', 'script', 'style'].filter((k) => s[k] !== undefined)) {
      if (!FILE_RE.test(s[k]) || s[k].includes('..')) errors.push(`settings.${k} must be a relative file name`);
    }
    settings = { html: s.html, script: s.script, style: s.style || null };
  }
  if (errors.length) return { manifest: null, errors };
  // #57: a widget whose look comes from theme packages ({ contract, contractVersions, default }). Defaults for
  // ctx.useThemes; an invalid value is dropped (the widget's own ctx.useThemes options still apply).
  let themes = null;
  if (raw.themes && typeof raw.themes === 'object' && !Array.isArray(raw.themes)) {
    const t = raw.themes;
    themes = {
      contract: ID_RE.test(t.contract || '') ? t.contract : raw.id,
      contractVersions: Array.isArray(t.contractVersions) ? t.contractVersions.filter((v) => Number.isInteger(v) && v > 0) : [1],
      default: ID_RE.test(t.default || '') ? t.default : null,
    };
    if (!themes.contractVersions.length) themes.contractVersions = [1];
  }
  const integrationCapabilities = Array.isArray(raw.integrationCapabilities)
    ? raw.integrationCapabilities.filter((name) => typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(name))
    : [];
  return {
    manifest: {
      id: raw.id,
      name: raw.name.trim(),
      description: String(raw.description || ''),
      version: String(raw.version || ''),
      engineApi: raw.engineApi === undefined ? null : String(raw.engineApi),
      // A widget seen for the first time starts right away unless it says otherwise.
      defaultEnabled: raw.defaultEnabled !== false,
      order: Number.isFinite(raw.order) ? raw.order : 100,
      main,
      settings,
      themes,
      integrationCapabilities: [...new Set(integrationCapabilities)],
    },
    errors,
  };
}

function readWidgetFolder(folder, source) {
  const file = path.join(folder, 'widget.json');
  let raw;
  let stamp = 0;
  try {
    stamp = fs.statSync(file).mtimeMs;
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { dir: folder, source, stamp, manifest: null, errors: [`widget.json을 읽을 수 없습니다: ${err.message}`] };
  }
  const result = validateWidgetManifest(raw, path.basename(folder));
  return { dir: folder, source, stamp, ...result };
}

/**
 * Finds widgets in `dirs` (folders holding <id>/widget.json) and `folders` (single widget
 * folders, e.g. a widget under development). Later entries win when ids collide.
 */
function discoverWidgets({ dirs = [], folders = [] } = {}) {
  const found = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'widget.json'))) found.push(readWidgetFolder(path.join(dir, d.name), 'installed'));
    }
  }
  for (const folder of folders) if (folder && fs.existsSync(path.join(folder, 'widget.json'))) found.push(readWidgetFolder(path.resolve(folder), 'dev'));
  // One entry per id (dev folders override installed ones); unreadable ones are kept by folder.
  const byKey = new Map();
  for (const f of found) byKey.set(f.manifest ? f.manifest.id : `broken:${f.dir}`, f);
  return [...byKey.values()].sort((a, b) => (a.manifest?.order ?? 999) - (b.manifest?.order ?? 999) || a.dir.localeCompare(b.dir));
}

/**
 * A widget's tray items (#118), cleaned: at most TRAY_ITEMS_MAX, unique ids, short one-line labels, a click function.
 * Anything else is left out.
 * @returns {{ id: string, label: string, click: Function }[]}
 */
function cleanTrayItems(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.replace(/\s+/g, ' ').trim().slice(0, TRAY_LABEL_MAX) : '';
    if (!id || !label || typeof item.click !== 'function' || out.some((x) => x.id === id)) continue;
    out.push({ id, label, click: item.click });
    if (out.length >= TRAY_ITEMS_MAX) break;
  }
  return out;
}

/** Forgets the cached modules of a widget folder so a reinstalled version loads fresh. */
function purgeModules(dir, cache = require.cache) {
  const prefix = path.resolve(dir) + path.sep;
  for (const key of Object.keys(cache)) if (key.startsWith(prefix)) delete cache[key];
}

class WidgetHost {
  /**
   * @param {{ sources: () => { dirs: string[], folders: string[] }, dataDir: (id: string) => string,
   *           getEnabledMap: () => object, services?: (ctx: object) => object, ipc?: { handle, removeHandler },
   *           load?: (file: string) => object, purge?: (dir: string) => void, engineApi?: string, engineVersion?: string,
   *           log?: (msg: string) => void, onTrayChange?: () => void }} opts
   *   getEnabledMap returns the engine setting { [id]: { enabled } }; services adds engine features to each ctx;
   *   onTrayChange is called when a running widget's tray items change (main.js rebuilds the tray menu).
   */
  constructor({ sources, dataDir, getEnabledMap, services = () => ({}), ipc, load = require, purge = purgeModules, engineApi = ENGINE_API, engineVersion = require('../../package.json').version, log = (m) => console.error(m), onTrayChange = () => {} }) {
    this.sources = sources;
    this.dataDir = dataDir;
    this.getEnabledMap = getEnabledMap;
    this.services = services;
    this.ipc = ipc || require('electron').ipcMain;
    this.load = load;
    this.purge = purge;
    this.engineApi = engineApi;
    this.engineVersion = engineVersion;
    this.log = log;
    this.onTrayChange = onTrayChange;
    this.widgets = new Map(); // id -> record of a loaded widget
    this.blocked = []; // found but not loadable: { id?, name?, version?, dir, status: 'incompatible' | 'error', message }
    this.integrationListeners = new Set();
    this.integrationStatusListeners = new Set();
  }

  /** First scan. */
  init() {
    this.rescan();
    return this;
  }

  /**
   * Re-reads the widget folders. New widgets are created, removed ones stopped and dropped,
   * changed ones (widget.json rewritten by an installer) stopped and recreated.
   * Call sync() afterwards to start what should run.
   * @returns {{ added: string[], removed: string[], updated: string[] }}
   */
  rescan() {
    const found = discoverWidgets(this.sources());
    const seen = new Set();
    const result = { added: [], removed: [], updated: [] };
    this.blocked = [];

    for (const f of found) {
      if (!f.manifest) {
        this.blocked.push({ dir: f.dir, status: 'error', message: f.errors.join('; ') });
        continue;
      }
      const { manifest } = f;
      const problem = checkEngineApi(manifest.engineApi, this.engineApi);
      if (problem) {
        this.blocked.push({ id: manifest.id, name: manifest.name, version: manifest.version, dir: f.dir, status: 'incompatible', message: problem });
        continue;
      }
      seen.add(manifest.id);
      const current = this.widgets.get(manifest.id);
      if (current && current.dir === f.dir && current.stamp === f.stamp) continue;
      if (current) {
        this.unload(manifest.id);
        result.updated.push(manifest.id);
      }
      if (this.loadWidget(f) && !current) result.added.push(manifest.id);
    }
    for (const id of [...this.widgets.keys()]) {
      if (!seen.has(id)) {
        this.unload(id);
        result.removed.push(id);
      }
    }
    return result;
  }

  loadWidget({ manifest, dir, source, stamp }) {
    const record = { manifest, dir, source, stamp, instance: null, running: false, cleanups: [], channels: new Set(), integrationHandlers: new Map(), integrationOptIns: new Map(), trayItems: [], traySettings: true };
    record.ctx = this.makeContext(record);
    try {
      const mod = this.load(path.join(dir, manifest.main));
      if (typeof mod?.create !== 'function') throw new Error('module must export create(ctx)');
      record.instance = mod.create(record.ctx);
      if (typeof record.instance?.start !== 'function' || typeof record.instance?.stop !== 'function') {
        throw new Error('create(ctx) must return { start, stop }');
      }
    } catch (err) {
      this.purge(dir);
      this.blocked.push({ id: manifest.id, name: manifest.name, version: manifest.version, dir, status: 'error', message: err.message });
      this.log(`widget ${manifest.id}: ${err.stack || err.message}`);
      return false;
    }
    this.widgets.set(manifest.id, record);
    return true;
  }

  unload(id) {
    const record = this.widgets.get(id);
    if (!record) return;
    this.stop(id);
    this.widgets.delete(id);
    this.purge(record.dir);
    this.notifyIntegrationStatus(id);
  }

  makeContext(record) {
    const ctx = {
      id: record.manifest.id,
      manifest: record.manifest,
      dir: record.dir,
      dataDir: this.dataDir(record.manifest.id),
      handle: (channel, fn) => {
        this.ipc.handle(channel, fn);
        record.channels.add(channel);
      },
      // Returns a function that takes the cleanup back (a window closed before the widget stopped, #109).
      onStop: (fn) => {
        record.cleanups.push(fn);
        return () => {
          const i = record.cleanups.indexOf(fn);
          if (i >= 0) record.cleanups.splice(i, 1);
        };
      },
      // 1.9 (#118): replaces this widget's tray items; [] removes them. Only while running; the engine drops them on stop.
      // options.settings === false: no "<name> 설정" item in the tray for this widget (its own items cover it).
      setTrayItems: (items, options = {}) => {
        if (this.widgets.get(record.manifest.id) !== record || !record.running) return false;
        record.trayItems = cleanTrayItems(items);
        record.traySettings = options?.settings !== false;
        this.trayChanged();
        return true;
      },
      integrations: this.integrationContext(record),
    };
    return Object.assign(ctx, this.services(ctx));
  }

  isEnabled(id) {
    const record = this.widgets.get(id);
    if (!record) return false;
    const saved = this.getEnabledMap()?.[id];
    return saved ? Boolean(saved.enabled) : record.manifest.defaultEnabled;
  }

  /** The broker uses the context's record identity to reject calls from a stopped or replaced widget. */
  integrationContext(record) {
    const sourceId = record.manifest.id;
    const active = () => this.widgets.get(sourceId) === record && record.running;
    return Object.freeze({
      status: (targetId) => this.integrationStatus(targetId, sourceId),
      setEnabled: (peerId, on) => {
        if (!active() || !this.canObserve(sourceId, peerId)) return false;
        const enabled = Boolean(on);
        if (record.integrationOptIns.get(peerId) === enabled) return true;
        record.integrationOptIns.set(peerId, enabled);
        this.notifyIntegrationStatus(sourceId);
        return true;
      },
      expose: (method, handler) => {
        if (!active() || typeof handler !== 'function' || !this.canReceive(sourceId, method)) return false;
        record.integrationHandlers.set(method, handler);
        return true;
      },
      call: async (targetId, method, payload) => {
        if (!active()) return { ok: false, code: 'source-unavailable' };
        if (!INTEGRATION_CALLS[sourceId]?.[targetId]?.includes(method)) return { ok: false, code: 'route-denied' };
        const target = this.widgets.get(targetId);
        if (!target?.running) return { ok: false, code: 'target-unavailable' };
        const handler = target.integrationHandlers.get(method);
        if (!handler) return { ok: false, code: 'method-unavailable' };
        const input = integrationCopy(payload);
        if (input.code) return { ok: false, code: input.code };
        let timer = null;
        try {
          const answer = await Promise.race([
            Promise.resolve().then(() => handler(input.value, { sourceId })),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), INTEGRATION_TIMEOUT_MS); }),
          ]);
          const result = integrationCopy(answer);
          return result.code ? { ok: false, code: result.code } : result.value;
        } catch (error) {
          this.log(`integration ${sourceId} -> ${targetId}.${method}: ${error.stack || error.message}`);
          return { ok: false, code: 'handler-failed' };
        } finally {
          clearTimeout(timer);
        }
      },
      publish: (event, payload) => {
        if (!active() || !INTEGRATION_EVENTS[sourceId] || !Object.values(INTEGRATION_EVENTS[sourceId]).some((events) => events.includes(event))) return false;
        const copy = integrationCopy(payload);
        if (copy.code) return false;
        for (const item of [...this.integrationListeners]) {
          if (item.sourceId !== sourceId || item.event !== event || !active() || !item.active()) continue;
          Promise.resolve().then(() => item.active() && item.handler(integrationCopy(copy.value).value))
            .catch((error) => this.log(`integration event ${sourceId}.${event}: ${error.message}`));
        }
        return true;
      },
      onEvent: (targetId, event, handler) => {
        if (!active() || typeof handler !== 'function' || !INTEGRATION_EVENTS[targetId]?.[sourceId]?.includes(event)) return () => {};
        const item = { sourceId: targetId, event, handler, active };
        this.integrationListeners.add(item);
        const remove = () => this.integrationListeners.delete(item);
        record.cleanups.push(remove);
        return remove;
      },
      importLegacy: async (widgetId) => {
        const clean = INTEGRATION_IMPORTS[sourceId]?.[widgetId];
        if (!active()) return { ok: false, code: 'source-unavailable' };
        if (!clean) return { ok: false, code: 'route-denied' };
        let raw;
        try {
          raw = JSON.parse(await fs.promises.readFile(path.join(this.dataDir(widgetId), 'settings.json'), 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') return { ok: true, result: { lists: [], tasks: [] }, installed: false };
          this.log(`integration import ${sourceId} <- ${widgetId}: ${error.message}`);
          return { ok: false, code: 'unreadable' };
        }
        const copy = integrationCopy(clean(raw));
        return copy.code ? { ok: false, code: copy.code } : { ok: true, result: copy.value };
      },
      onStatus: (targetId, handler) => {
        if (!active() || typeof handler !== 'function' || !this.canObserve(sourceId, targetId)) return () => {};
        const item = { targetId, observerId: sourceId, handler, active };
        this.integrationStatusListeners.add(item);
        const remove = () => this.integrationStatusListeners.delete(item);
        record.cleanups.push(remove);
        return remove;
      },
    });
  }

  canReceive(targetId, method) {
    return Object.values(INTEGRATION_CALLS).some((targets) => targets[targetId]?.includes(method));
  }

  canObserve(sourceId, targetId) {
    return Boolean(INTEGRATION_CALLS[sourceId]?.[targetId]
      || INTEGRATION_CALLS[targetId]?.[sourceId]
      || INTEGRATION_EVENTS[sourceId]?.[targetId]
      || INTEGRATION_EVENTS[targetId]?.[sourceId]);
  }

  notifyIntegrationStatus(targetId) {
    for (const item of [...this.integrationStatusListeners]) {
      if (item.targetId !== targetId || !item.active()) continue;
      const status = this.integrationStatus(targetId, item.observerId);
      Promise.resolve().then(() => item.handler(status)).catch((error) => this.log(`integration status ${targetId}: ${error.message}`));
    }
  }

  integrationStatus(id, observerId) {
    if (!this.canObserve(observerId, id)) return { installed: false, enabled: false, running: false, peerEnabled: false,
      version: null, engineVersion: this.engineVersion, engineApi: this.engineApi, requiredEngineApi: null,
      brokerAvailable: true, capabilities: [] };
    const record = this.widgets.get(id);
    const blocked = this.blocked.find((item) => item.id === id);
    return {
      installed: Boolean(record || blocked),
      enabled: record ? this.isEnabled(id) : false,
      running: Boolean(record?.running),
      version: record?.manifest.version || blocked?.version || null,
      engineVersion: this.engineVersion,
      engineApi: this.engineApi,
      requiredEngineApi: record?.manifest.engineApi || null,
      brokerAvailable: true,
      peerEnabled: Boolean(record?.running && record.integrationOptIns.get(observerId)),
      capabilities: record ? [...new Set([...record.manifest.integrationCapabilities, ...record.integrationHandlers.keys()])] : [],
    };
  }

  /** Every widget found, loadable or not, for the widget manager. */
  list() {
    const loaded = [...this.widgets.values()].map(({ manifest, running, source, dir, instance }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      source,
      dir,
      enabled: this.isEnabled(manifest.id),
      status: running ? 'running' : 'off',
      message: null,
      hasSettings: Boolean(manifest.settings && instance.settings),
    }));
    const blocked = this.blocked.map((b) => ({ ...b, name: b.name || path.basename(b.dir), enabled: false, hasSettings: false }));
    return [...loaded, ...blocked];
  }

  get(id) {
    return this.widgets.get(id) || null;
  }

  running() {
    return [...this.widgets.values()].filter((r) => r.running);
  }

  async start(id) {
    const record = this.widgets.get(id);
    if (!record || record.running) return;
    record.running = true;
    try {
      await record.instance.start();
      this.notifyIntegrationStatus(id);
    } catch (err) {
      this.log(`widget ${id} failed to start: ${err.stack || err.message}`);
      this.stop(id);
    }
  }

  stop(id) {
    const record = this.widgets.get(id);
    if (!record || !record.running) return;
    record.running = false;
    try {
      record.instance.stop();
    } catch (err) {
      this.log(`widget ${id} failed to stop cleanly: ${err.message}`);
    }
    for (const fn of record.cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (err) {
        this.log(`widget ${id} cleanup: ${err.message}`);
      }
    }
    for (const channel of record.channels) this.ipc.removeHandler(channel);
    record.channels.clear();
    record.integrationHandlers.clear();
    record.integrationOptIns.clear();
    if (record.trayItems.length || !record.traySettings) {
      record.trayItems = [];
      record.traySettings = true;
      this.trayChanged();
    }
    this.notifyIntegrationStatus(id);
  }

  /** Starts or stops widgets to match the on/off setting. */
  async sync() {
    for (const id of this.widgets.keys()) if (this.isEnabled(id)) await this.start(id);
    for (const id of this.widgets.keys()) if (!this.isEnabled(id)) this.stop(id);
  }

  stopAll() {
    for (const id of this.widgets.keys()) this.stop(id);
  }

  // ---------- engine features spread over the running widgets ----------

  desktopWindows() {
    return this.running().flatMap((r) => r.instance.desktopWindows?.() || []);
  }

  setPaused(reason) {
    for (const r of this.running()) r.instance.setPaused?.(reason);
  }

  /** Focuses the first running widget that has a main window. */
  focusAny() {
    return this.running().some((r) => r.instance.focus?.());
  }

  /**
   * The running widgets' own tray items (#118), in widget order. A click that throws or rejects is logged.
   * @returns {{ widgetId: string, id: string, label: string, click: () => void }[]}
   */
  trayItems() {
    return this.running().flatMap((r) => r.trayItems.map(({ id, label, click }) => ({
      widgetId: r.manifest.id,
      id,
      label,
      click: () => {
        if (!r.running) return;
        Promise.resolve().then(() => click()).catch((err) => this.log(`widget ${r.manifest.id} tray ${id}: ${err.stack || err.message}`));
      },
    })));
  }

  /** Whether the tray shows "<name> 설정" for this widget (#118: a widget can leave it out with setTrayItems). */
  traySettings(id) {
    return this.widgets.get(id)?.traySettings !== false;
  }

  trayChanged() {
    try {
      this.onTrayChange();
    } catch (err) {
      this.log(`tray: ${err.message}`);
    }
  }

  needsSetup(id) {
    const record = this.widgets.get(id);
    return Boolean(record?.running && record.instance.needsSetup?.());
  }

  /** A settings-window call: settings.handlers[name] of that widget. */
  async callSettings(id, name, args = []) {
    const handler = this.widgets.get(id)?.instance.settings?.handlers?.[name];
    if (typeof handler !== 'function') throw new Error(`Unknown settings call ${id}.${name}`);
    return handler(...args);
  }
}

/**
 * Watches the widgets folders and calls onChange (debounced) when something inside changes.
 * A missing folder is checked again every `pollMs` until it exists (the engine installer creates it).
 */
class WidgetWatcher {
  constructor({ dirs, onChange, debounceMs = 1500, pollMs = 15000, watch = fs.watch }) {
    this.dirs = dirs;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.pollMs = pollMs;
    this.watch = watch;
    this.watchers = new Map();
    this.timer = null;
    this.poller = null;
  }

  start() {
    this.attach();
    this.poller = setInterval(() => this.attach(), this.pollMs);
    this.poller.unref?.();
  }

  attach() {
    for (const dir of this.dirs) {
      if (this.watchers.has(dir) || !fs.existsSync(dir)) continue;
      try {
        const w = this.watch(dir, { recursive: true }, () => this.changed());
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
        this.changed(); // the folder may have appeared with widgets already in it
      } catch {
        // not watchable right now; the poller tries again
      }
    }
  }

  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onChange(), this.debounceMs);
  }

  stop() {
    clearInterval(this.poller);
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}

module.exports = { WidgetHost, WidgetWatcher, discoverWidgets, validateWidgetManifest, checkEngineApi, purgeModules, legacyTodo, cleanTrayItems, ENGINE_API };
