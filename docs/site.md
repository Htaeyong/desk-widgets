# 다운로드 페이지 (Firebase Hosting)

`site/public/`의 정적 페이지입니다(빌드 도구·외부 CDN·분석 도구 없음). 설치 파일은 GitHub Releases에 있고, 페이지는 브라우저에서 GitHub API(`api.github.com`, 로그인 없이)로 최신 릴리스를 읽어 다운로드 링크를 채웁니다. 릴리스가 없거나 API가 실패하면 "준비 중"과 릴리스 페이지 링크를 보여 줍니다.

## 구성

| 파일 | 역할 |
|---|---|
| `site/public/index.html`, `style.css`, `app.js` | 페이지. `app.js`가 태그 규칙(`engine-v<버전>`, `widget-<id>-v<버전>`)과 파일 이름(`DeskWidgets-Setup-<버전>.exe`, `DeskWidgets-<ProductName>-Setup-<버전>.exe`)으로 제품별 최신 설치 파일을 고릅니다 |
| `site/public/products.json` | 이름·설명·버전·필요 엔진 버전·API. `npm run site:build`가 `package.json`과 `widgets/*/widget.json`에서 만듭니다 |
| `site/public/img/` | 스크린샷(`docs/images`에서 복사). `hero.jpg`는 `hero.png`를 줄인 사본입니다 |
| `firebase.json`, `.firebaserc` | 호스팅 설정(보안 헤더·CSP·캐시), 프로젝트 `desk-widgets-chilgong88` |

위젯 버전이나 설명을 바꾼 뒤에는 `npm run site:build`를 다시 실행해 `products.json`을 커밋합니다(`npm test`가 최신 여부를 확인합니다).

## 미리보기

```bash
npm run site:build
npm run site:serve
```

`http://127.0.0.1:5050/` (포트는 `PORT` 환경 변수). 릴리스 정보는 GitHub API에서 읽으므로 인터넷이 되면 실제 릴리스가 반영됩니다.

## 배포

```bash
npm run site:deploy
```

`site:build` 후 `firebase deploy --only hosting`를 실행합니다(`scripts/site-deploy.js`). Firebase 계정은 공개 파일에 쓰지 않고 저장소 루트의 `.env`에 둡니다.

```
FIREBASE_ACCOUNT=<프로젝트 소유 Google 계정>
# FIREBASE_PROJECT=desk-widgets-chilgong88   (선택, 기본값)
```

값은 화면에 출력하지 않으며, 비워 두면 `firebase login`으로 로그인한 계정을 씁니다.

## 사용자 지정 도메인 widgets.chilgong88.com 연결

1. [Firebase 콘솔](https://console.firebase.google.com/) → 프로젝트 `desk-widgets-chilgong88` → Hosting → **도메인 추가**.
2. `widgets.chilgong88.com`을 입력하고 안내에 따라 진행합니다(리디렉션 옵션은 사용 안 함).
3. 콘솔이 보여 주는 DNS 레코드를 chilgong88.com의 DNS 관리 화면에 추가합니다. 보통 다음 두 가지이며, **실제 값은 콘솔에 표시된 것을 그대로** 씁니다.
   - 소유권 확인: 호스트 `widgets` (또는 `_acme-challenge`) 의 **TXT** 레코드
   - 연결: 호스트 `widgets` 의 **A** 레코드(콘솔이 알려 주는 IP) — 콘솔이 CNAME(`desk-widgets-chilgong88.web.app`)을 안내하면 그 값을 씁니다
4. 같은 이름에 다른 A/AAAA/CNAME 레코드가 있으면 충돌하므로 지웁니다.
5. 콘솔에서 상태가 "연결됨"이 될 때까지 기다립니다(DNS 반영 수 분~수 시간, SSL 인증서 발급은 최대 하루). 그 뒤 https://widgets.chilgong88.com 에서 확인합니다.
