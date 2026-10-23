// Markdown <-> HTML for the memo editor (#75). Written for this widget (packages carry no node_modules, #40) and
// limited to the subset the editor can show: headings, paragraphs (a single newline is a line break, like Obsidian),
// bold / italic / strike, inline code, fenced code, quotes, bullet / numbered / task lists, links, images, rules and
// GFM tables. Raw HTML in a file is never interpreted: it is shown and saved as the text it is.
//
// parse(md) -> block AST; renderHtml(ast, opts) -> HTML for the editor; toMarkdown(tree, opts) turns the editor's
// content (a plain { type, tag, attrs, children } tree made from the DOM, or from html.parseHtml) back into Markdown.

const PUNCT = /[!-/:-@[-`{-~ -⁯　-〿＀-／]/;
const SPACE = /\s/;

// ---------------------------------------------------------------------------------------------------------------
// Block parsing

const RE = {
  blank: /^\s*$/,
  fence: /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?/,
  item: /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  indented: /^(?: {4}|\t)/,
  tableDelim: /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/,
};

function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out;
}

const indentOf = (line) => line.match(/^ */)[0].length;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      code = code ? 0 : 1;
      cur += ch;
    } else if (ch === '[' && s[i + 1] === '[' && !code && s.indexOf(']]', i) > 0) {
      // [[제목|글자]] in a cell: its "|" is not a cell border.
      const end = s.indexOf(']]', i) + 2;
      cur += s.slice(i, end).replace(/\\\|/g, '|');
      i = end - 1;
    } else if (ch === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes('|')) return false;
  if (!RE.tableDelim.test(lines[i + 1]) || !lines[i + 1].includes('-')) return false;
  const head = splitRow(lines[i]);
  const delim = splitRow(lines[i + 1]);
  return head.length === delim.length && (lines[i + 1].includes('|') || head.length === 1);
}

/** Does this line start a block that interrupts a paragraph? */
function interrupts(line) {
  if (RE.fence.test(line) || RE.atx.test(line) || RE.hr.test(line) || RE.quote.test(line)) return true;
  const m = line.match(RE.item);
  if (m && m[4] !== undefined && m[4].trim() !== '') return /^[-+*]$/.test(m[2]) || /^1[.)]$/.test(m[2]);
  return false;
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.blank.test(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = line.match(RE.fence))) {
      const [, ind, fence, info] = m;
      const body = [];
      i++;
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${ind.length}}`), ''));
        i++;
      }
      i++; // closing fence (or end of file)
      blocks.push({ t: 'code', lang: info || '', text: body.join('\n') });
      continue;
    }
    if ((m = line.match(RE.atx))) {
      blocks.push({ t: 'heading', level: m[1].length, children: parseInline(m[2] || '') });
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      const inner = [];
      while (i < lines.length && RE.quote.test(lines[i])) inner.push(lines[i++].replace(RE.quote, ''));
      blocks.push({ t: 'quote', children: parseBlocks(inner) });
      continue;
    }
    if ((m = line.match(RE.item))) {
      i = parseList(lines, i, blocks);
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && !RE.blank.test(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i++]);
        rows.push(head.map((_, k) => parseInline(cells[k] || '')));
      }
      blocks.push({ t: 'table', align, head: head.map((c) => parseInline(c)), rows });
      continue;
    }
    if (RE.indented.test(line)) {
      const body = [];
      while (i < lines.length && (RE.indented.test(lines[i]) || RE.blank.test(lines[i]))) body.push(lines[i++].replace(RE.indented, ''));
      while (body.length && RE.blank.test(body[body.length - 1])) body.pop();
      blocks.push({ t: 'code', lang: '', text: body.join('\n') });
      continue;
    }
    // Paragraph (maybe a setext heading).
    const para = [line.trim()];
    i++;
    let heading = 0;
    while (i < lines.length && !RE.blank.test(lines[i])) {
      const s = lines[i].match(RE.setext);
      if (s) {
        heading = s[1][0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(lines[i]) || isTableStart(lines, i)) break;
      para.push(lines[i++].trim());
    }
    if (heading) blocks.push({ t: 'heading', level: heading, children: parseInline(para.join('\n')) });
    else if (para.length === 1 && para[0] === '&nbsp;') blocks.push({ t: 'para', children: [] });
    else blocks.push({ t: 'para', children: parseInline(para.join('\n')) });
  }
  return blocks;
}

function parseList(lines, start, blocks) {
  const first = lines[start].match(RE.item);
  const ordered = /\d/.test(first[2]);
  const kind = ordered ? first[2].slice(-1) : first[2];
  const list = { t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(RE.item);
    if (!m || (ordered ? !/\d/.test(m[2]) || m[2].slice(-1) !== kind : m[2] !== kind)) break;
    if (indentOf(lines[i]) > 3) break;
    const spaces = (m[3] || ' ').length;
    const width = m[1].length + m[2].length + (spaces > 4 ? 1 : spaces);
    const body = [m[4] === undefined ? '' : spaces > 4 ? ' '.repeat(spaces - 1) + m[4] : m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (RE.blank.test(l)) {
        // A blank line stays in the item only when indented content follows.
        let j = i;
        while (j < lines.length && RE.blank.test(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= width) {
          for (; i < j; i++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) >= width) {
        body.push(l.slice(width));
        i++;
        continue;
      }
      // Lazy continuation of the item's paragraph.
      if (!RE.blank.test(body[body.length - 1]) && !interrupts(l) && !RE.item.test(l)) {
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    let checked = null;
    const task = body[0].match(/^\[([ xX])\](?:[ \t]+|$)/);
    if (task) {
      checked = task[1] !== ' ';
      body[0] = body[0].slice(task[0].length);
    }
    const children = parseBlocks(body);
    list.items.push({ checked, children });
    // Items separated by blank lines: keep going if the next line is another item of this list.
    let j = i;
    while (j < lines.length && RE.blank.test(lines[j])) j++;
    if (j > i && j < lines.length && RE.item.test(lines[j])) i = j;
  }
  blocks.push(list);
  return i;
}

// ---------------------------------------------------------------------------------------------------------------
// Inline parsing

const ENTITIES = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function decodeEntity(s, i) {
  const m = s.slice(i).match(/^&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/i);
  if (!m) return null;
  const name = m[1];
  let ch = null;
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (code > 0 && code <= 0x10ffff) ch = String.fromCodePoint(code);
  } else if (Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase())) ch = ENTITIES[name.toLowerCase()];
  return ch === null ? null : { ch, len: m[0].length };
}

/** Finds the "]" closing the "[" at `open`, skipping escapes, code spans and nested brackets. */
function closingBracket(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === '`') {
      const run = s.slice(i).match(/^`+/)[0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) i = end + run.length - 1;
    } else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

/** Link destination and title after "](": returns { dest, title, end } (end = index after ")") or null. */
function linkTail(s, pos) {
  let i = pos;
  while (s[i] === ' ') i++;
  let dest = '';
  if (s[i] === '<') {
    const end = s.indexOf('>', i);
    if (end < 0 || s.slice(i, end).includes('\n')) return null;
    dest = s.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    const startI = i;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    dest = s.slice(startI, i).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  while (s[i] === ' ' || s[i] === '\n') i++;
  let title = '';
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i];
    const end = s.indexOf(q, i + 1);
    if (end < 0) return null;
    title = s.slice(i + 1, end);
    i = end + 1;
    while (s[i] === ' ') i++;
  }
  if (s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

const URL_RE = /^(?:https?:\/\/|mailto:)[^\s<>]+/i;

function bareUrl(s, i) {
  if (i > 0 && /[\w/]/.test(s[i - 1])) return null;
  const m = s.slice(i).match(/^https?:\/\/[^\s<>]+/i);
  if (!m) return null;
  let url = m[0];
  // Trailing punctuation is not part of a bare URL (GFM); a ")" only when unbalanced.
  while (/[.,:;!?'"*_~]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) url = url.slice(0, -1);
  return url.length > 8 ? url : null;
}

function parseInline(src) {
  const s = String(src);
  const tokens = [];
  let text = '';
  const flush = () => {
    if (text) tokens.push({ t: 'text', v: text });
    text = '';
  };
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === '\\') {
      if (s[i + 1] === '\n') {
        flush();
        tokens.push({ t: 'br' });
        i += 2;
        continue;
      }
      if (i + 1 < s.length && PUNCT.test(s[i + 1]) && s.charCodeAt(i + 1) < 128) {
        text += s[i + 1];
        i += 2;
        continue;
      }
      text += ch;
      i++;
      continue;
    }
    if (ch === '`') {
      const run = s.slice(i).match(/^`+/)[0];
      let end = -1;
      for (let k = i + run.length; k < s.length; ) {
        const r = s.slice(k).match(/^`+/);
        if (r) {
          if (r[0].length === run.length) {
            end = k;
            break;
          }
          k += r[0].length;
        } else k++;
      }
      if (end < 0) {
        text += run;
        i += run.length;
        continue;
      }
      let code = s.slice(i + run.length, end).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      flush();
      tokens.push({ t: 'code', v: code });
      i = end + run.length;
      continue;
    }
    if (ch === '[' && s[i + 1] === '[') {
      // A link to another memo (Obsidian style): [[제목]], [[제목|보이는 글자]], [[제목#소제목]].
      const w = s.slice(i).match(WIKI_RE);
      if (w && w[1].trim()) {
        flush();
        tokens.push({ t: 'wiki', target: w[1].trim(), label: (w[2] || '').trim() });
        i += w[0].length;
        continue;
      }
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const open = ch === '!' ? i + 1 : i;
      const close = closingBracket(s, open);
      if (close > 0 && s[close + 1] === '(') {
        const tail = linkTail(s, close + 2);
        if (tail) {
          flush();
          const label = s.slice(open + 1, close);
          if (ch === '!') tokens.push({ t: 'img', src: tail.dest, alt: plainText(parseInline(label)), title: tail.title });
          else tokens.push({ t: 'link', href: tail.dest, title: tail.title, children: parseInline(label) });
          i = tail.end;
          continue;
        }
      }
      text += ch;
      i++;
      continue;
    }
    if (ch === '<') {
      const m = s.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i);
      if (m) {
        flush();
        tokens.push({ t: 'link', href: m[1], title: '', children: [{ t: 'text', v: m[1] }], auto: true });
        i += m[0].length;
        continue;
      }
    }
    if (ch === 'h' || ch === 'H') {
      const url = bareUrl(s, i);
      if (url) {
        flush();
        tokens.push({ t: 'link', href: url, title: '', children: [{ t: 'text', v: url }], auto: true });
        i += url.length;
        continue;
      }
    }
    if (ch === '&') {
      const e = decodeEntity(s, i);
      if (e) {
        text += e.ch;
        i += e.len;
        continue;
      }
    }
    if (ch === '\n') {
      text = text.replace(/ +$/, '');
      flush();
      tokens.push({ t: 'br' });
      i++;
      while (s[i] === ' ') i++;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = s.slice(i).match(ch === '*' ? /^\*+/ : ch === '_' ? /^_+/ : /^~+/)[0];
      const before = i > 0 ? s[i - 1] : ' ';
      const after = i + run.length < s.length ? s[i + run.length] : ' ';
      const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before));
      const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after));
      let canOpen = left;
      let canClose = right;
      if (ch === '_') {
        canOpen = left && (!right || PUNCT.test(before));
        canClose = right && (!left || PUNCT.test(after));
      }
      if (ch === '~' && run.length !== 2) {
        text += run;
        i += run.length;
        continue;
      }
      flush();
      tokens.push({ t: 'delim', ch, n: run.length, orig: run.length, canOpen, canClose });
      i += run.length;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return finishInline(processEmphasis(tokens));
}

/** CommonMark "process emphasis", simplified: pairs delimiter runs into strong / em / del nodes. */
function processEmphasis(tokens) {
  for (let c = 0; c < tokens.length; c++) {
    const closer = tokens[c];
    if (closer.t !== 'delim' || !closer.canClose || closer.n === 0) continue;
    for (let o = c - 1; o >= 0; o--) {
      const opener = tokens[o];
      if (opener.t !== 'delim' || opener.ch !== closer.ch || !opener.canOpen || opener.n === 0) continue;
      // "Rule of 3" for runs that can both open and close.
      if (closer.ch !== '~' && (opener.canClose || closer.canOpen) && (opener.orig + closer.orig) % 3 === 0 && (opener.orig % 3 || closer.orig % 3)) continue;
      const use = closer.ch === '~' ? 2 : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
      const t = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      const inner = tokens.slice(o + 1, c);
      opener.n -= use;
      closer.n -= use;
      const node = { t, children: inner };
      tokens.splice(o + 1, c - o - 1, node);
      c = o + 1;
      if (closer.n > 0) c--; // look at the same closer again for what is left of it
      break;
    }
  }
  return tokens;
}

function finishInline(tokens) {
  const out = [];
  for (const tok of tokens) {
    let node = tok;
    if (tok.t === 'delim') {
      if (!tok.n) continue;
      node = { t: 'text', v: tok.ch.repeat(tok.n) };
    } else if (tok.children) node = { ...tok, children: finishInline(tok.children) };
    const prev = out[out.length - 1];
    if (node.t === 'text' && prev?.t === 'text') prev.v += node.v;
    else out.push(node);
  }
  return out;
}

function plainText(nodes) {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : n.t === 'img' ? n.alt : n.t === 'wiki' ? n.label || n.target : n.children ? plainText(n.children) : '')).join('');
}

// [[target]] / [[target|label]]: no brackets, "|" or line breaks inside.
const WIKI_RE = /^\[\[([^[\]|\n]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/;

/**
 * The memo a link means, as a lower-case title: "[[폴더/회의록.md#안건]]" -> "회의록", "회의록.md" -> "회의록".
 * Memos are matched by title (their file name), like Obsidian.
 */
function wikiKey(target) {
  let t = String(target || '').split('#')[0].trim();
  t = t.split(/[\\/]/).pop();
  t = t.replace(/\.(md|txt)$/i, '');
  return t.normalize('NFC').toLowerCase();
}

/** Memos a body links to: [[...]] targets and relative links to .md / .txt files, as wikiKey()s. */
function collectLinks(md) {
  const keys = new Set();
  const walkInline = (nodes) => {
    for (const n of nodes) {
      if (n.t === 'wiki') keys.add(wikiKey(n.target));
      else if (n.t === 'link') {
        const d = classifyDest(n.href, null);
        if (d.kind === 'relative' && /\.(md|txt)(#.*)?$/i.test(d.value)) keys.add(wikiKey(d.value));
      }
      if (n.children) walkInline(n.children);
    }
  };
  const walk = (bs) => {
    for (const b of bs) {
      if (b.t === 'heading' || b.t === 'para') walkInline(b.children);
      else if (b.t === 'quote') walk(b.children);
      else if (b.t === 'list') b.items.forEach((it) => walk(it.children));
      else if (b.t === 'table') [b.head, ...b.rows].forEach((row) => row.forEach(walkInline));
    }
  };
  walk(parse(md));
  keys.delete('');
  return [...keys];
}

/**
 * Points links at a renamed memo: [[old]], [[old|글자]], [[old#소제목]], [[폴더/old.md]] and [글자](old.md).
 * Code spans and code blocks are left alone.
 */
function relinkTitle(md, oldTitle, newTitle) {
  const oldKey = wikiKey(oldTitle);
  if (!oldKey || oldKey === wikiKey(newTitle)) return md;
  const fixWiki = (s) =>
    s.replace(/\[\[([^[\]|#\n]{1,200})(#[^[\]|\n]*)?(\|[^[\]\n]*)?\]\]/g, (m, target, heading = '', label = '') => {
      if (wikiKey(target) !== oldKey) return m;
      const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
      const ext = (target.match(/\.(md|txt)\s*$/i) || [''])[0].trim();
      return `[[${target.slice(0, slash + 1)}${newTitle}${ext}${heading}${label}]]`;
    });
  const forms = [...new Set([oldTitle, encodeDest(oldTitle), encodeURI(oldTitle)])];
  const fixLinks = (s) => {
    let out = s;
    for (const f of forms) {
      const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(\\]\\(<?)(\\./)?${esc}\\.md(?=[)#>\\s])`, 'gi'), (m, a, dot = '') => `${a}${dot}${encodeDest(newTitle)}.md`);
    }
    return out;
  };
  // Outside fenced code blocks and inline code only.
  const parts = String(md).split(/(^```[\s\S]*?^```[ \t]*$|^~~~[\s\S]*?^~~~[ \t]*$)/m);
  return parts
    .map((part, k) => (k % 2 ? part : part.split(/(`+[^`\n]*?`+)/).map((p, j) => (j % 2 ? p : fixLinks(fixWiki(p)))).join('')))
    .join('');
}

/** Markdown (front matter already removed) -> block AST. */
function parse(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  return parseBlocks(lines);
}

// ---------------------------------------------------------------------------------------------------------------
// Front matter

const FM_KEY = 'desk-widgets-memo';

/** Splits "---\n...\n---\n" off the top: { lines (raw front matter lines, without fences) | null, body, id }. */
function splitFrontMatter(text) {
  const src = String(text).replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!m) return { lines: null, body: src, id: null };
  const lines = m[1] === '' ? [] : m[1].split(/\r?\n/);
  const idLine = lines.find((l) => l.startsWith(`${FM_KEY}:`));
  const id = idLine ? idLine.slice(FM_KEY.length + 1).trim().replace(/^["']|["']$/g, '') : null;
  return { lines, body: src.slice(m[0].length), id: id && /^[\w-]{4,64}$/.test(id) ? id : null };
}

/** Front matter with our id set (other lines kept as they were). */
function joinFrontMatter(lines, id, body) {
  const kept = (lines || []).filter((l) => !l.startsWith(`${FM_KEY}:`));
  return `---\n${[...kept, `${FM_KEY}: ${id}`].join('\n')}\n---\n${body}`;
}

// ---------------------------------------------------------------------------------------------------------------
// AST -> HTML (for the editor)

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function decodeDest(dest) {
  try {
    return decodeURIComponent(dest);
  } catch {
    return dest;
  }
}

/** Percent-encodes what would end a Markdown link destination; keeps other characters (e.g. Korean) readable. */
const encodeDest = (s) => String(s).replace(/[%\s()<>\\]/g, (c) => (c === '%' ? '%25' : encodeURIComponent(c).replace(/[()]/g, (p) => `%${p.charCodeAt(0).toString(16).toUpperCase()}`)));

/** A destination that would not read back as written: spaces, angle brackets, unbalanced parentheses. */
function needsEncoding(d) {
  if (/[\s<>]/.test(d)) return true;
  let depth = 0;
  for (const ch of d) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return true;
  }
  return depth !== 0;
}

/** Where a link / image destination points: an http(s)/mailto URL, this memo's assets folder, or something else. */
function classifyDest(dest, assetsDir) {
  const raw = String(dest || '').trim();
  if (/^(https?:|mailto:)/i.test(raw)) return { kind: 'url', value: raw };
  if (/^data:/i.test(raw)) return { kind: 'data', value: raw };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('\\')) return { kind: 'other', value: raw };
  const decoded = decodeDest(raw).replace(/\\/g, '/').replace(/^\.\//, '');
  if (assetsDir) {
    const prefix = `${assetsDir}/`;
    if (decoded.toLowerCase().startsWith(prefix.toLowerCase())) {
      const name = decoded.slice(prefix.length);
      if (name && !name.includes('/') && name !== '.' && name !== '..') return { kind: 'asset', value: name };
    }
  }
  return { kind: 'relative', value: decoded, raw };
}

const IMG_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function inlineHtml(nodes, o) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += escapeHtml(n.v);
        break;
      case 'br':
        out += '<br>';
        break;
      case 'code':
        out += `<code>${escapeHtml(n.v)}</code>`;
        break;
      case 'wiki': {
        // data-missing: no memo has that title yet (Ctrl+click creates it).
        const missing = o.wikiExists && !o.wikiExists(n.target) ? ' data-missing="1"' : '';
        out += `<a class="wiki" data-wiki="${escapeHtml(n.target)}"${missing}>${escapeHtml(n.label || n.target)}</a>`;
        break;
      }
      case 'strong':
        out += `<strong>${inlineHtml(n.children, o)}</strong>`;
        break;
      case 'em':
        out += `<em>${inlineHtml(n.children, o)}</em>`;
        break;
      case 'del':
        out += `<del>${inlineHtml(n.children, o)}</del>`;
        break;
      case 'link': {
        const d = classifyDest(n.href, o.assetsDir);
        const title = n.title ? ` title="${escapeHtml(n.title)}"` : '';
        const body = inlineHtml(n.children, o);
        if (d.kind === 'url') out += `<a href="${escapeHtml(d.value)}"${title}>${body}</a>`;
        else if (d.kind === 'asset') out += `<a class="attach" data-asset="${escapeHtml(d.value)}"${title}>${body}</a>`;
        else out += `<a data-href="${escapeHtml(d.raw ?? d.value)}"${title}>${body}</a>`;
        break;
      }
      case 'img': {
        const d = classifyDest(n.src, o.assetsDir);
        const alt = ` alt="${escapeHtml(n.alt || '')}"`;
        const title = n.title ? ` title="${escapeHtml(n.title)}"` : '';
        const key = d.kind === 'asset' ? `asset:${d.value}` : d.kind === 'relative' ? `rel:${d.value}` : null;
        const data = d.kind === 'data' ? (IMG_DATA.test(d.value) ? d.value : null) : key ? o.images?.get(key) || null : null;
        const src = data ? ` src="${escapeHtml(data)}"` : '';
        const missing = data ? '' : ' data-missing="1"';
        if (d.kind === 'asset') out += `<img data-asset="${escapeHtml(d.value)}"${src}${alt}${title}${missing}>`;
        else out += `<img data-src="${escapeHtml(d.raw ?? d.value)}"${src}${alt}${title}${missing}>`;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function blocksHtml(blocks, o) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'heading':
        out += `<h${b.level}>${inlineHtml(b.children, o) || '<br>'}</h${b.level}>`;
        break;
      case 'para':
        out += `<p>${inlineHtml(b.children, o) || '<br>'}</p>`;
        break;
      case 'code':
        out += `<pre${b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : ''}><code>${escapeHtml(b.text)}${b.text.endsWith('\n') || !b.text ? '\n' : ''}</code></pre>`;
        break;
      case 'quote':
        out += `<blockquote>${blocksHtml(b.children, o) || '<p><br></p>'}</blockquote>`;
        break;
      case 'hr':
        out += '<hr>';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const task = b.items.some((it) => it.checked !== null);
        const attrs = (b.ordered && b.start !== 1 ? ` start="${b.start}"` : '') + (task ? ' class="task"' : '');
        out += `<${tag}${attrs}>`;
        for (const it of b.items) {
          const box = it.checked === null ? '' : `<input type="checkbox"${it.checked ? ' checked' : ''} contenteditable="false">`;
          const liAttr = it.checked === null ? '' : ` class="task" data-task="${it.checked ? 'x' : ' '}"`;
          // A tight item (one paragraph, maybe a nested list) shows its text without <p>.
          let inner = '';
          it.children.forEach((c, k) => {
            inner += k === 0 && c.t === 'para' ? inlineHtml(c.children, o) : blocksHtml([c], o);
          });
          out += `<li${liAttr}>${box}${inner || '<br>'}</li>`;
        }
        out += `</${tag}>`;
        break;
      }
      case 'table': {
        const al = (k) => (b.align[k] ? ` data-align="${b.align[k]}"` : '');
        out += '<table><thead><tr>';
        b.head.forEach((c, k) => (out += `<th${al(k)}>${inlineHtml(c, o) || '<br>'}</th>`));
        out += '</tr></thead><tbody>';
        for (const row of b.rows) {
          out += '<tr>';
          row.forEach((c, k) => (out += `<td${al(k)}>${inlineHtml(c, o) || '<br>'}</td>`));
          out += '</tr>';
        }
        out += '</tbody></table>';
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Image references of an AST: [{ key: 'asset:<name>' | 'rel:<path>', kind, value }]. */
function imageRefs(blocks, assetsDir) {
  const refs = new Map();
  const walkInline = (nodes) => {
    for (const n of nodes) {
      if (n.t === 'img') {
        const d = classifyDest(n.src, assetsDir);
        if (d.kind === 'asset' || d.kind === 'relative') refs.set(`${d.kind === 'asset' ? 'asset' : 'rel'}:${d.value}`, d);
      } else if (n.children) walkInline(n.children);
    }
  };
  const walk = (bs) => {
    for (const b of bs) {
      if (b.t === 'heading' || b.t === 'para') walkInline(b.children);
      else if (b.t === 'quote') walk(b.children);
      else if (b.t === 'list') b.items.forEach((it) => walk(it.children));
      else if (b.t === 'table') [b.head, ...b.rows].forEach((row) => row.forEach(walkInline));
    }
  };
  walk(blocks);
  return [...refs.entries()].map(([key, d]) => ({ key, ...d }));
}

/** @param {{ assetsDir?: string, images?: Map<string, string> }} o */
function renderHtml(blocks, o = {}) {
  return blocksHtml(blocks, o);
}

/** Plain text of a Markdown body (for the list's preview and search). */
function toPlainText(md) {
  const walk = (bs) =>
    bs
      .map((b) => {
        if (b.t === 'heading' || b.t === 'para') return plainText(b.children);
        if (b.t === 'code') return b.text;
        if (b.t === 'quote') return walk(b.children);
        if (b.t === 'list') return b.items.map((it) => walk(it.children)).join('\n');
        if (b.t === 'table') return [b.head, ...b.rows].map((r) => r.map(plainText).join(' ')).join('\n');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  return walk(parse(md));
}

// ---------------------------------------------------------------------------------------------------------------
// Editor tree -> Markdown

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section', 'article', 'header', 'footer', 'figure']);
const SKIP_TAGS = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'head', 'title', 'meta', 'link', 'svg', 'math', 'button', 'select', 'textarea']);

const isEl = (n, ...tags) => n && n.type === 'element' && (tags.length === 0 || tags.includes(n.tag));
const attr = (n, name) => (n.attrs && n.attrs[name] != null ? String(n.attrs[name]) : null);
const isBlock = (n) => isEl(n) && BLOCK_TAGS.has(n.tag);

function textOf(n) {
  if (n.type === 'text') return n.value;
  if (!isEl(n) || SKIP_TAGS.has(n.tag)) return '';
  if (n.tag === 'br') return '\n';
  const inner = (n.children || []).map(textOf).join('');
  return isBlock(n) && n.tag !== 'pre' ? `${inner}\n` : inner;
}

/** Escapes text so that it reads back as the same text. */
function escapeText(s, { lineStart }) {
  let out = s
    .replace(/\\/g, '\\\\')
    .replace(/[*`]/g, '\\$&')
    .replace(/~~/g, '\\~\\~')
    .replace(/\](?=\()/g, '\\]')
    .replace(/&(?=#?[a-z0-9]+;)/gi, '\\&')
    .replace(/<(?=(?:https?:|mailto:))/gi, '\\<');
  // "_" only opens or closes emphasis next to a space or punctuation (never inside a word).
  out = out.replace(/_/g, (m, i, str) => {
    const a = str[i - 1];
    const b = str[i + 1];
    return a && b && /[\p{L}\p{N}]/u.test(a) && /[\p{L}\p{N}]/u.test(b) ? '_' : '\\_';
  });
  if (lineStart) {
    out = out
      .replace(/^(\s*)([#>+=])/, '$1\\$2')
      .replace(/^(\s*)-(?=\s|$|-)/, '$1\\-')
      .replace(/^(\s*)(\d{1,9})([.)])(?=\s|$)/, '$1$2\\$3')
      .replace(/^(\s*)\[([ xX])\]/, '$1\\[$2]');
  }
  return out;
}

/** Inline Markdown of a node list (marks, links, images, code). */
function inlineMd(nodes, o, state = { lineStart: true }) {
  let out = '';
  const push = (s) => {
    if (!s) return;
    out += s;
    state.lineStart = s.endsWith('\n');
  };
  for (const n of nodes) {
    if (n.type === 'text') {
      const parts = n.value.replace(/\u00a0/g, ' ').replace(/[\r\u200b]/g, '').split('\n');
      parts.forEach((p, k) => {
        if (k > 0) push('\n');
        if (p) push(escapeText(p, { lineStart: state.lineStart && !o.inTable }));
      });
      continue;
    }
    if (!isEl(n) || SKIP_TAGS.has(n.tag)) continue;
    const tag = n.tag;
    if (tag === 'br') {
      push(o.inTable ? ' ' : '\n');
      continue;
    }
    if (tag === 'input') continue;
    if (tag === 'img') {
      const asset = attr(n, 'data-asset');
      const src = asset ? `${o.assetsDir}/${asset}` : attr(n, 'data-src');
      if (!src) continue;
      const alt = (attr(n, 'alt') || '').replace(/[[\]\\]/g, '\\$&');
      const title = attr(n, 'title');
      push(`![${alt}](${asset || needsEncoding(src) ? encodeDest(src) : src}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`);
      continue;
    }
    if (tag === 'code' && !o.inPre) {
      const code = textOf(n).replace(/\n/g, ' ').replace(/\u200b/g, '');
      if (!code) continue;
      const longest = Math.max(0, ...(code.match(/`+/g) || []).map((r) => r.length));
      const fence = '`'.repeat(longest + 1);
      const pad = code.startsWith('`') || code.endsWith('`') || (code.startsWith(' ') && code.endsWith(' ') && code.trim()) ? ' ' : '';
      push(`${fence}${pad}${code}${pad}${fence}`);
      continue;
    }
    if (tag === 'a' && attr(n, 'data-wiki')) {
      // [[target]], or [[target|글자]] when the shown text was changed.
      const clean = (s) => String(s).replace(/[[\]|\n\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
      const target = clean(attr(n, 'data-wiki'));
      const label = clean(textOf(n).replace(/\u00a0/g, ' '));
      if (!target) {
        push(escapeText(label, { lineStart: false }));
        continue;
      }
      push(label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`);
      continue;
    }
    if (tag === 'a') {
      const asset = attr(n, 'data-asset');
      const href = asset ? `${o.assetsDir}/${asset}` : attr(n, 'href') || attr(n, 'data-href');
      const label = inlineMd(n.children || [], o, { lineStart: false });
      if (!href) {
        push(label);
        continue;
      }
      const plain = textOf(n);
      if (!asset && plain === href && /^https?:\/\/[^\s<>]+$/i.test(href) && !/[.,:;!?'"*_~)]$/.test(href) && !/[*~`\\[\]]/.test(href)) {
        push(href);
        continue;
      }
      const title = attr(n, 'title');
      const dest = asset || needsEncoding(href) ? encodeDest(href) : href;
      push(`[${label || plain || href}](${dest}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`);
      continue;
    }
    const mark = { strong: '**', b: '**', em: '*', i: '*', del: '~~', s: '~~', strike: '~~' }[tag];
    if (mark) {
      const inner = inlineMd(n.children || [], o, { lineStart: false });
      if (!inner.trim()) {
        push(inner);
        continue;
      }
      // Markers must touch the text: move surrounding spaces outside.
      const lead = inner.match(/^\s*/)[0];
      const trail = inner.match(/\s*$/)[0];
      push(`${lead}${mark}${inner.trim()}${mark}${trail}`);
      continue;
    }
    if (tag === 'span' && /(^|;)\s*font-weight\s*:\s*(bold|[6-9]00)/i.test(attr(n, 'style') || '')) {
      push(inlineMd([{ type: 'element', tag: 'b', attrs: {}, children: n.children || [] }], o, state));
      continue;
    }
    // Anything else (span, font, u, a block inside inline content...): its content.
    push(inlineMd(n.children || [], o, state));
  }
  return out;
}

/** Splits a node list into blocks: block elements as they are, runs of inline nodes as paragraphs. */
function groupBlocks(nodes) {
  const groups = [];
  let run = [];
  const end = () => {
    if (run.length) groups.push({ type: 'element', tag: 'p', attrs: {}, children: run, implicit: true });
    run = [];
  };
  for (const n of nodes) {
    if (isBlock(n)) {
      end();
      groups.push(n);
    } else if (!(n.type === 'text' && !n.value.trim() && !run.length)) run.push(n);
  }
  end();
  return groups;
}

const trimBreaks = (s) => s.replace(/^\n+/, '').replace(/[ \n]+$/, '');

function indentLines(text, prefix, first = prefix) {
  return text
    .split('\n')
    .map((l, k) => (k === 0 ? first + l : l ? prefix + l : ''))
    .join('\n');
}

function listMd(n, o) {
  const ordered = n.tag === 'ol';
  let num = ordered ? parseInt(attr(n, 'start') || '1', 10) || 1 : 0;
  const items = [];
  const marker = ordered ? (o.altList ? ')' : '.') : o.altList ? '*' : '-';
  for (const child of n.children || []) {
    if (isEl(child, 'ul', 'ol')) {
      // Chromium nests an indented list directly in the list: it belongs to the item before it.
      const nested = listMd(child, { ...o, altList: false });
      if (items.length) items[items.length - 1].extra.push({ text: nested, loose: false });
      else items.push({ head: '', extra: [{ text: nested, loose: false }], box: null });
      continue;
    }
    if (!isEl(child, 'li')) {
      if (child.type === 'text' && !child.value.trim()) continue;
      items.push({ head: inlineMd([child], o), extra: [], box: null });
      continue;
    }
    const kids = child.children || [];
    const cb = kids.find((k) => isEl(k, 'input') && (attr(k, 'type') || '').toLowerCase() === 'checkbox');
    const dataTask = attr(child, 'data-task');
    let box = null;
    if (cb) box = cb.attrs.checked != null && cb.attrs.checked !== false;
    else if (dataTask !== null) box = dataTask.trim() !== '';
    const blocks = groupBlocks(kids.filter((k) => k !== cb));
    let head = '';
    const extra = [];
    blocks.forEach((b, k) => {
      if (k === 0 && (b.implicit || isEl(b, 'p', 'div'))) head = trimBreaks(inlineMd(b.children || [], o));
      else {
        // Nested lists follow the item line directly; other blocks (paragraphs, code...) after a blank line.
        const text = blockMd(b, o);
        if (text) extra.push({ text, loose: !isEl(b, 'ul', 'ol') });
      }
    });
    items.push({ head, extra, box });
  }
  const lines = items.map((it) => {
    const m = ordered ? `${num++}${marker} ` : `${marker} `;
    const box = it.box === null ? '' : it.box ? '[x] ' : '[ ] ';
    const pad = ' '.repeat(m.length);
    let text = indentLines(it.head || '', pad, m + box);
    if (!it.head && !box) text = m.trimEnd();
    else if (!it.head) text = (m + box).trimEnd();
    for (const e of it.extra) text += `${e.loose ? '\n\n' : '\n'}${indentLines(e.text, pad)}`;
    return text;
  });
  return lines.join('\n');
}

function tableMd(n, o) {
  const rows = [];
  const walk = (x) => {
    for (const c of x.children || []) {
      if (isEl(c, 'tr')) rows.push(c);
      else if (isEl(c, 'thead', 'tbody', 'tfoot')) walk(c);
    }
  };
  walk(n);
  if (!rows.length) return '';
  const cellsOf = (tr) => (tr.children || []).filter((c) => isEl(c, 'th', 'td'));
  const width = Math.max(...rows.map((r) => cellsOf(r).length), 1);
  const cellMd = (c) =>
    trimBreaks(inlineMd(c ? c.children || [] : [], { ...o, inTable: true }))
      .replace(/\n/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
  const line = (tr) => {
    const cells = cellsOf(tr);
    const out = [];
    for (let k = 0; k < width; k++) out.push(cellMd(cells[k]));
    return `| ${out.join(' | ')} |`;
  };
  const align = cellsOf(rows[0]).map((c) => attr(c, 'data-align') || '');
  while (align.length < width) align.push('');
  const delim = `| ${align.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---')).join(' | ')} |`;
  return [line(rows[0]), delim, ...rows.slice(1).map(line)].join('\n');
}

function blockMd(n, o) {
  if (!isEl(n)) return trimBreaks(inlineMd([n], o));
  const tag = n.tag;
  if (/^h[1-6]$/.test(tag)) {
    const text = trimBreaks(inlineMd(n.children || [], { ...o }, { lineStart: false })).replace(/\n/g, ' ');
    return text ? `${'#'.repeat(Number(tag[1]))} ${text}` : '';
  }
  if (tag === 'hr') return '---';
  if (tag === 'pre') {
    let code = textOf(n).replace(/\u00a0/g, ' ');
    if (code.endsWith('\n')) code = code.slice(0, -1);
    const longest = Math.max(2, ...(code.match(/`+/g) || []).map((r) => r.length));
    const fence = '`'.repeat(longest + 1);
    const lang = (attr(n, 'data-lang') || '').replace(/[`\s]/g, '');
    return `${fence}${lang}\n${code}\n${fence}`;
  }
  if (tag === 'blockquote') {
    const inner = blocksMd(n.children || [], o);
    return inner ? inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : '';
  }
  if (tag === 'ul' || tag === 'ol') return listMd(n, o);
  if (tag === 'table') return tableMd(n, o);
  if (tag === 'li') return listMd({ type: 'element', tag: 'ul', attrs: {}, children: [n] }, o);
  if (tag === 'p' || tag === 'div' || n.implicit) {
    const kids = n.children || [];
    if (kids.some(isBlock)) return blocksMd(kids, o);
    const text = trimBreaks(inlineMd(kids, o));
    if (!text.trim()) return n.implicit ? '' : '&nbsp;';
    return text;
  }
  return blocksMd(n.children || [], o);
}

function blocksMd(nodes, o) {
  const parts = [];
  let prevTag = null;
  for (const b of groupBlocks(nodes)) {
    // Two lists of the same kind in a row would read back as one list: the second uses the other marker.
    const alt = (b.tag === 'ul' || b.tag === 'ol') && prevTag === b.tag && !o.altList;
    const md = blockMd(b, alt ? { ...o, altList: true } : { ...o, altList: false });
    prevTag = isEl(b) ? b.tag : null;
    if (md === '') continue;
    parts.push(md);
  }
  // Trailing empty paragraphs are only the editor's caret line.
  while (parts.length && parts[parts.length - 1] === '&nbsp;') parts.pop();
  return parts.join('\n\n');
}

/**
 * The editor's content as Markdown.
 * @param {{ type: 'root'|'element', children: object[] }} tree  DOM-like tree ({ type: 'element', tag, attrs, children } / { type: 'text', value })
 * @param {{ assetsDir: string }} o  this memo's assets folder name ("<title>.assets") for data-asset references
 */
function toMarkdown(tree, o = {}) {
  const md = blocksMd(tree.children || [], { assetsDir: o.assetsDir || 'assets' });
  return md ? `${md}\n` : '';
}

/** Markdown for plain text (a .txt memo turned into .md): every line kept, nothing interpreted. */
function textToMarkdown(text) {
  const paras = String(text).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '').split(/\n{2,}/);
  return (
    paras
      .map((p) =>
        p
          .split('\n')
          .map((l) => escapeText(l.trim(), { lineStart: true }))
          .join('\n'),
      )
      .filter((p) => p.trim())
      .join('\n\n') + '\n'
  );
}

module.exports = {
  parse,
  parseInline,
  renderHtml,
  imageRefs,
  toMarkdown,
  toPlainText,
  textToMarkdown,
  splitFrontMatter,
  joinFrontMatter,
  classifyDest,
  encodeDest,
  escapeHtml,
  FM_KEY,
  wikiKey,
  collectLinks,
  relinkTitle,
};
