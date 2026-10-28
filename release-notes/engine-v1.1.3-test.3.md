# Desk Widgets 1.1.3-test.3 — 내부 테스트 (#108)

1.1.3-test.2에 아래 두 가지를 고쳤습니다(엔진만, 위젯은 그대로). (1) 네트워크 드라이브(SMB 공유 폴더)나 일부 클라우드 드라이브를 동기화 폴더로 쓰면 폴더 감시 오류로 "A JavaScript error occurred in the main process"(Error: UNKNOWN ... watch) 창이 뜨던 문제: 감시 오류가 나면 감시를 끄고 2분 간격 확인으로 계속 동기화합니다. (2) 드라이브 맨 위(예: Y:\)를 고르면 이유를 알려 주고 "폴더 만들어 쓰기" 버튼으로 그 안에 "Desk Widgets Sync" 폴더를 만들어 고를 수 있습니다.

내부 테스트용(Gitea 사전 릴리스)이며 GitHub·다운로드 페이지·앱 안 업데이트에는 나오지 않습니다.
