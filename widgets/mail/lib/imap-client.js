// A small IMAP4rev1 client on Node tls / net (#65): implicit TLS (993) or STARTTLS (143), LOGIN or
// AUTHENTICATE PLAIN, SELECT / EXAMINE, UID SEARCH / FETCH / STORE, IDLE. Read-mostly by design.
// Security rules: credentials are only sent on an encrypted connection (a STARTTLS server that does not
// offer STARTTLS is refused, never "downgraded"), certificates are verified, nothing is logged.
const tls = require('tls');
const net = require('net');
const { EventEmitter } = require('events');
const { ResponseReader, parseResponse, str, searchNumbers, esearch, expandSet } = require('./imap-parser');
const utf7 = require('./utf7');

class ImapError extends Error {
  /** kind: 'auth' | 'no' | 'bad' | 'tls' | 'starttls' | 'network' | 'timeout' | 'protocol' | 'closed' */
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const COMMAND_TIMEOUT = 60000;
const CONNECT_TIMEOUT = 20000;

/** Default transport: a TLS socket (verified) or a plain one for STARTTLS. */
function defaultConnect({ host, port, secure, timeoutMs = CONNECT_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, ...(secure ? { servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' } : {}) };
    const sock = secure ? tls.connect(opts) : net.connect(opts);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new ImapError('timeout', '서버에 연결하지 못했습니다(시간 초과).'));
    }, timeoutMs);
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Default STARTTLS upgrade of a plain socket (certificate verified against the host name). */
function defaultUpgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const sec = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' });
    sec.once('secureConnect', () => resolve(sec));
    sec.once('error', reject);
  });
}

/** An argument the server sees as a quoted string, or a literal when it cannot be quoted. */
function quote(value) {
  const s = String(value);
  if (/^[\x20-\x7e]*$/.test(s) && s.length <= 1000) return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return { literal: Buffer.from(s, 'utf8') };
}

/** A mailbox name argument (INBOX as is, others in modified UTF-7). */
const mailboxArg = (name) => (String(name).toUpperCase() === 'INBOX' ? 'INBOX' : quote(utf7.encode(name)));

class ImapClient extends EventEmitter {
  /**
   * @param {object} o host, port, security ('tls' | 'starttls'), username, password
   * @param {object} [o.deps] seams for tests: connect({ host, port, secure }) -> socket, upgrade(socket, host) -> socket
   */
  constructor({ host, port, security = 'tls', username, password, deps = {}, timeoutMs = COMMAND_TIMEOUT }) {
    super();
    this.host = host;
    this.port = port;
    this.security = security;
    this.username = username;
    this.password = password;
    this.connectFn = deps.connect || defaultConnect;
    this.upgradeFn = deps.upgrade || defaultUpgrade;
    this.timeoutMs = timeoutMs;
    this.caps = new Set();
    this.secure = false;
    this.socket = null;
    this.reader = new ResponseReader();
    this.seq = 0;
    this.current = null; // the command waiting for its tagged answer
    this.queue = Promise.resolve();
    this.greeting = null;
    this.closed = false;
    this.idling = null;
    this.selected = null;
  }

  has(cap) {
    return this.caps.has(cap.toUpperCase());
  }

  // ---- transport ----

  attach(socket) {
    this.socket = socket;
    socket.setKeepAlive?.(true, 60000);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(new ImapError('network', networkMessage(err), { cause: err })));
    socket.on('close', () => this.fail(new ImapError('closed', '서버와의 연결이 끊어졌습니다.')));
  }

  onData(chunk) {
    let list;
    try {
      list = this.reader.push(chunk);
    } catch (err) {
      this.fail(new ImapError('protocol', `서버 응답을 읽지 못했습니다: ${err.message}`));
      return;
    }
    for (const raw of list) {
      let res;
      try {
        res = parseResponse(raw);
      } catch (err) {
        this.fail(new ImapError('protocol', `서버 응답을 읽지 못했습니다: ${err.message}`));
        return;
      }
      this.onResponse(res);
    }
  }

  onResponse(res) {
    if (res.tag === '+') {
      const cont = this.current?.onContinue;
      if (cont) cont(res);
      return;
    }
    if (res.tag === '*') {
      if (this.greeting) {
        const g = this.greeting;
        this.greeting = null;
        g(res);
        return;
      }
      if (res.code?.name === 'CAPABILITY') this.setCaps(res.code.args);
      if (res.type === 'CAPABILITY') this.setCaps(res.values);
      if (this.current) this.current.untagged.push(res);
      // Mailbox changes: EXISTS / EXPUNGE, and FETCH that we did not ask for (another client changed flags;
      // the answer to our own UID FETCH carries UID and is not a change).
      const solicitedFetch = res.type === 'FETCH' && this.current && !this.idling && res.attrs?.UID !== undefined;
      if (res.type === 'EXISTS' || res.type === 'EXPUNGE' || (res.type === 'FETCH' && !solicitedFetch)) this.emit('mailbox', res);
      if (res.type === 'BYE') this.emit('bye', res.text);
      return;
    }
    const cur = this.current;
    if (!cur || res.tag !== cur.tag) return;
    this.current = null;
    clearTimeout(cur.timer);
    if (res.code?.name === 'CAPABILITY') this.setCaps(res.code.args);
    if (res.type === 'OK') cur.resolve({ ...res, untagged: cur.untagged });
    else cur.reject(new ImapError(res.type === 'NO' ? 'no' : 'bad', res.text || res.type, { responseCode: res.code?.name || null, untagged: cur.untagged }));
  }

  setCaps(list) {
    this.caps = new Set((list || []).map((c) => str(c).toUpperCase()));
  }

  fail(err) {
    if (this.closed) return;
    this.closed = true;
    const cur = this.current;
    this.current = null;
    if (cur) {
      clearTimeout(cur.timer);
      cur.reject(err);
    }
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = null;
      g(null, err);
    }
    if (this.idling) this.idling.fail(err);
    this.socket?.destroy();
    this.emit('close', err);
  }

  write(data) {
    if (this.closed || !this.socket) throw new ImapError('closed', '서버와의 연결이 끊어졌습니다.');
    this.socket.write(data);
  }

  // ---- commands ----

  /**
   * Runs one command (queued behind earlier ones). parts: strings joined by spaces, or { literal: Buffer }.
   * Resolves the tagged OK with the untagged responses that came meanwhile; rejects NO / BAD as ImapError.
   */
  command(parts, { timeoutMs = this.timeoutMs, onContinue = null } = {}) {
    const run = () => this.send(Array.isArray(parts) ? parts : [parts], timeoutMs, onContinue);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  send(parts, timeoutMs, onContinue) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new ImapError('closed', '서버와의 연결이 끊어졌습니다.'));
        return;
      }
      const tag = `A${++this.seq}`;
      const cur = { tag, untagged: [], resolve, reject, onContinue: null, timer: null };
      cur.timer = setTimeout(() => this.fail(new ImapError('timeout', '서버가 답하지 않습니다(시간 초과).')), timeoutMs);
      this.current = cur;
      // Segments split at literals: each literal is announced, then sent after the server's "+" (or at
      // once with LITERAL+).
      const segments = [];
      let line = tag;
      for (const p of parts) {
        if (p && typeof p === 'object' && p.literal) {
          const nonSync = this.has('LITERAL+');
          segments.push({ text: `${line} {${p.literal.length}${nonSync ? '+' : ''}}\r\n`, literal: p.literal, wait: !nonSync });
          line = '';
        } else line += ` ${p}`;
      }
      const tail = `${line}\r\n`; // after a literal this starts with the space before the next argument
      const queue = [...segments];
      const next = () => {
        try {
          const seg = queue.shift();
          if (!seg) {
            this.write(tail);
            cur.onContinue = onContinue ? (res) => onContinue(res, (data) => this.write(data)) : null;
            return;
          }
          this.write(seg.text);
          if (seg.wait) {
            cur.onContinue = () => {
              cur.onContinue = null;
              this.write(seg.literal);
              next();
            };
          } else {
            this.write(seg.literal);
            next();
          }
        } catch (err) {
          clearTimeout(cur.timer);
          if (this.current === cur) this.current = null;
          reject(err);
        }
      };
      next();
    });
  }

  async capability() {
    await this.command('CAPABILITY');
    return this.caps;
  }

  /** Connects, reads the greeting, switches to TLS when asked, logs in. */
  async open() {
    const secure = this.security === 'tls';
    if (this.security !== 'tls' && this.security !== 'starttls') throw new ImapError('tls', '암호화하지 않은 연결은 쓸 수 없습니다(SSL/TLS 또는 STARTTLS).');
    let socket;
    try {
      socket = await this.connectFn({ host: this.host, port: this.port, secure });
    } catch (err) {
      throw err instanceof ImapError ? err : new ImapError(isTlsError(err) ? 'tls' : 'network', networkMessage(err), { cause: err });
    }
    this.secure = secure;
    const greeting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ImapError('timeout', '서버가 인사말을 보내지 않습니다(시간 초과).')), CONNECT_TIMEOUT);
      this.greeting = (res, err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(res);
      };
    });
    this.attach(socket);
    const hello = await greeting;
    if (hello.type === 'BYE') throw new ImapError('no', `서버가 연결을 거절했습니다: ${hello.text}`);
    if (hello.code?.name === 'CAPABILITY') this.setCaps(hello.code.args);
    else await this.capability();
    if (this.security === 'starttls') {
      if (!this.has('STARTTLS')) throw new ImapError('starttls', '서버가 STARTTLS를 지원하지 않아 연결을 중단했습니다. 암호화되지 않은 연결로는 로그인하지 않습니다. 보안을 SSL/TLS(993)로 바꿔 보세요.');
      await this.command('STARTTLS');
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('close');
      this.socket.removeAllListeners('error');
      let upgraded;
      try {
        upgraded = await this.upgradeFn(this.socket, this.host);
      } catch (err) {
        this.socket.destroy();
        throw new ImapError('tls', networkMessage(err), { cause: err });
      }
      this.reader = new ResponseReader();
      this.secure = true;
      this.attach(upgraded);
      this.caps = new Set();
      await this.capability(); // capabilities before TLS are not trusted (RFC 3501 6.2.1)
    }
    if (hello.type !== 'PREAUTH') await this.login();
    return this;
  }

  async login() {
    if (!this.secure) throw new ImapError('tls', '암호화되지 않은 연결에서는 로그인하지 않습니다.');
    try {
      if (this.has('AUTH=PLAIN')) {
        const token = Buffer.from(`\0${this.username}\0${this.password}`, 'utf8').toString('base64');
        if (this.has('SASL-IR')) await this.command(['AUTHENTICATE', 'PLAIN', token]);
        else await this.command(['AUTHENTICATE', 'PLAIN'], { onContinue: (_res, write) => write(`${token}\r\n`) });
      } else if (this.has('LOGINDISABLED')) {
        throw new ImapError('auth', '서버가 이 방식의 로그인을 막아 두었습니다(LOGINDISABLED).');
      } else {
        await this.command(['LOGIN', quote(this.username), quote(this.password)]);
      }
    } catch (err) {
      if (err.kind === 'no' || err.kind === 'bad') throw new ImapError('auth', err.message, { responseCode: err.responseCode });
      throw err;
    }
    // Servers may change capabilities after login; ask again unless the OK carried them.
    if (!this.caps.size || !this.has('IMAP4REV1')) await this.capability().catch(() => {});
  }

  /** SELECT (or EXAMINE) -> { exists, uidValidity, uidNext, unseen, readOnly, flags }. */
  async select(mailbox = 'INBOX', { readOnly = false, raw = false } = {}) {
    // raw: the name exactly as LIST gave it (modified UTF-7 already), #80.
    const arg = raw && String(mailbox).toUpperCase() !== 'INBOX' ? quote(mailbox) : mailboxArg(mailbox);
    const res = await this.command([readOnly ? 'EXAMINE' : 'SELECT', arg]);
    const box = { name: mailbox, exists: 0, uidValidity: null, uidNext: null, unseen: null, readOnly: res.code?.name === 'READ-ONLY', flags: [] };
    for (const u of res.untagged) {
      if (u.type === 'EXISTS') box.exists = u.num;
      else if (u.type === 'FLAGS') box.flags = (u.values[0] || []).map(str);
      else if (u.type === 'OK' && u.code) {
        const v = Number(str(u.code.args[0]));
        if (u.code.name === 'UIDVALIDITY') box.uidValidity = v;
        else if (u.code.name === 'UIDNEXT') box.uidNext = v;
        else if (u.code.name === 'UNSEEN') box.unseen = v;
      }
    }
    this.selected = box;
    return box;
  }

  async uidSearch(criteria) {
    const res = await this.command(['UID', 'SEARCH', criteria]);
    const out = [];
    for (const u of res.untagged) {
      if (u.type === 'SEARCH') out.push(...searchNumbers(u));
      else if (u.type === 'ESEARCH') out.push(...expandSet(esearch(u).ALL));
    }
    return out;
  }

  /** How many messages match (ESEARCH RETURN (COUNT) when offered, else the length of a SEARCH). */
  async count(criteria) {
    if (this.has('ESEARCH')) {
      const res = await this.command(['UID', 'SEARCH', 'RETURN', '(COUNT)', criteria]);
      const e = res.untagged.find((u) => u.type === 'ESEARCH');
      return e ? Number(esearch(e).COUNT) || 0 : 0;
    }
    return (await this.uidSearch(criteria)).length;
  }

  /** FETCH by UID (uid = true) or sequence numbers -> [attrs] (each with UID as a number). */
  async fetch(set, items, { uid = true, timeoutMs } = {}) {
    if (!set) return [];
    const res = await this.command([uid ? 'UID FETCH' : 'FETCH', set, `(${items})`], { timeoutMs: timeoutMs || this.timeoutMs * 2 });
    const out = [];
    for (const u of res.untagged) {
      if (u.type !== 'FETCH' || !u.attrs) continue;
      const a = u.attrs;
      if (a.UID === undefined) continue; // an unsolicited flags update of another message
      out.push({ ...a, seq: u.num, UID: Number(str(a.UID)) });
    }
    return out;
  }

  /** UID STORE set +FLAGS.SILENT / -FLAGS.SILENT (flags). */
  async store(set, add, flags) {
    await this.command(['UID', 'STORE', set, add ? '+FLAGS.SILENT' : '-FLAGS.SILENT', `(${flags.join(' ')})`]);
  }

  noop() {
    return this.command('NOOP');
  }

  /** LIST "" "*" -> [{ name (decoded), raw (as sent), flags: ['\\Sent', ...], delimiter }]. */
  async list() {
    const res = await this.command(['LIST', '""', '"*"']);
    return res.untagged
      .filter((u) => u.type === 'LIST')
      .map((u) => {
        const raw = str(u.values[2]);
        return { raw, name: utf7.decode(raw), flags: (Array.isArray(u.values[0]) ? u.values[0] : []).map((f) => str(f)), delimiter: str(u.values[1]) };
      });
  }

  /**
   * STATUS of a mailbox that is not selected (#80): raw name as LIST gave it; items e.g.
   * ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN'] -> { MESSAGES: n, ... }.
   */
  async status(rawName, items) {
    const res = await this.command(['STATUS', String(rawName).toUpperCase() === 'INBOX' ? 'INBOX' : quote(rawName), `(${items.join(' ')})`]);
    const out = {};
    for (const u of res.untagged) {
      if (u.type !== 'STATUS') continue;
      const list = Array.isArray(u.values[1]) ? u.values[1] : [];
      for (let i = 0; i + 1 < list.length; i += 2) out[str(list[i]).toUpperCase()] = Number(str(list[i + 1]));
    }
    return out;
  }

  /** APPEND a message to a mailbox (raw name as LIST gave it) with flags, e.g. ['\\Seen']. */
  async append(rawName, flags, data) {
    const box = String(rawName).toUpperCase() === 'INBOX' ? 'INBOX' : quote(rawName);
    await this.command(['APPEND', box, `(${flags.join(' ')})`, { literal: Buffer.isBuffer(data) ? data : Buffer.from(data) }], { timeoutMs: 300000 });
  }

  /**
   * Starts IDLE (RFC 2177). Resolves once the server accepted it, with { done(): Promise } to end it.
   * Mailbox events arrive as 'mailbox' events meanwhile. The caller re-IDLEs before the server's ~29 min limit.
   */
  idle() {
    if (!this.has('IDLE')) return Promise.reject(new ImapError('no', 'IDLE not supported'));
    return new Promise((resolve, reject) => {
      let finished = null;
      let accepted = false;
      const state = {
        fail: (err) => {
          this.idling = null;
          if (!accepted) reject(err);
        },
      };
      this.idling = state;
      const tagged = this.command('IDLE', {
        timeoutMs: 31 * 60000,
        onContinue: () => {
          accepted = true;
          resolve({
            done: () => {
              if (finished) return finished;
              finished = (async () => {
                try {
                  this.write('DONE\r\n');
                  await tagged;
                } finally {
                  this.idling = null;
                }
              })();
              return finished;
            },
            ended: tagged.then(
              () => null,
              (err) => err,
            ),
          });
        },
      });
      tagged.catch((err) => {
        this.idling = null;
        if (!accepted) reject(err);
      });
    });
  }

  async logout() {
    if (this.closed) return;
    try {
      await this.command('LOGOUT', { timeoutMs: 5000 });
    } catch {
      // closing anyway
    }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const cur = this.current;
    this.current = null;
    if (cur) {
      clearTimeout(cur.timer);
      cur.reject(new ImapError('closed', '연결을 닫았습니다.'));
    }
    this.socket?.destroy();
    this.emit('close', null);
  }
}

function isTlsError(err) {
  const code = String(err?.code || '');
  return /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME|ERR_TLS/.test(code);
}

/** A network error -> a Korean message (no credentials are ever part of these). */
function networkMessage(err) {
  if (err instanceof ImapError) return err.message;
  const code = String(err?.code || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '서버 주소를 찾지 못했습니다. 서버 이름과 인터넷 연결을 확인하세요.';
  if (code === 'ECONNREFUSED') return '서버가 연결을 거부했습니다. 포트와 보안 방식(SSL/TLS·STARTTLS)을 확인하세요.';
  if (code === 'ETIMEDOUT') return '서버에 연결하지 못했습니다(시간 초과).';
  if (code === 'ECONNRESET' || code === 'EPIPE') return '서버와의 연결이 끊어졌습니다.';
  if (isTlsError(err)) return `서버 인증서를 확인하지 못했습니다(${code}). 서버 이름이 맞는지 확인하세요. 위젯은 확인되지 않은 인증서로 연결하지 않습니다.`;
  return `연결 오류: ${String(err?.message || err).slice(0, 200)}`;
}

module.exports = { ImapClient, ImapError, quote, mailboxArg, networkMessage, defaultConnect };
