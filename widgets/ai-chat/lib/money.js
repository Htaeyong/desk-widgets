// How an amount is shown (#129): two decimals at most, and under a cent as "under $0.01". Sums stay exact elsewhere; only the
// words on screen are rounded. chat/chat.js has the same rule for the window.
function money(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '$0.01 미만';
  return `$${n.toFixed(2)}`;
}

/** "약 $1.23" or "$0.01 미만": the "about" only where there is a number to be about. */
const aboutMoney = (usd) => (Number(usd) > 0 && Number(usd) < 0.01 ? money(usd) : (Number(usd) > 0 ? `약 ${money(usd)}` : money(0)));

module.exports = { money, aboutMoney };
