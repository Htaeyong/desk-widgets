// Dooray settings save (#97): the API token is saved only encrypted; the settings window gets a reason otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../../../engine/main/store');
const { createDooraySettings, TOKEN_UNAVAILABLE_MESSAGE } = require('../settings');

const crypto = (available) => ({
  ok: available,
  available() {
    return this.ok;
  },
  encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'),
  decrypt: (b64) => Buffer.from(b64, 'base64').toString().replace(/^enc:/, ''),
});
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dooray-settings-'));
const fileOf = (d) => path.join(d, 'settings.json');

test('saveChecked: a new token is saved encrypted', () => {
  const d = dir();
  const settings = createDooraySettings({ dir: d, createStore, crypto: crypto(true) });
  const res = settings.saveChecked({ doorayDomain: 'example.dooray.com', apiToken: 'tok' });
  assert.equal(res.ok, true);
  assert.equal(res.settings.apiToken, 'tok');
  const raw = JSON.parse(fs.readFileSync(fileOf(d), 'utf8'));
  assert.ok(raw.tokenEnc && !('tokenPlain' in raw) && !JSON.stringify(raw).includes('"tok"'));
  assert.equal(settings.toPublic().hasToken, true);
});

test('saveChecked: without OS encryption a new token is refused with a reason, nothing is saved', () => {
  const d = dir();
  const settings = createDooraySettings({ dir: d, createStore, crypto: crypto(false) });
  assert.equal(settings.canEncrypt(), false);
  assert.deepEqual(settings.saveChecked({ doorayDomain: 'example.dooray.com', apiToken: 'tok' }), { ok: false, message: TOKEN_UNAVAILABLE_MESSAGE });
  assert.match(TOKEN_UNAVAILABLE_MESSAGE, /평문으로 저장하지 않/);
  assert.ok(!fs.existsSync(fileOf(d)));
  // Settings without a new token still save.
  assert.equal(settings.saveChecked({ alwaysOnTop: true }).ok, true);
});

test('saveChecked: the refusal also comes from the store when the widget-side check passes', () => {
  const d = dir();
  const box = crypto(true);
  // The widget asks one crypto, the store another (as with a separate engine): the store has the last word.
  const settings = createDooraySettings({ dir: d, createStore: (o) => createStore({ ...o, crypto: crypto(false) }), crypto: box });
  assert.deepEqual(settings.saveChecked({ apiToken: 'tok' }), { ok: false, message: TOKEN_UNAVAILABLE_MESSAGE });
});

test('an older plain-text token is re-saved encrypted when possible, otherwise dropped from the file', () => {
  const legacy = (d) => fs.writeFileSync(fileOf(d), JSON.stringify({ doorayDomain: 'example.dooray.com', tokenEnc: '', tokenPlain: 'old-token' }));
  const a = dir();
  legacy(a);
  const enc = createDooraySettings({ dir: a, createStore, crypto: crypto(true) });
  assert.equal(enc.isConfigured(), true);
  assert.ok(!fs.readFileSync(fileOf(a), 'utf8').includes('old-token'));

  const b = dir();
  legacy(b);
  const none = createDooraySettings({ dir: b, createStore, crypto: crypto(false) });
  assert.equal(none.isConfigured(), true, 'works for this run');
  assert.ok(!fs.readFileSync(fileOf(b), 'utf8').includes('old-token'), 'never stays on disk');
  assert.equal(createDooraySettings({ dir: b, createStore, crypto: crypto(false) }).isConfigured(), false, 'must be entered again');
});
