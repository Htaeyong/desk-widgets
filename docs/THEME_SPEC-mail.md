# 메일 테마 규격 v1

> 모든 위젯 테마에 공통인 규칙(폴더, theme.json 공통 필드, `extends`·kit, 배경 불투명도, 격리, `window.widget`의 엔진 부분, 개발 방법)은 [테마 규격](THEME_SPEC.md)에 있습니다. 이 문서는 메일 위젯(`widget: "mail"`)이 테마에 여는 데이터와 호출입니다. 기준 코드: `widgets/mail/index.js`(#65). 시작 예제는 [테마 만들기](theme-guide.md)의 "메일 테마".

## 1. 무엇이 어디에

| 메일 위젯(메인)·엔진이 하는 일 | 테마가 하는 일 |
|---|---|
| 계정·비밀번호·서버(설정 창에만, **테마는 볼 수 없음**) | 목록·계정별 거르기·본문(텍스트) 보기 화면 |
| IMAP 연결·동기화·새 메일 감지·알림 카드 | 안 읽음 수·계정 상태 표시 |
| 본문 받기(메모리에만), **원문(HTML) 보기 창**: 격리된 보기(JavaScript 끔, 원격 차단), 이미지 표시 | "원문 보기" 버튼(메일 id만 넘김) |
| 읽음 표시(서버), 쓰기 넘기기(mailto·웹메일), 웹메일 열기 | 답장·전달·새 메일 버튼(메일 id만 넘김) |

테마는 메일의 **HTML을 받지 않습니다**. 본문은 텍스트(`text`)로만 오고, 서식·이미지가 있는 원문은 `api.openPreview(id)`로 위젯의 보기 창에서 엽니다. 받는 주소·Message-ID·서버 정보도 테마에는 없습니다.

## 2. theme.json (메일)

```json
{
  "id": "my-mail",
  "name": "내 메일",
  "version": "0.1.0",
  "widget": "mail",
  "contractVersion": 1,
  "extends": "default",
  "features": ["detail"],
  "background": { "opacity": 0.8 },
  "window": { "transparent": true, "main": { "width": 340, "height": 500, "minWidth": 260, "minHeight": 280 } }
}
```

| 필드 | 뜻 |
|---|---|
| `widget: "mail"` | **필수** |
| `contractVersion` | `1` |
| `features: ["detail"]` | 테마 안에 본문 보기 화면이 있다는 표시(위젯은 이 값으로 동작을 바꾸지 않음) |
| `window.main` | 창 기본·최소 크기. 없으면 340×500(최소 260×140) |
| `background.opacity` | 배경 불투명도 기본값([공통 4장](THEME_SPEC.md)) |

내장 테마: `default`(기본, 목록 + 본문 보기), `compact`(작은 카드, `extends: "default"` + 자기 `index.html`·`compact.css`·`compact.js`, 창 크기 따로), `dashboard`(계정 대시보드 #72, `extends: "default"` + 자기 `index.html`·`dashboard.css`·`dashboard.js`, 기본 720×520, 배경 0.85).

## 3. 공용 파일 (kit)

| 파일 | 전역 | 주요 내용 |
|---|---|---|
| `mail-model.js` | `window.MailModel` | `timeLabel(ms, now)`(오늘 `14:05`, `어제`, 요일, `10/3`, `2025.10.3`), `fullDate`, `senderLabel(from)`, `personLabel`, `initials`, `filterBy(items, accountId)`, `sizeLabel`, `accountStatus(account)` |

| `refresh.js`, `refresh.css` | `window.MailRefresh` | ⟳ 버튼(#79): `bind(button, { run, notice, minMs })`, `resultText(res)`. 누르는 즉시 `spin`·`pressed` 클래스와 `data-busy="1"`(**⟳ 글자만** 돎: 버튼 안 `<span class="glyph">⟳</span>`을 `refresh.css`가 회전, 버튼 상자는 그대로. 글자만 있는 버튼은 `bind`가 span으로 감쌈), 답이 오고 최소 0.6초가 지나면 풀고 `notice(문구, 오류인지)` |
| `dash-model.js` | `window.MailDash` | 계정 대시보드(#72): `filterFor(accountId, quick)`·`quickOf(filter)`(빠른 거르기 `all`·`unread`·`flagged`·`cat:<id>` ↔ `filter()` 값), `cardCategories(account, categories)`, `quickChips(account, categories)`, `totals(accounts)`, `scopeNote(quick, loaded)` |
| `nav.js` | `window.MailNav` | 뒤로·앞으로: `createHistory({ limit })`(`record(지금 화면)`, `back(지금)`/`forward(지금)` → 보여 줄 화면 또는 `null`, `canBack`, `canForward`, `clear`), `bindInputs(window, { back, forward })`(마우스 옆 버튼 3·4, Alt+←/→), `inputAction(event)` |

```html
<script src="mail-model.js"></script>
<script src="nav.js"></script>
```

### 뒤로·앞으로 (권장)

두레이 위젯(#17)과 같이 **마우스 옆 버튼**(뒤로 3·앞으로 4)과 **Alt+← / Alt+→**로 테마 안의 화면을 오갑니다. 화면을 바꿀 때(목록 → 메일, 계정 거르기, 알림 카드의 열기) **바꾸기 전에** 지금 화면을 `record`하고, 뒤로·앞으로에서 받은 화면을 그대로 다시 그리면 됩니다.

```js
const history = MailNav.createHistory();
const snapshot = () => ({ screen: detailId ? 'detail' : 'list', id: detailId, filter, scroll: list.scrollTop, selected });
function navigate(apply) { history.record(snapshot()); apply(); }   // 새로 이동하면 "앞으로"는 지워짐
function goBack() { const s = history.back(snapshot()); if (s) restore(s); }   // 없으면 아무 일도 안 함
MailNav.bindInputs(window, { back: goBack, forward: () => { const s = history.forward(snapshot()); if (s) restore(s); } });
```

- 되돌아갈 화면이 없으면 **아무것도 하지 않습니다**(위젯을 닫지 않음).
- 목록으로 돌아올 때는 거르기·스크롤 위치·마지막으로 연 메일 표시를 되살리세요(기본 테마는 `snapshot`에 `filter`·`scroll`·`selected`).
- 뒤로·앞으로로 메일을 다시 보여 줄 때는 `api.get(id)`(읽기만)을 쓰세요. 이미 읽은 메일이고, 키·옆 버튼이 클릭으로 인정되지 않을 수도 있습니다.
- 위젯의 **메일 보기 창**은 위젯이 따로 처리합니다: 뒤로 = 앞서 연 메일, 없으면 창을 닫음.

## 4. 데이터

### `api.getState()` (이벤트 `changed`와 같은 값)

| 필드 | 뜻 |
|---|---|
| `accounts` | `[{ id, name, color, email, enabled, unread, flagged, loaded, categories, latest, folders, state, error, lastSync, canCompose, hasWebmail }]`. #72: `unread`·`flagged`는 **서버가 센 받은편지함 전체**(UID SEARCH UNSEEN / FLAGGED, #80부터 **함께 볼 메일함 포함**). #83: 안 읽음·중요로 거른 `list()`가 **같은 서버 목록**을 보여 주므로 다 불러오면 목록 수 = 이 숫자(받은편지함과 메일함에 함께 있는 같은 Message-ID 메일은 한 번), `loaded`는 위젯이 불러온 머리글 수, `categories`는 `{ 분류 id: 수 }` — **불러온 메일 중**(분류는 이 PC에만 있어 서버가 셀 수 없음), `latest`는 최근 3통 `[{ id, folder, subject, from, date, unread, flagged }]`. `folders`(#80)는 사용자가 고른 **함께 볼 메일함** `[{ key, name, unread, error }]`(없으면 `[]`; `error`는 그 메일함만의 문제, 예: 서버에서 지워짐). `state`: `ok`·`connecting`·`syncing`·`error`·`paused`(자리 비움)·`off`. `error`는 그대로 보여 줄 한국어 문구 |
| `totalUnread` | 켜진 계정의 안 읽은 메일 합계(서버 기준) |
| `refreshing` | 연결·받는 중인 계정이 있음 |
| `errorCount` | 오류인 계정 수(자세한 이유는 설정 창, `window.widget.openSettings()`) |
| `lastUpdated` | 마지막으로 확인한 시각(ms) |
| `paused` | 자리 비움·잠금 중이라 연결을 끊어 둠 |
| `categories` | `[{ id, name, color, count }]` 이 PC의 메일 분류(#69, 메일 서버에는 없음). `count`는 지금 불러온 메일 중 그 분류인 수 |
| `filter` | 지금 목록 거르기 전체 `{ category, accountId, unread, flagged }`(#72) |
| `counts` | 숫자의 출처: `{ unread: 'server', flagged: 'server', categories: 'loaded' }` — `loaded`(분류)만 화면에 "불러온 메일 중"이라고 밝혀 주세요. `server`인 안 읽음·중요는 거른 목록도 서버 기준이라(#83) 그런 안내가 필요 없습니다 |
| `categoryFilter` | 지금 목록을 거르는 분류: `''` 전체, 분류 id, `'__none__'` 분류 없음 |
| `sending`, `lastSent` | 위젯에서 보내는 중인 메일 수, 마지막으로 끝난 보내기 `{ ok, subject, at, sentFolder?, note?, message? }`(#68) |
| `mailProgram` | Windows가 mailto 링크를 여는 프로그램 이름(예: `Outlook`), 없으면 `null`(그때 쓰기는 웹메일 주소가 있는 계정이면 웹메일로) |
| `notify`, `markReadOnOpen` | 새 메일 알림 켬, 열면 읽음 표시(설정) |
| `locale`, `mock` | 예: `ko-KR`, `--mock-data` 실행 여부 |

`getState()`는 `{ ok, result }`로 감싸지 않고 이 객체를 그대로 돌려줍니다.

### `api.list()` → `{ items, hasMore, limit }`

모든 계정의 받은편지함(과 #80 **함께 볼 메일함**)을 **도착 시각 최신순**으로 합친 목록(지금 `limit`통까지). 새 메일·읽음 변경·더 보기 뒤에는 `messages` 이벤트가 오니 다시 부르면 됩니다.

**메일 한 통**(`items`의 항목):

| 필드 | 뜻 |
|---|---|
| `id` | 받은편지함 `"<계정 id>:<UID>"`, 함께 볼 메일함(#80) `"<계정 id>:<메일함 키 8자>:<UID>"`. 모양을 풀지 말고 호출에 이 값을 그대로 넘김 |
| `accountId`, `accountName`, `color` | 계정과 그 색(목록의 색 막대) |
| `folder`, `folderKey` | 메일함 이름(받은편지함은 `"INBOX"`)과 키(받은편지함은 `""`), #80. `INBOX`가 아니면 이름을 작게 보여 주세요(기본 테마: 보낸 사람 옆 꼬리표) |
| `from` | `{ name, address }` |
| `subject`, `snippet` | 제목, 본문 앞부분 한 줄(최대 160자). 다른 사람이 쓴 값 — **`textContent`로** |
| `date` | 받은 시각(ms) |
| `unread`, `flagged`, `answered`, `hasAttachments` | 안 읽음, 별표, 답장함, 첨부 있음 |
| `categoryIds` | 이 메일의 분류 id(#69, `getState().categories`의 순서) |

### `api.select(id)` / `api.get(id)` → `{ ok: true, message }` 또는 `{ ok: false, message: 문구 }`

본문을 서버에서 받아(처음 한 번, 몇 초 걸릴 수 있음) 아래 값을 돌려줍니다. **`select`**는 클릭·키 입력 직후에만 되고 설정이 켜져 있으면 **읽음으로 표시**합니다(테마 미리보기에서는 표시하지 않음). **`get`**은 읽기만 합니다(알림 카드의 `reveal`처럼 테마에서 누른 것이 아닐 때).

| 필드 | 뜻 |
|---|---|
| `id`, `accountId`, `accountName`, `color`, `folder` | 목록과 같음 |
| `from`, `to`, `cc` | `{ name, address }`, 배열 |
| `subject`, `date`, `unread`, `flagged`, `hasAttachments` | 목록과 같음 |
| `text` | 본문 텍스트(HTML 메일은 텍스트로 바꾼 것, 최대 5만 자). **`textContent`로** |
| `hasHtml` | 서식 있는 원문이 있음 → "원문 보기"를 권하면 좋음 |
| `remoteImages` | 원문의 외부 이미지 수(원문 보기에서 사용자가 허용해야 보임) |
| `attachments` | `[{ name, size, type }]` 이름과 크기만(1.0.0은 내려받기 없음) |
| `truncated` | 너무 커서 일부만 받음 |
| `hasWebmail` | 이 계정에 웹메일 주소가 있음 |
| `categoryIds`, `categories` | 이 메일의 분류 id, 전체 분류 목록(#69) |

## 5. 호출

| 호출 | 결과 | 미리보기 | 클릭·키 입력 필요 |
|---|---|---|---|
| `api.getState()` | 4장 | 실행 | |
| `api.list()` | 4장 | 실행 | |
| `api.loadMore()` | 한 번 더 `pageSize`통(설정, 기본 30)을 보이고 필요한 계정은 더 오래된 메일을 받음 → `list()`와 같은 값 | 실행 | |
| `api.refresh()` | 모든 계정을 지금 서버에 다시 물어봄(IDLE 중인 계정도). **끝나면** 답함(#79): `{ ok: true, accounts, newMail, errors: [{ name, message }], at }`(오래 걸리는 계정은 45초 뒤 오류로 셈). kit `refresh.js`의 `MailRefresh.bind(button, { run: () => api.refresh(), notice })`가 누른 표시·최소 0.6초 회전·결과 문구(`새 메일 N통`·`새 메일 없음`·오류)를 해 줌 | 실행 | |
| `api.get(id)` | 4장 (읽음 표시 안 함) | 실행 | |
| `api.select(id)` | 4장 (읽음 표시) | 실행(읽음 표시 안 함) | **예** |
| `api.markRead(id)` / `api.markUnread(id)` | 서버에 읽음 / 안 읽음 → `{ ok: true }` | 거절 | **예** |
| `api.openPreview(id)` | 위젯의 **메일 보기 창**에 원문을 엶(격리된 보기, 외부 이미지는 사용자가 "이미지 표시"를 눌러야) → `{ ok: true }` | 거절 | **예** |
| `api.openWebmail({ id } \| { accountId })` | 그 계정의 웹메일을 브라우저로(Gmail은 그 메일을 찾아 엶) → `{ ok: true }` / 주소 없음 `{ ok: false, message }` | 거절 | **예** |
| `api.compose({ accountId?, to? })` | 새 메일: 계정 설정에 따라 위젯의 **메일 쓰기 창**(기본, #68), **메일 프로그램(mailto)** 또는 **웹메일** → `{ ok: true, via: 'widget' \| 'mailto' \| 'webmail' }`. `to`는 메일 주소 하나(잘못된 값은 버림) | 거절 | **예** |
| `api.setCategories(id, [categoryId, …])` | 그 메일을 **정확히** 이 분류들에(빈 배열 = 분류 없음, 모르는 id는 버림) → `{ ok: true, categoryIds }` | 거절 | **예** |
| `api.createCategory(name, color?)` | 새 분류(이름 30자, 같은 이름 불가, 50개까지, 색 `#rrggbb` 선택) → `{ ok: true, category, categories }` / `{ ok: false, message }` | 거절 | **예** |
| `api.filter(categoryId)` / `api.filter({ accountId?, unread?, flagged?, category? })` | 목록 거르기. 문자열이면 분류만(#69, 나머지는 풀림), 객체면 계정 하나·안 읽음만·중요만·분류를 함께(#72). 모르는 값은 "전체". 위젯이 기억하므로 `list()`·`loadMore()`도 같은 거르기, 계정을 고르면 **더 보기는 그 계정만** 더 불러옴. **안 읽음·중요**는 서버의 목록(#83: 받은편지함과 함께 볼 메일함의 UID SEARCH UNSEEN / FLAGGED, 불러오지 않은 오래된 메일은 위젯이 머리글을 받아 옴, 처음 계정·메일함마다 최근 200통, `loadMore()`로 더) — 거르기 직후 목록이 몇 번 늘어날 수 있어 `messages` 이벤트마다 다시 부르면 됨. **분류** 거르기는 **불러온 메일 중**에서 → `list()`와 같은 값 + `category`, `filter` | 실행 | |
| `api.reply(id, { all? })` | 답장 / `all: true`면 전체 답장(내 주소 제외). 쓰기 창에는 원래 메일이 온 계정, 인용, Re:, 대화 머리글이 채워짐 → 같음 | 거절 | **예** |
| `api.forward(id)` | 전달(원문, 원본 첨부는 20MB 안이면 함께) → 같음 | 거절 | **예** |

- 쓰기 창은 **위젯의 창**입니다(테마 안이 아님). 받는 사람·본문·첨부·보내는 계정은 테마가 볼 수 없고, 보내기·실패 알림·다시 열기도 위젯이 합니다. 테마는 `getState()`의 `sending`(보내는 중인 메일 수)과 `lastSent`(`{ ok, subject, at, sentFolder?, note?, message? }`)로 "보내는 중"·"보냈습니다"를 보여 줄 수 있습니다.
- `via: 'mailto'`·`'webmail'`로 끝났을 때만 아래 `note`·`fallback`이 의미가 있습니다.
- `compose`·`reply`·`forward`에 `via: 'widget' | 'webmail' | 'mailto'`를 주면 이번 한 번만 계정 설정 대신 그 방법으로 씁니다(`reply(id, { all, via })`, `forward(id, { via })`, `compose({ accountId, to, via })`).
- 성공 결과에는 `note`(그대로 보여 줄 문구)가 올 수 있습니다: 메일 프로그램으로 넘겼을 때 "아무 창도 뜨지 않으면…"(Windows가 링크를 받고도 아무것도 열지 않는 경우는 위젯이 알 수 없음), 메일 프로그램이 없어 웹메일로 열었을 때. `via: 'mailto'`로 끝났으면 "웹메일로 쓰기"를 함께 보여 주면 좋습니다.
- Windows가 메일 프로그램(또는 브라우저)을 열지 못하면(예: 기본 메일 앱이 정해지지 않음) `{ ok: false, message, fallback }`이 옵니다. `fallback`이 `'webmail'`(또는 `'mailto'`)이면 "웹메일로 쓰기" 같은 버튼을 보여 주고, **그 버튼의 클릭 안에서** 같은 호출을 `via: fallback`으로 다시 부르세요. 실패를 숨기지 마세요.
- 실패는 `{ ok: false, message }`(예: "메일을 찾지 못했습니다…")를 그대로 보여 주면 됩니다.
- **클릭·키 입력 필요**: 버튼의 `click`(또는 Enter 키) 처리기 안에서 바로 부르세요. 타이머나 긴 `await` 뒤에 부르면 거절될 수 있습니다.
- 테마가 넘기는 값은 메일 id(64자 이하 문자열)와 계정 id뿐이고, 위젯이 다시 확인합니다. URL·주소는 받지 않습니다(`compose`의 `to`만 예외, 메일 주소 형식만).

## 6. 이벤트

| 이벤트 | 값 | 테마가 할 일 |
|---|---|---|
| `changed` | `getState()`와 같은 값 | 계정·안 읽음 수를 다시 그림 |
| `messages` | `{ count, hasMore }` | `api.list()`를 다시 부름(분류가 바뀌어도 옴) |
| `reveal` | `{ id }` | 알림 카드의 **열기**: 그 메일을 보여 줌(`api.get(id)`; 위젯이 이미 읽음으로 표시함) |

오른쪽 클릭 메뉴(엔진이 띄움): 지금 새로고침 · 새 메일 쓰기 · 새 메일 알림 · 항상 위에 표시 · 테마 + 엔진 항목(설정·위젯 관리·이 위젯 끄기·종료).

## 7. 버전

| 버전 | 내용 |
|---|---|
| 1 | 최초 규격 (#65, 메일 위젯 0.0.1, 2026-10-19). 같은 버전에 추가: 계정 대시보드용 숫자·거르기(#72: `accounts[].flagged·loaded·categories·latest·email`, `filter`, `counts`, `filter({ … })`), 위젯에서 보내기(#68: `via: 'widget'`, `sending`, `lastSent`), 분류(#69: `categories`, `categoryFilter`, `categoryIds`, `setCategories`, `createCategory`, `filter`), 안 읽음·중요 거르기가 서버 목록(#83, 필드 변경 없음), 함께 볼 메일함(#80: 메일 `folder`·`folderKey`와 메일함이 들어간 `id`, `accounts[].folders`, `latest[].folder`, `unread`에 메일함 포함) |

같은 버전 안에서는 필드·호출·이벤트를 **추가만** 합니다([공통 8장](THEME_SPEC.md)). 이후 예정: Outlook 클래식(#66)·OAuth 계정(#67)도 같은 목록에 들어옴(규격 변경 없이).
