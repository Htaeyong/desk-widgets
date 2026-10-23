// Mail reader page (#65): shows the header of the message the widget sent, keeps the isolated body view
// placed over #body, and turns button presses into actions for the widget. All text via textContent.
(() => {
  const R = window.mailReader;
  const $ = (id) => document.getElementById(id);
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);
  const person = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
  const fmtDate = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  };

  let shown = null;

  // ---- #69 categories (this PC only) ----

  function renderCats() {
    const cats = shown?.categories || [];
    const ids = new Set(shown?.categoryIds || []);
    $('catChips').replaceChildren(
      ...cats.filter((c) => ids.has(c.id)).map((c) => {
        const s = document.createElement('span');
        s.className = 'cat';
        s.textContent = c.name;
        s.style.borderColor = c.color;
        s.style.background = `${c.color}33`;
        return s;
      }),
    );
    $('catList').replaceChildren(
      ...(cats.length
        ? cats.map((c) => {
            const li = document.createElement('li');
            const label = document.createElement('label');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = ids.has(c.id);
            box.addEventListener('change', async () => {
              const next = new Set(shown?.categoryIds || []);
              if (box.checked) next.add(c.id);
              else next.delete(c.id);
              const res = await R.action('setCategories', { ids: [...next] });
              if (res?.ok) {
                shown.categoryIds = res.categoryIds;
                renderCats();
              }
            });
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.background = c.color;
            const name = document.createElement('span');
            name.textContent = c.name;
            label.append(box, dot, name);
            li.append(label);
            return li;
          })
        : [Object.assign(document.createElement('li'), { textContent: '아직 분류가 없습니다. 아래에서 만드세요.' })]),
    );
  }

  $('catToggle').addEventListener('click', () => {
    $('catBox').hidden = !$('catBox').hidden;
    place();
  });
  $('catNew').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('catNewName').value.trim();
    if (!label || !shown) return;
    const res = await R.action('createCategory', { label });
    if (!res?.ok) {
      if (res?.message) showError(res.message);
      return;
    }
    $('catNewName').value = '';
    shown.categories = res.categories;
    const set = await R.action('setCategories', { ids: [...(shown.categoryIds || []), res.category.id] });
    if (set?.ok) shown.categoryIds = set.categoryIds;
    renderCats();
  });

  function show(d) {
    if (!d) return;
    shown = d;
    renderCats();
    $('subject').textContent = d.subject || '(제목 없음)';
    $('from').textContent = person(d.from);
    $('date').textContent = fmtDate(d.date);
    $('toLine').textContent = d.to?.length ? `받는 사람: ${d.to.map(person).join(', ')}` : '';
    $('ccLine').textContent = d.cc?.length ? `참조: ${d.cc.map(person).join(', ')}` : '';
    $('account').textContent = d.accountName ? `계정: ${d.accountName}${d.folder && d.folder !== 'INBOX' ? ` · 메일함: ${d.folder}` : ''}` : '';
    $('bar').style.background = d.color || '#4f8cff';
    $('files').replaceChildren(
      ...(d.attachments || []).map((f) => {
        const li = document.createElement('li');
        li.textContent = `📎 ${f.name} (${fmtSize(f.size)})`;
        li.title = '첨부 파일은 이 버전에서 위젯이 받지 않습니다. 웹메일이나 메일 프로그램에서 여세요.';
        return li;
      }),
    );
    $('imagesNotice').hidden = !(d.remoteImages > 0 && !d.allowRemote);
    $('reducedNotice').hidden = !d.reduced && !d.truncated;
    $('webmailBtn').hidden = !d.hasWebmail;
    $('error').hidden = true;
    $('status').textContent = '';
    place();
  }

  /** Puts the body view over #body (CSS pixels = window DIPs at zoom 1). */
  function place() {
    const r = $('body').getBoundingClientRect();
    R.layout({ x: r.left, y: r.top, width: r.width, height: r.height });
  }

  document.querySelector('.head').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-act]');
    if (!btn) return;
    btn.disabled = true;
    try {
      const res = await R.action(btn.dataset.act, btn.dataset.via ? { via: btn.dataset.via } : {});
      if (res && res.ok === false && res.message) {
        showError(res.message, res.fallback ? { act: btn.dataset.act, via: res.fallback } : null);
      } else if (res?.ok && res.via === 'mailto' && res.note) {
        // Windows may accept the link and still open nothing: say so, with the webmail way next to it.
        showError(res.note, shown?.hasWebmail ? { act: btn.dataset.act, via: 'webmail' } : null);
      } else if (btn.dataset.act === 'copyId' && res?.ok) {
        $('status').textContent = `복사함: ${res.messageId}`;
      }
    } finally {
      btn.disabled = false;
    }
  });

  /** An error line; with retry a button that writes the other way ("웹메일로 쓰기"). */
  function showError(text, retry = null) {
    const box = $('error');
    box.replaceChildren(document.createTextNode(text));
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.act = retry.act;
      b.dataset.via = retry.via;
      b.textContent = retry.via === 'webmail' ? '웹메일로 쓰기' : '메일 프로그램으로 쓰기';
      box.append(b);
    }
    box.hidden = false;
    place();
  }

  R.on((name, payload) => {
    if (name === 'error') showError(payload);
    else if (name === 'show') show(payload);
    else if (name === 'hover') $('status').textContent = payload ? `링크: ${payload}` : '';
  });
  // Alt+← / Alt+→ here (the header); mouse side buttons come to the widget as Windows app commands, so the
  // page only keeps them from doing anything else. Back with no earlier message closes this window.
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || e.isComposing) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    R.navigate(e.key === 'ArrowLeft' ? 'back' : 'forward');
  });
  for (const t of ['mousedown', 'mouseup', 'auxclick']) {
    window.addEventListener(t, (e) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    });
  }
  new ResizeObserver(place).observe($('body'));
  window.addEventListener('resize', place);
  R.ready().then(show);
})();
