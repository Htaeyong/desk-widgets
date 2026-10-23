# 설계: 여러 위젯이 쓰는 테마 호스트 (#56)

> 상태: **구현됨 (2026-10-19)**. 8장의 추천안이 모두 결정되었고(승인 23d2d33), 7장의 단계 1~6이 구현되었습니다: #57 엔진 테마 호스트 cd704a8 · #58 두레이 회귀 테스트 da90da8 · #59 공용 테마 칸 4fb9203 · #60 시계 5fde4cf(+ 테스트 9a39340, fcf43be) · #61 캘린더 59ca3f9 · #62 문서(이 커밋). 단계 7(배포)은 남음.
> 이 문서는 설계 당시의 기록입니다. 지금 규격은 [테마 규격](THEME_SPEC.md)(공통)과 [두레이](THEME_SPEC-dooray.md)·[시계](THEME_SPEC-clock.md)·[캘린더](THEME_SPEC-calendar.md) 규격, 위젯 쪽은 [위젯 만들기](widget-dev.md)가 기준입니다. 구현하며 달라진 점: 캘린더 쓰기는 뒤에서 진행(#63, 결과 `{ ok, queued }`), 캘린더 이벤트에 `reveal`·`open-editor` 추가, 시계 `getState()`는 `{ ok, result }`로 감쌈.
> 기준: 엔진 1.0.1 / 엔진 API 1.2, 두레이 1.0.1, 시계 1.0.0, 캘린더 0.0.1 (커밋 `1b0bfb8`).
> 함께 보는 이슈: **#55** 테마 호스트의 테마별 배경 불투명도(구현 중, 이 문서 작성 때 커밋 전). 이 설계는 #55를 다시 만들지 않고 그 위에 올립니다. 작업 중 코드 기준 이름: theme.json `"background": { "opacity": 0~1 }`(규격 v1.8), 호스트가 넣는 CSS 변수 `--theme-bg-alpha`, 이벤트 `onBackground`, 위젯 저장 키 `themeOpacity: { 테마 id: 0~100 }`(`engine/main/theme-background.js`). #55가 최종으로 정한 이름이 이 문서보다 우선합니다.

목표 한 줄: **시계·캘린더도 두레이처럼** 위젯이 테마에 필요한 기능을 열어 주고, 테마는 격리된 폴더 패키지로 누구나 만들 수 있게 합니다. 두레이 테마(내장·외부)는 한 글자도 고치지 않고 그대로 동작해야 합니다.

---

## 1. 현재 구조 요약

### 1.1 위젯 하나에 묶여 있는 것

| 위치 | 하나뿐인 것 | 근거 |
|---|---|---|
| `engine/main/themes.js` | 테마 폴더 한 쌍(`configure({ builtinDir, userDir })`이 전역 `roots`를 덮어씀), 테마 목록 `registry` 하나, 기본 테마 id `glass` 고정(`DEFAULT_THEME_ID`) | 두 번째 위젯이 `configure`하면 두레이 목록이 바뀜 |
| `themes.js` | 주소 체계 `dooray-theme://<themeId>/…`(`SCHEME`), 세션 `dooray-theme`(`PARTITION`), `setupThemeSession()`이 한 세션에만 프로토콜 처리기 등록 | policies #37 |
| `engine/main/theme-manifest.js` | `contractVersion === 1`만 허용, 창 크기 필드가 `overview`/`project`(두레이의 창 모드) 고정 | `SUPPORTED_CONTRACT`, `DEFAULT_WINDOW` |
| `engine/preload/theme.js` | 테마가 받는 API가 `window.dooray` 고정. 데이터 호출 이름(`getSnapshot`, `categories` …)이 preload에 하드코딩 | |
| `engine/main/theme-host.js` | `DATA_CALLS` 표가 두레이 호출 이름 고정, IPC 채널 `theme:*` 전역 1벌, `theme:open-project`처럼 두레이 개념이 엔진에 있음 | |
| `engine/main/windows.js` | 창 모드 `overview`/`project`, 저장 키 `windowBounds`·`projectWidgets`·`alwaysOnTop`, 기본 레이아웃 `glass`(`boundsKey`) | |
| `engine/main/preview.js` | 미리보기가 항상 `overview` 크기, 설명 문구가 glass 기준(`state().kind`) | |
| `engine/main/main.js` `widgetServices().useThemes` | `--theme <폴더>`(`flags.theme`)가 어느 위젯 테마인지 구분 없이 테마 호스트에 들어감 | |

그래서 시계(#41)와 캘린더(#52)는 테마를 위젯 안(`widgets/<id>/themes.js` + `renderer/themes/<id>.css`, `body[data-theme]`)에 두었고, 미리보기(#43)·불투명도(#53·#54)도 위젯마다 따로 만들었습니다.

### 1.2 이미 일반적인 것 (그대로 재사용)

| 기능 | 위치 | 비고 |
|---|---|---|
| 격리 실행: Node 없음, `sandbox`, `contextIsolation`, 원격 요청 전부 차단, 권한 요청 거부, 다운로드·새 창·`webview`·외부 이동 차단, CSP | `themes.js` `setupThemeSession`, `windows.js` `create` | 세션 단위라 위젯별 세션을 만들면 그대로 적용 |
| 테마 폴더 읽기, 사용자 폴더가 같은 id 내장 테마를 덮음, `extends` 4단계, 폴더 밖 경로 차단 | `themes.js` `scan`·`linkBases`·`serve` | 폴더 쌍만 위젯별로 받으면 됨 |
| 화면 구성(layout)별 창 크기 저장 (#23) | `linkBases`의 `layoutId`, `windows.js` `boundsKey` | 기본 레이아웃 이름만 위젯별로 |
| 창 크기·위치 복원, 화면 밖 보정, `setSize`(v1.7) | `windows.js` | |
| 미리보기 팝업: 실제 테마 실행, 이전/다음/이 테마로 바꾸기, 미리보기 창 안에서 `close`/`setSize` 처리 | `preview.js` | 창 모드·문구만 위젯별 |
| Win+D 고정 대상 목록 | 위젯의 `desktopWindows()` → `widgets.js` | 호스트가 창 목록을 돌려주면 끝 |
| 엔진이 창·컨텍스트 호출은 직접 처리하고 데이터 호출만 위젯에 넘김 | `theme-host.js` `registerIpc` | 이 원칙을 일반화 |
| 위젯 쪽 상태를 메인이 갖고 화면은 그리기만 (시계 타이머·알람 #45·#51, 캘린더 쓰기 #48) | `widgets/clock/index.js`, `widgets/calendar/index.js` | 테마로 옮겨도 그대로. 테마는 화면만 바뀜 |

---

## 2. 목표와 원칙

1. **격리·안전은 그대로.** 모든 위젯 테마는 지금 두레이 테마와 같은 규칙(Node 없음, 네트워크 없음, 페이지 이동·새 창 없음, 권한 거부, 자기 폴더 파일만)으로 실행합니다. 위젯별로 세션을 나눠 한 위젯의 테마가 다른 위젯의 테마 파일·API에 닿지 못하게 합니다.
2. **두레이 테마는 바꾸지 않아도 동작.** `dooray-theme://<id>/` 주소, `window.dooray` API(모든 함수·이벤트), 세션 이름 `dooray-theme`, theme.json 형식(`overview`/`project`)을 유지합니다. 두레이 위젯 코드(`ctx.useThemes({ store, builtinDir, userDir, api })`, engineApi 1.1)도 그대로 둡니다. 외부에서 받은 두레이 테마도 같은 이유로 그대로입니다.
3. **엔진 API는 추가만.** 새 기능은 엔진 API **1.3**으로 더하고, 1.0~1.2 위젯은 바뀐 것 없이 동작합니다(4장 끝 표).
4. **규격은 위젯별, 버전도 위젯별.** 엔진은 "테마를 담는 틀"(격리·창·목록·미리보기·불투명도)만 알고, 테마가 받는 데이터와 호출은 위젯이 정합니다. 시계 규격 v1, 캘린더 규격 v1, 두레이 규격 v1(지금의 THEME_SPEC)은 서로 따로 올라갑니다.
5. **테마는 이름(식별자)만 넘기고, 위젯이 실제 값을 정함.** 테마가 임의의 주소·경로·값을 넘겨 위젯이 그대로 쓰는 호출은 만들지 않습니다(예: 캘린더 링크 열기는 URL이 아니라 일정 id로). 테마가 데이터를 바깥으로 내보낼 통로(네트워크·임의 URL 열기)를 막기 위함입니다.
6. **비밀 값·되돌릴 수 없는 확인은 테마 밖.** 계정·비밀번호·토큰 입력, 삭제 확인 대화상자는 위젯/엔진 화면에만 둡니다(policies "설정 창·분류 관리 창·알림 카드는 앱 자체 화면"과 같은 이유).
7. **타이머·알람·동기화는 메인에.** 테마를 바꾸거나 창이 다시 불러와져도 끊기지 않도록, 지금처럼 상태는 위젯 메인 코드가 갖고 테마는 받아서 그리기만 합니다(#45·#51·#48).

---

## 3. 엔진 설계

### 3.1 큰 그림

```
widget.json "themes" ─┐
ctx.useThemes({...}) ─┴▶ ThemeHost(위젯마다 1개) ─ registry(그 위젯의 테마만)
                                │                 ─ session "widget-theme-<widgetId>" (격리)
                                │                 ─ ThemeWindows(frame별 창) / ThemePreview
                                ▼
                       테마 창 preload: window.widget  ── call(method) ─▶ 위젯이 선언한 methods
                                                       ◀─ on(event) ──── host.emit(event)
두레이(옛 방식 호출) → 같은 ThemeHost의 "legacy dooray" 설정: dooray-theme://, 세션 dooray-theme, window.dooray
```

`theme-host.js`·`themes.js`·`windows.js`·`preview.js`를 **전역 1벌에서 호스트 인스턴스별**로 바꾸는 것이 핵심입니다. 두레이는 같은 코드를 "옛 이름 설정(preset)"으로 씁니다. 코드 경로가 하나라 두레이에서 검증된 동작이 시계·캘린더에도 그대로 갑니다.

### 3.2 테마 목록 (위젯별 registry)

| 항목 | 설계 |
|---|---|
| 내장 테마 | 위젯 패키지 안 `widgets/<id>/themes/<themeId>/` → 설치 후 `C:\Program Files\chilgong88\widgets\<id>\themes\<themeId>\` (두레이와 같은 자리) |
| 사용자 테마 | `%APPDATA%\chilgong88\desk-widgets\widgets\<id>\themes\<themeId>\` (= `ctx.dataDir\themes`, 두레이와 같은 규칙). 같은 id면 사용자 폴더가 우선 |
| 공용 폴더(kit) | 위젯이 `kitDir`을 주면 **모든 테마의 마지막 기반 폴더**로 붙음(테마 → extends 기반들 → kit 순으로 파일 찾기). 메인 코드와 테마가 같이 쓰는 순수 JS(시계 `timer-model.js`·`alarm-model.js`, 캘린더 `model.js`)를 한 벌로 두기 위함. 외부 테마도 `<script src="timer-model.js">`로 바로 사용 |
| 기본 테마 | 위젯이 `defaultTheme`으로 지정(두레이 preset은 `glass`) |
| 테마가 어느 위젯 것인지 | theme.json `widget` 필드(새 테마는 필수). 없으면 `"dooray"`로 봄(기존 두레이 테마 호환). 다른 위젯 폴더에 들어 있으면 "다른 위젯의 테마"로 목록에 표시하고 쓸 수 없음 |
| 규격 버전 | theme.json `contractVersion`을 **그 위젯이 지원하는 버전 목록**(`contractVersions: [1]`)과 비교. 두레이 preset은 `[1]` |
| 개발용 `--theme <폴더>` | theme.json `widget`을 보고 그 위젯의 호스트에만 들어감(없으면 두레이) |

`themes.js`는 `createRegistry({ widgetId, builtinDir, userDir, kitDir, defaultTheme, contractVersions })`가 객체를 돌려주는 모양으로 바꾸고, 모듈 전역 상태(`roots`, `registry`, `devThemeDir`)를 없앱니다.

### 3.3 주소와 세션

| 항목 | 새 위젯 | 두레이 (그대로) |
|---|---|---|
| 주소 | `widget-theme://<themeId>.<widgetId>/<파일>` 예: `widget-theme://analog.clock/index.html` | `dooray-theme://<themeId>/<파일>` |
| 출처(origin) | 테마마다 따로 (지금 두레이와 같음) | 테마마다 따로 |
| 세션(partition) | `widget-theme-<widgetId>` (메모리 전용, 위젯마다 1개) | `dooray-theme` |
| 프로토콜 등록 | `widget-theme`, `dooray-theme` 두 이름을 **앱 시작 전에 한 번** 특권 등록(`registerSchemesAsPrivileged`) → 위젯이 나중에 설치돼도 새 이름이 필요 없음 | 같음 |
| 파일 제공 | 세션마다 처리기 등록: 주소의 `<widgetId>`가 그 세션의 위젯이 아니면 404. 한 위젯의 테마가 다른 위젯 테마 파일을 읽을 수 없음 | 같음 |

`<widgetId>-theme://`처럼 위젯마다 다른 이름을 쓰지 않는 이유: Electron은 특권 주소 이름을 **앱 준비 전에만** 등록할 수 있는데, 위젯은 실행 중에 설치될 수 있습니다(#34). 경로형 `widget-theme://<widgetId>/<themeId>/`는 한 위젯의 모든 테마가 같은 출처가 되어 지금보다 격리가 약해집니다. (8장 질문 1)

### 3.4 위젯이 테마를 쓴다고 알리는 방법

**widget.json** (설치·목록용 정보, 엔진이 위젯을 실행하지 않아도 읽음):

```json
"themes": { "contract": "clock", "contractVersions": [1], "default": "dark-glass" }
```

**ctx.useThemes (엔진 API 1.3 모양)** — 옵션에 `methods`가 있으면 새 방식, 없으면 지금 두레이 방식(legacy preset):

| 옵션 | 뜻 |
|---|---|
| `store` | 호스트가 쓰는 저장 키: `themeId`, 창 크기 `themeBounds`, 항상 위 `alwaysOnTop`, 불투명도 `themeOpacity`(#55). 위젯 설정 파일에 같이 저장 |
| `builtinDir`, `userDir`, `kitDir?`, `defaultTheme` | 3.2 |
| `contractVersions` | 지원하는 테마 규격 버전 목록 |
| `frames` | 창 종류: `{ main: { size, variants? } }`. 두레이 preset은 `overview`(1개)·`project`(여러 개, 인스턴스 id). 시계·캘린더는 `main` 하나 |
| `variant()` | 지금 창 크기 변형 이름(예: 시계 스톱워치·타이머 켬 → `'tools'`). 저장 키와 theme.json 크기에 쓰임 |
| `methods` | 테마가 부를 수 있는 함수 표 `{ 'timer.start': { run(entry, ...args), preview?, gesture? } }` (3.5) |
| `events` | 테마에 보낼 수 있는 이벤트 이름 목록 `['settings', 'timers']` |
| `menuItems?(entry)` | 테마 창 오른쪽 클릭 메뉴의 위젯 항목(엔진 항목은 `ctx.popupMenu`처럼 뒤에 붙음) |
| `onThemeApplied?` | 미리보기에서 "이 테마로 바꾸기"를 눌렀을 때 |

돌려받는 호스트: `open()`, `close()`, `emit(event, payload)`, `focus()`, `desktopWindows()`, `applyTheme(id)`, `reload()`, `setPinned(on)`, `settingsHandlers()`, `setLiveOpacity(themeId, value|null)`(#55에 맞춤).

### 3.5 테마가 받는 API: `window.widget`

엔진 preload 하나(`engine/preload/widget-theme.js`)가 모든 새 위젯 테마에 같은 모양을 줍니다. 위젯이 선언한 이름은 창을 만들 때 `additionalArguments`로 preload에 전달되어, 점으로 나눈 이름이 객체가 됩니다(`'timer.start'` → `widget.api.timer.start()`).

| 이름 | 처리 | 설명 |
|---|---|---|
| `apiVersion` | 엔진 | 이 브리지의 버전 `1` |
| `getContext()` | 엔진 | `{ widget: { id, name }, contract: { name, version }, frame, instanceId, preview, theme: { id, name, version }, locale }` |
| `api.<이름>(...args)` / `call(name, ...args)` | 위젯 | 위젯이 선언한 함수만. 모두 Promise |
| `on(event, callback)` | 위젯 → 테마 | 선언된 이벤트만 구독. 해제 함수 반환 |
| `openSettings()` | 엔진 | 그 위젯 설정 창 (미리보기에서는 무시) |
| `window.close()` | 엔진 | `main`: 위젯 끄기(두레이 overview와 같음) / 추가 창: 그 창만 / 미리보기: 미리보기 닫기 |
| `window.togglePin()`, `window.getState()` | 엔진 | 항상 위 (미리보기에서는 `false`) |
| `window.setSize(w, h)` | 엔진 | 두레이 v1.7과 같은 규칙 |
| `onBackground(callback)` | 엔진 | #55와 같음: 배경 불투명도가 바뀔 때 `{ opacity: 0~1 }`. 대부분의 테마는 CSS 변수 `--theme-bg-alpha`만 쓰면 됨 |
| `window.openMenu()` | 엔진 + 위젯 | 오른쪽 클릭 메뉴: `menuItems` + 설정 / 위젯 관리 / 이 위젯 끄기 / 종료. 끌기 영역의 `system-context-menu`와 DOM `contextmenu`가 겹쳐 두 번 열리는 문제(시계·캘린더가 각자 400ms로 거르던 것)는 엔진이 처리 |

**두레이 호환 shim**: 두레이 preset은 지금의 `engine/preload/theme.js`(`window.dooray`)와 `theme:*` 채널을 그대로 씁니다. 내부에서는 `DATA_CALLS` 표가 "두레이 preset의 methods 표"가 되고, `theme:open-project`는 두레이 preset의 `project` frame 열기로 연결됩니다. 두레이 테마가 보는 것은 바이트 단위로 같습니다.

### 3.6 권한 모델

| 규칙 | 내용 |
|---|---|
| 선언된 것만 | `methods`에 없는 이름은 엔진이 거절(`{ ok: false, message }`), 위젯 코드에 닿지 않음. `events`에 없는 이름은 `emit`해도 보내지 않음 |
| 보낸 창 확인 | IPC 보낸 쪽이 **그 호스트의 테마 창(또는 미리보기)** 인지 엔진이 확인하고, 위젯 함수 첫 인자로 `entry`(`{ frame, instanceId, preview, theme }`) 전달 |
| 인자 | 구조화 복제 가능한 값만, 호출 한 번 64KB 이하(넘으면 거절). 값 검사는 위젯 책임(지금 캘린더 `validateFields`처럼 메인에서) |
| 미리보기 | 함수마다 `preview: 'deny'`(기본, `{ ok: false, message: '미리보기에서는 …' }`) / `'allow'`(읽기 함수) / `'noop'`(조용히 무시, 시계 버튼처럼) |
| 사용자 조작 필요 | `gesture: true`인 함수는 preload가 `navigator.userActivation.isActive`(클릭·키 입력 직후)일 때만 보냄. 테마 코드가 혼자 몰래 부르지 못함. 캘린더 쓰기에 사용 |
| 되돌릴 수 없는 일 | 위젯이 자기 확인 대화상자(`ctx.confirm`)를 띄움. 테마는 건너뛸 수 없음 (캘린더 삭제는 지금도 그렇게 함) |
| 링크 | 엔진 공통 `openUrl`은 없음. 필요한 위젯이 자기 규칙으로 선언(두레이: 내 두레이 주소만, 캘린더: 일정 id로 그 일정의 http(s) 링크만) |

### 3.7 창

| 항목 | 설계 |
|---|---|
| 창 만들기 | 지금 `ThemeWindows.create`와 같음(테두리 없음, 작업 표시줄 없음, 투명·`material`, 격리 webPreferences). preload·partition·주소만 호스트별 |
| 크기 기본값 | theme.json `window.<frame>` (예: `window.main`), 변형은 `window["main+tools"]`. 없으면 위젯이 `frames`에 준 크기 |
| 크기 저장 키 | `<layout>/<frame>[+variant]`, 기본 레이아웃이면 `<layout>/` 생략 (두레이 glass의 `overview` 키와 같은 규칙). 예: 시계 `main`, `main+tools`, `analog/main`, `analog/main+tools` |
| 변형이 바뀔 때 | 위젯이 `host.reload()` 또는 새 `host.applyVariant()`를 부르면 엔진이 지금 크기를 저장하고 새 키의 크기로 바꿈(지금 시계 `applyLayout`이 하는 일, 가운데 기준 유지) |
| Win+D | 호스트의 `desktopWindows()`가 테마 창 목록을 돌려줌. 위젯은 그대로 전달 |
| 항상 위 | 호스트가 `alwaysOnTop` 저장값을 창에 적용(`setAlwaysOnTop`이면 엔진 Win+D 고정이 건드리지 않음, #41과 같음). 위젯 메뉴의 "항상 위에 표시"는 `host.setPinned()` |
| 앞으로 가져오기 | `focus()`가 `beforeFocus`(Win+D 고정 해제)를 먼저 부름. 지금과 같음 |

### 3.8 미리보기와 불투명도 (#55 일반화)

- **미리보기**: `ThemePreview`를 호스트별로 만듦. 미리보기 크기는 그 위젯의 `main` frame(+지금 변형) 크기. 위쪽 바의 설명 문구(`기본 테마` / `기본 구성 · 색만 다름` / `화면 구성이 다른 테마`)는 `glass` 대신 위젯의 기본 테마 기준. 미리보기는 실제 데이터로 실행하고, 저장되는 동작은 3.6의 `preview` 규칙으로 막습니다. 그래서 시계의 자체 미리보기 팝업(#43 `preload/preview.js`, `preview-model.js`)은 없어집니다.
- **불투명도**: #55가 엔진 테마 호스트에 넣는 기능(theme.json의 기본 배경 불투명도, 호스트가 넣는 CSS 변수, 테마별 사용자 값, 미리보기 반영, 저장해야 남음)을 **위젯 구분 없이** 모든 호스트가 씁니다. 이 설계가 더하는 것은 "저장 위치가 그 위젯의 설정 파일(`themeOpacity`)"이라는 점, `window.widget`에도 `onBackground`를 두는 것, 시계·캘린더 값 이전(6장)뿐입니다. 슬라이더를 움직이는 동안의 미리 보기 값(#53의 `liveOpacity`)도 호스트로 옮깁니다.

### 3.9 위젯 설정 창의 테마 칸

지금은 두레이 `settings/panel.js`가 `themes`·`previewTheme`·`openThemeFolder`를 받아 자기 화면을 그리고, 시계·캘린더는 각자 목록·미리보기·불투명도 슬라이더를 그립니다. 세 위젯이 같은 칸을 세 번 만들지 않도록:

- 엔진 설정 창 틀(`widget-settings`)에 **공용 테마 칸**: 목록(호환 안 됨·다른 위젯 테마 표시), 설명·만든 이, 미리보기, 불투명도 슬라이더(#55), 테마 폴더 열기, 목록 새로고침.
- 위젯 `settings/panel.js`는 `api.mountThemePicker(element)` 한 줄로 넣고, 저장할 때 `read()`에 그 값이 포함됨.
- 두레이는 지금 칸을 계속 써도 됨(엔진 API 1.1 위젯). 옮기는 것은 선택.

### 3.10 엔진 API 1.3과 기존 위젯

| 위젯 engineApi | 1.3 엔진에서 |
|---|---|
| 1.0 / 1.1 / 1.2 | 그대로 실행. `useThemes`를 옛 모양으로 부르면 두레이 preset (지금과 같음, 위젯 하나만). 두레이 1.0.2는 `engineApi: "1.1"` |
| 1.3 | #55의 테마 배경 불투명도(`settingsHandlers().liveOpacity`, `host.applyBackground()`)와 함께, `useThemes`의 새 옵션(`methods`, `events`, `frames`, `kitDir`, `contractVersions`), `window.widget`, 공용 테마 칸 사용 가능. 테마 호스트 여러 개 가능. |

엔진 API 1.3은 #55(87f5daf)가 먼저 올렸습니다. 엔진 1.0.1이 아직 배포 전이므로 호스트 일반화도 **같은 1.3**에 넣습니다(1.4로 올리지 않음).

- 1.2 엔진에 1.3 위젯(새 시계·캘린더)을 설치하면 위젯 관리 창에 "호환 안 됨 — 엔진을 업데이트하세요"가 나옴(#34 규칙). 그래서 **엔진을 먼저 배포**합니다.
- 옛 방식 호스트는 지금처럼 하나만(두 번째 옛 방식 호출은 오류). 새 방식은 위젯마다 하나.
- 문서: `docs/widget-dev.md` 4장 표의 `useThemes` 줄을 1.3 모양으로, policies #37 줄은 새 결정으로 갱신.

---

## 4. 시계 테마 규격 초안 (clock v1)

### 4.1 무엇이 어디에

| 메인(위젯 `index.js`)에 남음 | 테마(화면) |
|---|---|
| 설정 저장(`showSeconds`, `hour12`, `tools`, `lastTab`, 항상 위) | 시각 그리기(디지털·아날로그 모양, 글꼴, 애니메이션) |
| 스톱워치·타이머 상태(시작 시각 + 쌓인 시간, #45), 타이머 종료 `setTimeout`, 종료 알림 카드(#44) | 스톱워치·타이머·알람 탭과 버튼 화면 |
| 알람 목록·다음 울림 계산·놓친 알람 카드(#51) | 알람 추가·편집 입력 화면 |
| 오른쪽 클릭 메뉴 항목(항상 위, 스톱워치·타이머 사용, 테마) | 메뉴를 열 시점(`window.openMenu()`) |

### 4.2 다시 그리기는 테마가

- 엔진·위젯은 **1초마다 IPC를 보내지 않습니다.** 테마가 자기 `Date.now()`로 다음 초 경계에 맞춘 `setTimeout`(초 표시 안 하면 분 경계), 스톱워치는 돌고 보일 때만 `requestAnimationFrame`(지금 #45 방식). 같은 PC의 같은 시계를 쓰므로 어긋나지 않습니다.
- 스톱워치·타이머의 남은 시간은 `timer-model.js`(kit)로 상태에서 계산합니다. 상태가 바뀔 때만 `timers` 이벤트가 옵니다.

### 4.3 데이터

`api.getState()` → 아래 두 묶음을 한 번에. 이후 바뀌면 이벤트로.

| 이벤트 | 내용 |
|---|---|
| `settings` | `{ showSeconds, hour12, locale, tools, lastTab, alwaysOnTop }` |
| `timers` | `{ stopwatch: { startedAt, elapsed }, timer: { duration, startedAt, elapsed, done }, timerSeconds, timerPresets: [초 ×3], alarms: [{ id, hour, minute, name, days, on, snoozeUntil, next }] }` (`next`: 다음 울림 시각, 화면 표시용) |

불투명도는 #55의 CSS 변수 `--theme-bg-alpha`로 들어오므로 시계 규격에는 없습니다.

### 4.4 호출

| 함수 | 지금의 대응 (`timerAction`/`alarmAction`) | 미리보기 |
|---|---|---|
| `getState()` | `clock:get` + `clock:timers-get` | allow |
| `stopwatch.start()` / `pause()` / `reset()` | `sw-start` / `sw-pause` / `sw-reset` | noop |
| `timer.start()` / `pause()` / `reset()` | `tm-start` / `tm-pause` / `tm-reset` | noop |
| `timer.set(seconds)` | `tm-set` | noop |
| `timer.usePreset(slot)` / `timer.savePreset(slot, seconds)` | `tm-preset` / `tm-save-preset` | noop |
| `alarms.add({ hour, minute, name, days })` → `{ ok, id }` | `add` (최대 20개) | deny |
| `alarms.edit(id, { hour, minute, name, days })` / `alarms.remove(id)` / `alarms.toggle(id, on)` | `edit` / `delete` / `toggle` | deny |
| `setTab(tab)` | `tab` (`clock`·`stopwatch`·`timer`·`alarm`) | noop |

모두 `{ ok: true, result? }` 또는 `{ ok: false, message }`(두레이 `categories`와 같은 모양). 값 범위 검사는 지금처럼 메인의 `TM`/`AM` sanitize.

### 4.5 theme.json (시계)

| 필드 | 뜻 |
|---|---|
| `widget: "clock"`, `contractVersion: 1` | 필수 |
| `window.main`, `window["main+tools"]` | 기본·최소 크기 (지금 `SIZES`의 digital/analog 값이 각 내장 테마 기본값) |
| `features: ["tools"]` | 스톱워치·타이머·알람 탭을 그리는 테마. 없으면 설정의 "스톱워치·타이머 사용"을 그 테마에서 끈 것으로 보이고(설정 칸에 안내), 타이머·알람은 메인에서 계속 동작 |
| `background.opacity` (#55) | 기본 배경 불투명도 0~1 (지금 `themes.js`의 `opacity` % ÷ 100: dark-glass 0.78, light 0.88, minimal 0, neon 0.9, analog 0.85) |

---

## 5. 캘린더 테마 규격 초안 (calendar v1)

### 5.1 테마 밖에 남는 것 (안전)

| 위젯/엔진 화면 | 이유 |
|---|---|
| 설정 창: CalDAV 계정·앱 전용 비밀번호·ICS 주소·새로고침 주기·캘린더 켜기/끄기 | 비밀 값. 테마는 계정 주소·사용자 이름·비밀번호를 받지 않음 |
| 삭제 확인 대화상자(`ctx.confirm`) | 되돌릴 수 없고 서버에서도 지워짐 |
| 쓰기 검사·조건부 쓰기·다시 읽어 확인(`validateFields`, `writer.js`, `editable.js`) | #48 규칙. 테마는 결과만 받음 |
| 링크 열기 규칙 | 테마는 URL이 아니라 일정 id를 넘김 → 위젯이 그 일정의 http(s) 링크만 엶 |

### 5.2 데이터

| 이벤트 / 함수 | 내용 |
|---|---|
| `getState()`, 이벤트 `changed` | `{ weekStart, upcomingDays, locale, sources: [{ id, name, color, enabled }], calendars: [{ sourceId, calendarId, name, color }](새 일정을 만들 수 있는 곳), lastCalendar, lastUpdated, refreshing, errorCount, pending: [uid], unconfirmed: { uid: 문구 } }` (지금 `view()`에서 `themeId`·`layout`·`opacity` 뺀 것) |
| `events.list([{ from, to }, …])` → 범위마다 일정 배열 | 지금 `calendar:events`(grid·upcoming 두 범위)를 범위 배열로 일반화, 최대 4개, 범위당 길이 상한은 지금 `MAX_RANGE_MS`. CalDAV 계정은 이 범위로 받는 기간을 넓힘(#47) |

**정규화된 일정** (#49 모양 + 화면용):
`{ uid, sourceId, calendarId, title, start, end, allDay, location, description, recurrenceId, color, sourceName, readOnly, readOnlyReason, hasUrl }`
— 종일은 `YYYY-MM-DD`(끝 미포함), 시간 일정은 UTC ISO. `url`은 주지 않고 `hasUrl`만(원칙 5). `readOnlyReason`은 한국어 문장(예: "반복 일정은 여기서 바꿀 수 없습니다…").

**탐색·선택은 테마 것**: 보고 있는 달, 고른 날짜·일정은 테마가 들고, 그 범위의 일정을 `events.list`로 요청합니다. 위젯은 저장하지 않습니다(지금도 저장 안 함).

### 5.3 호출

| 함수 | 결과 | 미리보기 | 사용자 조작 |
|---|---|---|---|
| `refresh()` | 지금 다시 받기 | allow | |
| `events.create({ sourceId, calendarId }, fields)` | `{ ok, applied, uid, message }` | deny | 필요 |
| `events.update({ sourceId, calendarId, uid }, fields)` | 같음. 바꾼 항목만 서버 문서에 병합(#48) | deny | 필요 |
| `events.remove({ sourceId, calendarId, uid })` | 위젯이 확인 대화상자 → `{ ok, cancelled? }` | deny | 필요 |
| `events.openLink({ sourceId, calendarId, uid })` | 그 일정의 http(s) 링크를 브라우저로, `true/false` | deny | 필요 |
| `openSettings()` (엔진 공통) | 오류 자세히·계정 관리는 설정 창에서 | | |

`fields` = `{ title, allDay, start, end, location, description }` (지금 `event-fields.js`). 오류는 `{ ok: false, message }` 한국어 문장 그대로 보여 주면 됨. 저장 중 표시는 `pending`, 반영 확인 안 됨은 `unconfirmed`로 옵니다.

### 5.4 theme.json (캘린더)

`widget: "calendar"`, `contractVersion: 1`, `window.main`(기본: compact 300×460, 큰 달력 800×640), `features: ["edit"]`(일정 편집 화면을 가진 테마. 없으면 읽기 전용 테마로 표시), `background.opacity`(#55, default 0.8 · big 0.84).

---

## 6. 기존 내장 테마 이전

### 6.1 시계 5종

| 테마 | 패키지 | 내용 |
|---|---|---|
| `dark-glass` (기본) | 전체 페이지 | 지금 `clock.html`·`clock.js`·`clock.css`·`tools.js` + `themes/dark-glass.css` 변수. 디지털 레이아웃. kit(`timer-model.js`·`alarm-model.js`)는 `kitDir`로 |
| `light`, `minimal`, `neon` | `extends: "dark-glass"` + `style.css` | 지금 `renderer/themes/<id>.css`의 변수만. 크기는 dark-glass와 공유(지금 digital 키와 같음) |
| `analog` | `extends: "dark-glass"` + 자기 `index.html` | `body data-layout="analog"`로 같은 `clock.js`를 씀. 자기 entry가 있어 레이아웃이 따로 → 창 크기 따로(지금과 같음) |

### 6.2 캘린더 2종

| 테마 | 패키지 | 내용 |
|---|---|---|
| `default` (기본) | 전체 페이지 | 지금 `calendar.html`·`calendar.js`·`calendar.css`(자세히·편집·그날 일정 창 포함) + `default.css`. `model.js`는 kit |
| `big` (큰 달력) | `extends: "default"` + 자기 `index.html` + `style.css` | `data-layout="month"`, `weekLayout` 사용. 자기 entry → 창 크기 따로 |

캘린더 자세히·편집 창은 테마 안 겹침 창으로 남습니다(지금 0.98 불투명 규칙 그대로, #54).

### 6.3 설정 이전 (위젯 store `upgrade`에서 1회)

| 지금 값 | 새 값 |
|---|---|
| `themeId` | 그대로 (id를 바꾸지 않음) |
| `opacity: { 테마 id: 0~100 }` (#53·#54) | `themeOpacity`(#55)로 같은 값 복사. 테마 CSS의 `--card-alpha`는 `--theme-bg-alpha`를 쓰도록 바꿈(배경색 `--card-rgb`는 그대로) |
| 시계 `windowBounds.digital` / `digital+tools` / `analog` / `analog+tools` | `themeBounds.main` / `main+tools` / `analog/main` / `analog/main+tools` |
| 캘린더 `windowBounds.compact` / `month` | `themeBounds.main` / `big/main` |
| `alwaysOnTop`, 타이머·알람·소스·계정 | 그대로 |

옛 키는 지우지 않고 남겨 위젯을 이전 버전으로 되돌려도 설정이 살아 있게 합니다.

### 6.4 사용자가 보는 것

- 업데이트 후 같은 테마, 같은 위치·크기, 같은 불투명도로 뜹니다. 타이머·알람·일정은 끊기지 않습니다(메인 상태).
- 설정 창 테마 칸이 두레이와 같은 모양(목록 · 미리보기 · 테마 폴더 열기)으로 바뀝니다.
- 시계 미리보기는 엔진 미리보기 창으로 바뀝니다(이전·다음·이 테마로 바꾸기, 스톱워치 버튼은 눌러도 동작 안 함 — 지금과 같음).
- 새로 생기는 것: "테마 폴더 열기"로 받은 시계·캘린더 테마를 넣어 쓸 수 있음.
- 엔진을 먼저 업데이트하지 않으면 새 시계·캘린더가 "호환 안 됨"으로 보입니다(배포 안내에 순서 명시).

---

## 7. 단계와 이슈 나누기

| # | 이슈 (가칭) | 범위 | 위험 | 크기 | 순서·병렬 |
|---|---|---|---|---|---|
| 1 (#57) | 엔진: 테마 호스트 위젯별로 (엔진 API 1.3) | `themes.js`(registry 객체, kit, `widget` 필드), `theme-manifest.js`(위젯별 규격 버전·frame·features), `theme-host.js`(인스턴스별 IPC 라우팅, methods/events 허용 목록, gesture·preview 규칙), `windows.js`(frame·variant·저장 키), `preview.js`(위젯별), 새 preload `widget-theme.js`, `main.js`(두 주소 이름 등록, `--theme` 배분), 두레이 preset | 높음: 두레이 테마 회귀 | L | **#55가 끝난 뒤** (같은 파일). 다른 단계의 선행 |
| 2 (#58) | 두레이 회귀 확인 | 기존 엔진 테스트 + 두레이 내장 10종을 새 호스트로 띄우는 자동 테스트, 사용자 설치 확인 | 중간 | S | 1 직후 |
| 3 (#59) | 엔진: 공용 테마 칸 (설정 창) | `widget-settings`에 테마 목록·미리보기·불투명도·폴더 열기 | 낮음 | M | 1 뒤, 4·5와 병렬 가능(엔진 renderer만) |
| 4 (#60) | 시계: 테마 규격 v1 + 내장 5종 이전 | `widgets/clock/themes/*`, `index.js`를 `useThemes`로, 자체 미리보기 제거, 설정 이전, engineApi 1.3 | 중간: 타이머·알람 회귀 | M~L | 1 뒤. 5와 병렬(다른 폴더) |
| 5 (#61) | 캘린더: 테마 규격 v1 + 내장 2종 이전 | `widgets/calendar/themes/*`, `events.*` 호출, 링크를 uid로, 설정 이전, engineApi 1.3, **목업 데이터**(`--mock-data`용 샘플 일정, 지금 없음) | 중간: 쓰기 경로 | L | 1 뒤. 4와 병렬 |
| 6 (#62) | 문서 | `THEME_SPEC.md`를 공통(격리·theme.json 공통 필드·window.widget) + 위젯별(두레이·시계·캘린더) 규격으로 나눔, `theme-guide.md` 위젯별 예제, `widget-dev.md` 1.3, policies·changelog | 낮음 | M | 각 단계와 같은 커밋 + 마지막 정리 |
| 7 | 배포 | 엔진 → 시계·캘린더 순서. 버전은 사용자에게 먼저 확인 | | S | 마지막 |

### 쓸 테스트

- `theme-manifest`: `widget` 필드(없으면 dooray), 위젯별 `contractVersions`, `window.main`·`main+tools`, `features` 무시 규칙.
- registry: 두 위젯 registry가 서로의 테마를 보지 않음, 사용자 폴더 우선, kit가 마지막 기반, 다른 위젯 테마 표시.
- 주소: `<themeId>.<widgetId>` 해석, 다른 위젯 세션에서 404, 폴더 밖 경로 404 (지금 `serve` 테스트를 위젯별로).
- 호출 라우팅: 선언 안 된 함수 거절, 이벤트 필터, 64KB 상한, 미리보기 `deny`/`noop`/`allow`, 테마 창이 아닌 보낸 쪽 거절.
- 창 저장 키: 기본 레이아웃 생략 규칙, 변형 키, 두레이 키(`overview`, `board/overview`)가 지금과 똑같음.
- 설정 이전: 시계·캘린더 `upgrade` 전후 표, 옛 키 유지.
- 두레이: 지금의 엔진 테스트 전부 그대로 통과 + `window.dooray` 이름 목록 스냅샷 테스트.
- 패키지: `engine/test/widget-assets.test.js`를 시계·캘린더 테마(+kit)까지.
- gesture는 preload 안 검사라 단위 테스트가 어려움 → preload의 "보낼지 판단" 함수를 순수 함수로 빼서 테스트.

### 데스크톱 자동 조작 없이 확인하는 방법

- 위 단위 테스트(`npm test`)가 규칙 대부분을 덮습니다.
- 사용자 확인 목록(이슈에 남김): 엔진·위젯 설치 후 ① 두레이 테마 10종 전환·미리보기·프로젝트 분리 창 ② 시계 5종 전환, 스톱워치·타이머·알람이 테마를 바꿔도 이어짐, Win+D·항상 위 ③ 캘린더 2종, 일정 만들기·고치기·지우기(확인 창), 반영 확인 안 됨 표시 ④ 불투명도 값이 업데이트 전과 같음 ⑤ 받은 테마 폴더를 넣고 목록 새로고침.
- 개발 중 확인은 `npm start -- --mock-data --theme <폴더>`(테마의 `widget`으로 위젯 선택).

---

## 8. 결정이 필요한 질문

| # | 질문 | 선택지 | 추천 | 결정 |
|---|---|---|---|---|
| 1 | 새 테마 주소 모양 | ① `widget-theme://<themeId>.<widgetId>/` ② `widget-theme://<widgetId>/<themeId>/` ③ 위젯마다 `<widgetId>-theme://` | **①**: 테마마다 출처가 따로(지금 두레이와 같은 격리), 실행 중 설치된 위젯도 됨. ②는 한 위젯 테마끼리 출처 공유, ③은 실행 중 설치 위젯에서 불가 | **추천안 채택** (2026-10-19, 사용자 승인) |
| 2 | 테마가 받는 API 이름 | ① `window.widget` 하나(모든 위젯 같은 모양) ② 위젯마다 `window.clock`, `window.calendar` | **①**: 엔진 preload 하나, 문서 하나. 위젯 고유 부분은 `widget.api.*` | **추천안 채택** (2026-10-19, 사용자 승인) |
| 3 | 외부(사용자가 받은) 테마를 시계·캘린더에서 처음부터 허용 | ① 둘 다 허용 ② 시계만 ③ 내장만, 나중에 | **①**: 격리가 같고, 캘린더 쓰기는 사용자 조작·확인 창·uid 링크로 막음 | **추천안 채택** (2026-10-19, 사용자 승인) |
| 4 | 외부 캘린더 테마의 일정 쓰기 | ① 사용자 조작이 있을 때 허용(+삭제는 확인 창) ② 내장 테마만 쓰기 ③ 테마는 위젯 소유 편집 창만 열 수 있음 | **①**. ③은 안전하지만 "테마가 편집 화면도 꾸민다"는 목표와 맞지 않음 | **추천안 채택** (2026-10-19, 사용자 승인) |
| 5 | 두레이도 `window.widget`을 받게 할지 | ① 지금은 아니오(옛 방식 유지) ② `window.dooray`와 함께 제공 | **①**: 두레이 테마에 필요 없음. 원하면 나중에 추가만 하면 됨 | **추천안 채택** (2026-10-19, 사용자 승인) |
| 6 | 테마 선택 칸을 엔진 공용으로 | ① 엔진 공용 칸(시계·캘린더부터) ② 위젯마다 계속 | **①**: 세 번 만들 것을 한 번 | **추천안 채택** (2026-10-19, 사용자 승인) |
| 7 | 테마 설치 방법 | ① 지금처럼 폴더 넣기 + 새로고침 ② zip 가져오기 버튼 추가 | **①** 먼저, ②는 별도 이슈 | **추천안 채택** (2026-10-19, 사용자 승인) |
| 8 | 버전 | 엔진 API 1.2 → **1.3**은 규칙상 정해짐. 엔진 제품 버전(1.0.1 → ?)과 시계·캘린더 위젯 버전은 | 배포 때 사용자에게 확인 (임의로 올리지 않음) | **추천안 채택** (2026-10-19, 사용자 승인) |
