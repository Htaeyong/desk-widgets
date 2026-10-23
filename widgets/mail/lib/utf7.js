// IMAP modified UTF-7 mailbox names (RFC 3501 5.1.3): "&" starts base64 of UTF-16BE with "," for "/",
// "-" ends it, "&-" is a literal "&". The widget reads INBOX by default; folder names come in this form.

function decode(name) {
  return String(name).replace(/&([^-]*)-/g, (_m, b64) => {
    if (!b64) return '&';
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

function encode(name) {
  let out = '';
  let pending = '';
  const flush = () => {
    if (!pending) return;
    const buf = Buffer.alloc(pending.length * 2);
    for (let i = 0; i < pending.length; i++) buf.writeUInt16BE(pending.charCodeAt(i), i * 2);
    out += `&${buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    pending = '';
  };
  for (const ch of String(name)) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else pending += ch; // astral characters stay as their UTF-16 surrogate pair
  }
  flush();
  return out;
}

module.exports = { decode, encode };
