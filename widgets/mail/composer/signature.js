// The signature block in the composer body (#68): "-- " line + the account's signature, below the text
// the user writes and above a quote. Shared by the composer page (window.MailSignature) and the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailSignature = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const block = (sig) => `\n\n-- \n${sig}`;

  /**
   * The body after the sending account changed from oldSig to newSig. The block is swapped only while it is
   * exactly as inserted (the user did not edit it); an edited or removed signature is left alone.
   * Returns { body, swapped }.
   */
  function swapSignature(body, oldSig, newSig) {
    const text = String(body || '');
    const from = String(oldSig || '');
    const to = String(newSig || '');
    if (from === to) return { body: text, swapped: false };
    if (from) {
      const i = text.indexOf(block(from));
      const end = i + block(from).length;
      // The whole signature must be there unchanged: it ends the body or a line ("회사 서명 (재택)" is edited).
      if (i < 0 || (end < text.length && text[end] !== '\n')) return { body: text, swapped: false };
      return { body: text.slice(0, i) + (to ? block(to) : '') + text.slice(i + block(from).length), swapped: true };
    }
    // No signature before: put the new one after the first line (where composeBody puts it).
    if (/\n-- \n/.test(text)) return { body: text, swapped: false };
    const nl = text.indexOf('\n');
    const at = nl < 0 ? text.length : nl;
    return { body: text.slice(0, at) + block(to) + text.slice(at), swapped: true };
  }

  return { swapSignature, block };
});
