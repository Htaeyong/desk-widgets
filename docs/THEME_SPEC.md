# 테마 규격

Desk Widgets의 위젯 중 **두레이 대시보드**, **시계**, **캘린더**, **메일**, **시스템 모니터**, **할 일**은 화면을 **테마 폴더**로 통째로 바꿀 수 있습니다. 테마는 이 문서와 위젯별 규격만 지키면 누구나 만들 수 있고, 폴더를 넣기만 하면 적용됩니다. 시작하는 방법은 [테마 만들기](theme-guide.md)를 보세요.

이 문서는 **모든 위젯 테마에 공통인 규칙**입니다. 위젯이 테마에 주는 데이터와 호출은 위젯별 규격에 있습니다.

| 위젯 | 규격 | 테마가 받는 API | 주소 |
|---|---|---|---|
| 두레이 대시보드 | [두레이 테마 규격 v1](THEME_SPEC-dooray.md) (v1.8) | `window.dooray` | `dooray-theme://<테마 id>/` |
| 시계 | [시계 테마 규격 v1](THEME_SPEC-clock.md) | `window.widget` | `widget-theme://<테마 id>.clock/` |
| 캘린더 | [캘린더 테마 규격 v1](THEME_SPEC-calendar.md) | `window.widget` | `widget-theme://<테마 id>.calendar/` |
| 메일 | [메일 테마 규격 v1](THEME_SPEC-mail.md) | `window.widget` | `widget-theme://<테마 id>.mail/` |
| 시스템 모니터 | [시스템 모니터 테마 규격 v1](THEME_SPEC-system-monitor.md) | `window.widget` | `widget-theme://<테마 id>.system-monitor/` |
| 할 일 | [할 일 테마 규격 v1](THEME_SPEC-todo.md) | `window.widget` | `widget-theme://<테마 id>.todo/` |

```
┌──────── 위젯 (Electron main) ────────┐          ┌──────── 테마 (격리된 창) ────────┐
│ 데이터·계정·타이머·쓰기 규칙           │──이벤트──▶│ window.widget.on('…', …)         │
│ 비밀 값은 여기에만                    │◀──호출────│ window.widget.api.…(…)           │
└───────────────────────────────────────┘          └──────────────────────────────────┘
            ▲ 엔진: 테마 목록·창·Win+D·항상 위·미리보기·배경 불투명도·격리
```

- 테마 창·격리·미리보기·배경 불투명도는 **엔진**(테마 호스트, 위젯마다 하나)이 맡고, 데이터와 동작은 **위젯**이 정합니다.
- 테마는 위젯이 **열어 둔 호출과 이벤트만** 쓸 수 있습니다. 계정·비밀번호·토큰 같은 비밀 값은 테마에 오지 않습니다.
- 설계와 결정 이유: [theme-host-design.md](theme-host-design.md)

---

## 1. 테마 폴더

```
my-theme/
├─ theme.json      (필수) 테마 정보
├─ index.html      (필수, 이름은 theme.json의 entry로 변경 가능. extends로 기반 테마의 것을 써도 됨)
├─ style.css
├─ app.js
└─ (이미지, 폰트 등 자유)
```

### 설치 위치

| 위치 | 용도 |
|---|---|
| `C:\Program Files\chilgong88\widgets\<위젯 id>\themes\<테마 id>\` | 내장 테마 (위젯과 함께 설치) |
| `%APPDATA%\chilgong88\desk-widgets\widgets\<위젯 id>\themes\<테마 id>\` | 사용자가 받은 테마. 그 위젯의 설정 → 테마 칸 → **테마 폴더 열기**로 이동 |

위젯 id: 두레이 `dooray`, 시계 `clock`, 캘린더 `calendar`, 메일 `mail`, 시스템 모니터 `system-monitor`, 할 일 `todo`. 폴더를 넣고 **목록 새로고침**을 누른 뒤 고르면 적용됩니다. 같은 id면 사용자 폴더가 우선입니다. 다른 위젯의 테마는 목록에 "(다른 위젯 테마)", 규격 버전이 맞지 않는 테마는 "(호환 안 됨)"으로 보이고 고를 수 없습니다.

---

## 2. theme.json 공통 필드

```json
{
  "id": "my-theme",
  "name": "내 테마",
  "version": "1.0.0",
  "author": "홍길동",
  "description": "한 줄 설명",
  "widget": "clock",
  "contractVersion": 1,
  "entry": "index.html",
  "extends": "dark-glass",
  "features": ["tools"],
  "background": { "opacity": 0.8 },
  "window": { "transparent": true, "material": "none", "main": { "width": 220, "height": 96, "minWidth": 140, "minHeight": 64 } }
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `id` | O | 소문자·숫자·`-`만(64자까지). **폴더 이름과 같아야 함** |
| `name`, `version` | O | 설정 창에 표시 |
| `author`, `description` | | 설정 창·미리보기에 표시 |
| `widget` | 두레이 외 위젯은 O | 이 테마가 쓰이는 위젯 id. **없으면 두레이 테마**로 봄(그래서 기존 두레이 테마는 고칠 필요 없음) |
| `contractVersion` | O | 그 위젯 규격의 버전. 현재 위젯별 규격 버전은 모두 `1`. 위젯이 지원하지 않는 버전이면 "호환 안 됨" |
| `entry` | | 시작 HTML(테마 폴더 안의 상대 경로). 기본 `index.html` |
| `extends` | | 다른 테마의 id. 이 테마 폴더에 없는 파일을 그 테마에서 가져옴(최대 4단계, 3장) |
| `features` | | 위젯 규격의 선택 부분 중 이 테마가 그리는 것(예: 시계 `tools`, 캘린더 `edit`). 위젯별 규격 참고 |
| `background.opacity` | | 배경 불투명도 기본값 0~1. 넣으면 설정 창에 슬라이더가 생김(4장) |
| `window.transparent` | | 투명 창 여부. 기본 `true` |
| `window.material` | | Windows 11 배경 효과: `acrylic`, `mica`, `none`. 기본 `none` |
| `window.<창>` | | 창 기본·최소 크기 `{ width, height, minWidth, minHeight }`(32 ~ 4000). 창 이름은 위젯마다 다름: 두레이 `overview`·`project`, 시계·캘린더 `main`. 시계는 크기 변형 `main+tools`도 있음. 없으면 위젯이 정한 크기 |

- 모르는 필드는 무시됩니다. 값이 잘못된 선택 필드(예: `background`가 0~1이 아님, 모르는 `material`)는 없는 것으로 보고 테마는 그대로 쓸 수 있습니다.
- 필수 필드가 없거나 `id`가 폴더 이름과 다르면 그 테마는 쓸 수 없고 설정 창에 이유가 보입니다.

---

## 3. 이어받기(extends)와 공용 파일(kit)

테마가 파일을 요청하면 엔진은 다음 순서로 찾습니다.

1. 그 테마 폴더
2. `extends`로 이어받은 테마 폴더들(가까운 것부터, 최대 4단계)
3. 위젯의 **공용 파일 폴더(kit)** — 시계 `timer-model.js`·`alarm-model.js`, 캘린더 `model.js`, 메일 `mail-model.js`(두레이는 kit 대신 glass의 `kit.js`를 `extends`로 씀)

- 그래서 **색만 바꾼 테마**는 `theme.json` + `style.css` 두 파일이면 됩니다. 기반 테마의 `index.html`이 `style.css`를 불러오고, 내 `style.css`가 그 자리를 대신합니다.
- 기반 테마가 없거나, 쓸 수 없거나, 고리처럼 돌거나 4단계를 넘으면 이 테마도 쓸 수 없습니다.
- **창 크기는 화면 구성별로 기억**합니다. 시작 HTML(`entry`)을 가진 테마가 그 테마의 "화면 구성"이고, 색만 바꾼 테마는 기반 테마와 창 위치·크기를 함께 씁니다. 자기 `index.html`이 있는 테마(예: 시계 `analog`, 캘린더 `big`, 두레이 `board`)는 따로 기억합니다.
- kit 파일은 위젯이 정하고 위젯 메인 코드와 같은 계산을 하므로, 직접 계산하지 말고 불러 쓰는 것을 권합니다. 테마 폴더에 같은 이름의 파일이 있으면 그것이 우선입니다.

---

## 4. 배경 불투명도

바탕화면이 얼마나 비칠지는 배경화면·취향마다 달라서 사용자가 **테마마다** 정합니다(설정 창 테마 칸의 슬라이더 0~100%). 창 전체 투명도는 글자까지 흐려지므로 쓰지 않고, **테마의 배경만** 이 값을 따릅니다. (두레이 규격 v1.8에서 시작, 모든 위젯 테마에 같음)

1. `theme.json`에 기본값: `"background": { "opacity": 0.82 }` (0~1). 이 필드가 있는 테마만 슬라이더가 생깁니다.
2. 엔진이 테마 페이지 루트(`<html>`)에 CSS 변수 **`--theme-bg-alpha`**(0~1)를 넣어 줍니다. 사용자가 고른 값, 없으면 기본값입니다. 엔진이 직접 넣는 스타일이라 테마의 CSP·코드와 관계없고, 다시 불러와도 다시 들어갑니다.
3. 테마는 **배경색에만** 이 변수를 쓰고 기본값을 대체값으로 둡니다.

```css
:root {
  --bg-alpha: var(--theme-bg-alpha, 0.82);        /* theme.json과 같은 기본값 */
  --card-bg: rgba(22, 23, 28, var(--bg-alpha));    /* 색은 rgb, 불투명도는 변수 */
}
.card { background: var(--card-bg); }
```

- 글자·버튼·카드, 그리고 **메뉴·팝업·편집 창**은 이 값을 따르지 말고 읽을 수 있게 불투명하게 둡니다.
- 슬라이더를 움직이는 동안(저장 전)에도 바로 바뀌고, 미리보기는 테마마다 사용자가 정한 값으로 보입니다.
- 스크립트로 반응하려면 `getContext().background.opacity`와 `onBackground(callback)`을 씁니다(두 API 모두에 있음). CSS 변수만 쓰면 필요 없습니다.
- `background`가 없는 테마에는 엔진이 아무것도 넣지 않습니다(`getContext().background`는 `null`).

---

## 5. 격리와 보안 (엔진이 강제)

테마는 다른 사람이 만든 코드일 수 있으므로 격리된 환경에서 실행됩니다.

- Node.js·Electron API 없음. 테마가 받는 것은 `window.dooray`(두레이) 또는 `window.widget`(시계·캘린더·메일·시스템 모니터·할 일) 하나뿐
- **외부 네트워크 요청 차단**: `fetch`, 외부 이미지·폰트·스크립트(CDN) 모두. 필요한 파일은 테마 폴더에 포함
- 페이지 이동, 새 창(`window.open`), `<webview>`, 다운로드 차단. 카메라·알림 등 권한 요청은 모두 거부
- 테마 파일은 그 테마의 주소(`dooray-theme://<id>/`, `widget-theme://<id>.<위젯>/`)로만 제공되고, 테마·기반 테마·kit 폴더 밖 파일은 읽을 수 없음
- **위젯마다 세션이 따로**: 시계 테마는 캘린더·두레이 테마 파일이나 API에 닿지 못함
- 문서 기본 보안 정책(CSP): 스크립트·스타일·이미지·폰트는 자기 출처만(이미지·폰트는 `data:`도), 인라인 스크립트 불가, 인라인 스타일 가능
- 링크 열기는 위젯이 정한 규칙으로만: 두레이는 사용자의 두레이 주소만, 캘린더는 일정 id로 그 일정의 http(s) 링크만, 시계는 없음
- 데이터(제목·이름 등 다른 사람이 입력한 값)는 **`textContent`로** 넣고 `innerHTML`에 넣지 마세요

---

## 6. `window.widget` (위젯 공통)

두레이를 뺀 위젯의 테마는 모두 같은 모양의 `window.widget`을 받습니다. `api` 아래의 이름과 이벤트는 위젯이 정하고([시계](THEME_SPEC-clock.md), [캘린더](THEME_SPEC-calendar.md), [메일](THEME_SPEC-mail.md), [시스템 모니터](THEME_SPEC-system-monitor.md), [할 일](THEME_SPEC-todo.md)), 나머지는 엔진이 처리합니다. 모든 호출은 Promise입니다.

```ts
interface WidgetThemeApi {
  apiVersion: 1;
  getContext(): Promise<{
    widget: { id: string; name: string };             // 예: { id: 'clock', name: '시계' }
    contract: { name: string; version: number };      // 위젯 규격 이름과 이 테마의 contractVersion
    frame: string;                                    // 창 이름: 'main'
    instanceId: string | null;
    preview: boolean;                                 // 설정 창의 미리보기에서 실행 중
    theme: { id: string; name: string; version: string };
    background: { opacity: number } | null;           // 4장
    locale: string;
  }>;
  api: { /* 위젯이 연 호출: api.timer.start(), api.events.list(...) … */ };
  call(name: string, ...args: any[]): Promise<any>;   // api.<name>(...)과 같음: call('timer.start')
  on(event: string, callback: (payload: any) => void): () => void;   // 위젯이 연 이벤트만, 해제 함수 반환
  onBackground(callback: (b: { opacity: number }) => void): () => void;
  openSettings(): Promise<void>;                      // 그 위젯의 설정 창 (미리보기에서는 무시)
  window: {
    close(): Promise<void>;                           // 위젯 끄기 (미리보기에서는 미리보기 닫기)
    togglePin(): Promise<boolean>;                    // 항상 위 토글, 바뀐 상태 (미리보기에서는 false)
    getState(): Promise<{ pinned: boolean }>;
    setSize(width: number, height: number): Promise<{ width: number; height: number }>;
    openMenu(): Promise<boolean>;                     // 오른쪽 클릭 메뉴 (위젯 항목 + 설정·위젯 관리·끄기·종료)
  };
}
```

엔진이 위젯에 넘기기 전에 확인하는 것:

| 규칙 | 내용 |
|---|---|
| 연 것만 | 위젯이 열지 않은 이름은 `{ ok: false, message: '지원하지 않는 호출입니다: …' }`. 열지 않은 이벤트에 `on()`하면 오류 |
| 크기 | 한 번에 보내는 값은 64KB까지(넘으면 `{ ok: false, message }`) |
| 미리보기 | 호출마다 위젯이 정함: 실행(읽기), 아무 일 없이 `null`(버튼 누르기 등), 거절 `{ ok: false, message: '미리보기에서는 쓸 수 없습니다.' }`(저장되는 변경) |
| 사용자 조작 | 위젯이 "클릭·키 입력 필요"로 정한 호출(캘린더 일정 쓰기 등)은 **클릭이나 키 입력 직후**에만 보내지고, 아니면 `{ ok: false, message: '클릭이나 키 입력으로만 할 수 있습니다.' }`. 버튼 `click` 처리기에서 바로 부르면 됩니다(타이머·`await` 뒤 몇 초 지나면 거절될 수 있음) |
| 오류 | 위젯 함수의 오류는 `{ ok: false, message }`로 옵니다 |

- 값은 위젯이 다시 검사합니다. 테마가 보낸 값이 그대로 쓰인다고 가정하지 마세요.
- `on()`으로 받는 값과 호출 결과는 구조화 복제된 사본입니다.

---

## 7. 창

- 테마 창은 테두리가 없습니다. 끌어서 옮길 영역에 CSS `-webkit-app-region: drag;`, 그 안의 버튼·입력에는 `-webkit-app-region: no-drag;`를 주세요.
- 끌기 영역의 오른쪽 클릭은 엔진이 위젯 메뉴로 받습니다(시계·캘린더). 끌기 영역이 아닌 곳에서 메뉴를 띄우려면 `contextmenu`에서 `window.widget.window.openMenu()`(한 번 클릭에 메뉴가 두 번 열리지 않게 엔진이 거름).
- 창 위치·크기는 엔진이 저장합니다(화면 구성·창·크기 변형별). Win+D(바탕 화면 보기)에도 남고, 항상 위는 사용자 설정을 따릅니다.
- `F5`·`Ctrl+R`은 테마를 다시 불러오고, `--devtools`로 실행하면 `F12`가 개발자 도구입니다.

---

## 8. 버전 정책

- 규격 버전(`contractVersion`)은 **위젯마다 따로** 올라갑니다. 지금: 두레이 1(세부 v1.8), 시계·캘린더·메일·시스템 모니터·할 일 각각 1.
- 같은 `contractVersion` 안에서는 **추가만** 합니다(필드·호출·이벤트). 기존 것을 없애거나 모양을 바꾸지 않습니다. 테마는 모르는 필드를 무시하도록 작성하세요.
- 호환되지 않는 변경이 필요하면 그 위젯의 `contractVersion`을 2로 올립니다. 위젯이 1과 2를 함께 지원할 수도 있습니다.
- 엔진 쪽 공통 기능(이 문서)은 엔진 API 1.3(#57)부터입니다. 그보다 오래된 엔진에서는 시계·캘린더 테마가 동작하지 않습니다(위젯이 "호환 안 됨").

| 날짜 | 공통 규격 변경 |
|---|---|
| 2026-10-19 | 위젯별 테마 호스트(#57): `widget`·`features`·`window.main` 필드, `widget-theme://` 주소, `window.widget`, 공용 kit 폴더. 시계(#60)·캘린더(#61) 규격 v1 |
| 2026-10-19 | 배경 불투명도(#55, 두레이 v1.8): `background.opacity`, `--theme-bg-alpha` |

---

## 9. 개발하며 실행하기

```bash
# 내 테마 폴더를 바로 띄우기 (설치 불필요). theme.json의 widget으로 어느 위젯에 들어갈지 정해짐(없으면 두레이)
npm start -- --theme "C:\path\to\my-theme"

# 계정 없이 예시 데이터로 (두레이: 가상 프로젝트·업무, 캘린더: 메모리 안의 예시 캘린더)
npm start -- --theme "C:\path\to\my-theme" --mock-data

# 개발자 도구 (F12)
npm start -- --theme "C:\path\to\my-theme" --devtools
```

- 파일을 고친 뒤 테마 창에서 **Ctrl+R**.
- 개발 중인 테마는 고른 테마와 상관없이 그 위젯에 바로 쓰입니다.
- 예제: 두레이 [paper](../widgets/dooray/themes/paper)(최소)·[glass](../widgets/dooray/themes/glass)(전체), 시계 [dark-glass](../widgets/clock/themes/dark-glass)·[light](../widgets/clock/themes/light), 캘린더 [default](../widgets/calendar/themes/default)·[big](../widgets/calendar/themes/big).
