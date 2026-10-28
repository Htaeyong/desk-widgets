// One tidy-up of a note folder written before #113 (file names apart from titles), run once per note folder on the
// first start of this version and when the note folder changes to such a folder:
//
// (a) every note with our id gets "title:" in its front matter when it has none: the title it shows now (its file
//     name);
// (c) a numbered title "X (n)" that an old version added to keep file names apart (another note is titled "X" or
//     "X (m)") becomes "X". A numbered title with no such sibling may be one the user typed: kept. Kept too when
//     another note links to it as [[X (n)]]: after the rename only the title can still find it;
// (b) every note with our id moves to its id file name in the same folder, with its assets folder, and its links to
//     the assets follow: "YYYYMMDD-HHmmss-<id>.md" when its front matter has "created:", else "<id>.md". Old notes
//     have no creation time both PCs agree on (file times differ between PCs and after a sync), and a made-up
//     "00000000-000000" would look like a date, so they are named by id alone. This also renames the
//     "YYYY-MM-DD 제목.md" done files of the 0.0.4-test.8 build.
// (d) relative links in any note (ours or not) to a renamed note or into its assets folder, "[x](회의%20(2).md)",
//     "[x](완료/보고서.md#할 일)", "![a](../회의.assets/a.png)", point at the new names. Only names that really
//     changed count, so the links to a note that failed stay.
//
// Files without our id (made in Explorer or another program) keep their name and front matter; their title is their
// file name until the widget saves them. Only their links to renamed notes change (d).
//
// Two PCs may tidy the same synced folder. Everything depends only on the folder's files (titles, front matter,
// note ids), so both write the same bytes and names, and the sync sees equal records instead of conflicts. A note
// that fails (e.g. its id name is taken) is left as it was and reported; nothing is deleted. Running it again
// changes nothing. The same file is in widgets/memo and widgets/todonote.
const fs = require('fs');
const path = require('path');
const md = require('./markdown');
const F = require('./files');
const { relinkAssets } = require('./library');

const FORMAT = 2; // the marker kept per note folder in the widget's settings (titleFormat); 1 = titles only (test builds)
const NUMBERED = /^(.*\S) \((\d+)\)$/;

const keyOf = (s) => String(s).normalize('NFC').toLowerCase();
const lower = (p) => path.resolve(p).toLowerCase();
const stemOf = (file) => path.basename(file, path.extname(file));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * What the tidy-up would change in a scanned Library: [{ id, file, title (to write) | null, stem (new file name
 * without extension) | null, unnumbered (rule (c) took a number off the title), relink (has links to fix, (d)) }].
 */
function plan(lib) {
  const all = lib.list().filter((m) => !m.conflictOf);
  const baseOf = (title) => keyOf(NUMBERED.exec(title)?.[1] ?? '');
  const out = [];
  for (const m of all) {
    if (m.ext !== 'md' || m.tooBig || !m.hasFmId) continue;
    let title = null;
    if (!m.fmTitle) {
      title = m.title;
      const n = NUMBERED.exec(title);
      if (n && Number(n[2]) >= 2) {
        const base = keyOf(n[1]);
        const sibling = all.some((o) => o !== m && (keyOf(o.title) === base || baseOf(o.title) === base));
        const linked = all.some((o) => o !== m && (o.links || []).includes(md.wikiKey(title)));
        if (sibling && !linked) title = n[1];
      }
    }
    const stem = F.isIdFileStem(stemOf(m.file), m.id) ? null : F.idFileStem(m.id, m.created);
    if (title || stem) out.push({ id: m.id, file: m.file, title, stem, unnumbered: Boolean(title) && title !== m.title, relink: false });
  }
  // (d): every Markdown note with a link that the planned renames would break.
  const moves = movesOf(out.filter((i) => i.stem).map((i) => ({ from: i.file, to: path.join(path.dirname(i.file), `${i.stem}.md`) })));
  if (moves.size) {
    for (const m of lib.list()) {
      if (m.ext !== 'md' || m.tooBig) continue;
      let text;
      try {
        text = fs.readFileSync(m.file, 'utf8');
      } catch {
        continue;
      }
      if (relinkFiles(text, path.dirname(m.file), moves) === text) continue;
      const item = out.find((i) => i.file === m.file);
      if (item) item.relink = true;
      else out.push({ id: m.id, file: m.file, title: null, stem: null, unnumbered: false, relink: true });
    }
  }
  return out.sort(byId);
}

/** Renamed notes as a map: lower(old path) -> { to, assets } for the file and for its assets folder. */
function movesOf(renames) {
  const moves = new Map();
  for (const { from, to } of renames) {
    moves.set(lower(from), { to, assets: false });
    moves.set(lower(path.join(path.dirname(from), `${stemOf(from)}.assets`)), { to: path.join(path.dirname(to), `${stemOf(to)}.assets`), assets: true });
  }
  return moves;
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * A note's text with its relative links "](dest)" pointing at the new names (moves: movesOf()), for a note in dir.
 * Links to a renamed note file or to a file inside its assets folder change; code spans and blocks stay.
 */
function relinkFiles(text, dir, moves) {
  const fix = (part) =>
    part.replace(/(\]\()(<[^>\n]+>|(?:[^()\s]|\([^()\s]*\))+)/g, (all, open, raw) => {
      const angle = raw.startsWith('<');
      const dest = angle ? raw.slice(1, -1) : raw;
      if (/^[a-z][a-z0-9+.-]*:/i.test(dest) || /^[#/\\]/.test(dest)) return all;
      const hash = dest.indexOf('#');
      const target = hash < 0 ? dest : dest.slice(0, hash);
      const anchor = hash < 0 ? '' : dest.slice(hash);
      if (!target) return all;
      const abs = path.resolve(dir, decode(target).replace(/\\/g, '/'));
      let to = moves.get(lower(abs))?.to;
      if (!to) {
        // A file inside a renamed note's assets folder.
        const parent = moves.get(lower(path.dirname(abs)));
        if (parent?.assets) to = path.join(parent.to, path.basename(abs));
      }
      if (!to) return all;
      const rel = path.relative(dir, to).split(path.sep).join('/');
      return `${open}${angle ? `<${rel}${anchor}>` : `${md.encodeDest(rel)}${anchor}`}`;
    });
  const parts = String(text).split(/(^```[\s\S]*?^```[ \t]*$|^~~~[\s\S]*?^~~~[ \t]*$)/m);
  return parts.map((part, k) => (k % 2 ? part : part.split(/(`+[^`\n]*?`+)/).map((p, j) => (j % 2 ? p : fix(p))).join(''))).join('');
}

/** The file's text with "title:" in its front matter (every other byte of the front matter lines and body kept). */
function withTitle(text, title) {
  const fm = md.splitFrontMatter(text);
  return `---\n${md.withFrontMatterTitle(fm.lines || [], title).join('\n')}\n---\n${fm.body}`;
}

async function writeVerified(file, text, mtime) {
  await F.writeFileAtomic(file, text);
  if (fs.readFileSync(file, 'utf8') !== text) throw new Error('다시 읽은 내용이 다릅니다');
  // The note keeps its "last changed" time: the list order and the done folder's auto-delete clock stay as they were.
  if (mtime) fs.utimesSync(file, new Date(), mtime);
}

/** Applies one planned change; on a failure the note is put back as it was and the error thrown. */
async function applyOne(item) {
  const st = fs.statSync(item.file);
  const before = fs.readFileSync(item.file, 'utf8');
  let text = item.title ? withTitle(before, item.title) : before;
  if (!item.stem) {
    if (text !== before) await writeVerified(item.file, text, st.mtime);
    return item.file;
  }
  const dir = path.dirname(item.file);
  const target = path.join(dir, `${item.stem}.md`);
  const oldAssets = path.join(dir, `${stemOf(item.file)}.assets`);
  const newAssets = path.join(dir, `${item.stem}.assets`);
  if (fs.existsSync(target) || fs.existsSync(newAssets)) throw new Error('새 이름이 이미 있습니다');
  const hasAssets = fs.existsSync(oldAssets);
  // A rename in the same folder moves nothing: the file is the same bytes under a new name.
  await F.renameRetry(item.file, target);
  try {
    if (hasAssets) {
      await F.renameRetry(oldAssets, newAssets);
      text = relinkAssets(text, path.basename(oldAssets), path.basename(newAssets));
    }
    try {
      if (text !== before) await writeVerified(target, text, st.mtime);
    } catch (err) {
      if (hasAssets) await F.renameRetry(newAssets, oldAssets);
      throw err;
    }
  } catch (err) {
    await F.renameRetry(target, item.file).catch(() => {});
    // The old text, in case a half write got through.
    if (fs.existsSync(item.file) && fs.readFileSync(item.file, 'utf8') !== before) await F.writeFileAtomic(item.file, before).catch(() => {});
    throw err;
  }
  return target;
}

/** Rewrites the links of one note (d), keeping its change time; on a failure the note is left as it was. */
async function relinkOne(file, moves) {
  const st = fs.statSync(file);
  const before = fs.readFileSync(file, 'utf8');
  const text = relinkFiles(before, path.dirname(file), moves);
  if (text === before) return false;
  try {
    await writeVerified(file, text, st.mtime);
  } catch (err) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== before) await F.writeFileAtomic(file, before).catch(() => {});
    throw err;
  }
  return true;
}

/**
 * Runs a plan: { changed, unnumbered (titles that lost a number), relinked (notes whose links were fixed), failed:
 * [file name], renamed: [{ from, to }] }. Renames and titles first, then the links, only to names that changed.
 */
async function apply(items) {
  const result = { changed: 0, unnumbered: 0, relinked: 0, failed: [], renamed: [] };
  const done = [];
  const where = new Map(); // item -> its file after the first pass
  for (const item of items) {
    where.set(item, item.file);
    if (!item.title && !item.stem) continue;
    try {
      const file = await applyOne(item);
      where.set(item, file);
      result.changed++;
      if (item.unnumbered) result.unnumbered++;
      if (file !== item.file) {
        result.renamed.push({ from: path.basename(item.file), to: path.basename(file) });
        done.push({ from: item.file, to: file });
      }
    } catch {
      result.failed.push(path.basename(item.file));
    }
  }
  const moves = movesOf(done);
  for (const item of items) {
    if (!item.relink || !moves.size || result.failed.includes(path.basename(item.file))) continue;
    try {
      if (!(await relinkOne(where.get(item), moves))) continue;
      result.relinked++;
      if (!item.title && !item.stem) result.changed++;
    } catch {
      result.failed.push(path.basename(item.file));
    }
  }
  return result;
}

/** The one-line message for the list after a tidy-up. */
function noticeText(result) {
  const parts = [];
  if (result.changed) {
    const head = result.renamed.length ? `노트 저장 방식이 바뀌어 기존 노트 ${result.renamed.length}개의 파일 이름을 바꿨습니다.` : `노트 저장 방식이 바뀌어 기존 노트 ${result.changed}개를 정리했습니다.`;
    const tail = result.unnumbered ? `내용은 그대로이고, 제목 끝에 자동으로 붙었던 번호 ${result.unnumbered}개만 뺐습니다.` : '제목과 내용은 그대로입니다.';
    const links = result.relinked ? ` 노트 ${result.relinked}개 안의 파일 링크도 새 이름으로 고쳤습니다.` : '';
    parts.push(`${head} ${tail}${links}`);
  }
  if (result.failed.length) parts.push(`정리하지 못한 노트 ${result.failed.length}개(그대로 둠, 다음에 켤 때 다시 시도): ${result.failed.slice(0, 5).join(', ')}${result.failed.length > 5 ? ' …' : ''}.`);
  return parts.join(' ');
}

module.exports = { FORMAT, plan, apply, noticeText, relinkFiles };
