// AI chat window (#129). Everything from the model or a tool is drawn with textContent, never as markup: no links, no images,
// no buttons can come from it. The window has no network (CSP) and never holds the key.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? '' });
  const PAGES = ['consent', 'blocked', 'modelPage', 'app'];
  const show = (page) => {
    for (const id of PAGES) $(id).hidden = id !== page;
  };
  const LINK_LABELS = { install: '설치 안내 열기', keys: 'Console API keys 열기', billing: 'Console Billing 열기', workspaces: 'Console Workspaces 열기' };
  const STATE_TEXT = { running: '작업 중', queued: '대기 중', failed: '실패', stopped: '중단됨', interrupted: '끊김' };

  let view = null; // the last state()
  let list = { sessions: [], queue: [], running: [] };
  let current = null; // the open session id, null for a new conversation
  let draftFolder = null; // the folder of the new conversation
  let pendingFolder = null; // { prompt, cwd } waiting for the first-use answer
  let confirmAction = null;
  let stream = null; // { el, raw, queued } of the answer text arriving now
  let pendingUrl = null; // the web address waiting for the user's "열기"
  let sessionRow = null; // { id, kind: 'menu' | 'rename' | 'confirm', value?, message? } of the one row being worked on
  let liveRecipes = new Set(); // ids of the recipes that still exist
  let draftFiles = []; // attachments waiting for this prompt: { id, name, size, kind, thumb, warnings }
  const LONG_PASTE = 20000; // pasted text longer than this becomes an attached file instead of filling the box
  let snoozed = {}; // notices put off for the week, from the widget
  const closedHere = new Set(); // notices closed in this window without "이번 주 그만 보기": back next time it opens
  let toolTitles = {}; // exported widget tool name -> its title, from the engine's tools.json
  let runningSession = null; // the conversation whose answer is arriving now in this window
  const openGroups = new Set(); // "<session>:<n>" of tool groups the user opened; kept while the window lives, never saved
  let cards = []; // what the widget says waits for an answer
  let lastPrompt = '';
  let picked = []; // recipe ids the user chose for the next prompt
  let satisfied = false;
  let showFeedback = false;
  let keepBannerFor = null; // the session whose error banner the next redraw keeps
  let aiBubble = null; // the answer bubble the next pieces go into
  let bandPinned = false; // the usage details were opened by a click or a key, not a hover
  let layout = { sideWidth: 180, sideCollapsed: false, default: 180, min: 140, max: 360 };
  let autoFolded = false; // folded by a narrow window, not by the user: a wider window opens it again
  const NARROW = 700; // below this window width the list folds by itself so the conversation is not squeezed
  const ARMED_MS = 500; // a card's buttons wake up after this, so a click meant for something else cannot land on them

  /** Draws **bold** and [text](url) from the fixed consent strings. The only link there goes through the widget's list. */
  function rich(parent, text) {
    for (const part of text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/)) {
      if (!part) continue;
      const bold = /^\*\*(.+)\*\*$/.exec(part);
      const link = /^\[(.+)\]\((.+)\)$/.exec(part);
      if (bold) parent.append(Object.assign(document.createElement('b'), { textContent: bold[1] }));
      else if (link) {
        const a = Object.assign(document.createElement('a'), { textContent: link[1], href: '#' });
        a.addEventListener('click', (event) => {
          event.preventDefault();
          window.aiChat.call('openLink', 'aup');
        });
        parent.append(a);
      } else parent.append(part);
    }
  }

  function blocked({ title, text, link = null, settings = false }) {
    $('blockedTitle').textContent = title;
    $('blockedText').textContent = text;
    $('blockedLink').hidden = !link;
    if (link) {
      $('blockedLink').textContent = LINK_LABELS[link] || '안내 열기';
      $('blockedLink').onclick = () => window.aiChat.call('openLink', link);
    }
    $('blockedSettings').hidden = !settings;
    show('blocked');
  }

  // ---- the conversation ----

  /** Down to the newest message, unless the user scrolled up to read (then a new prompt of theirs still brings it down). */
  function scrollEnd(force = false) {
    const log = $('log');
    if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 140) log.scrollTop = log.scrollHeight;
  }

  /** The cards and the feedback row go with the newest answer; with none, they wait in the parking space under the log. */
  function placeControls() {
    const controls = [$('cards'), $('feedbackBar'), $('badBar')];
    if (aiBubble) aiBubble.append(...controls);
    else $('parking').append(...controls);
  }

  /** Before the log is redrawn: the controls are kept, not thrown away with it. */
  function clearLog() {
    aiBubble = null;
    placeControls();
    $('log').replaceChildren();
  }

  const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  /** My words as typed, and the names and sizes of what I attached (never their contents). */
  function userBubble(text, attachments = []) {
    const row = el('div', 'msg you', '');
    const bubble = el('div', 'bubble', text);
    if (attachments?.length) {
      const files = el('div', 'sent-files', '');
      for (const a of attachments) files.append(el('span', 'sent-file', `${a.kind === 'image' ? '🖼' : '📎'} ${a.name} (${sizeText(a.size)})`));
      bubble.append(files);
    }
    row.append(bubble);
    $('log').append(row);
    aiBubble = null;
    placeControls();
    scrollEnd(true);
  }

  /** The bubble of the answer in progress, made on the first piece of it. */
  function answerBubble() {
    if (!aiBubble) {
      const row = el('div', 'msg ai', '');
      aiBubble = el('div', 'bubble', '');
      row.append(el('div', 'who', 'Claude Code'), aiBubble);
      $('log').append(row);
    }
    return aiBubble;
  }

  /** One piece of an answer. The answer's own text is Markdown, drawn safely; everything else stays plain text. */
  function line(kind, text) {
    if (kind === 'you') {
      userBubble(text);
      return null;
    }
    const part = kind === 'text' ? markdownPart(text) : el('div', kind, text);
    answerBubble().append(part);
    placeControls();
    scrollEnd();
    return part;
  }

  function markdownPart(source) {
    const part = el('div', 'text md', '');
    part.append(window.AiChatMarkdownView.render(source));
    return part;
  }

  /** Streaming: the text so far is drawn again at most once a frame, so a half-written table or list settles as it grows. */
  function streamText(delta) {
    if (!stream) {
      const part = line('text', '');
      stream = { el: part, raw: '', queued: false };
    }
    stream.raw += delta;
    if (stream.queued) return;
    stream.queued = true;
    const target = stream;
    requestAnimationFrame(() => {
      target.queued = false;
      target.el.replaceChildren(window.AiChatMarkdownView.render(target.raw));
      scrollEnd();
    });
  }

  /** A web address from an answer: shown in full first, opened only by a real click on "열기", and only http or https. */
  function askOpen(url) {
    const href = window.AiChatMarkdownView.webAddress(url);
    if (!href) return;
    pendingUrl = href;
    $('linkUrl').textContent = href;
    $('linkConfirm').hidden = false;
  }

  // ---- tool calls: readable names, folded into one line per stretch ----

  const BUILTIN = {
    Read: '파일 읽기', Edit: '파일 고치기', Write: '파일 쓰기', Glob: '파일 찾기', Grep: '내용 찾기', Bash: 'Bash', PowerShell: 'PowerShell',
    WebSearch: '웹 검색', WebFetch: '웹 읽기', Task: '하위 작업', Agent: '하위 작업', ToolSearch: '도구 찾기', TodoWrite: '할 일 정리', NotebookEdit: '노트북 고치기',
  };
  const WIDGETS = [
    ['system_monitor_', '시스템 모니터'], ['todonote_', '할 일 노트'], ['calendar_', '캘린더'], ['mail_', '메일'], ['dooray_', '두레이'],
    ['clock_', '시계'], ['memo_', '스티키 노트'], ['todo_', '할 일 목록'], ['desk_widgets_', 'Desk Widgets'],
  ];
  const HOST_TOOLS = { ask_user: '질문', list_recipes: '요약 목록', read_recipe: '요약 읽기', approve: '승인' };

  /** { group, label }: group is what the summary counts by (a widget, or a built-in tool), label the line's words. */
  function toolName(name) {
    const raw = String(name || '');
    if (Object.hasOwn(BUILTIN, raw)) return { group: BUILTIN[raw], label: BUILTIN[raw] };
    let m = /^mcp__desk-widgets__(.+)$/.exec(raw);
    if (m) {
      const exported = m[1];
      const widget = WIDGETS.find(([prefix]) => exported.startsWith(prefix));
      const group = widget ? widget[1] : 'Desk Widgets';
      const title = Object.hasOwn(toolTitles, exported) ? toolTitles[exported] : (widget ? exported.slice(widget[0].length) : exported);
      return { group, label: `${group} · ${title}` };
    }
    m = /^mcp__ai-chat-host__(.+)$/.exec(raw);
    if (m) return { group: 'AI Widgets', label: `AI Widgets · ${HOST_TOOLS[m[1]] || m[1]}` };
    m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(raw);
    if (m) return { group: m[1], label: `${m[1]} · ${m[2]}` };
    return { group: raw || '도구', label: raw || '도구' };
  }

  /** "도구 15번 (캘린더 1, 메일 10, ...)", in the order the groups first appeared. */
  function groupSummary(group) {
    const counts = new Map();
    for (const line of group.querySelectorAll('.tool')) counts.set(line.dataset.group, (counts.get(line.dataset.group) || 0) + 1);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const parts = [...counts].map(([g, n]) => `${g} ${n}`).join(', ');
    const live = group.dataset.live === 'true';
    const last = group.querySelector('.tool:last-of-type summary')?.textContent || '';
    return live ? `작업 중… (도구 ${total}번) · 지금: ${last}` : `작업 내용 · 도구 ${total}번 (${parts})`;
  }

  /** The group a new tool call joins: the last one in this answer, if only notes came after it. */
  function currentGroup(bubble) {
    for (let node = bubble.lastElementChild; node; node = node.previousElementSibling) {
      if (node.classList.contains('toolgroup')) return node;
      if (!node.classList.contains('meta') && !['cards', 'feedbackBar', 'badBar'].includes(node.id)) return null;
    }
    return null;
  }

  function toolLine(name, input, live = false) {
    const bubble = answerBubble();
    let group = currentGroup(bubble);
    if (!group) {
      group = Object.assign(document.createElement('details'), { className: 'toolgroup' });
      const key = `${current}:${bubble.closest('#log') ? document.querySelectorAll('#log .toolgroup').length : 0}`;
      group.dataset.key = key;
      group.open = openGroups.has(key);
      group.addEventListener('toggle', () => {
        if (group.open) openGroups.add(key);
        else openGroups.delete(key);
      });
      group.append(Object.assign(document.createElement('summary'), { className: 'toolgroup-summary' }), el('div', 'toolgroup-lines', ''));
      // Before any note that came after the text, so the stretch reads in order.
      bubble.append(group);
    }
    const { group: kind, label } = toolName(name);
    const box = Object.assign(document.createElement('details'), { className: 'tool' });
    box.dataset.group = kind;
    box.append(Object.assign(document.createElement('summary'), { textContent: label }));
    if (input) box.append(Object.assign(document.createElement('div'), { textContent: typeof input === 'string' ? input : JSON.stringify(input) }));
    group.querySelector('.toolgroup-lines').append(box);
    group.dataset.live = String(live);
    group.querySelector('.toolgroup-summary').textContent = groupSummary(group);
    placeControls();
    scrollEnd();
  }

  /** The answer moved on (text, a card, the end): the live group says what it did instead of what it does. */
  function settleGroups() {
    for (const group of document.querySelectorAll('#log .toolgroup[data-live="true"]')) {
      group.dataset.live = 'false';
      group.querySelector('.toolgroup-summary').textContent = groupSummary(group);
    }
  }

  function drawItem(item) {
    if (item.k !== 'tool') settleGroups();
    if (item.k === 'you') userBubble(item.text, item.attachments);
    else if (item.k === 'ai') line('text', item.text);
    else if (item.k === 'tool') toolLine(item.name, item.input);
    else if (item.k === 'err') line('err', item.text);
    else if (item.k === 'fetched') fetchedLine(item);
    else line('meta', item.text || '');
  }

  const DECLINED = { rejected: '거절함', closed: '카드를 닫음', timeout: '2분 동안 응답 없음', unavailable: '물어볼 수 없음' };

  /** A file the Dooray widget fetched and the widget copied in (or one the user turned down): name and size, never its content. */
  function fetchedLine(f) {
    fetchWait(null);
    const chip = el('div', 'sent-files fetched', '');
    if (f.declined) chip.append(el('span', 'source-tag muted', '두레이 원본 받지 않음'), el('span', 'sent-file', `${f.name || '파일'} (${DECLINED[f.reason] || DECLINED.rejected})`));
    else chip.append(el('span', 'source-tag', '두레이에서 받음'), el('span', 'sent-file', `${f.kind === 'image' ? '🖼' : '📎'} ${f.name} (${sizeText(f.size)})`));
    answerBubble().append(chip);
    placeControls();
    scrollEnd();
  }

  /** While the Dooray widget waits for the user on its own card, or downloads: one line that changes, gone when it is over. */
  function fetchWait(state) {
    const old = document.getElementById('fetchWait');
    if (!state || state.state === 'clear') {
      old?.remove();
      return;
    }
    const what = state.name ? ` (${state.name}${state.size ? `, ${sizeText(state.size)}` : ''})` : '';
    const text = state.state === 'downloading' ? `두레이 원본을 받는 중입니다${what}.` : `두레이 원본 받기: Desk Widgets 알림 카드에서 "받기"를 눌러 주세요${what}.`;
    const row = old || Object.assign(el('div', 'fetch-wait', ''), { id: 'fetchWait' });
    row.textContent = text;
    if (!old) {
      answerBubble().append(row);
      placeControls();
      scrollEnd();
    }
  }

  const sessionOf = (id) => list.sessions.find((s) => s.id === id) || null;

  /** Which recipes went into this conversation, from the widget's record of tool calls and picks, never from the model's words. */
  function drawUsed(used) {
    const bar = $('usedBar');
    const chips = (used || []).map((u) => {
      // A recipe deleted since: the record keeps that it was used, without a button for something gone.
      if (!liveRecipes.has(u.id)) return el('span', 'info', `삭제된 요약 (${u.title} v${u.version})`);
      const chip = el('span', '', `${u.title} v${u.version}`);
      const out = el('button', 'small', '빼기');
      out.type = 'button';
      out.addEventListener('click', () => window.aiChat.call('excludeRecipe', { sessionId: current, recipeId: u.id }));
      const box = el('span', '', '');
      box.append(chip, ' ', out);
      return box;
    });
    bar.replaceChildren(...(chips.length ? [el('span', 'info', '이 대화에서 쓴 요약:'), ...chips] : []));
    bar.hidden = !chips.length;
  }

  function drawFeedback() {
    const s = current ? sessionOf(current) : null;
    const can = Boolean(s && s.resumable && showFeedback && s.state !== 'running' && s.state !== 'queued');
    $('feedbackBar').hidden = !can;
    $('fbGood').hidden = satisfied;
    $('fbBad').hidden = satisfied;
    $('fbAgain').hidden = satisfied;
    $('fbSummary').hidden = !satisfied;
    const last = s?.lastRunUsd;
    $('feedbackText').textContent = satisfied
      ? `요약을 만들면 다음에 비슷한 일에 쓸 수 있습니다. 모델을 한 번 더 부릅니다${last ? ` (직전 실행 ${aboutMoney(last)}, 추정)` : ' (비용 발생)'}. 저장 전에 직접 확인합니다.`
      : '이 결과는 어땠나요?';
    if (!can) $('badBar').hidden = true;
    placeControls();
    if (can) scrollEnd();
  }

  async function fillPick() {
    const recipes = await window.aiChat.call('recipes');
    liveRecipes = new Set(recipes.map((r) => r.id));
    const none = Object.assign(document.createElement('option'), { value: '', textContent: recipes.length ? '요약 고르기' : '저장한 요약 없음' });
    $('recipePick').replaceChildren(none, ...recipes.map((r) => Object.assign(document.createElement('option'), { value: r.id, textContent: `${r.pinned ? '★ ' : ''}${r.title} v${r.version}` })));
    $('recipePick').value = '';
    $('recipePick').disabled = !recipes.length;
  }

  function drawPicked() {
    $('picked').textContent = picked.length ? `함께 전달할 요약 ${picked.length}개` : '';
  }

  function drawHead() {
    const s = current ? sessionOf(current) : null;
    $('headTitle').textContent = s ? s.title : '새 대화';
    $('headActions').hidden = !s;
    const folder = s ? s.cwd : (draftFolder || view?.workDir || '');
    $('infoLine').textContent = `모델 ${s?.model || view?.model || ''} · 키 …${view?.key?.tail || ''} · Claude Code ${view?.prerequisites?.version || ''} · 폴더 ${folder}`;
    $('folderBtn').hidden = Boolean(s);
    if (s) $('pinBtn').textContent = s.pinned ? '고정 해제' : '고정';
    $('readOnly').hidden = !(s && !s.resumable);
    $('composer').hidden = Boolean(s && !s.resumable);
    const state = s?.state;
    const busy = state === 'running';
    $('runBar').hidden = !busy;
    if (!busy) $('sendChoice').hidden = true;
    const after = list.queue.filter((id) => id === current).length;
    $('cancelQueue').hidden = !after;
    $('send').disabled = false;
    $('queueState').textContent = busy && after ? `끝난 뒤 보낼 명령 ${after}개` : (state === 'queued' ? `대기 중 (${list.queue.indexOf(current) + 1}번째)` : '');
  }

  const small = (label, className, handler) => {
    const button = el('button', `small ${className || ''}`.trim(), label);
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
    return button;
  };

  async function renameSession(id, value) {
    const res = await window.aiChat.call('renameSession', { id, title: value });
    sessionRow = res.ok ? null : { id, kind: 'rename', value, message: res.message };
    if (res.ok) list = await window.aiChat.call('list');
    drawList();
  }

  /** One conversation in the list: open it, or from ⋯ rename, pin or delete it there. Double-click renames. */
  function sessionItem(s) {
    const box = el('div', `session-row${s.id === current ? ' current' : ''}`, '');
    box.dataset.session = s.id;
    const working = sessionRow?.id === s.id ? sessionRow : null;
    if (working?.kind === 'rename') {
      const input = Object.assign(el('input', 'session-rename', ''), { type: 'text', value: working.value ?? s.title, spellcheck: false, maxLength: 200 });
      input.setAttribute('aria-label', '대화 이름');
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          renameSession(s.id, input.value);
        } else if (event.key === 'Escape') {
          sessionRow = null;
          drawList();
        }
      });
      input.addEventListener('input', () => { working.value = input.value; });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      box.append(input);
    } else {
      const row = Object.assign(document.createElement('button'), { type: 'button', className: `session${s.id === current ? ' current' : ''}` });
      row.append(Object.assign(document.createElement('span'), { className: 'name', textContent: `${s.pinned ? '★ ' : ''}${s.title}` }));
      const sub = s.waiting ? '답을 기다림' : (STATE_TEXT[s.state] || (s.resumable ? '' : '읽기 전용'));
      if (sub) row.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: sub }));
      row.addEventListener('click', () => openSession(s.id));
      row.addEventListener('dblclick', () => {
        sessionRow = { id: s.id, kind: 'rename' };
        drawList();
      });
      const more = small('⋯', 'row-more', () => {
        sessionRow = working?.kind === 'menu' ? null : { id: s.id, kind: 'menu' };
        drawList();
      });
      more.title = '이름 바꾸기, 고정, 삭제';
      more.setAttribute('aria-label', `${s.title} 메뉴`);
      box.append(row, more);
    }
    if (working?.message) box.append(el('div', 'info err-text row-wide', working.message));
    if (working?.kind === 'menu') {
      const menu = el('div', 'row-menu row-wide', '');
      menu.append(
        small('이름 바꾸기', '', () => { sessionRow = { id: s.id, kind: 'rename' }; drawList(); }),
        small(s.pinned ? '고정 해제' : '고정', '', async () => {
          sessionRow = null;
          await window.aiChat.call('setPinned', { id: s.id, pinned: !s.pinned });
        }),
        small('삭제', '', () => { sessionRow = { id: s.id, kind: 'confirm' }; drawList(); }),
      );
      box.append(menu);
    }
    if (working?.kind === 'confirm') {
      const ask = el('div', 'confirm-row row-wide', '');
      ask.append(
        el('span', '', '이 대화와 Claude Code 기록을 모두 지웁니다. 되돌릴 수 없습니다.'),
        small('삭제', 'danger', async () => {
          sessionRow = null;
          const res = await window.aiChat.call('remove', s.id);
          if (!res.ok) {
            sessionRow = { id: s.id, kind: 'menu', message: res.message };
            drawList();
          } else if (s.id === current) newConversation();
        }),
        small('취소', '', () => { sessionRow = null; drawList(); }),
      );
      box.append(ask);
    }
    return box;
  }

  function drawList() {
    const pinned = list.sessions.filter((s) => s.pinned);
    const rest = list.sessions.filter((s) => !s.pinned);
    const parts = [];
    if (pinned.length) parts.push(el('div', 'list-group', '고정'), ...pinned.map(sessionItem));
    if (pinned.length && rest.length) parts.push(el('div', 'list-group', '대화'));
    parts.push(...rest.map(sessionItem));
    $('sessionList').replaceChildren(...parts);
    drawHead();
  }

  /** Answers a card. Only for a real input event: a script's click() is not the user. */
  function cardButton(label, className, handler) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className, textContent: label, disabled: true });
    button.addEventListener('click', (event) => {
      if (event.isTrusted) handler();
    });
    setTimeout(() => { button.disabled = false; }, ARMED_MS);
    return button;
  }

  const answer = (card, action, text) => window.aiChat.call('answerCard', { id: card.id, action, text, trusted: true });

  function drawCard(card) {
    const box = el('section', 'card');
    box.dataset.card = card.id;
    if (card.kind === 'approval') {
      box.append(el('h2', '', 'Claude Code가 승인을 요청합니다'), el('p', 'tool-name', `도구: ${card.tool}`));
      if (card.hidden) box.append(el('p', 'hidden-note', `보이지 않는 글자 ${card.hidden}개가 들어 있어 [U+...]로 표시했습니다. 주의해서 확인해 주세요.`));
      box.append(el('pre', '', card.inputText));
      const reason = Object.assign(el('input', ''), { type: 'text', placeholder: '거부 이유 (선택)', spellcheck: false });
      const row = el('div', 'actions');
      row.append(cardButton('거부', 'small', () => answer(card, 'deny', reason.value)), cardButton('허용', 'small danger', () => answer(card, 'allow')));
      box.append(reason, row);
    } else if (card.kind === 'memory') {
      drawMemoryCard(box, card);
    } else {
      box.append(el('h2', '', 'Claude Code의 질문'), el('p', 'tool-name', card.question));
      if (card.hidden) box.append(el('p', 'hidden-note', `보이지 않는 글자 ${card.hidden}개가 들어 있어 [U+...]로 표시했습니다.`));
      const options = el('div', 'options');
      for (const option of card.options) options.append(cardButton(option, 'small', () => answer(card, 'answer', option)));
      const free = Object.assign(el('input', ''), { type: 'text', placeholder: '직접 답하기', spellcheck: false });
      const row = el('div', 'actions');
      row.append(cardButton('답하지 않기', 'small', () => answer(card, 'deny')), cardButton('보내기', 'small primary', () => answer(card, 'answer', free.value)));
      box.append(options, free, row);
    }
    window.aiChat.call('cardShown', card.id);
    return box;
  }

  /**
   * save_memory: [저장] keeps the text as shown, [고쳐서 저장] opens it for editing first, [취소] keeps nothing. What is in the boxes
   * when the user clicks is what the widget checks and keeps.
   */
  function drawMemoryCard(box, card) {
    box.append(el('h2', '', '이 내용을 기억할까요?'), el('p', 'hint', '저장하면 앞으로 모든 새 대화에 전달됩니다. 설정의 "기억"에서 고치거나 끄거나 지울 수 있습니다.'));
    if (card.external) box.append(el('p', 'hidden-note', '웹 페이지·메일 같은 외부 내용을 읽은 대화에서 나온 요청입니다. 그 내용에 숨은 지시가 아닌지 확인해 주세요.'));
    if (card.hidden) box.append(el('p', 'hidden-note', `보이지 않는 글자 ${card.hidden}개가 들어 있어 [U+...]로 표시했습니다.`));
    for (const s of card.secrets) box.append(el('p', 'hidden-note', `비밀처럼 보이는 값: ${s}`));
    for (const r of card.risks) box.append(el('p', 'hidden-note', `확인할 문구 - ${r}`));
    const title = Object.assign(el('input', 'memory-title', ''), { type: 'text', value: card.title, placeholder: '제목 (선택)', spellcheck: false, readOnly: true, maxLength: 80 });
    const text = Object.assign(el('textarea', 'memory-text', ''), { value: card.text, rows: 3, spellcheck: false, readOnly: true, maxLength: 1000 });
    box.append(title, text);
    let notSecret = null;
    if (card.secrets.length) {
      notSecret = Object.assign(document.createElement('input'), { type: 'checkbox' });
      const label = el('label', 'check', '');
      label.append(notSecret, ' 비밀이 아닙니다');
      box.append(label);
    }
    const msg = el('p', 'status err', '');
    const send = async (action) => {
      const res = await window.aiChat.call('answerCard', { id: card.id, action, text: text.value, title: title.value, allowFlags: notSecret?.checked === true, trusted: true });
      msg.textContent = res && res.ok === false ? res.message : '';
    };
    const row = el('div', 'actions');
    const edit = cardButton('고쳐서 저장', 'small', () => {
      if (text.readOnly) {
        title.readOnly = false;
        text.readOnly = false;
        edit.textContent = '고친 내용 저장';
        text.focus();
      } else send('save');
    });
    row.append(cardButton('취소', 'small', () => send('cancel')), edit, cardButton('저장', 'small primary', () => send('save')));
    box.append(row, msg);
  }

  /** Only this session's cards, kept outside the log: nothing the model writes in the log can look like one. */
  function drawCards() {
    const mine = cards.filter((c) => c.sessionId === current);
    const area = $('cards');
    for (const box of [...area.children]) if (!mine.some((c) => c.id === box.dataset.card)) box.remove();
    const fresh = [];
    for (const card of mine) {
      if (area.querySelector(`[data-card="${card.id}"]`)) continue;
      const box = drawCard(card);
      area.append(box);
      fresh.push(box);
    }
    if (mine.length) answerBubble();
    placeControls();
    if (fresh.length) fresh[fresh.length - 1].scrollIntoView({ block: 'nearest' });
  }

  // Amounts: two decimals at most, under a cent as such (lib/money.js has the same rule). Sums are kept exact by the widget.
  const money = (n) => (!(n > 0) ? '$0.00' : (n < 0.01 ? '$0.01 미만' : `$${n.toFixed(2)}`));
  const aboutMoney = (n) => (n > 0 && n < 0.01 ? money(n) : (n > 0 ? `약 ${money(n)}` : money(0)));

  /**
   * The month's budget as a gauge of the share used. Every number is an estimate and the details say so; they open on hover, on
   * focus with Enter or Space, or on a click, and a clicked one closes on a click outside or Escape.
   */
  function drawBand(b) {
    if (!b) return;
    const share = b.budgetUsd > 0 ? b.spentUsd / b.budgetUsd : 0;
    const pct = Math.min(100, Math.floor(share * 100));
    $('band').className = `band ${b.level === 'ok' ? '' : b.level}`;
    $('gaugeLabel').textContent = '이번 달 예산';
    $('gaugeFill').style.width = `${Math.min(100, share * 100)}%`;
    $('gaugePct').textContent = !b.hasData ? '아직 없음' : (share > 0 && pct === 0 ? '1% 미만' : `${pct}% (추정)`);
    $('gauge').setAttribute('aria-label', `이번 달 예산 ${b.hasData ? `${pct}퍼센트 사용, 추정` : '사용 없음'}. 눌러서 상세 보기`);
    const rows = [
      ['이번 달 사용액', b.hasData ? `${aboutMoney(b.spentUsd)} (추정)` : '아직 없음'],
      ['월 예산', money(b.budgetUsd)],
      ['남은 금액', `${aboutMoney(b.remainingUsd)} (추정)`],
      ['작업 하나의 상한', b.taskCapUsd ? money(b.taskCapUsd) : '-'],
      ['기간 시작', b.period || '-'],
    ];
    $('bandRows').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
    const notes = ['이 위젯이 쓴 금액만 추정한 값입니다. 다른 프로그램의 사용과 실제 잔액은 Console에서 보세요.'];
    if (b.partial) notes.push('중단된 실행 일부는 미반영입니다.');
    if (b.level === 'warn') notes.push('예산의 80%를 넘었습니다.');
    if (b.level === 'over') notes.push('예산에 닿아 새 작업을 시작하지 않습니다.');
    $('bandNote').textContent = notes.join(' ');
    $('bandSettings').hidden = b.level !== 'over';
  }

  function showBandDetail(open, pinned = bandPinned) {
    bandPinned = open && pinned;
    $('bandDetail').hidden = !open;
    $('gauge').setAttribute('aria-expanded', String(open));
  }

  const TOOLS_TEXT = {
    off: '위젯 도구(캘린더·메일·할 일 노트 등)가 꺼져 있습니다. 위젯 관리의 "AI 도우미 연결 (MCP)"을 켜면 씁니다. 켜면 이 PC의 다른 AI 앱도 연결할 수 있습니다.',
    empty: 'AI 도우미 연결은 켜져 있지만 쓸 수 있는 위젯 도구가 없습니다. 위젯 관리에서 위젯별 허용과 위젯이 켜져 있는지 확인해 주세요.',
    unavailable: '이 엔진에서 위젯 도구 연결 파일을 찾지 못했습니다. Desk Widgets를 다시 설치해 주세요.',
  };

  function drawTools(t) {
    const text = t && TOOLS_TEXT[t.state];
    $('toolsBanner').hidden = !text || hiddenNotice('widget-tools');
    $('toolsText').textContent = text || '';
    $('toolsManager').hidden = t?.state === 'unavailable';
  }

  // ---- the conversation list: width and folding ----

  /** Never so wide that the conversation gets less than about 420px. */
  const widthLimit = () => Math.max(layout.min, Math.min(layout.max, window.innerWidth - 420));
  const clampWidth = (w) => Math.round(Math.min(widthLimit(), Math.max(layout.min, w)));

  function applySide() {
    const width = clampWidth(layout.sideWidth);
    $('app').style.setProperty('--side-width', `${width}px`);
    $('app').classList.toggle('side-collapsed', layout.sideCollapsed);
    const s = $('splitter');
    s.setAttribute('aria-valuemin', String(layout.min));
    s.setAttribute('aria-valuemax', String(widthLimit()));
    s.setAttribute('aria-valuenow', String(width));
    $('sideToggle').textContent = layout.sideCollapsed ? '목록 보기' : '목록 접기';
    $('sideToggle').setAttribute('aria-expanded', String(!layout.sideCollapsed));
  }

  /** Saved for the next time; the window does not wait for it. */
  function saveSide(change) {
    Object.assign(layout, change);
    applySide();
    window.aiChat.call('setLayout', { sideWidth: layout.sideWidth, sideCollapsed: layout.sideCollapsed }).then((saved) => {
      if (saved) Object.assign(layout, saved);
    });
  }

  function setWidth(width) {
    saveSide({ sideWidth: clampWidth(width) });
  }

  function fitToWindow() {
    if (window.innerWidth < NARROW && !layout.sideCollapsed) {
      autoFolded = true;
      layout.sideCollapsed = true; // not saved: the user did not ask for it
    } else if (window.innerWidth >= NARROW && autoFolded) {
      autoFolded = false;
      layout.sideCollapsed = false;
    }
    applySide();
  }

  // ---- notices that may wait: closed here, or put off for 7 days ----

  const hiddenNotice = (kind) => Boolean(snoozed[kind]) || closedHere.has(kind);

  /** Adds "닫기" and "이번 주 그만 보기" to every notice that may be put off. Safety, money and errors never get them. */
  function snoozeControls() {
    for (const box of document.querySelectorAll('.snoozable')) {
      if (box.querySelector('.snooze-row')) continue;
      const kind = box.dataset.notice;
      const row = el('span', 'snooze-row', '');
      const check = Object.assign(document.createElement('input'), { type: 'checkbox' });
      const label = el('label', '', '');
      label.append(check, ' 이번 주 그만 보기');
      const close = el('button', 'small', '닫기');
      close.type = 'button';
      close.addEventListener('click', async () => {
        closedHere.add(kind);
        if (check.checked) {
          await window.aiChat.call('snoozeNotice', kind);
          snoozed[kind] = true;
        }
        check.checked = false; // unticked again when it comes back
        box.hidden = true;
      });
      row.append(label, close);
      box.append(row);
    }
  }

  function drawNotices(s) {
    $('boundaryNotice').hidden = hiddenNotice('folder-boundary');
    const version = (s.prerequisites?.notes || []).map((n) => n.message).join(' ');
    $('versionText').textContent = version;
    $('versionNotice').hidden = !version || hiddenNotice('unverified-version');
    // A process left over from a crash: always said (it may still be changing files).
    const left = (s.notices || []).map((n) => n.message);
    $('noticeArea').hidden = !left.length;
    $('noticeArea').textContent = left.join(' ');
  }

  function drawErrorBanner(error) {
    const link = error?.link;
    const retry = error?.retryable === true;
    $('errorBanner').hidden = !link && !retry;
    if ($('errorBanner').hidden) return;
    $('errorHint').textContent = retry ? '같은 명령을 조금 뒤 다시 보낼 수 있습니다. 자동으로 다시 보내지는 않습니다.' : '이 오류는 다시 보내도 해결되지 않습니다.';
    $('errorLink').hidden = !link;
    if (link) {
      $('errorLink').textContent = LINK_LABELS[link] || '안내 열기';
      $('errorLink').onclick = () => window.aiChat.call('openLink', link);
    }
    $('errorRetry').hidden = !retry;
  }

  function closeConfirms() {
    $('confirmRow').hidden = true;
    confirmAction = null;
    $('folderConfirm').hidden = true;
    pendingFolder = null;
  }

  async function openSession(id) {
    current = id;
    stream = null;
    closeConfirms();
    if (id !== keepBannerFor) drawErrorBanner(null);
    keepBannerFor = null;
    const data = await window.aiChat.call('open', id);
    clearLog();
    for (const item of data?.items || []) drawItem(item);
    settleGroups();
    satisfied = Boolean(data?.session?.satisfied);
    const lastKinds = (data?.items || []).filter((i) => i.k !== 'meta').map((i) => i.k);
    const tail = lastKinds[lastKinds.length - 1];
    showFeedback = tail === 'ai' || tail === 'feedback' || tail === 'draftDone' || tail === 'tool';
    drawUsed(data?.session?.usedRecipes);
    drawList();
    drawCards();
    drawFeedback();
    scrollEnd(true); // a conversation opens at its newest message
    if (data?.draft && !$('chatView').hidden) showDraft(id, data.draft, data.session.external);
  }

  function newConversation() {
    current = null;
    stream = null;
    draftFolder = null;
    closeConfirms();
    showFeedback = false;
    satisfied = false;
    drawUsed([]);
    drawFeedback();
    $('modeBanner').hidden = true;
    clearLog();
    drawList();
    drawCards();
    $('prompt').focus();
  }

  function askConfirm(text, button, action) {
    $('confirmText').textContent = text;
    $('confirmYes').textContent = button;
    confirmAction = action;
    $('confirmRow').hidden = false;
  }

  function onRun(event) {
    if (event.sessionId !== current) return;
    if (event.type !== 'toolCall') settleGroups();
    if (event.type === 'textDelta') streamText(event.text);
    else if (event.type === 'text') {
      if (stream) stream.el.replaceChildren(window.AiChatMarkdownView.render(event.text));
      else line('text', event.text);
      stream = null;
    } else if (event.type === 'toolCall') {
      runningSession = current;
      toolLine(event.name, event.input, true);
    }
    else if (event.type === 'fetched') fetchedLine(event);
    else if (event.type === 'fetchState') fetchWait(event);
    else if (event.type === 'notice' && event.kind === 'mcp-server') line('err', event.message);
    else if (event.type === 'notice' || event.type === 'keyRetry') line('meta', event.message);
    else if (event.type === 'apiRetry') line('meta', `API 오류로 다시 시도 중입니다${event.attempt ? ` (${event.attempt}${event.maxRetries ? `/${event.maxRetries}` : ''}번째)` : ''}: ${event.error || '알 수 없음'}`);
    else if (event.type === 'rateLimit' && event.status && event.status !== 'allowed') line('meta', `일시 제한: ${event.status}`);
    else if (event.type === 'done') {
      fetchWait(null);
      $('modeBanner').hidden = event.error?.kind !== 'mode-changed';
      drawErrorBanner(event.ok ? null : event.error);
      keepBannerFor = current;
      // The record has everything now, including what arrived while the conversation was opening.
      openSession(current);
    }
  }

  // ---- attachments ----

  function drawAttachments() {
    const chips = draftFiles.map((f) => {
      const chip = el('div', `attach-chip${f.warnings?.length ? ' warned' : ''}`, '');
      chip.dataset.attachment = f.id;
      if (f.thumb && /^data:image\/(png|jpeg|gif|webp);base64,/.test(f.thumb)) chip.append(Object.assign(document.createElement('img'), { src: f.thumb, alt: '' }));
      else chip.append(el('span', 'attach-icon', f.kind === 'image' ? '🖼' : '📄'));
      const words = el('div', '', '');
      words.style.minWidth = '0';
      const name = el('div', 'attach-name', f.name);
      name.title = f.name;
      words.append(name, el('span', 'attach-size', sizeText(f.size)));
      for (const w of f.warnings || []) words.append(el('span', 'attach-warn', w));
      const out = el('button', 'small', '✕');
      out.type = 'button';
      out.title = '빼기';
      out.setAttribute('aria-label', `${f.name} 빼기`);
      out.addEventListener('click', () => {
        window.aiChat.call('removeAttachment', f.id);
        draftFiles = draftFiles.filter((x) => x.id !== f.id);
        drawAttachments();
      });
      chip.append(words, out);
      return chip;
    });
    $('attachList').replaceChildren(...chips);
    $('attachList').hidden = !chips.length;
  }

  function attachMessage(text) {
    $('attachMsg').textContent = text || '';
    $('attachMsg').hidden = !text;
  }

  function took(res) {
    if (res?.ok) {
      draftFiles.push(res.attachment);
      if (res.needsNotice) $('attachNotice').hidden = false;
    } else if (res?.message) attachMessage(res.message);
  }

  /** Files from a drop or a paste: by path when the file has one, else by its bytes. */
  async function addFiles(files) {
    attachMessage('');
    for (const file of files) {
      const where = window.aiChat.pathForFile(file);
      took(await window.aiChat.call('addAttachment', where ? { path: where } : { name: file.name, data: await file.arrayBuffer() }));
    }
    drawAttachments();
  }

  async function submit(prompt, cwd = null, when = null) {
    lastPrompt = prompt;
    drawErrorBanner(null);
    $('sendChoice').hidden = true;
    const res = await window.aiChat.call('send', { sessionId: current, prompt, cwd: current ? null : (cwd || draftFolder), recipeIds: picked, attachmentIds: draftFiles.map((f) => f.id), when });
    if (res.ok) {
      $('prompt').value = '';
      draftFiles = [];
      drawAttachments();
      attachMessage('');
      picked = [];
      drawPicked();
      showFeedback = false;
      drawFeedback();
      if (!current) {
        current = res.sessionId;
        list = await window.aiChat.call('list');
        await openSession(res.sessionId);
      } else userBubble(prompt, res.attachments);
      return;
    }
    if (res.code === 'attach-notice') {
      $('attachNotice').hidden = false;
      return;
    }
    if (res.code === 'folder-confirm') {
      pendingFolder = { prompt, cwd: res.cwd };
      $('folderConfirmText').textContent = `이 폴더에서 처음 실행합니다: ${res.cwd}. 작업 폴더는 격리 공간이 아니고, Claude Code가 이 폴더 안팎의 파일을 고칠 수 있습니다.`;
      $('folderConfirm').hidden = false;
      return;
    }
    line('err', res.message);
  }

  const busyHere = () => ['running', 'queued'].includes(current && sessionOf(current)?.state);

  /** While this conversation works, the user picks: a correction now, or a prompt for after. */
  function send() {
    const prompt = $('prompt').value.trim();
    if (!prompt && !draftFiles.length) return;
    if (busyHere()) {
      $('sendChoice').hidden = false;
      $('sendCorrect').hidden = sessionOf(current)?.state !== 'running';
      return;
    }
    submit(prompt);
  }
  const sendAs = (when) => {
    const prompt = $('prompt').value.trim();
    if (prompt || draftFiles.length) submit(prompt, null, when);
  };

  // ---- the page ----

  function fillModels(s) {
    const rows = s.models.map((m) => {
      const label = document.createElement('label');
      const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'model', value: m.id, checked: m.id === s.model });
      label.append(radio, ` ${m.label}`, Object.assign(document.createElement('small'), { textContent: m.cost }));
      return label;
    });
    $('modelChoices').replaceChildren(...rows);
  }

  async function refresh() {
    const s = await window.aiChat.call('state');
    view = s;
    list = s.list;
    cards = s.cards;
    snoozed = s.snoozed || {};
    if (s.layout) {
      layout = { ...s.layout };
      fitToWindow();
    }
    drawBand(s.budget);
    drawTools(s.widgetTools);
    toolTitles = s.widgetTools?.titles || {};
    if (s.consent) {
      $('consentTitle').textContent = s.consent.title;
      $('consentItems').replaceChildren(...s.consent.items.map((item) => {
        const li = document.createElement('li');
        rich(li, item);
        return li;
      }));
      show('consent');
      return;
    }
    if (!s.key.has) {
      blocked({ title: 'API 키가 필요합니다', text: '내 Anthropic API 키를 넣어야 쓸 수 있습니다. 키가 없으면 아무것도 실행하지 않습니다. 설정에서 전용 workspace의 키를 넣어 주세요.', settings: true });
      return;
    }
    const problem = s.prerequisites?.problems?.[0];
    if (problem) {
      blocked({ title: problem.kind === 'too-old' ? 'Claude Code 업데이트가 필요합니다' : 'Claude Code가 필요합니다', text: problem.message, link: problem.link });
      return;
    }
    if (s.needsModel) {
      fillModels(s);
      show('modelPage');
      return;
    }
    drawNotices(s);
    show('app');
    drawList();
    drawCards();
    fillPick();
  }

  function showChat() {
    $('recipesView').hidden = true;
    $('chatView').hidden = false;
  }

  function showDraft(sessionId, draft, external) {
    $('chatView').hidden = true;
    $('recipesView').hidden = false;
    window.AiChatRecipes.open({ ...draft, sessionId, external });
  }

  window.AiChatRecipes.init({
    call: (name, arg) => window.aiChat.call(name, arg),
    onOpenSession: (id) => {
      showChat();
      if (list.sessions.some((s) => s.id === id)) openSession(id);
    },
  });
  $('openRecipes').addEventListener('click', () => {
    $('chatView').hidden = true;
    $('recipesView').hidden = false;
    window.AiChatRecipes.showList();
  });
  $('recipesBack').addEventListener('click', async () => {
    showChat();
    await fillPick();
    if (current) openSession(current);
  });
  $('recipePick').addEventListener('change', () => {
    const id = $('recipePick').value;
    if (id && !picked.includes(id)) picked.push(id);
    $('recipePick').value = '';
    drawPicked();
  });
  $('fbGood').addEventListener('click', async () => {
    await window.aiChat.call('feedback', { sessionId: current, kind: 'good' });
    satisfied = true;
    list = await window.aiChat.call('list');
    drawFeedback();
  });
  $('fbBad').addEventListener('click', () => {
    $('badBar').hidden = false;
    $('badReason').focus();
  });
  $('badCancel').addEventListener('click', () => { $('badBar').hidden = true; });
  $('badSend').addEventListener('click', async () => {
    const res = await window.aiChat.call('feedback', { sessionId: current, kind: 'bad', reason: $('badReason').value });
    if (!res.ok) {
      line('err', res.message);
      return;
    }
    $('badReason').value = '';
    $('badBar').hidden = true;
    openSession(current);
  });
  $('fbAgain').addEventListener('click', async () => {
    const res = await window.aiChat.call('feedback', { sessionId: current, kind: 'again' });
    if (res.ok) openSession(current);
    else line('err', res.message);
  });
  $('fbSummary').addEventListener('click', async () => {
    const res = await window.aiChat.call('requestSummary', current);
    if (!res.ok) line('err', res.message);
    else openSession(current);
  });

  $('consentAccept').addEventListener('click', async () => {
    await window.aiChat.call('acceptConsent');
    refresh();
  });
  $('modelAccept').addEventListener('click', async () => {
    const picked = document.querySelector('input[name="model"]:checked');
    if (picked) await window.aiChat.call('chooseModel', picked.value);
    refresh();
  });
  $('blockedSettings').addEventListener('click', () => window.aiChat.call('openSettings'));
  $('blockedRetry').addEventListener('click', refresh);
  $('openSettings').addEventListener('click', () => window.aiChat.call('openSettings'));
  $('newChat').addEventListener('click', newConversation);
  $('readOnlyNew').addEventListener('click', newConversation);
  $('folderBtn').addEventListener('click', async () => {
    const dir = await window.aiChat.call('pickFolder');
    if (dir) {
      draftFolder = dir;
      drawHead();
    }
  });
  $('folderYes').addEventListener('click', async () => {
    const pending = pendingFolder;
    closeConfirms();
    if (!pending) return;
    await window.aiChat.call('confirmFolder', pending.cwd);
    submit(pending.prompt, pending.cwd);
  });
  $('folderNo').addEventListener('click', closeConfirms);
  $('pinBtn').addEventListener('click', () => {
    const s = sessionOf(current);
    if (s) window.aiChat.call('setPinned', { id: s.id, pinned: !s.pinned });
  });
  $('clearBtn').addEventListener('click', () => {
    askConfirm('Claude Code가 가진 이 대화의 전체 기록을 지웁니다. 지우면 이어 갈 수 없고, 위젯의 대화 내용만 읽을 수 있습니다.', '기록 지우기', async () => {
      const res = await window.aiChat.call('clearRecord', current);
      if (res.ok) openSession(current);
      else line('err', res.message);
    });
  });
  $('removeBtn').addEventListener('click', () => {
    askConfirm('이 대화와 Claude Code 기록을 모두 지웁니다. 되돌릴 수 없습니다.', '삭제', async () => {
      const res = await window.aiChat.call('remove', current);
      if (res.ok) newConversation();
      else line('err', res.message);
    });
  });
  $('confirmYes').addEventListener('click', () => {
    const action = confirmAction;
    closeConfirms();
    action?.();
  });
  $('confirmNo').addEventListener('click', closeConfirms);
  $('bandConsole').addEventListener('click', () => window.aiChat.call('openLink', 'billing'));
  $('gauge').addEventListener('mouseenter', () => { if (!bandPinned) showBandDetail(true, false); });
  $('band').addEventListener('mouseleave', () => { if (!bandPinned) showBandDetail(false); });
  $('gauge').addEventListener('click', () => showBandDetail(!bandPinned, true));
  $('gauge').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      showBandDetail(!bandPinned, true);
    } else if (event.key === 'Escape') showBandDetail(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('bandDetail').hidden) showBandDetail(false);
  });
  document.addEventListener('click', (event) => {
    if (bandPinned && !$('band').contains(event.target)) showBandDetail(false);
  });
  $('bandSettings').addEventListener('click', () => window.aiChat.call('openSettings'));
  $('errorRetry').addEventListener('click', () => {
    $('prompt').value = lastPrompt;
    drawErrorBanner(null);
    $('prompt').focus();
  });
  $('modeManual').addEventListener('click', async () => {
    await window.aiChat.call('useManualMode');
    $('modeBanner').hidden = true;
  });
  $('send').addEventListener('click', send);
  $('sendCorrect').addEventListener('click', () => sendAs('correct'));
  $('sendAfter').addEventListener('click', () => sendAs('after'));
  $('sendChoiceCancel').addEventListener('click', () => { $('sendChoice').hidden = true; });
  $('stop').addEventListener('click', () => window.aiChat.call('stop', current));
  $('cancelQueue').addEventListener('click', () => window.aiChat.call('cancelQueued', current));
  // Enter sends, Shift+Enter is a new line. Not while an IME (Korean) is still composing: that Enter finishes the syllable.
  $('prompt').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  });
  $('toolsManager').addEventListener('click', () => window.aiChat.call('openManager'));
  // Attachments: 📎, drop anywhere on the conversation, Ctrl+V of files or images. A drop never opens the file in the window.
  $('attachBtn').addEventListener('click', async () => {
    attachMessage('');
    const res = await window.aiChat.call('pickAttachments');
    for (const r of res?.results || []) took(r.ok ? { ...r, needsNotice: res.needsNotice } : r);
    drawAttachments();
  });
  $('attachNoticeOk').addEventListener('click', async () => {
    await window.aiChat.call('ackAttachNotice');
    $('attachNotice').hidden = true;
  });
  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    const inChat = !$('chatView').hidden && $('chatView').contains(event.target);
    $('chatView').classList.toggle('dropping', inChat && [...(event.dataTransfer?.types || [])].includes('Files'));
  });
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) $('chatView').classList.remove('dropping');
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    $('chatView').classList.remove('dropping');
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length && !$('chatView').hidden && !$('composer').hidden) addFiles(files);
  });
  $('prompt').addEventListener('paste', (event) => {
    const data = event.clipboardData;
    const files = [...(data?.files || [])];
    if (files.length) {
      event.preventDefault();
      addFiles(files);
      return;
    }
    const text = data?.getData('text/plain') || '';
    if (text.length > LONG_PASTE) {
      event.preventDefault();
      window.aiChat.call('addAttachment', { name: '붙여넣은 글.txt', text }).then((res) => {
        took(res);
        drawAttachments();
        if (res?.ok) attachMessage(`긴 글(${text.length.toLocaleString()}자)은 입력 칸 대신 첨부 파일로 넣었습니다.`);
      });
    }
  });
  $('log').addEventListener('click', (event) => {
    const link = event.target.closest?.('.md-link');
    if (link) askOpen(link.dataset.url);
  });
  $('log').addEventListener('keydown', (event) => {
    const link = event.target.closest?.('.md-link');
    if (link && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      askOpen(link.dataset.url);
    }
  });
  $('linkOpen').addEventListener('click', (event) => {
    if (!event.isTrusted || !pendingUrl) return;
    window.aiChat.call('openUrl', { url: pendingUrl, trusted: true });
    pendingUrl = null;
    $('linkConfirm').hidden = true;
  });
  $('linkCancel').addEventListener('click', () => {
    pendingUrl = null;
    $('linkConfirm').hidden = true;
  });
  // The list's edge: drag with the mouse, double-click for the default width, arrows when focused (Home/End for the ends).
  $('splitter').addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const splitter = $('splitter');
    const startX = event.clientX;
    const startWidth = $('side').getBoundingClientRect().width;
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    const move = (e) => {
      layout.sideWidth = clampWidth(startWidth + e.clientX - startX);
      applySide();
    };
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      setWidth(layout.sideWidth);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  $('splitter').addEventListener('dblclick', () => setWidth(layout.default));
  $('splitter').addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 40 : 16;
    const now = clampWidth(layout.sideWidth);
    const next = { ArrowLeft: now - step, ArrowRight: now + step, Home: layout.min, End: widthLimit() }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setWidth(next);
  });
  $('sideToggle').addEventListener('click', () => {
    autoFolded = false;
    saveSide({ sideCollapsed: !layout.sideCollapsed });
  });
  window.addEventListener('resize', fitToWindow);
  // Back from the widget manager: show at once whether the widget tools are on now.
  window.addEventListener('focus', async () => {
    if ($('app').hidden) return;
    const tools = await window.aiChat.call('widgetTools');
    drawTools(tools);
    toolTitles = tools?.titles || {};
  });
  window.aiChat.on((name, payload) => {
    if (name === 'run') onRun(payload);
    else if (name === 'list') {
      list = payload;
      if (view && !$('app').hidden) {
        drawList();
        drawFeedback();
      }
    } else if (name === 'budget') drawBand(payload);
    else if (name === 'draft') {
      if (payload.sessionId === current) showDraft(payload.sessionId, payload, payload.external);
    } else if (name === 'recipes') {
      if (payload.sessionId === current) drawUsed(payload.usedRecipes);
    }
    else if (name === 'cards') {
      cards = payload;
      if (view && !$('app').hidden) drawCards();
    } else if (name === 'focusSession') {
      if (payload) openSession(payload);
    } else if (name === 'noticesReset') closedHere.clear();
    else if (name === 'changed') refresh();
  });
  snoozeControls();
  refresh();
})();
