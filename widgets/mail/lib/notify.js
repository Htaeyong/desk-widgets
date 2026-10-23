// New-mail cards (#65): arrivals are collected for a moment (several accounts may report together), then
// one generic card per message, or one summary card when more than SUMMARY_OVER arrive at once.
// The account's and the widget's notification switches are checked here. Pure apart from the timer.

const SUMMARY_OVER = 3;
const COLLECT_MS = 1500;

const senderOf = (m) => m.from?.name || m.from?.address || '(보낸 사람 없음)';
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Arrivals [{ id, accountName, from, subject }] -> engine card objects. */
function cardsFor(arrivals) {
  if (!arrivals.length) return [];
  if (arrivals.length > SUMMARY_OVER) {
    const names = [...new Set(arrivals.map(senderOf))];
    const shown = names.slice(0, 2).join(', ');
    const rest = names.length - 2;
    return [
      {
        type: 'card',
        title: `새 메일 ${arrivals.length}통`,
        body: cut(`${shown}${rest > 0 ? ` 외 ${rest}명` : ''} · ${arrivals[arrivals.length - 1].subject || '(제목 없음)'}`, 300),
        icon: 'mail',
        actions: [{ id: 'open', label: '열기' }],
        tag: 'mail-summary',
        ids: arrivals.map((m) => m.id),
      },
    ];
  }
  return arrivals.map((m) => ({
    type: 'card',
    title: cut(senderOf(m), 120),
    body: cut(`${m.subject || '(제목 없음)'}${m.accountName ? ` · ${m.accountName}` : ''}`, 300),
    icon: 'mail',
    actions: [
      { id: 'open', label: '열기' },
      { id: 'read', label: '읽음' },
    ],
    tag: `mail:${m.id}`,
    ids: [m.id],
  }));
}

/**
 * Collects arrivals and sends cards. opts: { enabled(accountId) -> bool, send(cards), setTimeout?, clearTimeout? }
 */
function createNotifier(opts) {
  const st = opts.setTimeout || setTimeout;
  const ct = opts.clearTimeout || clearTimeout;
  let pending = [];
  let timer = null;
  const flush = () => {
    timer = null;
    const list = pending.filter((m) => opts.enabled(m.accountId));
    pending = [];
    const cards = cardsFor(list);
    if (cards.length) opts.send(cards);
  };
  return {
    add(list) {
      pending.push(...list);
      if (!timer) timer = st(flush, COLLECT_MS);
    },
    flush() {
      if (timer) ct(timer);
      flush();
    },
    cancel() {
      if (timer) ct(timer);
      timer = null;
      pending = [];
    },
  };
}

module.exports = { cardsFor, createNotifier, SUMMARY_OVER, COLLECT_MS };
