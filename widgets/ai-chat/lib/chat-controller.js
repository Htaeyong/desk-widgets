// What happens around a run (#129, design 7, 11, 14): the queue, one run per session, the session's record, and what the
// window hears. It knows the runner only through check / start / inspect (design 15).
const fs = require('fs');
const path = require('path');
const { shortInput } = require('./sessions');
const { approvalCard, questionCard, memoryCard, allowAnswer, denyAnswer, cleanAnswer } = require('./cards');
const { memoryNote, MAX_TEXT: MEMORY_MAX_TEXT } = require('./memory');
const { createHostServer } = require('./host-server');
const { costOfUsage, deltaOfReport } = require('./budget');
const { aboutMoney } = require('./money');
const { scanSecrets, scanRisks, isExternalRead, containsKey } = require('./recipe-safety');
const { SUMMARY_REQUEST, parseSummary, wrapRecipe, promptWithRecipes, systemNote } = require('./recipe-prompts');
const { RECIPE_ID, MAX_TITLE } = require('./recipes');
const { attachmentNote, imageType, ATTACH_DIR } = require('./attachments');
const { FETCH_TOOL } = require('./cards');

const FETCH_TOOLS = new Set([FETCH_TOOL, `${FETCH_TOOL}_status`]);
const FETCH_MAX = 20 * 1024 * 1024;
const KEY_HIDDEN = '[키 가림]'; // what stands in for the widget's key in a typed card answer, as in the runner's output

// What a run without the widget tools says, in the conversation and the record.
const TOOLS_OFF = {
  off: '이 실행에는 위젯 도구(캘린더·메일·할 일 노트 등)가 없습니다. 위젯 관리의 "AI 도우미 연결 (MCP)"이 꺼져 있습니다.',
  empty: 'AI 도우미 연결은 켜져 있지만 쓸 수 있는 위젯 도구가 없습니다. 위젯 관리에서 위젯별 허용을 확인해 주세요.',
  unavailable: '이 엔진에서 위젯 도구 연결 파일을 찾지 못해 위젯 도구 없이 실행합니다.',
};

const ARM_MS = 400; // a card cannot be answered this soon after it appears, so a click meant for something else cannot land on it

/**
 * @param {object} o
 * @param {object} o.runner  check() / start() / inspect()
 * @param {object} o.sessions  lib/sessions.js
 * @param {function} o.getKey  the API key, in this process only
 * @param {function} o.settings  the current settings
 * @param {function} o.rememberFolder  (dir) keeps a folder the user confirmed
 * @param {function} o.knowsFolder  (dir) -> boolean
 * @param {function} o.gate  -> null, or { code, message } when nothing may run yet (consent, key, model)
 * @param {function} o.emit  (name, payload) to the window
 * @param {function} o.defaultDir  -> the default work folder
 * @param {string} o.runsFile  remembers the running processes, for after a crash
 * @param {object} o.mcp  { dir, hostScript, widgetTools() -> { state, tools, server? }, fetchedDir: where the Dooray widget saves originals }
 * @param {function} o.alert  (session, card view) when no window can show a card now
 * @param {function} o.now
 * @param {object} o.budget  lib/budget.js
 * @param {object} o.recipes  lib/recipes.js
 * @param {object} o.memory  lib/memory.js: what the user approved to keep, given to every run
 * @param {object} o.attachments  lib/attachments.js; o.attachNoticeSeen() says whether the user saw that attachments go to Anthropic
 */
function createChatController({ runner, sessions, getKey, settings, rememberFolder, knowsFolder, gate, emit, defaultDir, runsFile, mcp, alert = () => {}, now = Date.now, budget, recipes, memory, attachments, attachNoticeSeen = () => true }) {
  const running = new Map(); // session id -> { handle, stopRequested }
  const queue = []; // [{ sessionId, prompt }]
  let notices = [];
  const cards = new Map(); // card id -> { card, sessionId, resolve, shownAt, timer }

  const listView = () => ({
    sessions: sessions.list().map((s) => ({ ...s, waiting: cardViews().some((c) => c.sessionId === s.id), state: running.has(s.id) ? 'running' : (queue.some((q) => q.sessionId === s.id) ? 'queued' : s.status) })),
    queue: queue.map((q) => q.sessionId),
    running: [...running.keys()],
  });
  const pushList = () => emit('list', listView());
  const isBusy = (id) => running.has(id) || queue.some((q) => q.sessionId === id);

  // ---- cards ----

  /**
   * A card's typed answer goes to Claude Code as is: the widget's key is taken out of it. When it is still there in another form
   * (broken up, Base64), nothing of the answer is passed on.
   */
  const withoutKey = (text) => {
    const key = getKey();
    if (!key || !containsKey(text, key)) return String(text);
    const hidden = String(text).split(key).join(KEY_HIDDEN);
    return containsKey(hidden, key) ? KEY_HIDDEN : hidden;
  };

  function cardViews() {
    return [...cards.values()].map((entry) => ({ id: entry.card.id, sessionId: entry.sessionId, ...entry.card.view }));
  }

  function settleCard(entry, answer, decision) {
    clearTimeout(entry.timer);
    cards.delete(entry.card.id);
    entry.resolve(answer);
    const { view } = entry.card;
    const what = { approval: () => `승인 요청 ${view.tool}`, question: () => `질문 "${view.question}"`, memory: () => '기억 저장 요청' }[view.kind]();
    if (sessions.get(entry.sessionId)) sessions.append(entry.sessionId, { k: 'card', text: `${what}: ${decision}` });
    emit('cards', cardViews());
    pushList();
  }

  /** A card waits as long as it takes, unless the user set a time limit. Nothing here can answer it but a click. */
  function raiseCard(sessionId, card, whenRefused) {
    return new Promise((resolve) => {
      const entry = { card, sessionId, resolve, shownAt: 0, timer: null, whenRefused };
      cards.set(card.id, entry);
      const minutes = settings().cardTimeoutMinutes;
      if (minutes) {
        entry.timer = setTimeout(() => settleCard(entry, whenRefused('The user did not answer in time.'), '시간 초과로 거부'), minutes * 60000);
        entry.timer.unref?.();
      }
      emit('cards', cardViews());
      pushList();
      alert(sessions.get(sessionId), card.view);
    });
  }

  function closeCards(sessionId, why = 'The run ended before the user answered.', decision = '실행이 끝나 거부') {
    for (const entry of [...cards.values()]) {
      if (entry.sessionId === sessionId) settleCard(entry, entry.whenRefused(why), decision);
    }
  }

  /**
   * Remembers that a recipe went into this conversation. This is the only way a recipe shows as used: a tool call or the user's own
   * pick, never what the model says about it.
   */
  function recordUse(sessionId, id, recipe, source) {
    const session = sessions.get(sessionId);
    if (!session) return;
    recipes.markUsed(id);
    const used = session.usedRecipes || [];
    if (!used.some((u) => u.id === id && u.version === recipe.version)) {
      sessions.update(sessionId, { usedRecipes: [...used, { id, title: recipe.title, version: recipe.version, source }] });
      sessions.append(sessionId, { k: 'meta', text: `요약을 썼습니다: ${recipe.title} v${recipe.version}` });
    }
    emit('recipes', { sessionId, usedRecipes: sessions.get(sessionId).usedRecipes });
    pushList();
  }

  /** What ai-chat-host asks. Unknown calls get nothing. */
  function onHostCall(sessionId, method, args) {
    if (method === 'approve') {
      const card = approvalCard(args);
      if (card.tooLarge) {
        sessions.append(sessionId, { k: 'meta', text: `승인 요청 ${card.view.tool}: 입력이 너무 커서 보여 줄 수 없어 거부했습니다.` });
        return denyAnswer('The input is too large to show to the user, so it was not approved.');
      }
      return raiseCard(sessionId, card, denyAnswer);
    }
    if (method === 'ask_user') return raiseCard(sessionId, questionCard(args), () => null);
    if (method === 'save_memory') return askToRemember(sessionId, args);
    if (method === 'list_memory') return { text: JSON.stringify({ memories: memory.list().map((m) => ({ title: m.title, text: m.text, on: m.enabled })) }) };
    if (method === 'list_recipes') return { text: JSON.stringify({ recipes: recipes.catalog(sessions.get(sessionId)?.excludedRecipes || []) }) };
    if (method === 'read_recipe') {
      const id = String(args?.id ?? '');
      if (!RECIPE_ID.test(id) || !recipes.get(id)) return { text: 'There is no such recipe.', isError: true };
      if ((sessions.get(sessionId)?.excludedRecipes || []).includes(id)) return { text: 'The user excluded this recipe from this conversation. Do not use it.', isError: true };
      const recipe = recipes.read(id);
      if (!recipe) return { text: 'There is no such recipe.', isError: true };
      recordUse(sessionId, id, recipe, 'tool');
      return { text: wrapRecipe(recipe) };
    }
    return null;
  }

  // ---- memory ----

  const scanMemory = (text, title = '') => {
    const key = getKey();
    return { secrets: [...scanSecrets(text, key), ...scanSecrets(title, key)], risks: [...scanRisks(title), ...scanRisks(text)] };
  };

  /** save_memory: a card first, always. The widget's key never reaches one; nothing is kept but by a click. */
  function askToRemember(sessionId, args) {
    const text = String(args?.text ?? '').trim();
    if (!text) return { text: 'Nothing to remember: the text is empty.', isError: true };
    if (text.length > MEMORY_MAX_TEXT) return { text: `A memory can be at most ${MEMORY_MAX_TEXT} characters. Make it shorter.`, isError: true };
    const scan = scanMemory(text, args?.title);
    if (scan.secrets.some((s) => s.hard)) {
      sessions.append(sessionId, { k: 'meta', text: '기억 저장 요청에 이 위젯의 API 키가 들어 있어 카드 없이 거부했습니다.' });
      return { text: 'Refused: it contains a secret. Never ask to remember secrets.', isError: true };
    }
    const card = memoryCard(args, { ...scan, external: Boolean(sessions.get(sessionId)?.external) });
    return raiseCard(sessionId, card, () => ({ text: 'The user did not save this memory.' }));
  }

  /** The user's click on a memory card: what is in the box then is what is checked and kept. */
  function settleMemory(entry, { action, text, title, allowFlags }) {
    if (action === 'cancel') {
      settleCard(entry, { text: 'The user did not save this memory.' }, '저장 안 함');
      return { ok: true };
    }
    const body = String(text ?? '').trim();
    const name = String(title ?? '').trim();
    if (!body) return { ok: false, message: '기억할 내용을 적어 주세요.' };
    const scan = scanMemory(body, name);
    if (scan.secrets.some((s) => s.hard)) return { ok: false, message: '이 위젯의 API 키가 들어 있어 저장할 수 없습니다.' };
    if (scan.secrets.length && allowFlags !== true) return { ok: false, code: 'secrets', message: '비밀처럼 보이는 값이 있습니다. 지우거나, 비밀이 아니면 그렇다고 표시해 주세요.' };
    const session = sessions.get(entry.sessionId);
    const got = memory.add({ text: body, title: name }, { sourceSessionId: entry.sessionId, sourceTitle: session?.title ?? '', external: Boolean(session?.external) });
    if (got.error) return { ok: false, message: got.error.message };
    const edited = body !== entry.card.view.text || name !== entry.card.view.title;
    settleCard(entry, { text: edited ? `Saved after the user edited it. What was kept: ${body}` : 'Saved. It will be given to later conversations.' }, edited ? '고쳐서 저장' : '저장');
    return { ok: true };
  }

  // ---- originals the Dooray widget fetched ----

  /** Where a fetched original goes in this conversation; the run's instructions name it, so Claude reads it there. */
  const fetchFolder = (session) => path.join(session.cwd, ATTACH_DIR, session.id, 'dooray');

  /**
   * A fetch_file result with status "done": the file is copied from the Dooray widget's own folder (nowhere else) into the
   * conversation, and shown as "두레이에서 받음". The record keeps the name and size only.
   */
  function takeFetched(sessionId, text) {
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      emit('run', { type: 'fetchState', sessionId, state: 'clear' });
      return;
    }
    const shownName = typeof r?.name === 'string' ? r.name.slice(0, 200) : '';
    if (r?.status === 'waiting_approval' || r?.status === 'downloading') {
      emit('run', { type: 'fetchState', sessionId, state: r.status === 'downloading' ? 'downloading' : 'asking', name: shownName, size: Number.isFinite(r.size) ? r.size : null });
      return;
    }
    emit('run', { type: 'fetchState', sessionId, state: 'clear' });
    if (r?.status === 'declined') {
      const item = { name: shownName, declined: true, reason: ['rejected', 'closed', 'timeout', 'unavailable'].includes(r.reason) ? r.reason : 'rejected', source: 'dooray' };
      sessions.append(sessionId, { k: 'fetched', ...item });
      emit('run', { type: 'fetched', sessionId, ...item });
      return;
    }
    if (r?.status !== 'done' || r.source !== 'dooray' || !/^[0-9a-f]{16}$/.test(r.fetch_id) || typeof r.path !== 'string' || !mcp.fetchedDir) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const from = path.resolve(r.path);
    const name = path.basename(from);
    if (path.dirname(from) !== path.join(path.resolve(mcp.fetchedDir), r.fetch_id)) return; // only from the Dooray widget's folder
    try {
      const stat = fs.statSync(from);
      if (!stat.isFile() || stat.size > FETCH_MAX) return;
      const dir = path.join(fetchFolder(session), r.fetch_id);
      fs.mkdirSync(dir, { recursive: true });
      const to = path.join(dir, name);
      fs.copyFileSync(from, to);
      const fd = fs.openSync(to, 'r');
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      const item = { name, size: stat.size, kind: imageType(head) ? 'image' : 'file', source: 'dooray' };
      sessions.append(sessionId, { k: 'fetched', ...item });
      emit('run', { type: 'fetched', sessionId, ...item });
    } catch (err) {
      sessions.append(sessionId, { k: 'err', kind: 'fetch-copy', text: `두레이에서 받은 파일을 대화 첨부로 복사하지 못했습니다: ${err.message}` });
    }
  }

  // ---- the record of running processes ----

  function readRuns() {
    try {
      const raw = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function writeRuns(runs) {
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
    fs.writeFileSync(runsFile, JSON.stringify(runs));
  }

  const addRun = (run) => writeRuns([...readRuns().filter((r) => r.sessionId !== run.sessionId), run]);
  const dropRun = (sessionId) => writeRuns(readRuns().filter((r) => r.sessionId !== sessionId));

  /**
   * After a crash: says so when a process from the last time is still ours. It is never stopped from here, because a pid
   * alone may by now be someone else's and the user may want it to finish (design 14.2).
   */
  async function checkLeftovers() {
    const runs = readRuns();
    if (!runs.length) return [];
    writeRuns([]);
    const found = [];
    for (const run of runs) {
      if (sessions.get(run.sessionId)?.status === 'running') {
        sessions.update(run.sessionId, { status: 'interrupted' });
        sessions.append(run.sessionId, { k: 'err', kind: 'interrupted', text: '앱이 비정상으로 끝나 이 작업의 결과를 받지 못했습니다.' });
      }
      const seen = await runner.inspect({ pid: run.pid, marker: run.marker });
      if (seen.ours) found.push({ kind: 'leftover', pid: run.pid, sessionId: run.sessionId, message: `지난번 작업의 Claude Code 프로세스(PID ${run.pid})가 아직 실행 중입니다. 위젯은 건드리지 않았습니다. 필요하면 작업 관리자에서 끝내 주세요.` });
    }
    notices = [...notices, ...found];
    pushList();
    return found;
  }

  /** Claude Code's own word on each MCP server it was given. A server that did not connect is said, with what it means. */
  function checkServers(sessionId, servers, widgetTools) {
    if (!Array.isArray(servers)) return;
    const expected = [['ai-chat-host', '승인·질문 카드와 요약 도구'], ...(widgetTools?.server ? [['desk-widgets', '위젯 도구(캘린더·메일·할 일 노트 등)']] : [])];
    for (const [name, what] of expected) {
      const status = servers.find((s) => s.name === name)?.status;
      if (status === 'connected') continue;
      const message = `${what} 서버가 연결되지 않았습니다(${status || '목록에 없음'}). 이 실행에서는 그 도구를 쓸 수 없습니다.`;
      sessions.append(sessionId, { k: 'err', kind: 'mcp-server', text: message });
      emit('run', { type: 'notice', kind: 'mcp-server', server: name, status: status || null, message, sessionId });
    }
  }

  // ---- cost ----

  /**
   * Adds a finished run to the month. A reported total counts earlier runs of the session too, so only the difference is added
   * (S7). A run that ended without a report is estimated from the usage seen so far; if there was none it says "일부 미반영".
   */
  function account(sessionId, done, usages, model) {
    const session = sessions.get(sessionId);
    let added = 0;
    let partial = false;
    if (typeof done.costUsd === 'number') {
      added = deltaOfReport(session?.lastCostUsd, done.costUsd);
      if (session) sessions.update(sessionId, { lastCostUsd: done.costUsd });
    } else {
      const costs = [...usages.values()].map((usage) => costOfUsage(model, usage));
      added = costs.reduce((sum, c) => sum + (c ?? 0), 0);
      partial = !costs.length || costs.includes(null);
    }
    if (session) sessions.update(sessionId, { estUsd: (sessions.get(sessionId).estUsd || 0) + added });
    const crossed = budget.add(added, { partial });
    if (crossed) sessions.append(sessionId, { k: 'meta', text: `이번 달 예산의 80%를 넘었습니다(추정, 예산 $${settings().monthlyBudgetUsd}).` });
    emit('budget', budget.view());
    return added;
  }

  // ---- runs ----

  function finish(sessionId, status) {
    running.delete(sessionId);
    dropRun(sessionId);
    if (sessions.get(sessionId)) sessions.update(sessionId, { status });
    pushList();
    pump();
  }

  function fail(sessionId, error) {
    sessions.append(sessionId, { k: 'err', kind: error.kind, text: error.message });
    emit('run', { sessionId, type: 'done', ok: false, stopped: false, text: '', error, costUsd: null });
    finish(sessionId, 'failed');
  }

  async function launch({ sessionId, prompt, kind = 'task' }) {
    const slot = { handle: null, stopRequested: false, prompt, correction: null };
    running.set(sessionId, slot);
    pushList();
    const problem = gate();
    if (problem) {
      fail(sessionId, { kind: problem.code, message: problem.message });
      return;
    }
    let prerequisites;
    try {
      prerequisites = await runner.check();
    } catch (err) {
      fail(sessionId, { kind: 'run-error', message: err.message });
      return;
    }
    if (prerequisites.problems.length) {
      fail(sessionId, prerequisites.problems[0]);
      return;
    }
    if (slot.stopRequested) {
      sessions.append(sessionId, { k: 'err', kind: 'stopped', text: '시작 전에 중지했습니다.' });
      emit('run', { sessionId, type: 'done', ok: false, stopped: true, text: '', error: { kind: 'stopped', message: '시작 전에 중지했습니다.' }, costUsd: null });
      if (slot.correction) queue.unshift({ sessionId, prompt: correctionPrompt(slot, sessions.get(sessionId)) });
      finish(sessionId, 'stopped');
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      finish(sessionId, 'idle');
      return;
    }
    const s = settings();
    let handle;
    let host = null;
    try {
      fs.mkdirSync(session.cwd, { recursive: true });
      host = await createHostServer((method, args) => onHostCall(sessionId, method, args));
      slot.host = host;
      const widgetTools = mcp.widgetTools();
      slot.widgetTools = widgetTools;
      // Said once per conversation for each state, not again on every prompt; the instructions say it to the model every run.
      const noted = sessions.get(sessionId)?.noted || {};
      if (widgetTools.state !== 'on' && noted.tools !== widgetTools.state) {
        const message = TOOLS_OFF[widgetTools.state] || TOOLS_OFF.off;
        sessions.update(sessionId, { noted: { ...noted, tools: widgetTools.state } });
        sessions.append(sessionId, { k: 'meta', text: message });
        emit('run', { type: 'notice', kind: 'widget-tools', state: widgetTools.state, message, sessionId });
      }
      handle = runner.start({
        prompt, cwd: session.cwd, model: s.model, mode: s.mode, resumeId: session.runnerSessionId, getKey, budgetUsd: s.taskCapUsd,
        configDir: sessions.configDirOf(sessionId), writeGuard: s.writeGuard,
        systemNote: `${systemNote(recipes.catalog(session.excludedRecipes || []), widgetTools, { fetchFolder: fetchFolder(session) })}\n${memoryNote(memory.delivered())}`,
        mcp: { dir: mcp.dir, host: { pipe: host.id, token: host.token, script: mcp.hostScript }, servers: widgetTools.server ? { 'desk-widgets': widgetTools.server } : {} },
      });
    } catch (err) {
      host?.close();
      fail(sessionId, { kind: err.code || 'run-error', message: err.message });
      return;
    }
    slot.handle = handle;
    sessions.update(sessionId, { status: 'running', model: s.model, mode: s.mode });
    let lastText = '';
    const usages = new Map(); // message id -> its usage: a message's blocks repeat the same usage, so the last one counts
    handle.events.on('event', (event) => {
      if (event.type === 'spawned') {
        addRun({ pid: event.pid, marker: event.marker, sessionId });
        return;
      }
      if (event.type === 'init') checkServers(sessionId, event.mcpServers, slot.widgetTools);
      if (event.type === 'init' && event.sessionId && !sessions.get(sessionId)?.runnerSessionId) sessions.update(sessionId, { runnerSessionId: event.sessionId });
      if (event.type === 'usage') usages.set(event.messageId || `n${usages.size}`, event.usage);
      if (event.type === 'toolCall' && !sessions.get(sessionId)?.external && isExternalRead(event, session.cwd)) sessions.update(sessionId, { external: true });
      if (event.type === 'toolCall' && FETCH_TOOLS.has(event.name) && event.id) {
        (slot.fetchCalls ||= new Set()).add(event.id);
        // The Dooray widget is about to ask on its own card (fetch_file), or a fetch is still going (status): say where to look.
        if (event.name === FETCH_TOOL) emit('run', { type: 'fetchState', sessionId, state: 'asking', name: '', size: null });
      }
      if (event.type === 'toolResult') {
        if (slot.fetchCalls?.has(event.id)) {
          if (event.isError) emit('run', { type: 'fetchState', sessionId, state: 'clear' });
          else takeFetched(sessionId, event.text);
        }
        return; // tool output is the model's business, not the window's
      }
      if (event.type === 'text') {
        lastText = event.text;
        sessions.append(sessionId, { k: 'ai', text: event.text });
      } else if (event.type === 'toolCall') {
        sessions.append(sessionId, { k: 'tool', name: event.name, input: shortInput(event.input) });
      } else if (event.type === 'notice' && event.kind === 'optional-tool-missing') {
        const noted = sessions.get(sessionId)?.noted || {};
        const key = (event.tools || []).join(',');
        if (noted.optional === key) return; // already said in this conversation
        sessions.update(sessionId, { noted: { ...noted, optional: key } });
        sessions.append(sessionId, { k: 'meta', text: event.message });
      } else if (event.type === 'notice' || event.type === 'keyRetry') {
        sessions.append(sessionId, { k: 'meta', text: event.message });
      } else if (event.type === 'done') {
        const showText = event.ok && event.text && event.text !== lastText ? event.text : '';
        // A summary only becomes a draft to read and fix. Nothing is kept until the user saves it.
        if (kind === 'summary' && event.ok) {
          const draft = parseSummary(event.text, session.title);
          sessions.append(sessionId, { k: 'draft', ...draft });
          emit('draft', { sessionId, ...draft, external: Boolean(sessions.get(sessionId)?.external) });
        }
        if (showText) sessions.append(sessionId, { k: 'ai', text: showText });
        const added = account(sessionId, event, usages, s.model);
        if (added > 0) sessions.append(sessionId, { k: 'meta', text: `이번 실행 ${aboutMoney(added)} (추정)` });
        if (sessions.get(sessionId)) sessions.update(sessionId, { lastRunUsd: added });
        if (event.stopped && slot.correction) sessions.append(sessionId, { k: 'stopped', text: '정정을 반영하려고 진행 중인 작업을 멈췄습니다. 지금까지의 결과는 위에 남아 있습니다.' });
        else if (event.stopped) sessions.append(sessionId, { k: 'stopped', text: `${event.error.message} 지금까지의 결과는 위에 남아 있습니다.` });
        else if (!event.ok) sessions.append(sessionId, { k: 'err', kind: event.error.kind, text: event.error.message });
        if (event.sessionId && event.error?.kind !== 'resume-failed') sessions.update(sessionId, { runnerSessionId: event.sessionId });
        if (event.error?.kind === 'resume-failed') sessions.update(sessionId, { resumable: false, runnerSessionId: null });
        closeCards(sessionId);
        host.close();
        if (slot.correction) queue.unshift({ sessionId, prompt: correctionPrompt(slot, sessions.get(sessionId)) });
        emit('run', { ...event, runnerSessionId: event.sessionId, sessionId, showText, corrected: Boolean(slot.correction) });
        finish(sessionId, event.ok ? 'idle' : (event.stopped ? 'stopped' : 'failed'));
        return;
      }
      if (event.type === 'apiRetry' && event.attempt === 1) sessions.append(sessionId, { k: 'meta', text: `API 오류로 Claude Code가 다시 시도합니다(${event.error || '알 수 없음'}).` });
      if (event.type !== 'init' && event.type !== 'usage' && event.type !== 'result') emit('run', { ...event, runnerSessionId: event.sessionId, sessionId });
    });
    handle.done.catch(() => {});
  }

  /** Starts what waits, oldest first, but never a second run of a session that is still running. */
  function pump() {
    for (let i = 0; i < queue.length && running.size < settings().maxConcurrent;) {
      if (running.has(queue[i].sessionId)) {
        i++;
        continue;
      }
      const [next] = queue.splice(i, 1);
      launch(next);
    }
    pushList();
  }

  /**
   * What the run after a correction is asked. It resumes the same Claude Code session, so the work so far is in its record; a run
   * stopped before Claude Code even began has no record, and then the original request goes along.
   */
  function correctionPrompt(slot, session) {
    const head = session?.runnerSessionId
      ? 'The user interrupted your previous step to correct the request. Continue the work with this correction. Check what was already done before repeating anything.'
      : `The user corrected this request before work began:\n${slot.prompt}\n\nThe correction, which takes priority:`;
    return `${head}\n${slot.correction.join('\n')}`;
  }

  // ---- what the window asks ----

  /** A new conversation or the next prompt of one. Refusals say why and start nothing. */
  function send({ sessionId = null, prompt, cwd = null, maxPrompt = 100000, recipeIds = [], attachmentIds = [], when = null } = {}) {
    const text = String(prompt ?? '').trim();
    const attachIds = Array.isArray(attachmentIds) ? attachmentIds.map(String) : [];
    const problem = gate();
    if (problem) return { ok: false, ...problem };
    if (!text && !attachIds.length) return { ok: false, code: 'empty', message: '명령을 입력해 주세요.' };
    if (text.length > maxPrompt) return { ok: false, code: 'too-long', message: '명령이 너무 깁니다.' };
    // The prompt is kept in the record and the title and goes to Claude Code, which could write it into a file or a command.
    if (containsKey(text, getKey())) return { ok: false, code: 'key-in-prompt', message: '명령에 이 위젯의 API 키가 들어 있어 보내지 않았습니다. 키를 지우고 다시 보내 주세요.' };
    let session = null;
    if (sessionId) {
      session = sessions.get(sessionId);
      if (!session) return { ok: false, code: 'no-session', message: '이 대화를 찾을 수 없습니다.' };
      if (!session.resumable) return { ok: false, code: 'read-only', message: '이 대화는 이어 갈 수 없습니다. 새 대화로 시작해 주세요.' };
      // While it works the user may correct it (stop, then go on with the correction) or leave a prompt for after.
      if (isBusy(sessionId) && when !== 'correct' && when !== 'after') return { ok: false, code: 'same-session', message: '이 대화는 작업 중입니다. 정정으로 보낼지, 끝난 뒤 보낼지 골라 주세요.' };
    }
    const dir = session ? session.cwd : (cwd || settings().workDir || defaultDir());
    if (!path.isAbsolute(dir)) return { ok: false, code: 'bad-folder', message: '작업 폴더는 전체 경로로 적어 주세요.' };
    if (!knowsFolder(dir)) return { ok: false, code: 'folder-confirm', cwd: dir, message: '이 폴더에서 처음 실행합니다.' };
    // Attachments last: once taken they are gone from the waiting list, so nothing that can still refuse comes after.
    let taken = [];
    if (attachIds.length) {
      if (!attachNoticeSeen()) return { ok: false, code: 'attach-notice', message: '첨부한 파일의 내용도 Anthropic으로 전달됩니다. 안내를 확인해 주세요.' };
      const got = attachments.take(attachIds);
      if (got.error) return got.error;
      taken = got.items;
    }
    if (!session) session = sessions.create({ prompt: text || taken[0]?.name || '첨부 파일', cwd: dir, model: settings().model, mode: settings().mode });
    let saved = [];
    if (taken.length) {
      try {
        saved = attachments.save(taken, path.join(session.cwd, ATTACH_DIR, session.id));
      } catch (err) {
        return { ok: false, code: 'attach-save', sessionId: session.id, message: `첨부 파일을 작업 폴더에 복사하지 못했습니다: ${err.message}` };
      }
    }
    // The record keeps names and sizes only, never what is in the files.
    sessions.append(session.id, { k: 'you', text, ...(saved.length ? { attachments: saved.map((s) => ({ name: s.name, size: s.size, kind: s.kind })) } : {}) });
    if (session.satisfied) sessions.update(session.id, { satisfied: false });
    // Recipes the user picked for this prompt, those still there and not excluded here.
    const excluded = session.excludedRecipes || [];
    const picked = (Array.isArray(recipeIds) ? recipeIds : []).filter((id) => RECIPE_ID.test(String(id)) && !excluded.includes(id)).map((id) => [id, recipes.read(id)]).filter(([, r]) => r);
    for (const [id, recipe] of picked) recordUse(session.id, id, recipe, 'user');
    const ask = (text || 'Please look at the attached files.') + attachmentNote(saved);
    const slot = running.get(session.id);
    if (when === 'correct' && slot && !slot.stopRequested) {
      // Stop now (a card that is up is refused) and go on with the correction as soon as the run has ended.
      slot.correction = [promptWithRecipes(ask, picked.map(([, r]) => r))];
      sessions.append(session.id, { k: 'meta', text: '정정: 진행 중인 작업을 멈추고 이 내용으로 이어 갑니다.' });
      stop(session.id, 'correction');
      return { ok: true, sessionId: session.id, corrected: true, attachments: saved.map((s) => ({ name: s.name, size: s.size, kind: s.kind })) };
    }
    if (when === 'correct' && slot?.correction) {
      slot.correction.push(promptWithRecipes(ask, picked.map(([, r]) => r)));
      return { ok: true, sessionId: session.id, corrected: true, attachments: saved.map((s) => ({ name: s.name, size: s.size, kind: s.kind })) };
    }
    queue.push({ sessionId: session.id, prompt: promptWithRecipes(ask, picked.map(([, r]) => r)) });
    const queued = running.has(session.id) || queue.length > 1 || running.size >= settings().maxConcurrent;
    pump();
    return { ok: true, sessionId: session.id, queued, attachments: saved.map((s) => ({ name: s.name, size: s.size, kind: s.kind })) };
  }

  function stop(sessionId, why = 'user') {
    const slot = running.get(sessionId);
    if (!slot) return false;
    slot.stopRequested = true;
    if (why === 'correction') closeCards(sessionId, 'The user stopped this step to correct the request, so this was not approved.', '정정으로 거부');
    else closeCards(sessionId, 'The user stopped the run, so this was not approved.', '중지로 거부');
    slot.handle?.stop();
    return true;
  }

  function cancelQueued(sessionId) {
    const at = queue.findIndex((q) => q.sessionId === sessionId);
    if (at < 0) return false;
    queue.splice(at, 1);
    sessions.append(sessionId, { k: 'stopped', text: '대기를 취소했습니다.' });
    pushList();
    return true;
  }

  // ---- feedback and summaries ----

  /** Good: nothing is sent, and a summary may be asked for. Not good: the reason continues the same session. Again: the last prompt once more. */
  function feedback(sessionId, { kind, reason } = {}) {
    const session = sessions.get(String(sessionId));
    if (!session) return { ok: false, message: '이 대화를 찾을 수 없습니다.' };
    if (isBusy(session.id)) return { ok: false, message: '작업이 끝난 뒤 알려 주세요.' };
    if (kind === 'good') {
      sessions.update(session.id, { satisfied: true });
      sessions.append(session.id, { k: 'feedback', text: '만족' });
      pushList();
      return { ok: true };
    }
    if (kind === 'bad') {
      const why = String(reason ?? '').trim();
      if (!why) return { ok: false, code: 'empty', message: '무엇이 부족했는지 적어 주세요.' };
      sessions.append(session.id, { k: 'feedback', text: `미흡: ${why}` });
      return send({ sessionId: session.id, prompt: `The user is not satisfied with the result. Their reason:\n${why}\nPlease continue and fix it.` });
    }
    if (kind === 'again') {
      const last = sessions.read(session.id).filter((i) => i.k === 'you').pop();
      if (!last) return { ok: false, message: '다시 보낼 명령이 없습니다.' };
      sessions.append(session.id, { k: 'feedback', text: '다시 시도' });
      return send({ sessionId: session.id, prompt: last.text });
    }
    return { ok: false, message: '알 수 없는 피드백입니다.' };
  }

  /** Only when the user asks, after saying the result was good: it costs money. The result is a draft. */
  function requestSummary(sessionId) {
    const session = sessions.get(String(sessionId));
    const problem = gate();
    if (problem) return { ok: false, ...problem };
    if (!session) return { ok: false, message: '이 대화를 찾을 수 없습니다.' };
    if (!session.satisfied) return { ok: false, code: 'not-satisfied', message: '결과에 만족한 뒤 요약할 수 있습니다.' };
    if (!session.resumable) return { ok: false, code: 'read-only', message: '이어 갈 수 없는 대화는 요약할 수 없습니다.' };
    if (isBusy(session.id)) return { ok: false, code: 'same-session', message: '작업이 끝난 뒤 요약해 주세요.' };
    sessions.append(session.id, { k: 'meta', text: '요약을 요청했습니다.' });
    queue.push({ sessionId: session.id, prompt: SUMMARY_REQUEST, kind: 'summary' });
    pump();
    return { ok: true };
  }

  /** The newest draft of a session not yet saved or discarded. */
  function draftOf(items) {
    let draft = null;
    for (const item of items) {
      if (item.k === 'draft') draft = item;
      else if (item.k === 'draftDone') draft = null;
    }
    return draft && { title: draft.title, when: draft.when, body: draft.body };
  }

  const scanFields = ({ title, when, body } = {}) => {
    const key = getKey();
    const parts = [['제목', title], ['언제 쓰는지', when], ['내용', body]];
    return {
      secrets: parts.flatMap(([field, text]) => scanSecrets(text, key).map((s) => ({ ...s, field }))),
      risks: parts.flatMap(([field, text]) => scanRisks(text).map((r) => ({ ...r, field }))),
    };
  };

  /**
   * The only way a recipe is kept: from a real click, with the checks done again here. The widget's key is refused always; other
   * secret-like text until it is gone or the user says it is not one; work that read outside content needs one more confirmation.
   */
  function saveRecipe({ recipeId = null, sessionId = null, title, when, body, trusted, allowFlags, confirmExternal } = {}) {
    if (trusted !== true) return { ok: false, code: 'not-confirmed', message: '직접 눌러야 저장됩니다.' };
    const existing = recipeId ? recipes.get(String(recipeId)) : null;
    if (recipeId && !existing) return { ok: false, code: 'no-recipe', message: '이 요약을 찾을 수 없습니다.' };
    if (!String(title ?? '').trim() || !String(when ?? '').trim() || !String(body ?? '').trim()) return { ok: false, code: 'empty', message: '제목, 언제 쓰는지, 내용을 모두 적어 주세요.' };
    const scan = scanFields({ title, when, body });
    if (scan.secrets.some((s) => s.hard)) return { ok: false, code: 'key-in-recipe', scan, message: '이 위젯의 API 키가 들어 있어 저장할 수 없습니다.' };
    if (scan.secrets.length && allowFlags !== true) return { ok: false, code: 'secrets', scan, message: '비밀처럼 보이는 값을 지운 뒤 저장해 주세요. 비밀이 아니면 그렇다고 표시해 주세요.' };
    const session = sessionId ? sessions.get(String(sessionId)) : null;
    const external = existing ? existing.external : Boolean(session?.external);
    if (external && confirmExternal !== true) return { ok: false, code: 'external-confirm', scan, message: '외부 내용을 읽은 대화에서 만든 요약입니다. 내용을 확인했다고 표시해 주세요.' };
    const saved = existing ? recipes.update(existing.id, { title, when, body }) : recipes.create({ title, when, body }, { sourceSessionId: session?.id ?? null, sourceTitle: session?.title ?? '', external });
    if (session && !existing) sessions.append(session.id, { k: 'draftDone', text: `요약을 저장했습니다: ${saved.title}` });
    pushList();
    return { ok: true, recipe: saved };
  }

  /** A name typed in a list: one line, not empty, not too long. Returns { title } or { message }. */
  function checkName(raw) {
    const text = String(raw ?? '');
    if (/[\r\n]/.test(text)) return { message: '이름은 한 줄로 적어 주세요.' };
    const title = text.trim();
    if (!title) return { message: '이름을 적어 주세요.' };
    if (title.length > MAX_TITLE) return { message: `이름은 ${MAX_TITLE}자까지 쓸 수 있습니다.` };
    return { title };
  }

  /** A recipe's new name: also checked for secrets, as a save is. The next run's list of titles has it. */
  function renameRecipe({ id, title } = {}) {
    if (!recipes.get(String(id))) return { ok: false, message: '이 요약을 찾을 수 없습니다.' };
    const name = checkName(title);
    if (name.message) return { ok: false, message: name.message };
    const found = scanSecrets(name.title, getKey());
    if (found.some((s) => s.hard)) return { ok: false, code: 'key-in-recipe', message: '이 위젯의 API 키가 들어 있어 쓸 수 없습니다.' };
    if (found.length) return { ok: false, code: 'secrets', message: `이름에 비밀처럼 보이는 값(${found[0].label})이 있습니다. 지운 뒤 다시 적어 주세요.` };
    const recipe = recipes.rename(String(id), name.title);
    return recipe ? { ok: true, recipe } : { ok: false, message: '이름을 바꾸지 못했습니다.' };
  }

  function renameSession({ id, title } = {}) {
    if (!sessions.get(String(id))) return { ok: false, message: '이 대화를 찾을 수 없습니다.' };
    const name = checkName(title);
    if (name.message) return { ok: false, message: name.message };
    if (containsKey(name.title, getKey())) return { ok: false, code: 'key-in-name', message: '이 위젯의 API 키가 들어 있어 쓸 수 없습니다.' };
    sessions.update(String(id), { title: name.title });
    pushList();
    return { ok: true };
  }

  /** Takes a recipe out of this conversation at one click: it stops being listed or readable here. */
  function excludeRecipe(sessionId, recipeId) {
    const session = sessions.get(String(sessionId));
    if (!session || !RECIPE_ID.test(String(recipeId))) return false;
    sessions.update(session.id, {
      excludedRecipes: [...new Set([...(session.excludedRecipes || []), recipeId])],
      usedRecipes: (session.usedRecipes || []).filter((u) => u.id !== recipeId),
    });
    sessions.append(session.id, { k: 'meta', text: '이 대화에서 요약을 뺐습니다. 이미 전달된 내용은 지금 대화 기록에 남아 있을 수 있습니다.' });
    emit('recipes', { sessionId: session.id, usedRecipes: sessions.get(session.id).usedRecipes });
    pushList();
    return true;
  }

  return {
    list: listView,
    cards: cardViews,
    /** The window has drawn this card: only from here can it be answered, and not at once. */
    cardShown(id) {
      const entry = cards.get(id);
      if (!entry) return false;
      if (!entry.shownAt) entry.shownAt = now();
      return true;
    },
    /** The user's click on a card. `trusted` is the page's word that a real input event did it (never a script). */
    answerCard({ id, action, text, title, allowFlags, trusted } = {}) {
      const entry = cards.get(id);
      if (!entry || trusted !== true || !entry.shownAt || now() - entry.shownAt < ARM_MS) return false;
      const { card } = entry;
      if (card.kind === 'approval' && action === 'allow') settleCard(entry, allowAnswer(card), '허용');
      else if (card.kind === 'approval' && action === 'deny') {
        const reason = withoutKey(cleanAnswer(text)).trim();
        settleCard(entry, denyAnswer(reason ? `The user denied this action: ${reason}` : ''), '거부');
      } else if (card.kind === 'question' && action === 'answer' && cleanAnswer(text).trim()) settleCard(entry, { text: withoutKey(cleanAnswer(text)).trim() }, '답함');
      else if (card.kind === 'question' && action === 'deny') settleCard(entry, null, '답하지 않음');
      else if (card.kind === 'memory') return settleMemory(entry, { action, text, title, allowFlags });
      else return false;
      return true;
    },
    notices: () => notices,
    dismissNotices() {
      notices = [];
      return true;
    },
    open(id) {
      const session = sessions.get(id);
      if (!session) return null;
      const items = sessions.read(id);
      return { session: { ...session, state: listView().sessions.find((s) => s.id === id)?.state }, items, draft: draftOf(items) };
    },
    send,
    feedback,
    requestSummary,
    scanFields,
    saveRecipe,
    excludeRecipe,
    renameRecipe,
    renameSession,
    discardDraft(id) {
      if (!sessions.get(String(id))) return false;
      sessions.append(String(id), { k: 'draftDone', text: '요약을 저장하지 않았습니다.' });
      return true;
    },
    stop,
    cancelQueued,
    confirmFolder(dir) {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
      rememberFolder(dir);
      return true;
    },
    remove(id) {
      if (!sessions.get(id)) return { ok: false, message: '이 대화를 찾을 수 없습니다.' };
      if (isBusy(id)) return { ok: false, message: '작업 중에는 지울 수 없습니다. 먼저 중지해 주세요.' };
      sessions.remove(id);
      pushList();
      return { ok: true };
    },
    clearRecord(id) {
      if (!sessions.get(id)) return { ok: false, message: '이 대화를 찾을 수 없습니다.' };
      if (isBusy(id)) return { ok: false, message: '작업 중에는 지울 수 없습니다. 먼저 중지해 주세요.' };
      sessions.clearClaudeRecord(id);
      sessions.append(id, { k: 'meta', text: 'Claude Code 기록을 지웠습니다. 이 대화는 이제 이어 갈 수 없습니다.' });
      pushList();
      return { ok: true };
    },
    setPinned(id, pinned) {
      if (!sessions.get(id)) return false;
      sessions.update(id, { pinned: Boolean(pinned) });
      pushList();
      return true;
    },
    prune: () => sessions.prune(settings().keepDays, new Set([...running.keys(), ...queue.map((q) => q.sessionId)])),
    checkLeftovers,
    anyRunning: () => running.size > 0 || queue.length > 0,
    stopAll() {
      queue.length = 0;
      for (const sessionId of running.keys()) closeCards(sessionId);
      for (const slot of running.values()) {
        slot.stopRequested = true;
        slot.handle?.stop();
      }
    },
  };
}

module.exports = { createChatController };
