// #113 (sticky notes): two PCs tidying the same synced note folder (lib/title-migration.js) through the engine's real
// file store and sync core end with equal records: no conflicts, nothing to import, no renames back and forth.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openFileStore } = require('../../../engine/main/files-store');
const { SyncManager } = require('../../../engine/main/sync');
const { Library } = require('../lib/library');
const TM = require('../lib/title-migration');

/** Every file under dir except dot folders (relative path -> text). */
function files(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('two PCs tidying the same old sticky note folder end with equal records: no conflicts, nothing to import', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-title-sync-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const provider = path.join(temp, 'provider');
  fs.mkdirSync(path.join(provider, 'Desk Widgets Sync'), { recursive: true });
  const first = path.join(temp, 'first-notes');
  const second = path.join(temp, 'second-notes');
  fs.mkdirSync(second);
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(first, rel)), { recursive: true });
    fs.writeFileSync(path.join(first, rel), text);
  };
  put('회의.md', '---\ndesk-widgets-memo: note-a\n---\n하나\n');
  put('회의 (2).md', '---\ndesk-widgets-memo: note-b\n---\n둘\n');
  put('보관함/회의 (3).md', '---\ndesk-widgets-memo: note-c\n---\n![a](회의%20(3).assets/a.png)\n');
  put('보관함/회의 (3).assets/a.png', 'png');
  put('장 (2).md', '---\ndesk-widgets-memo: note-d\n---\n직접 지은 이름\n');
  put('링크.md', '---\ndesk-widgets-memo: note-e\n---\n[[회의 (2)]] [둘째](회의%20(2).md) ![a](보관함/회의%20(3).assets/a.png)\n');
  const one = new SyncManager({ localDir: path.join(temp, 'state-one'), folder: provider, deviceId: 'd-11111111' });
  const two = new SyncManager({ localDir: path.join(temp, 'state-two'), folder: provider, deviceId: 'd-22222222' });
  const descriptor = (dir) => ({
    name: 'notes', dir: () => dir,
    include: (rel) => /^(?:보관함\/)?[^/]+\.md$/.test(rel) || /^(?:보관함\/)?[^/]+\.assets\/[^/]+$/.test(rel),
    idOf: (rel, text) => /^desk-widgets-memo:\s*(.+)$/im.exec(text)?.[1] || rel,
    maxFileBytes: 1024 * 1024,
  });
  t.after(openFileStore(one, 'memo', descriptor(first)).close);
  t.after(openFileStore(two, 'memo', descriptor(second)).close);
  await one.sync();
  await two.sync();
  assert.ok(fs.existsSync(path.join(second, '보관함', '회의 (3).assets', 'a.png')), 'both PCs start with the old folder');
  // Each PC runs the new widget before hearing from the other.
  for (const dir of [first, second]) {
    const lib = new Library({ dir, ids: { load: () => ({}), save() {} } });
    await lib.scan();
    assert.deepEqual((await TM.apply(TM.plan(lib))).failed, []);
  }
  await one.sync();
  const plan = await two.preview();
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.imports, [], 'the other PC already has the same files');
  await two.sync();
  await one.sync();
  assert.deepEqual((await one.preview()).imports, []);
  assert.deepEqual(files(second), files(first));
  assert.deepEqual(Object.keys(files(first)).sort(), ['note-a.md', 'note-b.md', 'note-d.md', 'note-e.md', '보관함/note-c.assets/a.png', '보관함/note-c.md'].sort());
  assert.equal(files(first)['note-e.md'], '---\ntitle: 링크\ndesk-widgets-memo: note-e\n---\n[[회의 (2)]] [둘째](note-b.md) ![a](보관함/note-c.assets/a.png)\n', 'file links follow the renames');
  assert.match(files(first)['note-b.md'], /^---\ntitle: 회의 \(2\)\n/, 'linked as [[회의 (2)]]: the number stays');
  assert.equal(files(first)['보관함/note-c.md'], '---\ntitle: 회의\ndesk-widgets-memo: note-c\n---\n![a](note-c.assets/a.png)\n', 'the number the old version added goes; the link follows the assets');
  assert.match(files(first)['note-d.md'], /^---\ntitle: 장 \(2\)\n/, 'no sibling: kept');
});
