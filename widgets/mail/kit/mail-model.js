// Pure mail view logic in the mail widget's theme kit (#65): any mail theme loads it with
// <script src="mail-model.js"> (window.MailModel), tests require it. Time labels, sender labels, initials,
// account filtering and unread counts of a list.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const pad = (n) => String(n).padStart(2, '0');
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  /** List time: today "14:05", yesterday "어제", this week "화", this year "10/3", else "2025.10.3". */
  function timeLabel(ms, now = Date.now()) {
    if (!ms) return '';
    const d = new Date(ms);
    const n = new Date(now);
    if (sameDay(d, n)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
    if (sameDay(d, y)) return '어제';
    const days = (new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
    if (days > 0 && days < 7) return WEEKDAYS[d.getDay()];
    if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  }

  /** Full date for a detail view: "2026년 10월 19일 (월) 14:05". */
  function fullDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const senderLabel = (from) => (from ? from.name || from.address || '' : '') || '(보낸 사람 없음)';
  const personLabel = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');

  /** One or two letters for an avatar. */
  function initials(from) {
    const s = senderLabel(from).replace(/[^\p{L}\p{N}]/gu, '');
    if (!s) return '?';
    return /^[ㄱ-힝]/.test(s) ? s.slice(0, 1) : s.slice(0, 2).toUpperCase();
  }

  /** Items of the chosen account ('' = all). */
  const filterBy = (items, accountId) => (accountId ? items.filter((m) => m.accountId === accountId) : items);

  /** "1.2KB" style sizes. */
  const sizeLabel = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n || 0}B`);

  /** Status line of an account for a tooltip. */
  function accountStatus(a) {
    if (!a) return '';
    if (a.state === 'error') return `${a.name}: ${a.error || '오류'}`;
    if (a.state === 'connecting') return `${a.name}: 연결 중…`;
    if (a.state === 'syncing') return `${a.name}: 받는 중…`;
    if (a.state === 'paused') return `${a.name}: 자리 비움 중 멈춤`;
    if (a.state === 'off') return `${a.name}: 꺼짐`;
    return `${a.name}: 안 읽은 메일 ${a.unread}통`;
  }

  return { timeLabel, fullDate, senderLabel, personLabel, initials, filterBy, sizeLabel, accountStatus };
});
