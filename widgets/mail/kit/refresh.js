// The ⟳ button of mail themes (#79), in the mail theme kit: <script src="refresh.js"> (window.MailRefresh),
// require for the tests. A press shows at once (pressed + spinning), keeps spinning at least minMs and until the
// widget's api.refresh() answers, then says what happened ("새 메일 3통", "새 메일 없음", or the error).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailRefresh = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_MS = 600;

  /** The short text after a refresh: { newMail, errors: [{ name, message }] } from api.refresh(). */
  function resultText(res) {
    if (!res || res.ok === false) return `새로고침하지 못했습니다${res && res.message ? `: ${res.message}` : ''}`;
    const errors = Array.isArray(res.errors) ? res.errors : [];
    const parts = [];
    if (res.newMail > 0) parts.push(`새 메일 ${res.newMail}통`);
    else if (errors.length < (res.accounts || 1)) parts.push('새 메일 없음');
    if (errors.length === 1) parts.push(`${errors[0].name}: ${errors[0].message}`);
    else if (errors.length > 1) parts.push(`연결 오류 ${errors.length}개 (${errors.map((e) => e.name).join(', ')})`);
    return parts.join(' · ');
  }

  /** Only the ⟳ spins (refresh.css ".spin .glyph"): a button with bare text gets it wrapped in <span class="glyph">. */
  function ensureGlyph(button) {
    if (!button || typeof button.querySelector !== 'function' || button.querySelector('.glyph')) return;
    const doc = button.ownerDocument;
    if (!doc) return;
    const span = doc.createElement('span');
    span.className = 'glyph';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = button.textContent.trim() || '⟳';
    button.replaceChildren(span);
  }

  /**
   * Wires a button: run() is the widget call (api.refresh), notice(text, isError) shows the result.
   * The button gets the classes "spin" and "pressed" and data-busy="1" while it runs.
   */
  function bind(button, { run, notice = () => {}, minMs = MIN_MS, now = () => Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    let busy = false;
    ensureGlyph(button);
    async function press() {
      if (busy) return null;
      busy = true;
      const started = now();
      button.classList.add('spin', 'pressed');
      button.dataset.busy = '1';
      button.setAttribute('aria-busy', 'true');
      let res;
      try {
        res = await run();
      } catch (err) {
        res = { ok: false, message: String((err && err.message) || err) };
      }
      const left = minMs - (now() - started);
      if (left > 0) await wait(left);
      button.classList.remove('spin', 'pressed');
      delete button.dataset.busy;
      button.removeAttribute('aria-busy');
      busy = false;
      notice(resultText(res), Boolean(!res || res.ok === false || (res.errors && res.errors.length)));
      return res;
    }
    button.addEventListener('click', press);
    return { press, busy: () => busy };
  }

  return { bind, resultText, MIN_MS };
});
