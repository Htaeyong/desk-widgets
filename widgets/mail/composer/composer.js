// Mail composer page (#68): edits the draft the widget keeps in memory and asks the widget to send it.
// Sending runs in the background after this window closes; a failure comes back as a notification card
// that reopens this window with everything kept. All text is set with textContent / value.
(() => {
  const C = window.mailComposer;
  const A = window.MailAddresses;
  const S = window.MailSignature;
  let accounts = [];
  let sigAccount = null; // the account whose signature is in the body now
  const $ = (id) => document.getElementById(id);
  const sizeLabel = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
  let draft = null;
  let files = [];
  let sending = false;
  let timer = null;

  // ---- recipient chips: To / Cc / Bcc are lists of { name, address } (invalid ones marked) ----

  const FIELDS = ['to', 'cc', 'bcc'];
  const chips = { to: [], cc: [], bcc: [] };
  const inputOf = (field) => $(field).querySelector('input');

  /** Text typed or pasted -> chips (one per address; entries that are not addresses become red chips). */
  function commit(field, text) {
    const entries = A.splitEntries(text);
    if (!entries.length) return false;
    for (const raw of entries) {
      const e = A.parseEntry(raw);
      if (e.valid && chips[field].some((c) => !c.invalid && c.address.toLowerCase() === e.address.toLowerCase())) continue;
      chips[field].push(e.valid ? { name: e.name, address: e.address } : { name: '', address: e.raw, invalid: true });
    }
    renderChips(field);
    save();
    return true;
  }

  function renderChips(field) {
    const box = $(field);
    const input = inputOf(field);
    box.replaceChildren(
      ...chips[field].map((c, i) => {
        const chip = document.createElement('span');
        chip.className = c.invalid ? 'chip bad' : 'chip';
        chip.title = c.invalid ? `올바르지 않은 주소: ${c.address} (눌러서 고치기)` : A.fullText(c);
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = c.invalid ? c.address : A.chipLabel(c);
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '✕';
        x.title = '빼기';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          chips[field].splice(i, 1);
          renderChips(field);
          save();
          input.focus();
        });
        // A red chip goes back into the input to be fixed.
        if (c.invalid) {
          chip.addEventListener('click', () => {
            chips[field].splice(i, 1);
            renderChips(field);
            input.value = c.address;
            input.focus();
          });
        }
        chip.append(label, x);
        return chip;
      }),
      input,
    );
    box.classList.toggle('invalid', chips[field].some((c) => c.invalid));
  }

  // ---- #70 autocomplete from the address book on this PC ----

  const sug = { field: null, items: [], index: -1, seq: 0, timer: null };
  const sugList = document.createElement('ul');
  sugList.className = 'suggest';
  sugList.hidden = true;
  document.body.append(sugList);

  function hideSuggest() {
    sug.field = null;
    sug.items = [];
    sug.index = -1;
    sugList.hidden = true;
  }

  function renderSuggest() {
    sugList.replaceChildren(
      ...sug.items.map((c, i) => {
        const li = document.createElement('li');
        li.className = i === sug.index ? 'on' : '';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = c.name || c.address;
        const addr = document.createElement('span');
        addr.className = 'addr';
        addr.textContent = c.name ? c.address : '';
        li.append(name, addr);
        // mousedown, not click: the input keeps the focus (its blur would turn the typed text into a chip).
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pickSuggest(i);
        });
        return li;
      }),
    );
  }

  async function updateSuggest(field) {
    const input = inputOf(field);
    const q = A.splitEntries(input.value).pop() || '';
    if (!q || q.length > 100) return hideSuggest();
    const seq = ++sug.seq;
    const exclude = FIELDS.flatMap((f) => chips[f].map((c) => c.address));
    const items = await C.suggest(q, exclude);
    if (seq !== sug.seq || document.activeElement !== input) return;
    if (!Array.isArray(items) || !items.length) return hideSuggest();
    sug.field = field;
    sug.items = items;
    sug.index = 0;
    renderSuggest();
    const r = $(field).getBoundingClientRect();
    sugList.style.left = `${r.left}px`;
    sugList.style.top = `${r.bottom + 2}px`;
    sugList.style.width = `${r.width}px`;
    sugList.hidden = false;
  }

  function pickSuggest(i) {
    const field = sug.field;
    const c = sug.items[i];
    if (!field || !c) return;
    const input = inputOf(field);
    // Text before the one being completed (e.g. "a@b.c, 홍") becomes chips first.
    const parts = A.splitEntries(input.value);
    parts.pop();
    if (parts.length) commit(field, parts.join(','));
    if (!chips[field].some((x) => !x.invalid && x.address.toLowerCase() === c.address.toLowerCase())) chips[field].push({ name: c.name || '', address: c.address });
    input.value = '';
    renderChips(field);
    save();
    hideSuggest();
    input.focus();
  }

  for (const field of FIELDS) {
    const input = inputOf(field);
    $(field).addEventListener('click', () => input.focus());
    input.addEventListener('input', () => {
      clearTimeout(sug.timer);
      sug.timer = setTimeout(() => updateSuggest(field), 80);
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // Korean IME: wait until the syllable is done
      if (sug.field === field && !sugList.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = sug.items.length;
          sug.index = (sug.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
          renderSuggest();
          return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && sug.index >= 0) {
          e.preventDefault();
          pickSuggest(sug.index);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          hideSuggest();
          return;
        }
      }
      if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
        e.preventDefault(); // Enter must not submit the form here
        if (commit(field, input.value)) input.value = '';
      } else if (e.key === 'Tab' && input.value.trim()) {
        if (commit(field, input.value)) input.value = ''; // focus still moves on
      } else if (e.key === 'Backspace' && !input.value && chips[field].length) {
        e.preventDefault();
        chips[field].pop();
        renderChips(field);
        save();
      }
    });
    input.addEventListener('blur', () => {
      hideSuggest();
      if (commit(field, input.value)) input.value = '';
    });
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (!/[,;\n\r\t]/.test(text) && !/<[^>]+>/.test(text)) return; // a plain single address: normal paste
      e.preventDefault();
      commit(field, `${input.value}${text}`);
      input.value = '';
    });
  }

  /** Chips plus what is still in the input (not committed yet). */
  function recipients(field) {
    const typed = inputOf(field).value;
    if (typed.trim()) {
      commit(field, typed);
      inputOf(field).value = '';
    }
    return chips[field].map((c) => ({ ...c }));
  }

  const fields = () => ({
    accountId: $('account').value,
    to: chips.to.map((c) => ({ ...c })),
    cc: chips.cc.map((c) => ({ ...c })),
    bcc: chips.bcc.map((c) => ({ ...c })),
    subject: $('subject').value,
    body: $('body').value,
    includeForward: $('forwardOn') ? $('forwardOn').checked : undefined,
  });

  /** Keeps the draft in the widget (memory) as the user types. */
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => C.update(fields()), 400);
  };

  function showError(text) {
    $('error').textContent = text || '';
    $('error').hidden = !text;
  }

  function renderFiles() {
    $('files').replaceChildren(
      ...files.map((f) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `${f.name} (${sizeLabel(f.size)})`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '빼기';
        remove.addEventListener('click', async () => {
          const res = await C.removeFile(f.id);
          files = res?.files || files;
          renderFiles();
        });
        li.append(name, remove);
        return li;
      }),
    );
    const fwd = draft?.forward && !draft.forward.tooBig && $('forwardOn')?.checked ? draft.forward.size : 0;
    const total = files.reduce((n, f) => n + f.size, 0) + fwd;
    const max = draft?.maxBytes || 0;
    $('total').textContent = total ? `첨부 ${sizeLabel(total)} / 최대 ${sizeLabel(max)}` : `첨부는 모두 합쳐 ${sizeLabel(max)}까지`;
  }

  function renderForward() {
    const f = draft.forward;
    const box = $('forward');
    box.hidden = !f || !f.names.length;
    if (box.hidden) return;
    box.replaceChildren();
    if (f.tooBig) {
      box.textContent = `원본 메일의 첨부 ${f.names.length}개(${sizeLabel(f.size)})는 너무 커서 함께 보내지 않습니다: ${f.names.join(', ')}. 필요하면 PC에 저장한 뒤 "파일 첨부"로 넣으세요.`;
      return;
    }
    const label = document.createElement('label');
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.id = 'forwardOn';
    on.checked = f.include;
    on.addEventListener('change', () => {
      save();
      renderFiles();
    });
    label.append(on, ` 원본 메일의 첨부 ${f.names.length}개(${sizeLabel(f.size)})를 함께 보냄: ${f.names.join(', ')}`);
    box.append(label);
  }

  async function init() {
    const res = await C.init();
    if (!res) return;
    draft = res.draft;
    files = draft.files;
    accounts = res.accounts;
    sigAccount = draft.accountId;
    $('account').replaceChildren(
      ...res.accounts.map((a) => {
        const o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.canSend ? a.label : `${a.label} — ${a.reason}`;
        o.disabled = !a.canSend;
        return o;
      }),
    );
    $('account').value = draft.accountId || '';
    for (const field of FIELDS) {
      chips[field] = (draft[field] || []).map((c) => ({ name: c.name || '', address: c.address, ...(c.invalid ? { invalid: true } : {}) }));
      renderChips(field);
    }
    $('bccRow').hidden = !chips.bcc.length;
    $('showBcc').hidden = chips.bcc.length > 0;
    $('subject').value = draft.subject;
    $('body').value = draft.body;
    showError(draft.error ? `보내지 못했습니다: ${draft.error}` : '');
    renderForward();
    renderFiles();
    const first = chips.to.length && draft.mode !== 'forward' ? $('body') : inputOf('to');
    first.focus();
    if (first === $('body')) $('body').setSelectionRange(0, 0);
  }

  for (const id of ['subject', 'body']) $(id).addEventListener('input', save);
  // Another sending account: its signature replaces the previous one, unless the user changed that block.
  $('account').addEventListener('change', () => {
    const sigOf = (id) => accounts.find((a) => a.id === id)?.signature || '';
    const next = $('account').value;
    const res = S.swapSignature($('body').value, sigOf(sigAccount), sigOf(next));
    if (res.swapped) $('body').value = res.body;
    sigAccount = next;
    save();
  });
  $('showBcc').addEventListener('click', () => {
    $('bccRow').hidden = false;
    $('showBcc').hidden = true;
    inputOf('bcc').focus();
  });
  $('attach').addEventListener('click', async () => {
    const res = await C.pickFiles();
    if (res?.files) files = res.files;
    renderFiles();
    showError(res?.message || '');
  });
  $('discard').addEventListener('click', () => C.discard());

  async function send(event) {
    event?.preventDefault();
    if (sending) return;
    sending = true;
    $('send').disabled = true;
    $('status').textContent = '확인하는 중…';
    try {
      clearTimeout(timer);
      for (const field of FIELDS) recipients(field);
      const bad = FIELDS.find((f) => chips[f].some((c) => c.invalid));
      if (bad) {
        showError(`빨간 주소를 고치거나 빼 주세요: ${chips[bad].filter((c) => c.invalid).map((c) => c.address).slice(0, 3).join(', ')}`);
        $('status').textContent = '';
        inputOf(bad).focus();
        return;
      }
      if (!FIELDS.some((f) => chips[f].length)) {
        showError('받는 사람을 넣으세요.');
        $('status').textContent = '';
        inputOf('to').focus();
        return;
      }
      const res = await C.send(fields());
      if (res && res.ok === false) {
        showError(res.message || '보낼 수 없습니다.');
        if (res.field) $(res.field)?.classList.add('invalid');
        else for (const f of FIELDS) $(f).classList.remove('invalid');
        $('status').textContent = '';
      }
      // ok: the widget closes this window and sends in the background.
    } finally {
      sending = false;
      $('send').disabled = false;
    }
  }
  $('form').addEventListener('submit', send);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) send(e);
  });
  init();
})();
