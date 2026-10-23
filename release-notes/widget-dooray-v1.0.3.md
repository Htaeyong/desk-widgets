## Desk Widgets-DoorayWidget 1.0.3 (두레이 대시보드 위젯)

### 새 기능

- **할 일에 추가** (선택, 기본 꺼짐): 업무 옆의 **+**(할 일에 추가)를 누르면 그 업무가 할 일 목록 위젯에 들어갑니다. **두레이 → 할 일 연동**과 **할 일 → 두레이에서 받기**를 모두 켜야 하고, 같은 업무를 다시 추가하면 기존 할 일을 씁니다. 설정에 필요한 조건(할 일 위젯 사용, 엔진 1.0.4)과 현재 상태가 표시됩니다.

### 고친 점

- **API 토큰은 암호화해서만 저장**: 이 PC에서 Windows 데이터 보호를 쓸 수 없으면 토큰을 평문으로 저장하지 않고 설정 창에 이유를 알려 줍니다.

### 설치

- `DeskWidgets-DoorayWidget-Setup-1.0.3.exe` 실행 (관리자 권한). 이전 버전 위에 그대로 설치하면 되고, 토큰·설정·분류·조건 알림은 유지됩니다.
- 제어판: **Desk Widgets-DoorayWidget 1.0.3**
- 설치 순서: **엔진(Desk Widgets) 먼저**, 그다음 위젯. 엔진이 없으면 위젯 설치 파일이 알려 주고 멈춥니다.
- 코드 서명이 아직 없어 SmartScreen 경고("Windows의 PC 보호")가 뜰 수 있습니다: **추가 정보 → 실행**.

### 요구 사항

- Desk Widgets 엔진 1.0.0 이상 (엔진 API 1.1). 배경 불투명도 슬라이더는 엔진 1.0.1부터, **할 일에 추가**는 엔진 1.0.4와 할 일 목록 위젯 1.0.0이 필요합니다.

### 받기

- 다운로드 페이지: https://widgets.chilgong88.com (항상 최신 버전)
- 모든 릴리스: https://github.com/Htaeyong/desk-widgets/releases

자세한 내용: [사용자 가이드](https://github.com/Htaeyong/desk-widgets/blob/main/docs/user-guide.md)
