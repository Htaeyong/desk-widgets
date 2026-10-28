// The to-do keys of a note's front matter (#110 / #111, design 3.1-3.3). Flat one-line values readable and editable in
// Obsidian's properties and VS Code. Reading: key names in any case, the first of a repeated key, "…" / '…' quotes,
// a wrong value ignored (that key only; the file is not changed). Writing: only the lines of our own keys change or
// are added (lower case, unquoted); every other line, its order and comments stay.
const D = require('./dates');

const KEYS = ['due', 'repeat', 'remind', 'completed', 'last-done', 'reset-checks', 'source', 'source-id', 'source-url'];
const LINE = /^([A-Za-z][\w-]*)[ \t]*:(.*)$/;

const keyOf = (line) => {
  const m = LINE.exec(line);
  return m ? m[1].toLowerCase() : null;
};

/** The raw value of a key (first occurrence), or undefined. */
function getValue(lines, key) {
  for (const line of lines || []) {
    const m = LINE.exec(line);
    if (!m || m[1].toLowerCase() !== key) continue;
    return unquote(m[2]);
  }
  return undefined;
}

function unquote(raw) {
  let v = String(raw).trim();
  const q = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/.exec(v) || /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(v);
  if (q) return v.startsWith('"') ? q[1].replace(/\\(.)/g, '$1') : q[1].replace(/''/g, "'");
  v = v.replace(/\s+#.*$/, '');
  return v.trim();
}

/** A continuation of the line before (an indented line or a list item under an empty value). */
const isContinuation = (line) => /^(\s+\S|\s*-\s)/.test(line) || line.trim() === '';

/**
 * Lines with our keys set: patch { key: value | null } (null removes the key). The first line of a key is replaced
 * in place, repeats of it are removed; a new key goes to the end. Other lines are kept as they are.
 */
function setValues(lines, patch) {
  const out = [...(lines || [])];
  for (const [key, value] of Object.entries(patch)) {
    let first = -1;
    for (let i = 0; i < out.length; i++) {
      if (keyOf(out[i]) !== key) continue;
      // A key with an empty value may own the indented lines under it (a YAML list): they go with it.
      let end = i + 1;
      if (!unquote(LINE.exec(out[i])[2])) while (end < out.length && isContinuation(out[end]) && out[end].trim()) end++;
      if (first === -1 && value !== null && value !== undefined) {
        out.splice(i, end - i, `${key}: ${value}`);
        first = i;
      } else {
        out.splice(i, end - i);
        i--;
      }
    }
    if (first === -1 && value !== null && value !== undefined) out.push(`${key}: ${value}`);
  }
  return out;
}

/**
 * The to-do of a note from its front matter lines:
 *   { due, rule, remind, completedAt, lastDoneAt, resetChecks (true/false/null), source, sourceId, sourceUrl,
 *     problems: [{ key, value }] }
 * due null = a plain note. A repeat without a due is ignored. Wrong values are reported in problems.
 */
function readTodo(lines) {
  const problems = [];
  const raw = (key) => {
    const v = getValue(lines, key);
    return v === undefined || v === '' ? null : v;
  };
  const dueRaw = raw('due');
  const due = dueRaw === null ? null : D.parseDueValue(dueRaw);
  if (dueRaw !== null && !due) problems.push({ key: 'due', value: dueRaw });
  const repeatRaw = raw('repeat');
  const rule = repeatRaw === null ? null : D.parseRepeat(repeatRaw);
  if (repeatRaw !== null && !rule && due) problems.push({ key: 'repeat', value: repeatRaw });
  const remindRaw = raw('remind');
  const remind = remindRaw === null ? null : D.parseRemind(remindRaw);
  if (remindRaw !== null && !remind && due) problems.push({ key: 'remind', value: remindRaw });
  const completedRaw = raw('completed');
  const completedAt = completedRaw === null ? null : D.parseStamp(completedRaw);
  if (completedRaw !== null && completedAt === null) problems.push({ key: 'completed', value: completedRaw });
  const reset = raw('reset-checks');
  const url = raw('source-url');
  return {
    due,
    rule: due ? rule : null,
    remind,
    completedAt,
    lastDoneAt: raw('last-done') === null ? null : D.parseStamp(raw('last-done')),
    resetChecks: reset === null ? null : /^(true|yes|on|1)$/i.test(reset) ? true : /^(false|no|off|0)$/i.test(reset) ? false : null,
    source: raw('source'),
    sourceId: raw('source-id'),
    sourceUrl: url && /^https:\/\//i.test(url) ? url : null,
    problems,
  };
}

/** Is there anything of a to-do in it (worth keeping in the index)? */
const hasTodoKeys = (lines) => (lines || []).some((l) => KEYS.includes(keyOf(l)));

module.exports = { KEYS, getValue, setValues, readTodo, hasTodoKeys, unquote };
