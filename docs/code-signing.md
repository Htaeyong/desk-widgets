# 코드 서명과 백신 오탐 대응

공개 배포하는 설치 파일이 Windows SmartScreen의 "알 수 없는 게시자" 경고나 백신(Microsoft Defender, AhnLab V3)의 오탐에 걸리지 않게 하기 위한 정책과 절차입니다. 예산 없이 무료 방법만 씁니다: 오픈소스 프로젝트에 무료로 코드 서명을 해 주는 **SignPath Foundation**에 신청하고, 설치 파일은 검증 가능한 **GitHub Actions**(GitHub 호스팅 Windows 러너)에서 빌드합니다.

> 표시: **(미확인)** 은 SignPath·Microsoft·AhnLab 공식 문서에서 직접 확인하지 못한 부분입니다. 신청·설정할 때 실제 화면과 비교하세요. (확인 기준일 2026-10-23)

## 1. Code signing policy (코드 서명 정책)

SignPath Foundation은 프로젝트 홈페이지와 다운로드·릴리스 페이지에 **"Code signing policy"** 라는 이름으로 정책을 공개하도록 요구합니다. 신청서의 Download URL 항목이 "이 페이지에 SignPath Foundation으로 서명한다는 내용이 있을 것"을 요구하므로, 신청 전(2026-10-24)에 README와 다운로드 페이지(widgets.chilgong88.com)에 **신청 중** 문구로 아래 정책을 실었습니다("신청했고, 승인되면 SignPath가 서명하며, 지금 설치 파일은 서명 전"). 승인되면 신청 중 문장을 빼고 아래 영문 그대로로 바꿉니다.

```markdown
## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [@Htaeyong](https://github.com/Htaeyong)
- Approvers: [@Htaeyong](https://github.com/Htaeyong)

Only installers built by this repository's GitHub Actions workflow (`.github/workflows/release.yml`) from a release tag
are signed; every signing request is approved by hand. Locally built files are never signed.

Privacy: Desk Widgets does not transfer any information to other networked systems unless the user configures it
(for example a Dooray, mail or calendar account). See [docs/privacy.md](docs/privacy.md).
```

| 항목 | 정책 |
|---|---|
| 서명 대상 | 이 저장소 소스로 만든 것만: 엔진 앱 exe(`Desk Widgets.exe`), 엔진·위젯 **설치 파일**, 그 안의 **제거 프로그램**. Electron 런타임 DLL, koffi 네이티브 모듈, electron-builder의 `elevate.exe` 같은 제3자 파일은 서명하지 않습니다(SignPath 규칙: 상위 프로젝트 파일은 그쪽이 서명) |
| 서명하는 빌드 | GitHub Actions `Build installers` 워크플로가 **릴리스 태그**(`engine-v<버전>`, `widget-<id>-v<버전>`) 또는 수동 실행으로, GitHub 호스팅 러너에서 만든 결과물만. 태그 버전과 소스 버전(`package.json`, `widgets/<id>/widget.json`)이 다르면 빌드가 실패합니다. 로컬에서 만든 파일(`npm run dist`, `npm run widget`)은 서명하지 않습니다 |
| 역할 | Author(커밋 권한)·Reviewer(외부 기여 검토)·Approver(서명 요청 승인) 모두 저장소 소유자 @Htaeyong. 사람이 늘면 이 표와 README의 정책을 같이 고칩니다 |
| 승인 | 서명 요청은 **매번 Approver가 SignPath에서 직접 승인**합니다. 릴리스 하나에 요청 2건(앱 exe·제거 프로그램 묶음, 설치 파일) |
| 보안 | GitHub과 SignPath 계정 모두 **2단계 인증 필수**. SignPath API 토큰은 GitHub 저장소 Secret에만 두고 파일·로그에 쓰지 않습니다. 빌드 스크립트와 워크플로(`.github/`, `scripts/ci/`, `tools/widget-kit/`, `build/`)의 변경은 소스 변경과 같이 검토합니다 |
| 확인 방법 | 받은 파일 → 속성 → **디지털 서명** 탭에서 서명자가 SignPath Foundation인지 확인. PowerShell: `Get-AuthenticodeSignature .\DeskWidgets-Setup-<버전>.exe` 의 `Status`가 `Valid`. 워크플로도 업로드 전에 같은 검사를 합니다 |

## 2. CI 빌드 (GitHub Actions)

워크플로: [.github/workflows/release.yml](../.github/workflows/release.yml), 보조 스크립트: [scripts/ci/](../scripts/ci).

| 실행 | 동작 |
|---|---|
| 태그 push `engine-v1.0.4` | 엔진 설치 파일 빌드 → 같은 태그의 GitHub Release에 첨부 |
| 태그 push `widget-clock-v1.0.0` | 해당 위젯 설치 파일 빌드 → 첨부 |
| 수동 실행 (Actions → Build installers → Run workflow) | `product`에 `engine` 또는 위젯 id. `release`를 켜면 소스 버전의 태그 릴리스에 첨부, 끄면 실행 결과(Artifacts)에만 둠 |
| 내부 테스트 태그 `*-test.*` (예: `engine-v1.1.1-test.1`) | 실행하지 않음(#109, Gitea 전용). 소스가 테스트 버전일 때 수동 실행은 빌드만 하고 GitHub Release에는 첨부하지 않음 |

- 릴리스 첨부 규칙: 서명을 켜기 전까지는 **릴리스 도구가 로컬 빌드로 올린 설치 파일이 기준**입니다. 그래서 릴리스에 같은 이름의 설치 파일이 이미 있으면 **바꾸지 않고** 알림만 남깁니다(이번 실행의 빌드는 실행 결과 Artifacts에 있음). 설치 파일이 빠져 있으면 올리고, 서명이 켜져 있으면(`SIGNPATH_ENABLED=true`) 서명된 CI 빌드로 바꿉니다. 릴리스가 없으면 **초안(draft)** 으로 만들고 `release-notes/<태그>.md`가 있으면 본문으로 씁니다. 초안은 사람이 읽고 **Publish** 해야 공개됩니다.
- 순서: `npm ci` → Electron 내려받기 → `npm test` → 제품 확인(`scripts/ci/product.js`) → (위젯) NSIS 내려받기 → 빌드(`scripts/ci/build.js`) → (서명) → 실행 결과 보관 → 릴리스 첨부.
- Electron 44는 설치(`npm ci`) 때가 아니라 처음 쓸 때 실행 파일을 내려받으므로, 테스트가 병렬로 동시에 내려받다 충돌하지 않게 먼저 한 번 받습니다(`node node_modules/electron/install.js`).
- 위젯 빌드는 electron-builder가 쓰는 NSIS를 `scripts/ci/fetch-nsis.js`로 같은 버전·체크섬 그대로 받아 `MAKENSIS`·`STDUTILS_PLUGINS`로 넘깁니다(엔진 빌드 불필요). 엔진 빌드는 태그에서 electron-builder가 자동 게시하지 않게 `--publish never`로 실행합니다.

### 서명 흐름 (SIGNPATH_ENABLED=true일 때)

SignPath는 NSIS 설치 파일 **안의** 파일을 직접 서명하지 못하고, 서명은 비동기(사람 승인)이므로 두 번 빌드합니다.

1. **1차 빌드**(`DW_SIGN_MODE=collect`): 서명 훅(`scripts/ci/sign-hook.js`)이 앱 exe와 제거 프로그램을 `dist/sign/unsigned/`로 모읍니다.
   - 엔진: electron-builder의 `win.signtoolOptions.sign` 훅으로 지정(CI에서만, `package.json`은 그대로).
   - 위젯: `WIDGET_KIT_SIGN_HOOK`가 있으면 widget-kit이 제거 프로그램을 먼저 만들고(설치 단계에서 `WriteUninstaller` 하는 대신) 훅에 넘깁니다.
2. 그 묶음을 워크플로 아티팩트로 올리고 SignPath에 서명 요청(아티팩트 설정 `inner`) → 승인 → 서명본을 `dist/sign/signed/`에 받음.
3. **2차 빌드**(`DW_SIGN_MODE=apply`): 엔진은 1차의 `dist/win-unpacked`를 그대로(`--prepackaged`) 다시 포장하며 서명된 앱 exe를 넣고, 훅이 제거 프로그램을 서명본으로 바꿔 끼웁니다. 위젯도 같은 방식.
4. 완성된 설치 파일을 SignPath에 서명 요청(아티팩트 설정 `installer`) → 승인 → 서명 확인(`Get-AuthenticodeSignature`) → 릴리스 첨부.

로컬에서 확인한 것(2026-10-23): 두 번 빌드한 엔진·시계 위젯 설치 파일 안의 앱 exe와 제거 프로그램이 `signed/`에 둔 파일과 **바이트 단위로 같음**(서명 대신 표시를 붙인 파일로 확인). SignPath 실제 서명·승인 대기·GitHub 러너에서의 실행은 **푸시 후에만 확인 가능**합니다.

### 필요한 설정 (이름만; 값은 저장소 설정에만)

GitHub 저장소 → Settings → Secrets and variables → Actions.

| 종류 | 이름 | 내용 |
|---|---|---|
| Variable | `SIGNPATH_ENABLED` | `true`일 때만 서명. 없거나 다른 값이면 서명 없이 빌드·릴리스 |
| Variable | `SIGNPATH_ORGANIZATION_ID` | SignPath 조직 ID |
| Variable | `SIGNPATH_PROJECT_SLUG` | SignPath 프로젝트 slug |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | 서명 정책 slug (예: `release-signing`) |
| Variable | `SIGNPATH_CONFIG_INNER` | (선택) 앱 exe·제거 프로그램용 아티팩트 설정 slug, 기본 `inner` |
| Variable | `SIGNPATH_CONFIG_INSTALLER` | (선택) 설치 파일용 아티팩트 설정 slug, 기본 `installer` |
| Secret | `SIGNPATH_API_TOKEN` | SignPath의 CI 사용자(Submitter 권한) API 토큰 |

워크플로 권한은 `contents: write`(릴리스), `actions: read`(SignPath가 아티팩트를 읽음)이며 기본 `GITHUB_TOKEN`을 씁니다.

### SignPath 아티팩트 설정 (예시, 미확인)

업로드 아티팩트는 zip으로 묶여 전달되므로 루트가 `<zip-file>`입니다. 문법은 SignPath 문서의 `pe-file-set` 형식을 따른 예시이며 실제 설정 화면에서 검증하세요 **(미확인)**.

`inner` (앱 exe + 제거 프로그램):

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file-set>
      <include path="*.exe" max-matches="unbounded" />
      <for-each>
        <authenticode-sign />
      </for-each>
    </pe-file-set>
  </zip-file>
</artifact-configuration>
```

`installer` (설치 파일 1개): 위와 같되 `max-matches="1"`.

SignPath Foundation 조건에는 "서명하는 파일의 제품 이름은 프로젝트 이름, 버전 정보가 일관될 것"이 있습니다. 엔진 파일의 제품 이름은 `Desk Widgets`이고, 위젯 설치 파일은 `Desk Widgets-<위젯 제품명>`(예: `Desk Widgets-ClockWidget`)입니다. 이 차이가 허용되는지는 신청 때 확인합니다 **(미확인)**.

## 3. 사용자가 직접 할 일 (SignPath Foundation 신청)

1. **GitHub 2단계 인증**: GitHub → 오른쪽 위 프로필 → Settings → Password and authentication → **Enable two-factor authentication** (인증 앱 권장, 복구 코드 보관).
2. **신청 전 준비** (SignPath 조건: OSI 라이선스, 활발한 유지보수, 이미 공개된 릴리스, 기능 설명이 다운로드 페이지에 있을 것)
   - 저장소 공개(MIT) 상태 확인.
   - 이 워크플로로 **서명 없는 첫 릴리스**를 GitHub Releases에 공개(조건: "서명할 형태로 이미 릴리스되어 있을 것").
   - 다운로드 페이지와 README에 제품 설명과 개인정보 안내([privacy.md](privacy.md)) 링크가 있는지 확인. Code signing policy 문구(1장)는 승인 후 싣되, 신청서에 "승인되면 게시"라고 적습니다 **(미확인: 신청 시점에 이미 게시해야 하는지)**.
3. **신청**: https://signpath.org/apply 에서 신청서 제출. 신청 양식의 항목은 페이지가 스크립트로 그려져 확인하지 못했습니다 **(미확인)**. 준비해 둘 정보:
   - 프로젝트 이름 `Desk Widgets`, 저장소 `https://github.com/Htaeyong/desk-widgets`, 홈페이지 `https://widgets.chilgong88.com`
   - 라이선스 MIT, 한 줄 설명(Windows 바탕화면 위젯 엔진과 위젯들, Electron), 유지보수자 GitHub 계정
   - 빌드 시스템: GitHub Actions(GitHub 호스팅 `windows-latest`), 워크플로 경로 `.github/workflows/release.yml`
   - 서명 대상: NSIS 설치 파일(엔진 1개 + 위젯 7개), 그 안의 제거 프로그램, 엔진 앱 exe
   - 릴리스 주소 `https://github.com/Htaeyong/desk-widgets/releases`, 개인정보 안내 `docs/privacy.md`
4. **승인 후 설정** (SignPath 화면 이름은 **미확인**, 받은 안내를 우선)
   - SignPath 계정 초대 수락, **SignPath 2단계 인증** 켜기.
   - 프로젝트에 GitHub 저장소를 연결(Trusted build system: GitHub.com). 저장소가 공개이면 SignPath GitHub 앱 설치는 필요 없음(문서 기준).
   - 아티팩트 설정 `inner`, `installer` 만들기(2장 예시), 서명 정책에 Approver 지정.
   - CI용 사용자(Submitter)의 API 토큰을 만들어 GitHub Secret `SIGNPATH_API_TOKEN`에 넣고, Variables(2장 표)를 채운 뒤 `SIGNPATH_ENABLED=true`.
   - Actions에서 수동 실행(`release` 끔)으로 위젯 하나를 시험 → SignPath 요청 2건 승인 → 실행 결과의 설치 파일 서명 확인.
   - README·다운로드 페이지에 Code signing policy 게시.

## 4. 릴리스마다 할 일

1. 내부 테스트(`-test.N`, Gitea 사전 릴리스)를 마친 뒤 정식 버전으로 올리고 커밋 → 태그 push(또는 릴리스 도구) → 워크플로 실행. 테스트 태그는 GitHub에 올리지 않습니다(정책과 합의사항 "단계 배포").
2. 서명이 켜져 있으면 SignPath에서 요청 2건을 **내용을 확인하고** 승인(커밋·태그가 맞는지). 승인 대기는 최대 3시간, 넘으면 실패하므로 다시 실행.
3. 릴리스 초안의 본문·파일 이름 확인 후 Publish.
4. 받은 설치 파일을 [VirusTotal](https://www.virustotal.com/)에 올려 진단 결과 확인(공개 파일이므로 올려도 됨). 특히 Microsoft·AhnLab 결과를 봄.
5. 오탐이 있으면 아래 5장대로 신고하고, 결과를 릴리스 이슈에 기록.
6. SmartScreen은 서명돼 있어도 **새 인증서·새 파일은 평판이 쌓일 때까지** 경고가 날 수 있습니다(설치 수가 늘면 사라짐). 경고가 오래가면 Microsoft에 SmartScreen으로 제출.

## 5. 오탐 신고

### Microsoft (Defender 백신·SmartScreen)

- 주소: https://www.microsoft.com/en-us/wdsi/filesubmission (Microsoft 계정으로 로그인하면 진행 상황을 볼 수 있음)
- 제출자: **Software developer**
- 제품: 진단한 제품을 고름 — 백신이 지우거나 막았으면 **Microsoft Defender Antivirus (Windows 10/11)**, 다운로드·실행 경고면 **Microsoft Defender SmartScreen**
- 파일: **최대 50MB**. 위젯 설치 파일은 바로 제출 가능. 엔진 설치 파일(약 110MB)은 한도를 넘으므로 Defender가 진단한 **그 파일**(진단 기록의 경로)을 제출하고, 설치 파일 자체는 SmartScreen 경고 화면의 신고나 Edge 다운로드 목록의 "이 파일을 안전한 파일로 보고"를 씁니다 **(미확인: 큰 파일의 다른 제출 경로)**. 압축해서 낼 때는 암호 `infected`.
- 판정: **Incorrectly detected as malware/malicious** (PUA로 진단되면 *Incorrectly detected as PUA*)
- 진단 이름(예: `Trojan:Win32/...`), 정의 버전, 추가 설명(영어, 1900자 이내): 오픈소스 저장소 주소, 릴리스 주소, 서명 정보, "built on GitHub Actions from tag ..." 를 적음
- 우선순위는 보통 Low/Medium(High는 긴급 악성코드용)

### AhnLab V3

- 공식 경로: ahnlab.com → **지원(Support) → 위협 문의(Threat Inquiry)** → 로그인 → **의심 파일 제출(Submit Suspicious Files)** 탭. 신고 유형에서 오진(오탐)을 고르고, 파일은 **ZIP으로 압축**해 첨부(첨부당 최대 2GB). 답변은 마이페이지의 신고 내역에서 확인 (AhnLab 도움말 기준, 메뉴 이름은 **미확인**)
- 함께 적을 것: V3 제품·엔진 버전, 진단명, 파일 이름·SHA-256, 릴리스 주소, 오픈소스 저장소 주소, 서명 정보
- 메일 접수 주소로 `v3sos@ahnlab.com` 이 알려져 있으나 커뮤니티 정리 목록 기준이라 **(미확인)**. 공식 양식을 먼저 씁니다.
- 과거에 이 프로젝트의 개발용 스크립트(PowerShell P/Invoke로 키 입력을 흉내 낸 테스트)가 V3에서 트로이목마로 진단된 적이 있습니다. 그 뒤로 데스크톱 입력·화면 자동화 코드는 저장소에 두지 않습니다(6장).

## 6. 백신 오탐 위험 점검 (2026-10-23)

`engine/`, `widgets/`, `build/installer.nsh`, `tools/widget-kit/installer.nsi`를 검색해 백신 휴리스틱이 의심하기 쉬운 동작을 확인했습니다.

| 항목 | 결과 | 판단 |
|---|---|---|
| PowerShell·cmd·스크립트 실행(`child_process`, `nsExec`, `ExecWait`) | 엔진·위젯 런타임에 **없음**. 시스템 모니터도 PowerShell·WMI 없이 koffi/PDH 사용(#74) | 문제 없음 |
| 키보드·마우스 후킹, 입력 흉내(`SetWindowsHookEx`, `SendInput`, `keybd_event`), 전역 단축키 | **없음** | 문제 없음 |
| 화면 캡처(`BitBlt`, `desktopCapturer`) | **없음** | 문제 없음 |
| 원격 코드 다운로드·실행, `eval`/`new Function` | `eval` 없음. **앱 안 업데이트(#104, 아래)** 외에는 내려받아 실행하는 것 없음. 위젯은 관리자만 쓸 수 있는 Program Files에서만 읽고, 사용자 테마는 네트워크·권한이 막힌 별도 세션에서 실행(`connect-src 'none'`) | 문제 없음 |
| Win32 직접 호출(koffi) | `user32`: 전경 창 확인, 창 소유자 바꾸기(바탕화면 고정), 창 위치·가림 확인. `kernel32`: 배터리·드라이브. `pdh`: 성능 카운터. 다른 프로세스 메모리·주입·후킹 없음 | 정당한 용도. koffi 네이티브 모듈(`.node`)은 제3자 파일이라 서명하지 않음 → 오탐 시 이 파일이 대상일 수 있음 |
| 자동 실행 등록(HKCU `...\Run`) | Electron `setLoginItemSettings`로 **사용자가 설정에서 켤 때만**(기본 꺼짐). 제거 시 값 삭제 | 문제 없음(사용자 동의) |
| 설치 프로그램 레지스트리 | HKLM Uninstall 키(제어판 항목)와 엔진 설치 위치 읽기만 | 표준 동작 |
| 설치 후 프로그램 실행 | 위젯 설치 파일이 엔진을 **로그인한 사용자 권한으로** 실행(`StdUtils.ExecShellAsUser`) — 관리자 권한을 넘기지 않음 | 정당 |
| 다른 프로그램 무인 제거 | 두레이 위젯 설치 파일이 예전 앱 "Dooray Widget"의 제거 프로그램을 `/S`로 실행(`widgets/dooray/installer/hooks.nsh`) | 이전 처리용. 예전 앱이 있을 때만 실행. **나중에 제거 후보**(아래) |
| 제거 프로그램이 지우는 범위 | 자기 설치 폴더, 자기 레지스트리 키, 사용자가 "예"를 고른 경우 자기 설정 폴더만 | 문제 없음 |
| 서명 안 된 제3자 실행 파일 | electron-builder의 `resources\elevate.exe` | 아래 검토 항목 |

### 앱 안 업데이트 점검 (#104, 2026-10-24)

"설치 파일을 내려받아 실행"은 드로퍼(dropper) 악성코드와 겉모양이 같아 휴리스틱이 보는 동작입니다. 그래서 다음처럼 만들었습니다.

| 항목 | 방식 | 이유 |
|---|---|---|
| 실행 계기 | 사용자가 위젯 관리 창에서 **업데이트**를 누를 때만. 백그라운드는 버전 정보(`products.json`)만 받음 | 사용자 모르게 받거나 실행하지 않음 |
| 받는 곳 | 고정 주소: 이 저장소의 `github.com/.../releases/download/`에서 시작, GitHub 파일 호스트로의 리디렉션만 허용(매 단계 확인), HTTPS만 | 다른 곳의 파일을 실행할 수 없음 |
| 확인 | 게시된 크기·SHA-256과 다르면 지우고 실행 안 함. 서명이 시작되면 Authenticode 게시자 확인 자리(`REQUIRE_SIGNATURE`) | 바뀐 파일을 실행하지 않음 |
| 실행 방법 | Electron `shell.openPath`(Windows `ShellExecuteEx`)로 파일 하나를 엶 → 표준 **UAC 확인 창**. 명령 문자열·PowerShell·cmd·인자 없음, `child_process` 없음 | 관리자 권한 설치 파일은 `CreateProcess`로 시작할 수 없음(오류 740). 권한 상승을 숨기지 않고 Windows 표준 동의 창을 거침 |
| 금지 | 입력 흉내(`keybd_event`·`SendInput`), 화면 캡처, P/Invoke, 다른 프로세스 종료 없음. 엔진 업데이트 때는 앱이 **스스로** 종료(`app.quit`) | 설치 프로그램이 PowerShell/taskkill로 앱을 닫는 단계를 타지 않게 함 |
| 저장 위치 | `%TEMP%\desk-widgets-update\<임의 폴더>`, 다음 실행 때 삭제. 받은 파일에 인터넷 표시(Zone.Identifier)는 붙이지 않음 | 시작 프로그램·시스템 폴더에 쓰지 않음 |

남은 위험: 서명 전에는 UAC 창에 "알 수 없는 게시자"가 보입니다. 서명이 켜지면 CI가 릴리스의 설치 파일을 서명본으로 바꾸므로, **그 뒤에는 `site/releases.json`의 해시도 서명본 기준이어야** 합니다(릴리스 도구 기록을 서명본에서 다시 하거나 CI가 기록하도록 바꾸기, 서명 시작 때 함께 할 일). 서명자 확인은 PowerShell(`Get-AuthenticodeSignature`) 없이 하려면 WinVerifyTrust 호출이 필요해 그때 따로 검토합니다.

이번에 고친 것: 없음(바로 고칠 작고 안전한 문제는 찾지 못함). 서명 단계를 위해 widget-kit에 "제거 프로그램을 먼저 만들어 서명본을 넣는" 빌드 방식만 추가했습니다(기본 빌드는 그대로).

검토가 필요한 큰 항목(리드 판단):

1. **`elevate.exe`(서명 안 됨)**: electron-builder가 모든 사용자 설치(`perMachine`)용으로 넣는 권한 상승 도우미. 서명된 설치 파일 안에 서명 없는 exe가 남습니다. 자동 업데이트를 쓰지 않으므로 `nsis.packElevateHelper: false`로 뺄 수 있는지 확인 필요(설치 파일이 처음부터 관리자 권한을 요청하는지 확인 후).
2. **두레이 위젯의 예전 앱 무인 제거**: 예전 앱 사용자가 모두 옮겨 간 뒤 다음 두레이 위젯 버전에서 빼면 "다른 프로그램을 몰래 실행"하는 동작이 없어집니다.
3. **위젯 파일의 제품 이름**: SignPath 조건(제품 이름 = 프로젝트 이름)과 위젯 설치 파일의 `Desk Widgets-<위젯 제품명>`이 맞는지 신청 때 확인(2장).
4. **koffi `.node` 모듈**: 서명하지 않는 제3자 바이너리. 오탐이 나면 koffi 상위 배포본이 서명돼 있는지 확인.
