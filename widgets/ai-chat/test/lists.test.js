// The lists (#129): saved recipes renamed, pinned and deleted with a short undo; conversations renamed from the list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecipeStore, CATALOG_MAX } = require('../lib/recipes');
const { FAKE_KEY } = require('./helpers');
const { ready, sleep } = require('./setup');

const FIELDS = { title: '보고서 정리', when: '월간 보고서', body: '## 절차\n읽는다.' };

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-lists-'));
  let at = 1000;
  return { dir, s: createRecipeStore({ dir, now: () => (at += 1) }), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('store: a rename is a new version; pinned come first in pin order, the rest by last use', () => {
  const { s, done } = store();
  try {
    const a = s.create({ ...FIELDS, title: 'A' });
    const b = s.create({ ...FIELDS, title: 'B' });
    const c = s.create({ ...FIELDS, title: 'C' });
    s.markUsed(a.id);
    assert.deepEqual(s.list().map((r) => r.title), ['A', 'C', 'B']);
    s.setPinned(b.id, true);
    s.setPinned(c.id, true);
    assert.deepEqual(s.list().map((r) => r.title), ['B', 'C', 'A']);
    s.setPinned(b.id, false);
    assert.deepEqual(s.list().map((r) => [r.title, Boolean(r.pinned)]), [['C', true], ['A', false], ['B', false]], 'unpinned: back among the rest, by last use');
    const renamed = s.rename(a.id, '새 이름');
    assert.equal(renamed.version, 2);
    assert.equal(s.read(a.id).title, '새 이름');
    assert.equal(s.read(a.id, 1).title, 'A', 'the old version keeps the old name');
    assert.equal(s.read(a.id).body, FIELDS.body);
  } finally {
    done();
  }
});

test('store: pinned recipes always make the 50 the model is told about', () => {
  const { s, done } = store();
  try {
    const many = Array.from({ length: CATALOG_MAX + 10 }, (_, i) => s.create({ ...FIELDS, title: `t${i}` }));
    for (const r of many.slice(0, CATALOG_MAX)) s.markUsed(r.id);
    const rare = many[many.length - 1];
    assert.ok(!s.catalog().some((r) => r.id === rare.id), 'never used: not in the 50');
    s.setPinned(rare.id, true);
    const catalog = s.catalog();
    assert.equal(catalog.length, CATALOG_MAX);
    assert.equal(catalog[0].id, rare.id, 'pinned first');
  } finally {
    done();
  }
});

test('store: a trashed recipe is gone from every list at once, comes back on untrash, and purge removes its versions', () => {
  const { dir, s, done } = store();
  try {
    const r = s.create(FIELDS);
    s.update(r.id, { ...FIELDS, body: '둘' });
    assert.equal(s.trash(r.id), true);
    assert.equal(s.get(r.id), null);
    assert.equal(s.read(r.id), null);
    assert.deepEqual([s.list().length, s.catalog().length], [0, 0]);
    assert.equal(s.markUsed(r.id), null);
    assert.equal(s.untrash(r.id), true);
    assert.equal(s.read(r.id).body, '둘');
    s.trash(r.id);
    s.purge();
    assert.ok(!fs.existsSync(path.join(dir, r.id)), 'every version is gone');
    assert.equal(s.untrash(r.id), false);
  } finally {
    done();
  }
});

// ---- through the window's calls ----

function saveOne(t, fields = FIELDS) {
  const res = t.call('saveRecipe', { ...fields, trusted: true });
  assert.equal(res.ok, true, res.message);
  return res.recipe;
}

test('rename from the list: one line, not empty, not too long, no secrets, and the next run gets the new title', async () => {
  const t = ready();
  try {
    const r = saveOne(t);
    for (const [title, part] of [['', '적어'], ['   ', '적어'], ['두\n줄', '한 줄'], ['x'.repeat(101), '100자'], ['password=hunter2xx', '비밀'], [`키 ${FAKE_KEY}`, 'API 키']]) {
      const res = t.call('renameRecipe', { id: r.id, title });
      assert.equal(res.ok, false, title.slice(0, 10));
      assert.match(res.message, new RegExp(part));
      assert.ok(!JSON.stringify(res).includes(FAKE_KEY));
    }
    assert.equal(t.call('recipe', r.id).title, FIELDS.title, 'refused names change nothing');
    const ok = t.call('renameRecipe', { id: r.id, title: '  월간 보고서 표  ' });
    assert.deepEqual([ok.ok, ok.recipe.title, ok.recipe.version], [true, '월간 보고서 표', 2]);
    assert.equal(t.call('renameRecipe', { id: 'r-0000000000000000', title: 'x' }).ok, false);
    const note = path.join(t.ws.dir, 'note.md');
    t.ws.setBehavior({ copySystemNote: note });
    const { sessionId } = t.send('x');
    await t.doneOf(sessionId);
    assert.match(fs.readFileSync(note, 'utf8'), new RegExp(`${r.id} \\| 월간 보고서 표 \\|`));
  } finally {
    t.cleanup();
  }
});

test('delete from the list: out at once with every version, back on undo in time, gone for good after', async () => {
  const t = ready({}, { deps: { undoMs: 300 } });
  try {
    const a = saveOne(t);
    const b = saveOne(t, { ...FIELDS, title: '두 번째' });
    const res = t.call('removeRecipe', a.id);
    assert.deepEqual(res, { ok: true, undoMs: 300 });
    assert.deepEqual(t.call('recipes').map((r) => r.id), [b.id]);
    assert.equal(t.call('recipe', a.id), null);
    assert.equal(t.call('undoRemoveRecipe', a.id), true);
    assert.deepEqual(t.call('recipes').map((r) => r.id).sort(), [a.id, b.id].sort());
    t.call('removeRecipe', a.id);
    await sleep(500);
    assert.equal(t.call('undoRemoveRecipe', a.id), false, 'too late');
    assert.ok(!fs.existsSync(path.join(t.fake.ctx.dataDir, 'recipes', a.id)));
    assert.equal(t.call('removeRecipe', a.id), false);
  } finally {
    t.cleanup();
  }
});

test('a deletion the app could not finish is finished on the next start', () => {
  const t = ready({}, { deps: { undoMs: 60000 } });
  try {
    const r = saveOne(t);
    t.call('removeRecipe', r.id);
    const index = JSON.parse(fs.readFileSync(path.join(t.fake.ctx.dataDir, 'recipes', 'index.json'), 'utf8'));
    assert.ok(index.recipes.find((x) => x.id === r.id).deletedAt, 'set aside, not gone yet');
    t.widget.stop();
    assert.ok(!fs.existsSync(path.join(t.fake.ctx.dataDir, 'recipes', r.id)), 'stopping finishes it');
  } finally {
    t.cleanup();
  }
});

test('pin from the list: first in the list, the picker and the model\'s titles', async () => {
  const t = ready();
  try {
    const a = saveOne(t, { ...FIELDS, title: '가' });
    const b = saveOne(t, { ...FIELDS, title: '나' });
    assert.equal(t.call('setRecipePinned', { id: a.id, pinned: true }), true);
    assert.deepEqual(t.call('recipes').map((r) => [r.title, Boolean(r.pinned)]), [['가', true], ['나', false]]);
    assert.equal(t.call('setRecipePinned', { id: 'r-0000000000000000', pinned: true }), false);
    const note = path.join(t.ws.dir, 'note.md');
    t.ws.setBehavior({ copySystemNote: note });
    const { sessionId } = t.send('x');
    await t.doneOf(sessionId);
    const text = fs.readFileSync(note, 'utf8');
    assert.ok(text.indexOf(a.id) < text.indexOf(b.id));
  } finally {
    t.cleanup();
  }
});

test('a conversation renamed from the list: the same rules, and the list says so', async () => {
  const t = ready();
  try {
    const { sessionId } = t.send('처음 제목');
    await t.doneOf(sessionId);
    assert.equal(t.call('renameSession', { id: sessionId, title: '\n' }).ok, false);
    assert.equal(t.call('renameSession', { id: sessionId, title: 'x'.repeat(101) }).ok, false);
    assert.equal(t.call('renameSession', { id: sessionId, title: '  새 대화 이름 ' }).ok, true);
    assert.equal(t.call('list').sessions[0].title, '새 대화 이름');
    assert.ok(t.win.sent.some(([n, p]) => n === 'list' && p.sessions.some((s) => s.title === '새 대화 이름')));
    assert.equal(t.call('renameSession', { id: 's-0000000000000000', title: 'x' }).ok, false);
  } finally {
    t.cleanup();
  }
});
