// The server's mailboxes for the "함께 볼 메일함" picker (#80): LIST results (SPECIAL-USE flags, modified
// UTF-7 names already decoded by the client) -> what the settings window shows. Pure (unit-tested).

// Mailboxes that are not "incoming mail": never offered (they would repeat or mix sent / deleted mail).
const SPECIAL = [
  { kind: 'sent', label: '보낸편지함', flag: '\\sent', names: /^(sent|sent (items|messages|mail)|보낸\s*(메일|편지)함?|\[gmail\]\/sent mail|inbox[./]sent)$/i },
  { kind: 'drafts', label: '임시 보관함', flag: '\\drafts', names: /^(drafts?|임시\s*(보관|저장)함?|\[gmail\]\/drafts)$/i },
  { kind: 'trash', label: '휴지통', flag: '\\trash', names: /^(trash|deleted( items| messages)?|bin|휴지통|지운\s*(메일|편지)함?|\[gmail\]\/(trash|bin))$/i },
  { kind: 'junk', label: '스팸', flag: '\\junk', names: /^(junk( e-?mail)?|spam|bulk mail|스팸(\s*(메일|편지)함)?|\[gmail\]\/spam)$/i },
  { kind: 'all', label: '전체 보관함', flag: '\\all', names: /^(all mail|\[gmail\]\/all mail|전체\s*보관함)$/i },
];

/** One LIST row -> { raw, name, special: kind | null, specialLabel, selectable }. */
function classify(box) {
  const flags = (box.flags || []).map((f) => String(f).toLowerCase());
  const last = String(box.name || '').split(box.delimiter || '/').pop();
  const hit = SPECIAL.find((s) => flags.includes(s.flag) || s.names.test(box.name || '') || s.names.test(last));
  const noselect = flags.includes('\\noselect') || flags.includes('\\nonexistent');
  return { raw: box.raw, name: box.name, special: hit ? hit.kind : null, specialLabel: hit ? hit.label : '', selectable: !noselect && !hit };
}

/** LIST rows -> the picker list without INBOX, in the server's order (names sorted within a level by the server). */
function pickerFolders(boxes) {
  return (boxes || []).filter((b) => b && b.raw && String(b.name).toUpperCase() !== 'INBOX').map(classify);
}

/** The settings value: [{ raw, name }] of chosen, existing, selectable folders (at most max). */
function cleanFolders(list, max = 10) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(list) ? list : []) {
    const raw = String(f?.raw || '');
    if (!raw || raw.length > 300 || /[\r\n\0]/.test(raw) || raw.toUpperCase() === 'INBOX' || seen.has(raw)) continue;
    seen.add(raw);
    out.push({ raw, name: String(f?.name || raw).replace(/[\r\n]+/g, ' ').slice(0, 100) });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { classify, pickerFolders, cleanFolders, SPECIAL };
