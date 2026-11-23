// Saved summaries of work the user was happy with ("recipes", design 12). Plain Markdown files any model can read, one per version,
// in the widget's data folder; never synced. Nothing here decides what is saved: the checks and the user's click come first.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RECIPE_ID = /^r-[0-9a-f]{16}$/;
const KEEP_VERSIONS = 10; // earlier versions kept besides the current one
const MAX_TITLE = 100;
const MAX_WHEN = 300;
const MAX_BODY = 100 * 1024;
const CATALOG_MAX = 50;

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The Markdown of one version. */
function renderRecipe({ title, when, body }) {
  return `# ${title}\n\n> 언제 쓰는지: ${when}\n\n${body}\n`;
}

function parseRecipe(text) {
  const m = /^# (.*)\r?\n\r?\n> 언제 쓰는지: (.*)\r?\n\r?\n([\s\S]*)$/.exec(text);
  return m ? { title: m[1], when: m[2], body: m[3].replace(/\r?\n$/, '') } : { title: '', when: '', body: text };
}

function createRecipeStore({ dir, now = Date.now }) {
  const indexFile = path.join(dir, 'index.json');
  const folder = (id) => {
    if (!RECIPE_ID.test(id)) throw new Error('Invalid recipe id');
    return path.join(dir, id);
  };
  const versionFile = (id, version) => path.join(folder(id), `v${Number(version)}.md`);

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return Array.isArray(raw.recipes) ? raw.recipes.filter((r) => RECIPE_ID.test(r?.id)) : [];
    } catch {
      return [];
    }
  }

  function write(recipes) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ recipes }));
    fs.renameSync(tmp, indexFile);
  }

  // A deleted recipe waits a moment for "되돌리기" (deletedAt), and is gone for everything else at once.
  const get = (id) => load().find((r) => r.id === id && !r.deletedAt) || null;
  const live = () => load().filter((r) => !r.deletedAt);
  const lastUse = (r) => r.lastUsedAt || r.updatedAt;
  /** Pinned first, in the order they were pinned; then the most recently used. */
  const ordered = (list) => [...list.filter((r) => r.pinned).sort((a, b) => (a.pinnedAt || 0) - (b.pinnedAt || 0)), ...list.filter((r) => !r.pinned).sort((a, b) => lastUse(b) - lastUse(a))];

  /** The text of one version (the current one by default), or null. */
  function read(id, version = null) {
    const meta = get(id);
    if (!meta) return null;
    const v = version ?? meta.version;
    try {
      return { ...parseRecipe(fs.readFileSync(versionFile(id, v), 'utf8')), version: v };
    } catch {
      return null;
    }
  }

  function versions(id) {
    if (!get(id)) return [];
    return fs.readdirSync(folder(id)).map((f) => /^v(\d+)\.md$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
  }

  function writeVersion(id, version, fields) {
    fs.mkdirSync(folder(id), { recursive: true });
    fs.writeFileSync(versionFile(id, version), renderRecipe(fields));
    for (const old of versions(id).slice(KEEP_VERSIONS + 1)) fs.rmSync(versionFile(id, old), { force: true });
  }

  const clean = ({ title, when, body }) => ({ title: oneLine(title, MAX_TITLE), when: oneLine(when, MAX_WHEN), body: String(body ?? '').slice(0, MAX_BODY).trimEnd() });

  return {
    get,
    read,
    versions,
    list: () => ordered(live()),
    create(fields, { sourceSessionId = null, sourceTitle = '', external = false } = {}) {
      const at = now();
      const c = clean(fields);
      const recipe = { id: `r-${crypto.randomBytes(8).toString('hex')}`, title: c.title, when: c.when, version: 1, createdAt: at, updatedAt: at, sourceSessionId, sourceTitle: oneLine(sourceTitle, MAX_TITLE), external: Boolean(external), useCount: 0, lastUsedAt: null };
      writeVersion(recipe.id, 1, c);
      write([...load(), recipe]);
      return recipe;
    },
    update(id, fields) {
      const all = load();
      const at = all.findIndex((r) => r.id === id && !r.deletedAt);
      if (at < 0) return null;
      const c = clean(fields);
      const version = all[at].version + 1;
      writeVersion(id, version, c);
      all[at] = { ...all[at], title: c.title, when: c.when, version, updatedAt: now() };
      write(all);
      return all[at];
    },
    /** An earlier version becomes the newest one; nothing is lost. */
    restore(id, version) {
      const old = read(id, version);
      return old ? this.update(id, old) : null;
    },
    /** A new title as a new version, so the history stays whole. */
    rename(id, title) {
      const current = read(id);
      return current ? this.update(id, { ...current, title }) : null;
    },
    setPinned(id, pinned) {
      const all = load();
      const at = all.findIndex((r) => r.id === id && !r.deletedAt);
      if (at < 0) return null;
      all[at] = { ...all[at], pinned: Boolean(pinned), pinnedAt: pinned ? now() : null };
      write(all);
      return all[at];
    },
    /** Out of every list at once; really removed by purge(), unless untrash() comes first. */
    trash(id) {
      const all = load();
      const at = all.findIndex((r) => r.id === id && !r.deletedAt);
      if (at < 0) return false;
      all[at] = { ...all[at], deletedAt: now() };
      write(all);
      return true;
    },
    untrash(id) {
      const all = load();
      const at = all.findIndex((r) => r.id === id && r.deletedAt);
      if (at < 0) return false;
      const { deletedAt, ...rest } = all[at];
      all[at] = rest;
      write(all);
      return true;
    },
    /** Removes trashed recipes for good: one, or all of them (on start, when no undo can still come). */
    purge(id = null) {
      for (const r of load().filter((x) => x.deletedAt && (id === null || x.id === id))) this.remove(r.id);
    },
    remove(id) {
      fs.rmSync(folder(id), { recursive: true, force: true });
      write(load().filter((r) => r.id !== id));
    },
    markUsed(id) {
      const all = load();
      const at = all.findIndex((r) => r.id === id && !r.deletedAt);
      if (at < 0) return null;
      all[at] = { ...all[at], useCount: all[at].useCount + 1, lastUsedAt: now() };
      write(all);
      return all[at];
    },
    /** What the model is told exists: titles and "when", most used and newest first, 50 at most. */
    catalog(excluded = []) {
      const skip = new Set(excluded);
      // Pinned recipes always make the list (in pin order), then the most used.
      const rest = live().filter((r) => !skip.has(r.id));
      return [...ordered(rest.filter((r) => r.pinned)), ...rest.filter((r) => !r.pinned).sort((a, b) => b.useCount - a.useCount || b.updatedAt - a.updatedAt)]
        .slice(0, CATALOG_MAX)
        .map((r) => ({ id: r.id, title: r.title, when: r.when, version: r.version }));
    },
  };
}

module.exports = { createRecipeStore, renderRecipe, parseRecipe, RECIPE_ID, KEEP_VERSIONS, CATALOG_MAX, MAX_BODY, MAX_TITLE };
