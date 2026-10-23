# 캘린더 테마 규격 v1

> 모든 위젯 테마에 공통인 규칙(폴더, theme.json 공통 필드, `extends`·kit, 배경 불투명도, 격리, `window.widget`의 엔진 부분, 개발 방법)은 [테마 규격](THEME_SPEC.md)에 있습니다. 이 문서는 캘린더 위젯(`widget: "calendar"`)이 테마에 여는 데이터와 호출입니다. 기준 코드: `widgets/calendar/index.js`(#61, 쓰기는 #63). 시작 예제는 [테마 만들기](theme-guide.md)의 "캘린더 테마".

## 1. 무엇이 어디에

| 캘린더 위젯(메인)·엔진이 하는 일 | 테마가 하는 일 |
|---|---|
| 계정·앱 전용 비밀번호·ICS 주소·새로고침 주기(설정 창에만, **테마는 볼 수 없음**) | 달력·일정 목록·자세히·편집 화면 |
| 일정 받기·캐시·반복 일정 펼치기, 범위 넓히기 | 보고 있는 달, 고른 날짜·일정, 편집 중인 값(위젯은 저장하지 않음) |
| 쓰기 검사·조건부 쓰기·다시 읽어 확인, 실패 알림 카드 | 저장 중·반영 확인 안 됨 표시 |
| **삭제 확인 창**(테마가 건너뛸 수 없음) | 삭제 버튼 |
| 링크 열기(일정의 http(s) 주소만) | 링크 버튼(일정 id만 넘김) |

## 2. theme.json (캘린더)

```json
{
  "id": "my-calendar",
  "name": "내 캘린더",
  "version": "0.1.0",
  "widget": "calendar",
  "contractVersion": 1,
  "extends": "default",
  "features": ["edit"],
  "background": { "opacity": 0.8 },
  "window": { "transparent": true, "main": { "width": 300, "height": 460, "minWidth": 240, "minHeight": 320 } }
}
```

| 필드 | 뜻 |
|---|---|
| `widget: "calendar"` | **필수** |
| `contractVersion` | `1` |
| `features: ["edit"]` | 일정 만들기·고치기·지우기 화면을 가진 테마라는 표시(위젯은 이 값으로 동작을 바꾸지 않음) |
| `window.main` | 창 기본·최소 크기. 없으면 300×460(최소 240×320) |
| `background.opacity` | 배경 불투명도 기본값([공통 4장](THEME_SPEC.md)). 자세히·편집 창은 거의 불투명하게 두세요 |

내장 테마: `default`(기본, 작은 달력 + 일정 목록, 전체 페이지), `big`(큰 달력, `extends: "default"` + 자기 `index.html`·`big.css`, 창 크기 따로).

## 3. 공용 파일 (kit)

| 파일 | 전역 | 주요 내용 |
|---|---|---|
| `model.js` | `window.CalendarModel` | `monthGrid`(6주 칸), `weeks`, `weekdayLabels`, `eventDays`(일정이 걸친 날), `compareEvents`, `byDay`, `upcoming`, `dayColors`, `timeLabel`, `dayTitle`, `detailTime`, `weekLayout`·`isBar`(큰 달력의 주별 막대 배치), `dateKey`·`parseKey`·`addDays`, `WEEKDAY_NAMES` |

```html
<script src="model.js"></script>
```

## 4. 데이터

### `api.getState()` (이벤트 `changed`와 같은 값)

| 필드 | 뜻 |
|---|---|
| `weekStart` | 한 주의 시작: `0` 일요일, `1` 월요일 |
| `upcomingDays` | 다가오는 일정 기간(일) |
| `locale` | 예: `ko-KR` |
| `sources` | `[{ id, name, color, enabled }]` 계정·구독(비밀 값 없음) |
| `calendars` | `[{ sourceId, calendarId, name, color }]` **새 일정을 만들 수 있는** 캘린더 |
| `lastCalendar` | 마지막으로 일정을 만든 캘린더 `{ sourceId, calendarId }` 또는 `null` |
| `lastUpdated` | 마지막 갱신 시각 |
| `refreshing` | 지금 받는 중 |
| `errorCount` | 실패한 계정·구독 수(자세한 이유는 설정 창, `window.widget.openSettings()`) |
| `pending` | 저장 중인 일정 uid 목록 |
| `unconfirmed` | `{ uid: 문구 }` 서버에 반영됐는지 확인되지 않은 일정 |

`getState()`는 `{ ok, result }`로 감싸지 않고 이 객체를 그대로 돌려줍니다.

### `api.events.list([{ from, to }, …])`

범위(밀리초, `to > from`, 최대 4개, 한 범위 400일까지)마다 일정 배열을 같은 순서로 돌려줍니다. 잘못된 범위 자리는 빈 배열. CalDAV 계정은 요청한 범위까지 받는 기간을 넓히고, 다 받으면 `changed`가 옵니다(그때 다시 부르면 됨).

**일정**(정규화된 모양):

| 필드 | 뜻 |
|---|---|
| `uid`, `sourceId`, `calendarId` | 일정을 가리키는 값. 호출에는 이 셋을 넘김 |
| `title`, `location`, `description` | 다른 사람이 입력한 값일 수 있음 — **`textContent`로** |
| `allDay` | 종일 여부 |
| `start`, `end` | 종일: `YYYY-MM-DD`(끝 날짜 미포함). 시간 일정: UTC ISO 문자열 |
| `recurrenceId` | 반복 일정의 한 회차면 그 값 |
| `color`, `sourceName` | 캘린더 색, 계정·구독 이름 |
| `readOnly`, `readOnlyReason` | 위젯에서 바꿀 수 없으면 `true`와 그대로 보여 줄 한국어 이유(구독, 쓰기 권한 없음, 반복 일정, 남의 회의 초대 등) |
| `hasUrl` | 일정에 링크가 있는지. **URL 자체는 주지 않습니다**(링크는 `events.openLink`) |
| `pending` | 저장 중(뒤에서 쓰는 중)인 일정이면 `true`(읽기 전용으로 다룸) |

## 5. 호출

| 호출 | 결과 | 미리보기 | 클릭·키 입력 필요 |
|---|---|---|---|
| `api.getState()` | 4장 | 실행 | |
| `api.events.list(ranges)` | 4장 | 실행 | |
| `api.refresh()` | 지금 다시 받기: 켜 둔 모든 캘린더를 서버에 다시 물어보고(바뀌지 않은 캘린더는 변경 표시·ETag로 짧게) **끝난 뒤** `{ ok, lastUpdated, errorCount }` (#81; 전에는 바로 `true`, 둘 다 참 값이라 `if (await refresh())`는 그대로 동작). 버튼을 끝날 때까지 돌게 하는 데 씀 | 실행 | |
| `api.events.create({ sourceId, calendarId }, fields)` | `{ ok: true, queued: true }` 또는 `{ ok: false, message }` | 거절 | **예** |
| `api.events.update({ sourceId, calendarId, uid }, fields)` | 같음. 바꾼 항목만 서버 문서에 병합 | 거절 | **예** |
| `api.events.remove({ sourceId, calendarId, uid })` | 위젯이 **확인 창**을 띄움 → `{ ok: true, queued: true }` / 취소하면 `{ ok: false, cancelled: true }` | 거절 | **예** |
| `api.events.openLink({ sourceId, calendarId, uid })` | 그 일정의 http(s) 링크를 브라우저로 → `true` / 링크 없음 `false` | 거절 | **예** |

**`fields`**: `{ title, allDay, start, end, location, description }`

- 종일: `start`·`end`는 `YYYY-MM-DD`(끝 미포함, 하루짜리면 다음 날). 시간 일정: 밀리초(분 단위로 맞춰짐).
- 제목 필수·300자, 장소 300자, 설명 4000자, 길이 1년까지. 틀리면 `{ ok: false, message }`(예: "제목을 넣으세요.")를 그대로 보여 주면 됩니다.

**쓰기는 뒤에서**(#63): 저장·삭제는 곧바로 `{ ok: true, queued: true }`가 오고, 그 일정은 `pending`으로 보이다가 서버에 반영되면 보통으로 돌아옵니다(새 일정은 반영 전 임시 uid `pending:<번호>`). 실패하면 위젯이 알림 카드로 알리고, 카드의 버튼이 아래 이벤트로 테마에 돌아옵니다.

**클릭·키 입력 필요**: 버튼의 `click`(또는 Enter 키) 처리기 안에서 바로 부르세요. 타이머나 긴 `await` 뒤에 부르면 거절될 수 있습니다.

## 6. 이벤트

| 이벤트 | 값 | 테마가 할 일 |
|---|---|---|
| `changed` | `getState()`와 같은 값 | 상태를 다시 그리고 보이는 범위의 `events.list`를 다시 부름 |
| `reveal` | `{ sourceId, calendarId, uid, day }` | 알림 카드의 **열기**: 그 날짜(`day`, `YYYY-MM-DD`)로 가서 그 일정의 자세히를 보여 줌 |
| `open-editor` | `{ sourceId, calendarId, uid, day }` | 알림 카드의 **다시 시도**: 그 일정의 편집 창을 서버의 최신 내용으로 열기 |

오른쪽 클릭 메뉴(엔진이 띄움): 지금 새로고침 · 항상 위에 표시 · 테마 · 한 주의 시작 + 엔진 항목(설정·위젯 관리·이 위젯 끄기·종료).

## 7. 버전

| 버전 | 내용 |
|---|---|
| 1 | 최초 규격 (#61, 뒤에서 쓰기·`reveal`·`open-editor` #63, 2026-10-19) |

같은 버전 안에서는 필드·호출·이벤트를 **추가만** 합니다([공통 8장](THEME_SPEC.md)).
