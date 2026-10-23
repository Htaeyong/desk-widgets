// Building outgoing mail (#68): RFC 5322 headers with RFC 2047 encoded words for Korean names / subjects,
// a UTF-8 text body in quoted-printable (or 7bit when plain ASCII with short lines), multipart/mixed for
// attachments with RFC 2231 file names and base64, Message-ID on the sender's domain, CRLF and line
// lengths kept within RFC limits. Pure functions (unit-tested).
const crypto = require('crypto');

const { parseAddresses, ADDRESS } = require('../composer/addresses');

const CRLF = '\r\n';

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 B-encoded words (UTF-8), split at character boundaries so each word stays under 75 chars. */
function encodeWords(text) {
  const s = String(text);
  if (isAscii(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    // 39 bytes -> 52 base64 characters: "Subject: " + one word stays under 78.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 39) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

/** One address for a header: ASCII names quoted when needed, others encoded. */
function formatAddress({ name, address }) {
  if (!name) return address;
  const n = isAscii(name) ? (/[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name) : encodeWords(name);
  return `${n} <${address}>`;
}

/** Folds a header (already encoded) so no line is longer than 78 characters where it can break. */
function header(name, value) {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || value.includes(CRLF)) return line;
  const out = [];
  let cur = `${name}:`;
  for (const token of value.split(/(?<=,) /)) {
    if (cur.length + token.length + 1 > 78 && cur !== `${name}:`) {
      out.push(cur);
      cur = ` ${token}`;
    } else cur += ` ${token}`;
  }
  out.push(cur);
  return out.join(CRLF);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** RFC 5322 date in the PC's time zone: "Mon, 19 Oct 2026 14:05:00 +0900". */
function formatDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

/** Quoted-printable (RFC 2045) of UTF-8 text with CRLF line ends, lines at most 76 characters. */
function encodeQP(text) {
  const lines = String(text).replace(/\r?\n/g, '\n').split('\n');
  return lines
    .map((line) => {
      const bytes = Buffer.from(line, 'utf8');
      let out = '';
      let cur = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        const last = i === bytes.length - 1;
        let enc;
        if ((b === 0x20 || b === 0x09) && last) enc = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
        else if ((b >= 33 && b <= 126 && b !== 61) || b === 0x20 || b === 0x09) enc = String.fromCharCode(b);
        else enc = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
        // A leading "." or "From " is safe through SMTP (dot-stuffing) but encode "." at line start anyway.
        if (cur === '' && b === 0x2e) enc = '=2E';
        if (cur.length + enc.length > 75) {
          out += `${cur}=${CRLF}`;
          cur = '';
        }
        cur += enc;
      }
      return out + cur;
    })
    .join(CRLF);
}

const base64Lines = (buf) => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64').replace(/.{1,76}/g, (l) => `${l}${CRLF}`);

/** RFC 2231 parameter value (UTF-8''percent) plus an RFC 2047 fallback for old readers. */
function fileParams(kind, name) {
  const safe = String(name || 'file').replace(/[\r\n"\\/]/g, '_').slice(0, 200);
  if (isAscii(safe)) return `${kind}="${safe}"`;
  const pct = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}*=UTF-8''${pct}`;
}

const MIME_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', hwp: 'application/x-hwp', eml: 'message/rfc822' };
const typeOf = (name, given) => (given && /^[a-z]+\/[a-z0-9.+-]+$/i.test(given) ? given : MIME_TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream');

/** A Message-ID on the sender's domain. */
const newMessageId = (from) => `<${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}@${String(from).split('@')[1] || 'desk-widgets.invalid'}>`;

/**
 * The whole message as bytes. msg: { from: {name,address}, to, cc, bcc (not written), subject, text,
 * inReplyTo, references: [ids], attachments: [{ name, type?, data: Buffer }], date?, messageId? }.
 * Returns { raw: Buffer, messageId, recipients: [addresses incl. Bcc] }.
 */
function buildMessage(msg) {
  const date = msg.date || Date.now();
  const messageId = msg.messageId || newMessageId(msg.from.address);
  const lines = [];
  lines.push(header('From', formatAddress(msg.from)));
  if (msg.to?.length) lines.push(header('To', msg.to.map(formatAddress).join(', ')));
  if (msg.cc?.length) lines.push(header('Cc', msg.cc.map(formatAddress).join(', ')));
  lines.push(`Subject: ${encodeWords(String(msg.subject || '').replace(/[\r\n]+/g, ' '))}`);
  lines.push(`Date: ${formatDate(date)}`);
  lines.push(`Message-ID: ${messageId}`);
  if (msg.inReplyTo) lines.push(`In-Reply-To: ${msg.inReplyTo}`);
  const refs = [...new Set([...(msg.references || []), ...(msg.inReplyTo ? [msg.inReplyTo] : [])])].filter((r) => /^<[^<>\s]+>$/.test(r)).slice(-20);
  if (refs.length) lines.push(header('References', refs.join(' ')).replace(/\r\n /g, '\r\n '));
  lines.push('MIME-Version: 1.0');
  lines.push('X-Mailer: Desk Widgets Mail');
  const text = String(msg.text || '');
  const simple = isAscii(text.replace(/\r?\n/g, '')) && text.split(/\r?\n/).every((l) => l.length <= 76 && !/^\./.test(l));
  const bodyHead = ['Content-Type: text/plain; charset=utf-8', `Content-Transfer-Encoding: ${simple ? '7bit' : 'quoted-printable'}`];
  const bodyText = simple ? text.replace(/\r?\n/g, CRLF) : encodeQP(text);
  const files = msg.attachments || [];
  let body;
  if (!files.length) {
    lines.push(...bodyHead);
    body = `${lines.join(CRLF)}${CRLF}${CRLF}${bodyText}${CRLF}`;
  } else {
    const boundary = `----=_DW_${crypto.randomBytes(12).toString('hex')}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [`${bodyHead.join(CRLF)}${CRLF}${CRLF}${bodyText}${CRLF}`];
    for (const f of files) {
      const type = typeOf(f.name, f.type);
      parts.push(
        [`Content-Type: ${type}; ${fileParams('name', f.name)}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; ${fileParams('filename', f.name)}`].join(CRLF) +
          CRLF +
          CRLF +
          base64Lines(f.data),
      );
    }
    body = `${lines.join(CRLF)}${CRLF}${CRLF}This is a multi-part message in MIME format.${CRLF}${parts.map((p) => `--${boundary}${CRLF}${p}`).join('')}--${boundary}--${CRLF}`;
  }
  const recipients = [...new Set([...(msg.to || []), ...(msg.cc || []), ...(msg.bcc || [])].map((a) => a.address.toLowerCase()))];
  return { raw: Buffer.from(body, 'utf8'), messageId, recipients };
}

module.exports = { buildMessage, parseAddresses, encodeWords, formatAddress, formatDate, encodeQP, fileParams, newMessageId, typeOf, ADDRESS };
