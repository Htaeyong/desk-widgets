// Header cache per account (#65): <dataDir>\cache\<accountId>.json with the last N headers (sender, subject,
// date, flags, MIME structure) for an instant start. No bodies and no snippets are ever written here.
const fs = require('fs');
const path = require('path');

function fileCache(dir, accountId) {
  const file = path.join(dir, `${accountId}.json`);
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    save(obj) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, file);
    },
    remove() {
      fs.rmSync(file, { force: true });
    },
  };
}

/** Removes cache files of accounts that no longer exist. */
function pruneCaches(dir, keepIds) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const keep = new Set(keepIds.map((id) => `${id}.json`));
  for (const n of names) if (n.endsWith('.json') && !keep.has(n)) fs.rmSync(path.join(dir, n), { force: true });
}

module.exports = { fileCache, pruneCaches };
