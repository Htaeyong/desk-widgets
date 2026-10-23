// #95: the widget was renamed 메모 -> 스티키 노트, and so was its default folder:
// Documents\Desk Widgets\메모 -> Documents\Desk Widgets\스티키 노트. Runs once, only for users who kept the default.
//
// - old folder missing or empty: nothing to do (the new default is used)
// - old has files, new missing or empty: rename old -> new (one step, nothing copied)
//   - rename refused (locked file, OneDrive, another drive): copy into "<new>.copying", check every file, then rename
//     that to the new name; the old folder stays and the user is told to look and remove it
//   - copy or check failed: keep using the old folder (saved as the chosen folder) and say so
// - both have files: never merged; keep using the old folder and say so
// Nothing is ever deleted except an empty new folder that is replaced by the rename.
const fs = require('fs');
const path = require('path');

const OLD_NAME = '메모';

const oldDefaultDir = (documents) => path.join(documents, 'Desk Widgets', OLD_NAME);

function entries(dir, f) {
  try {
    return f.readdirSync(dir);
  } catch {
    return null; // missing (or unreadable)
  }
}

/** Every file below a folder: [{ rel, size }], sorted. */
function listFiles(dir, f, base = dir) {
  const out = [];
  for (const name of f.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = f.statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, f, base));
    else out.push({ rel: path.relative(base, full), size: st.size });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Copies a folder tree file by file (fs.cpSync crashes the process on Windows with non-ASCII paths in Node 22, seen
 * while writing this). Fails on any file that is already there.
 */
function copyTree(from, to, f) {
  f.mkdirSync(to);
  for (const name of f.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const st = f.statSync(src);
    if (st.isDirectory()) copyTree(src, dst, f);
    else {
      f.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      f.utimesSync(dst, st.atime, st.mtime);
    }
  }
}

/** Same files, sizes and bytes in both folders? */
function sameTree(a, b, f) {
  const la = listFiles(a, f);
  const lb = listFiles(b, f);
  if (la.length !== lb.length) return false;
  return la.every((x, i) => x.rel === lb[i].rel && x.size === lb[i].size && f.readFileSync(path.join(a, x.rel)).equals(f.readFileSync(path.join(b, x.rel))));
}

/**
 * @param {{ documents: string, newDir: string, fs?: object }} o  newDir: the new default folder
 * @returns {{ result: string, useDir: string | null, notice: string | null }}
 *   useDir: a folder to save as the chosen notes folder (the old one when it must stay in use), else null
 */
function migrateDefaultFolder({ documents, newDir, fs: f = fs }) {
  const oldDir = oldDefaultDir(documents);
  const oldList = entries(oldDir, f);
  if (!oldList || oldList.length === 0) return { result: 'nothing', useDir: null, notice: null };
  const newList = entries(newDir, f);
  if (newList && newList.length > 0) {
    return {
      result: 'both',
      useDir: oldDir,
      notice: `노트 폴더가 두 곳에 있어 합치지 않고 예전 폴더(${oldDir})를 계속 씁니다. 새 이름의 폴더(${newDir})에도 파일이 있으니 확인한 뒤 설정에서 쓸 폴더를 고르세요.`,
    };
  }
  try {
    if (newList) f.rmdirSync(newDir); // empty: only so that the rename can take its name
    f.renameSync(oldDir, newDir);
    return { result: 'renamed', useDir: null, notice: `위젯 이름이 '스티키 노트'로 바뀌어 노트 폴더 이름도 바꿨습니다: ${newDir}` };
  } catch (renameErr) {
    // Copy next to it, check, then give it the new name: the new folder is never half there.
    const tmp = `${newDir}.copying`;
    try {
      if (entries(tmp, f)) throw new Error(`${tmp} 폴더가 이미 있습니다.`);
      copyTree(oldDir, tmp, f);
      if (!sameTree(oldDir, tmp, f)) throw new Error('복사한 파일이 원본과 다릅니다.');
      if (entries(newDir, f)) f.rmdirSync(newDir);
      f.renameSync(tmp, newDir);
      return {
        result: 'copied',
        useDir: null,
        notice: `노트 폴더를 새 이름으로 복사했습니다: ${newDir}. 예전 폴더(${oldDir})는 사용 중이라(${renameErr.code || renameErr.message}) 옮기지 못해 그대로 두었습니다. 새 폴더를 확인한 뒤 예전 폴더는 직접 지워도 됩니다.`,
      };
    } catch (copyErr) {
      return {
        result: 'kept',
        useDir: oldDir,
        notice: `노트 폴더 이름을 바꾸지 못해 예전 폴더(${oldDir})를 계속 씁니다(${copyErr.message}).${entries(tmp, f) ? ` 복사하다 만 폴더 ${tmp}는 지워도 됩니다.` : ''}`,
      };
    }
  }
}

module.exports = { migrateDefaultFolder, oldDefaultDir, sameTree, copyTree };
