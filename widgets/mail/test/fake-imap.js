// Test helper (#65): an in-process IMAP server on net (127.0.0.1, random port) with a scripted mailbox.
// Never a real account. TLS is simulated: the client's connect / upgrade seams return plain sockets, and the
// server records whether STARTTLS was asked before LOGIN. Enough of RFC 3501 for the widget's commands.
const net = require('net');
const utf7 = require('../lib/utf7');

const q = (s) => {
  if (s === null || s === undefined) return 'NIL';
  const b = Buffer.from(String(s), 'utf8');
  if (/^[\x20-\x7e]*$/.test(String(s)) && !/["\\]/.test(String(s))) return `"${s}"`;
  return `{${b.length}}\r\n${b.toString('latin1')}`;
};
const addr = (name, address) => {
  const [m, h] = address.split('@');
  return `(${q(name)} NIL ${q(m)} ${q(h)})`;
};
const addrList = (list) => (list && list.length ? `(${list.map((a) => addr(a.name || null, a.address)).join('')})` : 'NIL');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function internalDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/**
 * A message: { uid, date, subject (raw header value, may be encoded words), from: {name,address}, to, flags,
 * structure: BODYSTRUCTURE text, parts: { section: Buffer|string } }. Helpers below build common ones.
 */
function textMessage(uid, { date = Date.now(), subject = 'hello', from = { name: 'A', address: 'a@x.test' }, to = [{ name: 'Me', address: 'me@x.test' }], flags = [], text = 'body', charset = 'utf-8', encoding = '7bit', raw = null, messageId = null } = {}) {
  const body = raw ?? Buffer.from(text, 'utf8');
  return {
    uid,
    date,
    subject,
    from,
    to,
    flags,
    messageId: messageId || `<m${uid}@x.test>`,
    structure: `("text" "plain" ("charset" "${charset}") NIL NIL "${encoding}" ${Buffer.byteLength(body)} 1 NIL NIL NIL NIL)`,
    parts: { TEXT: body, 1: body },
  };
}

function altMessage(uid, { html, text, date = Date.now(), subject = 'alt', from = { name: 'B', address: 'b@x.test' }, flags = [], attachment = null } = {}) {
  const t = Buffer.from(text, 'utf8');
  const h = Buffer.from(html, 'utf8');
  const alt = `(("text" "plain" ("charset" "utf-8") NIL NIL "7bit" ${t.length} 1 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8") NIL NIL "7bit" ${h.length} 1 NIL NIL NIL NIL) "alternative" ("boundary" "b1") NIL NIL NIL)`;
  if (!attachment) return { uid, date, subject, from, to: [], flags, structure: alt, parts: { 1: t, 2: h } };
  return {
    uid,
    date,
    subject,
    from,
    to: [],
    flags,
    structure: `(${alt}("application" "pdf" ("name" "${attachment}") NIL NIL "base64" 4000 NIL ("attachment" ("filename" "${attachment}")) NIL NIL) "mixed" ("boundary" "b0") NIL NIL NIL)`,
    parts: { '1.1': t, '1.2': h, 2: Buffer.from('JVBERi0=') },
  };
}

class FakeImap {
  constructor({ messages = [], uidValidity = 1, caps = ['IMAP4rev1', 'IDLE', 'AUTH=PLAIN', 'SASL-IR'], user = 'me', pass = 'pw', starttls = true, greeting = null } = {}) {
    this.messages = messages;
    this.uidValidity = uidValidity;
    this.caps = caps;
    this.user = user;
    this.pass = pass;
    this.starttls = starttls;
    this.greetingText = greeting;
    this.log = []; // commands received (passwords included: tests check where they went)
    this.conns = new Set();
    this.server = net.createServer((sock) => this.onConn(sock));
    this.logins = 0;
    this.failLogins = false;
    // #68: other mailboxes for LIST / APPEND (raw name -> { flags, messages: [{ raw, flags }] }).
    this.boxes = {};
    this.appends = [];
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  close() {
    for (const c of this.conns) c.sock.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Seams for ImapClient: plain sockets to this server; "TLS" is recorded, not real. */
  deps() {
    return {
      connect: ({ secure }) =>
        new Promise((resolve, reject) => {
          const s = net.connect(this.server.address().port, '127.0.0.1', () => resolve(s));
          s.once('error', reject);
          s.secureFlag = secure;
        }),
      upgrade: async (socket) => {
        socket.upgraded = true;
        return socket;
      },
    };
  }

  /** Adds a message and tells IDLE-ing connections (EXISTS). */
  deliver(msg) {
    this.messages.push(msg);
    for (const c of this.conns) if (c.selected) c.send(`* ${this.messages.length} EXISTS`);
  }

  /** #80: adds a message to another mailbox (a server-side rule sorting new mail into a folder). */
  deliverTo(name, msg) {
    const box = this.boxes[name];
    box.messages.push(msg);
    for (const c of this.conns) if (c.box === name) c.send(`* ${box.messages.length} EXISTS`);
  }

  /** The messages a connection's commands act on: INBOX, or the folder it selected. */
  msgsOf(c) {
    return c.box ? this.boxes[c.box].messages : this.messages;
  }

  /** Deletes a message by UID and tells selected connections (EXPUNGE). */
  expunge(uid) {
    const i = this.messages.findIndex((m) => m.uid === uid);
    if (i < 0) return;
    this.messages.splice(i, 1);
    for (const c of this.conns) if (c.selected) c.send(`* ${i + 1} EXPUNGE`);
  }

  onConn(sock) {
    const c = { sock, buf: Buffer.alloc(0), need: 0, line: '', selected: false, idleTag: null, authed: false, tls: Boolean(sock.secureFlag), pendingAuth: null };
    c.send = (s) => sock.write(`${s}\r\n`);
    this.conns.add(c);
    sock.on('close', () => this.conns.delete(c));
    sock.on('error', () => {});
    sock.on('data', (chunk) => this.onData(c, chunk));
    c.send(this.greetingText || `* OK [CAPABILITY ${this.caps.join(' ')}${this.starttls ? ' STARTTLS' : ''}] fake ready`);
  }

  onData(c, chunk) {
    c.buf = Buffer.concat([c.buf, chunk]);
    for (;;) {
      if (c.need) {
        if (c.buf.length < c.need) return;
        // A literal becomes a quoted string in the logged line, so LOGIN parsing sees one argument.
        c.line += `"${c.buf.subarray(0, c.need).toString('utf8').replace(/[\\"]/g, (x) => `\\${x}`)}"`;
        c.buf = c.buf.subarray(c.need);
        c.need = 0;
      }
      const lf = c.buf.indexOf(10);
      if (lf < 0) return;
      const part = c.buf.subarray(0, lf).toString('utf8').replace(/\r$/, '');
      c.buf = c.buf.subarray(lf + 1);
      const lit = /\{(\d+)(\+?)\}$/.exec(part);
      if (lit) {
        c.line += part.slice(0, lit.index);
        c.need = Number(lit[1]);
        if (!lit[2]) c.send('+ go ahead');
        continue;
      }
      const full = c.line + part;
      c.line = '';
      this.onLine(c, full);
    }
  }

  onLine(c, line) {
    this.log.push(line);
    if (c.pendingAuth) {
      const tag = c.pendingAuth;
      c.pendingAuth = null;
      this.checkPlain(c, tag, line);
      return;
    }
    if (c.idleTag) {
      if (line.trim().toUpperCase() === 'DONE') {
        c.send(`${c.idleTag} OK IDLE done`);
        c.idleTag = null;
      }
      return;
    }
    const m = /^(\S+) ([\s\S]*)$/.exec(line); // a literal may hold CRLFs (APPEND)
    if (!m) return;
    const [, tag, rest] = m;
    const [cmd0, ...args] = rest.split(' ');
    let cmd = cmd0.toUpperCase();
    let uidMode = false;
    let argv = args;
    if (cmd === 'UID') {
      uidMode = true;
      cmd = args[0].toUpperCase();
      argv = args.slice(1);
    }
    const ok = (t = 'done') => c.send(`${tag} OK ${t}`);
    switch (cmd) {
      case 'CAPABILITY':
        c.send(`* CAPABILITY ${this.caps.join(' ')}${this.starttls && !c.tls ? ' STARTTLS' : ''}`);
        return ok();
      case 'STARTTLS':
        c.tls = true;
        return ok('begin TLS');
      case 'LOGIN': {
        const vals = [...rest.slice(6).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((x) => (x[1] !== undefined ? x[1].replace(/\\(.)/g, '$1') : x[2]));
        return this.finishLogin(c, tag, vals[0], vals[1]);
      }
      case 'AUTHENTICATE':
        if (argv[1]) return this.checkPlain(c, tag, argv[1]);
        c.pendingAuth = tag;
        return c.send('+ ');
      case 'LIST':
        c.send('* LIST (\\HasNoChildren) "/" INBOX');
        for (const [name, box] of Object.entries(this.boxes)) c.send(`* LIST (${['\\HasNoChildren', ...box.flags].join(' ')}) "/" "${utf7.encode(name)}"`); // names in modified UTF-7, like real servers
        return ok();
      case 'STATUS': {
        // #80: STATUS "<raw>" (MESSAGES UIDNEXT UIDVALIDITY UNSEEN)
        const m = /^STATUS (?:"((?:[^"\\]|\\.)*)"|(\S+)) \(([^)]*)\)$/.exec(rest);
        if (!m) return c.send(`${tag} BAD status`);
        const raw = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
        const name = utf7.decode(raw);
        const inbox = name.toUpperCase() === 'INBOX';
        const box = inbox ? { messages: this.messages, uidValidity: this.uidValidity } : this.boxes[name];
        if (!box) return c.send(`${tag} NO no such mailbox`);
        this.statusCount = (this.statusCount || 0) + 1;
        const msgs = box.messages;
        const vals = {
          MESSAGES: msgs.length,
          UIDNEXT: Math.max(0, ...msgs.map((x) => x.uid || 0)) + 1,
          UIDVALIDITY: box.uidValidity ?? 7,
          UNSEEN: msgs.filter((x) => !(x.flags || []).includes('\\Seen')).length,
        };
        const items = m[3].split(' ').filter((k) => k in vals);
        c.send(`* STATUS "${raw}" (${items.map((k) => `${k} ${vals[k]}`).join(' ')})`);
        return ok('STATUS completed');
      }
      case 'APPEND': {
        const m = /^APPEND (?:"((?:[^"\\]|\\.)*)"|(\S+)) \(([^)]*)\) "([\s\S]*)"$/.exec(rest);
        if (!m) return c.send(`${tag} BAD append`);
        const name = utf7.decode(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
        const box = this.boxes[name];
        if (!box) return c.send(`${tag} NO [TRYCREATE] no such mailbox`);
        const raw = m[4].replace(/\\(.)/g, '$1');
        box.messages.push({ raw, flags: m[3].split(' ').filter(Boolean) });
        this.appends.push({ box: name, raw, flags: m[3] });
        return ok('APPEND completed');
      }
      case 'SELECT':
      case 'EXAMINE':
        if (!c.authed) return c.send(`${tag} NO not authenticated`);
        {
          const name = utf7.decode(argv.join(' ').replace(/^"(.*)"$/, '$1'));
          if (name.toUpperCase() !== 'INBOX') {
            const box = this.boxes[name];
            if (!box) return c.send(`${tag} NO no such mailbox`);
            c.box = name;
            c.selected = false;
            this.selects = (this.selects || 0) + 1;
            this.selectLog = [...(this.selectLog || []), name];
            c.send(`* ${box.messages.length} EXISTS`);
            c.send(`* OK [UIDVALIDITY ${box.uidValidity ?? 7}] ok`);
            return c.send(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] selected`);
          }
          c.box = null;
          this.selectLog = [...(this.selectLog || []), 'INBOX'];
        }
        c.selected = true;
        c.send(`* ${this.messages.length} EXISTS`);
        c.send('* FLAGS (\\Seen \\Flagged \\Answered \\Deleted)');
        c.send(`* OK [UIDVALIDITY ${this.uidValidity}] ok`);
        c.send(`* OK [UIDNEXT ${Math.max(0, ...this.messages.map((x) => x.uid)) + 1}] ok`);
        return c.send(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] selected`);
      case 'SEARCH':
        return this.search(c, tag, argv.join(' '));
      case 'FETCH':
        return this.fetch(c, tag, argv[0], argv.slice(1).join(' '), uidMode);
      case 'STORE':
        return this.store(c, tag, argv[0], argv[1], argv.slice(2).join(' '));
      case 'IDLE':
        c.idleTag = tag;
        return c.send('+ idling');
      case 'NOOP':
        return ok();
      case 'LOGOUT':
        c.send('* BYE bye');
        ok();
        return c.sock.end();
      default:
        return c.send(`${tag} BAD unknown ${cmd}`);
    }
  }

  checkPlain(c, tag, b64) {
    const [, u, p] = Buffer.from(b64, 'base64').toString('utf8').split('\0');
    this.finishLogin(c, tag, u, p);
  }

  finishLogin(c, tag, u, p) {
    this.logins++;
    this.lastLogin = { user: u, pass: p, tls: c.tls };
    if (this.failLogins || u !== this.user || p !== this.pass) return c.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
    c.authed = true;
    return c.send(`${tag} OK [CAPABILITY ${this.caps.join(' ')}] logged in`);
  }

  /** "1:5,7" or "3:*" against the sorted UIDs (uid) or sequence numbers. */
  pick(set, uidMode, msgs = this.messages) {
    const list = msgs.map((m, i) => ({ m, seq: i + 1 }));
    const max = uidMode ? Math.max(0, ...msgs.map((m) => m.uid)) : list.length;
    const out = new Set();
    for (const part of set.split(',')) {
      const [a, b] = part.split(':').map((x) => (x === '*' ? max : Number(x)));
      const lo = b === undefined ? a : Math.min(a, b);
      const hi = b === undefined ? a : Math.max(a, b);
      for (const x of list) {
        const key = uidMode ? x.m.uid : x.seq;
        if (key >= lo && key <= hi) out.add(x);
      }
      // "n:*" with n past the end still names the last message (RFC 3501)
      if (b !== undefined && list.length && ![...out].length && part.endsWith('*')) out.add(list[list.length - 1]);
    }
    return [...out].sort((x, y) => x.seq - y.seq);
  }

  search(c, tag, criteria) {
    const header = /^HEADER Message-ID "([^"]*)"$/i.exec(criteria);
    if (header && c.box) {
      const hits = this.boxes[c.box].messages.map((m, i) => (m.raw.includes(header[1]) ? i + 1 : 0)).filter(Boolean);
      c.send(`* SEARCH${hits.map((n) => ` ${n}`).join('')}`);
      return c.send(`${tag} OK search done`);
    }
    const ret = /RETURN \(COUNT\) (.*)$/i.exec(criteria);
    const crit = ret ? ret[1] : criteria;
    const msgs = this.msgsOf(c);
    let found = msgs;
    const uidRange = /^UID (\S+)$/i.exec(crit);
    if (uidRange) found = this.pick(uidRange[1], true, msgs).map((x) => x.m);
    else if (/^UNSEEN$/i.test(crit)) found = msgs.filter((m) => !m.flags.includes('\\Seen'));
    else if (/^FLAGGED$/i.test(crit)) found = msgs.filter((m) => m.flags.includes('\\Flagged'));
    if (ret) c.send(`* ESEARCH (TAG "${tag}") UID COUNT ${found.length}`);
    else c.send(`* SEARCH${found.map((m) => ` ${m.uid}`).join('')}`);
    c.send(`${tag} OK search done`);
  }

  envelope(m) {
    return `(${q(new Date(m.date).toUTCString())} ${q(m.subject)} ${addrList([m.from])} ${addrList([m.from])} NIL ${addrList(m.to)} ${addrList(m.cc)} NIL NIL ${q(m.messageId || `<m${m.uid}@x.test>`)})`;
  }

  fetch(c, tag, set, itemText, uidMode) {
    const items = itemText.replace(/^\(|\)$/g, '');
    for (const { m, seq } of this.pick(set, uidMode, this.msgsOf(c))) {
      const out = [`UID ${m.uid}`];
      if (/\bFLAGS\b/.test(items)) out.push(`FLAGS (${m.flags.join(' ')})`);
      if (/INTERNALDATE/.test(items)) out.push(`INTERNALDATE "${internalDate(m.date)}"`);
      if (/RFC822\.SIZE/.test(items)) out.push(`RFC822.SIZE ${m.size || 1234}`);
      if (/ENVELOPE/.test(items)) out.push(`ENVELOPE ${this.envelope(m)}`);
      if (/BODYSTRUCTURE/.test(items)) out.push(`BODYSTRUCTURE ${m.structure}`);
      for (const b of items.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/g)) {
        let data = m.parts[b[1]];
        if (data === undefined) data = '';
        data = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        if (b[2] !== undefined) data = data.subarray(Number(b[2]), Number(b[2]) + Number(b[3]));
        out.push(`BODY[${b[1]}]${b[2] !== undefined ? `<${b[2]}>` : ''} {${data.length}}\r\n${data.toString('latin1')}`);
      }
      c.sock.write(Buffer.from(`* ${seq} FETCH (${out.join(' ')})\r\n`, 'latin1'));
    }
    c.send(`${tag} OK fetch done`);
  }

  store(c, tag, set, op, flagText) {
    const flags = flagText.replace(/[()]/g, '').split(' ').filter(Boolean);
    for (const { m } of this.pick(set, true, this.msgsOf(c))) {
      if (op.startsWith('+')) m.flags = [...new Set([...m.flags, ...flags])];
      else m.flags = m.flags.filter((f) => !flags.includes(f));
    }
    c.send(`${tag} OK store done`);
  }
}

module.exports = { FakeImap, textMessage, altMessage, q, internalDate };
