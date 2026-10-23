// MIME decoding for the mail widget (#65): RFC 2047 encoded words, charsets, quoted-printable / base64,
// header and parameter parsing (RFC 2231), and the IMAP ENVELOPE / BODYSTRUCTURE shapes (RFC 3501 7.4.2).
// Charsets are decoded with TextDecoder (Electron's main process has full ICU: euc-kr, iso-2022-jp, ...).
const { str, bytesToText } = require('./imap-parser');

// Labels TextDecoder does not know, mapped to ones it does (cp949 is a superset of euc-kr in practice:
// the WHATWG "euc-kr" decoder is windows-949).
const ALIASES = {
  cp949: 'euc-kr',
  'ms949': 'euc-kr',
  'x-windows-949': 'euc-kr',
  uhc: 'euc-kr',
  'ks_c_5601': 'euc-kr',
  'ks_c_5601-1987': 'euc-kr',
  'euc_kr': 'euc-kr',
  utf8: 'utf-8',
  'x-unknown': 'utf-8',
  'unknown-8bit': 'utf-8',
  'us-ascii': 'utf-8', // ascii is a subset; 8-bit bytes in "us-ascii" mail are nearly always UTF-8
  ascii: 'utf-8',
  cp932: 'shift_jis',
  'x-sjis': 'shift_jis',
  'iso-8859-8-i': 'iso-8859-8',
};

const decoders = new Map();
/** A TextDecoder for a charset label; unknown labels fall back to UTF-8. */
function decoderFor(charset) {
  let label = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '').replace(/\*.*$/, '');
  label = ALIASES[label] || label;
  if (!decoders.has(label)) {
    let d;
    try {
      d = new TextDecoder(label);
    } catch {
      d = new TextDecoder('utf-8');
    }
    decoders.set(label, d);
  }
  return decoders.get(label);
}

function decodeCharset(buf, charset) {
  if (!buf || !buf.length) return '';
  if (!charset) return bytesToText(Buffer.from(buf));
  return decoderFor(charset).decode(buf);
}

/** Base64 to bytes, ignoring whitespace, padding and junk; a lone trailing character (cut-off fetch) is dropped. */
function decodeBase64(input) {
  const clean = String(Buffer.isBuffer(input) ? input.toString('latin1') : input).replace(/[^A-Za-z0-9+/]/g, '');
  return Buffer.from(clean.length % 4 === 1 ? clean.slice(0, -1) : clean, 'base64');
}

/** Quoted-printable body to bytes (soft line breaks removed; a cut-off "=X" at the end is dropped). */
function decodeQP(input) {
  const s = Buffer.isBuffer(input) ? input.toString('latin1') : String(input);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=') {
      if (s[i + 1] === '\r' && s[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (s[i + 1] === '\n') {
        i += 1;
        continue;
      }
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      if (i + 3 > s.length) break; // truncated escape at the end of a partial fetch
      out.push(0x3d);
      continue;
    }
    out.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

/** Content-Transfer-Encoding -> raw bytes. */
function decodeTransfer(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') return decodeBase64(buf);
  if (enc === 'quoted-printable') return decodeQP(buf);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'latin1');
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** RFC 2047 Q encoding (headers): "_" is a space. */
function decodeQWord(text) {
  return decodeQP(text.replace(/_/g, ' '));
}

/**
 * Decodes encoded words in a header value. Adjacent words (only whitespace between) are joined without that
 * whitespace, and the bytes of neighbouring words in the same charset are decoded together, since senders
 * split multi-byte characters across words.
 */
function decodeWords(value) {
  const s = String(value || '');
  if (!s.includes('=?')) return s;
  const pieces = []; // { text } or { charset, bytes }
  let last = 0;
  ENCODED_WORD.lastIndex = 0;
  let m;
  while ((m = ENCODED_WORD.exec(s))) {
    const between = s.slice(last, m.index);
    const prevWord = pieces.length && pieces[pieces.length - 1].bytes;
    if (between && !(prevWord && /^\s*$/.test(between))) pieces.push({ text: between });
    const bytes = m[2].toUpperCase() === 'B' ? decodeBase64(m[3]) : decodeQWord(m[3]);
    const charset = m[1].replace(/\*.*$/, '').toLowerCase();
    const prev = pieces[pieces.length - 1];
    if (prev && prev.bytes && prev.charset === charset) prev.bytes = Buffer.concat([prev.bytes, bytes]);
    else pieces.push({ charset, bytes });
    last = m.index + m[0].length;
  }
  if (last < s.length) pieces.push({ text: s.slice(last) });
  return pieces.map((p) => (p.bytes ? decodeCharset(p.bytes, p.charset) : p.text)).join('');
}

/** A raw header value (Buffer or string) -> decoded text. */
const headerText = (v) => decodeWords(Buffer.isBuffer(v) ? bytesToText(v) : str(v)).replace(/\s+/g, ' ').trim();

/** Raw header block -> Map(lower-case name -> [unfolded values]). */
function parseHeaders(raw) {
  const text = Buffer.isBuffer(raw) ? bytesToText(raw) : String(raw || '');
  const map = new Map();
  const lines = text.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (!line) {
      if (cur) break;
      continue;
    }
    if (/^[ \t]/.test(line) && cur) {
      cur.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    cur = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
    if (!map.has(cur.name)) map.set(cur.name, []);
    map.get(cur.name).push(cur);
  }
  return new Map([...map].map(([k, list]) => [k, list.map((x) => x.value)]));
}

/**
 * Parameters of a list like ("charset" "utf-8" "name*" "UTF-8''%ED%95%9C") or a header tail
 * '; name="a"; filename*0*=...' -> { name: 'decoded' }, with RFC 2231 continuations and charsets.
 */
function decodeParams(pairs) {
  const raw = {};
  for (const [k0, v] of pairs) {
    const k = String(k0).toLowerCase();
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(k);
    if (!m) continue;
    const [, name, index, star] = m;
    (raw[name] ||= []).push({ index: index === undefined ? -1 : Number(index), star: Boolean(star), value: String(v) });
  }
  const out = {};
  for (const [name, parts] of Object.entries(raw)) {
    parts.sort((a, b) => a.index - b.index);
    const plain = parts.find((p) => p.index === -1 && !p.star);
    if (parts.every((p) => !p.star) && plain) {
      out[name] = decodeWords(plain.value);
      continue;
    }
    let charset = 'utf-8';
    const bytes = [];
    for (const [i, p] of parts.filter((x) => x.index >= 0 || x.star).entries()) {
      let v = p.value;
      if (p.star && i === 0) {
        const q = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (q) {
          charset = q[1] || charset;
          v = q[2];
        }
      }
      if (p.star) {
        for (let j = 0; j < v.length; j++) {
          if (v[j] === '%' && /^[0-9A-Fa-f]{2}$/.test(v.slice(j + 1, j + 3))) {
            bytes.push(parseInt(v.slice(j + 1, j + 3), 16));
            j += 2;
          } else bytes.push(v.charCodeAt(j) & 0xff);
        }
      } else for (const ch of Buffer.from(v, 'utf8')) bytes.push(ch);
    }
    out[name] = decodeCharset(Buffer.from(bytes), charset);
  }
  return out;
}

/** 'text/html; charset="utf-8"' -> { value: 'text/html', params: { charset: 'utf-8' } } */
function parseHeaderParams(value) {
  const s = String(value || '');
  const parts = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== '\\') quoted = !quoted;
    if (c === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  const pairs = [];
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    pairs.push([p.slice(0, eq).trim(), p.slice(eq + 1).trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1')]);
  }
  return { value: parts[0].trim().toLowerCase(), params: decodeParams(pairs) };
}

// ---- IMAP ENVELOPE / BODYSTRUCTURE ----

/** One address list of an ENVELOPE -> [{ name, address }] (group markers skipped). */
function addresses(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!Array.isArray(a)) continue;
    const mailbox = str(a[2]);
    const host = str(a[3]);
    if (!mailbox || !host) continue; // group start / end
    out.push({ name: headerText(a[0]), address: `${mailbox}@${host}`.toLowerCase() });
  }
  return out;
}

/** ENVELOPE list -> plain object. */
function parseEnvelope(env) {
  if (!Array.isArray(env)) return null;
  const date = Date.parse(str(env[0]));
  return {
    date: Number.isFinite(date) ? date : null,
    subject: headerText(env[1]),
    from: addresses(env[2]),
    sender: addresses(env[3]),
    replyTo: addresses(env[4]),
    to: addresses(env[5]),
    cc: addresses(env[6]),
    bcc: addresses(env[7]),
    inReplyTo: str(env[8]).trim(),
    messageId: str(env[9]).trim(),
  };
}

const pairsOf = (list) => {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i + 1 < list.length; i += 2) out.push([str(list[i]), str(list[i + 1])]);
  return out;
};

function disposition(v) {
  if (!Array.isArray(v)) return null;
  return { type: str(v[0]).toLowerCase(), params: decodeParams(pairsOf(v[1])) };
}

/**
 * BODYSTRUCTURE -> tree { type, subtype, params, id, encoding, size, disposition, part, children? }.
 * part is the section number ("1", "2.1"); a single-part message's body is "TEXT" for fetching.
 */
function parseBodyStructure(bs, path = '') {
  if (!Array.isArray(bs)) return null;
  if (Array.isArray(bs[0])) {
    const children = [];
    let i = 0;
    while (Array.isArray(bs[i])) {
      children.push(parseBodyStructure(bs[i], path ? `${path}.${i + 1}` : String(i + 1)));
      i++;
    }
    return {
      type: 'multipart',
      subtype: str(bs[i]).toLowerCase(),
      params: decodeParams(pairsOf(bs[i + 1])),
      disposition: disposition(bs[i + 2]),
      part: path,
      children,
    };
  }
  const type = str(bs[0]).toLowerCase();
  const subtype = str(bs[1]).toLowerCase();
  const node = {
    type,
    subtype,
    params: decodeParams(pairsOf(bs[2])),
    id: str(bs[3]).replace(/^<|>$/g, ''),
    description: headerText(bs[4]),
    encoding: str(bs[5]).toLowerCase(),
    size: Number(str(bs[6])) || 0,
    part: path || '1',
    disposition: null,
  };
  // Extension fields sit after type-specific ones: text has lines, message/rfc822 has envelope, body, lines.
  let ext = 7;
  if (type === 'text') ext = 8;
  else if (type === 'message' && subtype === 'rfc822') {
    node.envelope = parseEnvelope(bs[7]);
    ext = 10;
  }
  node.disposition = disposition(bs[ext + 1]);
  node.root = !path;
  return node;
}

/** Every leaf part of a tree, in order. */
function leaves(node, out = []) {
  if (!node) return out;
  if (node.children) for (const c of node.children) leaves(c, out);
  else out.push(node);
  return out;
}

const fileName = (p) => p.disposition?.params?.filename || p.params?.name || '';

/** Whether a leaf is an attachment (listed by name and size; not downloaded in this version). */
function isAttachment(p) {
  if (p.type === 'multipart') return false;
  if (p.disposition?.type === 'attachment') return true;
  if (p.type === 'message' && p.subtype === 'rfc822') return true;
  if (p.type === 'text' && (p.subtype === 'plain' || p.subtype === 'html') && !fileName(p)) return false;
  if (p.type === 'image' && p.id && p.disposition?.type !== 'attachment') return false; // inline (cid:) image
  return Boolean(fileName(p)) || !['text', 'multipart'].includes(p.type);
}

function attachments(tree) {
  return leaves(tree)
    .filter(isAttachment)
    .map((p) => ({
      name: fileName(p) || (p.type === 'message' ? `${p.envelope?.subject || '첨부 메일'}.eml` : `${p.type}-${p.subtype}`),
      size: p.encoding === 'base64' ? Math.floor((p.size * 3) / 4) : p.size,
      type: `${p.type}/${p.subtype}`,
    }));
}

/**
 * The parts to show: in multipart/alternative the richest (html over plain), in mixed / related every inline
 * text part in order, and the cid: images of a related html. Returns { html: [parts], text: [parts], images }.
 */
function displayParts(tree) {
  const html = [];
  const text = [];
  const images = [];
  function walk(node) {
    if (!node) return;
    if (node.children) {
      if (node.subtype === 'alternative') {
        const pick = [...node.children].reverse().find((c) => c.children || (c.type === 'text' && (c.subtype === 'html' || c.subtype === 'plain')));
        const plain = node.children.find((c) => c.type === 'text' && c.subtype === 'plain');
        if (pick) walk(pick);
        if (plain && pick !== plain) text.push(plain); // the plain version for the text preview and snippets
        return;
      }
      for (const c of node.children) walk(c);
      return;
    }
    if (isAttachment(node)) return;
    if (node.type === 'text' && node.subtype === 'html') html.push(node);
    else if (node.type === 'text') text.push(node);
    else if (node.type === 'image' && node.id) images.push(node);
  }
  walk(tree);
  return { html, text, images };
}

/** The part a list snippet is cut from: the first plain text part, else the first html part. */
function snippetPart(tree) {
  const { html, text } = displayParts(tree);
  return text[0] || html[0] || null;
}

/** IMAP section name for fetching a leaf (a single-part message's body is TEXT). */
const sectionOf = (p) => (p.root ? 'TEXT' : p.part);

/** A fetched leaf's bytes -> text in its charset. */
function partText(p, raw) {
  return decodeCharset(decodeTransfer(raw, p.encoding), p.params?.charset);
}

module.exports = {
  decodeCharset,
  decoderFor,
  decodeBase64,
  decodeQP,
  decodeTransfer,
  decodeWords,
  headerText,
  parseHeaders,
  parseHeaderParams,
  decodeParams,
  parseEnvelope,
  parseBodyStructure,
  leaves,
  attachments,
  displayParts,
  snippetPart,
  sectionOf,
  partText,
  isAttachment,
};
