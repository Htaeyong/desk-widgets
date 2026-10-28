# Google 로그인(OAuth) 준비와 앱 확인 신청

캘린더 위젯의 **Google 계정 추가**(#114)에 필요한 Google Cloud 설정을 처음부터 정리한 문서입니다. 코드가 하는 일은 [사용자 가이드의 Google 계정 연결](user-guide.md#google-계정-연결-114)과 [개인정보 안내](privacy.md)에, 결정 이유는 정책과 합의사항의 #114 행에 있습니다.

**하는 사람**: 개발자(저장소 주인). Google Cloud 콘솔에서 직접 합니다. 클라이언트 ID·보안 비밀은 `.env`에만 넣고 커밋·채팅·이슈에 붙이지 않습니다.

## 1. 위젯이 쓰는 것 (신청서에 적을 내용)

| 항목 | 값 |
|---|---|
| OAuth 클라이언트 유형 | **데스크톱 앱(Desktop app)** |
| 로그인 방식 | 사용자의 기본 브라우저(`shell.openExternal`), 리디렉션은 루프백 `http://127.0.0.1:<임의 포트>/callback`, PKCE(S256)·state 확인, 5분 제한. 앱 안 웹뷰 로그인 없음 |
| 사용 API | **Google Calendar API**(v3, REST). CalDAV API는 쓰지 않음 |
| 요청 범위(scope) | `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events` |
| 범위가 이 둘인 이유 | 캘린더 목록 보기(읽기 전용)와 일정 보기·만들기·고치기·지우기만 필요. 캘린더 공유(ACL)·캘린더 만들기/지우기·설정은 쓰지 않으므로 전체 권한 `calendar`는 요청하지 않음. 공휴일·공유받은 캘린더의 일정도 보여 주므로 `calendar.events.owned`(내 캘린더만)로는 부족 |
| 이메일 주소 | 별도 범위(`email`, `openid`) 없이 기본 캘린더의 id(= 계정 이메일)로 계정 이름을 표시 |
| 토큰 보관 | 새로 고침 토큰은 이 PC의 Windows 데이터 보호(DPAPI) 암호화 저장소에만, 접근 토큰은 메모리에만. 개발자 서버 없음, 다른 곳으로 보내지 않음 |
| 계정 삭제 | 위젯에서 계정을 지우고 저장하면 `https://oauth2.googleapis.com/revoke`로 연결을 끊고 토큰을 지움 |

> 확인한 날: 2026-10-27, Google 문서 [Calendar API 범위](https://developers.google.com/workspace/calendar/api/auth)·[CalDAV 가이드](https://developers.google.com/workspace/calendar/caldav/v2/guide). CalDAV는 범위 목록에 좁은 범위가 없고(전체 `calendar` 권한이 필요) 캘린더 목록을 알려 주는 방법이 없어 쓰지 않았습니다.

## 2. Google Cloud 프로젝트: 기존 `desk-widgets-chilgong88`

새 프로젝트를 만들지 않고, 다운로드 페이지(widgets.chilgong88.com)를 올리는 Firebase 프로젝트 **`desk-widgets-chilgong88`**(표시 이름 "Desk Widgets", 조직 없음)를 그대로 씁니다(팀장 결정 2026-10-27). 홈페이지 도메인과 같은 프로젝트라 도메인 확인·브랜딩이 한곳에 모입니다. 콘솔은 그 프로젝트 소유자 계정으로 엽니다.

1. [Google Cloud 콘솔](https://console.cloud.google.com/)에 소유자 계정으로 로그인 → 위쪽 프로젝트 선택에서 **`desk-widgets-chilgong88`**.
2. 왼쪽 메뉴 **API 및 서비스 → 라이브러리** → `Google Calendar API` 검색 → **사용**. 위젯이 쓰는 API는 이것 하나입니다.
   - CalDAV API는 위젯이 쓰지 않습니다. 켜 두어도 해는 없지만 필요 없으므로 꺼도 됩니다(**API 및 서비스 → 사용 설정된 API** → CalDAV API → 사용 중지).
   - Firebase Hosting이 쓰는 API는 그대로 둡니다.

> 상태(2026-10-27): 이 프로젝트에 Google Calendar API·CalDAV API 사용, 동의 화면 외부·테스트, 데스크톱 OAuth 클라이언트 "Desk Widgets Calendar"까지 만들어 둠. 아래 3·4장은 같은 설정을 다시 확인할 때와 범위(3장 3번)를 맞출 때 봅니다.

## 3. OAuth 동의 화면 (Google 인증 플랫폼)

콘솔 메뉴 **Google 인증 플랫폼(Google Auth Platform)** 또는 **API 및 서비스 → OAuth 동의 화면**.

1. **브랜딩**
   - 앱 이름: `Desk Widgets`
   - 사용자 지원 이메일: 개발자 이메일
   - 앱 로고: 선택(로고를 올리면 확인 심사에 로고 확인이 추가됨. 처음에는 비워 두는 것이 빠름)
   - 앱 홈페이지: `https://widgets.chilgong88.com/`
   - 개인정보처리방침: `https://widgets.chilgong88.com/privacy.html` (**아직 없음**, 아래 6장)
   - 서비스 약관: 선택
   - 승인된 도메인: `chilgong88.com`
   - 개발자 연락처 이메일: 개발자 이메일
2. **대상(Audience)**: 사용자 유형 **외부(External)**. 처음에는 게시 상태가 **테스트**입니다.
   - 테스트 상태에서는 **테스트 사용자**로 넣은 Google 계정(최대 100개)만 로그인할 수 있고, **새로 고침 토큰이 7일 뒤 만료**됩니다(위젯에는 "다시 로그인"으로 보임). 내부 테스트 동안은 이대로 씁니다.
3. **데이터 액세스(범위)** → **범위 추가 또는 삭제** → 아래 두 개만 체크(목록에 없으면 "수동으로 범위 추가"에 붙여 넣기) → 저장
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - 둘 다 **민감한 범위(sensitive)** 로 분류되어, 일반 공개 전에 확인(verification)이 필요합니다.
4. **대상 → 테스트 사용자**에 내부 테스트에 쓸 Google 계정을 추가합니다.

## 4. OAuth 클라이언트 만들기

1. **Google 인증 플랫폼 → 클라이언트**(또는 **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**)
2. 애플리케이션 유형: **데스크톱 앱**. 이름: `Desk Widgets Calendar`.
   - 리디렉션 URI는 넣지 않습니다(데스크톱 앱은 루프백 `127.0.0.1`의 아무 포트를 Google이 허용).
3. 만들기 → **클라이언트 ID**와 **클라이언트 보안 비밀번호**가 나옵니다. JSON을 내려받아 안전한 곳에 둡니다(저장소 밖).
   - 데스크톱 앱의 보안 비밀은 설치 파일 안에 들어가므로 Google도 "비밀로 취급하지 않음"이라고 안내합니다. 그래도 저장소·공개본에는 넣지 않습니다.

## 5. `.env`에 넣고 빌드

저장소 루트의 `.env`(커밋하지 않는 파일)에:

```
GOOGLE_OAUTH_CLIENT_ID=<클라이언트 ID>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_PW=<클라이언트 보안 비밀번호>
```

- 위젯을 빌드하면(`npm run widget -- widgets/calendar`, `npm run dist:widgets`, 릴리스 도구) 위젯 키트가 먼저 `widgets/calendar/scripts/google-client.js`를 실행해 `widgets/calendar/google-client.json`(git이 무시하는 파일)을 만들고, 그 파일이 설치 파일에 들어갑니다. 값은 화면에 출력하지 않습니다. 두 값이 없으면 그 파일을 지우고 **Google 로그인 없이** 빌드합니다(설정 창에 "Google 계정 로그인은 아직 준비 중" 안내).
- **정식 버전(X.Y.Z)에는 넣지 않음**: 앱 확인 전에는 테스트 사용자만 로그인할 수 있으므로, 스크립트는 **내부 테스트 버전(`-test.N`처럼 `-`가 있는 버전)** 을 빌드할 때만 파일을 만들고, 정식 버전 빌드에서는 값이 있어도 파일을 지웁니다. 빌드 버전은 위젯 키트가 넘기는 `WIDGET_KIT_VERSION`(없으면 `widget.json`). **확인(7장 신청)이 끝난 뒤** 정식 버전에 넣으려면 빌드 환경에 `GOOGLE_OAUTH_RELEASE=1`을 줍니다(GitHub Actions라면 `release.yml`의 env에 추가).
- 개발 실행(`npm start`)에서 쓰려면 한 번 `node widgets/calendar/scripts/google-client.js`를 실행합니다.
- **GitHub Actions 빌드**(공개 설치 파일)도 쓰려면 GitHub 저장소 → Settings → Secrets and variables → Actions → **New repository secret**으로 `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_PW`을 넣습니다. 워크플로(`release.yml`)가 이 값을 빌드 환경으로 넘깁니다. 넣지 않으면 공개 빌드는 Google 로그인 없이 나옵니다. 넣어도 `GOOGLE_OAUTH_RELEASE=1`이 없으면 정식 버전 빌드에는 들어가지 않습니다(위).
- 공개본 내보내기(`node scripts/publish-github.js`)는 `.env`의 `GOOGLE_OAUTH_CLIENT_ID`·`GOOGLE_OAUTH_CLIENT_PW` 값이 어떤 파일에든 있으면 멈춥니다. `google-client.json`은 git에 없으므로 내보내기에 들어가지 않습니다.

## 6. 확인(verification) 신청 전에 준비할 것

일반 공개(테스트 사용자가 아닌 누구나 로그인, 토큰 7일 만료 없음)에는 **게시 상태를 "프로덕션"으로 바꾸고 확인**을 받아야 합니다. 민감한 범위라 Google 심사(보통 수 일~수 주, 질문 메일이 올 수 있음)가 있습니다. 제한된 범위(restricted)는 쓰지 않으므로 보안 평가(CASA)는 필요 없습니다.

1. **도메인 소유 확인**: [Google Search Console](https://search.google.com/search-console)에서 `widgets.chilgong88.com`(또는 `chilgong88.com`) 소유 확인. 클라우드 프로젝트의 소유자 계정과 같은 계정이어야 합니다(#106에서 이미 했으면 그 계정 확인).
2. **개인정보처리방침 페이지**를 `https://widgets.chilgong88.com/privacy.html`에 올립니다. 지금 다운로드 페이지는 GitHub의 `docs/privacy.md`로 연결하지만, Google은 **승인된 도메인 위의** 방침 주소를 요구합니다. 내용은 [개인정보 안내](privacy.md)를 바탕으로 하고 다음 문장을 꼭 넣습니다(영문 병기 권장).
   - 어떤 Google 데이터를 쓰는지(캘린더 목록, 일정), 어디에 두는지(이 PC, 암호화), 누구에게도 보내지 않음, 사용자가 계정을 지우면 Google에서 연결을 끊음, Google 계정 설정(<https://myaccount.google.com/permissions>)에서도 끊을 수 있음.
   - **Limited Use 공개 문구**(그대로): "Desk Widgets' use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements."
   - 홈페이지(`index.html`)에도 이 방침으로 가는 링크와 앱이 Google 캘린더로 무엇을 하는지 한두 문장이 보여야 합니다.
3. **범위 사용 이유**(신청서의 "범위 근거" 칸, 영문 예시):
   - `calendar.calendarlist.readonly`: "Desk Widgets is a Windows desktop calendar widget. After the user signs in, it lists the user's calendars so the user can choose which ones to show on the desktop widget. Read-only; the app never changes the calendar list."
   - `calendar.events`: "The widget shows the events of the calendars the user chose, including subscribed and shared calendars such as public holidays, and lets the user create, edit and delete events on calendars they can write to, directly from the desktop widget. calendar.events.owned is not enough because events of shared/subscribed calendars must be shown. Data stays on the user's PC; there is no server of ours."
4. **시연 영상**(YouTube 비공개 링크, 2~4분, 영어 자막 또는 설명):
   1. 설치된 Desk Widgets 캘린더 위젯과 설정 창을 보여 줌
   2. **+ Google 계정 추가** → 기본 브라우저에 Google 동의 화면이 열리는 장면(**주소창에 OAuth 클라이언트 ID가 보이도록** 확대)
   3. 동의 화면의 앱 이름·요청 범위 두 개를 보여 주고 허용 → "로그인이 끝났습니다" 페이지
   4. 설정 창에 계정 이메일과 캘린더 목록 → 캘린더 선택·저장 → 위젯에 일정이 나타남(목록 범위 사용)
   5. 위젯에서 일정 만들기·고치기·지우기 → Google 캘린더 웹에서 같은 변경이 보임(이벤트 범위 사용)
   6. 설정 창에서 계정 삭제 → 저장 → Google 계정의 "타사 앱 연결"에서 사라진 것 확인
5. **앱 이름·로고 일관성**: 동의 화면의 앱 이름(`Desk Widgets`)이 홈페이지·설치 파일 이름과 같아야 합니다.
6. 신청: **Google 인증 플랫폼 → 확인 센터(Verification Center)** → **앱 게시(프로덕션으로 푸시)** → 확인 준비 → 제출. 심사 중에도 테스트 사용자는 계속 쓸 수 있습니다.

## 7. 알아 둘 제한

- 테스트 상태: 테스트 사용자만, 새로 고침 토큰 7일. 위젯은 만료되면 계정에 "다시 로그인"을 띄우고 마지막으로 받은 일정을 계속 보여 줍니다.
- 한 Google 계정·클라이언트당 새로 고침 토큰은 최대 100개(오래된 것부터 무효). 여러 PC에서 같은 계정을 쓰면 PC마다 하나씩 씁니다. 한 PC에서 계정을 지우면(연결 끊기) 같은 계정을 쓰는 **다른 PC의 로그인도 끊어집니다**(Google은 연결 단위로 끊음). 동기화로 계정 항목이 함께 지워지므로 보통은 문제가 없습니다.
- 할당량: Calendar API 기본 할당량(프로젝트 하루 요청 수, 사용자별 분당 요청 수)을 위젯이 15분마다(설정) 캘린더마다 1번 씁니다(지난번 목록의 ETag로 조건부 요청을 보내지만, Google이 목록에 304를 주는지는 실제 계정으로 아직 확인하지 못함). 사용자가 많아지면 콘솔 **API 및 서비스 → Google Calendar API → 할당량**을 확인합니다.
