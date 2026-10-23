// View logic of the 계정 대시보드 theme (#72) in the mail theme kit: <script src="dash-model.js">
// (window.MailDash) for any mail theme, require for the tests. Quick filters of the account view, the
// widget filter they map to, card numbers and totals. Pure functions.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailDash = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NONE = '__none__';

  /** Account view quick filter ('all' | 'unread' | 'flagged' | 'cat:<id>' | 'cat:__none__') -> widget filter. */
  function filterFor(accountId, quick = 'all') {
    const f = { accountId: accountId || '', unread: false, flagged: false, category: '' };
    if (quick === 'unread') f.unread = true;
    else if (quick === 'flagged') f.flagged = true;
    else if (typeof quick === 'string' && quick.startsWith('cat:')) f.category = quick.slice(4);
    return f;
  }

  /** The widget filter -> quick filter (the inverse of filterFor). */
  function quickOf(f) {
    if (!f) return 'all';
    if (f.unread) return 'unread';
    if (f.flagged) return 'flagged';
    if (f.category) return `cat:${f.category}`;
    return 'all';
  }

  /** Category chips of an account card: categories with mail in it (loaded headers), in category order. */
  function cardCategories(account, categories) {
    const counts = (account && account.categories) || {};
    return (categories || []).filter((c) => counts[c.id] > 0).map((c) => ({ id: c.id, name: c.name, color: c.color, count: counts[c.id] }));
  }

  /** Quick filter chips of the account view: 전체, 안 읽음 (server count), 중요 (server count), categories. */
  function quickChips(account, categories) {
    const a = account || {};
    return [
      { quick: 'all', label: '전체', count: null },
      { quick: 'unread', label: '안 읽음', count: a.unread || 0 },
      { quick: 'flagged', label: '중요', count: a.flagged || 0 },
      ...cardCategories(a, categories).map((c) => ({ quick: `cat:${c.id}`, label: c.name, color: c.color, count: c.count })),
    ];
  }

  /** Header totals over enabled accounts. */
  function totals(accounts) {
    const live = (accounts || []).filter((a) => a.enabled !== false);
    return {
      accounts: live.length,
      unread: live.reduce((n, a) => n + (a.unread || 0), 0),
      flagged: live.reduce((n, a) => n + (a.flagged || 0), 0),
      errors: live.filter((a) => a.state === 'error').length,
    };
  }

  /** Text for a filter that only looks at the headers loaded in the widget (분류). */
  function scopeNote(quick, loaded) {
    // 안 읽음 / 중요 come from the server's own lists (#83); only categories are this PC's, over loaded mail.
    if (quick === 'all' || quick === 'unread' || quick === 'flagged') return '';
    return `불러온 메일 ${loaded || 0}통 중에서 거릅니다. 더 보기로 더 불러올 수 있습니다.`;
  }

  return { NONE, filterFor, quickOf, cardCategories, quickChips, totals, scopeNote };
});
