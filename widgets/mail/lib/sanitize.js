// Mail HTML for the isolated preview (#65). Defense in depth: the preview view already runs with JavaScript
// off, sandboxed, in its own in-memory session that blocks remote requests, under a CSP that blocks every
// remote load; this allow-list sanitizer additionally drops scripts, frames, objects, forms, event handler
// attributes and non-http(s)/mailto links before the HTML gets there. Remote images stay blocked until the
// user presses "이미지 표시" for that message.

// Elements kept (their attributes filtered below).
const ALLOWED = new Set(
  (
    'a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em ' +
    'figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd label li main mark nav ol p pre q rp rt ruby s samp section ' +
    'small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr'
  ).split(' '),
);
// Elements dropped together with everything inside them.
const DROP_WITH_CONTENT = new Set('script iframe frame frameset object embed applet svg math template noembed noframes xmp textarea select option title head-script canvas audio video picture source track map area portal'.split(' '));
const VOID = new Set('br hr img col wbr'.split(' '));
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'template']);

const ATTRS = new Set(
  'align alt bgcolor border cellpadding cellspacing class color cols colspan dir face frame headers height hspace lang nowrap rowspan rules scope size span start summary title type valign vspace width style href src background datetime open'.split(' '),
);

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' };

/** Decodes character references (enough to see through "&#106;avascript:" tricks and for text output). */
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    const v = ENTITY[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

/** A link the preview may hand to the system after a click: http, https and mailto only. */
function isOpenableLink(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/** URL attribute values: control characters and whitespace removed before the scheme check. */
const cleanUrl = (v) => decodeEntities(v).replace(/[\u0000- \u007f-\u009f]/g, '');

/** Inline CSS without script-ish constructs; url() only for data:image and http(s) (still CSP-gated). */
function sanitizeCss(css) {
  let out = String(css)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\/g, '') // CSS escapes are how "expression" and "javascript" get hidden
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'x(')
    .replace(/(-moz-binding|behavior)\s*:/gi, 'x-blocked:')
    .replace(/javascript\s*:/gi, '');
  out = out.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, url) => {
    const u = url.trim();
    if (/^data:image\//i.test(u) || /^https?:/i.test(u)) return `url("${u.replace(/["()]/g, '')}")`;
    return 'none';
  });
  return out;
}

/** Tokenizes HTML: [{ type: 'text'|'open'|'close', name, attrs, raw }] (comments, doctype, PIs dropped). */
function tokenize(html) {
  const s = String(html || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out.push({ type: 'text', raw: s.slice(i) });
      break;
    }
    if (lt > i) out.push({ type: 'text', raw: s.slice(i, lt) });
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      const end = s.indexOf('>', lt);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(s.slice(lt, lt + 80));
    if (!m) {
      out.push({ type: 'text', raw: '<' });
      i = lt + 1;
      continue;
    }
    // Find the tag end, honouring quoted attribute values.
    let j = lt + m[0].length;
    let quoteCh = null;
    for (; j < s.length; j++) {
      const c = s[j];
      if (quoteCh) {
        if (c === quoteCh) quoteCh = null;
      } else if (c === '"' || c === "'") quoteCh = c;
      else if (c === '>') break;
    }
    const inner = s.slice(lt + m[0].length, j);
    const name = m[2].toLowerCase();
    i = j + 1;
    if (m[1]) {
      out.push({ type: 'close', name });
      continue;
    }
    out.push({ type: 'open', name, attrs: parseAttrs(inner), selfClosing: /\/\s*$/.test(inner) });
    if (RAW_TEXT.has(name) || name === 'style') {
      const close = s.toLowerCase().indexOf(`</${name}`, i);
      const end = close < 0 ? s.length : close;
      out.push({ type: 'raw', name, raw: s.slice(i, end) });
      const gt = close < 0 ? -1 : s.indexOf('>', close);
      out.push({ type: 'close', name });
      i = gt < 0 ? s.length : gt + 1;
    }
  }
  return out;
}

function parseAttrs(inner) {
  const attrs = [];
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(inner))) attrs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  return attrs;
}

/**
 * Sanitizes mail HTML. opts.cid: { contentId: dataUrl } for inline images.
 * Returns { html, remoteImages } (remoteImages: how many remote image references the message has).
 */
function sanitizeHtml(html, opts = {}) {
  const cid = opts.cid || {};
  const out = [];
  const styles = [];
  const stack = [];
  let dropDepth = 0;
  let dropName = null;
  let remoteImages = 0;

  const remoteRef = (v) => /^https?:/i.test(v);
  for (const t of tokenize(html)) {
    if (dropDepth) {
      if (t.type === 'open' && t.name === dropName && !t.selfClosing) dropDepth++;
      if (t.type === 'close' && t.name === dropName) dropDepth--;
      continue;
    }
    if (t.type === 'text') {
      out.push(escapeText(decodeEntities(t.raw)));
      continue;
    }
    if (t.type === 'raw') {
      if (t.name === 'style') styles.push(sanitizeCss(t.raw));
      continue;
    }
    if (t.type === 'open') {
      if (DROP_WITH_CONTENT.has(t.name)) {
        if (!t.selfClosing && !VOID.has(t.name) && !RAW_TEXT.has(t.name)) {
          dropDepth = 1;
          dropName = t.name;
        }
        continue;
      }
      if (t.name === 'style') continue; // content arrives as the raw token
      if (!ALLOWED.has(t.name)) continue; // unknown / unsafe tag: dropped, its children kept (form, input, body, ...)
      const attrs = [];
      for (const [name, value] of t.attrs) {
        if (!ATTRS.has(name)) continue; // on*, id, srcset, formaction, ... never pass
        if (name === 'href') {
          if (t.name !== 'a') continue;
          const url = cleanUrl(value);
          if (!isOpenableLink(url)) continue;
          attrs.push(['href', url]);
        } else if (name === 'src') {
          if (t.name !== 'img') continue;
          const url = cleanUrl(value);
          if (/^cid:/i.test(url)) {
            const data = cid[url.slice(4).replace(/^<|>$/g, '')];
            if (data) attrs.push(['src', data]);
          } else if (/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(url)) attrs.push(['src', url]);
          else if (remoteRef(url)) {
            remoteImages++;
            attrs.push(['src', url]); // blocked by CSP and the session filter until "이미지 표시"
          }
        } else if (name === 'background') {
          const url = cleanUrl(value);
          if (remoteRef(url)) {
            remoteImages++;
            attrs.push(['background', url]);
          }
        } else if (name === 'style') {
          if (/url\s*\(\s*['"]?\s*https?:/i.test(value)) remoteImages++;
          attrs.push(['style', sanitizeCss(decodeEntities(value))]);
        } else attrs.push([name, decodeEntities(value)]);
      }
      if (t.name === 'a') attrs.push(['rel', 'noreferrer noopener']);
      out.push(`<${t.name}${attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')}>`);
      if (!VOID.has(t.name) && !t.selfClosing) stack.push(t.name);
      continue;
    }
    if (t.type === 'close') {
      if (!ALLOWED.has(t.name) || VOID.has(t.name)) continue;
      const at = stack.lastIndexOf(t.name);
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
    }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  for (const css of styles) if (/url\s*\(\s*"https?:/i.test(css)) remoteImages++;
  const styleBlock = styles.length ? `<style>${styles.join('\n').replace(/<\//g, '<\\/')}</style>` : '';
  return { html: styleBlock + out.join(''), remoteImages };
}

/** HTML -> readable plain text (for snippets and the theme's text preview). */
function htmlToText(html) {
  const parts = [];
  let skip = 0;
  let skipName = null;
  for (const t of tokenize(html)) {
    if (skip) {
      if (t.type === 'close' && t.name === skipName) skip = 0;
      continue;
    }
    if (t.type === 'raw') continue;
    if (t.type === 'open') {
      if (DROP_WITH_CONTENT.has(t.name) && !t.selfClosing && !VOID.has(t.name) && !RAW_TEXT.has(t.name)) {
        skip = 1;
        skipName = t.name;
      } else if (t.name === 'br') parts.push('\n');
      else if (t.name === 'li') parts.push('\n• ');
      else if (/^(p|div|tr|h[1-6]|table|blockquote|pre|ul|ol|hr|section|article|header|footer)$/.test(t.name)) parts.push('\n');
      else if (t.name === 'td' || t.name === 'th') parts.push(' ');
      continue;
    }
    if (t.type === 'close') {
      if (/^(p|div|tr|h[1-6]|table|blockquote|pre|ul|ol|section|article)$/.test(t.name)) parts.push('\n');
      continue;
    }
    parts.push(decodeEntities(t.raw.replace(/\s+/g, ' ')));
  }
  return parts
    .join('')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text mail -> HTML (escaped, http(s) links clickable, line breaks kept). */
function textToHtml(text) {
  const escaped = escapeText(String(text || ''));
  const linked = escaped.replace(/\bhttps?:\/\/[^\s<>"']+/g, (u) => {
    const clean = u.replace(/[.,);\]]+$/, '');
    return `<a href="${clean.replace(/"/g, '&quot;')}" rel="noreferrer noopener">${clean}</a>${u.slice(clean.length)}`;
  });
  return `<pre class="plain">${linked}</pre>`;
}

/** One line for the list: whitespace collapsed, cut at max characters. */
function snippetOf(text, max = 160) {
  const s = String(text || '')
    .replace(/^>.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The CSP of a preview document: nothing remote, unless the user allowed this message's images. */
function previewCsp(allowRemote) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${allowRemote ? ' https: http:' : ''}`,
    'font-src data:',
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const PREVIEW_STYLE =
  "html{background:#fff;color:#1d1f23}body{margin:14px 16px;font:14px/1.55 'Segoe UI','Malgun Gothic',sans-serif;word-wrap:break-word;overflow-wrap:anywhere}" +
  'img{max-width:100%;height:auto}pre.plain{white-space:pre-wrap;font:inherit;margin:0}blockquote{margin:0 0 0 8px;padding-left:10px;border-left:3px solid #ccd}a{color:#1a5fd0}';

/** The whole preview document (sanitized body + CSP meta). */
function buildDocument(bodyHtml, { allowRemote = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewCsp(allowRemote)}"><meta name="referrer" content="no-referrer"><style>${PREVIEW_STYLE}</style></head><body>${bodyHtml}</body></html>`;
}

module.exports = { sanitizeHtml, sanitizeCss, htmlToText, textToHtml, snippetOf, decodeEntities, isOpenableLink, previewCsp, buildDocument, tokenize };
