// A small SMTP submission client on Node tls / net (#68): implicit TLS (465) or STARTTLS (587), EHLO,
// AUTH PLAIN / LOGIN, MAIL FROM / RCPT TO / DATA with dot-stuffing. Same security rules as the IMAP client:
// credentials only over an encrypted, verified connection (a STARTTLS server that does not offer STARTTLS
// gets no password), nothing is logged.
const tls = require('tls');
const net = require('net');

class SmtpError extends Error {
  /** kind: 'auth' | 'relay' | 'recipient' | 'size' | 'rejected' | 'tls' | 'starttls' | 'network' | 'timeout' | 'protocol' | 'closed' */
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TIMEOUT = 60000;
const DATA_TIMEOUT = 300000; // a 20 MB message on a slow uplink

function defaultConnect({ host, port, secure, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, ...(secure ? { servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' } : {}) };
    const sock = secure ? tls.connect(opts) : net.connect(opts);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new SmtpError('timeout', '보내는 메일 서버(SMTP)에 연결하지 못했습니다(시간 초과).'));
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

function defaultUpgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const sec = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' });
    sec.once('secureConnect', () => resolve(sec));
    sec.once('error', reject);
  });
}

function networkMessage(err) {
  const code = String(err?.code || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '보내는 메일 서버(SMTP) 주소를 찾지 못했습니다. 서버 이름과 인터넷 연결을 확인하세요.';
  if (code === 'ECONNREFUSED') return '보내는 메일 서버가 연결을 거부했습니다. 포트와 보안 방식(SSL/TLS·STARTTLS)을 확인하세요.';
  if (code === 'ETIMEDOUT') return '보내는 메일 서버에 연결하지 못했습니다(시간 초과).';
  if (code === 'ECONNRESET' || code === 'EPIPE') return '보내는 메일 서버와의 연결이 끊어졌습니다.';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/.test(code)) return `보내는 메일 서버의 인증서를 확인하지 못했습니다(${code}). 확인되지 않은 인증서로는 연결하지 않습니다.`;
  return `보내는 메일 서버 연결 오류: ${String(err?.message || err).slice(0, 200)}`;
}

/** "250-a\r\n250 b" lines -> { code, lines } once the final line arrived. */
class ReplyReader {
  constructor() {
    this.buf = '';
    this.lines = [];
  }

  push(chunk) {
    this.buf += chunk.toString('utf8');
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) {
        out.push({ code: 0, lines: [line], bad: true });
        continue;
      }
      this.lines.push(m[3]);
      if (m[2] === ' ') {
        out.push({ code: Number(m[1]), lines: this.lines });
        this.lines = [];
      }
    }
    return out;
  }
}

/** Dot-stuffing (RFC 5321 4.5.2) and the terminating CRLF.CRLF; input already has CRLF line ends. */
function dotStuff(data) {
  const text = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
  const stuffed = text.replace(/(^|\r\n)\./g, '$1..');
  return Buffer.from(`${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`, 'latin1');
}

class SmtpClient {
  constructor({ host, port, security = 'tls', username, password, deps = {}, timeoutMs = TIMEOUT, helo = '[127.0.0.1]' }) {
    this.host = host;
    this.port = port;
    this.security = security;
    this.username = username;
    this.password = password;
    this.connectFn = deps.connect || defaultConnect;
    this.upgradeFn = deps.upgrade || defaultUpgrade;
    this.timeoutMs = timeoutMs;
    this.helo = helo;
    this.secure = false;
    this.ext = new Map(); // EHLO keyword -> parameter text
    this.reader = new ReplyReader();
    this.waiting = null;
    this.pending = [];
    this.closed = false;
  }

  attach(socket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      for (const r of this.reader.push(chunk)) this.onReply(r);
    });
    socket.on('error', (err) => this.fail(new SmtpError('network', networkMessage(err))));
    socket.on('close', () => this.fail(new SmtpError('closed', '보내는 메일 서버와의 연결이 끊어졌습니다.')));
  }

  onReply(r) {
    const w = this.waiting;
    if (!w) {
      this.pending.push(r);
      return;
    }
    this.waiting = null;
    clearTimeout(w.timer);
    w.resolve(r);
  }

  fail(err) {
    if (this.closed) return;
    this.closed = true;
    const w = this.waiting;
    this.waiting = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.socket?.destroy();
  }

  /** The next reply (one per command; RFC 5321 does not pipeline here). */
  reply(timeoutMs = this.timeoutMs) {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    if (this.closed) return Promise.reject(new SmtpError('closed', '보내는 메일 서버와의 연결이 끊어졌습니다.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new SmtpError('timeout', '보내는 메일 서버가 답하지 않습니다(시간 초과).')), timeoutMs);
      this.waiting = { resolve, reject, timer };
    });
  }

  write(data) {
    if (this.closed) throw new SmtpError('closed', '보내는 메일 서버와의 연결이 끊어졌습니다.');
    this.socket.write(data);
  }

  async cmd(line, expect, kind = 'rejected', timeoutMs) {
    this.write(`${line}\r\n`);
    const r = await this.reply(timeoutMs);
    if (!expect.includes(r.code)) throw replyError(r, kind);
    return r;
  }

  async ehlo() {
    const r = await this.cmd(`EHLO ${this.helo}`, [250], 'protocol');
    this.ext = new Map();
    for (const l of r.lines.slice(1)) {
      const [k, ...rest] = l.trim().split(/\s+/);
      this.ext.set(k.toUpperCase(), rest.join(' ').toUpperCase());
    }
  }

  async open() {
    if (this.security !== 'tls' && this.security !== 'starttls') throw new SmtpError('tls', '암호화하지 않은 연결은 쓸 수 없습니다(SSL/TLS 또는 STARTTLS).');
    const secure = this.security === 'tls';
    let socket;
    try {
      socket = await this.connectFn({ host: this.host, port: this.port, secure });
    } catch (err) {
      throw err instanceof SmtpError ? err : new SmtpError(/CERT|SSL|TLS/.test(String(err?.code)) ? 'tls' : 'network', networkMessage(err));
    }
    this.secure = secure;
    this.attach(socket);
    const hello = await this.reply();
    if (hello.code !== 220) throw replyError(hello, 'rejected');
    await this.ehlo();
    if (this.security === 'starttls') {
      if (!this.ext.has('STARTTLS')) throw new SmtpError('starttls', '보내는 메일 서버가 STARTTLS를 지원하지 않아 중단했습니다. 암호화되지 않은 연결로는 로그인하지 않습니다. 보안을 SSL/TLS(465)로 바꿔 보세요.');
      await this.cmd('STARTTLS', [220], 'starttls');
      for (const ev of ['data', 'close', 'error']) this.socket.removeAllListeners(ev);
      let up;
      try {
        up = await this.upgradeFn(this.socket, this.host);
      } catch (err) {
        this.socket.destroy();
        throw new SmtpError('tls', networkMessage(err));
      }
      this.reader = new ReplyReader();
      this.secure = true;
      this.attach(up);
      await this.ehlo(); // extensions before TLS are not trusted
    }
    await this.login();
    return this;
  }

  async login() {
    if (!this.secure) throw new SmtpError('tls', '암호화되지 않은 연결에서는 로그인하지 않습니다.');
    const auth = this.ext.get('AUTH') || '';
    const methods = auth.split(/\s+/);
    if (methods.includes('PLAIN') || !methods.includes('LOGIN')) {
      const token = Buffer.from(`\0${this.username}\0${this.password}`, 'utf8').toString('base64');
      await this.cmd(`AUTH PLAIN ${token}`, [235], 'auth');
      return;
    }
    await this.cmd('AUTH LOGIN', [334], 'auth');
    await this.cmd(Buffer.from(this.username, 'utf8').toString('base64'), [334], 'auth');
    await this.cmd(Buffer.from(this.password, 'utf8').toString('base64'), [235], 'auth');
  }

  /** Sends one message: from (address), recipients (addresses, Bcc included), data (CRLF lines). */
  async send({ from, recipients, data }) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const max = Number(this.ext.get('SIZE')) || 0;
    if (max && bytes.length > max) throw new SmtpError('size', `메일이 서버 한도(${Math.floor(max / 1048576)}MB)보다 큽니다. 첨부를 줄여 주세요.`);
    const sizeArg = this.ext.has('SIZE') ? ` SIZE=${bytes.length}` : '';
    const utf8 = this.ext.has('SMTPUTF8') && /[^\x00-\x7f]/.test(from + recipients.join('')) ? ' SMTPUTF8' : '';
    await this.cmd(`MAIL FROM:<${from}>${sizeArg}${utf8}`, [250], 'relay');
    const refused = [];
    for (const rcpt of recipients) {
      this.write(`RCPT TO:<${rcpt}>\r\n`);
      const r = await this.reply();
      if (r.code !== 250 && r.code !== 251) refused.push({ rcpt, r });
    }
    if (refused.length === recipients.length || refused.length) {
      // Any refused recipient: nothing is sent (a partial send would surprise the user).
      this.write('RSET\r\n');
      await this.reply().catch(() => {});
      const first = refused[0];
      const err = replyError(first.r, 'recipient');
      err.message = `받는 사람 ${first.rcpt}: ${err.message}`;
      err.recipients = refused.map((x) => x.rcpt);
      throw err;
    }
    await this.cmd('DATA', [354], 'rejected');
    this.write(dotStuff(bytes));
    const r = await this.reply(DATA_TIMEOUT);
    if (r.code !== 250) throw replyError(r, 'rejected');
    return { response: r.lines.join(' ').slice(0, 200) };
  }

  async quit() {
    if (this.closed) return;
    try {
      this.write('QUIT\r\n');
      await this.reply(5000);
    } catch {
      // closing anyway
    }
    this.close();
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }
}

/** A refused reply -> SmtpError with a Korean message and the server text. */
function replyError(r, kind) {
  const text = r.lines.join(' ').slice(0, 200);
  const code = r.code;
  let k = kind;
  if (code === 535 || code === 534 || code === 530 || (kind === 'auth' && code >= 500)) k = 'auth';
  else if (code === 552 || /size|too (large|big)|exceed/i.test(text)) k = 'size';
  else if (/relay|not permitted|sender.*(denied|rejected)|not owned|authenticat/i.test(text) && (kind === 'relay' || kind === 'recipient')) k = 'relay';
  const label = {
    auth: '보내는 메일 서버가 로그인을 거절했습니다',
    relay: '보내는 메일 서버가 이 보내는 주소로는 보낼 수 없다고 했습니다(보내는 주소가 이 계정의 주소인지 확인)',
    recipient: '서버가 받는 사람을 거절했습니다',
    size: '메일이 너무 큽니다',
    starttls: '보안 연결(STARTTLS)을 시작하지 못했습니다',
    protocol: '보내는 메일 서버와 대화하지 못했습니다',
    rejected: '보내는 메일 서버가 메일을 거절했습니다',
  }[k] || '보내는 메일 서버가 거절했습니다';
  return new SmtpError(k, `${label} (${code} ${text})`, { code });
}

module.exports = { SmtpClient, SmtpError, dotStuff, replyError, ReplyReader, networkMessage };
