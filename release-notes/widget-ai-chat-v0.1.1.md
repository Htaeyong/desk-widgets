## Desk Widgets-AiChatWidget 0.1.1 (AI Widgets 위젯)

새 위젯 **AI Widgets**의 첫 공개 버전입니다. 말로 시키면 이 PC에 설치된 **Claude Code**가 **내 Anthropic API 키로** 작업하고 결과를 돌려줍니다. 위젯은 대화와 이력을 남기고, 만족한 작업을 요약해 두었다가 비슷한 일에 다시 씁니다.

> Anthropic과 제휴하거나 Anthropic이 보증한 제품이 아닙니다. Claude와 Claude Code는 Anthropic의 상표입니다.

### 기능

- **대화**: 명령을 보내면 Claude Code가 작업하는 과정과 결과가 대화로 보입니다. 대화 목록에서 이어 가고, 이름을 바꾸고, 고정하고, 지웁니다. 작업 중에도 **정정으로 보내기**(지금 단계를 멈추고 고친 내용으로 이어 가기)와 **끝난 뒤 보내기**를 고를 수 있습니다.
- **승인과 질문 카드**: 승인이 필요한 작업은 실행될 입력 전문을 카드로 보여 주고, 직접 눌러야 허용됩니다. 보이지 않는 글자는 `[U+…]`로 드러냅니다. Claude가 결정을 물을 때도 카드로 묻습니다.
- **요약 다시 쓰기**: 결과에 만족하면 요약을 만들어 직접 확인·수정한 뒤 저장하고, 비슷한 요청에 다시 씁니다. 요약은 참고 자료일 뿐 권한을 주지 않습니다.
- **기억**: Claude가 규칙을 기억하려 하면 카드로 묻고, 승인한 것만 다음 대화에 전달합니다.
- **첨부**: 파일·이미지를 붙여 보낼 수 있습니다(작업 폴더에 사본을 두고 Claude가 읽음).
- **비용**: 월 예산 기준 잔여 추정과 작업마다 상한(기본 $3). 추정값이며 실제 금액은 Anthropic Console에서 확인합니다.
- **AI 도우미 연결**을 켜 두면 캘린더·메일·할 일 노트·두레이 위젯 도구도 씁니다. 두레이 원본은 받을 때마다 두레이 알림 카드로 확인합니다.

### 안전과 비용 (먼저 읽어 주세요)

- **내 PC에서 내 Windows 계정 권한으로 실행합니다.** Windows에는 이를 막는 샌드박스가 없고, 작업 폴더는 시작 위치일 뿐 격리 공간이 아닙니다. 중요한 자료는 백업하세요.
- **비용은 내 몫입니다.** 내 API 키의 Anthropic 조직에 청구됩니다. **전용 workspace의 키와 낮은 사용 한도(spend limit)**를 권합니다.
- 내 명령과 작업 중 읽은 파일·명령 결과가 Anthropic으로 갑니다. Desk Widgets 개발자에게는 아무것도 가지 않습니다.
- 키는 이 PC에 암호화해 저장하고 Claude Code에는 실행마다 한 번만 넘기지만, 같은 계정에서 실행한 프로그램이 빼낼 가능성을 없앨 수는 없습니다. 의심되면 Console에서 키를 폐기하세요.
- 기본으로 꺼져 있습니다. 동의 화면을 확인하고 키를 넣기 전에는 아무 프로그램도 실행하지 않습니다. 관리자 키와 구독 로그인 토큰은 받지 않습니다.

### 설치

- `DeskWidgets-AiChatWidget-Setup-0.1.1.exe` 실행 (관리자 권한). 트레이 메뉴의 **AI Widgets**로 창을 엽니다. 내부 시험판(0.0.x)을 쓰던 PC는 그 위에 그대로 설치하면 되고, 대화와 설정은 유지됩니다.
- 제어판: **Desk Widgets-AiChatWidget 0.1.1**
- 설치 순서: **엔진(Desk Widgets) 먼저**, 그다음 위젯.
- **코드 서명이 없습니다.** SmartScreen 경고("Windows의 PC 보호")가 뜰 수 있습니다: **추가 정보 → 실행**. 이 위젯은 프로그램을 실행하고 키를 다루므로, 설치 전에 받은 파일의 **SHA-256**을 GitHub 릴리스 페이지의 값과 비교해 주세요(PowerShell: `Get-FileHash .\DeskWidgets-AiChatWidget-Setup-0.1.1.exe`). 코드 서명이 승인되면 서명판으로 바꿉니다.

### 요구 사항

- **Desk Widgets 엔진 1.1.2 이상** (엔진 API 1.9). 앱을 끌 때 진행 중인 작업을 묻는 확인은 엔진 1.1.4부터, AI 도우미 연결(위젯 도구)은 엔진 1.1.3부터입니다.
- **Claude Code 2.1.309 이상**이 이 PC에 설치되어 있어야 합니다(공식 설치 방법). 위젯은 Claude Code를 대신 설치하지 않습니다.
- **내 Anthropic API 키**(Console에서 workspace를 골라 만든 키).
- 잠긴 노트는 AI 도구에 제목과 마감도 넘기지 않습니다. 캘린더 1.1.3까지는 캘린더 도구 결과에 잠긴 노트의 제목과 마감이 들어갈 수 있으니 **캘린더 1.1.4 이상**과 **할 일 노트 1.1.5 이상**을 함께 쓰세요.

### 받기

- 다운로드 페이지: https://widgets.chilgong88.com (항상 최신 버전)
- 모든 릴리스: https://github.com/Htaeyong/desk-widgets/releases

자세한 내용: [AI Widgets 사용법](https://github.com/Htaeyong/desk-widgets/blob/main/docs/ai-chat.md) · [개인정보 안내](https://github.com/Htaeyong/desk-widgets/blob/main/docs/privacy.md)
