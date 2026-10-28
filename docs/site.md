# 다운로드 페이지 (Firebase Hosting)

`site/public/`의 정적 페이지입니다(빌드 도구·외부 CDN·분석 도구 없음). 설치 파일은 GitHub Releases에 있고, 페이지는 브라우저에서 GitHub API(`api.github.com`, 로그인 없이)로 최신 릴리스를 읽어 다운로드 링크를 채웁니다. 릴리스가 없거나 API가 실패하면 "준비 중"과 릴리스 페이지 링크를 보여 줍니다.

## 구성

| 파일 | 역할 |
|---|---|
| `site/public/index.html`, `style.css`, `app.js` | 페이지. `app.js`가 태그 규칙(`engine-v<버전>`, `widget-<id>-v<버전>`)과 파일 이름(`DeskWidgets-Setup-<버전>.exe`, `DeskWidgets-<ProductName>-Setup-<버전>.exe`)으로 제품별 최신 설치 파일을 고릅니다 |
| `site/public/products.json` | 이름·설명·버전·필요 엔진 버전·API. `npm run site:build`가 `package.json`과 `widgets/*/widget.json`에서 만듭니다 |
| `site/releases.json` | 제품별로 마지막에 릴리스한 설치 파일(버전·태그·파일·GitHub 주소·크기·SHA-256). `npm run release`가 GitHub에 올린 뒤 적고(#104), `site:build`가 `products.json`의 `download`로 넣습니다. 앱 안 업데이트가 이것을 씁니다([앱 안에서 업데이트](updates.md)) |
| `site/public/showcase.json` | 위젯마다 주요 기능·필요한 것·화면 목록(카드의 기능 목록과 갤러리). 손으로 고치고, 화면 파일은 `npm run screenshots`가 `docs/images`에서 `img/`로 함께 복사합니다 |
| `site/public/img/` | 스크린샷(`docs/images`에서 복사). `hero.jpg`는 `hero.png`를 줄인 사본입니다 |
| `firebase.json`, `.firebaserc` | 호스팅 설정(보안 헤더·CSP·캐시), 프로젝트 `desk-widgets-chilgong88` |

위젯 버전이나 설명을 바꾼 뒤에는 `npm run site:build`를 다시 실행해 `products.json`을 커밋합니다(`npm test`가 최신 여부를 확인합니다).

## 항상 최신 버전 (#100)

- 다운로드 버튼과 버전 표시는 **GitHub 릴리스 기준**입니다. 페이지가 릴리스 목록(최근 100개)을 읽어 제품마다 **가장 높은 버전**을 고릅니다. API가 돌려주는 순서와 상관없고, 초안·사전 릴리스와 설치 파일이 아직 올라가지 않은 릴리스는 건너뜁니다.
- 릴리스를 읽기 전이나 읽지 못하면 `products.json`의 버전을 보여 주고 버튼은 "준비 중"입니다.
- 브라우저는 릴리스 정보를 10분 동안 기억하므로(sessionStorage), 새 릴리스는 늦어도 10분 뒤(새 탭은 바로) 반영됩니다. 페이지 파일의 캐시는 5분입니다.
- `npm run release:all -- release-notes`는 릴리스 뒤에 `site:deploy`까지 실행해 `products.json`(이름·설명·필요 엔진)도 새 버전으로 맞춥니다. 하나씩 `npm run release`로 냈다면 끝에 `npm run site:deploy`를 실행합니다.

## 설치 안내 문구 (#96)

첫 화면의 **설치 순서**는 ① 엔진 설치 ② 처음 실행하면 쓸 위젯을 고르는 화면이 나옴(위젯마다 관리자 확인 창 한 번) ③ 위젯 설치 파일을 따로 받아 직접 설치해도 됨(위젯 카드의 **다운로드**, 오프라인 PC는 위젯 고르기 화면의 **내려받은 설치 파일 열기**)입니다. 위젯 고르기 화면은 이 페이지의 `products.json`을 읽으므로, 사이트를 배포해야 새 위젯이 목록에 나타납니다. 엔진 설치 마지막 화면(`build/installer.nsh`의 `MUI_FINISHPAGE_TEXT`)에도 같은 안내가 한 줄 있습니다.

## 내부 테스트 버전 (#109)

새 버전은 먼저 **Gitea에만 사전 릴리스**로 올려 내부 테스트를 하고, 정식 버전으로 바꿔 GitHub에 올릴 때 사이트를 갱신합니다(정책 "단계 배포").

- 테스트 버전은 다음 버전 뒤에 `-test.N`을 붙입니다(예: `1.1.1-test.1`, 태그 `engine-v1.1.1-test.1`, `widget-<id>-v1.1.1-test.1`).
- 소스(`package.json`, `widgets/*/widget.json`)가 테스트 버전이어도 `npm run site:build`는 **마지막 공개 버전**을 씁니다: 그 제품의 `site/releases.json` 기록 버전(아직 공개한 적이 없으면 `X.Y.Z` 부분). 그래서 테스트 기간에 빌드해도 `site/`는 바뀌지 않고 `npm test`도 통과합니다. 빌드는 내용이 바뀐 파일만 다시 쓰므로(줄바꿈 차이 무시) CRLF 체크아웃에서도 `git status site/`가 깨끗합니다.
- `site/releases.json`·`products.json`에는 테스트 버전이 들어가지 않습니다(`recordRelease`가 거부, 앱의 업데이트 확인도 무시).
- `release:all`은 테스트 버전이 하나라도 있으면 사이트 빌드·배포를 하지 않습니다. GitHub 릴리스가 없으니 페이지(`app.js`)에도 나타나지 않습니다(사전 릴리스와 `-test` 태그는 원래 건너뜀).
- 테스트가 끝나면 버전을 `1.1.1`로 바꾸고 릴리스 노트 `release-notes/<태그>.md`를 정식 태그 이름으로 준비해 평소처럼 `npm run release:all -- release-notes`를 실행합니다(GitHub 릴리스 → `site/releases.json` → 사이트 배포).

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

`site:build` 후 `firebase deploy --only hosting`를 실행합니다(`scripts/site-deploy.js`, 다른 위치의 .env는 `node scripts/site-deploy.js --env <파일>`). Firebase CLI가 만드는 `.firebase/` 캐시 폴더는 커밋하지 않습니다(.gitignore). Firebase 계정은 공개 파일에 쓰지 않고 저장소 루트의 `.env`에 둡니다.

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

## 검색 노출 (#106)

광고 없이 Google·Naver 검색에 나오게 하는 설정입니다. 페이지 쪽 준비는 끝나 있고(아래 "페이지에 들어 있는 것"), 사용자가 계정에서 **한 번만** 등록하면 됩니다.

### 페이지에 들어 있는 것

| 항목 | 위치 |
|---|---|
| `robots.txt`(모두 허용, 사이트맵 주소 포함), `sitemap.xml`(페이지 1개) | `npm run site:build`가 만듭니다. 페이지 파일(`index.html`·`app.js`·`style.css`·`products.json`·`showcase.json`)이 바뀐 빌드에서만 `lastmod`가 그날 날짜로 바뀝니다(상태는 `site/sitemap-state.json`) |
| canonical, Open Graph, Twitter 카드 | `index.html`(대표 이미지는 `img/hero.jpg`, 절대 주소) |
| `SoftwareApplication` JSON-LD(무료, MIT, 윈도우 10/11, 버전, 다운로드 주소) | `index.html`의 `seo:jsonld` 표시 사이. `site:build`가 엔진 버전·설치 파일 주소로 채우므로 직접 고치지 않습니다 |
| 네이버 소유 확인 태그 자리 | `index.html`의 주석 처리된 `naver-site-verification` 줄. 값을 받으면 주석을 풀고 채웁니다. 비어 있어도 빌드와 테스트는 그대로 통과합니다 |

JSON-LD는 `type="application/ld+json"` 데이터 블록이라 브라우저가 실행하지 않으므로 CSP의 `script-src 'self'`를 그대로 두어도 됩니다(`'unsafe-inline'` 없음). 로컬에서 같은 CSP 헤더로 열어 콘솔 오류가 없음을 확인했고, 테스트가 이 조건을 지킵니다. 사이트를 바꾸면 `npm run site:build` 후 `site:deploy`로 배포해야 사이트맵 날짜가 반영됩니다.

### 사용자가 할 일 (배포 후)

먼저 `npm run site:deploy`로 이 변경을 배포하고 https://widgets.chilgong88.com/robots.txt 와 `/sitemap.xml`이 열리는지 확인합니다.

**Google Search Console**

1. [Search Console](https://search.google.com/search-console)에 로그인 → 속성 추가 → **도메인**에 `chilgong88.com` 입력(하위 도메인 `widgets`까지 한 번에 포함됩니다).
2. 확인 방법으로 **TXT** 레코드가 나옵니다. 값(`google-site-verification=...`)을 복사합니다.
3. Cloudflare → `chilgong88.com` → DNS → 레코드 추가: 유형 **TXT**, 이름 `@`, 내용에 복사한 값. 저장합니다. (Cloudflare가 값을 따옴표로 감싸 보여 줘도 정상입니다.)
4. Search Console로 돌아가 **확인**. 바로 안 되면 하루 이틀 뒤 다시 누릅니다(Google 안내: 반영에 최대 2~3일). 확인 뒤에도 **TXT 레코드는 지우지 않습니다**(지우면 소유 확인을 잃을 수 있음).
5. 왼쪽 **Sitemaps**에서 `sitemap.xml`을 입력해 제출합니다. 상태가 "성공"이면 됩니다.
6. 상단 검사창에 `https://widgets.chilgong88.com/`을 넣어 **URL 검사** → "색인 생성 요청". 이미 색인되어 있으면 요청이 필요 없습니다. **(미확인: 이 단계의 화면 이름은 공식 문서를 직접 확인하지 못했고, 일반적인 화면 기준입니다)**

**네이버 서치어드바이저**

네이버 공식 문서는 이 환경에서 열지 못해 아래 화면 이름과 절차는 **(미확인)**입니다. 화면이 다르면 서치어드바이저의 도움말을 따릅니다.

1. [서치어드바이저](https://searchadvisor.naver.com/)에 네이버 계정으로 로그인 → **웹마스터 도구** → **사이트 등록**에 `https://widgets.chilgong88.com` 입력.
2. 소유 확인은 **HTML 태그** 방법이 가장 간단합니다. 네이버가 `<meta name="naver-site-verification" content="값">` 한 줄을 보여 줍니다. **값만** 알려 주면(또는 직접) `site/public/index.html`의 주석 줄을 풀고 `content`를 채운 뒤 `npm run site:build` → `npm run site:deploy`로 배포합니다. 배포가 끝난 뒤 **소유확인**을 누릅니다. (HTML 파일 업로드 방식도 있다고 알고 있습니다 **(미확인)**. DNS TXT 방식 지원 여부는 **(미확인)**이라 태그 방식을 권합니다.)
3. 확인되면 **요청 → 사이트맵 제출**에 `https://widgets.chilgong88.com/sitemap.xml`을 제출합니다.
4. **검증 → robots.txt**에서 `robots.txt`가 수집을 막지 않는지 확인합니다. **웹 페이지 수집 요청**에 첫 페이지 주소를 넣으면 수집을 앞당길 수 있습니다 **(미확인)**.

인증 코드·비밀번호는 사용자가 직접 입력합니다.

### 진행 확인과 예상 기간

- 검색창에 `site:widgets.chilgong88.com`을 입력합니다(Google, Naver 모두). 결과에 페이지가 나오면 색인된 것입니다.
- Search Console **페이지**(색인 생성) 보고서, 서치어드바이저 **수집 현황**에서 상태를 봅니다.
- 현실적인 기대: 등록 뒤 Google은 보통 며칠~몇 주, Naver는 그보다 오래(몇 주) 걸릴 수 있고 새 사이트는 더 느립니다. 이 사이트는 외부 링크가 거의 없어 `site:`에는 나와도 "윈도우 바탕화면 위젯" 같은 일반 검색어 순위는 한참 뒤이거나 낮을 수 있습니다. 순위를 높이려면 GitHub 저장소 설명·README에서 사이트로 링크하고 소개 글에서 링크가 걸리게 하는 것이 도움이 됩니다.
