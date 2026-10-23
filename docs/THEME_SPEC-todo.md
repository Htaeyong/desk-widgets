# 할 일 목록 테마 규격 v1

공통 테마 설치·격리·미리보기 규칙은 [테마 규격](THEME_SPEC.md)에 있습니다. 할 일 테마는 `theme.json`에 `"widget": "todo"`, `"contractVersion": 1`을 지정합니다. 기본 내장 테마 `default`는 기존 위젯과 같은 다크 글래스 카드이고, `ocean`은 이전 남색·하늘색 스타일을 이어받는 선택 테마입니다. `ocean`처럼 `default`를 상속하고 `style.css`의 변수만 바꾸면 기능과 화면 구성을 유지할 수 있습니다.

## 상태와 이벤트

`window.widget.api.getState()`는 `{ ok: true, result }`를 돌려줍니다. `result`에는 `lists[]`, `tasks[]`, `selectedListId`, `snoozeMinutes`, `alwaysOnTop`, `themeId`, `themeOpacity`, `locale`, `labels`가 있습니다. 저장된 내용이 바뀌면 `window.widget.on('state', handler)`가 같은 `result` 모양을 보냅니다. `labels`는 현재 언어의 사용자 표시 문구이며, 할 일 제목과 목록 이름은 사용자가 입력한 텍스트이므로 테마는 `textContent`로 표시해야 합니다.

| 항목 | 주요 필드 |
|---|---|
| 목록 | `id`, `name` |
| 할 일 | `id`, `listId`, `title`, `dueAt`, `dateOnly`, `repeatWeekday`, `completedAt`, `createdAt` |

`dueAt`과 `completedAt`은 밀리초 시각 또는 `null`입니다. `dateOnly`는 시간을 정하지 않은 날짜이고, `repeatWeekday`는 매주 반복이면 일요일 0~토요일 6입니다. 배열의 순서는 사용자가 끌어서 정한 순서입니다. 완료한 항목은 테마에서 아래에 접어 표시할 수 있습니다.

## 호출

| 호출 | 동작 |
|---|---|
| `api.tasks.add(text)` | 빠른 입력 한 줄을 현재 목록에 추가 |
| `api.tasks.toggle(id)` | 완료·완료 취소; 반복 할 일은 다음 회차로 이동 |
| `api.tasks.remove(id)` | 할 일 삭제 |
| `api.tasks.reorder(id, beforeId)` | 같은 목록에서 지정한 항목 앞으로 이동; `beforeId`가 없으면 끝으로 이동 |
| `api.lists.add(name)` | 목록 만들기·선택 |
| `api.lists.rename(id, name)` | 목록 이름 변경 |
| `api.lists.remove(id)` | 목록과 그 안의 할 일 삭제 |
| `api.lists.select(id)` | 표시할 목록 선택 |

변경 호출은 사용자 클릭·키 입력 직후에만 허용됩니다. 미리보기에서는 저장하지 않습니다. 성공하면 `{ ok: true, result }`, 입력 오류에는 `{ ok: false, message }`가 돌아옵니다. 테마는 오류 문구를 사용자에게 표시해야 합니다.

## 빠른 입력과 알림

한국어 입력 끝의 `오늘`, `내일`, `모레`, `다음 주 월요일`, `매주 월요일`과 `3시`, `오후 3시`, `15:30` 같은 시간을 해석합니다. 인식한 날짜 표현은 제목에서 제거합니다. 날짜만 입력한 할 일은 그날 마감으로 강조하되 시각 알림은 보내지 않습니다. 시각이 지정된 할 일은 시간이 되면 엔진 알림 카드가 뜨고, 카드의 **다시 알림**은 설정된 분만큼 뒤로 미룹니다. 테마는 알림을 직접 보내지 않습니다.
