## Desk Widgets-StickyNoteWidget 1.0.0 (스티키 노트 위젯)

첫 정식 버전입니다.

### 주요 기능

- **노트마다 창 하나**: 색 7가지, 항상 위, 접기. 바탕 화면 보기(Win+D)에도 남습니다.
- **서식이 보이는 상태로 바로 고치기**: 제목·목록·체크 목록·표·코드·링크, 이미지 붙여넣기·끌어다 놓기, 첨부 파일, 노트끼리 `[[이름]]` 연결.
- **Markdown 파일로 저장**: `문서\Desk Widgets\스티키 노트`에 노트마다 `.md` 파일(이미지·첨부는 `제목.assets` 폴더). VS Code·Obsidian 등에서 고친 내용도 반영하고, 저장 안 한 내용이 있으면 덮어쓰지 않고 고르게 합니다. 위젯을 제거해도 노트 파일은 남습니다.
- **노트 목록**: 검색, 고정, 보관함, 휴지통. 예전 `.txt` 메모를 열어 Markdown 노트로 바꿀 수 있습니다.

### 설치

- `DeskWidgets-StickyNoteWidget-Setup-1.0.0.exe` 실행 (관리자 권한).
- 제어판: **Desk Widgets-StickyNoteWidget 1.0.0**
- 개발판(0.0.1, 이전 이름 MemoWidget)을 쓰던 경우 그대로 설치하면 됩니다. 제어판 항목이 바뀌고, 기본 폴더를 쓰던 경우에만 `문서\Desk Widgets\메모`를 `스티키 노트`로 한 번 옮깁니다(옮길 수 없으면 예전 폴더를 계속 씀).
- 설치 순서: **엔진(Desk Widgets) 먼저**, 그다음 위젯. 엔진이 없으면 위젯 설치 파일이 알려 주고 멈춥니다.
- 코드 서명이 아직 없어 SmartScreen 경고("Windows의 PC 보호")가 뜰 수 있습니다: **추가 정보 → 실행**.

### 요구 사항

- Desk Widgets 엔진 1.0.0 이상 (엔진 API 1.0)

### 받기

- 다운로드 페이지: https://widgets.chilgong88.com (항상 최신 버전)
- 모든 릴리스: https://github.com/Htaeyong/desk-widgets/releases

자세한 내용: [사용자 가이드](https://github.com/Htaeyong/desk-widgets/blob/main/docs/user-guide.md)
