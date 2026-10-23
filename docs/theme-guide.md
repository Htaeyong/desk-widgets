# 테마 만들기

두레이 대시보드·시계·캘린더·메일·시스템 모니터·할 일 위젯의 화면은 테마 폴더 하나로 통째로 바꿀 수 있습니다. 이 문서는 시작하는 방법을 안내하고, 정확한 규칙은 규격 문서에 있습니다.

| 위젯 | 규격 | 테마가 받는 API | 이 문서 |
|---|---|---|---|
| 공통 | [테마 규격](THEME_SPEC.md) | | 1장 |
| 두레이 대시보드 | [두레이 테마 규격](THEME_SPEC-dooray.md) | `window.dooray` | 2장 |
| 시계 | [시계 테마 규격](THEME_SPEC-clock.md) | `window.widget` | 3장 |
| 캘린더 | [캘린더 테마 규격](THEME_SPEC-calendar.md) | `window.widget` | 4장 |
| 메일 | [메일 테마 규격](THEME_SPEC-mail.md) | `window.widget` | 5장 |
| 시스템 모니터 | [시스템 모니터 테마 규격](THEME_SPEC-system-monitor.md) | `window.widget` | 규격 문서 |
| 할 일 목록 | [할 일 테마 규격](THEME_SPEC-todo.md) | `window.widget` | 규격 문서 |

## 1. 공통

### 시작하는 방법

1. 내장 테마 폴더 하나를 복사합니다(각 위젯 장의 "예제"). **색만 바꾸려면** `extends`로 기본 테마를 이어받고 `theme.json` + `style.css` 두 파일만 두는 것이 가장 쉽습니다. 기능은 기본 테마와 똑같이 동작하고, 기본 테마가 업데이트되면 함께 좋아집니다.
2. `theme.json`의 `id`를 폴더 이름과 같게 고칩니다. 시계·캘린더 테마는 `"widget": "clock"` / `"calendar"`가 꼭 있어야 합니다(없으면 두레이 테마로 봄).
3. 개발 중에는 설치하지 않고 바로 띄웁니다.

```bash
npm start -- --mock-data --theme "C:\path\to\my-theme"
```

- `--theme`: 그 폴더의 테마를 `theme.json`의 `widget` 위젯에 바로 적용(고른 테마와 상관없이)
- `--mock-data`: 계정 없이 예시 데이터로(두레이: 가상 프로젝트·업무·분류·태그, 캘린더: 메모리 안의 예시 캘린더로 만들기·수정·삭제까지. 실제 설정은 건드리지 않음)
- 파일을 고친 뒤 테마 창에서 **Ctrl+R**, `--devtools`를 붙이면 개발자 도구(F12)

### 꼭 지킬 것

- **데이터는 `textContent`로 넣기**: 업무 제목·일정 제목 등은 다른 사람이 입력한 값이라 `innerHTML`에 넣으면 안 됩니다.
- **외부 파일 금지**: CDN 스크립트·웹 폰트·외부 이미지·`fetch`는 막혀 있습니다. 필요한 파일은 테마 폴더에 넣으세요.
- **모르는 필드는 무시**: 규격은 필드가 계속 추가됩니다. 없는 필드도 대비하세요(예: `t.tags || []`).
- **창 드래그**: 끌 곳에 `-webkit-app-region: drag`, 그 안의 버튼·입력에는 `no-drag`.
- **스타일 속성**: 테마 HTML의 CSP가 인라인 `style="…"`을 막는다면 색 같은 값은 스크립트에서 `element.style.background = …`로 넣습니다.
- **미리보기**: 설정 창의 미리보기도 같은 격리 환경·같은 API로 실행되고 사용자 데이터를 씁니다. 저장되는 동작은 막혀 있으니(`getContext().preview`가 `true`), 미리보기에서 버튼이 안 먹는 것은 정상입니다.

### 배경 불투명도 지원하기 (선택)

사용자가 설정 창 슬라이더로 배경이 얼마나 비칠지 정하게 하려면:

1. `theme.json`에 기본값: `"background": { "opacity": 0.9 }` (0~1)
2. 배경색의 불투명도를 엔진이 넣어 주는 CSS 변수 `--theme-bg-alpha`로, 대체값은 같은 기본값으로:

```css
:root {
  --bg-alpha: var(--theme-bg-alpha, 0.9);
}
.shell { background: rgba(250, 250, 247, var(--bg-alpha)); }
```

- **배경에만** 씁니다. 글자·카드·버튼·메뉴/팝업·편집 창은 그대로 두어야 0%에서도 읽힙니다.
- 창이 불투명한 테마(`window.transparent: false`)는 비칠 것이 없으므로 넣지 않습니다. 넣지 않은 테마는 슬라이더가 없고 예전과 똑같이 보입니다. 자세히: [테마 규격](THEME_SPEC.md) 4장.

### 배포·설치

1. 테마 폴더를 그대로 압축해서 전달
2. 받는 사람: 그 위젯의 설정 → 테마 칸의 **테마 폴더 열기** → 폴더 넣기 → **목록 새로고침** → 테마 선택 → **미리보기**로 확인 → 저장(또는 미리보기의 "이 테마로 바꾸기")

| 위젯 | 받은 테마를 넣는 곳 |
|---|---|
| 두레이 | `%APPDATA%\chilgong88\desk-widgets\widgets\dooray\themes\` |
| 시계 | `%APPDATA%\chilgong88\desk-widgets\widgets\clock\themes\` |
| 캘린더 | `%APPDATA%\chilgong88\desk-widgets\widgets\calendar\themes\` |

다른 위젯의 테마는 "(다른 위젯 테마)", 규격 버전이 맞지 않으면 "(호환 안 됨)"으로 보이고 고를 수 없습니다. 같은 id면 내장 테마 대신 받은 테마가 쓰입니다.

## 2. 두레이 테마

### 예제

| 예제 | 위치 | 특징 |
|---|---|---|
| paper | [widgets/dooray/themes/paper](../widgets/dooray/themes/paper) | 가장 작은 예제(약 100줄). 규격의 기본만 사용 |
| glass | [widgets/dooray/themes/glass](../widgets/dooray/themes/glass) | 기본 테마. 검색·분류·태그·프로젝트 분리 등 전체 기능 |
| bigsur, midnight, sunset, mono | [widgets/dooray/themes](../widgets/dooray/themes) | glass를 이어받아(`extends`) **색과 모양만** 바꾼 테마. `theme.json` + `style.css` 두 파일 |
| sidebar, board, agenda, minibar | [widgets/dooray/themes](../widgets/dooray/themes) | **화면 구성 자체가 다른** 테마(사이드바·칸반·일정·미니 바). 자기 index.html·app.js를 갖고, 검색·마감 표시 등은 glass의 공통 도구 `kit.js`를 사용 (각 300~400줄) |

- **색만 바꾸기**: `widgets/dooray/themes/bigsur`를 복사해서 `style.css`의 변수 값만 고칩니다. 변수 목록은 `widgets/dooray/themes/glass/base.css` 맨 위. 배경 불투명도는 `--shell-bg` 대신 `--shell-rgb: 250, 250, 247;`과 `--bg-alpha: var(--theme-bg-alpha, 0.9);`(예: `bigsur`, `midnight`, `mono`), 그라데이션은 `sunset`처럼 색 멈춤마다 `rgba(r, g, b, var(--bg-alpha))`. 자세히: [두레이 테마 규격](THEME_SPEC-dooray.md)의 "색만 바꾼 테마".
- **화면 구성부터 새로**: `widgets/dooray/themes/agenda`를 복사하면 `extends: "glass"` 덕분에 `kit.js`(검색·초성·마감 표시·뒤로 가기 등)를 그대로 씁니다. 아무것도 이어받지 않는 독립 테마는 `paper`를 복사합니다.
- 데이터 모양은 [widgets/dooray/contract/sample-snapshot.json](../widgets/dooray/contract/sample-snapshot.json)에서 바로 볼 수 있습니다.

```json
{
  "id": "my-theme",
  "name": "내 테마",
  "version": "0.1.0",
  "author": "홍길동",
  "contractVersion": 1,
  "entry": "index.html",
  "window": { "transparent": false, "material": "none" }
}
```

### 최소 코드

```html
<!-- index.html -->
<body>
  <header style="-webkit-app-region: drag">
    Dooray <button id="close" style="-webkit-app-region: no-drag">✕</button>
  </header>
  <ul id="list"></ul>
  <script src="app.js"></script>
</body>
```

```js
// app.js
const api = window.dooray;
document.getElementById('close').onclick = () => api.window.close();

function render(snapshot) {
  const list = document.getElementById('list');
  list.replaceChildren(
    ...snapshot.projects.map((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name} ${p.counts.open}건`; // 데이터는 반드시 textContent로
      li.onclick = () => api.openUrl(p.url);
      return li;
    })
  );
}

api.getSnapshot().then(render);
api.onSnapshot(render);
```

### 두레이만의 것

- **모드 확인**: `getContext()`의 `mode`가 `project`면 프로젝트 하나(`projectId`)만 그립니다(별도 위젯으로 분리된 창).
- **뒤로 가기(권장)**: 여러 화면을 둔다면 마우스 옆 버튼(`mouseup`의 `button` 3=뒤로, 4=앞으로)과 Alt+←/→를 처리해 주세요. glass 테마의 `goBack`/`goForward` 참고.
- **미리보기에서**: `window.close`는 미리보기를 닫고, `togglePin`은 `false`, 분류 변경은 `{ ok: false }`, 순서 저장·별도 위젯·설정 열기는 무시됩니다.

## 3. 시계 테마

### 예제

| 예제 | 위치 | 특징 |
|---|---|---|
| dark-glass | [widgets/clock/themes/dark-glass](../widgets/clock/themes/dark-glass) | 기본 테마. 디지털·아날로그 얼굴, 스톱워치·타이머·알람 탭 전체(index.html · clock.css · clock.js · tools.js) |
| light, minimal, neon | [widgets/clock/themes/light](../widgets/clock/themes/light) 등 | `extends: "dark-glass"` + `style.css`로 **색만** 바꾼 테마. 변수 목록은 [dark-glass/style.css](../widgets/clock/themes/dark-glass/style.css) |
| analog | [widgets/clock/themes/analog](../widgets/clock/themes/analog) | 자기 `index.html`(아날로그 시계판)로 dark-glass의 코드를 함께 씀. 창 크기를 따로 기억 |

**색만 바꾸기**: `light` 폴더를 복사해 `theme.json`의 `id`·`name`과 `style.css`의 변수만 고치면 스톱워치·타이머·알람까지 그대로 동작합니다.

### 처음부터 만드는 최소 시계

```
my-clock/
├─ theme.json
├─ index.html
├─ style.css
└─ app.js
```

```json
{
  "id": "my-clock",
  "name": "내 시계",
  "version": "0.1.0",
  "author": "홍길동",
  "widget": "clock",
  "contractVersion": 1,
  "background": { "opacity": 0.8 },
  "window": { "transparent": true, "main": { "width": 220, "height": 96, "minWidth": 140, "minHeight": 64 } }
}
```

```html
<!-- index.html -->
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main id="clock">
      <div id="time"></div>
      <div id="date"></div>
    </main>
    <script src="app.js"></script>
  </body>
</html>
```

```css
/* style.css */
:root { --bg-alpha: var(--theme-bg-alpha, 0.8); }
html, body { margin: 0; height: 100%; background: transparent; }
#clock {
  height: 100%; box-sizing: border-box; padding: 12px 16px; border-radius: 14px;
  background: rgba(20, 22, 28, var(--bg-alpha)); color: #f2f4f8; font-family: 'Segoe UI', sans-serif;
  -webkit-app-region: drag; user-select: none;
}
#time { font-size: 34px; font-variant-numeric: tabular-nums; }
#date { font-size: 13px; opacity: 0.7; }
```

```js
// app.js
const W = window.widget;
let settings = { showSeconds: false, hour12: false, locale: 'ko-KR' };
let timer = null;

function draw() {
  const now = new Date();
  document.getElementById('time').textContent = now.toLocaleTimeString(settings.locale, {
    hour: '2-digit', minute: '2-digit', ...(settings.showSeconds ? { second: '2-digit' } : {}), hour12: settings.hour12,
  });
  document.getElementById('date').textContent = now.toLocaleDateString(settings.locale, { month: 'long', day: 'numeric', weekday: 'short' });
}

// 다시 그리기는 테마가: 다음 초(초를 안 보이면 다음 분) 경계에 맞춰서
function tick() {
  draw();
  const step = settings.showSeconds ? 1000 : 60000;
  timer = setTimeout(tick, step - (Date.now() % step) + 5);
}

W.api.getState().then((res) => {
  settings = res.result.settings;
  tick();
});
W.on('settings', (next) => {
  settings = next;
  clearTimeout(timer);
  tick();
});
```

- 끌기 영역(`#clock`)의 오른쪽 클릭은 엔진이 시계 메뉴(항상 위·스톱워치·타이머 사용·테마·설정…)로 받습니다.
- 스톱워치·타이머·알람을 그리려면 `features: ["tools"]`, `window["main+tools"]` 크기를 넣고 `on('timers', …)`와 `api.stopwatch.*`·`api.timer.*`·`api.alarms.*`를 씁니다. 남은 시간 계산·글자는 kit의 `timer-model.js`·`alarm-model.js`(`<script src="timer-model.js">`, 테마 폴더에 없어도 됨). 전체 목록: [시계 테마 규격](THEME_SPEC-clock.md).
- 타이머 종료·알람 카드와 소리는 시계 위젯이 띄웁니다. 테마는 그리기만 합니다.
- 실행: `npm start -- --theme "C:\path\to\my-clock"`

## 4. 캘린더 테마

### 예제

| 예제 | 위치 | 특징 |
|---|---|---|
| default | [widgets/calendar/themes/default](../widgets/calendar/themes/default) | 기본 테마. 작은 월 달력 + 일정 목록, 자세히·만들기·수정·삭제 창 전체(index.html · calendar.css · calendar.js · default.css) |
| big | [widgets/calendar/themes/big](../widgets/calendar/themes/big) | 큰 달력. 자기 `index.html` + `big.css`, `calendar.js`는 default의 것을 이어받아 씀 |

**색만 바꾸기**: `theme.json`(`extends: "default"`) + CSS 하나. 변수 목록은 [default/calendar.css](../widgets/calendar/themes/default/calendar.css) 맨 위. 화면 구성을 바꾸려면 `big`처럼 자기 `index.html`을 두고 default의 `calendar.js`를 함께 쓰거나, `default` 폴더를 통째로 복사해 고칩니다.

### 처음부터 만드는 최소 캘린더 (다가오는 일정 목록)

```json
{
  "id": "my-agenda",
  "name": "내 일정 목록",
  "version": "0.1.0",
  "author": "홍길동",
  "widget": "calendar",
  "contractVersion": 1,
  "background": { "opacity": 0.85 },
  "window": { "transparent": true, "main": { "width": 280, "height": 360, "minWidth": 220, "minHeight": 200 } }
}
```

```html
<!-- index.html -->
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <header id="head">다가오는 일정 <button id="refresh">↻</button></header>
    <ol id="days"></ol>
    <script src="model.js"></script> <!-- 캘린더 kit: 테마 폴더에 없어도 됨 -->
    <script src="app.js"></script>
  </body>
</html>
```

```css
/* style.css */
:root { --bg-alpha: var(--theme-bg-alpha, 0.85); }
html, body { margin: 0; height: 100%; }
body { background: rgba(24, 26, 32, var(--bg-alpha)); color: #eef0f4; font: 13px 'Segoe UI', sans-serif; border-radius: 12px; overflow: auto; }
#head { padding: 8px 12px; font-weight: 600; -webkit-app-region: drag; }
#head button { -webkit-app-region: no-drag; }
#days { list-style: none; margin: 0; padding: 0 12px 12px; }
.event { border-left: 3px solid; padding-left: 6px; margin: 2px 0; cursor: default; }
```

```js
// app.js
const W = window.widget;
const M = window.CalendarModel;
const DAYS = 14;

async function render() {
  const state = await W.api.getState();
  const now = new Date();
  const [events] = await W.api.events.list([{ from: now.getTime(), to: now.getTime() + DAYS * 86400000 }]);
  const days = M.upcoming(events, now, Math.min(DAYS, state.upcomingDays || DAYS));
  document.getElementById('days').replaceChildren(
    ...days.map(({ key, events: list }) => {
      const day = document.createElement('li');
      day.textContent = M.dayTitle(key);
      for (const e of list) {
        const row = document.createElement('div');
        row.className = 'event';
        row.style.borderLeftColor = e.color;                  // CSSOM으로 (인라인 style 속성 대신)
        row.textContent = `${M.timeLabel(e, key)} ${e.title}`; // 반드시 textContent
        if (e.hasUrl) row.onclick = () => W.api.events.openLink(e); // 클릭 안에서 바로: 사용자 조작 필요 호출
        day.append(row);
      }
      return day;
    })
  );
}

document.getElementById('refresh').onclick = () => W.api.refresh();
W.on('changed', render);
render();
```

- 일정 쓰기(`api.events.create/update/remove`)와 링크 열기는 **클릭·키 입력 처리기 안에서 바로** 불러야 합니다. 삭제는 위젯이 확인 창을 띄웁니다.
- 저장·삭제는 뒤에서 진행되어 곧바로 `{ ok: true, queued: true }`가 오고, 그 일정은 `pending`으로 보입니다. 실패는 위젯이 알림 카드로 알리고 `reveal`·`open-editor` 이벤트로 테마에 돌아옵니다.
- 일정에는 URL이 없고 `hasUrl`만 있습니다. 계정·비밀번호는 테마가 볼 수 없습니다.
- 보고 있는 달·고른 날짜·편집 중인 값은 테마가 들고 있습니다(위젯은 저장하지 않음).
- 전체 목록: [캘린더 테마 규격](THEME_SPEC-calendar.md). 실행: `npm start -- --mock-data --theme "C:\path\to\my-agenda"`

## 5. 메일 테마

### 예제

| 예제 | 위치 | 특징 |
|---|---|---|
| default | [widgets/mail/themes/default](../widgets/mail/themes/default) | 기본 테마. 계정을 모은 받은편지함 목록(계정 칩으로 거르기, 더 보기) + 본문(텍스트) 보기와 원문 보기·답장·전달 버튼(index.html · mail.css · mail.js) |
| dashboard | [widgets/mail/themes/dashboard](../widgets/mail/themes/dashboard) | 계정 대시보드(#72). 화면이 3단계(계정 카드 → 계정 목록 → 메일)인 예: kit의 `nav.js`(뒤로·앞으로)와 `dash-model.js`(빠른 거르기 ↔ `filter({ accountId, unread, flagged, category })`), `getState().accounts[]`의 서버 숫자(`unread`·`flagged`)와 불러온 메일 기준 숫자(`categories`) 구분 |
| compact | [widgets/mail/themes/compact](../widgets/mail/themes/compact) | 작은 카드. 안 읽은 수와 최근 메일 몇 통. 자기 `index.html`·`compact.css`·`compact.js`, `mail.css`(변수·카드)는 default에서 이어받음 |

**색만 바꾸기**: `theme.json`(`extends: "default"`) + CSS 하나. 변수 목록은 [default/mail.css](../widgets/mail/themes/default/mail.css) 맨 위.

### 처음부터 만드는 최소 메일 테마 (안 읽은 메일 목록)

```json
{
  "id": "my-unread",
  "name": "안 읽은 메일만",
  "version": "0.1.0",
  "author": "홍길동",
  "widget": "mail",
  "contractVersion": 1,
  "background": { "opacity": 0.85 },
  "window": { "transparent": true, "main": { "width": 300, "height": 260, "minWidth": 200, "minHeight": 120 } }
}
```

```html
<!-- index.html -->
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <header id="head">안 읽은 메일 <b id="n">0</b></header>
    <ul id="list"></ul>
    <script src="mail-model.js"></script> <!-- 메일 kit: 테마 폴더에 없어도 됨 -->
    <script src="app.js"></script>
  </body>
</html>
```

```css
/* style.css */
:root { --bg-alpha: var(--theme-bg-alpha, 0.85); }
html, body { margin: 0; height: 100%; }
body { background: rgba(24, 26, 32, var(--bg-alpha)); color: #eef0f4; font: 13px 'Segoe UI', 'Malgun Gothic', sans-serif; border-radius: 12px; overflow: auto; }
#head { padding: 8px 12px; font-weight: 600; -webkit-app-region: drag; }
#list { list-style: none; margin: 0; padding: 0 8px 8px; }
#list li { border-left: 3px solid; padding: 2px 6px; margin: 2px 0; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

```js
// app.js
const W = window.widget;
const M = window.MailModel;

async function render() {
  const state = await W.api.getState();
  const { items } = await W.api.list();
  document.getElementById('n').textContent = String(state.totalUnread);
  document.getElementById('list').replaceChildren(
    ...items.filter((m) => m.unread).map((m) => {
      const li = document.createElement('li');
      li.style.borderLeftColor = m.color;                                   // CSSOM으로 (인라인 style 속성 대신)
      li.textContent = `${M.timeLabel(m.date)} ${M.senderLabel(m.from)} · ${m.subject}`; // 반드시 textContent
      li.onclick = () => W.api.openPreview(m.id);                         // 클릭 안에서 바로: 사용자 조작 필요 호출
      return li;
    })
  );
}

W.on('changed', render);
W.on('messages', render);
render();
```

- 메일 내용(보낸 사람·제목·본문)은 남이 쓴 글입니다. **`textContent`로만** 넣으세요. 테마는 HTML 원문을 받지 않고, 원문은 `api.openPreview(id)`로 위젯의 격리된 보기 창에서 엽니다.
- 읽음 표시·원문 보기·답장·전달·새 메일·웹메일은 **클릭·키 입력 처리기 안에서 바로** 불러야 합니다. 미리보기에서는 거절됩니다(`select`는 미리보기에서 읽기만).
- 계정·비밀번호·서버 주소·Message-ID는 테마가 볼 수 없습니다. 쓰기는 위젯이 메일 프로그램·웹메일로 넘깁니다.
- 전체 목록: [메일 테마 규격](THEME_SPEC-mail.md). 실행: `npm start -- --mock-data --theme "C:\path\to\my-unread"`

## 6. 시스템 모니터·할 일 테마

두 위젯의 기본 테마는 기존 시계·캘린더·메일의 다크 글래스 스타일과 같은 짙은 회색 반투명 카드입니다. 다른 색상은 기본 테마를 `extends`로 이어받고 `style.css`의 색 변수를 바꾸는 선택 테마로 만듭니다.

| 위젯 | 기본 테마 | 색상 변형 예제 |
|---|---|---|
| 시스템 모니터 | [graph](../widgets/system-monitor/themes/graph) | [ocean](../widgets/system-monitor/themes/ocean): `graph`를 이어받아 파란 그라데이션과 그래프 색 변경 |
| 할 일 | [default](../widgets/todo/themes/default) | [ocean](../widgets/todo/themes/ocean): `default`를 이어받아 남색 카드와 하늘색 강조색 변경 |

두 위젯 모두 카드 **배경만** `--theme-bg-alpha`를 사용합니다. 색상 변형에서도 설정의 배경 불투명도 슬라이더를 동작시키고, 글자·입력·측정 항목은 읽을 수 있게 유지하세요. 데이터·호출 규격은 [시스템 모니터](THEME_SPEC-system-monitor.md)와 [할 일](THEME_SPEC-todo.md) 문서를 참고하세요.
