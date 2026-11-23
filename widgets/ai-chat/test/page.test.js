// The real pages in hidden Electron windows (#129): first-run steps, settings, a run, and model text that tries to be markup
// or to make a request. The driver is page-driver.electron.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = path.join(__dirname, '..', '..', '..', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

function drive(extra = {}) {
  const env = { ...process.env, ...extra, AI_CHAT_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  const out = cp.spawnSync(electron, [path.join(__dirname, 'page-driver.electron.js')], { env, encoding: 'utf8', windowsHide: true, timeout: 240000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  const line = String(out.stdout || '').split('\n').find((l) => l.startsWith('FINDINGS '));
  assert.ok(line, `the driver reported nothing: ${out.stderr}`);
  return JSON.parse(line.slice('FINDINGS '.length));
}

test('hidden windows: the steps, settings and a run; model text stays text and makes no request', { skip: !fs.existsSync(electron) }, () => {
  const f = drive(process.env.AI_CHAT_SHOTS ? { AI_CHAT_SHOTS: process.env.AI_CHAT_SHOTS } : {});
  assert.equal(f.error, undefined, f.error);
  assert.equal(f.hidden, true, 'nothing shows on screen');
  assert.equal(f.consent, true);
  assert.equal(f.toolsBanner, true, 'widget tools off: the window says so and how');
  assert.equal(f.shiftEnterKept, true);
  assert.equal(f.composingKept, true);
  assert.equal(f.noSendWhileComposing, true);
  assert.equal(f.placeholder, '무엇을 할까요? (Enter 보내기, Shift+Enter 줄바꿈)');
  assert.equal(f.noKeyPage, true);
  assert.equal(f.settingsNoKey, true);
  assert.equal(f.keyFieldEmptied, true);
  assert.equal(f.settingsHoldsNoKey, true);
  assert.equal(f.dpapiFile, true);
  assert.equal(f.noKeyInPage, true);
  // Injection: nothing the model writes becomes an element, runs, or reaches the network.
  assert.equal(f.injectedElements, 0);
  assert.equal(f.pwned, null);
  assert.equal(f.attackShownAsText, true);
  assert.equal(f.bodyBackground, 'none');
  // Cards: only a real click answers one, and the model cannot draw one.
  assert.equal(f.cardInAnswer, true);
  assert.equal(f.cardFits, true);
  assert.equal(f.buttonsAsleepAtFirst, true);
  assert.equal(f.cardShowsHidden, true);
  assert.equal(f.cardWarnsHidden, true);
  assert.equal(f.cardElements, 0);
  assert.equal(f.logButtons, 0);
  assert.equal(f.logHasLookalike, true);
  assert.equal(f.scriptClickIgnored, true);
  assert.equal(f.realClickApproved, true);
  assert.equal(f.questionIsText, true);
  assert.equal(f.questionAnswered, true);
  // A summary: asked for by the user, read and fixed, saved by a real click only, with its risks marked.
  assert.equal(f.summaryNotAutomatic, true);
  assert.equal(f.draftMarksRisks, true);
  assert.equal(f.draftMasksSecret, true);
  assert.equal(f.draftElements, 0);
  assert.equal(f.draftNotSavedYet, true);
  assert.equal(f.scriptCannotSave, true);
  assert.equal(f.secretStopsRealClick, true);
  assert.equal(f.savedListed, true);
  // Bubbles: mine right, answers left, each answer's tools and cost inside its bubble, amounts two decimals at most.
  assert.ok(f.bubbles.you >= 2 && f.bubbles.ai >= 2, JSON.stringify(f.bubbles));
  for (const k of ['youRight', 'aiLeft', 'narrow', 'toolsInside', 'costInside', 'noLongCost', 'atBottom']) assert.equal(f.bubbles[k], true, k);
  assert.equal(f.longWraps, true);
  assert.equal(f.narrowWraps, true);
  // The gauge: share of the budget, colours at 80% and 100%, details on hover, click and keys, always "추정".
  assert.deepEqual([f.gaugeEmpty.cls.trim(), f.gaugeEmpty.pct, f.gaugeEmpty.width], ['band', '아직 없음', '0%']);
  assert.deepEqual([f.gauge85.cls.trim(), f.gauge85.pct], ['band warn', '85% (추정)']);
  assert.deepEqual([f.gauge100.cls.trim(), f.gauge100.pct, f.gauge100.width], ['band over', '100% (추정)', '100%']);
  assert.equal(f.gaugeTiny.pct, '1% 미만');
  for (const k of ['hoverOpens', 'leaveCloses', 'clickStays', 'outsideCloses', 'keyOpens', 'escapeCloses']) assert.equal(f[k], true, k);
  for (const part of ['이번 달 사용액', '약 $17.00 (추정)', '월 예산', '$20.00', '남은 금액', '약 $3.00 (추정)', '작업 하나의 상한', '$3.00', '이 위젯이 쓴 금액만 추정한 값', 'Console에서 실제 잔액 보기']) assert.ok(f.detailText.includes(part), part);
  assert.match(f.overDetail, /예산에 닿아 새 작업을 시작하지 않습니다/);
  assert.match(f.overDetail, /예산 바꾸기/);
  assert.match(f.overDetail, /남은 금액\s*\$0\.00 \(추정\)/);
  assert.deepEqual([f.short.you, f.short.ai, f.short.youRight, f.short.aiLeft], [1, 1, true, true]);
  // Tool calls: one folded line per stretch, readable names, live while running, the answer's words right after.
  assert.match(f.liveSummary, /^작업 중… \(도구 3번\) · 지금: 메일 · 메일 읽기$/);
  assert.equal(f.liveClosed, true);
  const g = f.groups;
  assert.equal(g.count, 2, JSON.stringify(g));
  assert.equal(g.summaries[0], '작업 내용 · 도구 15번 (캘린더 1, 메일 10, 할 일 노트 1, 두레이 2, PowerShell 1)');
  assert.equal(g.summaries[1], '작업 내용 · 도구 2번 (파일 읽기 2)');
  assert.equal(g.closed, true);
  assert.deepEqual(g.lines, [15, 2]);
  assert.deepEqual(g.firstLabels, ['캘린더 · 일정 찾기', '메일 · 메일 찾기', '메일 · 메일 읽기']);
  assert.deepEqual(g.order.slice(0, 3), ['meta', 'group', 'text'], JSON.stringify(g.order));
  assert.equal(g.firstVisibleText, true);
  assert.equal(g.shortCellOneLine, true, 'a short table cell stays on one line');
  assert.deepEqual([f.opened.open, f.opened.lineOpen], [true, true]);
  assert.match(f.opened.input, /\{"n":1\}/);
  assert.equal(f.keptOpen, true);
  // Lists: recipes pinned first, renamed in place (one line only), deleted with confirm and undo; conversations the same.
  assert.deepEqual(f.recipeOrder.slice(0, 2), ['#고정', '주간 보고 정리'], JSON.stringify(f.recipeOrder));
  // A text field cannot hold a line break; the widget refuses one anyway (lists.test.js). Here: too long.
  assert.match(f.renameRefused, /100자까지/);
  assert.equal(f.renamed, '주간 보고 정리 (고정)');
  assert.match(f.deleteAsks, /이전 버전을 모두 지웁니다/);
  assert.match(f.undoShown, /회의록 요약/);
  assert.equal(f.undone, true);
  assert.match(f.usedBar, /삭제된 요약 \(회의록 요약 v1\)/);
  assert.equal(f.usedBarButtons, 0);
  assert.equal(f.pickOrder[1], '★ 주간 보고 정리 (고정) v2', JSON.stringify(f.pickOrder));
  assert.ok(!f.pickOrder.some((o) => o.includes('회의록 요약')));
  assert.deepEqual(f.sessionMenu, ['이름 바꾸기', '고정', '삭제']);
  assert.deepEqual(f.sessionOrder.slice(0, 3), ['#고정', '★ 회의록 대화', '#대화'], JSON.stringify(f.sessionOrder));
  assert.equal(f.dblclickRenames, true);
  assert.match(f.sessionDeleteAsks, /되돌릴 수 없습니다/);
  assert.equal(f.sessionDeleted, true);
  // Attachments: pasted image (with a preview), dropped file, picked file, long text as a file; notice before the first send.
  assert.deepEqual(f.attach.names, ['화면 캡처.png', '메모.txt', '회의 자료.pdf', '붙여넣은 글.txt']);
  assert.deepEqual(f.attach.thumbs, ['data:image/png;base64,']);
  assert.equal(f.attach.notice, true);
  assert.match(f.attach.longMsg, /첨부 파일로 넣었습니다/);
  assert.equal(f.attach.promptEmpty, true, 'the long text did not fill the box');
  assert.equal(f.attachWaitsForNotice, true);
  assert.deepEqual(f.attachSent.chips.map((c) => c.replace(/ \(.*\)$/, '')), ['🖼 화면 캡처.png', '📎 회의 자료.pdf', '📎 붙여넣은 글.txt']);
  assert.equal(f.attachSent.listCleared, true);
  assert.equal(f.attachSent.noImgInLog, 0, 'a sent image shows as its name, not drawn in the conversation');
  assert.deepEqual(f.attachCopies, ['붙여넣은 글.txt', '화면 캡처.png', '회의 자료.pdf']);
  assert.equal(f.attachOriginal, '%PDF-1.4 meeting');
  // Notices that may wait: "닫기" for this window, "이번 주 그만 보기" for 7 days per kind, "안내 다시 보기" in the settings.
  assert.deepEqual(f.noticeStart, { tools: true, boundary: true });
  assert.deepEqual(f.noticeControls.map((c) => c.split(':')[0]).sort(), ['boundaryNotice', 'toolsBanner', 'versionNotice']);
  assert.ok(f.noticeControls.every((c) => c.includes('이번 주 그만 보기') && c.includes('닫기')));
  assert.deepEqual(f.noticeNoControlsOnSafety, [false, false, false, false], 'errors, the mode, the attachment notice and leftover processes cannot be put off');
  assert.deepEqual(f.noticeClosedHere, { tools: false, boundary: true, stored: {} }, 'closing without the check stores nothing');
  assert.deepEqual(f.noticeClosedComesBack, { tools: true, boundary: true });
  assert.equal(f.noticeSnoozedFor, 168, '7 days');
  assert.deepEqual(f.noticeSnoozedReopen, { tools: false, boundary: true }, 'only that kind');
  assert.deepEqual(f.noticeAfterWeek, { tools: true, boundary: true }, 'back after 7 days');
  assert.deepEqual(f.noticeBeforeReset, { tools: false, boundary: false });
  assert.match(f.noticeResetMsg, /다시 보이게/);
  assert.deepEqual(f.noticeAfterReset, { tools: true, boundary: true, stored: {} });
  assert.equal(f.noticeBoundaryInSession, true);
  assert.equal(f.noticeChecksCleared, true);
  // Memory: a card with 저장 / 고쳐서 저장 / 취소; nothing kept before the click; the edited text is what is kept; the settings list it.
  assert.deepEqual(f.memoryCard, { head: '이 내용을 기억할까요?', text: '일정 유무를 말하기 전에 캘린더를 먼저 조회한다', readOnly: true, buttons: ['취소', '고쳐서 저장', '저장'] });
  assert.equal(f.memoryNotBeforeClick, 0);
  assert.deepEqual(f.memoryEditing, { readOnly: false, label: '고친 내용 저장' });
  assert.deepEqual(f.memorySaved, [['일정 확인', '일정 유무를 말하기 전에 캘린더를 먼저 조회한다 (오늘·내일 질문 포함)']]);
  assert.deepEqual(f.memoryList, [['일정 확인', '일정 유무를 말하기 전에 캘린더를 먼저 조회한다 (오늘·내일 질문 포함)', true]]);
  // While it works: the bar with 중지, and a prompt asks how to go; a correction stops the step and goes on, the half result kept.
  assert.match(f.runBar.text, /작업 중입니다/);
  assert.equal(f.runBar.stop, true);
  assert.equal(f.runBar.choice, true);
  assert.deepEqual(f.runBar.choices, ['정정으로 보내기', '끝난 뒤 보내기', '취소']);
  assert.deepEqual(f.corrected, { stopped: true, half: true, bar: true });
  // A Dooray original: no card of ours (the Dooray widget asks on its own), a line saying where to look, then the copy or "받지 않음".
  assert.deepEqual(f.fetchWaiting, { text: '두레이 원본 받기: Desk Widgets 알림 카드에서 "받기"를 눌러 주세요 (회의자료.pdf, 3 KB).', cards: 0 });
  assert.deepEqual(f.fetchedChips, ['두레이에서 받음📎 회의자료.pdf (3 KB)', '두레이 원본 받지 않음예산안.xlsx (거절함)']);
  assert.equal(f.fetchWaitGone, true);
  assert.equal(f.fetchedCopy, true);
  // An answer's Markdown: the shapes are drawn, attacks stay words, links open only through the full-address check.
  const m = f.md;
  assert.deepEqual([m.h4, m.h5, m.tables, m.th, m.hr, m.ul, m.ol, m.tasks, m.quote, m.pre, m.code, m.strong, m.em, m.del], [1, 1, 2, 3, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1], JSON.stringify(m));
  // Bare addresses (even inside an <img ...> written as text) are links too: the same full-address check guards them.
  assert.equal(m.links[0], 'https://example.com/meeting?id=1');
  assert.ok(m.links.length === 3 && m.links.every((u) => u.startsWith('http://') || u.startsWith('https://')), JSON.stringify(m.links));
  assert.equal(m.dead, 1, 'the javascript: link is words with its address beside them');
  assert.deepEqual(m.imgText.length, 1);
  assert.match(m.imgText[0], /^\[이미지: 지도\] http:\/\/127\.0\.0\.1:\d+\/map\.png$/);
  assert.equal(m.bad, 0);
  assert.equal(m.pwned, null);
  assert.equal(m.scriptShown, true);
  assert.equal(m.pipe, '주간 회의 a | b');
  assert.deepEqual(m.align, ['left', 'center', 'right']);
  assert.equal(m.tableScrolls, true, 'a wide table scrolls inside the bubble');
  assert.equal(m.logNoSideways, true);
  assert.equal(m.youPlain, true, 'my own words stay as typed');
  assert.deepEqual(f.linkConfirm, [true, 'https://example.com/meeting?id=1']);
  assert.equal(f.scriptOpenIgnored, true);
  assert.deepEqual(f.openedUrls, ['https://example.com/meeting?id=1']);
  assert.equal(f.linkConfirmClosed, true);
  // The list: narrow by default, a real drag widens it and is saved, double-click resets, keys move it, limits hold.
  assert.equal(f.sideDefault, 180);
  assert.ok(f.sideDragged >= 260 && f.sideDragged <= 290, String(f.sideDragged));
  assert.equal(f.sideSaved, f.sideDragged);
  assert.deepEqual(f.sideReset, [180, 180]);
  assert.deepEqual(f.sideKeys, [212, 212]);
  assert.equal(f.sideHome, 140);
  assert.equal(f.sideEnd, 360);
  assert.equal(f.titleOneLine, true);
  assert.deepEqual(f.folded, ['none', true, '목록 보기']);
  assert.deepEqual(f.unfolded, ['flex', false]);
  assert.deepEqual(f.narrowFolds, ['none', false], 'folded for a narrow window, not saved as the user\'s choice');
  assert.equal(f.wideBack, 'flex');
  assert.match(f.tinyDetail, /\$0\.01 미만 \(추정\)/);
  assert.equal(f.errorGuide, true);
  assert.equal(f.requests, 0);
  assert.deepEqual(f.netLog, []);
  assert.deepEqual(f.console, []);
});
