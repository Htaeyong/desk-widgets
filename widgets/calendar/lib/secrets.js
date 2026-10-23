// CalDAV passwords, encrypted with Electron safeStorage (Windows: DPAPI, tied to this Windows user) in the
// widget's own main code. The file holds only ciphertext; nothing is written when encryption is unavailable.
const fs = require('fs');
const path = require('path');

class SecretUnavailableError extends Error {
  constructor() {
    super('이 PC에서 암호화 저장(Windows 데이터 보호)을 쓸 수 없어 비밀번호를 저장하지 않았습니다. 비밀번호를 평문으로 저장하지 않기 때문에 이 상태에서는 CalDAV 계정을 추가할 수 없습니다.');
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
 * @param {{ file: string, crypto?: { available(): boolean, encrypt(s): string, decrypt(s): string } }} opts
 * crypto is a seam for tests; the default is Electron safeStorage.
 */
function createSecrets({ file, crypto = null }) {
  let box = crypto;
  const keychain = () => (box ||= electronCrypto());

  function read() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
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

  return {
    available: () => {
      try {
        return Boolean(keychain().available());
      } catch {
        return false;
      }
    },
    /** Stores the password for an account id; throws SecretUnavailableError instead of writing plain text. */
    set(id, password) {
      let ok = false;
      try {
        ok = keychain().available();
      } catch {
        ok = false;
      }
      if (!ok) throw new SecretUnavailableError();
      write({ ...read(), [id]: keychain().encrypt(String(password)) });
    },
    /** The password, or '' when there is none or it cannot be decrypted (e.g. another Windows user's file). */
    get(id) {
      const enc = read()[id];
      if (!enc) return '';
      try {
        return keychain().decrypt(enc);
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
    /** Removes secrets of accounts that no longer exist. */
    prune(keepIds) {
      const map = read();
      const keep = new Set(keepIds);
      const next = Object.fromEntries(Object.entries(map).filter(([id]) => keep.has(id)));
      if (Object.keys(next).length !== Object.keys(map).length) write(next);
    },
  };
}

module.exports = { createSecrets, SecretUnavailableError };
