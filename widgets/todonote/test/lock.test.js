// Password-locked notes (#124, docs/todonote-lock-design.md): nothing of a locked note's text may be readable on disk
// or through the widget's other ways out, and everything keeps working on the plain front matter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/lock');
const md = require('../lib/markdown');
const { Library } = require('../lib/library');
const { MemoSession } = require('../lib/session');
const TM = require('../lib/title-migration');
const { setup } = require('./fake-engine');

const FAST = { N: 1024, r: 8, p: 1 };
const PASSWORD = '올바른-password-1';
const SECRET = '은행 비밀번호 1234 secret-text';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let ids = {};
  const lib = new Library({ dir, ids: { load: () => ids, save: (m) => (ids = m) }, kdf: FAST });
  return { dir, lib, fresh: () => new Library({ dir, ids: { load: () => ids, save: (m) => (ids = m) }, kdf: FAST }) };
}

/** Every byte under a folder, as text, to search for what must not be there. */
function allBytes(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out.push(e.name);
    if (e.isDirectory()) out.push(allBytes(full));
    else out.push(fs.readFileSync(full).toString('utf8'), fs.readFileSync(full).toString('latin1'));
  }
  return out.join('\n');
}

async function lockedNote(t, { title = '메모', body = `${SECRET}\n`, fm = null } = {}) {
  const f = folder(t);
  const m = await f.lib.create({ title, body, fm });
  await f.lib.lock(m.id, PASSWORD);
  return { ...f, m };
}

// ---- the crypto ----

test('the default key derivation really is scrypt N=2^17, r=8, p=1, and only the right password opens the key', async () => {
  assert.deepEqual(L.KDF, { N: 2 ** 17, r: 8, p: 1 });
  const { dek, header } = await L.newKey(PASSWORD);
  assert.equal(header.N, 2 ** 17);
  assert.deepEqual(await L.openKey(header, PASSWORD), dek);
  await assert.rejects(L.openKey(header, 'wrong-password'), (e) => e.code === 'wrong-password');
});

test('a password is the same however its Hangul is composed (NFC / NFD)', async () => {
  const { dek, header } = await L.newKey('비밀번호1234', FAST);
  assert.deepEqual(await L.openKey(header, '비밀번호1234'.normalize('NFD')), dek);
});

test('any password is accepted, however short; only an empty one is refused (user decision)', () => {
  assert.ok(L.passwordProblem(''));
  for (const any of ['1', '0000', ' ', '12345678']) assert.equal(L.passwordProblem(any), null);
  assert.ok(L.passwordProblem(undefined));
});

test('sealing twice never repeats salt or nonce; a header asking for absurd memory is not used', async () => {
  const a = await L.newKey(PASSWORD, FAST);
  const b = await L.newKey(PASSWORD, FAST);
  assert.notEqual(a.header.salt, b.header.salt);
  const one = L.parseBody(L.sealBody(a.dek, a.header, { body: 'x', assets: null }));
  const two = L.parseBody(L.sealBody(a.dek, a.header, { body: 'x', assets: null }));
  assert.notEqual(one.nonce, two.nonce);
  assert.notDeepEqual(one.sealed, two.sealed);
  await assert.rejects(L.openKey({ ...a.header, N: 2 ** 30 }, PASSWORD), (e) => e.code === 'corrupt');
  const text = L.sealBody(a.dek, { ...a.header, N: 2 ** 30 }, { body: 'x', assets: null });
  assert.equal(L.parseBody(text), null);
});

test('an attachment put in another attachment\'s place, or changed, does not open', async () => {
  const { dek } = await L.newKey(PASSWORD, FAST);
  const sealed = L.sealAsset(dek, 'a.png', Buffer.from('image'));
  assert.deepEqual(L.openAsset(dek, sealed), { name: 'a.png', bytes: Buffer.from('image') });
  const changed = Buffer.from(sealed);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => L.openAsset(dek, changed), (e) => e.code === 'corrupt');
  assert.ok(L.isAssetFile(L.assetFileName(dek, '연봉계약서.pdf')));
  assert.doesNotMatch(L.assetFileName(dek, '연봉계약서.pdf'), /연봉/);
});

test('the padlock: not locked, locked and asking, locked and open, cannot be locked', () => {
  assert.deepEqual(L.lockIcon({ lockable: true }), { icon: '🔓', state: 'open', title: '암호로 잠그기', action: 'set' });
  const asking = L.lockIcon({ locked: true });
  assert.equal(asking.icon, '🔒');
  assert.equal(asking.action, null);
  const open = L.lockIcon({ locked: true, unlocked: true });
  assert.equal(open.icon, '🔒');
  assert.equal(open.action, 'menu');
  assert.match(open.title, /잠긴 노트/);
  assert.equal(L.lockIcon({ lockable: false }), null);
  assert.equal(L.lockIcon(), null);
});

// ---- the file ----

test('a locked file: .md, title, due and id readable; the text, password and keys nowhere', async (t) => {
  const { dir, m, lib } = await lockedNote(t, { title: '은행', fm: { due: '2026-12-01' } });
  assert.match(m.file, /\.md$/);
  const text = fs.readFileSync(m.file, 'utf8');
  const fm = md.splitFrontMatter(text);
  assert.equal(fm.id, m.id);
  assert.equal(md.frontMatterTitle(fm.lines), '은행');
  assert.ok(fm.lines.includes('due: 2026-12-01'));
  assert.match(text, /🔒/); // what Obsidian and other editors show
  assert.match(text, /```desk-widgets-locked/);
  const all = allBytes(dir);
  for (const leak of ['은행 비밀번호', 'secret-text', PASSWORD]) assert.ok(!all.includes(leak), leak);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), []);
  assert.deepEqual(await lib.read(m.id).then((r) => r.body), `${SECRET}\n`);
});

test('the list index holds nothing of a locked body, also after a restart and while it is open', async (t) => {
  const { lib, m, fresh } = await lockedNote(t);
  for (const x of [lib.get(m.id), await (async () => { const l = fresh(); await l.scan(); return l.get(m.id); })()]) {
    assert.equal(x.locked, true);
    assert.equal(x.preview, '');
    assert.equal(x.search, '');
    assert.deepEqual(x.links, []);
    assert.equal(x.title, '메모');
  }
});

test('without its password a locked note cannot be read or written, and the file stays', async (t) => {
  const { m, fresh } = await lockedNote(t);
  const lib = fresh();
  await lib.scan();
  const before = fs.readFileSync(m.file);
  await assert.rejects(lib.read(m.id), (e) => e.code === 'locked');
  await assert.rejects(lib.write(m.id, 'plain text'), (e) => e.code === 'locked');
  assert.throws(() => lib.writeSync(m.id, 'plain text'), (e) => e.code === 'locked');
  assert.equal(lib.resolveAsset(m.id, 'a.png'), null);
  assert.deepEqual(fs.readFileSync(m.file), before);
});

test('wrong password: refused, nothing changes; right password: the text; every save is new ciphertext', async (t) => {
  const { m, fresh } = await lockedNote(t);
  const lib = fresh();
  await lib.scan();
  const before = fs.readFileSync(m.file, 'utf8');
  await assert.rejects(lib.unlock(m.id, 'not-the-password'), (e) => e.code === 'wrong-password');
  assert.equal(lib.isUnlocked(m.id), false);
  assert.equal(fs.readFileSync(m.file, 'utf8'), before);
  await lib.unlock(m.id, PASSWORD);
  assert.equal((await lib.read(m.id)).body, `${SECRET}\n`);
  await lib.write(m.id, '새 내용 unique-new-words\n');
  const after = fs.readFileSync(m.file, 'utf8');
  assert.ok(!after.includes('unique-new-words'));
  assert.equal((await lib.read(m.id)).body, '새 내용 unique-new-words\n');
  lib.forget(m.id);
  await assert.rejects(lib.read(m.id), (e) => e.code === 'locked');
});

test('forget wipes the key in memory', async (t) => {
  const { m, lib } = await lockedNote(t);
  const { dek } = lib.keys.get(m.id);
  lib.forget(m.id);
  assert.ok(dek.every((b) => b === 0));
});

test('a damaged file says so: the right password is not called wrong, and the file is left alone', async (t) => {
  const { m, fresh } = await lockedNote(t);
  const text = fs.readFileSync(m.file, 'utf8');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('{"v":1')) + 1;
  lines[at] = `${lines[at][0] === 'A' ? 'B' : 'A'}${lines[at].slice(1)}`;
  fs.writeFileSync(m.file, lines.join('\n'));
  const damaged = fs.readFileSync(m.file, 'utf8');
  const lib = fresh();
  await lib.scan();
  await assert.rejects(lib.unlock(m.id, PASSWORD), (e) => e.code === 'corrupt');
  assert.equal(lib.isUnlocked(m.id), false);
  // The fence cut off: still treated as locked and marked; never shown as plain or rewritten.
  fs.writeFileSync(m.file, damaged.replace(/\{"v":1[^\n]*\n/, 'not json\n'));
  const lib2 = fresh();
  await lib2.scan();
  assert.equal(lib2.get(m.id).locked, true);
  assert.equal(lib2.get(m.id).lockDamaged, true);
  await assert.rejects(lib2.unlock(m.id, PASSWORD), (e) => e.code === 'corrupt');
});

test('other editors changing the line endings or the front matter do not break a locked note', async (t) => {
  const { m, fresh } = await lockedNote(t);
  const text = fs.readFileSync(m.file, 'utf8');
  fs.writeFileSync(m.file, text.replace('---\n', '---\ntags: [obsidian]\n').replace(/\n/g, '\r\n'));
  const lib = fresh();
  await lib.scan();
  await lib.unlock(m.id, PASSWORD);
  assert.equal((await lib.read(m.id)).body, `${SECRET}\n`);
  await lib.write(m.id, 'edited\n');
  assert.match(fs.readFileSync(m.file, 'utf8'), /tags: \[obsidian\]/);
});

// ---- attachments ----

test('attachments: content and names encrypted, plain ones gone, the links keep working', async (t) => {
  const f = folder(t);
  const m = await f.lib.create({ title: '첨부' });
  const png = Buffer.from('plain-image-bytes-secret');
  const name = await f.lib.addAssetBytes(m.id, '연봉.png', png);
  const assets = f.lib.assetsName(m);
  await f.lib.write(m.id, `![a](${assets}/${encodeURIComponent(name)})\n`);
  await f.lib.lock(m.id, PASSWORD);
  const files = fs.readdirSync(path.join(f.dir, assets));
  assert.equal(files.length, 1);
  assert.ok(L.isAssetFile(files[0]));
  const all = allBytes(f.dir);
  for (const leak of ['연봉', 'plain-image-bytes']) assert.ok(!all.includes(leak), leak);
  assert.deepEqual(f.lib.readLockedAsset(m.id, name).bytes, png);
  // Adding while locked keeps it encrypted, with free names.
  const again = await f.lib.addAssetBytes(m.id, '연봉.png', Buffer.from('second'));
  assert.equal(again, '연봉 (2).png');
  assert.deepEqual(f.lib.readLockedAsset(m.id, again).bytes, Buffer.from('second'));
  assert.equal(fs.readdirSync(path.join(f.dir, assets)).filter((n) => !L.isAssetFile(n)).length, 0);
  // A file dropped on the note: the copy is encrypted, the original is the user's.
  const outside = path.join(f.dir, '..', `outside-${path.basename(f.dir)}.pdf`);
  fs.writeFileSync(outside, 'pdf-secret-words');
  t.after(() => fs.rmSync(outside, { force: true }));
  const dropped = await f.lib.addAssetFile(m.id, outside);
  assert.ok(!allBytes(f.dir).includes('pdf-secret-words'));
  assert.deepEqual(f.lib.readLockedAsset(m.id, dropped.name).bytes, Buffer.from('pdf-secret-words'));
});

test('an attachment swapped for another one\'s file is refused', async (t) => {
  const f = folder(t);
  const m = await f.lib.create({ title: 'x' });
  await f.lib.lock(m.id, PASSWORD);
  const a = await f.lib.addAssetBytes(m.id, 'a.png', Buffer.from('aaa'));
  const b = await f.lib.addAssetBytes(m.id, 'b.png', Buffer.from('bbb'));
  fs.copyFileSync(f.lib.resolveAsset(m.id, b), f.lib.resolveAsset(m.id, a));
  assert.throws(() => f.lib.readLockedAsset(m.id, a), (e) => e.code === 'corrupt');
});

test('plain attachments left by a crash while locking are encrypted at the next unlock', async (t) => {
  const { dir, m, fresh } = await lockedNote(t);
  const lib = fresh();
  await lib.scan();
  const assets = path.join(dir, lib.assetsName(lib.get(m.id)));
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'left.png'), 'left-behind-secret');
  const r = await lib.unlock(m.id, PASSWORD);
  assert.equal(r.sealed, 1);
  assert.ok(!allBytes(dir).includes('left-behind-secret'));
  assert.deepEqual(lib.readLockedAsset(m.id, 'left.png').bytes, Buffer.from('left-behind-secret'));
});

test('a failure while locking leaves the plain note and attachments as they were', async (t) => {
  const f = folder(t);
  const m = await f.lib.create({ title: 'x', body: 'body\n' });
  await f.lib.addAssetBytes(m.id, 'a.png', Buffer.from('aaa'));
  const before = fs.readFileSync(m.file, 'utf8');
  const realCompose = f.lib.compose;
  f.lib.compose = () => { throw new Error('disk full'); };
  await assert.rejects(f.lib.lock(m.id, PASSWORD), /disk full/);
  f.lib.compose = realCompose;
  assert.equal(fs.readFileSync(m.file, 'utf8'), before);
  assert.equal(f.lib.get(m.id).locked, false);
  assert.equal(f.lib.isUnlocked(m.id), false);
  assert.deepEqual(fs.readdirSync(f.lib.assetsDir(m)), ['a.png']);
});

test('a one-character and a four-zero password lock and open a note', async (t) => {
  for (const password of ['1', '0000']) {
    const f = folder(t);
    const m = await f.lib.create({ title: '짧은 암호', body: `${SECRET}
` });
    await f.lib.lock(m.id, password);
    assert.ok(!allBytes(f.dir).includes(SECRET));
    const again = f.fresh();
    await again.scan();
    await assert.rejects(again.unlock(m.id, 'x'), (e) => e.code === 'wrong-password');
    await again.unlock(m.id, password);
  }
});

// ---- password change, taking the lock off ----

test('changing the password: old one stops working, attachments still open, a wrong current one changes nothing', async (t) => {
  const { m, lib, fresh } = await lockedNote(t);
  const name = await lib.addAssetBytes(m.id, 'a.png', Buffer.from('aaa'));
  const before = fs.readFileSync(m.file, 'utf8');
  await assert.rejects(lib.changePassword(m.id, 'not-the-password', 'new-password-2'), (e) => e.code === 'wrong-password');
  assert.equal(fs.readFileSync(m.file, 'utf8'), before);
  await assert.rejects(lib.changePassword(m.id, PASSWORD, ''), /암호를 넣어/);
  await lib.changePassword(m.id, PASSWORD, 'new-password-2');
  const again = fresh();
  await again.scan();
  await assert.rejects(again.unlock(m.id, PASSWORD), (e) => e.code === 'wrong-password');
  await again.unlock(m.id, 'new-password-2');
  assert.equal((await again.read(m.id)).body, `${SECRET}\n`);
  assert.deepEqual(again.readLockedAsset(m.id, name).bytes, Buffer.from('aaa'));
});

test('taking the lock off asks the password even when open and brings everything back', async (t) => {
  const { dir, m, lib } = await lockedNote(t, { fm: { due: '2026-12-01' } });
  const name = await lib.addAssetBytes(m.id, '계약서.png', Buffer.from('pdf'));
  await assert.rejects(lib.removeLock(m.id, 'not-the-password'), (e) => e.code === 'wrong-password');
  assert.equal(lib.get(m.id).locked, true);
  const r = await lib.removeLock(m.id, PASSWORD);
  assert.equal(r.body, `${SECRET}\n`);
  const text = fs.readFileSync(m.file, 'utf8');
  assert.ok(text.includes(SECRET));
  assert.doesNotMatch(text, /desk-widgets-locked/);
  assert.match(text, /due: 2026-12-01/);
  const m2 = lib.get(m.id);
  assert.equal(m2.locked, false);
  assert.equal(lib.isUnlocked(m.id), false);
  assert.ok(m2.search.includes('은행'));
  assert.deepEqual(fs.readdirSync(path.join(dir, lib.assetsName(m2))), [name]);
  assert.deepEqual(fs.readFileSync(path.join(dir, lib.assetsName(m2), name)), Buffer.from('pdf'));
});

test('front matter changes without the password and leaves the ciphertext byte for byte', async (t) => {
  const { m, fresh } = await lockedNote(t, { fm: { due: '2026-12-01' } });
  const lib = fresh();
  await lib.scan();
  const before = md.splitFrontMatter(fs.readFileSync(m.file, 'utf8')).body;
  await lib.updateFrontMatter(m.id, { due: '2027-01-02' });
  assert.equal(lib.get(m.id).todo.due.date, '2027-01-02');
  await lib.rename(m.id, '새 제목');
  assert.equal(lib.get(m.id).title, '새 제목');
  await lib.archive(m.id);
  await lib.restore(m.id);
  assert.equal(md.splitFrontMatter(fs.readFileSync(lib.get(m.id).file, 'utf8')).body, before);
});

// ---- moves, sync copies, backups ----

test('a renamed file (name clash, sync copy): links to its attachments follow when it is opened', async (t) => {
  const f = folder(t);
  const m = await f.lib.create({ title: 'x' });
  const name = await f.lib.addAssetBytes(m.id, 'a.png', Buffer.from('aaa'));
  const oldAssets = f.lib.assetsName(m);
  await f.lib.write(m.id, `![a](${oldAssets}/${name})\n`);
  await f.lib.lock(m.id, PASSWORD);
  fs.mkdirSync(path.join(f.dir, '보관함'));
  fs.writeFileSync(path.join(f.dir, '보관함', path.basename(m.file)), 'taken');
  await f.lib.archive(m.id);
  const moved = f.lib.get(m.id);
  assert.notEqual(f.lib.assetsName(moved), oldAssets);
  const { body } = await f.lib.read(m.id);
  assert.ok(body.includes(md.encodeDest(f.lib.assetsName(moved))), body);
  assert.deepEqual(f.lib.readLockedAsset(m.id, name).bytes, Buffer.from('aaa'));
});

test('the engine\'s "keep both" copy (new id in the front matter, same bytes after it) opens with the same password', async (t) => {
  const { dir, m, fresh } = await lockedNote(t);
  const source = fs.readFileSync(m.file, 'utf8');
  const copy = source.replace(/^desk-widgets-memo:\s*[^\r\n]+/im, 'desk-widgets-memo: abcdef123456');
  fs.writeFileSync(path.join(dir, 'copy (2).md'), copy);
  const lib = fresh();
  await lib.scan();
  assert.equal(lib.get('abcdef123456').locked, true);
  await lib.unlock('abcdef123456', PASSWORD);
  assert.equal((await lib.read('abcdef123456')).body, `${SECRET}\n`);
});

test('the engine\'s plain backups of a locked note are removed; others and encrypted ones stay', async (t) => {
  const { dir, m, lib } = await lockedNote(t);
  const backup = (stamp, rel, data) => {
    const file = path.join(dir, '.sync-removed', stamp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
  };
  const plainNote = backup('1760000000000-aaaaaaaa', path.basename(m.file), `---\ndesk-widgets-memo: ${m.id}\n---\n${SECRET}\n`);
  const oldName = backup('1760000000001-aaaaaaaa', '옛이름.md', `---\ndesk-widgets-memo: ${m.id}\n---\n${SECRET}\n`);
  const plainAsset = backup('1760000000002-aaaaaaaa', `${lib.assetsName(m)}/a.png`, 'plain-asset');
  const other = backup('1760000000003-aaaaaaaa', 'other.md', '---\ndesk-widgets-memo: otherother\n---\nother\n');
  const cipher = backup('1760000000004-aaaaaaaa', path.basename(m.file), fs.readFileSync(m.file));
  assert.equal(await lib.purgePlainBackups(), 3);
  for (const gone of [plainNote, oldName, plainAsset]) assert.equal(fs.existsSync(gone), false);
  for (const kept of [other, cipher]) assert.equal(fs.existsSync(kept), true);
  assert.ok(!allBytes(dir).includes('은행 비밀번호'));
});

test('a locked note too big to open again is refused and the file stays', async (t) => {
  const { m, lib } = await lockedNote(t);
  const before = fs.readFileSync(m.file, 'utf8');
  const huge = require('crypto').randomBytes(4 * 1024 * 1024).toString('base64');
  await assert.rejects(lib.write(m.id, huge), (e) => e.code === 'too-big');
  assert.equal(fs.readFileSync(m.file, 'utf8'), before);
});

test('the #113 folder tidy-up renames a locked note without its password and it still opens', async (t) => {
  const f = folder(t);
  const m = await f.lib.create({ title: '옛 노트', body: `${SECRET}\n` });
  await f.lib.lock(m.id, PASSWORD);
  const named = path.join(f.dir, '옛 노트.md');
  const text = fs.readFileSync(m.file, 'utf8').replace(/^title:.*\n/m, '').replace(/^created:.*\n/m, '');
  fs.rmSync(m.file);
  fs.writeFileSync(named, text);
  const lib = f.fresh();
  await lib.scan();
  const items = TM.plan(lib);
  assert.equal(items.length, 1);
  await TM.apply(items);
  await lib.scan();
  const moved = lib.get(m.id);
  assert.notEqual(path.basename(moved.file), '옛 노트.md');
  assert.equal(moved.title, '옛 노트');
  await lib.unlock(m.id, PASSWORD);
  assert.equal((await lib.read(m.id)).body, `${SECRET}\n`);
});

test('a conflict at shutdown writes the text to a locked copy, never a plain file', async (t) => {
  const { dir, m, lib } = await lockedNote(t);
  const session = new MemoSession({ library: lib, id: m.id, send: () => {} });
  await session.load();
  session.conflict = { body: 'theirs', hash: 'x' };
  session.pending = 'unsaved-private-words\n';
  session.flushSync();
  session.dispose();
  assert.ok(!allBytes(dir).includes('unsaved-private-words'));
  const lib2 = new Library({ dir, ids: { load: () => ({}), save() {} }, kdf: FAST });
  await lib2.scan();
  const copy = lib2.list().find((x) => x.id !== m.id);
  assert.equal(copy.locked, true);
  assert.match(copy.title, /내 사본/);
  await lib2.unlock(copy.id, PASSWORD);
  assert.equal((await lib2.read(copy.id)).body, 'unsaved-private-words\n');
});

// ---- the widget ----

async function widget(t, opts = {}) {
  const s = setup({ mcp: true, ...opts });
  t.after(() => s.w.stop());
  await s.w.start();
  return s;
}

async function openLocked(t, s, { title = '메모', body = `${SECRET}\n`, due = null } = {}) {
  const file = s.writeNote(title, { id: 'note00000001', fm: due ? [`due: ${due}`] : [], body });
  await s.call(await s.w.focus() && (await s.until(() => s.listWindow()), s.listWindow()), 'refresh');
  await s.call(s.listWindow(), 'open', { id: 'note00000001' });
  await s.until(() => s.memoWindows().length === 1);
  const win = s.memoWindows()[0];
  await s.call(win, 'init');
  const r = await s.call(win, 'lock', { password: PASSWORD });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.meta.locked, true);
  assert.equal(r.meta.unlocked, true);
  return { file, win };
}

test('widget: while open the window works; closed, it asks again and shows nothing without the password', async (t) => {
  const s = await widget(t);
  const { file, win } = await openLocked(t, s);
  assert.ok(!s.read(file).includes(SECRET));
  // The list never shows the text, also while the note is open.
  const list = await s.call(s.listWindow(), 'search', { q: '은행' });
  assert.equal(list.items.length, 0);
  const all = await s.call(s.listWindow(), 'search', { q: '' });
  const row = all.items.find((x) => x.id === 'note00000001');
  assert.equal(row.locked, true);
  assert.equal(row.preview, '');
  assert.equal(row.title, '메모');
  // Typing is saved encrypted.
  await s.call(win, 'update', { tree: { type: 'root', children: [{ type: 'element', tag: 'p', attrs: {}, children: [{ type: 'text', value: '새로 쓴 비밀 typed-words' }] }] } });
  await s.call(win, 'flush');
  assert.ok(!s.read(file).includes('typed-words'));
  // Close: the key is gone and the window asks again.
  await s.call(win, 'close');
  await s.until(() => s.memoWindows().length === 0);
  await s.call(s.listWindow(), 'open', { id: 'note00000001' });
  await s.until(() => s.memoWindows().length === 1);
  const again = s.memoWindows()[0];
  const init = await s.call(again, 'init');
  assert.equal(init.locked, true);
  assert.equal(init.html, undefined);
  assert.equal(init.text, undefined);
  assert.equal(init.meta.title, '메모');
  for (const name of ['update', 'flush', 'resolve', 'addImage', 'openAsset', 'removeLock', 'changePassword']) {
    const r = await s.call(again, name, { tree: { type: 'root', children: [] } });
    assert.equal(r.ok, false, name);
    assert.equal(r.code, 'locked', name);
  }
  assert.equal(s.read(file).includes('typed-words'), false);
  const wrong = await s.call(again, 'unlock', { password: 'not-the-password' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'wrong-password');
  assert.equal(wrong.html, undefined);
  const right = await s.call(again, 'unlock', { password: PASSWORD });
  assert.equal(right.ok, true);
  assert.match(right.html, /typed-words/);
  assert.equal(right.meta.unlocked, true);
});

test('widget: stopping forgets every key; the next start asks again', async (t) => {
  const s = await widget(t);
  await openLocked(t, s);
  s.w.stop();
  const again = setup({ mcp: true, initial: { notesDir: s.notes, memos: s.state().memos, listOpen: false } });
  t.after(() => again.w.stop());
  await again.w.start();
  await again.until(() => again.memoWindows().length === 1);
  const init = await again.call(again.memoWindows()[0], 'init');
  assert.equal(init.locked, true);
});

test('widget: AI assistant tools never see or change a locked note, even while it is open', async (t) => {
  const s = await widget(t);
  await openLocked(t, s, { title: '비밀 할 일', due: '2030-01-02' });
  const tool = (name) => s.mcpTools().find((x) => x.name === name);
  assert.equal((await tool('list_todos').run({})).data.items.length, 0);
  assert.equal((await tool('search_notes').run({ query: '비밀 할 일' })).data.items.length, 0);
  assert.equal((await tool('search_notes').run({ query: '은행' })).data.items.length, 0);
  await assert.rejects(tool('read_note').run({ id: 'note00000001' }), /찾을 수 없습니다/);
  for (const [name, input] of [['set_due', { id: 'note00000001', when: '내일' }], ['postpone', { id: 'note00000001', days: 1 }], ['clear_due', { id: 'note00000001' }], ['complete', { id: 'note00000001' }], ['append', { id: 'note00000001', text: 'x', expect_hash: 'x' }], ['check_item', { id: 'note00000001', index: 0, done: true, expect_hash: 'x' }]]) {
    await assert.rejects(tool(name).run(input), /찾을 수 없습니다/, name);
  }
});

test('widget: a locked to-do keeps reminding by its title and goes to the calendar; 완료 needs no password', async (t) => {
  const shared = { expose() {}, onStatus() {}, setEnabled() {}, status: () => ({}), publish() {} };
  const exposed = {};
  shared.expose = (name, fn) => (exposed[name] = fn);
  const s = await widget(t, { integrations: shared, initial: { shareCalendar: true, listOpen: false } });
  const { file, win } = await openLocked(t, s, { title: '보고 마감', due: '2020-01-02 09:00', body: `- [x] ${SECRET}\n` });
  await s.call(win, 'close');
  await s.until(() => s.memoWindows().length === 0);
  const snapshot = exposed['notes.snapshot']({}, { sourceId: 'calendar' });
  assert.equal(snapshot.ok, true);
  const item = snapshot.result.tasks.find((x) => x.id === 'note00000001');
  assert.equal(item.title, '보고 마감');
  assert.ok(!JSON.stringify(snapshot).includes('은행'));
  // The calendar moving the due: only the plain line changes.
  const cipher = md.splitFrontMatter(s.read(file)).body;
  const moved = await exposed['notes.updateDue']({ taskId: 'note00000001', dueAt: new Date(2031, 0, 2, 9).getTime(), dateOnly: false }, { sourceId: 'calendar' });
  assert.equal(moved.ok, true, moved.message);
  assert.equal(md.splitFrontMatter(s.read(file)).body, cipher);
  // 완료 from the list without the password: the note moves, the text stays encrypted.
  const done = await s.call(s.listWindow() || (await s.w.focus(), await s.until(() => s.listWindow()), s.listWindow()), 'complete', { id: 'note00000001' });
  assert.equal(done.ok, true, done.message);
  const doneFile = s.fileById('note00000001');
  assert.match(doneFile, /완료/);
  assert.equal(md.splitFrontMatter(s.read(doneFile)).body, cipher);
});

test('widget: a due locked note reminds with its title only', async (t) => {
  const s = await widget(t);
  const soon = new Date(Date.now() + 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const due = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())} ${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
  const { win } = await openLocked(t, s, { title: '곧 마감', due });
  await s.call(win, 'close');
  await s.until(() => s.memoWindows().length === 0);
  const now = Date.now;
  Date.now = () => now() + 5 * 60000; // after the due
  try {
    s.w.setPaused(null); // back from away: reminders are checked
  } finally {
    Date.now = now;
  }
  const card = s.cards.flatMap((c) => c.events).find((e) => e.title === '곧 마감');
  assert.ok(card, JSON.stringify(s.cards.map((c) => c.events)));
  assert.ok(!JSON.stringify(card).includes('은행'));
});

test('widget: completing a repeating locked note does not touch its checklist', async (t) => {
  const s = await widget(t);
  const { file, win } = await openLocked(t, s, { title: '반복', due: '2020-01-02', body: '- [x] 했음\n' });
  await s.call(win, 'close');
  await s.until(() => s.memoWindows().length === 0);
  const cipher = md.splitFrontMatter(s.read(file)).body;
  await s.call(s.listWindow(), 'complete', { id: 'note00000001' });
  assert.equal(md.splitFrontMatter(s.read(s.fileById('note00000001'))).body, cipher);
});

test('widget: the first line never becomes the title of a locked note', async (t) => {
  const s = await widget(t);
  await s.call(await s.w.focus() && (await s.until(() => s.listWindow()), s.listWindow()), 'new');
  await s.until(() => s.memoWindows().length === 1);
  const win = s.memoWindows()[0];
  await s.call(win, 'init');
  const r = await s.call(win, 'lock', { password: PASSWORD });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.meta.autoTitle, false);
  await s.call(win, 'update', { tree: { type: 'root', children: [{ type: 'element', tag: 'p', attrs: {}, children: [{ type: 'text', value: '첫 줄 비밀 first-line-secret' }] }] } });
  win.emit('blur');
  await s.call(win, 'close');
  await s.until(() => s.memoWindows().length === 0);
  const files = s.noteFiles();
  assert.equal(files.length, 1); // an empty new note is removed when closed, a locked one is not
  assert.ok(!s.read(files[0]).includes('first-line-secret'));
});

test('widget: pictures come from memory, other attachments only through a save dialog; no plain file appears', async (t) => {
  const s = await widget(t);
  const { win, file } = await openLocked(t, s);
  const image = await s.call(win, 'addImage', { name: 'pic.png', type: 'image/png', bytes: Buffer.from('png-secret-bytes') });
  assert.equal(image.ok, true, image.message);
  assert.match(image.src, /^data:image\/png;base64,/);
  const outside = path.join(os.tmpdir(), `dw-lock-${process.pid}.pdf`);
  fs.writeFileSync(outside, 'attachment-secret');
  t.after(() => fs.rmSync(outside, { force: true }));
  const added = await s.call(win, 'addFiles', { paths: [outside] });
  assert.equal(added.added.length, 1);
  assert.ok(!allBytes(s.notes).includes('attachment-secret'));
  assert.ok(!allBytes(s.notes).includes('png-secret-bytes'));
  // Opening: no temporary plain copy, and nothing leaves unless the user picks a place.
  let asked = 0;
  s.setSaveDialog(() => (asked++, { canceled: true }));
  const cancelled = await s.call(win, 'openAsset', { name: added.added[0].name });
  assert.equal(asked, 1);
  assert.equal(cancelled.ok, false);
  const target = path.join(os.tmpdir(), `dw-lock-saved-${process.pid}.pdf`);
  t.after(() => fs.rmSync(target, { force: true }));
  s.setSaveDialog(() => ({ canceled: false, filePath: target }));
  const saved = await s.call(win, 'openAsset', { name: added.added[0].name });
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'attachment-secret');
  assert.match(s.read(file), /desk-widgets-locked/);
});

test('widget: settings on disk hold nothing of the note', async (t) => {
  const s = await widget(t);
  await openLocked(t, s);
  assert.ok(!JSON.stringify(s.state()).includes('은행'));
});

test('widget: the password changed on another PC closes the open text and asks for the new one', async (t) => {
  const s = await widget(t);
  const { file, win } = await openLocked(t, s);
  const other = new Library({ dir: s.notes, ids: { load: () => ({}), save() {} }, kdf: FAST });
  await other.scan();
  await other.unlock('note00000001', PASSWORD);
  await other.changePassword('note00000001', PASSWORD, 'new-password-2');
  other.forgetAll();
  assert.ok(fs.existsSync(file));
  await s.call(s.listWindow(), 'refresh');
  await s.until(() => win.isDestroyed() && s.memoWindows().length === 1);
  const next = s.memoWindows()[0];
  const init = await s.call(next, 'init');
  assert.equal(init.locked, true);
  assert.equal((await s.call(next, 'unlock', { password: PASSWORD })).code, 'wrong-password');
  assert.equal((await s.call(next, 'unlock', { password: 'new-password-2' })).ok, true);
});

test('widget: a plain window whose note was locked on another PC closes; the note is not written back in plain', async (t) => {
  const s = await widget(t);
  const file = s.writeNote('공유', { id: 'note00000002', body: '공유 내용\n' });
  await s.call(await s.w.focus() && (await s.until(() => s.listWindow()), s.listWindow()), 'refresh');
  await s.call(s.listWindow(), 'open', { id: 'note00000002' });
  await s.until(() => s.memoWindows().length === 1);
  const win = s.memoWindows()[0];
  await s.call(win, 'init');
  const other = new Library({ dir: s.notes, ids: { load: () => ({}), save() {} }, kdf: FAST });
  await other.scan();
  await other.lock('note00000002', PASSWORD);
  other.forgetAll();
  await s.call(s.listWindow(), 'refresh');
  await s.until(() => win.isDestroyed() && s.memoWindows().length === 1);
  assert.ok(!s.read(file).includes('공유 내용'));
  const init = await s.call(s.memoWindows()[0], 'init');
  assert.equal(init.locked, true);
  assert.equal(init.meta.lockIcon.icon, '🔒');
  // And the other way: the lock taken off elsewhere brings 🔓 to the window asking for the password.
  await other.scan();
  await other.unlock('note00000002', PASSWORD);
  await other.removeLock('note00000002', PASSWORD);
  await s.call(s.listWindow(), 'refresh');
  const after = s.memoWindows()[0];
  assert.ok(await s.until(() => after.sent.filter(([n]) => n === 'meta').at(-1)?.[1].lockIcon?.icon === '🔓'));
});

test('widget: taking the lock off and menus', async (t) => {
  const menus = [];
  const s = await widget(t, { menus });
  const { win, file } = await openLocked(t, s);
  await s.call(win, 'menu', {});
  const labels = menus.at(-1).map((x) => x.label);
  assert.ok(labels.includes('암호 바꾸기…'));
  assert.ok(labels.includes('잠금 풀기 (평문으로 되돌리기)…'));
  assert.ok(!labels.includes('암호로 잠그기…'));
  assert.equal((await s.call(win, 'removeLock', { password: 'not-the-password' })).code, 'wrong-password');
  const r = await s.call(win, 'removeLock', { password: PASSWORD });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.meta.locked, false);
  assert.match(r.html, /은행/);
  assert.ok(s.read(file).includes(SECRET));
});

test('widget: the padlock follows the note in its window and in the list, and its button does the right thing', async (t) => {
  const menus = [];
  const s = await widget(t, { menus });
  s.writeNote('열쇠', { id: 'note00000001', body: '내용\n' });
  fs.writeFileSync(path.join(s.notes, 'plain.txt'), 'text');
  const list = await s.call(await s.w.focus() && (await s.until(() => s.listWindow()), s.listWindow()), 'refresh');
  const row = (items, title) => items.find((x) => x.title === title);
  assert.equal(row(list.items, '열쇠').lockIcon.icon, '🔓');
  assert.equal(row(list.items, 'plain').lockIcon, null);
  await s.call(s.listWindow(), 'open', { id: 'note00000001' });
  await s.until(() => s.memoWindows().length === 1);
  const win = s.memoWindows()[0];
  const lastMeta = () => win.sent.filter(([n]) => n === 'meta').at(-1)?.[1];
  const init = await s.call(win, 'init');
  assert.equal(init.meta.lockIcon.action, 'set');
  // 🔓: the same box as the menu item.
  await s.call(win, 'lockButton');
  assert.deepEqual(win.sent.filter(([n]) => n === 'lockBox').at(-1)[1], { mode: 'set' });
  // Locking changes it at once, here and in the list.
  const locked = await s.call(win, 'lock', { password: PASSWORD });
  assert.equal(locked.meta.lockIcon.icon, '🔒');
  assert.equal(lastMeta().lockIcon.icon, '🔒');
  assert.equal(row((await s.call(s.listWindow(), 'search', { q: '' })).items, '열쇠').lockIcon.icon, '🔒');
  // 🔒 open: the menu with both items.
  const before = menus.length;
  await s.call(win, 'lockButton');
  assert.equal(menus.length, before, 'not the right-click menu: the engine would add 설정, 위젯 관리, 종료 to it');
  assert.deepEqual(s.ownMenus.at(-1).map((x) => x.label), ['암호 바꾸기…', '잠금 풀기 (평문으로 되돌리기)…']);
  // Unlocked for good: back to 🔓.
  const plain = await s.call(win, 'removeLock', { password: PASSWORD });
  assert.equal(plain.meta.lockIcon.icon, '🔓');
  // 🔒 before the password: nothing happens.
  await s.call(win, 'lock', { password: PASSWORD });
  await s.call(win, 'close');
  await s.until(() => s.memoWindows().length === 0);
  await s.call(s.listWindow(), 'open', { id: 'note00000001' });
  await s.until(() => s.memoWindows().length === 1);
  const again = s.memoWindows()[0];
  const asking = await s.call(again, 'init');
  assert.equal(asking.meta.lockIcon.action, null);
  const menusBefore = s.ownMenus.length;
  const boxesBefore = again.sent.filter(([n]) => n === 'lockBox').length;
  assert.equal((await s.call(again, 'lockButton')).ok, true);
  assert.equal(s.ownMenus.length, menusBefore);
  assert.equal(menus.filter((m) => m.some((x) => x.label === '암호 바꾸기…')).length, 0);
  assert.equal(again.sent.filter(([n]) => n === 'lockBox').length, boxesBefore);
  // A note in the archive shows no 🔓; a locked one keeps its 🔒.
  await s.call(again, 'close');
  await s.until(() => s.memoWindows().length === 0);
  s.writeNote('보관', { id: 'note00000003', body: 'x\n' });
  await s.call(s.listWindow(), 'refresh');
  await s.call(s.listWindow(), 'archive', { id: 'note00000003' });
  const after = await s.call(s.listWindow(), 'search', { q: '' });
  assert.equal(row(after.items, '보관').lockIcon, null);
  assert.equal(row(after.items, '열쇠').lockIcon.icon, '🔒');
});

test('widget: .txt, archived and conflict copies cannot be locked', async (t) => {
  const s = await widget(t);
  fs.writeFileSync(path.join(s.notes, 'plain.txt'), 'text');
  await s.call(await s.w.focus() && (await s.until(() => s.listWindow()), s.listWindow()), 'refresh');
  const txt = (await s.call(s.listWindow(), 'search', { q: 'plain' })).items[0];
  await s.call(s.listWindow(), 'open', { id: txt.id });
  await s.until(() => s.memoWindows().length === 1);
  const win = s.memoWindows()[0];
  await s.call(win, 'init');
  assert.equal((await s.call(win, 'lock', { password: PASSWORD })).ok, false);
  assert.equal(fs.readFileSync(path.join(s.notes, 'plain.txt'), 'utf8'), 'text');
});

test('undo after taking a note locked on another PC cannot bring the plain edit back or upload it (#125)', async (t) => {
  const { openFileStore } = require('../../../engine/main/files-store');
  const { SyncManager } = require('../../../engine/main/sync');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-lock-undo-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cloud = path.join(temp, 'cloud');
  fs.mkdirSync(cloud);
  const pc = (label, deviceId) => {
    const dir = path.join(temp, label);
    fs.mkdirSync(dir);
    let ids = {};
    const lib = new Library({ dir, ids: { load: () => ids, save: (m) => (ids = m) }, kdf: FAST });
    const manager = new SyncManager({ localDir: path.join(temp, `${label}-state`), folder: cloud, deviceId });
    // As in the widget's index.js.
    t.after(openFileStore(manager, 'todonote', {
      name: 'notes', dir: () => dir, include: (rel) => /^[^/]+\.md$/.test(rel) || /^[^/]+\.assets\/[^/]+$/.test(rel),
      idOf: (rel, text) => /^desk-widgets-memo:\s*(.+)$/im.exec(text)?.[1] || rel,
      onRemoteChange: () => lib.scan().then(() => lib.purgePlainBackups()),
    }).close);
    return { dir, lib, manager };
  };
  const a = pc('a', 'd-aaaaaaaa');
  const b = pc('b', 'd-bbbbbbbb');
  const m = await a.lib.create({ title: '메모', body: '처음\n' });
  await a.manager.sync();
  await b.manager.sync();
  await b.lib.scan();
  const onB = path.join(b.dir, path.basename(m.file));
  const edit = 'B-PLAIN-EDIT-never-uploaded';
  fs.writeFileSync(onB, fs.readFileSync(onB, 'utf8').replace('처음', edit));
  await a.lib.lock(m.id, PASSWORD);
  await a.manager.sync();
  const held = await b.manager.sync();
  assert.equal(held.conflicts.length, 1);
  await b.manager.sync({ resolutions: { [held.conflicts[0].key]: 'remote' } });
  const locked = fs.readFileSync(onB, 'utf8');
  assert.ok(L.isLocked(md.splitFrontMatter(locked).body));
  assert.ok(!allBytes(b.dir).includes(edit), 'the widget removed the plain backup');
  const [entry] = await b.manager.listUndo();
  await assert.rejects(b.manager.undo(entry.id), /no longer kept/);
  assert.equal(fs.readFileSync(onB, 'utf8'), locked);
  assert.ok(!allBytes(cloud).includes(edit), 'the plain edit never reaches the sync folder');
});
