// IMAP4rev1 response parsing (RFC 3501), written for the mail widget (#65): the package has no node_modules.
// Two layers: ResponseReader cuts the byte stream into whole responses (a response may carry literals
// "{n}\r\n<n bytes>" with CRLFs inside), parseResponse turns one response into a plain object.
// Strings stay Buffers until a caller decodes them (header bytes may be 8-bit in any charset).

const CR = 13;
const LF = 10;
const MAX_RESPONSE = 64 * 1024 * 1024; // one response may hold a message body; beyond this the server is wrong

/** Splits incoming bytes into complete responses (Buffers without the final CRLF). */
class ResponseReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.pos = 0; // where the next CRLF search starts within the response being collected
    this.need = 0; // literal bytes still to skip before looking for a CRLF again
  }

  /** Feeds bytes; returns the responses completed by them. */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      if (this.need) {
        if (this.buf.length - this.pos < this.need) {
          this.need -= this.buf.length - this.pos;
          this.pos = this.buf.length;
          break;
        }
        this.pos += this.need;
        this.need = 0;
      }
      const lf = this.buf.indexOf(LF, this.pos);
      if (lf < 0) {
        this.pos = this.buf.length;
        if (this.buf.length > MAX_RESPONSE) throw new Error('IMAP response too large');
        break;
      }
      const lineEnd = lf > 0 && this.buf[lf - 1] === CR ? lf - 1 : lf;
      // A literal announcement at the end of the line: {123} or {123+}
      const m = /\{(\d+)\+?\}$/.exec(this.buf.toString('latin1', Math.max(this.pos, lineEnd - 24), lineEnd));
      if (m) {
        this.need = Number(m[1]);
        this.pos = lf + 1;
        continue;
      }
      out.push(this.buf.subarray(0, lineEnd));
      this.buf = this.buf.subarray(lf + 1);
      this.pos = 0;
    }
    return out;
  }
}

/** Tokenizer over one response. Values: string atoms, Buffer strings (quoted / literal), null (NIL), arrays (lists). */
class Cursor {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  eof() {
    return this.pos >= this.buf.length;
  }

  peek() {
    return this.buf[this.pos];
  }

  skipSpaces() {
    while (this.buf[this.pos] === 32) this.pos++;
  }

  /** Reads until a space or the end (raw text, for tags and status words). */
  word() {
    const start = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos] !== 32) this.pos++;
    return this.buf.toString('latin1', start, this.pos);
  }

  rest() {
    const s = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return s;
  }

  quoted() {
    this.pos++; // opening quote
    const bytes = [];
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++];
      if (c === 0x5c && this.pos < this.buf.length) bytes.push(this.buf[this.pos++]);
      else if (c === 0x22) return Buffer.from(bytes);
      else bytes.push(c);
    }
    throw new Error('unterminated quoted string');
  }

  literal() {
    const close = this.buf.indexOf(0x7d, this.pos); // }
    if (close < 0) throw new Error('bad literal');
    const n = Number(this.buf.toString('latin1', this.pos + 1, close).replace('+', ''));
    let start = close + 1;
    if (this.buf[start] === CR) start++;
    if (this.buf[start] === LF) start++;
    if (!Number.isFinite(n) || start + n > this.buf.length) throw new Error('literal past the end of the response');
    this.pos = start + n;
    return this.buf.subarray(start, start + n);
  }

  /**
   * An atom. A FETCH key like BODY[HEADER.FIELDS (A B)]<0> keeps its bracket part (spaces included) and the
   * partial suffix, so "BODY[1]<0>" comes back as one atom.
   */
  atom() {
    const start = this.pos;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];
      if (c === 0x5b) {
        // [
        const close = this.buf.indexOf(0x5d, this.pos);
        this.pos = close < 0 ? this.buf.length : close + 1;
        if (this.buf[this.pos] === 0x3c) {
          // <
          const gt = this.buf.indexOf(0x3e, this.pos);
          this.pos = gt < 0 ? this.buf.length : gt + 1;
        }
        continue;
      }
      if (c === 32 || c === 0x28 || c === 0x29 || c === 0x22 || c === 0x7b) break; // space ( ) " {
      this.pos++;
    }
    if (this.pos === start) throw new Error(`unexpected byte ${this.buf[this.pos]} at ${this.pos}`);
    return this.buf.toString('latin1', start, this.pos);
  }

  value() {
    this.skipSpaces();
    const c = this.peek();
    if (c === 0x28) return this.list();
    if (c === 0x22) return this.quoted();
    if (c === 0x7b) return this.literal();
    const a = this.atom();
    return a.toUpperCase() === 'NIL' ? null : a;
  }

  list() {
    this.pos++; // (
    const out = [];
    for (;;) {
      this.skipSpaces();
      if (this.eof()) throw new Error('unterminated list');
      if (this.peek() === 0x29) {
        this.pos++;
        return out;
      }
      out.push(this.value());
    }
  }

  /** All remaining values. */
  values() {
    const out = [];
    for (;;) {
      this.skipSpaces();
      if (this.eof()) return out;
      out.push(this.value());
    }
  }
}

const STATUS = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);

/** "[CODE args] text" of a status response. */
function respText(cur) {
  cur.skipSpaces();
  let code = null;
  if (cur.peek() === 0x5b) {
    const close = cur.buf.indexOf(0x5d, cur.pos);
    const inner = cur.buf.subarray(cur.pos + 1, close < 0 ? cur.buf.length : close);
    cur.pos = close < 0 ? cur.buf.length : close + 1;
    const c = new Cursor(inner);
    const name = c.word().toUpperCase();
    let args = [];
    try {
      args = c.values();
    } catch {
      args = [];
    }
    code = { name, args };
  }
  cur.skipSpaces();
  return { code, text: cur.rest().toString('utf8') };
}

/** Pairs a FETCH attribute list into an object keyed by upper-case names (BODY[1]<0> as is). */
function fetchAttrs(list) {
  const out = {};
  for (let i = 0; i + 1 < (list || []).length; i += 2) {
    const key = String(list[i]).toUpperCase();
    out[key.replace(/^BODY\.PEEK/, 'BODY')] = list[i + 1];
  }
  return out;
}

/**
 * One response -> { tag, type, ... }:
 *  continuation: { tag: '+', type: 'CONTINUE', text }
 *  status (tagged or untagged): { tag, type: 'OK'|'NO'|'BAD'|'BYE'|'PREAUTH', code, text }
 *  numbered untagged: { tag: '*', type: 'EXISTS'|'RECENT'|'EXPUNGE'|'FETCH', num, attrs? }
 *  other untagged: { tag: '*', type: 'CAPABILITY'|'SEARCH'|'FLAGS'|'LIST'|'STATUS'|'ESEARCH'|..., values }
 */
function parseResponse(buf) {
  const cur = new Cursor(buf);
  const tag = cur.word();
  cur.skipSpaces();
  if (tag === '+') return { tag, type: 'CONTINUE', text: cur.rest().toString('utf8') };
  const second = cur.word();
  const upper = second.toUpperCase();
  if (STATUS.has(upper)) return { tag, type: upper, ...respText(cur) };
  if (tag === '*' && /^\d+$/.test(second)) {
    cur.skipSpaces();
    const type = cur.word().toUpperCase();
    const res = { tag, type, num: Number(second) };
    if (type === 'FETCH') res.attrs = fetchAttrs(cur.value());
    return res;
  }
  return { tag, type: upper, values: cur.values() };
}

// ---- value helpers ----

const isBuf = (v) => Buffer.isBuffer(v);

/** Bytes of a header value -> text: UTF-8 when valid, else EUC-KR (old Korean mail without encoded words). */
function bytesToText(buf) {
  if (!buf.some((b) => b > 0x7f)) return buf.toString('latin1');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

/** Any parsed value -> string ('' for NIL). */
const str = (v) => (v === null || v === undefined ? '' : isBuf(v) ? bytesToText(v) : Array.isArray(v) ? '' : String(v));

/** Numbers of an untagged SEARCH (or ESEARCH ALL) answer. */
function searchNumbers(res) {
  if (res.type === 'SEARCH') return res.values.map(Number).filter(Number.isFinite);
  return [];
}

/** ESEARCH "(TAG "A1") UID COUNT 3" -> { COUNT: 3, ... } */
function esearch(res) {
  const out = {};
  const vals = res.values || [];
  for (let i = 0; i < vals.length; i++) {
    if (Array.isArray(vals[i])) continue;
    const key = String(vals[i]).toUpperCase();
    if (key === 'UID') continue;
    out[key] = str(vals[i + 1]);
    i++;
  }
  return out;
}

/** "1:3,7,9:10" -> [1,2,3,7,9,10] (bounded; used for ESEARCH ALL). */
function expandSet(set, max = 100000) {
  const out = [];
  for (const part of String(set || '').split(',')) {
    const [a, b] = part.split(':').map(Number);
    if (!Number.isFinite(a)) continue;
    const lo = Number.isFinite(b) ? Math.min(a, b) : a;
    const hi = Number.isFinite(b) ? Math.max(a, b) : a;
    for (let n = lo; n <= hi && out.length < max; n++) out.push(n);
  }
  return out;
}

/** UIDs -> a compact set "1:3,7". */
function compactSet(uids) {
  const sorted = [...new Set(uids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j;
  }
  return parts.join(',');
}

module.exports = { ResponseReader, Cursor, parseResponse, fetchAttrs, bytesToText, str, searchNumbers, esearch, expandSet, compactSet };
