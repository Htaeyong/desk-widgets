// Local-folder sync core. Each device writes only its own state file; records use stable hashes and Lamport revisions.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FORMAT = 2;
const CLOUD_FOLDER = 'Desk Widgets Sync';
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const DEFAULT_UNDO_DAYS = 30;
const DEFAULT_TOMBSTONE_DAYS = 180;
const RETRY_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);
const DELETED_HASH = 'sha256:' + crypto.createHash('sha256').update('deleted').digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashValue(value) {
  return 'sha256:' + crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(a, b) {
  if (!a || !b) return !a && !b;
  return a.deleted === b.deleted && a.hash === b.hash;
}

function record(key, value, deleted, n, device, now) {
  return {
    key,
    rev: { n, device },
    updatedAt: now(),
    hash: deleted ? DELETED_HASH : hashValue(value),
    deleted,
    ...(deleted ? {} : { value: clone(value) }),
  };
}

function validRecord(key, item) {
  if (!item || item.key !== key || !item.rev || !Number.isSafeInteger(item.rev.n) || item.rev.n < 1 ||
      !/^d-[a-f0-9]{8,64}$/.test(item.rev.device) || typeof item.deleted !== 'boolean') return false;
  if (item.deleted) return item.hash === DELETED_HASH && !Object.hasOwn(item, 'value');
  return Object.hasOwn(item, 'value') && item.hash === hashValue(item.value);
}

function validName(name) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

function validKey(key) {
  if (typeof key !== 'string' || key.length > 512) return false;
  const parts = key.split('/');
  return parts.length >= 3 && validName(parts[0]) && /^[a-zA-Z0-9@_-]+$/.test(parts[1]) &&
    parts.slice(2).every((part) => part && !part.includes('..') && !part.includes('\\'));
}

async function readJson(file, maxBytes = MAX_STATE_BYTES) {
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('unsafe-file');
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const handle = await fsp.open(temp, 'wx');
    try {
      await handle.writeFile(JSON.stringify(data), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(temp, file);
        break;
      } catch (error) {
        if (attempt >= 4 || !RETRY_CODES.has(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 30 * 2 ** attempt));
      }
    }
    // Directory fsync is unavailable on some Windows volumes; the file itself is already durable.
    try {
      const dir = await fsp.open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch {}
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

function stateEnvelope(device, records, now, format = FORMAT) {
  return {
    format,
    device,
    written: now(),
    count: Object.keys(records).length,
    sha256: hashValue(records),
    records,
  };
}

function validEnvelope(data, device, format = FORMAT) {
  if (!data || data.format !== format || data.device !== device || !data.records || Array.isArray(data.records) ||
      data.count !== Object.keys(data.records).length || data.sha256 !== hashValue(data.records)) return false;
  return Object.entries(data.records).every(([key, item]) => validKey(key) && validRecord(key, item));
}

function validRecords(records) {
  return Boolean(records && typeof records === 'object' && !Array.isArray(records)) &&
    Object.entries(records).every(([key, item]) => validKey(key) && validRecord(key, item));
}

async function cloudLayout(folder) {
  const direct = await readJson(path.join(folder, 'format.json'));
  if (direct) {
    if (!Number.isInteger(direct.format) || direct.format < 1) throw new Error('Unsupported sync format');
    return { cloudRoot: folder, format: direct.format, readOnly: direct.format > FORMAT };
  }
  const legacyRoot = path.join(folder, CLOUD_FOLDER);
  const legacy = await readJson(path.join(legacyRoot, 'format.json'));
  if (legacy) {
    if (!Number.isInteger(legacy.format) || legacy.format < 1) throw new Error('Unsupported sync format');
    // An old selected parent still resolves to its format-1 data until the controller migrates its saved path.
    if (legacy.format === 1) return { cloudRoot: legacyRoot, format: 1, readOnly: false };
    // A version-2 nested marker protects a direct root from an old client's nested writes.
    return { cloudRoot: folder, format: legacy.format, readOnly: true };
  }
  return { cloudRoot: folder, format: FORMAT, readOnly: false };
}

function maxRevision(...collections) {
  let n = 0;
  for (const records of collections) for (const item of Object.values(records || {})) n = Math.max(n, item.rev?.n || 0);
  return n;
}

function aggregate(remoteStates, ownPublished, ownDevice = null) {
  const byKey = new Map();
  for (const records of [...Object.values(remoteStates), ownPublished]) {
    for (const [key, item] of Object.entries(records || {})) {
      const candidates = byKey.get(key) || [];
      candidates.push(item);
      byKey.set(key, candidates);
    }
  }
  const result = {};
  const divergent = {};
  for (const [key, candidates] of byKey) {
    const highest = Math.max(...candidates.map((item) => item.rev.n));
    const newest = candidates.filter((item) => item.rev.n === highest);
    const signatures = new Set(newest.map((item) => `${item.deleted}:${item.hash}`));
    if (signatures.size > 1) divergent[key] = newest;
    // On a tie another PC's record is "the other PC's value"; this PC's own published copy only fills in when no
    // other PC has the key (field test: "use the other PC's value" must never pick this PC's own edit).
    const mine = (item) => (item.rev.device === ownDevice ? 1 : 0);
    result[key] = newest.sort((a, b) => mine(a) - mine(b) || b.rev.device.localeCompare(a.rev.device))[0];
  }
  return { result, divergent };
}

class SyncManager {
  constructor({ localDir, folder = null, deviceId = null, deviceName = os.hostname(), now = Date.now, undoDays = DEFAULT_UNDO_DAYS, tombstoneDays = DEFAULT_TOMBSTONE_DAYS, secretGuard = () => false, log = () => {} } = {}) {
    if (!localDir) throw new Error('localDir is required');
    if (deviceId && !/^d-[a-f0-9]{8,64}$/.test(deviceId)) throw new Error('Invalid deviceId');
    this.localDir = path.resolve(localDir);
    this.folder = folder ? path.resolve(folder) : null;
    this.deviceId = deviceId;
    this.deviceName = String(deviceName).slice(0, 80);
    this.now = now;
    this.undoDays = undoDays;
    this.tombstoneDays = tombstoneDays;
    // Returns true when text contains a secret this PC knows; such a store is not exported (design 10.4).
    this.secretGuard = secretGuard;
    this.log = log;
    this.adapters = new Map();
    this.isEnabled = () => true;
    this.listeners = new Set();
    this.lastStatus = { connected: Boolean(folder), conflicts: [], warnings: [], lastSync: null };
    this.pending = new Map();
    this.running = null;
    this.timer = null;
    this.watcher = null;
  }

  register(adapter) {
    if (!adapter || !validName(adapter.name) || typeof adapter.read !== 'function' || typeof adapter.apply !== 'function') throw new Error('Invalid sync adapter');
    // A widget reload replaces its adapter; the old cleanup must not remove the replacement.
    this.adapters.set(adapter.name, adapter);
    return () => { if (this.adapters.get(adapter.name) === adapter) this.adapters.delete(adapter.name); };
  }

  connect(folder) {
    const next = folder ? path.resolve(folder) : null;
    if (next !== this.folder) this.stop();
    this.folder = next;
    this.lastStatus = { ...this.lastStatus, connected: Boolean(this.folder) };
    this.emit();
  }

  status() { return clone(this.lastStatus); }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(this.status()); }

  async metadata() {
    const file = path.join(this.localDir, 'state.json');
    const loaded = await readJson(file);
    const deviceId = this.deviceId || loaded?.deviceId || `d-${crypto.randomBytes(8).toString('hex')}`;
    if (!/^d-[a-f0-9]{8,64}$/.test(deviceId)) throw new Error('Invalid saved deviceId');
    this.deviceId = deviceId;
    return {
      deviceId,
      sources: loaded?.sources || {},
      remoteCache: loaded?.remoteCache || {},
      lastSync: loaded?.lastSync || null,
      undoLog: (Array.isArray(loaded?.undoLog) ? loaded.undoLog : []).filter((item) => item.expiresAt > this.now()),
      folder: loaded?.folder || null,
      tombstoneSeen: loaded?.tombstoneSeen || {},
      retired: loaded?.retired || {},
    };
  }

  addUndo(meta, conflict, choice, selected) {
    const discarded = choice === 'remote' ? conflict.local : choice === 'local' ? conflict.remote : null;
    if (!discarded) return;
    meta.undoLog.push({
      id: crypto.randomBytes(12).toString('hex'),
      key: conflict.key,
      source: conflict.source,
      discarded,
      selected: selected ? { hash: selected.hash, deleted: selected.deleted } : null,
      createdAt: this.now(),
      expiresAt: this.now() + this.undoDays * 24 * 60 * 60 * 1000,
    });
  }

  async listUndo() { return (await this.metadata()).undoLog; }

  async remoteFor(name, meta, warnings, cloudRoot, format) {
    const states = {};
    const cache = {};
    for (const [device, records] of Object.entries(meta.remoteCache[name] || {})) {
      if (/^d-[a-f0-9]{8,64}$/.test(device) && validRecords(records)) cache[device] = records;
      else warnings.push({ code: 'invalid-local-cache', device, source: name });
    }
    const stateDir = path.join(cloudRoot, 'state');
    let devices = [];
    try { devices = await fsp.readdir(stateDir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of devices) {
      if (!entry.isDirectory() || !/^d-[a-f0-9]{8,64}$/.test(entry.name) || entry.name === meta.deviceId) continue;
      const file = path.join(stateDir, entry.name, `${name}.json`);
      try {
        const data = await readJson(file);
        if (!data) continue;
        if (!validEnvelope(data, entry.name, format)) throw new Error('invalid-state');
        states[entry.name] = data.records;
        cache[entry.name] = data.records;
      } catch {
        warnings.push({ code: 'remote-not-ready', device: entry.name, source: name });
        if (cache[entry.name]) states[entry.name] = cache[entry.name];
      }
    }
    for (const [device, records] of Object.entries(cache)) if (!states[device] && device !== meta.deviceId) states[device] = records;
    return { states, cache };
  }

  async plan(folder = this.folder) {
    if (!folder) throw new Error('Sync folder is not connected');
    folder = path.resolve(folder);
    const meta = await this.metadata();
    const warnings = [];
    const retentionMs = this.tombstoneDays * 24 * 60 * 60 * 1000;
    const folderChanged = Boolean(meta.folder && path.resolve(meta.folder).toLowerCase() !== folder.toLowerCase());
    const staleDevice = Boolean(meta.lastSync && this.now() - meta.lastSync > retentionMs);
    const requiresReconnect = folderChanged || staleDevice;
    const reconnectReason = folderChanged ? 'folder-changed' : staleDevice ? 'stale-device' : null;
    if (requiresReconnect) warnings.push({ code: 'requires-reconnect', reason: reconnectReason });
    const { cloudRoot, format, readOnly } = await cloudLayout(folder);
    if (readOnly) warnings.push({ code: 'newer-format', format });
    const sources = {};
    const imports = [];
    const uploads = [];
    const conflicts = [];
    for (const [name, adapter] of this.adapters) {
      if (!this.isEnabled(name, adapter)) continue;
      let current;
      try { current = await adapter.read({ folder }); }
      catch (error) {
        // A missing folder of a store that never synced anything has nothing to lose: notes can arrive (the folder
        // is created). Once it has synced notes, a missing folder is skipped rather than read as deletions.
        const known = Object.keys(meta.sources[name]?.local || {}).length;
        if (error.code === 'FOLDER_UNAVAILABLE' && !known) current = {};
        else {
          warnings.push({ code: 'source-error', source: name, message: error.message, reason: error.code || null });
          sources[name] = { skipped: true };
          continue;
        }
      }
      if (current === null) {
        warnings.push({ code: 'already-cloud-managed', source: name });
        sources[name] = { skipped: true };
        continue;
      }
      if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`Invalid adapter data: ${name}`);
      if (this.secretGuard(canonical(current))) {
        warnings.push({ code: 'secret-blocked', source: name });
        sources[name] = { skipped: true };
        continue;
      }
      const original = meta.sources[name] || { local: {}, base: {}, published: {} };
      if (!validRecords(original.local || {}) || !validRecords(original.published || {})) throw new Error(`Invalid local sync state: ${name}`);
      // A store that now reads another folder (the user changed the note folder): what is missing there was not
      // deleted. That store is matched again like a first connect: no base, no deletions from the change; notes
      // missing here arrive from the cloud, notes only here are uploaded, equal ones stay quiet (#108, 2026-10-27).
      const location = typeof adapter.location === 'function' ? adapter.location() : null;
      const relocated = Boolean(location && original.location && original.location !== location);
      if (relocated) {
        warnings.push({ code: 'store-relocated', source: name });
        this.log(`${name}: its folder changed; matching it again without deletions`);
      }
      const saved = requiresReconnect ? { ...original, base: {}, published: {} } : relocated ? { ...original, base: {} } : original;
      const remoteMeta = folderChanged ? { ...meta, remoteCache: {} } : meta;
      const remote = await this.remoteFor(name, remoteMeta, warnings, cloudRoot, format);
      const { result: cloud, divergent } = aggregate(remote.states, saved.published, meta.deviceId);
      // After a relocation only records whose content is still here keep their revision; the rest start fresh.
      const local = relocated
        ? Object.fromEntries(Object.entries(saved.local).filter(([key, item]) => Object.hasOwn(current, key) && !item.deleted && item.hash === hashValue(current[key])))
        : { ...saved.local };
      let clock = maxRevision(saved.local, cloud);
      for (const key of new Set([...Object.keys(current), ...Object.keys(local)])) {
        if (!validKey(key)) throw new Error(`Invalid sync key: ${key}`);
        const exists = Object.hasOwn(current, key);
        const previous = local[key];
        const nextHash = exists ? hashValue(current[key]) : DELETED_HASH;
        if (previous && previous.hash === nextHash && previous.deleted === !exists) continue;
        if (!exists && !previous) continue;
        local[key] = record(key, current[key], !exists, ++clock, meta.deviceId, this.now);
      }
      const base = saved.base || {};
      const retired = meta.retired[name] || {};
      for (const key of new Set([...Object.keys(local), ...Object.keys(cloud), ...Object.keys(base)])) {
        const mine = local[key] || null;
        const theirs = cloud[key] || null;
        const before = base[key] || null;
        const localChanged = !same(mine, before);
        // A key no other state has any more is unknown, not deleted: only tombstones delete.
        const remoteChanged = theirs ? !same(theirs, before) : false;
        if ((retired[key] && theirs && !theirs.deleted) || divergent[key] || (localChanged && remoteChanged && !same(mine, theirs))) {
          conflicts.push({ key, source: name, local: mine, remote: theirs, candidates: divergent[key] || [theirs].filter(Boolean) });
        } else if (remoteChanged && !same(mine, theirs)) {
          imports.push({ key, source: name, record: theirs });
        } else if (localChanged && !same(mine, theirs)) {
          uploads.push({ key, source: name, record: mine });
        }
      }
      sources[name] = { local, base: { ...base }, published: { ...saved.published }, remoteCache: remote.cache, remoteStates: remote.states, location: location || original.location || null };
    }
    return { deviceId: meta.deviceId, folder, cloudRoot, format, readOnly, requiresReconnect, reconnectReason, imports, uploads, conflicts, warnings, sources, lastSync: meta.lastSync };
  }

  preview(folder) { return this.plan(folder || this.folder); }

  async sync({ resolutions = {}, approveReconnect = false } = {}) {
    // One run at a time, and every call gets its own run: a call during a background run must not return that
    // run's result, or the user's conflict choices would be dropped (#108 field test).
    while (this.running) await this.running.catch(() => {});
    const run = this.performSync(resolutions, approveReconnect);
    this.running = run;
    try { return await run; }
    finally { if (this.running === run) this.running = null; }
  }

  async performSync(resolutions, approveReconnect) {
    const plan = await this.plan();
    if (plan.requiresReconnect && !approveReconnect) {
      this.lastStatus = { connected: true, conflicts: plan.conflicts, warnings: plan.warnings, lastSync: plan.lastSync, requiresReconnect: true, reconnectReason: plan.reconnectReason };
      this.emit();
      return { ...this.status(), applied: 0, published: 0, resolved: 0 };
    }
    if (plan.readOnly) {
      this.lastStatus = { connected: true, conflicts: plan.conflicts, warnings: plan.warnings, lastSync: plan.lastSync, readOnly: true };
      this.emit();
      return { ...this.status(), applied: 0, published: 0 };
    }
    const meta = await this.metadata();
    const { cloudRoot, format } = plan;
    await fsp.mkdir(cloudRoot, { recursive: true });
    const formatFile = path.join(cloudRoot, 'format.json');
    if (!(await readJson(formatFile))) await atomicJson(formatFile, { format });
    if (format === FORMAT) {
      // Old clients probe this nested path; keep them read-only on a direct-root folder.
      const markerDir = path.join(cloudRoot, CLOUD_FOLDER);
      const markerStat = await fsp.lstat(markerDir).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (markerStat && (!markerStat.isDirectory() || markerStat.isSymbolicLink())) throw new Error('Unsafe sync marker directory');
      const markerFile = path.join(markerDir, 'format.json');
      const marker = await readJson(markerFile);
      if (marker && marker.format !== FORMAT) throw new Error('Conflicting legacy sync data');
      if (!marker) await atomicJson(markerFile, { format: FORMAT });
    }
    const pending = new Map(plan.conflicts.map((conflict) => [conflict.key, conflict]));
    let applied = 0;
    let published = 0;
    let resolved = 0;
    for (const [name, adapter] of this.adapters) {
      const state = plan.sources[name];
      if (!state || state.skipped) continue;
      // One store failing (a locked file, a bad incoming note) must not stop the others; it is retried next time.
      try {
        const imports = [];
        for (const item of plan.imports.filter((entry) => entry.source === name)) {
          if (typeof adapter.available === 'function' && !await adapter.available(item, { cloudRoot })) {
            plan.warnings.push({ code: 'blob-not-ready', source: name, key: item.key });
            continue;
          }
          imports.push(item);
        }
        for (const conflict of plan.conflicts.filter((item) => item.source === name)) {
          const choice = resolutions[conflict.key];
          if (choice === undefined) continue;
          if (!['local', 'remote', 'both'].includes(choice)) throw new Error(`Invalid conflict choice: ${choice}`);
          const { key, local: mine, remote: theirs } = conflict;
          if (choice === 'remote') {
            if (!theirs) throw new Error(`No remote value for ${key}`);
            if (typeof adapter.available === 'function' && !await adapter.available({ key, source: name, record: theirs }, { cloudRoot })) {
              plan.warnings.push({ code: 'blob-not-ready', source: name, key });
              continue;
            }
            imports.push({ key, source: name, record: theirs });
          } else {
            if (choice === 'both') {
              if (!mine || mine.deleted || !theirs || theirs.deleted || typeof adapter.copy !== 'function') throw new Error(`Both is unavailable for ${key}`);
              const copied = await adapter.copy(key, clone(theirs.value), { cloudRoot });
              if (!copied || !validKey(copied.key) || copied.key === key || state.local[copied.key]) throw new Error('Invalid copied item');
              const clock = maxRevision(state.local, { [key]: theirs });
              state.local[copied.key] = record(copied.key, copied.value, false, clock + 1, meta.deviceId, this.now);
            }
            const clock = maxRevision(state.local, { [key]: theirs }, Object.fromEntries((conflict.candidates || []).map((item) => [item.rev.device, item])));
            state.local[key] = record(key, mine?.value, mine?.deleted ?? true, clock + 1, meta.deviceId, this.now);
          }
          this.addUndo(meta, conflict, choice, choice === 'remote' ? theirs : state.local[key]);
          pending.delete(key);
          resolved++;
        }
        if (imports.length) {
          await adapter.apply(imports.map(({ key, record: item }) => ({ key, deleted: item.deleted, ...(!item.deleted && { value: clone(item.value) }) })), { cloudRoot });
          for (const { key, record: item } of imports) {
            if (item) state.local[key] = item;
            else delete state.local[key];
            if (item) state.base[key] = { hash: item.hash, deleted: item.deleted, rev: item.rev };
            else delete state.base[key];
          }
          applied += imports.length;
        }
        for (const { key, record: item } of plan.uploads.filter((entry) => entry.source === name)) {
          state.base[key] = { hash: item.hash, deleted: item.deleted, rev: item.rev };
        }
        for (const [key, item] of Object.entries(state.local)) {
          if (pending.has(key)) continue;
          if (!state.base[key] || !same(state.base[key], item)) state.base[key] = { hash: item.hash, deleted: item.deleted, rev: item.rev };
        }
        const outgoing = { ...state.local };
        for (const [key, conflict] of pending) {
          if (conflict.source !== name) continue;
          if (state.published[key]) outgoing[key] = state.published[key];
          else delete outgoing[key];
        }
        const seen = { ...(meta.tombstoneSeen[name] || {}) };
        const retired = { ...(meta.retired[name] || {}) };
        const retentionMs = this.tombstoneDays * 24 * 60 * 60 * 1000;
        for (const [key, item] of Object.entries(outgoing)) {
          if (!item.deleted) {
            delete seen[key];
            if (!pending.has(key)) delete retired[key];
            continue;
          }
          if (seen[key] === undefined) seen[key] = this.now();
          const remoteHasLiveItem = Object.values(state.remoteStates).some((records) => records[key] && !records[key].deleted);
          if (!pending.has(key) && this.now() - seen[key] >= retentionMs && !remoteHasLiveItem) {
            // Keep a local retirement marker so an old cloud state cannot revive this key silently.
            retired[key] = { hash: item.hash, rev: item.rev, retiredAt: this.now() };
            delete outgoing[key];
            delete state.local[key];
            delete state.base[key];
            delete seen[key];
          }
        }
        if (typeof adapter.prepare === 'function') await adapter.prepare(outgoing, cloudRoot);
        const file = path.join(cloudRoot, 'state', meta.deviceId, `${name}.json`);
        await atomicJson(file, stateEnvelope(meta.deviceId, outgoing, this.now, format));
        state.published = outgoing;
        published += Object.keys(outgoing).length;
        meta.sources[name] = { local: state.local, base: state.base, published: state.published, ...(state.location ? { location: state.location } : {}) };
        meta.remoteCache[name] = state.remoteCache;
        meta.tombstoneSeen[name] = seen;
        meta.retired[name] = retired;
      } catch (error) {
        if (/^Invalid conflict choice|^Both is unavailable|^No remote value/.test(error.message)) throw error;
        plan.warnings.push({ code: 'source-error', source: name, message: error.message });
      }
    }
    await atomicJson(path.join(cloudRoot, 'devices', `${meta.deviceId}.json`), {
      id: meta.deviceId, name: this.deviceName, lastSync: this.now(), engineVersion: null,
    });
    meta.lastSync = this.now();
    meta.folder = path.resolve(this.folder);
    await atomicJson(path.join(this.localDir, 'state.json'), meta);
    this.pending = pending;
    this.lastStatus = { connected: true, conflicts: [...pending.values()], warnings: plan.warnings, lastSync: meta.lastSync, readOnly: false, requiresReconnect: false };
    this.emit();
    return { ...this.status(), applied, published, resolved };
  }

  async resolve({ key, choice }) {
    const conflict = this.pending.get(key);
    if (!conflict || !['local', 'remote', 'both'].includes(choice)) throw new Error('Unknown conflict or choice');
    const adapter = this.adapters.get(conflict.source);
    const { cloudRoot, format, readOnly } = await cloudLayout(this.folder);
    if (readOnly) throw new Error('Sync folder is read-only');
    const meta = await this.metadata();
    const state = meta.sources[conflict.source];
    const mine = conflict.local;
    const theirs = conflict.remote;
    if (choice === 'both') {
      if (!mine || mine.deleted || !theirs || theirs.deleted || typeof adapter.copy !== 'function') throw new Error('Both is unavailable for this item');
      const copied = await adapter.copy(key, clone(theirs.value), { cloudRoot });
      if (!copied || !validKey(copied.key) || copied.key === key) throw new Error('Invalid copied item');
      const clock = maxRevision(state.local, state.published, { [key]: theirs });
      state.local[copied.key] = record(copied.key, copied.value, false, clock + 1, meta.deviceId, this.now);
    }
    if (choice === 'remote') {
      if (!theirs) throw new Error('No remote value for this item');
      await adapter.apply([{ key, deleted: theirs?.deleted ?? true, ...(!theirs?.deleted && theirs && { value: clone(theirs.value) }) }], { cloudRoot });
      if (theirs) state.local[key] = theirs;
      else delete state.local[key];
    } else {
      const clock = maxRevision(state.local, state.published, { [key]: theirs });
      state.local[key] = record(key, mine?.value, mine?.deleted ?? true, clock + 1, meta.deviceId, this.now);
    }
    const selected = state.local[key];
    this.addUndo(meta, conflict, choice, selected);
    if (selected) state.base[key] = { hash: selected.hash, deleted: selected.deleted, rev: selected.rev };
    else delete state.base[key];
    if (typeof adapter.prepare === 'function') await adapter.prepare(state.local, cloudRoot);
    await atomicJson(path.join(cloudRoot, 'state', meta.deviceId, `${conflict.source}.json`), stateEnvelope(meta.deviceId, state.local, this.now, format));
    state.published = { ...state.local };
    await atomicJson(path.join(this.localDir, 'state.json'), meta);
    this.pending.delete(key);
    this.lastStatus = { ...this.lastStatus, conflicts: this.lastStatus.conflicts.filter((item) => item.key !== key) };
    this.emit();
    return this.status();
  }

  async undo(id) {
    const meta = await this.metadata();
    const entry = meta.undoLog.find((item) => item.id === id);
    if (!entry) throw new Error('Undo entry expired or missing');
    const adapter = this.adapters.get(entry.source);
    if (!adapter) throw new Error('Sync adapter is unavailable');
    const plan = await this.plan();
    if (plan.readOnly) throw new Error('Sync folder is read-only');
    if (plan.conflicts.some((item) => item.key === entry.key) ||
        plan.imports.some((item) => item.key === entry.key) || plan.uploads.some((item) => item.key === entry.key) ||
        !same(plan.sources[entry.source]?.local[entry.key], entry.selected)) {
      throw new Error('Item changed since this choice; compare it again before restoring');
    }
    const { cloudRoot, format } = plan;
    const state = meta.sources[entry.source];
    const discarded = entry.discarded;
    await adapter.apply([{ key: entry.key, deleted: discarded.deleted, ...(!discarded.deleted && { value: clone(discarded.value) }) }], { cloudRoot });
    const clock = maxRevision(state.local, state.published, { [entry.key]: discarded });
    const restored = record(entry.key, discarded.value, discarded.deleted, clock + 1, meta.deviceId, this.now);
    state.local[entry.key] = restored;
    state.base[entry.key] = { hash: restored.hash, deleted: restored.deleted, rev: restored.rev };
    if (typeof adapter.prepare === 'function') await adapter.prepare(state.local, cloudRoot);
    await atomicJson(path.join(cloudRoot, 'state', meta.deviceId, `${entry.source}.json`), stateEnvelope(meta.deviceId, state.local, this.now, format));
    state.published = { ...state.local };
    meta.undoLog = meta.undoLog.filter((item) => item.id !== id);
    await atomicJson(path.join(this.localDir, 'state.json'), meta);
    this.emit();
    return { key: entry.key, restored };
  }

  start({ intervalMs = 60000 } = {}) {
    this.stop();
    if (!this.folder) return;
    const run = () => this.sync().catch((error) => {
      this.lastStatus = { ...this.lastStatus, warnings: [{ code: 'sync-error', message: error.message }] };
      this.emit();
    });
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
    run().finally(() => {
      if (!this.timer) return;
      cloudLayout(this.folder).then(({ cloudRoot }) => {
        if (!this.timer) return;
        const stateDir = path.join(cloudRoot, 'state');
        try {
          this.watcher = fs.watch(stateDir, { recursive: true }, (_kind, filename) => {
            // Our own atomic rename is not a remote change. Polling handles unnamed notifications.
            if (!filename || String(filename).split(/[\\/]/)[0] === this.deviceId) return;
            run();
          });
          // Network shares (SMB) and some cloud drives report watch errors later; without a
          // handler that is an uncaught exception in the main process. Polling keeps working.
          const failed = this.watcher;
          failed.on('error', () => {
            try { failed.close(); } catch { /* already closed */ }
            if (this.watcher === failed) this.watcher = null;
          });
        } catch { /* Polling also works for cloud drives without watcher support. */ }
      }).catch(() => { /* Polling reports unreadable formats through sync status. */ });
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

module.exports = { SyncManager, canonical, hashValue, stateEnvelope, validEnvelope, atomicJson, CLOUD_FOLDER, FORMAT };
