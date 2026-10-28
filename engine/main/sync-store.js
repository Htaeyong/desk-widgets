// Engine item store with a sync declaration (#108). The widget reads and writes only this PC's file; the
// engine builds sync records from the declared shared parts and applies other PCs' records back into it.
// Fields are marked per collection: `shared` lists the fields that leave this PC, or `local` lists the
// PC-only ones. Top-level settings are PC-only unless listed in sync.shared.
const { canonical } = require('./sync');

const UNSAFE_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const FIELD = /^[A-Za-z_$][\w$]{0,63}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLLECTION = /^[A-Za-z][\w]{0,63}$/;

function fieldList(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((field) => typeof field !== 'string' || !FIELD.test(field))) throw new Error(`Invalid sync ${label} fields`);
  return [...new Set(value)];
}

/** Validates a widget's sync declaration; secret fields can never be shared. */
function normalizeSpec(sync, secret) {
  if (!sync || typeof sync !== 'object') throw new Error('Invalid sync declaration');
  if (secret) throw new Error('A store with a secret field cannot be synced; keep secrets in ctx.secrets');
  const source = sync.name === undefined ? 'settings' : sync.name;
  if (typeof source !== 'string' || !NAME.test(source)) throw new Error('Invalid sync store name');
  const collections = {};
  for (const [name, spec] of Object.entries(sync.collections || {})) {
    if (!COLLECTION.test(name) || !spec || typeof spec !== 'object') throw new Error(`Invalid sync collection: ${name}`);
    const shared = fieldList(spec.shared, 'shared');
    const local = fieldList(spec.local, 'local');
    if (shared && local) throw new Error(`Sync collection ${name} declares both shared and local fields`);
    const id = spec.map ? null : spec.id === undefined ? 'id' : spec.id;
    if (!spec.map && (typeof id !== 'string' || !FIELD.test(id))) throw new Error(`Invalid sync id field: ${name}`);
    if (local?.includes(id)) throw new Error(`The id field cannot be PC-only: ${name}`);
    collections[name] = {
      map: Boolean(spec.map),
      id,
      shared: shared && id && !shared.includes(id) ? [id, ...shared] : shared,
      local,
      filter: typeof spec.filter === 'function' ? spec.filter : null,
      localDefaults: spec.localDefaults && typeof spec.localDefaults === 'object' ? { ...spec.localDefaults } : {},
      copy: typeof spec.copy === 'function' ? spec.copy : null,
    };
  }
  const shared = fieldList(sync.shared, 'shared') || [];
  for (const field of shared) if (Object.hasOwn(collections, field)) throw new Error(`Sync field is also a collection: ${field}`);
  return { source, collections, shared, copy: typeof sync.copy === 'function' ? sync.copy : null };
}

const isItem = (item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item);

/** The part of an item that leaves this PC. */
function sharedPart(item, spec) {
  if (spec.shared) return Object.fromEntries(spec.shared.filter((field) => item[field] !== undefined).map((field) => [field, item[field]]));
  const out = { ...item };
  for (const field of spec.local || []) delete out[field];
  return out;
}

/** The PC-only part of an item, kept when another PC's version is applied. */
function localPart(item, spec) {
  if (!isItem(item)) return {};
  if (spec.shared) {
    const out = { ...item };
    for (const field of spec.shared) delete out[field];
    return out;
  }
  return Object.fromEntries((spec.local || []).filter((field) => item[field] !== undefined).map((field) => [field, item[field]]));
}

const itemKey = (widgetId, collection, id) => `${widgetId}/${collection}/${encodeURIComponent(String(id))}`;
const settingKey = (widgetId, field) => `${widgetId}/@settings/${encodeURIComponent(field)}`;

function decodeKey(widgetId, key) {
  const prefix = `${widgetId}/`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
  const slash = key.indexOf('/', prefix.length);
  if (slash < 0) return null;
  try {
    const id = decodeURIComponent(key.slice(slash + 1));
    return UNSAFE_IDS.has(id) ? null : { collection: key.slice(prefix.length, slash), id };
  } catch {
    return null;
  }
}

const isDefault = (spec, field, value) => Object.hasOwn(spec.defaults || {}, field) && canonical(value) === canonical(spec.defaults[field]);

/** Sync records of a store value: { key: shared value }. */
function recordsOf(state, widgetId, spec) {
  const records = {};
  for (const [name, collection] of Object.entries(spec.collections)) {
    const add = (id, item) => {
      if (isItem(item) && !UNSAFE_IDS.has(String(id)) && (!collection.filter || collection.filter(item))) {
        records[itemKey(widgetId, name, id)] = sharedPart(item, collection);
      }
    };
    if (collection.map) {
      for (const [id, item] of Object.entries(isItem(state[name]) ? state[name] : {})) add(id, item);
    } else {
      for (const item of Array.isArray(state[name]) ? state[name] : []) {
        if (isItem(item) && item[collection.id] !== undefined && item[collection.id] !== null) add(item[collection.id], item);
      }
    }
  }
  // A setting still at its default is "not set": on first connect another PC's real choice then simply arrives
  // instead of every untouched setting becoming a conflict (#108 field test).
  for (const field of spec.shared) {
    if (!Object.hasOwn(state, field) || state[field] === undefined || isDefault(spec, field, state[field])) continue;
    records[settingKey(widgetId, field)] = state[field];
  }
  return records;
}

/** Applies record changes ({ key, deleted, value }) to a store value; PC-only fields stay as they are. */
function applyChanges(state, changes, widgetId, spec) {
  const next = { ...state };
  for (const change of changes) {
    const parsed = decodeKey(widgetId, change.key);
    if (!parsed) continue;
    const { collection: name, id } = parsed;
    if (name === '@settings') {
      if (!spec.shared.includes(id)) continue;
      if (!change.deleted && change.value !== undefined) next[id] = change.value;
      // Another PC set it back to its default.
      else if (change.deleted && Object.hasOwn(spec.defaults || {}, id)) next[id] = structuredClone(spec.defaults[id]);
      continue;
    }
    const collection = spec.collections[name];
    if (!collection) continue;
    const value = change.deleted ? null : change.value;
    if (!change.deleted && (!isItem(value) || (collection.filter && !collection.filter(value)))) continue;
    if (collection.map) {
      const map = { ...(isItem(next[name]) ? next[name] : {}) };
      const existing = Object.hasOwn(map, id) && isItem(map[id]) && (!collection.filter || collection.filter(map[id])) ? map[id] : null;
      if (change.deleted) {
        if (existing) delete map[id];
      } else {
        map[id] = { ...(existing ? localPart(existing, collection) : collection.localDefaults), ...sharedPart(value, collection) };
      }
      next[name] = map;
      continue;
    }
    const items = Array.isArray(next[name]) ? [...next[name]] : [];
    const index = items.findIndex((item) => isItem(item) && String(item[collection.id]) === id && (!collection.filter || collection.filter(item)));
    if (change.deleted) {
      if (index >= 0) items.splice(index, 1);
    } else {
      if (String(value[collection.id]) !== id) continue;
      const merged = { ...(index >= 0 ? localPart(items[index], collection) : collection.localDefaults), ...sharedPart(value, collection) };
      if (index >= 0) items[index] = merged;
      else items.push(merged);
    }
    next[name] = items;
  }
  return next;
}

/**
 * Replaces the shared part of a store value with the given records (legacy migration, 10.5 of the design):
 * declared items missing from the records are removed, PC-only fields and filtered-out items stay.
 */
function replaceShared(state, records, widgetId, spec) {
  const changes = [];
  const present = recordsOf(state, widgetId, spec);
  for (const key of Object.keys(present)) {
    if (!Object.hasOwn(records, key) && !key.includes('/@settings/')) changes.push({ key, deleted: true });
  }
  for (const [key, value] of Object.entries(records)) changes.push({ key, deleted: false, value });
  return applyChanges(state, changes, widgetId, spec);
}

/**
 * @param {{ createStore: Function, manager?: object, widgetId: string, options: object,
 *   onLocalChange?: () => void, onStop?: (fn) => void, migrate?: (store: object) => void }} args
 */
function createSyncStore({ createStore, manager, widgetId, options, onLocalChange = () => {}, onStop = () => {}, migrate = null }) {
  if (!options?.sync) return createStore(options);
  const spec = { ...normalizeSpec(options.sync, options.secret), defaults: options.defaults || {} };
  const { sync, ...plain } = options;
  const store = createStore(plain);
  const listeners = new Set();

  const save = (partial) => {
    const result = store.save(partial);
    onLocalChange();
    return result;
  };
  const notifyRemote = () => {
    for (const listener of listeners) {
      try { listener(); } catch (error) { console.error(`sync: ${widgetId} onRemoteChange: ${error.message}`); }
    }
  };
  const synced = {
    ...store,
    save,
    onRemoteChange(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  // 1.1.3-test data that lived in the sync folder comes back into this file before the widget reads it.
  if (migrate) {
    migrate({
      name: `${widgetId}-${spec.source}`, widgetId, source: spec.source, file: store.file(),
      records: () => recordsOf(store.load(), widgetId, spec),
      replace: (records) => {
        const expected = store.save(replaceShared(store.load(), records, widgetId, spec));
        return recordsOf(expected, widgetId, spec);
      },
      reread: () => {
        store.reset();
        return recordsOf(store.load(), widgetId, spec);
      },
    });
  }

  if (manager) {
    const adapter = {
      name: `${widgetId}-${spec.source}`,
      widgetId,
      read: async () => recordsOf(store.load(), widgetId, spec),
      apply: async (changes) => {
        if (!changes.length) return;
        store.save(applyChanges(store.load(), changes, widgetId, spec));
        notifyRemote();
      },
    };
    const copyable = Object.values(spec.collections).some((collection) => collection.copy) || spec.copy;
    if (copyable) {
      adapter.copy = async (key, value) => {
        const parsed = decodeKey(widgetId, key);
        const collection = parsed && spec.collections[parsed.collection];
        const copy = collection?.copy || spec.copy;
        if (!collection || !copy) throw new Error('This sync item cannot be copied');
        const copied = await copy(value);
        const id = collection.map ? copied?.id : copied?.[collection.id];
        if (!isItem(copied) || id === undefined || String(id) === parsed.id) throw new Error('Sync copy needs a new item id');
        const state = store.load();
        if (collection.map) {
          const items = { ...(state[parsed.collection] || {}) };
          if (Object.hasOwn(items, id)) throw new Error('Sync copy id already exists');
          const { id: _id, ...body } = copied;
          items[id] = { ...collection.localDefaults, ...body };
          store.save({ [parsed.collection]: items });
        } else {
          const items = [...(state[parsed.collection] || [])];
          if (items.some((item) => String(item?.[collection.id]) === String(id))) throw new Error('Sync copy id already exists');
          items.push({ ...collection.localDefaults, ...copied });
          store.save({ [parsed.collection]: items });
        }
        notifyRemote();
        const saved = recordsOf(store.load(), widgetId, spec)[itemKey(widgetId, parsed.collection, id)];
        return { key: itemKey(widgetId, parsed.collection, id), value: saved };
      };
    }
    onStop(manager.register(adapter));
  }
  return synced;
}

module.exports = { createSyncStore, normalizeSpec, recordsOf, applyChanges, replaceShared, sharedPart, localPart };
