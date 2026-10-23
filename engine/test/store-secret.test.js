// The store's secret field is never written as plain text (#97): refused without OS encryption,
// plain text from older versions is rewritten encrypted or dropped from the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../main/store');

const crypto = (available = true) => ({
  ok: available,
  available() {
    return this.ok;
  },
  encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'),
  decrypt: (b64) => Buffer.from(b64, 'base64').toString().replace(/^enc:/, ''),
});
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-secret-')), 's.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const make = (file, box, seed) => createStore({ file, defaults: { n: 1 }, secret: { field: 'token', enc: 'tokenEnc', plain: 'tokenPlain' }, crypto: box, seed });

test('store secret: encrypted when OS encryption works; no plain-text field is written', () => {
  const file = tmpFile();
  const store = make(file, crypto(true));
  assert.equal(store.secretAvailable(), true);
  store.save({ token: 'abc' });
  const raw = read(file);
  assert.equal(raw.tokenEnc, Buffer.from('enc:abc').toString('base64'));
  assert.ok(!('tokenPlain' in raw) && !('token' in raw));
  const before = raw.tokenEnc;
  store.save({ n: 2 });
  assert.equal(read(file).tokenEnc, before, 'an unchanged secret keeps its ciphertext');
});

test('store secret: without OS encryption a new secret is refused and nothing is written', () => {
  const file = tmpFile();
  const store = make(file, crypto(false));
  assert.equal(store.secretAvailable(), false);
  assert.throws(() => store.save({ token: 'abc', n: 5 }), (e) => e.code === 'secret-unavailable' && /평문/.test(e.message));
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(store.load(), { n: 1, token: '' }, 'the cache is unchanged');
  store.save({ n: 3 });
  assert.deepEqual(read(file), { n: 3, tokenEnc: '' }, 'other settings still save while there is no secret');
});

test('store secret: an encrypted secret survives saves while OS encryption is briefly unavailable', () => {
  const file = tmpFile();
  const box = crypto(true);
  make(file, box).save({ token: 'abc' });
  const store = make(file, box);
  assert.equal(store.load().token, 'abc');
  box.ok = false;
  store.save({ n: 7 });
  assert.equal(read(file).tokenEnc, Buffer.from('enc:abc').toString('base64'));
  assert.throws(() => store.save({ token: 'new' }), (e) => e.code === 'secret-unavailable');
});

test('store secret: a plain-text secret from an older version is rewritten encrypted at once', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ n: 4, tokenEnc: '', tokenPlain: 'legacy' }));
  const store = make(file, crypto(true));
  assert.equal(store.load().token, 'legacy');
  const raw = read(file);
  assert.ok(!('tokenPlain' in raw));
  assert.equal(raw.tokenEnc, Buffer.from('enc:legacy').toString('base64'));
  assert.equal(raw.n, 4);
});

test('store secret: without OS encryption a plain-text secret works for this run only and leaves the file', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ n: 4, tokenEnc: '', tokenPlain: 'legacy' }));
  const store = make(file, crypto(false));
  assert.equal(store.load().token, 'legacy', 'still usable in this run');
  assert.deepEqual(read(file), { n: 4, tokenEnc: '' }, 'plain text removed from the file immediately');
  store.save({ n: 5 });
  assert.deepEqual(read(file), { n: 5, tokenEnc: '' }, 'and never written back');
  assert.equal(make(file, crypto(false)).load().token, '', 'the next run needs the token again');
});

test('store secret: a seeded secret (development .env) is kept in memory when it cannot be encrypted', () => {
  const file = tmpFile();
  const store = make(file, crypto(false), () => ({ token: 'from-env' }));
  assert.equal(store.load().token, 'from-env');
  store.save({ n: 2 });
  assert.deepEqual(read(file), { n: 2, tokenEnc: '' });
  const enc = make(tmpFile(), crypto(true), () => ({ token: 'from-env' }));
  enc.save({ n: 2 });
  assert.equal(enc.load().token, 'from-env');
});
