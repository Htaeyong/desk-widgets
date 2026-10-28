// Moving the notes to a newly chosen note folder (#108, 2026-10-27): the settings ask "기존 노트를 새 폴더로
// 옮길까요?" and on "옮기기" this moves this widget's own files, like the #95 folder rename (lib/migrate.js):
//
// - what moves: note files (.md, .txt) at the top and in the widget's subfolders (보관함, 완료), and each note's
//   "<file name>.assets" folder. Other files in the folder stay where they are.
// - same name in the new folder: a note without attachments gets a free file name "<file name> (2).md" (its title
//   is in its front matter and stays, #113); a note with an .assets folder is refused (renaming it would break the
//   image links inside it) and nothing is moved.
// - copy every file, compare the bytes, and only then remove the originals: to the Recycle Bin (recoverable),
//   or not at all when the user keeps them. A failed copy removes what it made and changes nothing else.
// The same file is in widgets/memo and widgets/todonote (each widget installs on its own).
const fs = require('fs');
const path = require('path');

const NOTE = /\.(md|txt)$/i;
const lower = (p) => path.resolve(p).toLowerCase();
const inside = (base, target) => {
  const rel = path.relative(lower(base), lower(target));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function isDir(p, f) {
  try {
    return f.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p, f) {
  try {
    f.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Every file below a folder, relative paths. */
function treeFiles(dir, f, base = dir) {
  const out = [];
  for (const name of f.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = f.lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...treeFiles(full, f, base));
    else if (st.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * What would move, without touching anything.
 * @returns {{ notes: { rel, target, assets: string|null, targetAssets: string|null }[], refused: string[] }}
 *   rel/target: note paths relative to the old / new folder; assets: its .assets folder (relative) if any
 */
function planMove({ from, to, subfolders = [], fs: f = fs }) {
  const notes = [];
  const refused = [];
  const taken = new Set(); // lower-case targets already given out in this move
  for (const sub of ['', ...subfolders]) {
    const dir = path.join(from, sub);
    if (!isDir(dir, f)) continue;
    for (const name of f.readdirSync(dir).sort()) {
      if (!NOTE.test(name) || !f.lstatSync(path.join(dir, name)).isFile()) continue;
      const rel = path.join(sub, name);
      const stem = name.replace(NOTE, '');
      const ext = name.slice(stem.length);
      const assetsRel = path.join(sub, `${stem}.assets`);
      const assets = isDir(path.join(from, assetsRel), f) ? assetsRel : null;
      const free = (candidateStem) => {
        const t = path.join(sub, `${candidateStem}${ext}`);
        const a = path.join(sub, `${candidateStem}.assets`);
        return !exists(path.join(to, t), f) && !exists(path.join(to, a), f) && !taken.has(t.toLowerCase()) ? { t, a } : null;
      };
      let slot = free(stem);
      if (!slot) {
        if (assets) {
          refused.push(rel);
          continue;
        }
        for (let n = 2; n < 1000 && !slot; n++) slot = free(`${stem} (${n})`);
        if (!slot) {
          refused.push(rel);
          continue;
        }
      }
      taken.add(slot.t.toLowerCase());
      notes.push({ rel, target: slot.t, assets, targetAssets: assets ? slot.a : null });
    }
  }
  return { notes, refused };
}

/**
 * Moves the notes. Throws (and leaves everything as it was) when something cannot be moved safely.
 * @param {{ from: string, to: string, subfolders?: string[], keepOriginals?: boolean, trash?: (file: string) => Promise<void>, fs?: object }} o
 * @returns {Promise<{ moved: number, renamed: { from: string, to: string }[], pathMap: Record<string, string>, leftBehind: string[] }>}
 *   pathMap: lower-case absolute old note path -> new one (for the widget's remembered path ids)
 */
async function moveNotes({ from, to, subfolders = [], keepOriginals = false, trash = null, fs: f = fs }) {
  if (lower(from) === lower(to)) return { moved: 0, renamed: [], pathMap: {}, leftBehind: [] };
  if (inside(from, to) || inside(to, from)) throw new Error('새 노트 폴더가 지금 폴더 안에 있거나 지금 폴더를 품고 있어 옮길 수 없습니다. 따로 떨어진 폴더를 고르세요.');
  if (!isDir(from, f)) return { moved: 0, renamed: [], pathMap: {}, leftBehind: [] };
  const plan = planMove({ from, to, subfolders, fs: f });
  if (plan.refused.length) {
    throw new Error(`새 폴더에 같은 이름의 노트가 이미 있고 첨부 파일이 있어 이름을 바꿔 옮길 수 없습니다: ${plan.refused.slice(0, 5).join(', ')}${plan.refused.length > 5 ? ` 외 ${plan.refused.length - 5}개` : ''}. 그 파일을 정리하거나 다른 폴더를 고르세요. 아무것도 옮기지 않았습니다.`);
  }
  // Copy everything first, compare the bytes, and undo on any problem.
  const pairs = [];
  for (const n of plan.notes) {
    pairs.push([n.rel, n.target]);
    if (n.assets) for (const rel of treeFiles(path.join(from, n.assets), f)) pairs.push([path.join(n.assets, rel), path.join(n.targetAssets, rel)]);
  }
  const created = [];
  try {
    for (const [src, dst] of pairs) {
      const target = path.join(to, dst);
      f.mkdirSync(path.dirname(target), { recursive: true });
      f.copyFileSync(path.join(from, src), target, fs.constants.COPYFILE_EXCL);
      created.push(target);
      if (!f.readFileSync(path.join(from, src)).equals(f.readFileSync(target))) throw new Error(`복사한 파일이 원본과 다릅니다: ${src}`);
    }
  } catch (error) {
    for (const file of created.reverse()) {
      try { f.unlinkSync(file); } catch { /* the original is still there */ }
    }
    throw new Error(`노트를 새 폴더로 복사하지 못해 아무것도 옮기지 않았습니다(${error.code || error.message}).`);
  }
  const pathMap = {};
  for (const n of plan.notes) pathMap[lower(path.join(from, n.rel))] = lower(path.join(to, n.target));
  const leftBehind = [];
  if (!keepOriginals) {
    for (const n of plan.notes) {
      for (const rel of [n.rel, n.assets].filter(Boolean)) {
        try {
          if (trash) await trash(path.join(from, rel));
          else f.rmSync(path.join(from, rel), { recursive: true });
        } catch {
          leftBehind.push(rel);
        }
      }
    }
  }
  const renamed = plan.notes.filter((n) => n.rel.toLowerCase() !== n.target.toLowerCase()).map((n) => ({ from: n.rel, to: n.target }));
  return { moved: plan.notes.length, renamed, pathMap, leftBehind };
}

module.exports = { moveNotes, planMove };
