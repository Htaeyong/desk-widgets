# Desk Widgets

Windows 바탕화면 위젯 엔진입니다. **엔진**(Electron 앱)을 한 번 설치하고, 필요한 **위젯**을 따로 설치합니다. 설치한 위젯은 모두 같은 엔진 안에서 실행되어, 위젯마다 Electron 앱을 따로 띄울 때보다 메모리를 크게 아낍니다. 창 관리, 바탕화면 고정(Win+D 뒤에도 남음), 위치 저장, 자동 실행, 알림 카드, 트레이 메뉴, 테마는 엔진이 공통으로 맡습니다.

> English summary: [below](#english).

<!-- 스크린샷: 공개 전에 docs/images/에 넣고 아래 자리를 채웁니다. -->
| 두레이 대시보드 | 캘린더 | 메일 |
|---|---|---|
| *(스크린샷 준비 중)* | *(스크린샷 준비 중)* | *(스크린샷 준비 중)* |

## 위젯

| 위젯 | 설치 파일 | 설명 |
|---|---|---|
| 두레이 대시보드 | `DeskWidgets-DoorayWidget-Setup-<버전>.exe` | Dooray! 프로젝트 업무 현황, 업무 변경·댓글·멘션 알림, 나만의 분류, 초성 검색 |
| 캘린더 | `DeskWidgets-CalendarWidget-Setup-<버전>.exe` | 여러 CalDAV 계정(두레이·네이버·iCloud·NAVER WORKS 등)과 ICS 주소의 일정을 한 달력에서 보고, 지원하는 계정의 일정을 편집 |
| 메일 | `DeskWidgets-MailWidget-Setup-<버전>.exe` | 여러 IMAP 계정(두레이·네이버·다음·Gmail 등)의 메일을 한 목록으로, 새 메일 알림, 안전한 미리보기, 메일 보내기 |
| 시계 | `DeskWidgets-ClockWidget-Setup-<버전>.exe` | 작은 바탕화면 시계. 위젯을 만드는 방법을 보여 주는 예제 |
| 스티키 노트 (개발판) | `DeskWidgets-StickyNoteWidget-Setup-<버전>.exe` | 노트마다 창 하나, 서식이 보이는 상태로 편집, 문서 폴더에 Markdown 파일로 저장 |
| 시스템 모니터 (개발판) | `DeskWidgets-SystemMonitorWidget-Setup-<버전>.exe` | CPU·메모리·디스크·네트워크·GPU·배터리 표시 |
| 할 일 목록 (개발판) | `DeskWidgets-TodoWidget-Setup-<버전>.exe` | 빠른 입력, 날짜·반복, 여러 목록과 미리 알림 |

## 설치

설치 파일은 [Releases](https://github.com/Htaeyong/desk-widgets/releases)에서 받습니다. 엔진과 위젯은 버전과 릴리스가 따로 있습니다(엔진 `engine-v…`, 위젯 `widget-<id>-v…`).

1. **엔진** `DeskWidgets-Setup-<버전>.exe`를 먼저 설치합니다(관리자 권한, 모든 사용자). 위젯은 들어 있지 않습니다.
2. 원하는 **위젯** 설치 파일을 설치합니다. 설치하면 실행 중인 Desk Widgets에 바로 나타납니다. 엔진이 없으면 위젯 설치 파일이 먼저 엔진을 설치하라고 알려 줍니다.
3. 사용할 위젯은 작업 표시줄 오른쪽의 트레이 아이콘 → **위젯 관리 · 설정**에서 고릅니다.

> 설치 파일에 코드 서명이 없어 처음 실행할 때 Windows SmartScreen 경고("Windows의 PC 보호")가 뜰 수 있습니다. **추가 정보 → 실행**을 누르세요.

자세한 사용법은 [사용자 가이드](docs/user-guide.md)에 있습니다. 위젯을 제거할 때는 설정을 함께 지울지 고를 수 있고, 엔진과 위젯은 Windows 설정의 앱 목록에서 따로 제거합니다.

## 테마

두레이 대시보드, 시계, 캘린더, 메일, 시스템 모니터, 할 일 위젯의 화면은 **테마 폴더** 하나로 통째로 바꿀 수 있습니다. 테마는 HTML·CSS·JS로 만들고, 격리된 창에서 실행되어 인터넷에 접속하거나 파일에 접근할 수 없습니다. 위젯 설정의 테마 칸에서 **테마 폴더 열기**로 받은 테마를 넣고 **목록 새로고침**을 누르면 됩니다.

- 시작하기: [테마 만들기](docs/theme-guide.md) (색만 바꾸는 가장 작은 테마부터 위젯별 예제까지)
- 규격: [공통 테마 규격](docs/THEME_SPEC.md), [두레이](docs/THEME_SPEC-dooray.md)·[시계](docs/THEME_SPEC-clock.md)·[캘린더](docs/THEME_SPEC-calendar.md)·[메일](docs/THEME_SPEC-mail.md)·[시스템 모니터](docs/THEME_SPEC-system-monitor.md)·[할 일](docs/THEME_SPEC-todo.md)
- 위젯 만들기: [위젯 개발 가이드](docs/widget-dev.md)

만든 테마를 공유하고 싶으면 [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.

## 소스에서 빌드하기

Windows 10/11, [Node.js](https://nodejs.org/) LTS, Git이 필요합니다.

```bash
git clone https://github.com/Htaeyong/desk-widgets.git
cd desk-widgets
npm ci
npm test                 # 단위 테스트
npm start                # 엔진 실행 (저장소 widgets/ 의 위젯을 불러옴)
npm start -- --mock-data # 계정 없이 예시 데이터로 실행
npm run dist             # 엔진 설치 파일 → dist/
npm run dist:widgets     # 위젯 패키지와 설치 파일 → dist/
```

위젯 설치 파일은 [NSIS](https://nsis.sourceforge.io/)로 만듭니다. `npm run dist`를 한 번 실행하면 electron-builder가 받아 둔 `makensis`를 쓰고, 다른 NSIS를 쓰려면 `MAKENSIS` 또는 `NSIS_DIR` 환경 변수로 지정합니다. 두레이 위젯을 실제 계정으로 확인하려면 `.env.example`을 `.env`로 복사해 `DOORAY_API_KEY`를 채우고 `npm run check-api`를 실행합니다.

## 개인정보

Desk Widgets는 사용 기록이나 개인정보를 수집하지 않습니다. 계정 비밀번호와 API 토큰은 이 PC에 Windows 암호화(DPAPI)로 저장되고 해당 서비스에만 보냅니다. 자세한 내용은 [개인정보 안내](docs/privacy.md)를 보세요.

## 문의와 기여

버그 제보, 기능 제안, 질문은 [GitHub Issues](https://github.com/Htaeyong/desk-widgets/issues)에 남겨 주세요. 기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다.

## 라이선스

[MIT](LICENSE). 무료로 쓰고, 고치고, 배포할 수 있습니다.

## 상표

Dooray!는 NHN Dooray, Gmail은 Google LLC, Outlook은 Microsoft Corporation, iCloud는 Apple Inc., 네이버(Naver)와 NAVER WORKS는 NAVER Corp. 및 그 계열사, 다음(Daum)은 Kakao Corp.의 상표입니다. Desk Widgets는 이 회사들과 관계가 없으며, 이 회사들이 보증하거나 후원하는 제품이 아닙니다. 서비스 이름은 연결할 수 있는 서비스를 알리기 위해서만 씁니다.

---

## English

**Desk Widgets** is a desktop widget engine for Windows built on Electron. You install the engine once and add widgets as separate installers; all widgets run inside the same engine process. The engine handles windows, pinning to the desktop (survives Win+D), positions, autostart, notification cards, the tray menu and themes.

Widgets: Dooray! dashboard, calendar (CalDAV/ICS), mail (IMAP/SMTP), clock, and preview versions of sticky notes, system monitor and to-do list. The UI is in Korean.

- **Install**: download from [Releases](https://github.com/Htaeyong/desk-widgets/releases), install the engine `DeskWidgets-Setup-<version>.exe` first, then any widget installer. The installers are not code-signed, so Windows SmartScreen may warn on first run: choose **More info → Run anyway**.
- **Themes**: every themed widget's UI is a replaceable folder of HTML/CSS/JS running in an isolated, offline window. See [docs/theme-guide.md](docs/theme-guide.md) (Korean).
- **Build**: `npm ci`, `npm test`, `npm start` (add `-- --mock-data` for sample data), `npm run dist`.
- **Privacy**: no telemetry, no data collection. Account passwords and API tokens are encrypted on your PC with Windows DPAPI (Electron `safeStorage`) and sent only to the service they belong to. See [docs/privacy.md](docs/privacy.md).
- **Issues**: [GitHub Issues](https://github.com/Htaeyong/desk-widgets/issues). **License**: [MIT](LICENSE).
- **Trademarks**: Dooray!, Gmail, Outlook, iCloud, Naver, Daum and NAVER WORKS are trademarks of their respective owners. This project is not affiliated with or endorsed by them.
