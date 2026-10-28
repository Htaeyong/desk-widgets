// #113: two PCs tidying the same synced note folder to id file names (lib/title-migration.js) through the engine's real
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

test('two PCs tidying the same old note folder end with equal records: no conflicts, no renames back and forth', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'todonote-title-sync-'));
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
  put('완료/보고서.md', '---\ncompleted: 2026-10-25 10:00\ndesk-widgets-memo: note-c\ndue: 2026-10-24\n---\n![a](보고서.assets/a.png)\n');
  put('완료/보고서.assets/a.png', 'png');
  put('완료/보고서 (2).md', '---\ncompleted: 2026-10-25 18:00\ndesk-widgets-memo: note-d\ndue: 2026-10-24\n---\n같은 날\n[회의](../회의%20(2).md)\n');
  const one = new SyncManager({ localDir: path.join(temp, 'state-one'), folder: provider, deviceId: 'd-11111111' });
  const two = new SyncManager({ localDir: path.join(temp, 'state-two'), folder: provider, deviceId: 'd-22222222' });
  const descriptor = (dir) => ({
    name: 'notes', dir: () => dir,
    include: (rel) => /^(?:완료\/)?[^/]+\.md$/.test(rel) || /^(?:완료\/)?[^/]+\.assets\/[^/]+$/.test(rel),
    idOf: (rel, text) => /^desk-widgets-memo:\s*(.+)$/im.exec(text)?.[1] || rel,
    maxFileBytes: 1024 * 1024,
  });
  t.after(openFileStore(one, 'todonote', descriptor(first)).close);
  t.after(openFileStore(two, 'todonote', descriptor(second)).close);
  await one.sync();
  await two.sync();
  assert.ok(fs.existsSync(path.join(second, '완료', '보고서.assets', 'a.png')), 'both PCs start with the old folder');
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
  assert.deepEqual(Object.keys(files(first)).sort(), ['note-a.md', 'note-b.md', '완료/note-c.assets/a.png', '완료/note-c.md', '완료/note-d.md'].sort());
  assert.match(files(first)['완료/note-d.md'], /\n\[회의\]\(\.\.\/note-b\.md\)\n$/, 'a link from another folder follows the rename');
  assert.equal(files(first)['완료/note-c.md'], '---\ntitle: 보고서\ncompleted: 2026-10-25 10:00\ndesk-widgets-memo: note-c\ndue: 2026-10-24\n---\n![a](note-c.assets/a.png)\n');
});
