// The unified inbox (#65): every account's loaded headers merged newest first, cut at the page limit, and
// which accounts must load older mail for "더 보기" to be complete. Pure functions (unit-tested).

// INBOX: "acc:uid"; a chosen mailbox (#80): "acc:<8-hex folder key>:uid".
const messageId = (accountId, uid, folderKey = '') => (folderKey ? `${accountId}:${folderKey}:${uid}` : `${accountId}:${uid}`);

/** "acc:123" or "acc:<folder key>:123" -> { accountId, folderKey ('' = INBOX), uid } or null. */
function parseId(id) {
  const m = /^([a-z0-9-]{1,40}):(?:([0-9a-f]{8}):)?(\d{1,10})$/i.exec(String(id || ''));
  return m ? { accountId: m[1], folderKey: (m[2] || '').toLowerCase(), uid: Number(m[3]) } : null;
}

/** A header as a theme sees it (no MIME structure, no Message-ID, no recipients). */
function listItem(account, h) {
  return {
    id: messageId(account.id, h.uid, h.folderKey),
    accountId: account.id,
    accountName: account.name,
    color: account.color,
    folder: h.folder || 'INBOX',
    folderKey: h.folderKey || '',
    from: h.from ? { name: h.from.name || '', address: h.from.address || '' } : { name: '', address: '' },
    subject: h.subject || '',
    date: h.date || 0,
    snippet: h.snippet || '',
    unread: Boolean(h.unread),
    flagged: Boolean(h.flagged),
    answered: Boolean(h.answered),
    hasAttachments: Boolean(h.hasAttachments),
  };
}

/**
 * sources: [{ account, headers: [...] (any order), hasMore, uidValidity? }]. Returns { items, hasMore } with
 * at most limit items, newest first (ties: account order, then UID). opts.categoryIds(source, h) adds
 * categoryIds (#69); opts.keep(item) filters before the page is cut (category filter).
 */
function merge(sources, limit, opts = {}) {
  const all = [];
  sources.forEach((s, order) => {
    for (const h of s.headers) all.push({ order, h, source: s });
  });
  all.sort((a, b) => b.h.date - a.h.date || a.order - b.order || b.h.uid - a.h.uid);
  const decorated = all.map((x) => ({ ...listItem(x.source.account, x.h), categoryIds: opts.categoryIds ? opts.categoryIds(x.source, x.h) : [] }));
  const kept = opts.keep ? decorated.filter(opts.keep) : decorated;
  const items = kept.slice(0, limit);
  const hasMore = kept.length > limit || sources.some((s) => s.hasMore);
  return { items, hasMore };
}

/**
 * Accounts that must fetch older mail before the first `limit` merged items are right: an account with more
 * on the server whose oldest loaded message would be inside (or right at the edge of) the page.
 */
function needsMore(sources, limit) {
  const all = [];
  sources.forEach((s, order) => {
    for (const h of s.headers) all.push({ order, date: h.date, id: s.account.id });
  });
  all.sort((a, b) => b.date - a.date || a.order - b.order);
  const cutoff = all.length >= limit ? all[limit - 1].date : -Infinity;
  return sources
    .filter((s) => s.hasMore)
    .filter((s) => {
      if (!s.headers.length) return true;
      const oldest = Math.min(...s.headers.map((h) => h.date));
      return oldest >= cutoff;
    })
    .map((s) => s.account.id);
}

module.exports = { messageId, parseId, listItem, merge, needsMore };
