// Writing mail is not done in the widget (#65): 새 메일 / 답장 / 전달 hand off to the PC's mail program
// (a mailto: link, RFC 6068) or to the account's webmail. Pure functions (unit-tested).

// Windows hands mailto: links to the mail program through the shell; some programs (Outlook classic) cut or
// refuse links longer than about 2,000 characters, so the quoted body shrinks to fit.
const MAX_MAILTO = 2000;
const ADDRESS = /^[^\s@<>()[\]\\,;:"?&%#/]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const isAddress = (a) => ADDRESS.test(String(a || ''));

/** RFC 6068 value encoding: UTF-8 percent-encoding, spaces as %20, line breaks as %0D%0A. */
const enc = (s) => encodeURIComponent(String(s).replace(/\r?\n/g, '\r\n'));
const encAddr = (a) => encodeURIComponent(a).replace(/%40/g, '@');

/** mailto: with to (one address or a list), subject, body (cut to fit MAX_MAILTO, with "…" when cut). */
function buildMailto({ to = [], cc = [], subject = '', body = '' } = {}) {
  const toList = (Array.isArray(to) ? to : [to]).filter(isAddress);
  const ccList = (Array.isArray(cc) ? cc : [cc]).filter(isAddress);
  const head = `mailto:${toList.map(encAddr).join(',')}`;
  const params = [];
  if (ccList.length) params.push(`cc=${ccList.map(encAddr).join(',')}`);
  if (subject) params.push(`subject=${enc(String(subject).slice(0, 300))}`);
  const base = `${head}${params.length ? `?${params.join('&')}` : ''}`;
  if (!body) return base;
  const sep = params.length ? '&' : '?';
  let text = String(body);
  let url = `${base}${sep}body=${enc(text)}`;
  if (url.length <= MAX_MAILTO) return url;
  // Shrink by characters until the encoded link fits (binary search, each step re-encodes).
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (`${base}${sep}body=${enc(`${text.slice(0, mid)}…`)}`.length <= MAX_MAILTO) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return base.length <= MAX_MAILTO ? base : head;
  text = `${text.slice(0, lo)}…`;
  url = `${base}${sep}body=${enc(text)}`;
  return url;
}

const prefixed = (prefix, subject) => {
  const s = String(subject || '').trim();
  return new RegExp(`^${prefix}:`, 'i').test(s) ? s : `${prefix}: ${s}`;
};

const formatDate = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const person = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');

/** The quoted original for a reply / forward body (plain text, short). */
function quoted(msg, text, maxChars = 1200) {
  const lines = String(text || '').replace(/\r\n/g, '\n').slice(0, maxChars).split('\n').map((l) => `> ${l}`);
  return `\n\n${formatDate(msg.date)}, ${person(msg.from)} 작성:\n${lines.join('\n')}`;
}

/**
 * The handoff link for an action: 'compose' | 'reply' | 'replyAll' | 'forward'.
 * msg: header (from, to, cc, replyTo, subject, date); text: the plain text of the message (for the quote);
 * self: the account's own address (left out of reply-all).
 */
function mailtoFor(action, { msg = null, text = '', self = '', to = '' } = {}) {
  if (action === 'compose') return buildMailto({ to: to ? [to] : [] });
  if (!msg) return buildMailto({});
  const own = String(self || '').toLowerCase();
  if (action === 'forward') {
    const head = `\n\n---------- 전달된 메일 ----------\n보낸 사람: ${person(msg.from)}\n날짜: ${formatDate(msg.date)}\n제목: ${msg.subject || ''}\n\n`;
    return buildMailto({ subject: prefixed('Fwd', msg.subject), body: `${head}${String(text || '').slice(0, 1200)}` });
  }
  const replyTo = (msg.replyTo && msg.replyTo.length ? msg.replyTo : [msg.from]).filter(Boolean).map((a) => a.address);
  let cc = [];
  if (action === 'replyAll') {
    const seen = new Set([...replyTo, own].map((a) => String(a).toLowerCase()));
    cc = [...(msg.to || []), ...(msg.cc || [])].map((a) => a.address).filter((a) => {
      const k = String(a).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return buildMailto({ to: replyTo, cc, subject: prefixed('Re', msg.subject), body: quoted(msg, text) });
}

/** Gmail can open its own compose page with the fields filled; other webmails open at their start page. */
function webmailFor(account, action, { msg = null, to = '' } = {}) {
  const base = account.webmail || '';
  if (!base) return '';
  if (account.provider === 'gmail') {
    if (action === 'compose' || action === 'reply' || action === 'replyAll' || action === 'forward') {
      const params = new URLSearchParams({ view: 'cm', fs: '1' });
      if (action === 'compose' && isAddress(to)) params.set('to', to);
      if (msg && action !== 'compose') {
        if (action !== 'forward') {
          const target = (msg.replyTo && msg.replyTo.length ? msg.replyTo : [msg.from]).filter(Boolean).map((a) => a.address).filter(isAddress);
          if (target.length) params.set('to', target.join(','));
        }
        params.set('su', action === 'forward' ? prefixed('Fwd', msg.subject) : prefixed('Re', msg.subject));
      }
      return `https://mail.google.com/mail/?${params.toString()}`;
    }
    if (action === 'open' && msg?.messageId) {
      // Gmail search by Message-ID ("rfc822msgid:") finds that exact message.
      return `https://mail.google.com/mail/#search/${encodeURIComponent(`rfc822msgid:${msg.messageId.replace(/^<|>$/g, '')}`)}`;
    }
  }
  return base;
}

// ---- the widget's own composer (#68) ----

const MAX_QUOTE = 200000; // characters of the original quoted in the composer

/** Who a reply goes to: Reply-To or From; reply all adds To / Cc without the own address and duplicates. */
function replyRecipients(action, msg, self = '') {
  const own = String(self || '').toLowerCase();
  const to = (msg.replyTo && msg.replyTo.length ? msg.replyTo : [msg.from]).filter((a) => a && isAddress(a.address));
  if (action !== 'replyAll') return { to, cc: [] };
  const seen = new Set([...to.map((a) => a.address.toLowerCase()), own]);
  const cc = [...(msg.to || []), ...(msg.cc || [])].filter((a) => {
    const k = String(a?.address || '').toLowerCase();
    if (!isAddress(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { to: to.filter((a) => a.address.toLowerCase() !== own || to.length === 1), cc };
}

/** "이름 <주소>" text for the composer's address fields. */
const addressText = (list) => list.map((a) => (a.name ? `${a.name.replace(/[<>,;"]/g, ' ').trim()} <${a.address}>` : a.address)).join(', ');

const withSignature = (signature) => (signature ? `\n\n-- \n${signature}` : '');

/**
 * The composer's starting body: an empty line to write in, the signature, then the quote.
 * reply: "2026-10-19 14:05, 김부장 <boss@x> 님이 작성:" + "> " lines; forward: a header block + the text.
 */
function composeBody(action, { msg = null, text = '', signature = '' } = {}) {
  const sig = withSignature(signature);
  if (!msg || action === 'compose') return `\n${sig}`;
  const original = String(text || '').replace(/\r\n/g, '\n').slice(0, MAX_QUOTE);
  if (action === 'forward') {
    const head = ['---------- 전달된 메일 ----------', `보낸 사람: ${person(msg.from)}`, `날짜: ${formatDate(msg.date)}`, `제목: ${msg.subject || ''}`, `받는 사람: ${(msg.to || []).map(person).join(', ')}`];
    if (msg.cc?.length) head.push(`참조: ${msg.cc.map(person).join(', ')}`);
    return `\n${sig}\n\n${head.join('\n')}\n\n${original}`;
  }
  const lines = original.split('\n').map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`));
  return `\n${sig}\n\n${formatDate(msg.date)}, ${person(msg.from)} 님이 작성:\n${lines.join('\n')}`;
}

module.exports = { buildMailto, mailtoFor, webmailFor, isAddress, MAX_MAILTO, quoted, prefixed, replyRecipients, addressText, composeBody };
