// The recipes screen of the AI chat window (#129, design 12): the list, and the editor every recipe passes through before it is
// kept. All text is drawn as text. Only a real click saves; the widget's main code checks everything again.
window.AiChatRecipes = (() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => Object.assign(document.createElement(tag), { className: className || '', textContent: text ?? '' });
  let call = null;
  let onOpenSession = () => {};
  let editing = null; // { recipeId, sessionId, external }
  let scanTimer = null;
  let lastScan = null;

  const fields = () => ({ title: $('recipeTitle').value, when: $('recipeWhen').value, body: $('recipeBody').value });
  const dateOf = (at) => (at ? new Date(at).toLocaleDateString() : '없음');

  let rowState = null; // { id, kind: 'rename' | 'confirm', value?, message? } of the one row being worked on
  let undoTimer = null;

  /** A small button that does one thing to a row. */
  const action = (label, className, handler) => {
    const button = el('button', `small ${className || ''}`.trim(), label);
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler(event);
    });
    return button;
  };

  async function rename(recipe, value) {
    const res = await call('renameRecipe', { id: recipe.id, title: value });
    rowState = res.ok ? null : { id: recipe.id, kind: 'rename', value, message: res.message };
    showList();
  }

  function renameField(recipe) {
    const input = Object.assign(el('input', 'recipe-rename'), { type: 'text', value: rowState.value ?? recipe.title, spellcheck: false, maxLength: 200 });
    input.setAttribute('aria-label', '요약 이름');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        rename(recipe, input.value);
      } else if (event.key === 'Escape') {
        rowState = null;
        showList();
      }
    });
    input.addEventListener('input', () => { rowState.value = input.value; });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    return input;
  }

  function row(recipe) {
    const box = el('div', `recipe-row${recipe.pinned ? ' pinned' : ''}`);
    box.dataset.recipe = recipe.id;
    const line = el('div', 'recipe-line');
    const pin = action(recipe.pinned ? '★' : '☆', 'pin', async () => {
      await call('setRecipePinned', { id: recipe.id, pinned: !recipe.pinned });
      showList();
    });
    pin.title = recipe.pinned ? '고정 해제' : '고정';
    pin.setAttribute('aria-pressed', String(Boolean(recipe.pinned)));
    line.append(pin);
    const working = rowState?.id === recipe.id ? rowState : null;
    if (working?.kind === 'rename') line.append(renameField(recipe));
    else {
      const open = el('button', 'recipe-name', recipe.title);
      open.type = 'button';
      open.title = '누르면 열기, 두 번 누르면 이름 바꾸기';
      open.addEventListener('click', (event) => {
        if (event.detail > 1) return;
        clearTimeout(open.wait);
        open.wait = setTimeout(() => edit(recipe.id), 250); // a double-click renames instead
      });
      open.addEventListener('dblclick', () => {
        clearTimeout(open.wait);
        rowState = { id: recipe.id, kind: 'rename' };
        showList();
      });
      line.append(open);
    }
    line.append(
      action('이름 바꾸기', '', () => { rowState = { id: recipe.id, kind: 'rename' }; showList(); }),
      action('삭제', '', () => { rowState = { id: recipe.id, kind: 'confirm' }; showList(); }),
    );
    box.append(line);
    if (working?.message) box.append(el('div', 'info err-text', working.message));
    if (working?.kind === 'confirm') {
      const ask = el('div', 'confirm-row');
      ask.append(
        el('span', '', '이 요약과 이전 버전을 모두 지웁니다. 지운 뒤 잠깐 동안 되돌릴 수 있습니다.'),
        action('삭제', 'danger', async () => {
          rowState = null;
          const res = await call('removeRecipe', recipe.id);
          if (res?.ok) showUndo(recipe, res.undoMs);
          showList();
        }),
        action('취소', '', () => { rowState = null; showList(); }),
      );
      box.append(ask);
    }
    box.append(el('div', 'info', recipe.when));
    box.append(el('div', 'info', `v${recipe.version} · 사용 ${recipe.useCount}번 · 마지막 사용 ${dateOf(recipe.lastUsedAt)}${recipe.external ? ' · 외부 내용을 읽은 대화에서 만듦' : ''}`));
    if (recipe.sourceSessionId) {
      const source = el('button', 'link', `만든 대화: ${recipe.sourceTitle || '(제목 없음)'}`);
      source.type = 'button';
      source.addEventListener('click', () => onOpenSession(recipe.sourceSessionId));
      box.append(source);
    }
    return box;
  }

  /** "지웠습니다 · 되돌리기" for as long as the widget keeps the recipe aside. */
  function showUndo(recipe, ms) {
    clearTimeout(undoTimer);
    $('recipeUndoText').textContent = `'${recipe.title}'을(를) 지웠습니다.`;
    $('recipeUndo').hidden = false;
    $('recipeUndoButton').onclick = async () => {
      clearTimeout(undoTimer);
      $('recipeUndo').hidden = true;
      await call('undoRemoveRecipe', recipe.id);
      showList();
    };
    undoTimer = setTimeout(() => { $('recipeUndo').hidden = true; }, ms);
  }

  async function showList() {
    editing = null;
    $('recipeEditor').hidden = true;
    $('recipeList').hidden = false;
    const recipes = await call('recipes');
    if (!recipes.length) {
      $('recipeList').replaceChildren(el('p', 'info', '저장한 요약이 없습니다. 결과에 만족하면 대화에서 요약을 만들 수 있습니다.'));
      return;
    }
    const pinned = recipes.filter((x) => x.pinned);
    const rest = recipes.filter((x) => !x.pinned);
    const parts = [];
    if (pinned.length) parts.push(el('div', 'list-group', '고정'), ...pinned.map(row));
    if (rest.length) parts.push(el('div', 'list-group', pinned.length ? '최근 사용' : '모든 요약'), ...rest.map(row));
    $('recipeList').replaceChildren(...parts);
  }

  function drawScan(scan) {
    lastScan = scan;
    const hard = scan.secrets.filter((s) => s.hard);
    const soft = scan.secrets.filter((s) => !s.hard);
    const list = [];
    for (const s of hard) list.push(el('div', 'scan-hard', `${s.label}가 들어 있어 저장할 수 없습니다. 지워 주세요.`));
    for (const s of soft) list.push(el('div', 'scan-secret', `${s.field} ${s.line}번째 줄: ${s.label} (${s.sample}). 지우기 전에는 저장하지 않습니다.`));
    for (const r of scan.risks) list.push(el('div', 'scan-risk', `${r.field} ${r.line}번째 줄 [${r.label}]: ${r.text}`));
    $('recipeScan').replaceChildren(...list);
    $('recipeScan').hidden = !list.length;
    $('recipeNotSecretRow').hidden = !soft.length;
    if (!soft.length) $('recipeNotSecret').checked = false;
    $('recipeSave').disabled = Boolean(hard.length);
  }

  async function rescan() {
    drawScan(await call('scanRecipe', fields()));
  }

  function open({ title, when, body, recipeId = null, sessionId = null, external = false, versions = [] }) {
    editing = { recipeId, sessionId, external };
    $('recipeList').hidden = true;
    $('recipeEditor').hidden = false;
    $('recipeEditorTitle').textContent = recipeId ? '요약 고치기' : '새 요약 확인';
    $('recipeTitle').value = title || '';
    $('recipeWhen').value = when || '';
    $('recipeBody').value = body || '';
    $('recipeResult').textContent = '';
    $('recipeExternalRow').hidden = !external;
    $('recipeExternal').checked = false;
    $('recipeNotSecret').checked = false;
    $('recipeDelete').hidden = !recipeId;
    $('recipeDeleteYes').hidden = true;
    const rows = versions.slice(1).map((v) => {
      const b = el('button', 'small', `v${v}로 되돌리기`);
      b.type = 'button';
      b.addEventListener('click', async () => {
        await call('restoreRecipe', { id: recipeId, version: v });
        edit(recipeId);
      });
      return b;
    });
    $('recipeVersions').replaceChildren(...rows);
    $('recipeVersions').hidden = !rows.length;
    rescan();
  }

  async function edit(id) {
    const r = await call('recipe', id);
    if (r) open({ ...r, recipeId: id });
  }

  async function save(event) {
    if (!event.isTrusted || !editing || !lastScan) return;
    const res = await call('saveRecipe', {
      ...fields(), recipeId: editing.recipeId, sessionId: editing.sessionId, trusted: true,
      allowFlags: $('recipeNotSecret').checked, confirmExternal: $('recipeExternal').checked,
    });
    if (res.ok) {
      showList();
      return;
    }
    $('recipeResult').textContent = res.message;
    if (res.scan) drawScan(res.scan);
  }

  function init(api) {
    call = api.call;
    onOpenSession = api.onOpenSession;
    for (const id of ['recipeTitle', 'recipeWhen', 'recipeBody']) {
      $(id).addEventListener('input', () => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(rescan, 200);
      });
    }
    $('recipeSave').addEventListener('click', save);
    $('recipeCancel').addEventListener('click', async () => {
      if (editing?.sessionId && !editing.recipeId) await call('discardDraft', editing.sessionId);
      showList();
    });
    $('recipeDelete').addEventListener('click', () => { $('recipeDeleteYes').hidden = false; });
    $('recipeDeleteYes').addEventListener('click', async (event) => {
      if (!event.isTrusted || !editing?.recipeId) return;
      await call('removeRecipe', editing.recipeId);
      showList();
    });
  }

  return { init, showList, open, edit };
})();
