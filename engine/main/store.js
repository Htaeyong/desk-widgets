// Small JSON settings store shared by the engine and widgets.
// One secret field can be kept encrypted with the OS keychain (DPAPI on Windows) via safeStorage.
// The secret is never written as plain text: without OS encryption a new secret is refused (#97).
const fs = require('fs');
const path = require('path');

class SecretUnavailableError extends Error {
  constructor() {
    super('이 PC에서 암호화 저장(Windows 데이터 보호)을 쓸 수 없어 저장하지 않았습니다. 토큰과 비밀번호는 평문으로 저장하지 않습니다.');
    this.code = 'secret-unavailable';
  }
}

function defaultCrypto() {
  const { safeStorage } = require('electron');
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
}

/**
 * @param {{
 *   file: string | (() => string),
 *   defaults: object,
 *   sanitize?: (next: object) => object,       // clamps and normalizes values before saving
 *   upgrade?: (raw: object) => object,         // fixes older file shapes after reading
 *   seed?: () => object | null,                // values for a missing file (e.g. from .env in development)
 *   secret?: { field: string, enc: string, plain: string },
 *   crypto?: { available(): boolean, encrypt(s): string, decrypt(s): string },
 * }} opts
 */
function createStore({ file, defaults, sanitize = (v) => v, upgrade = (v) => v, seed = () => null, secret = null, crypto = null }) {
  const filePath = typeof file === 'function' ? file : () => file;
  let cache = null;
  let box = crypto;
  const keychain = () => (box ||= defaultCrypto());
  // The secret as it is on disk: its value and ciphertext ('' when it is only in memory).
  let stored = { value: '', enc: '' };

  function secretAvailable() {
    try {
      return Boolean(keychain().available());
    } catch {
      return false;
    }
  }

  /** The secret fields to write. Plain text is never written: a changed secret without OS encryption throws. */
  function encrypt(value) {
    if (!value) return { [secret.enc]: '' };
    // Unchanged: keep the ciphertext, or keep a memory-only secret (legacy plain text, .env seed) off the disk.
    if (value === stored.value && (stored.enc || !secretAvailable())) return { [secret.enc]: stored.enc };
    if (!secretAvailable()) throw new SecretUnavailableError();
    return { [secret.enc]: keychain().encrypt(value) };
  }

  function decrypt(raw) {
    try {
      if (raw[secret.enc]) return keychain().decrypt(raw[secret.enc]);
    } catch {
      return '';
    }
    // Older versions wrote the secret as plain text when OS encryption was unavailable.
    return raw[secret.plain] || '';
  }

  function write(persisted) {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(persisted, null, 2), 'utf8');
  }

  function persistedOf(next) {
    if (!secret) return next;
    const { [secret.field]: value, ...rest } = next;
    return { ...rest, ...encrypt(String(value || '')) };
  }

  function merge(raw) {
    const out = { ...defaults, ...raw };
    // Nested option objects keep defaults for keys the file does not have yet.
    for (const [k, v] of Object.entries(defaults)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...v, ...(raw[k] || {}) };
    }
    return out;
  }

  function load() {
    if (cache) return cache;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    } catch {
      raw = null;
    }
    if (raw) {
      const rest = { ...raw };
      if (secret) {
        delete rest[secret.enc];
        delete rest[secret.plain];
      }
      cache = merge(upgrade(rest));
      if (secret) {
        cache[secret.field] = decrypt(raw);
        stored = { value: cache[secret.field], enc: raw[secret.enc] || '' };
        // A plain-text secret from an older version: rewrite the file at once, encrypted when possible,
        // otherwise without it (the value then works for this run only and must be entered again).
        if (secret.plain in raw) {
          try {
            const persisted = persistedOf(cache);
            write(persisted);
            stored = { value: cache[secret.field], enc: persisted[secret.enc] || '' };
          } catch { /* read-only folder: the next save tries again */ }
        }
      }
    } else {
      cache = { ...merge({}), ...(secret ? { [secret.field]: '' } : {}), ...(seed() || {}) };
      // A seeded secret (development .env) counts as unchanged: kept in memory if it cannot be encrypted.
      if (secret) stored = { value: String(cache[secret.field] || ''), enc: '' };
    }
    return cache;
  }

  /** Saves the merged values. Throws SecretUnavailableError (nothing written) for a new secret without OS encryption. */
  function save(partial) {
    const next = sanitize({ ...load(), ...partial });
    const persisted = persistedOf(next);
    write(persisted);
    if (secret) stored = { value: String(next[secret.field] || ''), enc: persisted[secret.enc] || '' };
    cache = next;
    return next;
  }

  /** Forgets the cached values (tests, or after another process changed the file). */
  function reset() {
    cache = null;
    stored = { value: '', enc: '' };
  }

  return { load, save, reset, secretAvailable, file: filePath };
}

/** Clamps a number into [min, max]; falls back when it is not a number. */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

module.exports = { createStore, clampInt, SecretUnavailableError };
