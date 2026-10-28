// Engine secret store (#108): id -> DPAPI ciphertext (Electron safeStorage) in a widget's data folder.
// Secrets never take part in sync. Values this PC decrypts or saves are remembered in memory only, so the
// sync engine can refuse to export a record that accidentally contains one (secretGuard).
const fs = require('fs');
const path = require('path');

const MIN_GUARDED = 4;
const known = new Set();

function rememberSecret(value) {
  if (typeof value === 'string' && value.length >= MIN_GUARDED) known.add(value);
}

/** Whether the text (for example canonical JSON of outgoing records) contains a secret seen on this PC. */
function containsSecret(text) {
  if (typeof text !== 'string' || !known.size) return false;
  for (const secret of known) {
    if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))) return true;
  }
  return false;
}

function forgetSecrets() {
  known.clear();
}

class SecretUnavailableError extends Error {
  constructor() {
    super('이 PC에서 암호화 저장(Windows 데이터 보호)을 쓸 수 없어 비밀번호를 저장하지 않았습니다. 비밀번호와 토큰은 평문으로 저장하지 않습니다.');
    this.code = 'secret-unavailable';
  }
}

function electronCrypto() {
  const { safeStorage } = require('electron');
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
}

/**
 * The file shape matches the calendar and mail widgets' earlier secrets.json: { [id]: base64 ciphertext }.
 * @param {{ file: string, crypto?: { available(): boolean, encrypt(s): string, decrypt(s): string } }} opts
 */
function openSecrets({ file, crypto = null }) {
  let box = crypto;
  const keychain = () => (box ||= electronCrypto());
  const available = () => {
    try {
      return Boolean(keychain().available());
    } catch {
      return false;
    }
  };

  function read() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  function write(map) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, file);
  }

  // The export guard must know every stored secret before the first sync, not only those a widget used already.
  if (available()) {
    for (const enc of Object.values(read())) {
      try { rememberSecret(keychain().decrypt(enc)); } catch { /* another Windows user's value: not readable here either */ }
    }
  }

  return {
    available,
    /** Stores a secret; throws SecretUnavailableError instead of writing plain text. */
    set(id, value) {
      if (!available()) throw new SecretUnavailableError();
      const text = String(value);
      write({ ...read(), [id]: keychain().encrypt(text) });
      rememberSecret(text);
    },
    /** The secret, or '' when there is none or it cannot be decrypted (another Windows user's file). */
    get(id) {
      const enc = read()[id];
      if (!enc) return '';
      try {
        const text = keychain().decrypt(enc);
        rememberSecret(text);
        return text;
      } catch {
        return '';
      }
    },
    has: (id) => Boolean(read()[id]),
    delete(id) {
      const map = read();
      if (!(id in map)) return;
      delete map[id];
      write(map);
    },
    /** Removes secrets whose ids are no longer used. */
    prune(keepIds) {
      const map = read();
      const keep = new Set(keepIds);
      const next = Object.fromEntries(Object.entries(map).filter(([id]) => keep.has(id)));
      if (Object.keys(next).length !== Object.keys(map).length) write(next);
    },
  };
}

module.exports = { openSecrets, rememberSecret, containsSecret, forgetSecrets, SecretUnavailableError };
