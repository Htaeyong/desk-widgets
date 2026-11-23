// Dev-only: renders the AI Widgets screenshots for the README, the guide and the download page (#129, 0.1.1) from made-up runs.
//   node widgets/ai-chat/test/screenshots.js [--out <folder>]     (starts this file in Electron; the default folder is docs/images)
// The real widget code and chat page run in hidden windows (show:false) with a throw-away data folder, a fake key and the
// scripted demo-claude.js. No real key, no API call, nothing on the screen. Not part of the package (package.exclude has test).
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const widgetDir = path.join(__dirname, '..');
const repo = path.join(widgetDir, '..', '..');
const out = path.resolve(process.env.AI_CHAT_SHOTS_OUT || path.join(repo, 'docs', 'images'));
const nodeExe = process.env.AI_CHAT_NODE;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-shots-'));
app.setPath('userData', path.join(tmp, 'profile'));
app.disableHardwareAcceleration();

const FAKE_KEY = `sk-ant-api03-${'demo'.repeat(8)}-Ab12`;
const WIDTH = 880;
const HEIGHT = 840;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const W = (name) => `mcp__desk-widgets__${name}`;

// ---- the made-up runs ----

// The conversation picture: widget tools read the calendar, mail and notes, then a plain answer; a second prompt goes on.
const MEETING = [
  {
    prompt: '내일 오전 회의 준비할 것 정리해 줘',
    cost: 0.41,
    steps: [
      { tools: [[W('calendar_list_events'), { from: 'tomorrow', to: 'tomorrow' }], [W('mail_search_messages'), { query: '디자인 리뉴얼 회의' }], [W('mail_read_message'), { id: 'm-101' }], [W('mail_read_message'), { id: 'm-102' }], [W('todonote_list_tasks'), { due: 'soon' }]] },
      {
        text: [
          '내일 **10:00 디자인 리뉴얼 회의** 준비할 것을 정리했어요.',
          '',
          '| 할 일 | 근거 |',
          '|---|---|',
          '| 시안 B안 수정본 공유 | 김지현 님 메일(어제) |',
          '| 일정표 초안 출력 | 회의 안건 2번 |',
          '| 견적 범위 확인 | 할 일 노트 "견적서 회신" |',
          '',
          '회의실은 **3층 소회의실**이고, 화상 참석자가 한 명 있어요.',
        ].join('\n'),
      },
    ],
  },
  {
    prompt: '좋아, 이걸 체크리스트로 작업 폴더에 저장해 줘',
    cost: 0.58,
    steps: [
      { tools: [['Write', { file_path: '회의 준비.md', content: '- [ ] 시안 B안 수정본 공유\n- [ ] 일정표 초안 출력\n- [ ] 견적 범위 확인\n' }]] },
      { text: '작업 폴더에 `회의 준비.md`로 저장했어요. 체크 상자 세 개짜리 목록이에요.' },
    ],
  },
];

const OTHERS = [
  { prompt: '지난달 카드 지출 엑셀을 항목별로 요약해 줘', cost: 0.27, steps: [{ tools: [['Glob', { pattern: '*.xlsx' }], ['PowerShell', { command: 'Import-Excel .\\지출.xlsx | Group-Object 항목' }]] }, { text: '식비가 가장 많았어요(38%).' }] },
  { prompt: '사진 폴더를 찍은 날짜별로 정리하는 방법 알려 줘', cost: 0.12, steps: [{ text: '찍은 날짜(EXIF)로 폴더를 나누는 방법은 두 가지예요.' }] },
  { prompt: '이번 주 두레이 업무 중 마감 지난 것 알려 줘', cost: 0.19, steps: [{ tools: [[W('dooray_list_tasks'), { status: 'open' }]] }, { text: '마감이 지난 업무는 2건이에요.' }] },
];

const APPROVAL = {
  prompt: '다운로드 폴더의 PDF를 문서\\PDF로 옮겨 줘',
  steps: [{ tools: [['Glob', { pattern: '*.pdf' }]] }, { text: 'PDF 파일 4개를 찾았어요. 옮기기 전에 확인을 받을게요.' }],
  approve: { tool: 'PowerShell', input: { command: "Move-Item -Path .\\*.pdf -Destination \"$HOME\\Documents\\PDF\"", description: 'PDF 4개를 문서\\PDF 폴더로 옮김' } },
};

app.whenReady().then(async () => {
  const { openSecrets } = require(path.join(repo, 'engine', 'main', 'secrets.js'));
  const { create, CHANNEL } = require(path.join(widgetDir, 'index.js'));
  const S = require(path.join(widgetDir, 'lib', 'settings.js'));
  const dataDir = path.join(tmp, 'data');
  const workDir = path.join(tmp, 'work');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'demo-claude.js'), path.join(tmp, 'demo-claude.js'));
  let sessionNo = 0;
  const demo = (run) => fs.writeFileSync(path.join(tmp, 'demo.json'), JSON.stringify({ sessionId: `demo-${++sessionNo}`, ...run }));
  demo({ steps: [] });

  // Ready as after the first-run steps: consent given, model picked, a calm budget, the widget tools connected.
  let state = S.sanitize({
    consent: { version: 1, at: '2026-11-20T00:00:00.000Z' }, modelChosen: true, model: 'claude-sonnet-5-5', monthlyBudgetUsd: 10, workDir,
    noticeSnooze: { 'folder-boundary': Date.now() + 7 * 86400000, 'unverified-version': Date.now() + 7 * 86400000 },
  });
  const ctx = {
    id: 'ai-chat',
    dir: widgetDir,
    dataDir,
    createStore: ({ sanitize }) => ({ load: () => state, save: (v) => { state = sanitize({ ...state, ...v }); return state; } }),
    secrets: { open: () => openSecrets({ file: path.join(dataDir, 'secrets.json') }) },
    handle: (channel, fn) => ipcMain.handle(channel, fn),
    openExternal: () => {},
    openSettings: () => {},
    setTrayItems: () => true,
    notify: () => {},
    openAppWindow: ({ html, preload }) => {
      const win = new BrowserWindow({ show: false, width: WIDTH, height: HEIGHT, backgroundColor: '#16181d', webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      win.loadFile(html);
      return win;
    },
  };
  const titles = { calendar_list_events: '일정 찾기', mail_search_messages: '메일 찾기', mail_read_message: '메일 읽기', todonote_list_tasks: '할 일 찾기', dooray_list_tasks: '업무 찾기' };
  const widget = create(ctx, {
    resolve: () => ({ file: nodeExe, args: [path.join(tmp, 'demo-claude.js')] }),
    documents: path.join(tmp, 'documents'),
    widgetTools: () => ({ state: 'on', tools: Object.keys(titles), titles }),
  });
  widget.settings.handlers.saveKey(FAKE_KEY);
  widget.start();
  widget.focus();
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (test, what) => {
    for (let i = 0; i < 1200; i++) {
      if (await test()) return;
      await wait(25);
    }
    throw new Error(`timed out: ${what}`);
  };
  // The info line names the work folder, here a temp folder under the user profile: a made-up folder stands in for it, the
  // shot is public.
  const SHOWN_FOLDER = String.raw`C:\Users\me\Documents\Desk Widgets\AI Widgets`;
  const shot = async (name) => {
    await js(`(() => { const i = document.getElementById('infoLine'); i.textContent = i.textContent.replace(/폴더 .*$/, ${JSON.stringify(`폴더 ${SHOWN_FOLDER}`)}); })()`);
    const shown = await js(`document.body.innerText`);
    if (shown.includes(tmp) || /Users[\\/](?!me[\\/])/i.test(shown)) throw new Error(`${name}: a real folder is on the screen`);
    // A hidden window may otherwise give an older frame: repaint, let two frames pass, and take the second of two captures.
    const settle = async () => {
      win.webContents.invalidate();
      await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await wait(400);
    };
    await settle();
    await win.webContents.capturePage();
    await settle();
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    console.log(file);
  };
  // The widget's own list: a sent prompt is running or queued at once, so nothing can count as ended before it began.
  const idle = async () => {
    await until(async () => { const l = await js(`window.aiChat.call('list')`); return !l.running.length && !l.queue.length; }, 'the run to end');
    await wait(500);
  };
  const send = async (run, { newChat = false } = {}) => {
    demo(run);
    if (newChat) await js(`document.getElementById('newChat').click()`);
    await js(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(run.prompt)}; document.getElementById('send').click(); })()`);
  };

  try {
    await until(async () => !(await js(`document.getElementById('app').hidden`)), 'the app page');
    await js(`window.aiChat.call('confirmFolder', ${JSON.stringify(workDir)})`);
    for (const run of OTHERS) {
      await send(run, { newChat: true });
      await wait(300);
      await idle();
    }
    // The main conversation: two prompts in one session, answers in bubbles, the tool calls folded.
    await send(MEETING[0], { newChat: true });
    await wait(300);
    await idle();
    await send(MEETING[1]); // the same conversation goes on (--resume)
    await wait(300);
    await idle();
    await js(`(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; })()`);
    await shot('ai-chat');
    // The same with the first group of tool calls opened.
    await js(`document.querySelector('#log .toolgroup > summary').click(); document.getElementById('log').scrollTop = 0`);
    await shot('ai-chat-tools');

    // An approval in the manual mode: the card shows the input to run in full.
    state = S.sanitize({ ...state, mode: 'default' });
    await send(APPROVAL, { newChat: true });
    await until(async () => js(`Boolean(document.querySelector('.card'))`), 'the approval card');
    await wait(900);
    await js(`document.querySelector('.card').scrollIntoView({ block: 'end' })`);
    await shot('ai-chat-approval');
    await js(`document.getElementById('stop').click()`);
    await idle();
    if ((await js('document.documentElement.outerHTML')).includes(FAKE_KEY)) throw new Error('the key reached the page');
  } catch (err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  } finally {
    widget.stop();
    await wait(500);
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a dying child may hold it a moment */ }
    app.exit(process.exitCode || 0);
  }
});
