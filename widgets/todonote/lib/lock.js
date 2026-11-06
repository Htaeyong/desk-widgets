// Password-locked notes (#124, docs/todonote-lock-design.md): the crypto of a locked note. Nothing here touches files.
//
// A random data key encrypts the body and the attachments; a key derived from the password (scrypt) wraps the data key.
// The file holds salt, nonces, the wrapped key and ciphertext, never the password or a key. So only the password opens
// a note: a forgotten password cannot be recovered by anybody. The wrap also tells a wrong password (the wrap does not
// open) from a damaged file (the wrap opens, the body does not), and changing the password does not touch attachments.
const crypto = require('crypto');
const zlib = require('zlib');

const FENCE = 'desk-widgets-locked';
const NOTICE = '> 🔒 Desk Widgets 할 일 노트에서 암호로 잠근 노트입니다. 이 파일을 고치면 열 수 없게 됩니다.';
// 128 MB and about half a second on the first target PC; kept in the file so a later version can raise it.
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const MAX_KDF = { N: 2 ** 20, r: 32, p: 4 }; // a damaged or hostile file must not make the widget use gigabytes
const MIN_PASSWORD = 1; // any password: nobody can recover a forgotten one, so a forced rule only makes losing it likelier
const MAX_PASSWORD = 1024;
const WRAP_AAD = Buffer.from('desk-widgets-lock-wrap-v1');
const ASSET_MAGIC = Buffer.from('DWLK1\n');
const NONCE = 12;
const TAG = 16;
const ASSET_FILE = /^[0-9a-f]{40}\.dwenc$/;
const HEAD = new RegExp(`^\\s*(?:>[^\\n]*\\n\\s*)*\`\`\`${FENCE}[ \\t]*\\r?\\n`);

class LockError extends Error {
  /** @param {'locked'|'wrong-password'|'corrupt'|'changed'|'too-big'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MESSAGES = {
  locked: '노트가 잠겨 있습니다.',
  'wrong-password': '암호가 맞지 않습니다.',
  corrupt: '파일이 손상됐거나 바깥에서 고쳐져 열 수 없습니다.',
  changed: '다른 곳에서 암호가 바뀌었습니다. 새 암호로 다시 열어 주세요.',
};
const fail = (code) => new LockError(code, MESSAGES[code]);

/** Is this body (the text after the front matter) a locked note? */
const isLocked = (body) => HEAD.test(String(body));

/** A problem with a new password, or null. */
function passwordProblem(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) return '암호를 넣어 주세요.';
  if (password.length > MAX_PASSWORD) return '암호가 너무 깁니다.';
  return null;
}

const subKey = (dek, label) => Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), `desk-widgets-lock-${label}`, 32));

function encrypt(key, plain, aad) {
  const nonce = crypto.randomBytes(NONCE);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { nonce, data: Buffer.concat([data, c.getAuthTag()]) };
}

/** Throws (any error) when the bytes were changed or the key is wrong. */
function decrypt(key, nonce, sealed, aad) {
  if (nonce.length !== NONCE || sealed.length < TAG) throw new Error('short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
}

function deriveKey(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function validKdf(h) {
  const { N, r, p } = h || {};
  return h?.kdf === 'scrypt' && Number.isSafeInteger(N) && N > 1 && N <= MAX_KDF.N && (N & (N - 1)) === 0 && Number.isSafeInteger(r) && r > 0 && r <= MAX_KDF.r && Number.isSafeInteger(p) && p > 0 && p <= MAX_KDF.p;
}

/** The header of a password: what the file keeps to get the data key back with that password. */
async function wrapKey(dek, password, params = KDF) {
  const salt = crypto.randomBytes(16);
  const kek = await deriveKey(password, salt, params);
  const { nonce, data } = encrypt(kek, dek, WRAP_AAD);
  kek.fill(0);
  return { v: 1, kdf: 'scrypt', N: params.N, r: params.r, p: params.p, salt: salt.toString('base64'), wrapNonce: nonce.toString('base64'), wrap: data.toString('base64') };
}

/** A new data key and its header. */
async function newKey(password, params = KDF) {
  const dek = crypto.randomBytes(32);
  return { dek, header: await wrapKey(dek, password, params) };
}

/** The data key of a header, or LockError('wrong-password'); a header that cannot be used: 'corrupt'. */
async function openKey(header, password) {
  if (!validKdf(header)) throw fail('corrupt');
  const kek = await deriveKey(password, Buffer.from(String(header.salt), 'base64'), header);
  try {
    return decrypt(kek, Buffer.from(String(header.wrapNonce), 'base64'), Buffer.from(String(header.wrap), 'base64'), WRAP_AAD);
  } catch {
    throw fail('wrong-password');
  } finally {
    kek.fill(0);
  }
}

const sameWrap = (a, b) => Boolean(a && b) && a.salt === b.salt && a.wrap === b.wrap && a.wrapNonce === b.wrapNonce;

const ONLY_WRAP = ({ nonce: _nonce, ...header }) => header;

/** The note body of a locked file: a notice for other programs and the armored ciphertext of { assets, body }. */
function sealBody(dek, header, { body, assets }) {
  const key = subKey(dek, 'body');
  const nonce = crypto.randomBytes(NONCE);
  const headerText = JSON.stringify({ ...ONLY_WRAP(header), nonce: nonce.toString('base64') });
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(headerText));
  const plain = zlib.deflateRawSync(Buffer.from(JSON.stringify({ assets, body }), 'utf8'));
  const sealed = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const lines = sealed.toString('base64').match(/.{1,76}/g) || [];
  return `${NOTICE}\n\n\`\`\`${FENCE}\n${headerText}\n${lines.join('\n')}\n\`\`\`\n`;
}

/** { header, headerText, sealed } of a locked body, or null when it cannot be read as one. */
function parseBody(text) {
  const src = String(text);
  const head = HEAD.exec(src);
  if (!head) return null;
  const rest = src.slice(head[0].length).split(/\r?\n/);
  const end = rest.findIndex((l) => l.trim() === '```');
  if (end < 2) return null;
  const headerText = rest[0].trim();
  let header;
  try {
    header = JSON.parse(headerText);
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object' || header.v !== 1 || !validKdf(header) || typeof header.nonce !== 'string') return null;
  const b64 = rest.slice(1, end).join('').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  return { header: ONLY_WRAP(header), nonce: header.nonce, headerText, sealed: Buffer.from(b64, 'base64') };
}

/** { body, assets } of a parsed locked body; LockError('corrupt') when the text was changed. */
function openBody(dek, parsed) {
  try {
    const plain = decrypt(subKey(dek, 'body'), Buffer.from(parsed.nonce, 'base64'), parsed.sealed, Buffer.from(parsed.headerText));
    const v = JSON.parse(zlib.inflateRawSync(plain).toString('utf8'));
    if (typeof v.body !== 'string') throw new Error('body');
    return { body: v.body, assets: typeof v.assets === 'string' ? v.assets : null };
  } catch {
    throw fail('corrupt');
  }
}

/** The file name of an attachment inside a locked note's assets folder: reveals nothing of its name. */
function assetFileName(dek, name) {
  const mac = crypto.createHmac('sha256', subKey(dek, 'name')).update(String(name).normalize('NFC')).digest('hex');
  return `${mac.slice(0, 40)}.dwenc`;
}

const isAssetFile = (fileName) => ASSET_FILE.test(fileName);

/** An attachment's file bytes: its real name and content, encrypted. */
function sealAsset(dek, name, bytes) {
  const nameBytes = Buffer.from(String(name).normalize('NFC'), 'utf8');
  if (nameBytes.length > 0xffff) throw new Error('file name');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(nameBytes.length);
  const { nonce, data } = encrypt(subKey(dek, 'asset'), Buffer.concat([len, nameBytes, bytes]), ASSET_MAGIC);
  return Buffer.concat([ASSET_MAGIC, nonce, data]);
}

/** { name, bytes } of an attachment file; LockError('corrupt') when it was changed. */
function openAsset(dek, file) {
  try {
    if (!file.subarray(0, ASSET_MAGIC.length).equals(ASSET_MAGIC)) throw new Error('magic');
    const at = ASSET_MAGIC.length;
    const plain = decrypt(subKey(dek, 'asset'), file.subarray(at, at + NONCE), file.subarray(at + NONCE), ASSET_MAGIC);
    const len = plain.readUInt16BE(0);
    return { name: plain.subarray(2, 2 + len).toString('utf8'), bytes: plain.subarray(2 + len) };
  } catch {
    throw fail('corrupt');
  }
}

/**
 * The padlock of a note in its window and in the list: null for a note that cannot be locked (.txt, archive, done,
 * conflict copy). action: 'set' opens the lock box, 'menu' the lock menu, null nothing (the password comes first).
 */
function lockIcon({ locked = false, unlocked = false, lockable = false } = {}) {
  if (locked) return unlocked
    ? { icon: '🔒', state: 'locked', title: '잠긴 노트: 암호 바꾸기·잠금 풀기', action: 'menu' }
    : { icon: '🔒', state: 'locked', title: '잠긴 노트: 암호를 넣으면 열립니다', action: null };
  return lockable ? { icon: '🔓', state: 'open', title: '암호로 잠그기', action: 'set' } : null;
}

module.exports = { lockIcon, LockError, fail, KDF, MIN_PASSWORD, FENCE, isLocked, passwordProblem, newKey, wrapKey, openKey, sameWrap, sealBody, parseBody, openBody, assetFileName, isAssetFile, sealAsset, openAsset };
