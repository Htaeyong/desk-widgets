## Desk Widgets-SystemMonitorWidget 1.0.0 (시스템 모니터 위젯)

첫 정식 버전입니다.

### 주요 기능

- CPU 사용률과 최근 기록(코어별 표시 선택), 메모리, 드라이브별 여유 공간, 디스크 읽기·쓰기, 네트워크 송수신, GPU 사용률, 배터리, 가동 시간.
- 테마: **다크 글래스**(기본), **오션 그래프**, **막대**, **미니 바**. 모든 테마에서 배경 불투명도를 조절합니다.
- 측정 간격 1~10초(기본 2초), CPU 기록 10~300초(기본 60초).
- 창이 가려졌거나 자리를 비운 동안에는 측정을 멈춥니다. GPU 카운터나 배터리가 없는 PC에서는 그 항목만 **측정 불가**로 표시합니다. PowerShell·WMI는 실행하지 않습니다.

### 설치

- `DeskWidgets-SystemMonitorWidget-Setup-1.0.0.exe` 실행 (관리자 권한). 개발판(0.0.1) 위에 그대로 설치하면 되고, 설정은 유지됩니다.
- 제어판: **Desk Widgets-SystemMonitorWidget 1.0.0**
- 설치 순서: **엔진(Desk Widgets) 먼저**, 그다음 위젯. 엔진이 없으면 위젯 설치 파일이 알려 주고 멈춥니다.
- 코드 서명이 아직 없어 SmartScreen 경고("Windows의 PC 보호")가 뜰 수 있습니다: **추가 정보 → 실행**.

### 요구 사항

- **Desk Widgets 엔진 1.0.4 이상** (엔진 API 1.5). 이전 엔진에서는 위젯 관리 창에 "호환 안 됨"으로 표시됩니다.

### 받기

- 다운로드 페이지: https://widgets.chilgong88.com (항상 최신 버전)
- 모든 릴리스: https://github.com/Htaeyong/desk-widgets/releases

자세한 내용: [사용자 가이드](https://github.com/Htaeyong/desk-widgets/blob/main/docs/user-guide.md)
