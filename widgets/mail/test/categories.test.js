// The category store (#69): local file only, keys by account + Message-ID, delete / rename / limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CategoryStore, messageKey, MAX_CATEGORIES } = require('../lib/categories');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cat-')), 'categories.json');

test('message keys: account + Message-ID (case, brackets ignored), else account + INBOX + UIDVALIDITY + UID', () => {
  assert.equal(messageKey('a1', { uid: 5, messageId: '<ABC@X.test>' }, 7), 'a1|mid:abc@x.test');
  assert.equal(messageKey('a1', { uid: 5, messageId: 'abc@x.test' }, 9), 'a1|mid:abc@x.test', 'a new UIDVALIDITY keeps the key');
  assert.equal(messageKey('a1', { uid: 5, messageId: '' }, 7), 'a1|uid:INBOX:7:5');
  assert.notEqual(messageKey('a1', { messageId: '<m@x>' }), messageKey('a2', { messageId: '<m@x>' }), 'per account');
});

test('store: create / rename / recolor / delete, several per message, persisted, limits', () => {
  const f = file();
  const s = new CategoryStore(f);
  const a = s.create('중요');
  const b = s.create('결재', '#123456');
  assert.throws(() => s.create('  '), /이름/);
  assert.throws(() => s.create('x'.repeat(31)), /30자/);
  assert.throws(() => s.create('중요'), /같은 이름/);
  assert.deepEqual(s.set('k1', [b.id, a.id, 'zzz']), [a.id, b.id]);
  s.set('k2', [b.id]);
  s.rename(a.id, '아주 중요');
  s.recolor(b.id, '#ABCDEF');
  const again = new CategoryStore(f);
  assert.deepEqual(again.list().map((c) => [c.name, c.color]), [['아주 중요', a.color], ['결재', '#abcdef']]);
  assert.deepEqual(again.idsFor('k1'), [a.id, b.id]);
  again.remove(b.id);
  assert.deepEqual(again.idsFor('k1'), [a.id]);
  assert.equal(again.idsFor('k2').length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).assignments.k2, undefined, 'empty assignments are removed');
  again.set('k1', []);
  assert.deepEqual(again.idsFor('k1'), []);
  for (let i = again.list().length; i < MAX_CATEGORIES; i++) again.create(`c${i}`);
  assert.throws(() => again.create('one more'), /50개/);
});

test('store: the settings list (rename, recolor, reorder, add, delete) in one go', () => {
  const s = new CategoryStore(file());
  const a = s.create('A');
  const b = s.create('B');
  s.set('k', [a.id, b.id]);
  const out = s.replaceAll([{ id: b.id, name: 'B2', color: '#000000' }, { name: '새것' }]);
  assert.deepEqual(out.map((c) => c.name), ['B2', '새것']);
  assert.deepEqual(s.idsFor('k'), [b.id], 'A was deleted and left the message');
  assert.throws(() => s.replaceAll([{ name: 'x' }, { name: 'x' }]), /두 개/);
});
