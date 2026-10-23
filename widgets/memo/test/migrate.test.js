// #95: the default notes folder "Documents\Desk Widgets\메모" becomes "...\스티키 노트" once, for default-folder users.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateDefaultFolder, oldDefaultDir } = require('../lib/migrate');
const S = require('../lib/settings');

function setup() {
  const documents = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-docs-'));
  const oldDir = oldDefaultDir(documents);
  const newDir = S.defaultNotesDir(documents);
  const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const seedOld = () => {
    write(oldDir, '장보기.md', '---\ndesk-widgets-memo: abc123\n---\n- [ ] 우유\n');
    write(oldDir, '장보기.assets/영수증.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    write(oldDir, '보관함/옛것.txt', '옛 메모\n');
  };
  return { documents, oldDir, newDir, write, seedOld };
}

const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test('folder names: 메모 -> 스티키 노트 under Documents\\Desk Widgets', () => {
  assert.equal(oldDefaultDir('C:\\Users\\a\\Documents'), 'C:\\Users\\a\\Documents\\Desk Widgets\\메모');
  assert.equal(S.defaultNotesDir('C:\\Users\\a\\Documents'), 'C:\\Users\\a\\Documents\\Desk Widgets\\스티키 노트');
});

test('no old folder (new user) or an empty one: nothing happens', () => {
  const t = setup();
  assert.deepEqual(migrateDefaultFolder({ documents: t.documents, newDir: t.newDir }), { result: 'nothing', useDir: null, notice: null });
  fs.mkdirSync(t.oldDir, { recursive: true });
  assert.equal(migrateDefaultFolder({ documents: t.documents, newDir: t.newDir }).result, 'nothing');
  assert.ok(fs.existsSync(t.oldDir), 'an empty old folder is left alone');
});

test('old folder with notes and no new folder: renamed in one step, everything there', () => {
  const t = setup();
  t.seedOld();
  const before = tree(t.oldDir);
  const r = migrateDefaultFolder({ documents: t.documents, newDir: t.newDir });
  assert.equal(r.result, 'renamed');
  assert.equal(r.useDir, null);
  assert.match(r.notice, /스티키 노트/);
  assert.ok(!fs.existsSync(t.oldDir));
  assert.deepEqual(tree(t.newDir), before);
  assert.equal(fs.readFileSync(path.join(t.newDir, '장보기.md'), 'utf8'), '---\ndesk-widgets-memo: abc123\n---\n- [ ] 우유\n');
});

test('an empty new folder (e.g. created by an earlier start) is replaced by the rename', () => {
  const t = setup();
  t.seedOld();
  fs.mkdirSync(t.newDir, { recursive: true });
  assert.equal(migrateDefaultFolder({ documents: t.documents, newDir: t.newDir }).result, 'renamed');
  assert.ok(fs.existsSync(path.join(t.newDir, '장보기.md')));
});

test('both folders have files: never merged, the old one stays in use with a notice', () => {
  const t = setup();
  t.seedOld();
  t.write(t.newDir, '다른 것.md', '새 폴더 내용\n');
  const r = migrateDefaultFolder({ documents: t.documents, newDir: t.newDir });
  assert.equal(r.result, 'both');
  assert.equal(r.useDir, t.oldDir);
  assert.match(r.notice, /합치지 않고/);
  assert.deepEqual(tree(t.newDir), ['다른 것.md']);
  assert.ok(fs.existsSync(path.join(t.oldDir, '장보기.md')));
});

test('rename refused (locked, OneDrive): copied, checked, old folder left in place with a notice', () => {
  const t = setup();
  t.seedOld();
  let refused = 0;
  const lockedFs = {
    ...fs,
    renameSync: (a, b) => {
      if (a === t.oldDir) {
        refused++;
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return fs.renameSync(a, b);
    },
  };
  const r = migrateDefaultFolder({ documents: t.documents, newDir: t.newDir, fs: lockedFs });
  assert.equal(refused, 1);
  assert.equal(r.result, 'copied');
  assert.equal(r.useDir, null);
  assert.match(r.notice, /그대로 두었습니다/);
  assert.match(r.notice, /EPERM/);
  assert.deepEqual(tree(t.newDir), tree(t.oldDir), 'same files in both');
  assert.ok(!fs.existsSync(`${t.newDir}.copying`));
  assert.ok(fs.readFileSync(path.join(t.newDir, '장보기.assets', '영수증.png')).equals(Buffer.from([137, 80, 78, 71, 1, 2, 3])));
});

test('rename refused and the copy fails or differs: the old folder stays in use, the new name is not taken', () => {
  for (const mode of ['copy-fails', 'copy-differs']) {
    const t = setup();
    t.seedOld();
    const badFs = {
      ...fs,
      renameSync: (a, b) => {
        if (a === t.oldDir) {
          const err = new Error('busy');
          err.code = 'EBUSY';
          throw err;
        }
        return fs.renameSync(a, b);
      },
      copyFileSync: (a, b, flags) => {
        if (mode === 'copy-fails') throw new Error('disk full');
        fs.copyFileSync(a, b, flags);
        if (b.endsWith('장보기.md')) fs.writeFileSync(b, 'broken');
      },
    };
    const r = migrateDefaultFolder({ documents: t.documents, newDir: t.newDir, fs: badFs });
    assert.equal(r.result, 'kept', mode);
    assert.equal(r.useDir, t.oldDir);
    assert.match(r.notice, /예전 폴더/);
    assert.match(r.notice, /\.copying/, 'the half copy is named so the user can remove it');
    assert.ok(!fs.existsSync(t.newDir), `${mode}: the new name is not taken by a bad copy`);
    assert.equal(fs.readFileSync(path.join(t.oldDir, '장보기.md'), 'utf8'), '---\ndesk-widgets-memo: abc123\n---\n- [ ] 우유\n');
  }
});

test('a leftover "<new>.copying" folder is never overwritten', () => {
  const t = setup();
  t.seedOld();
  t.write(`${t.newDir}.copying`, 'x.md', 'left from before');
  const lockedFs = {
    ...fs,
    renameSync: (a, b) => {
      if (a === t.oldDir) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return fs.renameSync(a, b);
    },
  };
  const r = migrateDefaultFolder({ documents: t.documents, newDir: t.newDir, fs: lockedFs });
  assert.equal(r.result, 'kept');
  assert.equal(fs.readFileSync(path.join(`${t.newDir}.copying`, 'x.md'), 'utf8'), 'left from before');
});
