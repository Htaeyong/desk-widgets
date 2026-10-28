// A small HTML parser and an allow-list sanitizer for the memo editor (#75). Everything shown in a memo window goes
// through sanitizeHtml(): only the elements and attributes the editor uses survive, links only for http(s)/mailto,
// images only as inline data: images (the widget reads them from the memo's own folder), no scripts, styles or
// event handlers. The window's CSP (no remote loads, scripts only from the package) is the second line.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[name.toLowerCase()] ?? m;
  });
}

/** HTML -> { type: 'root', children } of { type: 'element', tag, attrs, children } / { type: 'text', value }. */
function parseHtml(html) {
  const s = String(html);
  const root = { type: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const text = (v) => {
    if (!v) return;
    const kids = top().children;
    const last = kids[kids.length - 1];
    if (last && last.type === 'text') last.value += v;
    else kids.push({ type: 'text', value: v });
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      text(decodeEntities(s.slice(i)));
      break;
    }
    if (lt > i) text(decodeEntities(s.slice(i, lt)));
    i = lt;
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      const end = s.indexOf('>', i);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    const close = s.slice(i).match(/^<\/([a-zA-Z][\w:-]*)[^>]*>/);
    if (close) {
      const tag = close[1].toLowerCase();
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      i += close[0].length;
      continue;
    }
    const open = s.slice(i).match(/^<([a-zA-Z][\w:-]*)/);
    if (!open) {
      text('<');
      i++;
      continue;
    }
    const tag = open[1].toLowerCase();
    i += open[0].length;
    const attrs = {};
    // Attributes until ">" (quotes may hold ">").
    for (;;) {
      const m = s.slice(i).match(/^[\s/]*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/);
      if (!m || !m[1]) break;
      const name = m[1].toLowerCase();
      if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
      i += m[0].length;
    }
    const end = s.indexOf('>', i);
    const selfClosing = end > 0 && s[end - 1] === '/';
    i = end < 0 ? s.length : end + 1;
    const el = { type: 'element', tag, attrs, children: [] };
    top().children.push(el);
    if (RAW_TEXT.has(tag)) {
      const endTag = s.toLowerCase().indexOf(`</${tag}`, i);
      const raw = s.slice(i, endTag < 0 ? s.length : endTag);
      if (raw) el.children.push({ type: 'text', value: tag === 'textarea' || tag === 'title' ? decodeEntities(raw) : raw });
      const gt = endTag < 0 ? -1 : s.indexOf('>', endTag);
      i = gt < 0 ? s.length : gt + 1;
      continue;
    }
    if (!VOID.has(tag) && !selfClosing) stack.push(el);
  }
  return root;
}

const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

function serialize(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += escapeText(n.value);
    else if (n.type === 'element') {
      const attrs = Object.entries(n.attrs || {})
        .map(([k, v]) => (v === '' && (k === 'checked' || k === 'disabled') ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
        .join('');
      out += `<${n.tag}${attrs}>`;
      if (!VOID.has(n.tag)) out += `${serialize(n.children || [])}</${n.tag}>`;
    }
  }
  return out;
}

// Elements the editor uses, with the attributes each may keep.
const ALLOWED = {
  p: [],
  div: [],
  br: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  del: [],
  s: [],
  strike: [],
  code: [],
  pre: ['data-lang'],
  blockquote: [],
  ul: ['class'],
  ol: ['start', 'class'],
  li: ['class', 'data-task'],
  input: ['type', 'checked', 'contenteditable'],
  hr: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['data-align'],
  td: ['data-align'],
  a: ['href', 'title', 'class', 'data-asset', 'data-href', 'data-wiki', 'data-missing'],
  img: ['src', 'alt', 'title', 'data-asset', 'data-src', 'data-missing'],
  span: [],
};
// Dropped with everything inside them.
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'applet', 'template', 'noscript', 'svg', 'math', 'link', 'meta', 'base', 'form', 'button', 'select', 'textarea', 'title', 'head', 'audio', 'video', 'canvas', 'portal', 'webview']);

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const SAFE_IMG = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
const CLASS_OK = { ul: ['task'], ol: ['task'], li: ['task'], a: ['attach', 'wiki'] };

function cleanAttrs(tag, attrs) {
  const out = {};
  for (const name of ALLOWED[tag]) {
    if (!(name in attrs)) continue;
    let v = String(attrs[name]);
    if (name === 'href') {
      if (!SAFE_HREF.test(v.trim()) || /[\u0000-\u001f]/.test(v)) continue;
      v = v.trim();
    } else if (name === 'src') {
      v = v.replace(/\s+/g, '');
      if (!SAFE_IMG.test(v)) continue;
    } else if (name === 'type') {
      if (v.toLowerCase() !== 'checkbox') return null;
    } else if (name === 'contenteditable') {
      if (v !== 'false') continue;
    } else if (name === 'start') {
      if (!/^\d{1,9}$/.test(v)) continue;
    } else if (name === 'class') {
      v = v
        .split(/\s+/)
        .filter((c) => (CLASS_OK[tag] || []).includes(c))
        .join(' ');
      if (!v) continue;
    } else if (name === 'data-align') {
      if (!['left', 'right', 'center'].includes(v)) continue;
    } else if (name === 'data-asset') {
      if (!v || /[\\/]/.test(v) || v === '.' || v === '..') continue;
    } else if (name === 'data-wiki') {
      if (!v.trim() || v.length > 200 || /[[\]|\n]/.test(v)) continue;
    } else if (name === 'checked') v = '';
    out[name] = v;
  }
  if (tag === 'input' && out.type !== 'checkbox') return null;
  return out;
}

function sanitizeNodes(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      out.push({ type: 'text', value: n.value });
      continue;
    }
    if (n.type !== 'element' || DROP.has(n.tag)) continue;
    const children = VOID.has(n.tag) ? [] : sanitizeNodes(n.children || []);
    if (!ALLOWED[n.tag]) {
      out.push(...children); // unknown element: keep its content only
      continue;
    }
    const attrs = cleanAttrs(n.tag, n.attrs || {});
    if (attrs === null) continue;
    out.push({ type: 'element', tag: n.tag, attrs, children });
  }
  return out;
}

/** Allow-listed HTML (see the top of this file). */
function sanitizeHtml(html) {
  return serialize(sanitizeNodes(parseHtml(html).children));
}

/** An editor tree from the page (already a plain object) cleaned the same way, before it is turned into Markdown. */
function sanitizeTree(tree) {
  const walk = (nodes, depth) =>
    depth > 64 || !Array.isArray(nodes)
      ? []
      : nodes
          .map((n) =>
            n && n.type === 'text'
              ? { type: 'text', value: String(n.value ?? '') }
              : n && n.type === 'element' && typeof n.tag === 'string'
                ? { type: 'element', tag: n.tag.toLowerCase(), attrs: n.attrs && typeof n.attrs === 'object' ? Object.fromEntries(Object.entries(n.attrs).map(([k, v]) => [String(k).toLowerCase(), String(v)])) : {}, children: walk(n.children, depth + 1) }
                : null,
          )
          .filter(Boolean);
  return { type: 'root', children: walk(tree?.children, 0) };
}

module.exports = { parseHtml, serialize, sanitizeHtml, sanitizeTree, decodeEntities };
