// Test helper (#68): an in-process SMTP server on net (127.0.0.1, random port). Never a real account.
// TLS is simulated like fake-imap.js: the client's connect / upgrade seams return plain sockets and the
// server records whether STARTTLS came before AUTH.
const net = require('net');

class FakeSmtp {
  constructor({ user = 'me', pass = 'pw', starttls = true, auth = 'PLAIN LOGIN', size = 0, refuse = [], refuseFrom = false, multiline = true } = {}) {
    Object.assign(this, { user, pass, starttls, auth, size, refuse, refuseFrom, multiline });
    this.log = [];
    this.messages = [];
    this.logins = 0;
    this.lastLogin = null;
    this.conns = new Set();
    this.server = net.createServer((sock) => this.onConn(sock));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  close() {
    for (const c of this.conns) c.sock.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  deps() {
    return {
      connect: ({ secure }) =>
        new Promise((resolve, reject) => {
          const s = net.connect(this.server.address().port, '127.0.0.1', () => resolve(s));
          s.once('error', reject);
          s.secureFlag = secure;
        }),
      upgrade: async (socket) => socket,
    };
  }

  onConn(sock) {
    const c = { sock, buf: '', tls: Boolean(sock.secureFlag), authed: false, state: 'cmd', data: [], mail: null, rcpts: [], login: null };
    c.send = (s) => sock.write(`${s}\r\n`);
    this.conns.add(c);
    sock.on('close', () => this.conns.delete(c));
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      c.buf += chunk.toString('latin1');
      let i;
      while ((i = c.buf.indexOf('\r\n')) >= 0) {
        const line = c.buf.slice(0, i);
        c.buf = c.buf.slice(i + 2);
        this.onLine(c, line);
      }
    });
    c.send('220 fake.smtp ESMTP ready');
  }

  ext(c) {
    const lines = ['fake.smtp hello'];
    if (this.starttls && !c.tls) lines.push('STARTTLS');
    if (this.auth) lines.push(`AUTH ${this.auth}`);
    if (this.size) lines.push(`SIZE ${this.size}`);
    lines.push('8BITMIME');
    return lines;
  }

  finishAuth(c, u, p) {
    this.logins++;
    this.lastLogin = { user: u, pass: p, tls: c.tls };
    if (u === this.user && p === this.pass) {
      c.authed = true;
      return c.send('235 2.7.0 Authentication successful');
    }
    return c.send('535 5.7.8 Username and Password not accepted');
  }

  onLine(c, line) {
    if (c.state === 'data') {
      if (line === '.') {
        c.state = 'cmd';
        const data = c.data.map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n');
        this.messages.push({ from: c.mail, rcpts: c.rcpts, data: Buffer.from(data, 'latin1').toString('utf8'), raw: Buffer.from(data, 'latin1') });
        c.data = [];
        c.mail = null;
        c.rcpts = [];
        return c.send('250 2.0.0 OK queued');
      }
      c.data.push(line);
      return undefined;
    }
    this.log.push(line);
    if (c.login === 'user') {
      c.loginUser = Buffer.from(line, 'base64').toString('utf8');
      c.login = 'pass';
      return c.send('334 UGFzc3dvcmQ6');
    }
    if (c.login === 'pass') {
      c.login = null;
      return this.finishAuth(c, c.loginUser, Buffer.from(line, 'base64').toString('utf8'));
    }
    const [verb, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    switch (verb.toUpperCase()) {
      case 'EHLO': {
        const ext = this.ext(c);
        if (!this.multiline) return c.send(`250 ${ext[0]}`);
        return ext.forEach((l, i) => c.send(`250${i === ext.length - 1 ? ' ' : '-'}${l}`));
      }
      case 'STARTTLS':
        c.tls = true;
        return c.send('220 2.0.0 Ready to start TLS');
      case 'AUTH': {
        const [mech, token] = arg.split(' ');
        if (mech === 'PLAIN') {
          const [, u, p] = Buffer.from(token || '', 'base64').toString('utf8').split('\0');
          return this.finishAuth(c, u, p);
        }
        if (mech === 'LOGIN') {
          c.login = 'user';
          return c.send('334 VXNlcm5hbWU6');
        }
        return c.send('504 unknown mechanism');
      }
      case 'MAIL':
        if (!c.authed) return c.send('530 5.7.0 Authentication required');
        if (this.refuseFrom) return c.send('553 5.7.1 Sender address rejected: not owned by user');
        c.mail = /<([^>]*)>/.exec(arg)?.[1];
        return c.send('250 2.1.0 OK');
      case 'RCPT': {
        const to = /<([^>]*)>/.exec(arg)?.[1];
        if (this.refuse.includes(to)) return c.send('550 5.1.1 User unknown');
        c.rcpts.push(to);
        return c.send('250 2.1.5 OK');
      }
      case 'DATA':
        c.state = 'data';
        return c.send('354 End data with <CR><LF>.<CR><LF>');
      case 'RSET':
        c.mail = null;
        c.rcpts = [];
        return c.send('250 OK');
      case 'QUIT':
        c.send('221 bye');
        return c.sock.end();
      default:
        return c.send('502 unknown');
    }
  }
}

module.exports = { FakeSmtp };
