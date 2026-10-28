// Brings 1.1.3-test data back from the sync folder into this PC's stores (design 10.5, #108).
// Those builds wrote the shared part of each connected store to <sync folder>\widgets\<widget>\<device>\ and
// kept only the PC-only part in the local file; the engine's sync\config.json listed them in activeSources.
// Per store, once: verify the sync-folder copy, back up the local file, write the merged value, read it back,
// and only then mark it migrated. The sync-folder originals are never deleted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashValue } = require('./sync');
const { hash, relativeName } = require('./files-store');

const DEVICE = /^d-[a-f0-9]{8,64}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const SAFE_ID = (value) => typeof value === 'string' && value.length > 0 && value.length <= 500 &&
  !['__proto__', 'constructor', 'prototype'].includes(value);

function readJsonSync(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) throw new Error('unsafe-file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const key = (widgetId, collection, id) => `${widgetId}/${collection}/${encodeURIComponent(id)}`;

/** The legacy shared files that widgets wrote themselves (dooray and mail adapters), as sync records. */
const LEGACY_FILES = {
  'dooray-categories': {
    file: 'categories.json',
    records(data) {
      const records = {};
      for (const c of Array.isArray(data.categories) ? data.categories : []) if (SAFE_ID(c?.id)) records[key('dooray', 'categories', c.id)] = c;
      for (const [id, a] of Object.entries(data.assignments || {})) if (SAFE_ID(id) && a) records[key('dooray', 'assignments', id)] = a;
      return records;
    },
  },
  'dooray-rules': {
    file: 'rules-shared.json',
    records: (data) => Object.fromEntries((Array.isArray(data.rules) ? data.rules : []).filter((r) => SAFE_ID(r?.id))
      .map(({ enabled, ...rule }) => [key('dooray', 'rules', rule.id), rule])),
  },
  'mail-categories': {
    file: 'categories.json',
    records(data) {
      const records = {};
      for (const c of Array.isArray(data.categories) ? data.categories : []) if (SAFE_ID(c?.id)) records[key('mail', 'categories', c.id)] = c;
      for (const [id, a] of Object.entries(data.assignments || {})) if (SAFE_ID(id) && a) records[key('mail', 'assignments', id)] = a;
      return records;
    },
  },
  'mail-contacts': {
    file: 'contacts-shared.json',
    records: (data) => Object.fromEntries(Object.entries(data.contacts || {}).filter(([id, c]) => SAFE_ID(id) && c)
      .map(([id, c]) => [key('mail', 'contacts', id), { address: c.address, name: c.name, imported: Boolean(c.imported), edited: Boolean(c.edited) }])),
  },
};

/**
 * Call once at engine start, before the sync config is rewritten: keeps what the 1.1.3-test config said.
 * @returns {{ migrateStore(info), migrateFiles(info), pending(): string[], warnings(): object[] }}
 */
function createLegacyMigrator({ syncDir, now = Date.now, log = (message) => console.error(`sync migration: ${message}`) }) {
  const snapshotFile = path.join(syncDir, 'legacy-sources.json');
  const doneFile = path.join(syncDir, 'migrated.json');
  const warnings = [];
  let legacy = null;
  try {
    legacy = readJsonSync(snapshotFile);
  } catch {
    try {
      const config = readJsonSync(path.join(syncDir, 'config.json'));
      const active = Object.keys(config.activeSources || {}).filter((name) => config.activeSources[name] === true);
      if (config.folder && DEVICE.test(config.deviceId) && active.length) {
        legacy = { folder: config.folder, deviceId: config.deviceId, activeSources: active, savedAt: now() };
        writeJsonSync(snapshotFile, legacy);
      }
    } catch { /* No sync config: nothing was ever connected on this PC. */ }
  }
  const valid = Boolean(legacy && typeof legacy.folder === 'string' && path.isAbsolute(legacy.folder) && DEVICE.test(legacy.deviceId) &&
    Array.isArray(legacy.activeSources));
  let done = {};
  try { done = readJsonSync(doneFile) || {}; } catch { done = {}; }

  const deviceDir = (widgetId) => path.join(path.resolve(legacy.folder), 'widgets', widgetId, legacy.deviceId);
  const needs = (name) => valid && legacy.activeSources.includes(name) && !done[name];
  const backupDir = (name) => path.join(syncDir, 'migration-backup', `${now()}-${name}`);
  const markDone = (name, detail) => {
    done = { ...done, [name]: { at: now(), ...detail } };
    writeJsonSync(doneFile, done);
  };
  const warn = (name, error) => {
    warnings.push({ code: 'legacy-migration', source: name, message: error.message });
    log(`${name}: ${error.message}`);
  };

  function legacyRecords(name, widgetId, source) {
    const dir = deviceDir(widgetId);
    const special = LEGACY_FILES[name];
    if (special) {
      const file = path.join(dir, special.file);
      if (!fs.existsSync(file)) return null;
      return special.records(readJsonSync(file));
    }
    const file = path.join(dir, `${source}.json`);
    if (!fs.existsSync(file)) return null;
    const data = readJsonSync(file);
    if (!data || data.format !== 1 || data.widget !== widgetId || data.source !== source || data.device !== legacy.deviceId ||
        !data.records || typeof data.records !== 'object' || Array.isArray(data.records) || data.sha256 !== hashValue(data.records)) {
      throw new Error('The sync-folder copy is incomplete or damaged; it is kept and migration retries at the next start');
    }
    return data.records;
  }

  /** Item store: { name, widgetId, source, file, records(), replace(records) -> expected, reread() -> records }. */
  function migrateStore(info) {
    if (!needs(info.name)) return false;
    try {
      const records = legacyRecords(info.name, info.widgetId, info.source);
      if (!records) {
        markDone(info.name, { result: 'nothing-in-sync-folder' });
        return false;
      }
      // Back up the local (PC-only) file first; the merge below never runs without it.
      const backup = backupDir(info.name);
      if (fs.existsSync(info.file)) {
        fs.mkdirSync(backup, { recursive: true });
        const copy = path.join(backup, path.basename(info.file));
        fs.copyFileSync(info.file, copy, fs.constants.COPYFILE_EXCL);
        if (hash(fs.readFileSync(copy)) !== hash(fs.readFileSync(info.file))) throw new Error('Backup verification failed');
      }
      const expected = info.replace(records);
      const reread = info.reread();
      if (hashValue(reread) !== hashValue(expected)) {
        if (fs.existsSync(path.join(backup, path.basename(info.file)))) fs.copyFileSync(path.join(backup, path.basename(info.file)), info.file);
        info.reread();
        throw new Error('The merged file did not read back the same; the previous file was restored');
      }
      markDone(info.name, { records: Object.keys(records).length, backup });
      log(`${info.name}: ${Object.keys(records).length} records back in this PC's store`);
      return true;
    } catch (error) {
      warn(info.name, error);
      return false;
    }
  }

  /** File store: { name, widgetId, source, dir, include, limit }. Synchronous so the widget scans the result. */
  function migrateFiles(info) {
    if (!needs(info.name)) return false;
    const source = path.join(deviceDir(info.widgetId), info.source);
    try {
      if (!fs.existsSync(source)) {
        markDone(info.name, { result: 'nothing-in-sync-folder' });
        return false;
      }
      const target = path.resolve(info.dir);
      const rels = listSync(source, info.include);
      // Verify every file first: nothing is copied when one is unreadable (still downloading, too large).
      const items = rels.map((rel) => {
        const bytes = readLimitedSync(path.join(source, ...rel.split('/')), info.limit);
        const destination = path.join(target, ...rel.split('/'));
        let existing = null;
        try {
          const stat = fs.lstatSync(destination);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file in the note folder: ${rel}`);
          existing = hash(fs.readFileSync(destination));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        return { rel, bytes, digest: hash(bytes), destination, existing };
      });
      const backup = backupDir(info.name);
      let copied = 0;
      let replaced = 0;
      for (const item of items) {
        if (item.existing === item.digest) continue;
        // The sync-folder file was the one in use; an older PC copy of the same name goes to the backup.
        if (item.existing) {
          const saved = path.join(backup, ...item.rel.split('/'));
          fs.mkdirSync(path.dirname(saved), { recursive: true });
          fs.copyFileSync(item.destination, saved, fs.constants.COPYFILE_EXCL);
          if (hash(fs.readFileSync(saved)) !== item.existing) throw new Error(`Backup verification failed: ${item.rel}`);
          replaced++;
        }
        fs.mkdirSync(path.dirname(item.destination), { recursive: true });
        const tmp = path.join(path.dirname(item.destination), `.${path.basename(item.destination)}.tmp-${crypto.randomBytes(4).toString('hex')}`);
        fs.writeFileSync(tmp, item.bytes);
        fs.renameSync(tmp, item.destination);
        if (hash(fs.readFileSync(item.destination)) !== item.digest) throw new Error(`Copy verification failed: ${item.rel}`);
        copied++;
      }
      markDone(info.name, { files: items.length, copied, replaced, ...(replaced ? { backup } : {}) });
      log(`${info.name}: ${items.length} files checked, ${copied} copied back (${replaced} older copies backed up)`);
      return true;
    } catch (error) {
      warn(info.name, error);
      return false;
    }
  }

  return {
    migrateStore,
    migrateFiles,
    pending: () => (valid ? legacy.activeSources.filter((name) => !done[name]) : []),
    warnings: () => [...warnings],
  };
}

function listSync(root, include) {
  const result = [];
  const visit = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.sync-removed' || entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      relativeName(rel);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path.join(folder, entry.name), rel);
      else if (entry.isFile() && include(rel)) result.push(rel);
    }
  };
  visit(root, '');
  return result;
}

function readLimitedSync(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error(`File is missing, unsafe, or too large: ${path.basename(file)}`);
  return fs.readFileSync(file);
}

module.exports = { createLegacyMigrator, LEGACY_FILES };
