# 앱 안에서 업데이트 (#104)

엔진(Desk Widgets) 1.1.0부터 엔진과 설치한 위젯의 새 버전을 앱이 알려 주고, 사용자가 누르면 설치 파일을 받아 실행합니다. **자동으로 설치하지 않습니다.** 사용법은 [사용자 가이드](user-guide.md#업데이트), 접속하는 곳은 [개인정보 안내](privacy.md)에 있습니다.

## 결정 (2026-10-24, 사용자)

| 결정 | 내용 |
|---|---|
| 설치는 수동 | 앱은 새 버전이 있다고 알리기만 합니다. 내려받기와 설치는 사용자가 **업데이트**를 눌렀을 때만. 위젯 관리 창에 **업데이트 확인** 버튼 |
| 확인은 기본 켜기 | 위젯 관리 창 → 일반 설정 → **업데이트 확인**에서 끌 수 있음. 꺼도 **업데이트 확인** 버튼은 동작 |
| 버전 | 이 기능을 넣으며 엔진과 모든 위젯을 한 번 1.1.0으로 맞춤. 이후는 제품별로 바뀐 것만 올림 |

## 정보의 출처: products.json

앱은 다운로드 페이지가 쓰는 `https://widgets.chilgong88.com/products.json`을 읽습니다. 제품마다 **배포된 설치 파일** 정보(`download`)가 붙습니다.

```json
{
  "engine": { "id": "engine", "version": "1.1.0", "engineApi": "1.6",
    "download": { "version": "1.1.0", "tag": "engine-v1.1.0", "file": "DeskWidgets-Setup-1.1.0.exe",
      "url": "https://github.com/Htaeyong/desk-widgets/releases/download/engine-v1.1.0/DeskWidgets-Setup-1.1.0.exe",
      "size": 91234567, "sha256": "<64자리 16진수>" } },
  "widgets": [ { "id": "dooray", "version": "1.0.3", "engineApi": "1.1", "engineMin": "1.0.0", "download": { ... } } ]
}
```

- `download`는 **`scripts/release.js`가 GitHub에 올린 바로 그 파일**에서 계산한 크기·SHA-256입니다. 릴리스가 끝나면 `site/releases.json`에 제품별로 기록하고, `npm run site:build`가 이것을 `products.json`에 넣습니다(`release:all`은 끝에 사이트를 배포).
  - 이미 올라가 있는 릴리스를 다시 실행하면(`complete`), GitHub가 알려 주는 파일 해시(`digest`)가 로컬 파일과 같을 때만 기록합니다. 다르거나 알 수 없으면 기록하지 않고 경고합니다.
- `version`(위젯 매니페스트 버전)과 `download.version`(실제로 배포된 버전)은 다를 수 있습니다(버전을 올렸지만 아직 배포 전). 앱은 **`download.version`만** 봅니다. `download`가 없는 제품은 "업데이트 정보 없음"으로 건너뜁니다.
- 다운로드 페이지(`app.js`)는 지금처럼 GitHub API로 최신 릴리스를 고르고 `download`는 쓰지 않습니다.

## 확인

- 시작 2분 뒤 한 번, 실행 중에는 **마지막 확인 뒤 24시간이 지나면**(1시간마다 검사, 절전 뒤에도 맞게) 다시 확인합니다. 설정에서 끄면 자동 확인은 하지 않습니다.
- 위젯 관리 창의 **업데이트 확인** 버튼은 설정과 상관없이 바로 확인합니다.
- 비교: 버전은 `주.부.수`(숫자) 비교에 semver 사전 릴리스 규칙을 더합니다(#109): `1.1.1-test.1` < `1.1.1-test.2` < `1.1.1`. 엔진은 `package.json` 버전, 위젯은 설치된 `widget.json` 버전(개발 폴더 `--widget`로 불러온 위젯은 제외).
- **내부 테스트 버전은 절대 제안하지 않습니다**(#109): `products.json`에 사전 릴리스 버전(`-test.N` 등)이 있으면 그 항목은 버립니다(`engineMin`도 같음). 사이트는 원래 사전 릴리스를 싣지 않습니다([다운로드 페이지](site.md#내부-테스트-버전-109)).
- 테스트 빌드를 설치한 PC: `1.1.0` 위에 `1.1.1-test.1`을 설치하면, 사이트가 아직 `1.1.0`이므로 "최신"으로 보이고 낮은 버전을 제안하지 않습니다. 정식 `1.1.1`이 사이트에 오르면 `1.1.1-test.1`보다 새 버전이므로 **업데이트**로 제안되고 그대로 덮어 설치됩니다(엔진·위젯 설치 프로그램은 버전 순서를 검사하지 않으므로 어느 방향이든 설치 가능).
- 위젯 새 버전이 더 새 엔진을 요구하면(`engineMin`이 현재 엔진보다 높거나 `engineApi`를 이 엔진이 지원하지 않음) 설치 버튼 대신 **엔진을 먼저 업데이트**를 표시합니다.
- 보내는 것: `products.json` 요청 하나(HTTPS GET, 쿠키·식별자 없음). 설치한 위젯 목록이나 버전은 보내지 않습니다.

## 알림

- 새 버전이 처음 보이면 알림 카드 하나(엔진 일반 카드, "Desk Widgets 업데이트")와 버튼 **업데이트 보기**(위젯 관리 창 열기). 같은 버전은 다시 알리지 않습니다(`<userData>/updates.json`에 알린 버전 기록).
- 업데이트가 있는 동안 트레이 메뉴 맨 위에 **업데이트 있음 (N)**.
- 위젯 관리 창의 **업데이트** 칸: 제품마다 현재·최신 버전, **업데이트** 버튼, 진행률(내려받는 중 n%, 확인 중, 설치 프로그램 실행), 오류.

## 설치

1. **내려받기**: HTTPS만, 시작 주소는 `https://github.com/Htaeyong/desk-widgets/releases/download/…`만 허용. 리디렉션은 직접 따라가며(최대 5번) 매번 호스트를 확인합니다: `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`. 다른 곳으로 가면 중단합니다.
2. 임시 폴더(`%TEMP%\desk-widgets-update\<임의 이름>\`)에 저장하면서 크기를 셉니다. `products.json`의 크기를 넘으면 바로 중단합니다.
3. **확인**: 크기와 SHA-256이 `products.json`과 다르면 파일을 지우고 "파일 확인 실패"를 보여 줍니다. 실행하지 않습니다.
4. (서명 확인 자리) `REQUIRE_SIGNATURE`가 켜지면 Authenticode 서명자 확인을 통과해야 실행합니다. 지금은 꺼짐(아래).
5. **실행**: Windows 셸로 설치 파일을 엽니다(Electron `shell.openPath`, 인자·명령 문자열 없음). 설치 파일은 관리자 권한이 필요하므로 Windows가 **UAC 확인 창**을 띄웁니다. 사용자가 거부하면 "설치를 취소했습니다".
   - **엔진**: 설치 프로그램이 시작되면 1.5초 뒤 앱을 종료합니다. electron-builder NSIS 설치 프로그램은 설치 단계에서 실행 중인 앱을 찾아 닫으라고 묻고 PowerShell/taskkill로 닫으므로, 앱이 먼저 스스로 종료해 그 단계를 피합니다. 설치가 끝나면 설치 프로그램이 앱을 다시 실행합니다(`runAfterFinish`). 설정과 위젯은 그대로입니다.
   - **위젯**: 위젯 설치 프로그램이 폴더를 바꾸고 `--widget-installed=<id>`로 실행 중인 엔진에 알립니다. 엔진은 `WidgetWatcher`(폴더 감시)와 이 신호로 위젯을 다시 불러옵니다(`widget.json`의 수정 시각이 바뀌어 `updated`). 앱은 종료하지 않습니다.
6. 임시 파일은 다음 실행 때 지웁니다(설치 프로그램이 실행 중일 수 있어 바로 지우지 않음).

### 처음 설치할 때 위젯 고르기 (#96)

설치하지 않은 위젯도 같은 경로(`UpdateManager.install(id)`: 허용 주소, 크기·SHA-256 확인, `shell.openPath`)로 설치합니다. `engine/main/widget-picker.js`의 `WidgetPicker`가 목록과 순차 설치를 맡고, 위젯 관리 창의 **위젯 추가**가 화면입니다. 설계 [묶음 설치 설계](bundle-install-design.md).

- 목록: `products.json`의 위젯 중 **정식 배포된 것만**(`0.0.x`·사전 릴리스·`frozen` 위젯·설치 파일 없는 것은 제외). 엔진이 요구 버전보다 낮으면 "엔진 업데이트 필요". 기본 체크는 시계·캘린더·할 일 노트.
- 합쳐진 위젯(#117, `products.json` `"merged": { since, successor }`, 할 일 목록·스티키 노트 → 할 일 노트): 목록 맨 끝에 제목 줄 "…로 합쳐진 위젯 (계속 설치할 수 있음)"과 함께 "새 버전 없음"으로 나오고 고를 수 있습니다(기본 체크 안 함). 업데이트 목록에서는 예전 버전이면 마지막 버전을 보통 업데이트로 주고, 마지막 버전이면 "새 버전 없음" + "…로 합쳐진 위젯입니다"와 후속 위젯 설치 버튼(`frozen`과 같은 안내). 설치된 위젯 목록에도 "…로 합쳐짐" 배지(업데이트 확인 뒤). 엔진 1.1.1 이하는 `merged`를 몰라 예전처럼 보통 위젯으로 보입니다.
- 순서: 고른 위젯을 하나씩 내려받아 실행하고, 위젯이 폴더에 나타나면(폴더 감시) 다음 위젯으로 갑니다. 5분 안에 나타나지 않으면(관리자 확인 창을 취소) "설치가 끝나지 않았습니다"로 두고 다음 위젯으로 넘어가며, **다시 시도 / 건너뛰기**를 줍니다.
- 한 위젯이 실패(네트워크·해시 불일치)해도 나머지는 계속합니다.
- 내려받은 설치 파일 열기: `DeskWidgets-<위젯>-Setup-<버전>.exe` 이름의 파일만, 임시 폴더로 복사한 뒤 그 사본을 확인·실행합니다. `products.json`을 받을 수 있으면 게시된 SHA-256과 같을 때만, 받을 수 없으면(오프라인) 확인할 수 없다는 경고에 사용자가 동의해야 실행합니다.
- 첫 실행 판단: 설치된 위젯이 없고 설정 `onboardingDone`이 없을 때 위젯 관리 창을 열면서 `onboardingDone`을 켭니다(그 한 번만).
- 시험: `node scripts/picker-e2e.js`(진짜 위젯 설치 파일을 만들어 로컬 서버로 목록·설치 순서·해시 불일치·사이트 불통을 확인, 설치 프로그램은 열지 않음).

### 왜 `spawn`이 아니라 `shell.openPath`인가

관리자 권한을 요구하는 exe(`requireAdministrator`)는 `CreateProcess`(Node `spawn`)로 실행할 수 없습니다(오류 740). Windows에서 UAC 확인 창을 거쳐 실행하는 표준 방법은 셸 실행(`ShellExecuteEx`)이고, Electron `shell.openPath`가 이것입니다. 명령 문자열이나 PowerShell은 쓰지 않고, 확인을 마친 파일 경로 하나만 넘깁니다.

### 서명자 확인 (SignPath 승인 뒤)

`engine/main/updates.js`의 `REQUIRE_SIGNATURE`(기본 `false`)와 `verifyPublisher()`가 그 자리입니다. 서명이 시작되면 Authenticode 서명과 게시자(SignPath Foundation 인증서의 주체)를 확인하도록 구현하고 켭니다. 켜져 있는데 확인을 구현하지 않았으면 설치하지 않습니다. 확인 방법은 PowerShell(`Get-AuthenticodeSignature`)이나 네이티브 호출 대신 별도 검토가 필요합니다([코드 서명](code-signing.md) §점검).

## 시험 모드 (개발 전용)

패키지 빌드(`app.isPackaged`)에서는 무시합니다.

| 환경 변수 | 뜻 |
|---|---|
| `DESK_WIDGETS_UPDATE_URL` | `products.json` 주소를 바꿈(예: `http://127.0.0.1:5077/products.json`). 이때 `127.0.0.1`·`localhost`의 **http** 내려받기 주소도 허용 |
| `DESK_WIDGETS_UPDATE_DRY_RUN=1` | 확인까지 하고 설치 프로그램은 실행하지 않음(실행할 경로만 기록) |

`node scripts/update-e2e.js`는 로컬 서버에 가짜 `products.json`과 실제로 빌드한 위젯 설치 파일을 올려 내려받기·해시 확인·실행 직전까지 확인합니다(해시가 틀린 경우와 허용하지 않는 호스트도).

## 코드

| 파일 | 역할 |
|---|---|
| `engine/main/updates.js` | 버전 비교, products.json 검사, 호스트 허용 목록, 내려받기·해시 확인, 업데이트 목록 계산, 스케줄러, `UpdateManager` |
| `engine/main/main.js` | 설정·알림·트레이·위젯 관리 창 연결, 설치 프로그램 실행 |
| `engine/renderer/settings.*` | 업데이트 칸과 설정 |
| `scripts/release.js`, `scripts/site-build.js` | `site/releases.json` 기록, `products.json`의 `download` |
| `engine/test/updates.test.js` | 단위 테스트 |
