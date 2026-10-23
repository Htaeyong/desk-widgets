// Sending one message from the widget (#68): build the MIME message, submit it over SMTP with the
// account's own login, then keep a copy in the account's Sent folder (IMAP APPEND) unless the server
// already did (Gmail stores what its SMTP sends; others are checked by Message-ID first, so no duplicate).
const { SmtpClient } = require('./smtp-client');
const { ImapClient, quote } = require('./imap-client');
const { buildMessage } = require('./mime-build');

// Mailbox names used for sent mail when the server does not mark one \Sent (RFC 6154 SPECIAL-USE).
const SENT_NAMES = ['sent', 'sent messages', 'sent items', 'sent mail', 'sent-mail', '보낸메일함', '보낸편지함', '보낸 메일함', '보낸 편지함', '보낸메일', '보낸 메일', '[gmail]/sent mail', 'inbox.sent', 'inbox/sent'];

/** The Sent folder among LIST results: the \Sent flag first, then well-known names. */
function findSent(boxes) {
  const flagged = boxes.find((b) => b.flags.some((f) => f.toLowerCase() === '\\sent'));
  if (flagged) return flagged;
  const norm = (n) => n.toLowerCase().trim();
  for (const name of SENT_NAMES) {
    const hit = boxes.find((b) => norm(b.name) === name || norm(b.name.split(b.delimiter || '/').pop()) === name);
    if (hit) return hit;
  }
  return null;
}

/** Whether a copy should go to Sent: 'off' never, 'on' always (still checked for duplicates), 'auto': not for Gmail. */
const shouldSave = (account) => (account.saveSent === 'off' ? false : account.saveSent === 'on' ? true : account.provider !== 'gmail');

/**
 * Puts a sent message into the Sent folder over a separate short IMAP connection (the INBOX connection
 * stays as it is). Waits a little first and skips the copy when the server already filed that Message-ID.
 */
async function saveToSent({ account, password, raw, messageId, deps = {}, waitMs = 3000 }) {
  const client = new ImapClient({ host: account.host, port: account.port, security: account.security, username: account.username, password, deps: deps.imap || {} });
  try {
    await client.open();
    const box = findSent(await client.list());
    if (!box) return { saved: false, reason: '보낸편지함을 찾지 못했습니다.' };
    if (waitMs) await new Promise((r) => (deps.setTimeout || setTimeout)(r, waitMs));
    await client.select(box.name, { readOnly: true });
    const q = quote(messageId);
    const found = typeof q === 'string' ? await client.uidSearch(`HEADER Message-ID ${q}`) : [];
    if (found.length) return { saved: false, already: true, box: box.name };
    await client.append(box.raw, ['\\Seen'], raw);
    return { saved: true, box: box.name };
  } finally {
    client.logout().catch(() => {});
  }
}

/**
 * Sends a prepared message. msg: buildMessage input (from, to, cc, bcc, subject, text, attachments,
 * inReplyTo, references). Returns { messageId, sent: { saved, already, reason } }; throws SmtpError when
 * the server refused or the connection failed (nothing was sent then).
 */
async function sendMail({ account, password, msg, deps = {}, waitMs }) {
  if (!account.smtpHost) throw Object.assign(new Error('이 계정의 보내는 메일 서버(SMTP)가 설정되지 않았습니다. 설정 → 계정에서 SMTP 서버를 넣으세요.'), { kind: 'config' });
  const built = buildMessage(msg);
  if (!built.recipients.length) throw Object.assign(new Error('받는 사람이 없습니다.'), { kind: 'config' });
  const smtp = new SmtpClient({ host: account.smtpHost, port: account.smtpPort, security: account.smtpSecurity, username: account.username, password, deps: deps.smtp || {} });
  try {
    await smtp.open();
    await smtp.send({ from: msg.from.address, recipients: built.recipients, data: built.raw });
  } finally {
    smtp.quit().catch(() => {});
  }
  let sent = { saved: false, reason: 'off' };
  if (shouldSave(account)) {
    try {
      sent = await saveToSent({ account, password, raw: built.raw, messageId: built.messageId, deps, waitMs });
    } catch (err) {
      // The mail went out; only the copy failed.
      sent = { saved: false, reason: `보낸편지함에 저장하지 못했습니다: ${String(err?.message || err).slice(0, 160)}` };
    }
  }
  return { messageId: built.messageId, size: built.raw.length, sent };
}

/** SMTP login check for "연결 확인" (no mail sent). */
async function checkSmtp({ account, password, deps = {} }) {
  const smtp = new SmtpClient({ host: account.smtpHost, port: account.smtpPort, security: account.smtpSecurity, username: account.username, password, deps: deps.smtp || {} });
  try {
    await smtp.open();
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: err?.kind || 'network', message: String(err?.message || err) };
  } finally {
    smtp.quit().catch(() => {});
  }
}

module.exports = { sendMail, saveToSent, findSent, shouldSave, checkSmtp, SENT_NAMES };
