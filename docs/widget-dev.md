# 위젯 만들기

Desk Widgets 위젯은 **엔진과 따로 설치하는 패키지**입니다. 설치된 엔진(Electron) 하나가 모든 위젯을 불러와 실행하므로, 위젯 하나를 추가해도 메모리가 약 25MB만 늘어납니다(별도 Electron 앱이면 약 115MB).

가장 작은 예제는 시계 위젯([`widgets/clock`](../widgets/clock))이고(엔진 테마 호스트·알림 카드도 사용), 테마·추가 창·알림까지 쓰는 예제는 두레이 위젯([`widgets/dooray`](../widgets/dooray))입니다. 네트워크에서 데이터를 주기적으로 받고(자리 비움 중 멈춤, 캐시) 설정 창에서 목록을 편집하는 예제는 캘린더 위젯([`widgets/calendar`](../widgets/calendar))입니다. 위젯 자체 창 여러 개·파일 끌어다 놓기·문서 폴더 저장 예제는 스티키 노트 위젯([`widgets/memo`](../widgets/memo))입니다.

## 1. 폴더 구조

```
my-widget/
  widget.json          위젯 정보 (아래)
  index.js             module.exports = { create(ctx) { ... } }
  settings/            (선택) 위젯 설정 창에 들어갈 화면: panel.html, panel.js
  renderer/ preload/   (선택) 위젯 창 화면
  package.json         (선택) npm run build 스크립트
```

설치하면 `C:\Program Files\chilgong88\widgets\<id>\`에 이 폴더가 그대로 복사됩니다(관리자만 쓸 수 있는 곳). 위젯 코드는 엔진의 메인 프로세스에서 앱과 같은 권한으로 실행되므로, 신뢰하는 위젯만 설치해야 합니다.

## 2. widget.json

```json
{
  "id": "clock",
  "name": "시계",
  "description": "바탕화면 시계",
  "version": "1.0.0",
  "engineApi": "1.0",
  "main": "index.js",
  "settings": { "html": "settings/panel.html", "script": "settings/panel.js" },
  "package": { "productName": "ClockWidget", "exclude": ["package.json", "test"] }
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `id` | O | 소문자·숫자·`-`. 폴더 이름과 같아야 함. 설정 폴더 이름(`widgets\<id>`)으로도 쓰임 |
| `name` | O | 위젯 관리 창·설정 창 제목에 표시 |
| `engineApi` | O | 이 위젯이 쓰는 엔진 API 버전 (아래 4장). 없거나 맞지 않으면 실행되지 않고 위젯 관리 창에 이유가 표시됨 |
| `version`, `description` | | 위젯 관리 창에 표시 |
| `main` | | 기본 `index.js` |
| `settings` | | 위젯 설정 창 화면 (아래 5장). 없으면 설정 버튼이 없음 |
| `order` | | 위젯 관리 창 표시 순서 (작을수록 위) |
| `themes` | | (1.3) 테마 패키지를 쓰는 위젯: `{ "contract": "clock", "contractVersions": [1], "default": "dark-glass" }`. `ctx.useThemes` 옵션의 기본값 (4장 "위젯별 테마 호스트") |
| `defaultEnabled` | | `false`면 처음 발견됐을 때 꺼진 상태. 기본은 켜짐(설치하면 바로 사용) |
| `package` | 빌드용 | `productName`(영문·숫자, 제어판 이름 `Desk Widgets-<productName>`과 설치 파일 이름에 사용), `exclude`(패키지에서 뺄 최상위 파일·폴더), `installerHooks`(설치 프로그램에 추가할 NSIS 매크로 파일). 설치되는 widget.json에서는 빠짐 |

## 3. index.js

```js
function create(ctx) {
  // 가볍게: 창이나 타이머를 여기서 만들지 않음 (꺼 둔 위젯도 create는 실행됨)
  const store = ctx.createStore({ file: require('path').join(ctx.dataDir, 'settings.json'), defaults: { showSeconds: false } });
  let win = null;
  return {
    start() {          // 켜질 때: 창 열기, IPC 등록, 작업 시작
      ctx.handle('clock:get', (event) => store.load());
      win = ctx.createWidgetWindow({ html: ..., preload: ..., size: { width: 220, height: 96 },
                                     getBounds: () => store.load().windowBounds,
                                     saveBounds: (b) => store.save({ windowBounds: b }) });
    },
    stop() {},         // 꺼질 때 (ctx.handle·ctx.onStop·ctx로 만든 창은 엔진이 정리)
    focus: () => { win?.focus(); return Boolean(win); },
    desktopWindows: () => (win ? [win] : []),     // Win+D에도 바탕화면에 남길 창
    setPaused: (reason) => {},                    // 잠금·절전·자리 비움이면 'locked'/'suspended'/'idle', 돌아오면 null
    needsSetup: () => false,                      // true면 켜지자마자 설정 창이 열림 (예: 토큰 없음)
    settings: { get: () => store.load(), save: (values) => { store.save(values); return { ok: true }; }, handlers: {} },
  };
}
module.exports = { create };
```

**위젯 화면(HTML)도 자기 폴더의 파일만 불러옵니다.** `<link href>`, `<script src>`, `<img src>`가 엔진 파일이나 위젯 밖을 가리키면 설치된 위젯에서는 비어 보입니다(필요한 스타일은 위젯 안에 함께 둠). 테스트 `engine/test/widget-assets.test.js`가 확인합니다.

**위젯 코드는 엔진 파일을 `require`하지 않습니다.** 엔진과 다른 폴더에 설치되므로 필요한 기능은 모두 `ctx`로 받습니다. Node 기본 모듈과 `electron`은 쓸 수 있고, 다른 npm 패키지가 필요하면 위젯 폴더에 함께 넣습니다.

## 4. ctx API (엔진 API 1.5)

| 항목 | 설명 |
|---|---|
| `id`, `manifest`, `dir`, `dataDir` | 위젯 id, widget.json 내용, 설치 폴더, 설정·데이터 폴더(`%APPDATA%\chilgong88\desk-widgets\widgets\<id>`) |
| `engineApi` | 엔진의 API 버전 |
| `flags.mockData`, `flags.devtools` | `--mock-data`, `--devtools`로 실행했는지 |
| `app.version`, `app.isPackaged`, `app.locale()` | 엔진 버전 등 |
| `createStore({ file, defaults, sanitize?, upgrade?, seed?, secret? })` | JSON 설정 파일. `secret: { field, enc, plain }`이면 그 값은 Windows 암호화(DPAPI)로만 저장: 암호화를 쓸 수 없으면 새 값의 `save()`가 `code: 'secret-unavailable'` 오류를 던지고 아무것도 쓰지 않음(평문 저장 없음, `plain`은 예전 파일을 읽을 때만 씀). `secretAvailable()`로 미리 확인 가능 |
| `system.createSampler({ intervalMs, historyMs })` | 1.5부터 Windows PC 측정 서비스. `read()`로 CPU·메모리·디스크·네트워크·GPU·배터리·가동 시간을 읽고, `reset()`으로 CPU 기준과 기록을 비우며, 위젯 중지 시 `close()`로 PDH 카운터를 해제. 지원하지 않는 값은 `null` ([시스템 모니터 규격](THEME_SPEC-system-monitor.md)) |
| `system.isWindowCovered(window)` | 1.5부터 Windows에서 위젯 창이 불투명한 다른 창들에 완전히 가려졌는지 확인. 판정할 수 없는 경우 측정을 계속하도록 `false`를 반환 |
| `handle(channel, fn)` | `ipcMain.handle`. 위젯이 꺼지면 엔진이 제거 |
| `onStop(fn)` | 위젯이 꺼질 때 실행할 정리 |
| `createWidgetWindow({ html, preload, size, getBounds, saveBounds, transparent? })` | 테두리 없는 바탕화면 위젯 창 (작업 표시줄 없음, 위치 저장, Win+D 고정 대상). 꺼지면 닫힘 |
| `openAppWindow({ html, preload, query?, title, width, height, minWidth?, minHeight? })` | 일반 앱 창 (예: 두레이 분류 관리). 꺼지면 닫힘 |
| `popupMenu(win, items?)` | 오른쪽 클릭 메뉴: 위젯 항목 + 설정 / 위젯 관리 / 이 위젯 끄기 / 종료. 항목에는 `type: 'checkbox'`·`radio`·`submenu`도 쓸 수 있음(시계의 항상 위·테마). 끌기 영역에서는 한 번 클릭에 `system-context-menu`와 DOM `contextmenu`가 둘 다 올 수 있어, 두 번 열리면 메뉴가 바로 닫히니 한 번만 열도록 걸러야 함 |
| `useThemes({ store, builtinDir, userDir, api })` | 테마로 모양을 바꾸는 위젯, 두레이 방식(`window.dooray`, [두레이 테마 규격](THEME_SPEC-dooray.md)). 이 방식은 한 위젯만. 자기 테마 규격을 가진 위젯은 아래 "위젯별 테마 호스트"(1.3). 1.3부터 테마별 **배경 불투명도**: `store`에 `themeOpacity: { 테마 id: 0~100 }`을 두면 엔진이 테마에 적용, `settingsHandlers().liveOpacity(themeId, 값 또는 null)`(저장 전 미리 보기), 저장 뒤 `host.applyBackground()` |
| `notify(events, { openUrl?, showWidget?, menu?, onAction? })` | 알림 카드. 어느 위젯이든 쓰는 **일반 카드**(`type: 'card'`, 1.2부터)는 아래 "일반 알림 카드", 그 밖의 이벤트는 두레이 업무 카드 모양. `menu`는 1.1부터(두레이 업무 카드), **1.4부터 일반 카드에도**, 아래 "카드 메뉴" |
| `openSettings()`, `openManager()`, `disable()`, `quit()` | 이 위젯 설정 창, 위젯 관리 창, 이 위젯 끄기, 앱 종료 |
| `beforeFocus(win)` | 위젯 창을 앞으로 가져오기 전에 호출 (Win+D 고정 해제) |
| `sendToSettings(name, payload)` | 열린 설정 창에 이벤트 보내기 |
| `confirm(win, options)`, `openExternal(url)` | 확인 대화상자, 브라우저로 열기 |

### 카드 메뉴 (엔진 API 1.1, 일반 카드는 1.4)

1.4(#71)부터 **일반 카드**(`type: 'card'`)에도 같은 메뉴가 붙습니다(예: 메일 위젯의 새 메일 카드 "분류"). 이때 `appliesTo`·`items`·`toggle`·`create.run`이 받는 `event`는 엔진이 정리한 카드(`{ type: 'card', title, body, icon, actions, sticky, sound, tag }`)이므로, 위젯은 **`tag`로 어느 카드인지** 알아봅니다(카드에 위젯만의 필드를 넣어도 엔진이 지움). 요약 카드에는 붙지 않고, 대기 중(#42)인 카드는 메뉴를 열 수 없으며, 확인할 때까지 남는(sticky) 카드는 메뉴를 닫아도 자동으로 닫히지 않습니다. 메뉴를 쓰는 일반 카드 위젯이 1.3 이하 엔진에서도 돌아야 하면 `"engineApi": "1.3"`으로 두면 됩니다(그 엔진에서는 메뉴가 그냥 안 보임). 두레이 업무 카드는 1.1 그대로입니다.

위젯이 알림 카드에 체크 목록 메뉴를 붙일 수 있습니다(예: 두레이의 "분류"). 위젯은 내용만 정하고, 엔진이 버튼·목록·입력 칸을 그리고 클릭을 위젯으로 돌려줍니다.

```js
ctx.notify(events, {
  openUrl, showWidget,
  menu: {
    label: '분류',                                   // 카드 버튼 이름
    appliesTo: (event) => Boolean(event.task?.id),   // 이 카드에 메뉴를 붙일지 (선택)
    items: (event) => [{ id, label, color, checked }],  // 목록 (color는 #rgb/#rrggbb, 선택)
    toggle: (event, id, checked) => items,           // 항목을 눌렀을 때 → 바뀐 목록
    create: { placeholder: '새 분류 이름', run: (event, text) => items },  // 새로 만들기 칸 (선택)
  },
});
```

- 버튼에는 체크된 항목(첫 항목 색·이름 + 나머지 개수)이 표시됩니다.
- 함수에서 오류를 던지면 그 메시지가 카드에 표시됩니다(예: "같은 이름의 분류가 이미 있습니다.").
- 메뉴가 열리면 카드가 위로 커지고(최대 260px) 입력을 위해 그 카드만 포커스를 받으며, 열려 있는 동안 그 카드의 자동 닫기 타이머만 멈춥니다. Esc나 카드 밖 클릭으로 닫힙니다. 메뉴가 없는 카드는 예전처럼 포커스를 받지 않습니다.
- 메뉴를 쓰는 위젯은 `"engineApi": "1.1"`이 필요합니다(1.0 엔진에서는 "호환 안 됨"으로 표시).

### 위젯별 테마 호스트 (엔진 API 1.3, #57)

두레이처럼 화면을 **격리된 테마 패키지**로 바꾸고 다른 사람이 테마를 만들 수 있게 하려면 `ctx.useThemes`에 `methods`를 줍니다. 위젯마다 테마 목록·주소(`widget-theme://<themeId>.<widgetId>/`)·세션(`widget-theme-<widgetId>`)이 따로 생기고, 테마는 `window.widget`만 받습니다. 테마 쪽 규칙은 [테마 규격](THEME_SPEC.md), 실제 사용 예는 시계([`widgets/clock/index.js`](../widgets/clock/index.js), [시계 테마 규격](THEME_SPEC-clock.md))와 캘린더([`widgets/calendar/index.js`](../widgets/calendar/index.js), [캘린더 테마 규격](THEME_SPEC-calendar.md)). 설계: [theme-host-design.md](theme-host-design.md).

**엔진 API 1.3 요약 (위젯 작성자용)**

| 옵션 | 뜻 |
|---|---|
| `store` | 위젯 설정 저장소. 호스트가 `themeId`, `alwaysOnTop`, `themeBounds`(창 위치·크기), `themeFrames`(추가 창), `themeOpacity`(배경 불투명도)를 읽고 씀 |
| `builtinDir` / `userDir` | 내장 테마(`<위젯 폴더>\themes`) / 받은 테마(`<dataDir>\themes`) |
| `kitDir` | (선택) 모든 테마가 불러올 수 있는 공용 파일 폴더(테마 → `extends` 기반 → kit 순으로 찾음). 메인과 테마가 같은 계산 코드를 쓰게 할 때(시계 `kit/timer-model.js`, 캘린더 `kit/model.js`) |
| `defaultTheme` | 기본 테마 id. 목록 맨 위, 고른 테마를 쓸 수 없을 때 대신 |
| `contractVersions` | 지원하는 테마 규격 버전(theme.json `contractVersion`). 보통 `[1]` |
| `frames` | 창 종류와 기본 크기 `{ main: { width, height, minWidth, minHeight, variants? } }`. 첫 번째가 주 창 |
| `variant()` | (선택) 지금 창 크기 변형 이름(시계: 스톱워치·타이머를 켜면 `'tools'` → `main+tools` 크기) |
| `methods` | 테마가 부를 수 있는 호출. `{ run(entry, ...args), preview: 'allow' \| 'noop' \| 'deny', gesture?: true }` 또는 함수 |
| `events` | 테마에 보낼 수 있는 이벤트 이름 |
| `menuItems(entry)` | (선택) 테마 창 오른쪽 클릭 메뉴의 위젯 항목 |

- **읽기는 `allow`, 버튼 누르기는 `noop`, 저장되는 변경은 `deny`**(미리보기 규칙), 서버나 사용자 데이터를 바꾸는 호출은 `gesture: true`가 기본 선택입니다(캘린더 쓰기).
- 테마가 넘기는 값은 메인에서 다시 검사하고, URL·경로처럼 그대로 쓰일 값을 받지 말고 id를 받으세요(캘린더 `events.openLink`).
- 비밀 값·계정은 테마에 보내지 마세요. 설정 창(위젯 설정 화면)에서만 다룹니다.
- 설정 화면의 테마 칸은 엔진 공용 칸(5장 "공용 테마 칸")을 씁니다.

```js
const host = ctx.useThemes({
  store,                                  // themeId, alwaysOnTop, themeBounds, themeFrames, themeOpacity(#55)를 저장
  builtinDir: path.join(ctx.dir, 'themes'),
  userDir: path.join(ctx.dataDir, 'themes'),
  kitDir: path.join(ctx.dir, 'kit'),      // (선택) 모든 테마가 불러올 수 있는 공용 파일
  defaultTheme: 'dark-glass',
  contractVersions: [1],                  // 지원하는 테마 규격 버전 (theme.json contractVersion)
  frames: { main: { width: 220, height: 96, minWidth: 140, minHeight: 64, variants: { tools: { width: 260, height: 200 } } } },
  variant: () => (store.load().tools ? 'tools' : null),   // (선택) 창 크기 변형
  methods: {
    getState: { run: (entry) => state(), preview: 'allow' },
    'timer.start': { run: (entry) => startTimer(), preview: 'noop' },
    'events.remove': { run: (entry, req) => remove(req), gesture: true },  // 클릭·키 입력 직후에만
  },
  events: ['settings', 'timers'],
  menuItems: (entry) => [{ label: '항상 위에 표시', type: 'checkbox', checked, click }],
});
host.emit('timers', timersView());        // 선언한 이벤트만 테마로 감
```

| 호스트 | 설명 |
|---|---|
| `open()` / `close()` / `focus()` / `desktopWindows()` | 두레이 방식과 같음 (`start`·`stop`·`focus`·`desktopWindows`에서 그대로 부름) |
| `emit(name, payload)` | `events`에 있는 이름만 모든 테마 창·미리보기에 보냄 |
| `reload()`, `applyTheme(id)` | 테마 창 다시 만들기, 테마 바꾸기 |
| `applyVariant()` | `variant()` 값이 바뀐 뒤: 지금 크기를 이전 키에 저장하고 새 키의 크기로 (가운데 기준) |
| `setPinned(on)` | 항상 위 (`alwaysOnTop` 저장) |
| `openFrame(frame, instanceId?)` | `frames`의 다른 창 열기 (기억했다가 다시 켤 때 함께 열림) |
| `applyBackground()`, `settingsHandlers()` | 배경 불투명도(#55), 설정 창용 호출(`themes`·`previewTheme`·`openThemeFolder`·`liveOpacity`) |

- `methods`의 함수는 첫 인자로 부른 창 `{ frame, instanceId, preview, theme }`를 받습니다. 선언하지 않은 이름, 64KB가 넘는 인자는 엔진이 `{ ok: false, message }`로 거절하고, 함수가 던진 오류도 `{ ok: false, message }`가 됩니다.
- `preview`: 미리보기에서 부를 때 `'deny'`(기본, 거절) / `'noop'`(아무것도 안 하고 `null`) / `'allow'`(실행, 읽기 함수).
- 테마의 theme.json에는 `"widget": "<위젯 id>"`가 필요합니다(없으면 두레이 테마로 봄). 창 크기는 `window.main`, 변형은 `window["main+tools"]`, 그리기 범위는 `features`.
- `widget.json`의 `"themes": { "contract", "contractVersions", "default" }`는 이 옵션들의 기본값입니다.
- 테마 창 오른쪽 클릭(끌기 영역)과 `window.widget.window.openMenu()`는 `menuItems` + 엔진 항목 메뉴를 띄웁니다(한 번 클릭에 두 번 열리지 않게 엔진이 거름).
- 창 위치·크기 저장 키: `main`, `main+tools`, `<레이아웃>/main` … (기본 테마와 그 색 테마는 같은 키).

테마 쪽 `window.widget`:

| 이름 | 설명 |
|---|---|
| `getContext()` | `{ widget: { id, name }, contract: { name, version }, frame, instanceId, preview, theme: { id, name, version }, background, locale }` |
| `api.<이름>(...)` / `call(name, ...)` | 위젯이 선언한 호출 (Promise) |
| `on(event, callback)` | 선언된 이벤트 구독, 해제 함수 반환 |
| `onBackground(callback)` | 배경 불투명도 변경(#55). CSS 변수 `--theme-bg-alpha`는 항상 들어감 |
| `openSettings()` | 위젯 설정 창 |
| `window.close()` / `togglePin()` / `getState()` / `setSize(w, h)` / `openMenu()` | 주 창 닫기 = 위젯 끄기, 미리보기에서는 미리보기에 적용 |

### 일반 알림 카드 (엔진 API 1.2)

어느 위젯이든 보낼 수 있는 알림 카드입니다(예: 시계 타이머 종료). 카드에는 **보낸 위젯 이름**(widget.json의 `name`)이 표시되어 사용자가 어디서 온 알림인지 압니다.

```js
ctx.notify(
  [
    {
      type: 'card',                 // 일반 카드
      title: '타이머 종료',            // 필수 (최대 120자, 두 줄까지 보임)
      body: '25분 타이머가 끝났습니다.', // 선택 (최대 300자, 한 줄 + 마우스를 올리면 전체)
      icon: 'alarm',                // 선택: 아래 아이콘 이름, 이모지 하나, 또는 이미지 data URL
      actions: [{ id: 'snooze', label: '5분 뒤 다시' }],  // 선택: 버튼 최대 3개 (이름 최대 20자)
      sticky: true,                 // 선택: 확인할 때까지 남음 (엔진의 유지 시간 설정과 상관없이)
      sound: true,                  // 선택: 처음 화면에 뜰 때 짧은 알림음 한 번
      tag: 'timer',                 // 선택: 같은 위젯이 같은 tag로 다시 보내면 이전 카드를 바꿈
    },
  ],
  {
    onAction: (event, actionId) => {
      if (actionId === 'snooze') startTimer(5 * 60);
      // return { keepOpen: true }; 이면 카드를 닫지 않음
    },
  }
);
```

| 필드 | 동작 |
|---|---|
| `title` | 없거나 비어 있으면 그 카드는 표시하지 않음 |
| `icon` | 이름: `bell` `alarm` `timer` `clock` `info` `warning` `error` `check` `calendar` `mail` `star`. 이모지(글자·숫자·`/`·`:` 없는 16자 이하)도 됨. 이미지는 `data:image/(png\|jpeg\|gif\|webp\|svg+xml);base64,...` 형식, **64KB 이하**만. 파일 경로·URL은 받지 않음(카드 화면은 엔진 것이라 위젯 파일을 불러오지 않음, #40). 위젯 폴더의 아이콘은 직접 읽어 data URL로: `'data:image/png;base64,' + fs.readFileSync(path.join(ctx.dir, 'icon.png')).toString('base64')` |
| `actions` | 카드 아래쪽 버튼(첫 번째가 강조). 누르면 `onAction(event, actionId)`가 불리고 카드가 닫힘. `{ keepOpen: true }`를 돌려주면 남고, 오류를 던지면 남은 채 메시지가 표시됨. **확인** 버튼은 항상 있음. `onAction`이 없으면 버튼은 닫기만 함. 위젯이 꺼지거나 다시 불러와진 뒤 누른 버튼은 위젯에 전달되지 않음 |
| `sticky` | `true`일 때만(다른 값은 무시) 자동 닫기 없이 남음. 없으면 엔진 설정(유지 시간)을 따름 |
| `sound` | `true`일 때만. 엔진이 만든 짧은 소리(파일·URL 없음)를 **처음 화면에 뜰 때 한 번**. 사용자가 자리 비움(잠금·절전·입력 없음)이면 돌아왔을 때 그 카드가 보이고 있으면 울림 |
| `tag` | 같은 위젯·같은 tag의 카드(화면에 있든 대기 중이든)를 닫고 새 카드를 띄움. 다른 위젯의 카드에는 영향 없음 |

- 일반 카드도 쌓기·최대 개수·대기·모두 확인 규칙(#42)을 똑같이 따릅니다. 많이 보내도 두레이처럼 "업무 변경 N건" 요약 카드로 묶이지 않습니다.
- 일반 카드에는 **열기** 버튼이 없습니다. 카드 메뉴는 1.3까지는 두레이 이벤트 카드에만, **1.4부터 일반 카드에도** 붙습니다(위 "카드 메뉴").
- 일반 카드를 쓰는 위젯은 `"engineApi": "1.2"`가 필요합니다(1.0·1.1 위젯은 그대로 동작).
- 위젯 없이 모양을 보려면 `--sample-card`로 실행합니다(아래 6장).

**버전 규칙**: 현재 엔진 API는 1.5(1.0 + 카드 메뉴 1.1 + 일반 알림 카드 1.2 + 테마 배경 불투명도·위젯별 테마 호스트 1.3 + 일반 카드의 카드 메뉴 1.4 + Windows 측정 서비스 1.5)입니다. `"engineApi": "1.0"`은 "1.0 이상 1.x"에서 동작한다는 뜻입니다. 엔진은 같은 큰 버전 안에서는 기능을 **추가만** 하고(1.1, 1.2 …), 없애거나 바꿀 때는 큰 버전을 올립니다(2.0). 맞지 않는 위젯은 위젯 관리 창에 "호환 안 됨"과 이유(엔진 또는 위젯을 업데이트하라는 안내)가 표시되고 실행되지 않습니다.

## 5. 설정 화면

위젯 설정은 위젯 안에서 엽니다(테마의 ⚙, 오른쪽 클릭 메뉴, 위젯 관리 창의 **설정**). 엔진이 설정 창 틀(제목·저장·취소)을 만들고 `settings.html` 내용을 가운데 넣은 뒤 `settings.script`를 실행합니다.

```js
// settings/panel.js
window.settingsShell.registerPanel('clock', {
  init(root, values, api) { /* values = settings.get(). api.call(name, ...args) -> settings.handlers[name] */ },
  validate() { return null; },              // 문제가 있으면 안내 문구
  read() { return { showSeconds: root.querySelector('#x').checked }; },   // -> settings.save(values)
});
```

`settings.save`가 `{ ok: false, message }`를 돌려주면 창이 닫히지 않고 메시지가 표시됩니다.

설정 화면에 스타일이 필요하면 `widget.json`의 `settings.style`에 CSS 파일을 적습니다(엔진이 `<link>`로 넣음, 예: 캘린더의 `settings/panel.css`). 설정 창의 CSP는 인라인 `style` 속성을 막으므로 색 같은 값은 스크립트에서 `element.style.background = ...`로 넣습니다.

**공용 테마 칸 (엔진 API 1.3, #59)**: 테마 호스트(위 4장)를 쓰는 위젯은 테마 목록·설명·배경 불투명도 슬라이더·미리보기·테마 폴더 열기·목록 새로고침을 직접 만들지 않고 엔진 것을 넣을 수 있습니다.

```js
init(root, values, api) {
  this.themes = api.mountThemePicker(root.querySelector('#themes'), { themeId: values.themeId, themeOpacity: values.themeOpacity });
},
read() { return { showSeconds: ... } },   // 저장할 때 엔진이 { themeId, themeOpacity }를 더함
```

- 위젯의 `settings.handlers`에 `host.settingsHandlers()`(`themes`·`previewTheme`·`openThemeFolder`·`liveOpacity`)를 넣어야 합니다.
- 다른 위젯의 테마는 "(다른 위젯 테마)", 규격이 맞지 않는 테마는 "(호환 안 됨)"으로 보이고 고를 수 없습니다. 미리보기의 "이 테마로 바꾸기"를 따라 선택이 바뀌고, 저장하지 않은 슬라이더 값은 창을 닫으면 되돌아갑니다.
- 두레이는 자기 테마 칸을 그대로 씁니다.

## 6. 개발하며 실행하기

```bash
# 저장소의 widgets/ 폴더 전체로 실행 (개발 기본값)
npm start -- --mock-data

# 일반 알림 카드 샘플 두 장(자동 닫힘 하나, 확인할 때까지 남고 소리·버튼 있는 것 하나)을 띄우기
npm start -- --mock-data --sample-card

# 다른 곳의 위젯 소스 폴더를 함께 불러오기 (여러 번 지정 가능, 같은 id면 이쪽이 우선)
npm start -- --widget "C:\path\to\my-widget"

# 설치된 엔진으로 위젯 폴더를 바꿔서 실행
"C:\Program Files\chilgong88\Desk Widgets\Desk Widgets.exe" --widgets-dir "C:\temp\widgets" --user-data-dir "C:\temp\data"
```

위젯 폴더(또는 `--widget` 폴더)의 `widget.json`이 바뀌면 엔진이 위젯을 다시 불러옵니다. 다른 파일만 고쳤다면 위젯 관리 창에서 끄고 켜거나 엔진을 다시 실행하세요.

## 7. 패키지와 설치 파일 만들기

```bash
node tools/widget-kit/build.js widgets/clock --version 1.0.0 --out dist
# -> dist/widgets/clock/                          설치될 패키지
# -> dist/DeskWidgets-ClockWidget-Setup-1.0.0.exe 설치 파일
```

NSIS가 필요합니다(`npm run dist`를 한 번 실행하면 electron-builder가 내려받은 것을 사용, 또는 `MAKENSIS` 환경 변수). 설치 파일은 공통 틀([`tools/widget-kit/installer.nsi`](../tools/widget-kit/installer.nsi))로 만들어지며 다음을 합니다.

- Desk Widgets(모든 사용자용 설치)가 없으면 "먼저 Desk Widgets를 설치하라"고 안내하고 중단
- `C:\Program Files\chilgong88\widgets\<id>\`에 패키지 복사 (`widget.json`은 마지막에 써서 엔진이 반쯤 복사된 위젯을 읽지 않게 함)
- 제어판에 `Desk Widgets-<productName>`, 게시자 chilgong88로 등록
- 로그인한 사용자 권한으로 엔진에 `--widget-installed=<id>` 전달 → 실행 중이면 바로 켜고, 아니면 엔진을 시작. 설정이 필요한 위젯은 설정 창이 열림
- 제거: 패키지 삭제(엔진이 감지해 위젯을 멈춤), 그 위젯 설정 유지/삭제 질문(무인 제거 `/S`는 유지, `/S --delete-app-data`는 삭제)

위젯마다 필요한 설치 단계는 `package.installerHooks` 파일에 `widgetPreInstall` / `widgetPostInstall` / `widgetUninstall` 매크로로 넣습니다(예: 두레이는 이전 앱 Dooray Widget을 제거, [`widgets/dooray/installer/hooks.nsh`](../widgets/dooray/installer/hooks.nsh)).

위젯을 별도 저장소로 옮길 때는 위젯 폴더와 `tools/widget-kit`(엔진 코드에 의존하지 않음)을 함께 가져가면 됩니다.
