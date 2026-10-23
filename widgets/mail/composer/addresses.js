// Recipient addresses for the composer (#68): one module for the composer page (<script src="addresses.js">,
// window.MailAddresses: chips) and the widget's main code (require: checks before sending), so both read
// addresses the same way. Recipients travel as lists of { name, address }, never as one string.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailAddresses = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  const MAX = 100;

  const isAddress = (a) => typeof a === 'string' && a.length <= 254 && ADDRESS.test(a);

  /** Splits pasted / typed text at commas, semicolons and line breaks outside quotes and <>. */
  function splitEntries(text) {
    const parts = [];
    let cur = '';
    let quoted = false;
    let angle = false;
    for (const ch of String(text || '')) {
      if (ch === '"') quoted = !quoted;
      if (!quoted && ch === '<') angle = true;
      if (!quoted && ch === '>') angle = false;
      if (!quoted && !angle && (ch === ',' || ch === ';' || ch === '\n' || ch === '\r' || ch === '\t')) {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  /** One entry ("이름 <a@b.c>", "\"Kim, J\" <k@y.com>", "a@b.c") -> { name, address, valid, raw }. */
  function parseEntry(raw) {
    const text = String(raw || '').trim();
    const m = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(text);
    const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim() : '';
    const address = (m ? m[2] : text).trim();
    const valid = isAddress(address) && !/[\r\n]/.test(name) && name.length <= 200;
    return { name: valid ? name : '', address: valid ? address : text, valid, raw: text };
  }

  /** Text -> { list: [{ name, address }], bad: ['raw', ...] } (the order kept, duplicates dropped). */
  function parseAddresses(text) {
    const list = [];
    const bad = [];
    const seen = new Set();
    for (const raw of splitEntries(text)) {
      const e = parseEntry(raw);
      if (!e.valid) bad.push(e.raw);
      else if (!seen.has(e.address.toLowerCase())) {
        seen.add(e.address.toLowerCase());
        list.push({ name: e.name, address: e.address });
      }
    }
    return { list, bad };
  }

  /** A chip's text: the name if there is one, else the address. Its tooltip: "이름 <주소>". */
  const chipLabel = (a) => (a && a.name ? a.name : a ? a.address : '');
  const fullText = (a) => (a && a.name ? `${a.name} <${a.address}>` : a ? a.address : '');

  /**
   * A recipient list from the page (or a draft) checked for sending: { list } with clean { name, address },
   * or { error, bad } when an entry is not an address (the composer shows it as a red chip).
   */
  function checkList(input) {
    const list = [];
    const bad = [];
    const seen = new Set();
    for (const r of Array.isArray(input) ? input : []) {
      const address = String(r?.address || '').trim();
      const name = String(r?.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      if (!isAddress(address) || r?.invalid) {
        bad.push(address || String(r?.raw || ''));
        continue;
      }
      if (seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      list.push({ name, address });
    }
    if (bad.length) return { error: `메일 주소가 올바르지 않습니다: ${bad.slice(0, 3).join(', ')}`, bad };
    if (list.length > MAX) return { error: `받는 사람은 ${MAX}명까지입니다.`, bad: [] };
    return { list };
  }

  return { ADDRESS, isAddress, splitEntries, parseEntry, parseAddresses, chipLabel, fullText, checkList, MAX };
});
