# 시계 테마 규격 v1

> 모든 위젯 테마에 공통인 규칙(폴더, theme.json 공통 필드, `extends`·kit, 배경 불투명도, 격리, `window.widget`의 엔진 부분, 개발 방법)은 [테마 규격](THEME_SPEC.md)에 있습니다. 이 문서는 시계 위젯(`widget: "clock"`)이 테마에 여는 데이터와 호출입니다. 기준 코드: `widgets/clock/index.js`(#60). 시작 예제는 [테마 만들기](theme-guide.md)의 "시계 테마".

## 1. 무엇이 어디에

| 시계 위젯(메인)이 하는 일 | 테마가 하는 일 |
|---|---|
| 설정 저장(초 표시, 12시간제, 스톱워치·타이머 사용, 마지막 탭, 항상 위) | 시각 그리기(디지털·아날로그 모양, 글꼴, 애니메이션) |
| 스톱워치·타이머 상태(시작 시각 + 쌓인 시간), 타이머 종료 예약, 종료 알림 카드·소리 | 스톱워치·타이머·알람 탭과 버튼 화면 |
| 알람 목록, 다음 울림 계산, 알람·놓친 알람 카드 | 알람 추가·고치기 입력 화면 |
| 오른쪽 클릭 메뉴 항목(항상 위, 스톱워치·타이머 사용, 테마) | 메뉴를 열 시점(끌기 영역은 엔진이 자동) |

그래서 테마를 바꾸거나, 받은 테마가 잘못 만들어졌거나, 스톱워치·타이머 탭을 그리지 않는 테마여도 **타이머와 알람은 계속 울립니다.**

## 2. theme.json (시계)

```json
{
  "id": "my-clock",
  "name": "내 시계",
  "version": "0.1.0",
  "widget": "clock",
  "contractVersion": 1,
  "extends": "dark-glass",
  "features": ["tools"],
  "background": { "opacity": 0.8 },
  "window": {
    "transparent": true,
    "main": { "width": 220, "height": 96, "minWidth": 140, "minHeight": 64 },
    "main+tools": { "width": 260, "height": 200, "minWidth": 220, "minHeight": 180 }
  }
}
```

| 필드 | 뜻 |
|---|---|
| `widget: "clock"` | **필수** |
| `contractVersion` | `1` |
| `features: ["tools"]` | 스톱워치·타이머·알람 탭을 그리는 테마라는 표시. 시계는 이 값으로 동작을 바꾸지 않습니다: "스톱워치·타이머 사용"을 켜면 `settings.tools`가 `true`가 되고 창이 `main+tools` 크기로 바뀌며, 그릴지는 테마가 정함 |
| `window.main` | 스톱워치·타이머를 쓰지 않을 때 창 기본·최소 크기. 없으면 220×96(최소 140×64) |
| `window["main+tools"]` | 스톱워치·타이머를 쓸 때. 없으면 260×200(최소 220×180). 두 크기는 따로 기억됨 |
| `background.opacity` | 배경 불투명도 기본값([공통 4장](THEME_SPEC.md)) |

내장 테마: `dark-glass`(기본, 전체 페이지), `light`·`minimal`·`neon`(`extends: "dark-glass"` + `style.css`), `analog`(`extends: "dark-glass"` + 자기 `index.html`, 창 크기 따로).

## 3. 공용 파일 (kit)

어느 시계 테마든 테마 폴더에 없어도 불러올 수 있습니다. 위젯 메인과 **같은 코드**라 계산이 어긋나지 않습니다.

| 파일 | 전역 | 주요 내용 |
|---|---|---|
| `timer-model.js` | `window.TimerModel` | `swElapsed(sw, now)`, `swRunning`, `tmRemaining(timer, now)`, `tmStatus`, `tmRunning`, `formatStopwatch`, `formatRemaining`, `formatDuration`, `splitSeconds`, `clampSeconds`, `TABS`, `MIN_SECONDS`(1)·`MAX_SECONDS`(23:59:59) |
| `alarm-model.js` | `window.AlarmModel` | `nextDue(alarm, now)`, `formatHM`, `daysText`, `alarmBadge`, `DAY_NAMES`, `MAX_ALARMS`(20)·`MAX_NAME`(20) |

```html
<script src="timer-model.js"></script>
<script src="alarm-model.js"></script>
```

## 4. 데이터

### `api.getState()`

`{ ok: true, result: { settings, timers } }` — 시작할 때 한 번 부르고, 이후는 이벤트로 받습니다.

### 이벤트 `settings`

`window.widget.on('settings', (settings) => …)` — 설정이나 마지막 탭이 바뀔 때.

| 필드 | 뜻 |
|---|---|
| `showSeconds` | 초 표시 |
| `hour12` | 12시간제(오전/오후) |
| `locale` | 예: `ko-KR` (날짜 글자용) |
| `tools` | 스톱워치·타이머 사용(탭을 보여야 함) |
| `lastTab` | `clock` · `stopwatch` · `timer` · `alarm` |
| `alwaysOnTop` | 항상 위 |

### 이벤트 `timers`

`window.widget.on('timers', (timers) => …)` — 스톱워치·타이머·알람 상태가 바뀔 때만(1초마다 오지 않음). 시각은 모두 ms(`Date.now()` 기준).

| 필드 | 뜻 |
|---|---|
| `stopwatch` | `{ startedAt: 시각 \| null, elapsed: ms }` — 돌고 있으면 `elapsed + (now - startedAt)` (`TimerModel.swElapsed`) |
| `timer` | `{ duration: ms, startedAt: 시각 \| null, elapsed: ms, done: boolean }` — 남은 시간은 `TimerModel.tmRemaining(timer, now)`, 상태는 `tmStatus` |
| `timerSeconds` | 타이머에 맞춰 둔 시간(초) |
| `timerPresets` | 프리셋 3칸(초) |
| `alarms` | `[{ id, hour, minute, name, days, on, snoozeUntil, since, next }]` — `days`는 요일 번호(0=일요일) 배열, 비면 한 번만. `next`는 다음 울림 시각(꺼져 있으면 `null`) |

### 다시 그리기는 테마가

위젯은 1초마다 신호를 보내지 않습니다. 테마가 자기 `Date.now()`로 다음 초 경계(초 표시를 끄면 다음 분)에 맞춘 `setTimeout`으로 시각을 다시 그리고, 스톱워치는 돌고 있고 보일 때만 `requestAnimationFrame`을 쓰세요. 같은 PC의 시계라 어긋나지 않습니다.

## 5. 호출

모두 Promise. 결과는 `{ ok: true }` 또는 `{ ok: false, message }`(한국어 문장)입니다.

| 호출 | 하는 일 | 미리보기 |
|---|---|---|
| `api.getState()` | 4장 | 실행 |
| `api.stopwatch.start()` / `pause()` / `reset()` | 스톱워치 | 무시(`null`) |
| `api.timer.start(초?)` | 멈춰 있으면 그 시간(없으면 맞춰 둔 시간)으로 시작, 일시정지 중이면 이어서 | 무시 |
| `api.timer.pause()` / `reset()` | 타이머 | 무시 |
| `api.timer.set(초)` | 맞춰 둘 시간(1초~23:59:59) | 무시 |
| `api.timer.usePreset(칸)` | 프리셋 칸(0~2, 정수)의 시간으로 바로 시작 | 무시 |
| `api.timer.savePreset(칸, 초)` | 프리셋 칸에 저장 | 무시 |
| `api.alarms.add({ hour, minute, name, days })` | 새 알람(켜진 상태) → `{ ok: true, id }`. 최대 20개, 이름 20자 | 거절 |
| `api.alarms.edit(id, { hour, minute, name, days })` | 고치면 다시 켜짐 | 거절 |
| `api.alarms.remove(id)` | 지우기 | 거절 |
| `api.alarms.toggle(id, on)` | 켜기·끄기 | 거절 |
| `api.setTab(tab)` | 마지막 탭 저장(`clock`·`stopwatch`·`timer`·`alarm`), `settings` 이벤트가 옴 | 무시 |

- 사용자 조작(클릭·키 입력)이 필요한 호출은 없습니다.
- 잘못된 값(없는 알람 id, 범위 밖 시각·칸)은 위젯이 거절하거나 무시합니다.
- 오른쪽 클릭 메뉴: 항상 위에 표시 · 스톱워치·타이머 사용 · 테마 + 엔진 항목(설정·위젯 관리·이 위젯 끄기·종료).

## 6. 버전

| 버전 | 내용 |
|---|---|
| 1 | 최초 규격 (#60, 2026-10-19) |

같은 버전 안에서는 필드·호출·이벤트를 **추가만** 합니다([공통 8장](THEME_SPEC.md)).
