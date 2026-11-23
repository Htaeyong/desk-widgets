// Draws an answer's Markdown (#129) from the parser's tree (chat/markdown-parse.js) with elements and text nodes only: nothing here
// sets HTML, so raw HTML in an answer stays the text it is. No image is loaded: an image shows as its words and address. A link is
// not an <a>: http and https links become marked text that chat.js opens only after showing the full address; any other link is
// just its words with the address beside it.
window.AiChatMarkdownView = (() => {
  const MAX_DEPTH = 24; // deeper nesting is shown as plain text
  const MAX_LENGTH = 400000; // longer answers are shown as plain text rather than parsed on every redraw

  const el = (tag, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };
  const text = (value) => document.createTextNode(String(value ?? ''));
  const webAddress = (href) => {
    try {
      const url = new URL(String(href));
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };

  function inline(nodes, parent, depth) {
    for (const n of nodes || []) {
      if (depth > MAX_DEPTH) {
        parent.append(text(n.v ?? ''));
        continue;
      }
      switch (n.t) {
        case 'text':
          parent.append(text(n.v));
          break;
        case 'br':
          parent.append(el('br'));
          break;
        case 'code': {
          const code = el('code', 'md-code');
          code.textContent = n.v;
          parent.append(code);
          break;
        }
        case 'strong':
        case 'em':
        case 'del': {
          const node = el(n.t);
          inline(n.children, node, depth + 1);
          parent.append(node);
          break;
        }
        case 'wiki':
          parent.append(text(`[[${n.target}${n.label ? `|${n.label}` : ''}]]`));
          break;
        case 'link': {
          const href = webAddress(n.href);
          if (href) {
            const link = el('span', 'md-link');
            link.dataset.url = href;
            link.title = href;
            link.tabIndex = 0;
            link.setAttribute('role', 'link');
            inline(n.children, link, depth + 1);
            parent.append(link);
          } else {
            inline(n.children, parent, depth + 1);
            const where = el('span', 'md-dead');
            where.textContent = ` (${n.href})`;
            parent.append(where);
          }
          break;
        }
        case 'img': {
          const img = el('span', 'md-img');
          img.textContent = `[이미지${n.alt ? `: ${n.alt}` : ''}] ${n.src}`;
          parent.append(img);
          break;
        }
        default:
          if (n.v) parent.append(text(n.v));
          else if (n.children) inline(n.children, parent, depth + 1);
      }
    }
  }

  function blocks(list, parent, depth) {
    for (const b of list || []) {
      if (depth > MAX_DEPTH) {
        parent.append(text(JSON.stringify(b.text ?? '')));
        continue;
      }
      switch (b.t) {
        case 'heading': {
          const h = el(b.level <= 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5', 'md-h');
          inline(b.children, h, depth + 1);
          parent.append(h);
          break;
        }
        case 'para': {
          const p = el('p', 'md-p');
          inline(b.children, p, depth + 1);
          parent.append(p);
          break;
        }
        case 'code': {
          const pre = el('pre', 'md-pre');
          const code = el('code');
          code.textContent = b.text;
          pre.append(code);
          parent.append(pre);
          break;
        }
        case 'quote': {
          const q = el('blockquote', 'md-quote');
          blocks(b.children, q, depth + 1);
          parent.append(q);
          break;
        }
        case 'hr':
          parent.append(el('hr', 'md-hr'));
          break;
        case 'list': {
          const tasks = b.items.some((it) => it.checked !== null);
          const list = el(b.ordered ? 'ol' : 'ul', tasks ? 'md-list md-tasks' : 'md-list');
          if (b.ordered && b.start !== 1) list.start = b.start;
          for (const it of b.items) {
            const li = el('li');
            if (it.checked !== null) {
              const box = el('span', it.checked ? 'md-check done' : 'md-check');
              box.textContent = it.checked ? '☑ ' : '☐ ';
              li.append(box);
            }
            it.children.forEach((c, k) => {
              if (k === 0 && c.t === 'para') inline(c.children, li, depth + 1);
              else blocks([c], li, depth + 1);
            });
            list.append(li);
          }
          parent.append(list);
          break;
        }
        case 'table': {
          const wrap = el('div', 'md-table-wrap');
          const table = el('table', 'md-table');
          const cell = (tag, content, k) => {
            const c = el(tag);
            if (b.align[k] === 'left' || b.align[k] === 'center' || b.align[k] === 'right') c.style.textAlign = b.align[k];
            inline(content, c, depth + 1);
            if (c.textContent.length <= 24 && !c.textContent.includes('\n')) c.classList.add('md-short');
            return c;
          };
          const head = el('thead');
          const hr = el('tr');
          b.head.forEach((c, k) => hr.append(cell('th', c, k)));
          head.append(hr);
          const body = el('tbody');
          for (const row of b.rows) {
            const tr = el('tr');
            row.forEach((c, k) => tr.append(cell('td', c, k)));
            body.append(tr);
          }
          table.append(head, body);
          wrap.append(table);
          parent.append(wrap);
          break;
        }
        default:
          break;
      }
    }
  }

  /** A fragment for this Markdown. If the text is huge or the parser fails, the text as it is. */
  function render(markdown) {
    const fragment = document.createDocumentFragment();
    const source = String(markdown ?? '');
    if (source.length > MAX_LENGTH) {
      fragment.append(text(source));
      return fragment;
    }
    try {
      blocks(window.AiChatMarkdown.parse(source), fragment, 0);
    } catch {
      fragment.replaceChildren(text(source));
    }
    return fragment;
  }

  return { render, webAddress };
})();
