# 두레이 테마 규격 v1

> 모든 위젯 테마에 공통인 규칙(격리, theme.json 공통 필드, `extends`, 배경 불투명도, 사용자 테마 폴더, 개발 방법)은 [테마 규격](THEME_SPEC.md)에 있습니다. 이 문서는 **두레이 대시보드** 테마만의 규격(`window.dooray`, 스냅샷, 창 모드)이고, 위젯별 테마 호스트(#57) 이후에도 내용은 그대로입니다. 두레이 테마는 `window.widget`이 아니라 `window.dooray`를 받습니다.

Desk Widgets의 **두레이 대시보드** 위젯은 **백엔드**(데이터 수집·집계)와 **테마**(화면)로 나뉩니다.
테마 창·격리·미리보기는 엔진(`engine/main/theme-host.js`)이 맡고, 데이터는 두레이 위젯이 보냅니다. 앱 이름이 바뀌어도(1.1.0, #33) 테마 주소 `dooray-theme://<id>/`와 `window.dooray` API는 그대로입니다.
테마는 이 문서의 규격만 지키면 누구나 만들 수 있고, 폴더를 복사해 넣기만 하면 적용됩니다.

```
┌──────────── 백엔드 (Electron main) ────────────┐        ┌──────── 테마 (격리된 창) ────────┐
│ Dooray API ─▶ 수집 ─▶ 집계 ─▶ 스냅샷(JSON, v1) │──IPC──▶│ window.dooray.onSnapshot(...)    │
│ API 토큰은 여기에만 존재                         │◀──IPC──│ refresh / openUrl / window 조작   │
└─────────────────────────────────────────────────┘        └──────────────────────────────────┘
```

- 테마는 **데이터 형식(스냅샷)** 과 **API(`window.dooray`)** 두 가지만 알면 됩니다.
- API 토큰 등 비밀 값은 테마에 전달되지 않습니다.

---

## 1. 테마 폴더 구조

```
my-theme/
├─ theme.json      (필수) 테마 정보
├─ index.html      (필수, 이름은 theme.json의 entry로 변경 가능)
├─ style.css
├─ app.js
└─ (이미지, 폰트 등 자유)
```

### 설치 위치

| 위치 | 용도 |
|---|---|
| `C:\Program Files\chilgong88\widgets\dooray\themes\<id>\` | 기본 내장 테마 (두레이 위젯과 함께 설치) |
| `%APPDATA%\chilgong88\desk-widgets\widgets\dooray\themes\<id>\` | 사용자가 받은 테마. 설정 → 두레이 대시보드 → **테마 폴더 열기**로 이동 (1.0.x의 `%APPDATA%\dooray-widget\themes`는 첫 실행 때 여기로 복사됨) |

폴더를 넣은 뒤 설정 창에서 테마를 고르면 바로 적용됩니다. 같은 id면 사용자 폴더가 우선입니다.

### theme.json

```json
{
  "id": "my-theme",
  "name": "내 테마",
  "version": "1.0.0",
  "author": "홍길동",
  "description": "한 줄 설명",
  "contractVersion": 1,
  "entry": "index.html",
  "background": { "opacity": 0.82 },
  "window": {
    "transparent": true,
    "material": "acrylic",
    "overview": { "width": 380, "height": 560, "minWidth": 300, "minHeight": 320 },
    "project":  { "width": 360, "height": 520, "minWidth": 300, "minHeight": 320 }
  }
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `id` | O | 소문자·숫자·`-`만. **폴더 이름과 같아야 함** |
| `widget` | | 쓰지 않거나 `"dooray"`. 다른 값이면 다른 위젯의 테마로 보고 두레이에서는 쓸 수 없음(#57) |
| `name`, `version` | O | 설정 창에 표시 |
| `author`, `description` | | 설정 창에 표시 |
| `contractVersion` | O | 이 문서의 버전. 현재 `1`. 다르면 설정 창에 "호환 안 됨"으로 표시되고 적용되지 않음 |
| `entry` | | 시작 HTML. 기본 `index.html` |
| `window.transparent` | | 투명 창 여부. 기본 `true` |
| `window.material` | | Windows 11 배경 효과: `acrylic`, `mica`, `none`. 기본 `none` |
| `window.overview` / `window.project` | | 창 기본/최소 크기(32 ~ 4000). 사용자가 크기를 바꾸면 그 값이 **화면 구성별로** 저장되어 우선 적용 (glass와 glass의 색만 바꾼 테마는 같은 크기를 공유, 자기 index.html을 가진 테마는 따로) |
| `background.opacity` | | (v1.8) 배경 불투명도 기본값(0~1). 넣으면 설정 창에 이 테마의 **배경 불투명도** 슬라이더가 생기고 앱이 CSS 변수 `--theme-bg-alpha`를 넣어 줌(아래 "배경 불투명도"). 없거나 0~1 숫자가 아니면 슬라이더 없음, 테마는 예전 그대로 |
| `extends` | | (v1.6) 다른 테마의 id. 이 테마 폴더에 없는 파일은 그 테마에서 가져옴 (최대 4단계). 기반 테마가 없거나 쓸 수 없으면 이 테마도 쓸 수 없음 |

### 색만 바꾼 테마 (extends, v1.6)

기능은 기본 테마 glass와 같고 색·모양만 바꾸려면 `theme.json`과 `style.css` 두 파일이면 됩니다.

```
my-skin/
├─ theme.json   "extends": "glass"
└─ style.css    glass의 CSS 변수를 덮어씀
```

- glass의 `index.html`은 `base.css`(배치, 기본 색 변수) 다음에 `style.css`를 불러옵니다. 내 `style.css`가 glass의 빈 `style.css` 자리를 대신합니다.
- 바꿀 수 있는 변수 목록은 `widgets/dooray/themes/glass/base.css` 맨 위 `:root`에 있습니다 (`--shell-rgb`·`--bg-alpha`(배경색과 불투명도, v1.8), `--shell-bg`, `--panel`, `--text`, `--accent`, `--radius` 등). 변수 외의 CSS 규칙도 덧붙일 수 있습니다.
- 배경 불투명도 슬라이더(v1.8)를 쓰려면 `--shell-bg` 대신 `--shell-rgb`(예: `246, 246, 250`)와 `--bg-alpha: var(--theme-bg-alpha, <기본값>)`을 쓰고 `theme.json`에 같은 기본값을 `"background": { "opacity": <기본값> }`으로 넣습니다. `--shell-bg`를 직접 정한 테마는 예전처럼 고정 배경입니다.
- 예제: 내장 테마 `bigsur`, `midnight`, `sunset`, `mono`

### 화면 구성이 다른 테마 + 공통 도구 kit.js

`extends: "glass"`로 자기 `index.html`·`style.css`·`app.js`를 두면 화면 구성을 완전히 새로 만들면서도 glass의 공통 도구 `kit.js`를 쓸 수 있습니다 (`<script src="kit.js"></script>`를 app.js보다 먼저).

`window.DoorayKit`이 제공하는 것: `h()`(안전한 요소 생성, 글자는 항상 textContent), `ICONS`, `relativeTime`, `dueDays`, `dueLabel`, 검색(`parseQuery`, `searchTasks`, `highlight`, 초성 포함), `byUrgency`(정렬), `openTasks`, `allKnownTasks`, `tagLabel`, `statusInfo`(상태 점·문구), `onBackForward`(마우스 뒤로/앞으로·Alt+←/→), `createHistory`.

예제: 내장 테마 `sidebar`(사이드바), `board`(칸반 보드), `agenda`(일정), `minibar`(미니 바, `window.setSize` 사용)

### 배경 불투명도 (v1.8)

바탕화면이 얼마나 비칠지는 배경화면·취향마다 달라서 사용자가 **테마마다** 정합니다(설정 창의 테마 아래 슬라이더 0~100%). 창 전체 투명도는 글자까지 흐려지므로 쓰지 않고, **테마의 배경만** 이 값을 따릅니다.

1. `theme.json`에 기본값을 넣습니다: `"background": { "opacity": 0.82 }` (0~1). 이 필드가 있는 테마만 슬라이더가 생깁니다.
2. 앱이 테마 페이지의 루트(`<html>`)에 CSS 변수 **`--theme-bg-alpha`**(0~1)를 넣어 줍니다. 사용자가 고른 값, 없으면 `theme.json`의 기본값입니다. 앱이 직접 넣는 스타일이라 테마의 CSP나 코드와 관계없이 동작하고, 페이지를 다시 불러와도 다시 들어갑니다.
3. 테마는 **배경색에만** 이 변수를 쓰고, 기본값을 대체값으로 둡니다. 이 변수를 넣지 않는 예전 앱에서도 같은 모양이 되도록:

```css
:root {
  --bg-alpha: var(--theme-bg-alpha, 0.82);           /* theme.json과 같은 기본값 */
  --card-bg: rgba(22, 23, 28, var(--bg-alpha));       /* 색은 rgb, 불투명도는 변수 */
}
.card { background: var(--card-bg); }
```

- 그라데이션은 색 멈춤마다 `rgba(r, g, b, var(--bg-alpha))`로 씁니다(내장 `sunset`, `board`).
- 글자·업무 카드·버튼, 그리고 **메뉴·팝업**은 이 값을 따르지 말고 읽을 수 있게 불투명하게 둡니다.
- 슬라이더를 움직이는 동안(저장 전)에도 값이 바로 바뀝니다. 미리보기 창은 테마마다 사용자가 정한 값으로 보입니다.
- 값이 바뀔 때 스크립트로 반응하려면 `getContext()`의 `background.opacity`와 `onBackground(callback)`을 씁니다. CSS 변수만 쓰는 테마는 필요 없습니다.
- `background`가 없는 테마에는 앱이 아무것도 넣지 않습니다(`getContext().background`는 `null`).

---

## 2. 창 모드 (context)

같은 테마가 두 가지 모드로 열립니다. 테마는 시작할 때 `getContext()`로 모드를 확인하고 그에 맞게 그립니다.

| 모드 | 언제 | 그려야 할 것 |
|---|---|---|
| `overview` | 메인 위젯 | 전체 요약 + 프로젝트 목록. 프로젝트 상세로 들어가는 화면 전환은 테마가 자유롭게 구현 |
| `project` | 프로젝트를 **별도 위젯으로 분리**했을 때 | `projectId` 프로젝트 하나의 대시보드 |

---

## 3. `window.dooray` API

모든 함수는 Promise를 반환합니다(`onSnapshot` 제외).

```ts
interface DoorayThemeApi {
  apiVersion: 1;

  /** 창 모드와 테마 정보 */
  getContext(): Promise<{
    mode: 'overview' | 'project';
    projectId: string | null;      // project 모드일 때만
    theme: { id: string; name: string; version: string };
    locale: string;                // 예: 'ko-KR'
    /** 배경 불투명도 0~1 (v1.8). theme.json에 background가 없으면 null */
    background: { opacity: number } | null;
  }>;

  /** 최신 스냅샷 (아직 없으면 state='loading' 스냅샷) */
  getSnapshot(): Promise<Snapshot>;

  /** 스냅샷이 바뀔 때마다 호출. 구독 해제 함수를 반환 */
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;

  /** 배경 불투명도가 바뀔 때마다 호출 (슬라이더를 움직이거나 저장할 때, v1.8).
   *  CSS 변수 --theme-bg-alpha는 앱이 이미 바꿔 주므로 대부분의 테마는 필요 없음. 구독 해제 함수를 반환 */
  onBackground(callback: (background: { opacity: number }) => void): () => void;

  /** 변경 확인을 건너뛰고 전부 다시 읽기(프로젝트·업무·완료·분류 업무·태그). 완료되면 onSnapshot으로 새 데이터가 옴 */
  refresh(): Promise<void>;

  /** 사용자의 두레이 주소(snapshot.dooray.webUrl)로 시작하는 링크만 기본 브라우저로 열림 */
  openUrl(url: string): Promise<boolean>;

  /** 설정 창 열기 */
  openSettings(): Promise<void>;

  /** 프로젝트 하나를 별도 위젯 창으로 띄우기 (이미 떠 있으면 앞으로 가져옴) */
  openProjectWidget(projectId: string): Promise<void>;

  /** 사용자가 정한 프로젝트 순서 저장 (프로젝트 id 배열). 다음 스냅샷부터 이 순서로 옴 (v1.5) */
  setProjectOrder(projectIds: string[]): Promise<boolean>;

  /** 앱의 분류 관리 창 열기. categoryId를 주면 그 분류를 선택한 상태로 열림 (v1.2) */
  openCategoryManager(categoryId?: string): Promise<void>;

  /** 나만의 업무 분류 (v1.1). 앱에만 저장되고 두레이에는 쓰지 않음.
   *  모두 { ok: true, result } 또는 { ok: false, message } 를 반환. 성공하면 onSnapshot으로 새 스냅샷이 옴 */
  categories: {
    create(input: { name: string; color?: string }): Promise<Result<Category>>;   // color: '#rrggbb'
    update(id: string, changes: { name?: string; color?: string }): Promise<Result>;
    move(id: string, delta: -1 | 1): Promise<Result>;                              // 순서 위/아래
    remove(id: string): Promise<Result>;                                           // 업무 지정도 함께 해제
    setTaskCategories(taskId: string, categoryIds: string[]): Promise<Result>;     // 빈 배열 = 모든 분류에서 빼기
    removeClosed(id?: string): Promise<Result<number>>;                            // 완료된 업무 정리. id 없으면 전체
  };

  window: {
    /** overview 창: 앱 종료 / project 창: 그 창만 닫기 */
    close(): Promise<void>;
    /** 항상 위 토글. 바뀐 상태를 반환 */
    togglePin(): Promise<boolean>;
    getState(): Promise<{ pinned: boolean }>;
    /** 창 크기 바꾸기. 왼쪽 위 모서리는 그대로, 화면 밖으로 나가지 않게 조정. 적용된 크기를 반환 (v1.7)
     *  예: 접었다 펼치는 바 모양 테마. 최소 크기(theme.json)보다 작아지지 않음 */
    setSize(width: number, height: number): Promise<{ width: number; height: number }>;
  };
}
```

### 창 드래그

테마 창은 테두리가 없습니다. 드래그할 영역에 CSS `-webkit-app-region: drag;`를 주고,
그 안의 버튼에는 `-webkit-app-region: no-drag;`를 주세요.

---

## 4. 스냅샷 (데이터 형식)

정확한 정의는 [`widgets/dooray/contract/dashboard.v1.schema.json`](../widgets/dooray/contract/dashboard.v1.schema.json) (JSON Schema)입니다.
예시 데이터는 [`widgets/dooray/contract/sample-snapshot.json`](../widgets/dooray/contract/sample-snapshot.json)에 있습니다.

```jsonc
{
  "contractVersion": 1,
  "generatedAt": "2026-10-16T05:00:00.000Z",
  "status": {
    "state": "ok",              // unconfigured | loading | ok | error
    "refreshing": false,        // 지금 가져오는 중
    "message": null,            // 오류 메시지 (사용자에게 보여줄 문장)
    "lastSuccessAt": "...",     // 마지막 성공 시각
    "nextRefreshAt": "...",
    "paused": false,            // 자리 비움으로 갱신이 멈춘 상태 (v1.3)
    "pausedReason": null        // locked | suspended | idle (v1.3)
  },
  "me": { "id": "...", "name": "홍길동" },
  "dooray": { "domain": "mycompany.dooray.com", "webUrl": "https://mycompany.dooray.com" },
  "rules": { "dueSoonDays": 3, "recentDays": 7, "taskListLimit": 10 },
  "summary": { "projectCount": 5, "counts": { /* counts */ } },
  "projects": [ /* project, 사용자가 정한 순서 (v1.5) */ ],
  "categories": [ /* category (v1.1) */ ]
}
```

### counts

| 필드 | 의미 |
|---|---|
| `open` | 미완료 업무 = `backlog + registered + working` |
| `backlog` / `registered` / `working` | 두레이 상태 분류별 개수 (대기 / 할 일 / 진행 중) |
| `overdue` | 마감일이 지난 미완료 업무 |
| `dueSoon` | 마감까지 `rules.dueSoonDays`일 이내 |
| `mine` | 내가 담당자인 미완료 업무 |
| `unassigned` | 담당자 없는 미완료 업무 |
| `closedRecently` | 최근 `rules.recentDays`일 안에 완료된 업무 |

### project

`projects` 배열은 **사용자가 정한 순서**로 옵니다(v1.5). 테마는 다시 정렬하지 말고 이 순서를 유지하세요. 순서를 바꾸는 화면을 제공하려면 `setProjectOrder(ids)`를 호출합니다.

| 필드 | 의미 |
|---|---|
| `id`, `name`, `description`, `url` | 프로젝트 정보. `url`은 두레이 웹 주소 |
| `counts` | 위 counts |
| `workflows[]` | 업무 상태(워크플로)별 미완료 개수 `{ id, name, class, count }` |
| `assignees[]` | 담당자별 부하 `{ id, name, open, working, overdue, isMe }`, open 많은 순 |
| `tasks.open` | 미완료 업무 전체, 최근 수정 순 (최대 500건). 검색은 이 목록을 대상으로 하면 됨 |
| `tasks.overdue` / `dueSoon` | 마감 순, 최대 `taskListLimit`개 |
| `tasks.mine` | 내 업무, 최대 `taskListLimit`개 |
| `tasks.recent` | 최근 수정 순, 최대 `taskListLimit`개 |
| `truncated` | 업무가 너무 많아 일부만 가져왔을 때 `true` |
| `error` | 이 프로젝트만 실패했을 때 메시지, 아니면 `null` |

### task

| 필드 | 의미 |
|---|---|
| `id`, `key`, `number` | `key`는 `프로젝트/번호` 형태 |
| `subject` | 제목. **반드시 이스케이프해서 표시** (`textContent` 사용 권장) |
| `url` | 두레이 업무 주소. `openUrl(url)`로 열기 |
| `workflowClass`, `workflowName` | 상태 분류와 프로젝트별 상태 이름 |
| `priority` | `highest` `high` `normal` `low` `lowest` `none` |
| `dueDate` | 두레이 원본 마감일 |
| `deadline` | 실제 마감 시각. 날짜만 지정된 경우 그날 끝까지로 계산 |
| `dueState` | `none` `overdue` `soon` `later` |
| `assignees[]`, `author` | `{ id, name }` |
| `isMine` | 내가 담당자인지 |
| `createdAt`, `updatedAt` | ISO 시각 |
| `projectId`, `projectName` | 소속 프로젝트 (v1.1) |
| `categoryIds` | 이 업무가 들어 있는 내 분류 id 목록 (v1.1) |
| `stale` | 삭제·권한 없음 등으로 최신 정보를 못 가져와 저장된 사본을 보여줄 때 `true` (v1.1) |
| `tags[]` | 두레이 태그 `{ id, name, color, group }`. 예: `{ name: "고객사: 예시시청", color: "#ECF7FF", group: "고객사" }` (v1.4). 분류에 저장된 오래된 사본에는 없을 수 있으니 `t.tags || []`로 다루세요 |

### category (v1.1)

사용자가 직접 만든 분류입니다. 여러 프로젝트의 업무를 담을 수 있고, 완료된 업무도 정리하기 전까지 남아 있습니다.

| 필드 | 의미 |
|---|---|
| `id`, `name`, `color` | `color`는 `#rrggbb` |
| `counts` | `{ total, open, overdue, dueSoon, closed }` |
| `tasks[]` | task 목록. 미완료(지연 → 임박 → 나머지) 먼저, 완료는 뒤. 각 묶음은 최근 수정 순 |

분류 기능은 선택 사항입니다. 분류를 지원하지 않는 테마는 `categories`를 무시하면 됩니다.

---

## 5. 보안 규칙 (앱이 강제함)

테마는 다른 사람이 만든 코드일 수 있으므로 격리된 환경에서 실행됩니다.

- Node.js / Electron API 접근 불가. `window.dooray`만 사용 가능
- **외부 네트워크 요청 차단** (`fetch`, 외부 이미지·폰트·스크립트 CDN 모두). 필요한 파일은 테마 폴더에 포함
- 페이지 이동, 새 창(`window.open`) 차단
- 링크는 `openUrl()`로만, 사용자의 두레이 주소만 열림
- 카메라·알림 등 권한 요청은 모두 거부
- 테마 파일은 `dooray-theme://<id>/...` 주소로 제공되며, 테마 폴더 밖 파일은 읽을 수 없음

---

## 6. 버전 정책

| 버전 | 추가 내용 |
|---|---|
| 1.0 | 최초 규격 |
| 1.1 | `snapshot.categories`, task의 `projectId` `projectName` `categoryIds` `stale`, `window.dooray.categories` |
| 1.2 | `window.dooray.openCategoryManager()`, `tasks.open` 한도 100 → 500 |
| 1.3 | `status.paused`, `status.pausedReason` (잠금·절전·자리 비움 중 갱신 중단) |
| 1.4 | task의 `tags` (두레이 태그 이름·색·그룹) |
| 1.5 | `projects` 배열 순서 = 사용자가 정한 순서, `window.dooray.setProjectOrder(ids)` |
| 1.6 | `theme.json`의 `extends` (다른 테마의 파일을 이어받기) |
| 1.7 | `window.dooray.window.setSize(width, height)`, 창 최소 크기 하한 120 → 32, 창 크기를 화면 구성별로 저장 |
| 1.8 | `theme.json`의 `background.opacity`, 앱이 넣는 CSS 변수 `--theme-bg-alpha`, `getContext().background`, `window.dooray.onBackground()` (테마별 배경 불투명도, #55) |


- `contractVersion` 1 안에서는 **필드 추가만** 합니다. 기존 필드를 없애거나 타입을 바꾸지 않습니다.
- 테마는 모르는 필드를 무시하도록 작성하세요.
- 호환되지 않는 변경이 필요하면 `contractVersion: 2`로 올리고 이 문서를 새로 씁니다.

---

## 7. 테마 개발 방법

```bash
# 내 테마 폴더를 바로 띄우기 (설치 불필요, 파일 수정 후 Ctrl+R로 새로고침)
npm start -- --theme "C:\path\to\my-theme"

# 두레이 계정 없이 샘플 데이터로 띄우기
npm start -- --theme "C:\path\to\my-theme" --mock-data

# 개발자 도구 열기
npm start -- --theme "C:\path\to\my-theme" --devtools
```

최소 예시는 [`widgets/dooray/themes/paper`](../widgets/dooray/themes/paper)를, 전체 기능 예시는 [`widgets/dooray/themes/glass`](../widgets/dooray/themes/glass)를 참고하세요.
