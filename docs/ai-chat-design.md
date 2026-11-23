# AI Widgets 위젯 설계: 공개판, 사용자 API 키 전용 (#129)

> 0.0.4까지의 이름은 "AI Widgets"였습니다(2026-11-09 사용자 요청으로 변경). 위젯 id `ai-chat`, 데이터 폴더, 설정, 설치 파일 이름 `AiChatWidget`, 기본 작업 폴더 `문서\Desk Widgets\AI Widgets`는 그대로입니다.

> **상태: 구조 확정, 구현 끝남(16.2의 세션 1~7), 공개 준비 중(0.1.1, 2026-11-23 자체 점검, 서명 없이 공개: 19장 C7).** C1~C8은 2026-11-07에 결정했고, 재시험 S9(같은 날 사용자 실행, Claude Code 2.1.309, 추정 $0.0102)를 통과해 **격리 non-bare + `apiKeyHelper` 한 번 응답 + `auto`** 구조로 확정했습니다(16.1.3, 19장 C1~C4). 시험 도구는 tools/ai-chat-spike이고 사용자가 자기 터미널에서 실행합니다. 사용자 결정(2026-11-07 "공개 배포할 제품이니 배포 가능한 버전으로")에 따라 **처음부터 사용자 자신의 API 키만 쓰는 공개판**입니다. 구독 로그인 경로는 넣지 않습니다. 구독 지원은 나중에 Anthropic이 서면으로 허용하면 다시 검토합니다. 이전 판은 git 이력에 있습니다(`0c2e806` API 직접 호출, `ebf6700` 구독 포함). 약관·문서는 2026-11-07에 읽은 내용입니다. 아직 확인하지 못한 것은 **(미확인)** 으로 적었고, 실제 PC에서 볼 항목은 16.5에 모았습니다.

## 1. 요약

- **무엇**: 위젯에서 명령하면 이 PC에 설치된 Claude Code가 작업하고 결과를 돌려줍니다. 위젯은 세션 목록과 이력을 남기고, 만족한 작업을 요약해 비슷한 요청에 다시 씁니다. 할 일을 미리 정의하지 않습니다.
- **구조(확정)**: 설치본 **`claude -p`를 격리해 실행**합니다. 전용 `CLAUDE_CONFIG_DIR` + `--setting-sources user --strict-mcp-config --disable-slash-commands` + `--tools` 목록. `--bare`는 웹 도구가 안 되어 쓰지 않습니다. 위젯 크기가 거의 늘지 않습니다. Agent SDK는 Windows용 실행 파일이 **344.8MB**라 위젯에 넣기 어렵습니다(5장).
- **키**: 사용자가 만들어 위젯 설정에 넣습니다. DPAPI 저장, 렌더러 비공개, 로그·기록 제외. **키는 `apiKeyHelper`로 넘기고 프로세스 환경에 두지 않습니다. 헬퍼는 실행마다 한 번만 응답합니다(16.1.2, S9 확인).** 그래도 같은 사용자 프로세스가 DPAPI를 풀 수 있으므로 **전용 workspace 키 + spend limit**을 강하게 권합니다(6장).
- **안전**: 기본 꺼짐, 키 없으면 아무것도 실행 안 함, 첫 실행 동의 화면, 기본 `auto`, **`bypassPermissions`는 공개판에 없음**. 네이티브 Windows에는 샌드박스가 없어 폴더는 격리 공간이 아니라고 화면에 적습니다(8장).
- **잔여량**: API 키로는 잔액을 읽을 수 없어 **사용자가 넣은 월 예산 − 추정 사용액 = 잔여 추정**을 "추정"으로 표시하고 Console 링크를 둡니다(10장). Admin 키는 받지 않습니다.
- **약관**: 막는 조항은 찾지 못했습니다. 다만 "인증 수단을 제한하지 말라"는 문구와 위젯의 키 전용 실행의 관계, 게시자의 Commercial Terms 동의 범위는 문서가 분명히 말하지 않아 **짧은 Anthropic 문의를 권합니다**(4장). 구조가 이 답에 따라 갈리지는 않습니다.
- **크기·엔진**: 위젯이 자식 프로세스와 자기 MCP 도구를 다룹니다. 엔진 변경은 앱 종료 확인을 위한 선택 호출 `confirmQuit()`과 `quit-gate` 하나이고, 엔진 API 값은 그대로입니다.

## 2. 사용자 기획과 이 문서의 대응

| # | 사용자 기획 | 어디서 |
|---|---|---|
| 1 | 명령 → Claude Code 작업 → 결과 회신 → 이력 → 피드백 → 만족하면 요약 → 요약 저장 → 비슷한 요청에 요약 + 요청 전달 → 반복 | 7장, 12장 |
| 2 | 이전 대화를 세션 목록으로 | 11장 |
| 3 | 할 일을 미리 정의하지 않음, 넓은 처리 범위, 역할별 허용 목록 폐기 | 5.2장 |
| 4 | 폴더 권한은 AI 기준, 승인은 높은 수준 | 8장 |
| 5 | 의사결정이 필요하면 승인 카드 같은 전달 카드 | 9장 |
| 6 | 잔여 한도 UI | 10장 |
| 7 | 1차 사전 조건: Claude Code 설치 PC | 14.3장 |
| 8 | 이후 Gemini, GPT 등 | 15장 |

## 3. 확인한 사실 (2026-11-07)

bare 행은 C1을 정할 때의 비교 자료입니다. 위젯은 `--bare`를 쓰지 않습니다(16.1.2).

| 항목 | 내용 | 출처 |
|---|---|---|
| bare 인증 | "never reads OAuth credentials or the system keychain". `ANTHROPIC_API_KEY` 또는 `--settings`의 `apiKeyHelper`만 | [headless](https://code.claude.com/docs/en/headless), `--help` |
| bare 지위 | "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release" | headless |
| bare 제한 동작 | v2.1.286 전에는 일부만 적용 | headless |
| bare 도구 | "access to the Bash, file read, and file edit tools". 문서에는 "loads only shell and file tools" | headless, [tools](https://code.claude.com/docs/en/tools-reference) |
| bare 탐색 제외 | hooks, skills, 명령, 서브에이전트, 플러그인, MCP, 자동 메모리, CLAUDE.md. 시스템 알림·백그라운드 작업도 없음 | headless |
| bare로 다시 넣기 | `--append-system-prompt[-file]`, `--settings`, `--mcp-config`, `--agents`, `--plugin-dir`, `--add-dir`(스킬·CLAUDE.md 폴더) | headless, `--help` |
| 키 우선순위 | `-p`에서 "the key is always used when present". 그보다 위에 클라우드 제공자 변수와 `ANTHROPIC_AUTH_TOKEN` | [authentication](https://code.claude.com/docs/en/authentication) |
| 키 차단 정책 | 관리 설정 `forceLoginMethod`·`forceLoginOrgUUID`가 있으면 환경 키가 시작 시 차단 | authentication |
| 환경 정리 | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`: Bash·hooks·stdio MCP 등 자식 환경에서 자격 증명 제거, `ANTHROPIC_API_KEY` 포함. "use it as one layer" | [env-vars](https://code.claude.com/docs/en/env-vars) |
| 승인 주체 | 승인이 필요한 호출은 hook이나 `--permission-prompt-tool`이 승인하지 않으면 거부 | headless |
| 샌드박스 | "On native Windows, Claude Code runs commands unsandboxed" | [sandboxing](https://code.claude.com/docs/en/sandboxing) |
| 비용 값 | `total_cost_usd`는 추정, 이어 간 실행은 이전 분 포함 | [cost-tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) |

## 4. 약관 대조

요약 도구로 읽은 문서와 원문을 구분해 적습니다. **이 판단은 법률 검토가 아닙니다.**

### 4.1 Legal의 제품 탑재 조건

[Legal](https://code.claude.com/docs/en/legal-and-compliance)(원문으로 읽음)의 "Can customers offer Claude Code in their products?"는 "preinstalling or running Claude Code in your products or services"에 조건을 둡니다.

| 조건 | 이 구조 | 판단 |
|---|---|---|
| 실행 파일 수정 금지 | 사용자가 설치한 것을 그대로 실행, 넣거나 고치지 않음 | 맞음 |
| 인증 수단 제거·비활성·제한 금지 | 4.2장 | **불명확, 위험 낮음으로 봄** |
| 각 사용자가 자기 키·자격으로 인증 | 사용자가 만든 자기 키만 받음 | 맞음 |
| 사용자에게 직접 청구 | 사용자의 Anthropic 조직에 청구 | 맞음 |
| 재판매·중개 금지 | 서버 없음, 우리 키 없음, 요금 없음 | 맞음 |
| Commercial Terms 동의 | 4.3장 | 게시자 동의 권장 |
| 이름·로고 | "AI Widgets", 로고 없음, 평문 사실만 | 맞음 |

인증 문단의 "Developers … should use API key authentication"과 제3자가 구독 자격을 쓰거나 중개하지 말라는 금지에 대해, API 키 전용은 그 권고대로입니다.

### 4.2 "may not remove, disable, or restrict any authentication method"와 키 전용 실행

아래 표는 bare를 기준으로 비교할 때 썼습니다. 결정한 구조(격리 non-bare + `apiKeyHelper`)도 판단은 같습니다. 공식 옵션으로 한 실행의 설정 폴더와 키를 정할 뿐 설치본의 인증을 고치지 않고, 위젯 안에서는 구독 로그인을 쓸 수 없습니다.

원문: "customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key)."

| 부딪치지 않는다는 근거 | 부딪칠 수 있다는 근거 |
|---|---|
| 조항 제목이 "The Claude Code binary must not be modified"이고, 호스팅 환경에서 실행 파일을 고쳐 인증을 막는 경우를 다루는 것으로 읽힘 | 문장이 "restrict"까지 넓고, 조건 범위가 "running Claude Code in your products"라 우리도 해당한다고 읽을 수 있음 |
| `--bare`는 Anthropic이 공식 제공·권장하는 옵션이고, 앞으로 `-p` 기본값 | 위젯 안에서는 구독 로그인을 쓸 수 없음. 제품 수준에서 인증 선택을 좁히는 것 |
| 사용자의 로그인과 설치본은 그대로이고, 터미널에서 `claude`로 구독을 계속 쓸 수 있음 | 문서가 이런 데스크톱 제품을 명시적으로 다루지 않음 |
| 같은 문서가 개발자에게 API 키를 쓰라고 하고, Agent SDK 문서는 제3자 제품의 claude.ai 로그인 제공을 금지함. 그 금지를 지키는 방법이 바로 API 키 전용 | |

**판단**: 설치본의 인증을 막는 것이 아니라 공식 옵션으로 한 실행의 자격을 정하는 것이어서 **충돌 가능성은 낮게 봅니다.** 단정할 근거는 없습니다.

### 4.3 Commercial Terms 동의 주체

[Commercial Terms](https://www.anthropic.com/legal/commercial-terms)(2025-06-17, 요약 도구): 고객은 전자 동의나 서비스 첫 접속으로 계약 당사자가 됩니다. **계정 없는 소프트웨어 게시자, 자기 키를 쓰는 최종 사용자가 Customer인지 User인지는 문서가 정하지 않습니다.**

- 사용자는 자기 키로 접속하므로 자기 조직의 Customer로 봅니다.
- 게시자 chilgong88은 키도 계정 요청도 넣지 않지만 Legal 문장이 "running Claude Code in your products"이므로, **게시자도 Console 조직으로 Commercial Terms에 동의해 두는 쪽을 권합니다**(비용 없음). 내부 테스트 때 이미 Console을 쓰게 됩니다.
- D.3의 고지 의무(결과의 사실 진술을 독립 확인 없이 믿지 말 것)와 사용 정책 준수를 화면 안내에 넣습니다. 의무 주체가 불명확해도 넣어서 손해가 없습니다.

### 4.4 이번에 읽은 다른 문서 (모두 요약 도구로 읽음)

| 문서 | 결과 | 조치 |
|---|---|---|
| [Usage Policy](https://www.anthropic.com/legal/aup) (2026-11-12 발효 한국어판) | 에이전트 사용도 정책 적용, 배포자는 자기 에이전트의 준수에 책임. 사용자 대면 에이전트는 AI임을 알림. 고위험 분야(법률·의료·금융 등) 추천에는 자격 있는 사람의 검토와 공개. 재판매·프록시 금지, 가드레일 우회 금지 | 동의 화면과 안내에 정책 링크·AI 표시·고위험 안내. 분류기를 끄는 기능을 두지 않음 |
| [Supported Regions](https://www.anthropic.com/supported-countries) | South Korea가 목록에 있음. 목록은 앱·API를 나누지 않음 | 지원 지역 밖이면 오류를 그대로 안내 |
| [Trademark](https://www.anthropic.com/legal/trademark-guidelines) (2024-08-01) | 사용은 사전 허가 필요, 후원·제휴 암시 금지. "works with" 문구는 다루지 않음 | Legal이 Claude Code에 대해 허용한 **정확한 평문**만 사용. 로고 없음. 사람이 확인 |
| [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (2025-10-08) | API 키·Console은 Commercial Terms 대상이라고 명시. 자동 접근 금지의 예외에 API 키. 키 공유 금지 | 공개판은 구독을 쓰지 않으므로 주 적용 대상 아님. 키 공유 금지 안내 |
| [Service Specific Terms](https://www.anthropic.com/legal/service-specific-terms) (2026-08-31) | Claude Code·소프트웨어 배포를 다루지 않음 | 조치 없음 |
| [Agent SDK 개요](https://code.claude.com/docs/en/agent-sdk/overview) (원문) | SDK는 Commercial Terms, 고객·사용자 제품에 허용. 브랜딩: "Claude Code"라는 이름 사용 불가, 제품처럼 보이면 안 됨 | 이름·화면에 반영. Legal의 평문 허용과 함께 사람이 확인 |
| [Supplemental Credit Terms](https://www.anthropic.com/legal/credit-terms) (2024-03-04) | 크레딧 양도 금지, 계정 보유자만 사용. 구독 크레딧·배포 조항 없음 | 각 사용자가 자기 크레딧·키 사용 |

**읽지 못한 것**: DPA, Agent SDK 패키지와 바이너리의 LICENSE 전문(SDK를 넣게 되면 필요).

**크레딧**: [API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) 표는 Claude Code를 제외하고 Agent SDK를 포함합니다. [Agent SDK 안내](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)의 2026-10-07 항목은 Agent SDK와 `claude -p`를 **연결한 Console 조직의 API 키로 실행할 때** 크레딧이 적용된다고 합니다. 대화형 Claude Code 세션은 크레딧 대상이 아닙니다. 실제 차감은 S8로 확인합니다. 공개 사용자에게는 "내 Console 조직에 청구, Max 등은 연결 조직의 크레딧이 먼저 쓰일 수 있음"으로 안내합니다.

### 4.5 남은 질문과 문의

구조는 답을 기다리지 않습니다. 다음 두 가지만 짧게 묻는 것을 권합니다([contact sales](https://www.anthropic.com/contact-sales)).

1. 사용자가 설치한 수정 없는 Claude Code를 데스크톱 앱이 전용 설정 폴더와 `apiKeyHelper`로 `claude -p` 실행하고 사용자 자신의 API 키만 쓰는 구조가 "restrict any authentication method"에 해당하는지.
2. 키도 서버도 없는 소프트웨어 게시자에게 Commercial Terms 동의나 추가 조건이 필요한지.

답이 올 때까지 공개를 멈출지는 사용자가 정합니다(19장 C8).

## 5. 실행 방식

### 5.1 비교 (크기: npm 패키지 정보, 2026-11-07, 내려받지 않음)

| | **A. 설치본 `claude -p`(격리)** | B. Agent SDK + 함께 넣는 실행 파일 | C. Agent SDK JS + 설치본(`pathToClaudeCodeExecutable`) |
|---|---|---|---|
| 위젯에 더해지는 크기 | **약 0** | `@anthropic-ai/claude-agent-sdk` 5.1MB + `…-win32-x64` **344.8MB** | 5.1MB |
| 사전 설치 | Claude Code 필요(이 PC `claude.exe` 298.6MB) | **필요 없음** | 필요 |
| 승인·질문 | `--permission-prompt-tool` + 자체 MCP 도구(2차 시험에서 동작 확인) | `canUseTool`, `AskUserQuestion` 문서화 | 같음 |
| 중지 | 프로세스 트리 종료(2차 시험에서 확인, 14.2장) | `interrupt()` | 같음 |
| 버전 | 사용자가 업데이트, 위젯은 범위 관리 | "SDK version tracks the bundled Claude Code version", 위젯 배포마다 갱신 | **임의 설치본과의 호환 (미확인)** |
| 약관 | 4장 | SDK 조항이 제품 사용을 명시. 실행 파일 재배포 LICENSE **미확인** | 4장과 비슷 |
| 설치 부담 | 사용자가 Claude Code를 먼저 설치 | 위젯 설치 파일 수백 MB, 앱 안 업데이트 부담 | 사전 설치 + 5.1MB |

**결정: A(19장 C1).** 위젯 설치 파일이 지금처럼 작고, 사용자가 1차 설치 조건을 받아들였습니다. 카드와 중지는 2차 시험에서 동작했습니다. 앞으로 막히면 **C로 바꿉니다**(15장의 실행기 경계 덕분에 영향이 작음). B는 설치 조건을 없앨 때(2차)의 후보이고 그때 LICENSE를 확인합니다.

### 5.2 격리 실행에서 되는 것과 빠지는 것

| 기능 | 격리 non-bare(S9 기준) | 비고 |
|---|---|---|
| Bash·파일 읽기·수정·찾기·웹 | `--tools`로 `Read, Edit, Write, Glob, Grep, Bash, PowerShell, WebSearch, WebFetch, Task`만 남김 | 넓은 일을 처리. `bare`에서는 웹·Write가 없어 쓰지 않음 |
| PowerShell | **S9에서 목록에 없었음**(Git Bash 있는 PC, 헬퍼 인증). 문서: Git Bash가 있으면 claude.ai·Console 계정에서 기본으로 켜지고 `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`로 켬. Git Bash가 없으면 자동으로 켜짐 | 자식 환경에 이 값을 넣음. **실제 확인은 내부 테스트(16.5)** |
| WebSearch·WebFetch | 있음. S9에서 `ToolSearch` 없이 WebFetch 동작, 2차에서 웹 검색 사용 | `ToolSearch`는 넣지 않음. 없을 때 WebSearch 사용은 내부 테스트에서 봄 |
| 서브에이전트 | 도구 이름은 `Task` | 큰 일의 병렬 처리 |
| 스킬·슬래시 명령 | `--disable-slash-commands`면 스킬 0개 | 사용자의 `~/.claude` 스킬은 안 옴 |
| 내장 플러그인 | `cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring` 3개가 남음(모두 builtin) | 끄는 옵션은 찾지 못함. 사용자 플러그인은 안 옴 |
| 사용자 MCP 서버 | 없음(`--strict-mcp-config`) | `--mcp-config`로 위젯이 넣는 것만 |
| 작업 폴더의 `CLAUDE.md`·스킬·명령·hook·`.mcp.json` | **모두 영향 없음(S9)** | `--setting-sources user`가 필수 |
| 사용자의 로그인 | 읽지 않음. 키 없으면 `Not logged in`으로 실패(S9) | 구독 한도를 쓰지 않음 |
| 예약·백그라운드 도구 | `--tools`로 뺌 | 실행이 끝난 뒤 남는 작업을 만들지 않음 |

**`--bare`를 쓰지 않는 이유**: bare는 `--tools`로 웹·`Write`가 늘지 않습니다(16.1.2). 그러면 사용자 기획 3의 "넓은 범위"와 어긋납니다. 대신 격리 옵션으로 재현성과 안전을 챙기고, `--bare`가 `-p`의 기본이 되는 위험은 16.1.2의 도구 검사로 대비합니다.

## 6. 키 저장과 노출

**저장·경계**
- `ctx.secrets.open('secrets')`(DPAPI). 암호화할 수 없으면 저장을 거절합니다. 동기화 안 함.
- 키는 위젯 메인 코드에만 있습니다. 렌더러에는 있음/없음과 끝 4자리만. 입력 칸은 설정 창에만 있고 저장 뒤 비웁니다.
- `log.jsonl`, 세션 기록, 오류 메시지, 카드에 키를 넣지 않습니다. 출력에서 키 문자열을 찾아 가립니다.
- 형식 검사: 관리자 키(`sk-ant-admin`)와 구독 OAuth 토큰(`sk-ant-oat`)은 저장 거절.
- 연결 확인 버튼은 누를 때만, 토큰이 들지 않는 방법으로(`GET /v1/models`, 위젯이 직접 HTTPS 호출).

**실행 때 환경**
- 자식 환경을 **허용 목록으로 새로 만듭니다**(`PATH`, `SystemRoot`, `USERPROFILE`, `APPDATA`, `TEMP` 등 + 아래).
- 키 전달은 **V3**: `--settings`의 `apiKeyHelper`, 환경에 키 없음, 실행마다 새 일회용 값으로 한 번만 응답(16.1.2, S9 확인).
- **헬퍼 실행 방법**: 사용자 PC에 `node`가 없을 수 있고 엔진 exe 경로에는 공백이 있어, 스파이크의 `node helper.js`를 그대로 옮기지 못합니다. 위젯은 `bin/ai-chat-key.cmd`를 설치 폴더에 두고 그 폴더를 자식 `PATH` 앞에 넣습니다. 명령 글은 `ai-chat-key.cmd <id> <일회용 값>`이라 cmd·PowerShell·Git Bash에서 같습니다. 실제 Claude Code가 이 방식으로 실행하는지는 **내부 테스트(16.5)** 입니다.
- **`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `HTTP(S)_PROXY`의 계승을 막습니다.** 그래야 키가 다른 주소로 가거나 다른 자격이 먼저 쓰이지 않습니다. 회사 프록시는 설정에서 명시한 경우만.
- 명령 인자에 키를 넣지 않습니다(`tasklist`로 보임).
- 관리 정책이 환경 키를 막으면 오류를 그대로 보이고 멈춥니다.

**실행한 명령이 키를 읽을 수 있나**

| 경로 | 문서·판단 |
|---|---|
| Bash·PowerShell의 환경 변수 | **V3이라 키가 없음(S9).** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`은 `auto`를 `default`로 강제해 쓰지 않음(16.1.1) |
| `claude.exe` 프로세스의 메모리 | 받은 키를 들고 있고 같은 사용자의 도구가 읽을 가능성을 없앨 수 없음(일반 Windows 동작) |
| 위젯의 `secrets.json` | **같은 사용자 프로세스는 DPAPI를 풀 수 있음.** 위젯의 다른 비밀(메일·캘린더 비밀번호, 두레이 토큰)도 같음 |
| `apiKeyHelper` | 명령이 헬퍼를 다시 실행해도 거절됨(S9 재요청 거절). 먼저 요청하면 Claude Code가 거절당해 실패로 드러남 |
| 분류기 | `auto`는 "Printing a live credential or token"과 외부 전송을 기본 차단. 보장 아님 |

**결론: 키가 새지 않는다고 약속할 수 없습니다.** 대책은 피해 한도입니다. 전용 workspace 키, 낮은 spend limit, 유출 의심 시 Console에서 폐기. 설정 화면과 동의 화면에 적습니다.

**전용 workspace 안내**: [Workspaces](https://platform.claude.com/settings/workspaces)에서 "AI Widgets" workspace를 만들고(기본 workspace에는 spend limit 불가), **Spend limits**를 정한 뒤, 그 workspace의 키를 만들어 넣습니다. Max 등은 연결 조직에서 키를 만들어야 크레딧이 적용됩니다.

**키 범위 오류**: [API keys](https://platform.claude.com/settings/keys) → **Create key**에서 workspace를 고르지 않으면 범위 없는 키가 됩니다. 이 키는 요청마다 `anthropic-workspace-id` 헤더가 필요하고, 없으면 400 `This API key is not scoped to a workspace…`입니다([Authentication](https://platform.claude.com/docs/en/manage-claude/authentication)). 위젯은 헤더로 우회하지 않고(`ANTHROPIC_CUSTOM_HEADERS`로 가능은 하나 ID를 또 받아야 함) **이 오류를 알아보고 "전용 workspace를 고른 키를 다시 만드세요"로 안내**합니다. 연결 확인(`GET /v1/models`)이 이 오류를 잡는지는 문서에 없어 **(미확인, 16.5)**, 잡지 못하면 첫 실행의 오류 글로 안내합니다.

## 7. 구조와 흐름

```
AI Widgets 창(렌더러, CSP로 네트워크 차단, 키 없음)
   │ IPC
ai-chat 메인 코드 ── spawn(claude.exe, 셸 없음, 허용 환경) ── stream-json ──► 이력·예산·카드
   └─ 명명 파이프 + 실행별 토큰 ◄── ai-chat-host.js(MCP stdio, 위젯 폴더, 엔진 exe Node 모드)
                                         ▲ --mcp-config로 Claude Code가 실행
Claude Code ── (선택) 기존 desk-widgets 다리 ──► 위젯 도구
```

```
claude -p --output-format stream-json --verbose --include-partial-messages
  --permission-mode auto --setting-sources user --strict-mcp-config --disable-slash-commands
  --tools Read,Edit,Write,Glob,Grep,Bash,PowerShell,WebSearch,WebFetch,Task
  --mcp-config <실행별 파일, 끝나면 지움>
  --permission-prompt-tool mcp__ai-chat-host__approve
  --allowedTools mcp__ai-chat-host__ask_user,mcp__ai-chat-host__list_recipes,mcp__ai-chat-host__read_recipe
  --append-system-prompt-file <위젯 지침 + 요약 제목, 끝나면 지움>
  --settings {"apiKeyHelper":"ai-chat-key.cmd <id> <일회용 값>"}
  --model <사용자 선택> --max-budget-usd <작업 상한>
  [--resume <session_id>] [--add-dir <폴더>]
```

명령 글은 stdin으로 보냅니다. `--resume` 때 옵션을 다시 넘기고, 키 서버는 실행마다 새로 만듭니다(S9 확인). 자식 환경에는 허용 목록과 `CLAUDE_CONFIG_DIR=<위젯 데이터>\claude-config`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=86400000`, `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`만 넣습니다. 사전 조건은 v2.1.309 이상입니다(14.3장).

**요청 한 번의 흐름**
1. 명령 입력 → 예산 확인 → Claude Code 실행.
2. 스트림 표시, 도구 호출은 접어서. 승인·질문은 카드.
3. `result`로 결과·세션 ID·비용·거부 목록 기록.
4. **만족 / 미흡 / 다시 시도**. 미흡은 사유와 함께 같은 세션을 이어 갑니다.
5. 만족 뒤 **요약 저장**을 누르면 요약 요청(비용 표시), 사용자가 고쳐 저장.

## 8. 공개판 안전

### 8.1 켜는 순서

- 위젯 고르기 **기본 체크 제외**(`DEFAULT_CHECKED`에 넣지 않음), 설치 후에도 기본 동작 없음, 트레이 **AI Widgets**로만 창을 엽니다.
- **키가 없으면 어떤 프로세스도 띄우지 않습니다.** 사전 점검의 `--version`도 동의와 키가 있은 뒤에만 실행합니다. 키가 없을 때 사용자의 구독으로 넘어가는 경로가 없습니다(S9: 키 없으면 `Not logged in`으로 실패).
- **첫 실행 동의 화면**(끝까지 확인 눌러야 시작, 버전이 바뀌면 다시)

> **AI Widgets를 쓰기 전에 확인해 주세요**
> - **내 PC에서 실행합니다.** 설치된 Claude Code가 내 Windows 계정 권한으로 파일을 읽고 고치고 명령을 실행합니다. **Windows에서는 이를 막는 샌드박스가 없고, 작업 폴더는 시작 위치일 뿐 격리 공간이 아닙니다.** 파일을 지우거나 망가뜨릴 수 있으니 중요한 자료는 백업하세요.
> - **비용은 내 몫입니다.** 내 API 키의 Anthropic 조직에 청구됩니다. 금액은 추정이며 넘을 수 있습니다. Console에서 한도를 정하세요.
> - **내용이 Anthropic으로 갑니다.** 내 명령과 작업 중 읽은 파일·명령 결과, 저장한 요약의 제목과 "언제 쓰는지"가 전달됩니다. Desk Widgets 개발자에게는 가지 않습니다.
> - **AI는 틀릴 수 있고, 읽은 글에 속을 수 있습니다.** 메일·웹·남의 파일에 숨은 지시를 따를 수 있습니다. 결과를 확인하세요. 법률·의료·금융 판단은 전문가에게 확인하세요.
> - **키**는 이 PC에 암호화해 저장하지만 실행한 프로그램이 빼낼 가능성을 없앨 수 없습니다. 전용 키와 낮은 한도를 쓰세요.
> - Anthropic 약관과 [사용 정책](https://www.anthropic.com/legal/aup)이 적용됩니다.

### 8.2 승인 모드

| 모드 | 공개판 | 근거 |
|---|---|---|
| `auto` | **기본** | 문서: 위험 작업과 읽은 내용에 끌린 행동을 막음, "does not guarantee safety" |
| `default`(Manual) + 카드 | **`auto`를 못 쓸 때 대체**, 선택 가능 | 승인이 필요한 호출마다 카드 |
| `acceptEdits` + 카드 | 선택 | 파일 수정만 자동 |
| `plan` | 선택 | 계획만 |
| `dontAsk` | 사용 안 함 | 묻지 않고 **거부** |
| `bypassPermissions` | **공개판에 없음(결정)** | 문서: "no protection against prompt injection", "isolated environments … only". 위젯에는 격리 판별 수단이 없고, 일반 사용자 PC가 대상. 실행기가 값을 거부하고 시험으로 고정 |

사용자가 "높은 수준"을 원하지만 공개판에서 위험을 대신 감수할 수 없어, 가장 높은 값을 `auto`로 둡니다. 필요한 사람은 Claude Code를 직접 쓰면 됩니다. 개인 빌드 옵션도 두지 않습니다(코드 경로가 공개판에 남지 않도록).

**`auto`를 못 쓰는 경우**
- 조건: API는 Opus 4.6+, Sonnet 4.6+, Haiku 5.5, Fable 계열만. Windows v2.1.233+. Team·Enterprise 관리자 차단 가능.
- 시작 때 또는 실패 시 안내 후 **Manual + 카드**로 진행할지 묻습니다. 저절로 낮추거나 올리지 않습니다. 격리 non-bare에서 `auto`가 그대로 됨을 S9로 확인했습니다.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`은 `default`를 강제하므로(1차 시험의 stderr, 문서에는 없음) 쓰지 않습니다. init의 모드가 요청과 다르면 위젯은 조용히 진행하지 않고 실행을 멈춘 뒤 알립니다.

### 8.3 폴더

샌드박스는 "macOS, Linux, and WSL2"만 지원하고 덮는 범위도 셸 명령뿐입니다. `blockWritesOutsideWorkingDirectories`는 "doesn't limit shell commands"이고, `Bash(rm *)` deny는 `bash -c 'rm …'`을 막지 못합니다([permissions](https://code.claude.com/docs/en/permissions)).

- 기본 폴더 `문서\Desk Widgets\AI 대화`, 대화별로 바꿀 수 있음.
- `--settings`로 쓰기 제한 켬(`permissions.blockWritesOutsideWorkingDirectories`, 파일 도구, v2.1.314+, 끌 수 있음). `deny`로 파일 도구의 `%APPDATA%\chilgong88\**`, `.ssh`, `.aws`, `.claude`, 브라우저 프로필 읽기·수정 차단(셸은 못 막음). 규칙은 문서의 Windows 형식 `//c/Users/...`로 씁니다. 2.1.314 미만에서 쓰기 제한 키는 무시될 것으로 보며 내부 테스트 대상입니다(16.5).
- 폴더 칸 옆 고정 문구: "작업 폴더는 격리 공간이 아닙니다."
- 폴더의 hooks·`.mcp.json`·`CLAUDE.md`·스킬·명령은 `--setting-sources user`로 영향을 주지 않습니다(S9 확인). 그래도 **새 폴더 첫 사용 확인**을 둡니다. 폴더 내용 때문이 아니라 "이 폴더 안팎을 고칠 수 있다"를 실행 전에 알리기 위해서입니다. 한 번 확인한 폴더는 다시 묻지 않습니다.

### 8.4 남는 위험

| 위험 | 내용 | 줄이는 방법(완전하지 않음) |
|---|---|---|
| 프롬프트 주입 | 메일·웹·파일 글 | `auto`, 동의 화면, 위험 작업 경고 |
| 사용자 파일 | 문서·`.ssh` 등에 닿을 수 있음 | 파일 도구 deny, 백업 안내 |
| **위젯 비밀과 API 키** | **이 위젯의 키**, 메일·캘린더 비밀번호, 두레이 토큰은 DPAPI로 저장되어 같은 사용자 프로세스가 풀 수 있음 | 환경 정리, deny, 전용 키·낮은 한도, 유출 시 폐기 안내 |
| 비용 폭주 | 추정 기반 상한은 넘을 수 있음 | 작업 상한, 월 예산, 진행 중 표시, Console spend limit |
| 되돌릴 수 없는 작업 | 위젯 도구 밖의 파일·명령 변경은 카드·되돌리기 없음 | 작업 폴더를 git이나 백업 아래 |
| 잠긴 노트 | 본문은 암호문이라 읽을 수 없음. 제목·마감은 파일 안에서 평문 | AI 도우미 도구는 잠긴 노트의 제목·마감도 넘기지 않음(결정 A, 2026-11-10). 캘린더 도구의 틈은 #133으로 고침(캘린더 1.1.3까지는 남음) |
| 창 표시 | 모델 글·질문은 글자로, 이미지·원격 자원 없음, 링크는 전체 주소 확인 | CSP |
| 키의 다른 모양 | 실행기는 출력에서 **키 문자열 그대로**만 가림. 모델이 키를 쪼개거나 Base64로 바꿔 출력하면 창과 위젯 기록에 남을 수 있음 | 요약·기억·첨부·명령·카드 답·대화 이름은 쪼갠 모양과 Base64까지 거부하거나 가림(자체 점검 2026-11-23). 키를 출력하라는 명령은 `auto` 분류기가 막음(보장 아님) |
| 실행 중 MCP 설정 파일 | 실행 동안 `<위젯 데이터>\run\mcp-*.json`에 `ai-chat-host` 파이프 이름과 토큰이 있음. 셸 명령은 파일 도구 deny를 거치지 않아 읽을 수 있음 | 그 파이프로 할 수 있는 것은 카드 띄우기(사람 클릭 필요)와 요약·기억 목록 읽기뿐이라 권한이 늘지 않음. 실행이 끝나면 지우고, 비정상 종료로 남은 파일은 다음 시작 때 지움(자체 점검 2026-11-23) |
| 외부 내용 표시 | "외부 내용을 읽은 대화" 판단은 도구 이름·경로·명령 글로만 함. 앞선 명령이 작업 폴더에 받아 둔 파일, 하위 작업(`Task`) 안의 읽기는 놓칠 수 있음 | 요약·기억은 언제나 사람이 읽고 저장. 경로는 `..`를 풀어 비교(자체 점검 2026-11-23) |
| `auto`의 카드 | `auto`에서는 분류기가 대부분 판단해 카드가 드뭄. 카드가 뜨면 입력 전문을 보여 주지만, 카드 없이 지나간 동작은 사람이 보지 못함 | 동의 화면 안내, 필요하면 Manual 모드 |

더 강한 격리(WSL2 + 샌드박스, VM)는 15장의 실행기 경계로 나중에 붙일 수 있습니다.

## 9. 카드: 승인과 질문

**승인**: `--permission-prompt-tool mcp__ai-chat-host__approve`. `ai-chat-host`는 판단하지 않고 파이프(실행별 이름과 토큰, 토큰은 그 서버의 환경에만)로 위젯에 묻습니다. 위젯에 닿지 못하면 거부합니다. 도구는 카드를 띄우고 기다립니다(`-p`에서는 백그라운드로 안 옮겨지고 제한 약 28시간). 입력 키는 `input, tool_name, tool_use_id`이고 allow·deny가 동작합니다(2차 시험). `auto`에서 파일 쓰기는 카드 없이 통과합니다. 카드 내용은 도구 이름과 **입력 전문**, **허용 / 거부(이유)**. "항상 허용"은 없습니다. 보이지 않는 문자(제어·방향·너비 0·태그)는 `[U+XXXX]`로 보이고 개수를 경고합니다. 렌더러에는 표시용 글자만 가고 실행될 입력은 메인에 남아 있어, 허용하면 묻은 입력 그대로 실행됩니다. 전문을 보여 줄 수 없을 만큼 크면(256KB 초과) 거부합니다. 버튼은 나타난 뒤 잠시 잠겨 있고, 스크립트의 `click()`이 아니라 실제 입력 이벤트로만 답합니다. 카드는 대화 기록 밖 고정 영역에 그려 모델 글이 흉내 낼 수 없습니다. 창이 안 보이면 엔진 알림 카드로 **대기 중이라는 사실만** 알리고(내용 없음, 버튼은 열기뿐) 승인은 창에서만 합니다. 기본은 답할 때까지, 설정으로 30분 뒤 거부.

**질문**: 위젯 MCP 도구 `ask_user`로 정했습니다(19장 C3). `auto`에서 동작하고 `ToolSearch` 없이 불립니다(S9).

| 안 | 내용 | 판단 |
|---|---|---|
| CLI `AskUserQuestion` | `auto` 도구 목록에 없음. approve까지 오지만 답 전달 미확인(2차 시험) | 쓰지 않음 |
| **위젯 MCP 도구 `ask_user`** | 입력을 위젯이 정함, 답할 때까지 대기, `--allowedTools`로 허용 | **결정** |

`auto`에서는 분류기가 대부분 처리합니다. 실제 작업에서 카드가 얼마나 나오는지는 내부 테스트에서 봅니다.

## 10. 잔여 한도 UI (API 키)

**원천**

| 값 | API 키에서 | 근거 |
|---|---|---|
| 잔액 | **읽을 수 없음** | 일반 키로 제공되는 값을 찾지 못함. 잔액은 Console Billing |
| `rate_limit_event` | API 키 실행에서 **0번**(2차, S9). 없어도 동작하고, 오면 "일시 제한"으로만 표시 | 시험 결과 |
| 상태줄 `rate_limits` | "only present for claude.ai Pro, Max, and Ultra subscribers" 또는 게이트웨이. 해당 없음 | [statusline](https://code.claude.com/docs/en/statusline) |
| `total_cost_usd` | 있음, **추정**, 세션 누적 | 문서: 금전 결정에 쓰지 말 것 |
| Admin API 비용 보고 | Admin 키 필요 | **받지 않음** |

**Admin 키를 받지 않는 이유**: 조직 구성원·키·workspace를 관리하는 넓은 권한입니다. 조금 나은 표시를 위해 이런 자격을 사용자 PC 위젯에 두고 명령을 실행하는 환경 옆에 둘 수 없습니다. 형식 검사로 거절합니다.

**화면(창 위 띠, 값마다 "추정" 표시)**

```
이번 달 약 $4.20 사용 (추정) · 예산 $20 · 약 $15.80 남음 (추정)   [Console에서 실제 잔액 보기]
```

- **월 예산**: 사용자가 정합니다(처음 묻고, 기본 $20). 달력 월 기준, 초기화일은 바꿀 수 있습니다(크레딧 주기에 맞출 때).
- **잔여 추정 = 예산 − 위젯의 추정 합계.** 다른 프로그램의 사용·실제 크레딧·Console 한도는 모릅니다. 화면에 "이 위젯 기준 추정입니다"를 적습니다.
- **갱신**: 작업 끝(`done`). 세션 값은 누적이라 직전 값과의 차이만 더합니다. 보고 없이 끝난 실행(중단 등)은 받은 `assistant` usage를 메시지별로 한 번씩 가격표로 계산해 더하고, usage도 없거나 가격을 모르는 모델이면 "일부 미반영"으로 표시합니다. 중단된 실행의 추정과 다음 실행의 누적 값이 겹치면 조금 많게 잡힐 수 있고, 적게 잡는 것보다 낫다고 봅니다.
- **멈춤**: 80%에 한 번 안내, 100%면 새 작업을 시작하지 않습니다(대기 중이던 작업 포함). 예산을 바꾸면 이어 씁니다. 진행 중인 작업은 `--max-budget-usd`(기본 $3)가 끊습니다. 문서: 상한을 넘을 수 있음.
- **서버 쪽 멈춤**: `Your credit balance is too low…`, 직접 정한 한도(400 `You have reached your specified…`), 조직 한도(429 `enforced_spend_limit_reached`, 재시도 안 함)를 구분해 안내하고 Billing·Workspaces로 연결합니다. `system/api_retry`는 화면에 표시하고, `billing_error`면 기다려도 소용없으므로 실행을 바로 멈춥니다.
- **오류와 재시도**: 위젯은 어떤 오류도 저절로 다시 보내지 않습니다(키 재요청의 `--resume` 한 번만 예외, 16.1.2). 일시 오류(429 제한, 529·5xx)만 "명령 다시 넣기"를 보이고, 키·권한·크레딧·한도·지역·모델·길이·작업 상한은 다시 보내도 해결되지 않는다고 안내합니다. 표는 14.3장, 코드는 `lib/key.js`.
- 값이 없으면 "아직 없음"이라고 쓰고 추측값을 그리지 않습니다.

## 11. 세션 목록과 기록

- **위젯 세션**: `{ id, title, cwd, runner, runnerSessionId, model, mode, createdAt, lastAt, status, usedRecipes[], feedback[], estUsd }`. 왼쪽 목록은 최근순, 고르면 대화, 이어 쓰면 `--resume`.
- **이어 갈 수 없으면**(30일 정리) 내용은 읽기 전용, 새 세션 제안.
- **저장**: `<dataDir>\sessions\index.json`과 `<id>.jsonl`에 명령, 답변, 도구 이름과 짧은 입력, 카드, 추정 비용, 피드백. **도구 결과 전문은 저장 안 함.** 동기화 안 함. 기본 30일(7·30·90일·직접 삭제), 고정 가능.
- **Claude Code 자체 기록은 세션별 폴더**: 세션마다 `CLAUDE_CONFIG_DIR=<위젯 데이터>\claude-config\<세션 ID>`를 씁니다. Claude Code의 내부 파일 배치를 몰라도 그 폴더만 지우면 한 세션의 전문 기록이 정확히 사라지고, 다른 세션은 그대로입니다. 공유 폴더 안의 파일을 골라 지우는 방식은 배치가 바뀌면 조용히 남을 수 있어 쓰지 않습니다. 화면에 **Claude 기록 지우기**(대화는 읽기 전용으로 남음)와 **대화 삭제**(둘 다 지움)를 둡니다. 지우면 그 세션은 이어 갈 수 없습니다(S9). 보관 기간이 지난 대화는 두 기록을 함께 지웁니다. `--no-session-persistence`는 이어 가기를 없애므로 "이 대화는 기록하지 않음" 선택지로만 둡니다.

## 12. 피드백과 요약

요약은 **recipe**라 부르고 코드는 `lib/recipes.js`, `lib/recipe-safety.js`, `lib/recipe-prompts.js`, 화면은 `chat/recipes.js`입니다.

- **피드백**: 결과 뒤 **만족 / 미흡 / 다시 시도**. 만족은 모델을 부르지 않습니다. 미흡은 사유가 필수이고 같은 세션을 이어 갑니다. 새 명령을 보내면 만족 표시가 풀립니다.
- **만드는 때**: 만족 뒤 **요약 만들기**를 눌렀을 때만, 직전 실행 비용을 보이고 같은 세션에 요청합니다. 자동으로 만들지 않습니다.
- **내용**: 제목, 언제 쓰는지, 효과 있던 절차, 하지 말 것, 가정. 이번 값(이름·경로·비밀)은 일반화하도록 요청합니다. 형식에 맞지 않으면 답 전체를 내용 칸에 넣어 사용자가 고칩니다.
- **저장 전 사용자 확인**: 답은 초안일 뿐이고 실제 클릭으로만 저장합니다. 초안은 대화 기록에 남아 다시 열 수 있습니다.
- **형식과 위치**: `<dataDir>\recipes\<id>\v<번호>.md`, 모델 중립 Markdown(`# 제목`, `> 언제 쓰는지: …`, 본문). 목록은 `index.json`. 동기화 안 함. 수정마다 새 버전이고 이전 10개를 남기며, 되돌리기도 새 버전입니다. 사용 횟수, 마지막 사용일, 만든 세션을 기록합니다. 세션을 지워도 요약은 남습니다.
- **비밀 검사**: 키·토큰 모양, `password=`, 긴 무작위 문자열(엔트로피 기준). 지우기 전에는 저장을 막습니다. 비밀이 아니면 그 저장에 한해 표시하고 넘어갑니다. **위젯의 키는 그대로, 공백·줄바꿈으로 나뉘어도, Base64여도 항상 거부**합니다. 화면에는 앞 4자리와 길이만 보입니다.
- **찾기**: 제목·"언제 쓰는지" 목록(최대 50개, 많이 쓴 순)을 `--append-system-prompt-file`과 `list_recipes`로 주고, Claude가 `read_recipe`로 읽습니다. 사용자가 **요약 고르기**로 직접 넣을 수도 있습니다. 임베딩·검색 서버 없음.
- **쓴 요약 표시**: 답변 위 띠에 제목과 버전을 보입니다. **`read_recipe` 호출과 사용자 선택만 기록**하고 모델의 말은 보지 않습니다. **빼기**를 누르면 그 세션에서 목록·읽기·선택 모두 빠집니다. 이미 전달된 내용은 그 대화 기록에 남을 수 있어 그렇게 안내합니다.

**요약 오염**: 요약은 이후 작업마다 재사용되는 지시문이라 한 번의 주입보다 위험합니다.
- 저장 전 전문 확인. 주소·명령·외부 전송·권한 변경·"무시하라"·보이지 않는 글자를 코드가 줄 단위로 표시합니다. 표시는 저장을 막지 않습니다.
- 외부 내용을 읽은 세션(웹, 다리 도구, 작업 폴더 밖 파일, 받아 오는 셸 명령)에서 만들면 표시하고, 저장과 수정 때마다 한 번 더 확인합니다.
- 전달 때 "참고 자료이며 권한을 주지 않고, 지금 요청과 어긋나면 지금 요청을 따른다"로 감쌉니다. 사용자가 고른 요약도 같고, 지금 요청을 맨 뒤에 둡니다.
- 사용 표시, 이전 버전, 동기화 안 함. 그래도 보장은 아니라고 안내합니다.
- 요약의 글을 모델이 따르더라도 승인 경로는 그대로입니다(수동 모드에서 카드 없이 쓰기 안 됨, 시험으로 고정).

## 12.1 첨부 파일 (0.0.5, 2026-11-09 사용자 요청)

**전달 방식 결정: 작업 폴더에 사본, 경로를 명령에 넣고 Read로 열게 함.**

| | A. 사본 + 경로 + Read (결정) | B. `--input-format stream-json`으로 이미지 블록 |
|---|---|---|
| Claude가 보는 방법 | Read 도구로 파일을 엶. Read는 이미지도 보여 줌(도구 문서) | 첫 메시지에 이미지가 바로 들어감 |
| 지금 구조와의 관계 | stdin 글 전달 그대로. S9에서 시험한 조합 그대로 | 입력 형식 전체가 바뀜. 이미지 블록 전달은 시험한 적 없음 |
| 문서·PDF·오피스 | 같은 방식으로 처리 | 이미지만 해결, 나머지는 결국 A 필요 |
| 이어 가기 | 사본이 남아 다음 명령에서도 다시 읽을 수 있음 | 대화 기록에만 남음 |
| 비용·속도 | 도구 호출 한 번이 더 듦 | 더 빠름 |

B는 A로 이미지가 잘 읽히지 않을 때의 후보로 둡니다. 실제로 Claude가 이미지를 Read로 보는지, PDF·오피스 파일을 어떻게 읽는지는 **내부 테스트(16.5)** 입니다.

- **위치**: `<세션 작업 폴더>\AI Widgets 첨부\<세션 ID>\`. 원본은 옮기지 않고 복사, 이름 충돌은 `이름 (2).확장자`. 대화 삭제·보관 기간 만료 때 이 폴더만 지움(`lib/sessions.js`). Claude 기록만 지울 때는 남김.
- **명령**: 사용자 글 뒤에 "The user attached these files … read the ones you need with the Read tool (it also shows images …)"와 사본의 종류·크기·전체 경로.
- **제한**: 한 번에 10개, 파일 20MB, 합계 50MB, 붙여넣은 이미지·글 10MB. 이미지는 내용의 첫 바이트로 판정(PNG·JPEG·GIF·WebP). SVG는 이미지로 그리지 않음.
- **안전**: 실행 파일·스크립트는 경고. 첫 첨부 때 "Anthropic으로 전달" 안내를 한 번 확인해야 보냄. **비밀 검사는 글 파일(1MB까지)에만**: 위젯 키가 있으면 거부, 다른 비밀 모양은 경고만(사용자가 일부러 보내는 파일일 수 있음). 이미지·이진 파일은 검사하지 않음.
- **긴 붙여넣기**: 2만 자 넘는 글은 입력 칸 대신 `붙여넣은 글.txt` 첨부로.
- **기록**: 위젯 기록에는 이름·크기·종류만. 내용과 경로는 남기지 않음. Claude Code 자체 기록에는 명령의 경로가 남음.
- **화면**: 미리보기는 메인이 만든 작은 `data:` 이미지만(CSP `img-src data:`). 대화 안의 첨부는 이름으로만 보이고 그림을 그리지 않음. 창에 파일을 떨어뜨려도 그 파일을 열지 않음.

## 12.2 안내 줄이기 (2026-11-09 사용자 요청)

| 분류 | 안내 | 처리 |
|---|---|---|
| 일주일 미루기 가능 | 작업 폴더 격리 안내(`folder-boundary`), 위젯 도구 꺼짐 배너(`widget-tools`), 확인되지 않은 Claude Code 버전(`unverified-version`) | 닫기 = 이 창에서만. "이번 주 그만 보기" = 7일. 종류별로 `noticeSnooze[kind] = 만료 시각` |
| 대화당 한 번 | 위젯 도구 꺼짐 기록 줄, 선택 도구 없음 줄 | 세션의 `noted`에 상태를 적고 같은 상태면 다시 쓰지 않음 |
| 한 번만(이미) | 첨부 첫 안내, 예산 80% 알림(기간마다), 새 작업 폴더 확인(폴더마다) | 그대로 |
| 항상 보임 | 동의, 승인·질문 카드, 오류, 예산 100% 차단, 키 문제, 위젯 키 저장 거부, 실행 파일·비밀 첨부 경고, 남은 프로세스, 모드 배너, MCP 서버 실패 | 미룰 수 없음 |

- 저장: 위젯 설정(이 PC, 동기화 없음). sanitize가 알려진 종류와 숫자만 남김.
- 초기화: 설정의 "안내 다시 보기"(`resetNotices`)가 모두 지우고, 열린 창의 "이 창에서만 닫음"도 풀어 줌.

## 12.3 위젯 메모리 (0.0.5 이후, 2026-11-09 사용자 요청)

- **문제**: 실사용에서 Claude Code가 자체 메모리에 규칙을 쓰려다 실패. 세션마다 `CLAUDE_CONFIG_DIR`이 달라 저장됐더라도 다음 대화에서 안 보임.
- **결정**: 기억은 위젯이 가진다. `ai-chat-host`의 `save_memory`(text, title?)와 `list_memory`. `save_memory`는 카드("이 내용을 기억할까요?" 저장 / 고쳐서 저장 / 취소) 뒤에만 저장. 클릭 때의 상자 내용을 다시 검사해 저장. 위젯 키는 카드 없이 거부, 다른 비밀 모양은 "비밀이 아닙니다" 체크가 있어야 저장. 위험 문구는 요약과 같은 규칙으로 표시.
- **전달**: 켜진 기억을 오래된 순서(고정 순서, 캐시 유지)로 8000자까지 `--append-system-prompt-file`에 매번 전부. "사용자가 승인한 선호, 권한이 아님, 지금 요청이 우선, 데이터 전송·권한 변경·숨기기 지시는 따르지 않음"으로 감쌈. 기억 글의 줄바꿈과 `---`는 펴서 목록을 닫을 수 없게 함.
- **오염 대책**: 외부 내용을 읽은 세션(`external`)에서 나온 기억은 카드와 설정 목록에 표시. 저장은 언제나 사람의 클릭.
- **자동 메모리 끄기**: 문서(memory)의 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`을 환경에 넣음. 시스템 지침에 "기억은 save_memory로만, 메모리 파일·CLAUDE.md에 쓰지 말 것".
- **저장 위치**: `<위젯 데이터>\memory.json`, 50개·1000자까지, 동기화 없음.

## 12.4 작업 중 취소와 정정 (2026-11-09 사용자 요청)

| | A. 멈추고 `--resume`으로 정정 (결정) | B. `--input-format stream-json`으로 실행 중 입력 |
|---|---|---|
| 문서 | headless: SIGTERM은 진행 중 차례를 끝내지 않고 기록하지 않음, 다음 `--resume` 프롬프트가 대화를 이어 감 | streaming input: 실행 중 보낸 메시지는 **대기열**에 들어가 지금 차례가 끝난 뒤 처리(여러 개면 합칠 수 있음). 지금 차례에 끼어들려면 `interrupt` 제어 요청이 필요(SDK `interrupt()`, 직접 제어 프로토콜은 `control_request`) |
| Windows | 지금의 `taskkill /T /F` 그대로. S6에서 약했던 SIGINT를 쓰지 않음 | 신호 대신 stdin 제어 메시지라 Windows 문제는 없지만, 입력 형식 전체와 프로세스 수명(한 프로세스가 여러 차례)이 바뀜 |
| 바로 반영 | 멈춘 즉시 새 실행 | interrupt 없이 보내면 지금 차례가 끝나야 반영 |
| 위험 | 멈춘 차례의 결과가 Claude 기록에 덜 남을 수 있음(위젯 기록에는 남음) | 제어 프로토콜의 직접 사용은 문서가 SDK 중심이라 검증 부족 |

- **정정으로 보내기**: 슬롯에 정정을 적고 `stop`(떠 있는 카드는 "정정으로 거부"), 끝나면 정정 프롬프트를 대기열 맨 앞에. Claude Code 세션 id가 있으면 "The user interrupted your previous step to correct the request…"로 `--resume`, 시작 전에 멈췄으면 처음 명령 + 정정.
- **끝난 뒤 보내기**: 같은 세션의 대기열에 넣음. `pump`는 실행 중인 세션의 것을 건너뜀.
- **중지**: 입력 칸 위 "작업 중" 줄에 둠. "중지됨"과 지금까지의 결과가 남음. 카드는 "중지로 거부".
- B는 나중에 실행 중 이미지 블록이나 한 프로세스로 여러 차례가 필요할 때 다시 봄.

## 12.5 두레이 원본 받기 (#131과 함께)

- 두레이 `fetch_file`은 `requiresUserInteraction`을 쓰지 않음(문서: `--permission-prompt-tool` 실행에서는 그 표시가 붙은 도구의 허용이 거절로 바뀜). 대신 두레이 위젯이 Desk Widgets 알림 카드로 파일마다 확인(팀장 결정).
- AI Widgets는 카드를 띄우지 않음: `mcp__desk-widgets__dooray_fetch_file`과 `_status`를 `--allowedTools`에 넣어, 수동 방식에서도 두레이 알림 카드 하나만 뜨게 함(카드가 두 번 뜨지 않음, 시험으로 확인).
- 대기 표시: `fetch_file` 호출 시작에 "Desk Widgets 알림 카드에서 받기를 눌러 주세요", 결과가 `waiting_approval`이면 파일 이름·크기를 붙여 유지, `downloading`이면 "받는 중", 그 밖의 결과·오류·실행 끝에 지움.
- `declined`(rejected / closed / timeout / unavailable): 첨부 없이 `{k:'fetched', declined: true, name, reason}`을 기록하고 "두레이 원본 받지 않음"으로 표시.
- 결과: 러너가 `tool_result`를 `toolResult` 이벤트로 냄(창에는 보내지 않음). 받기 도구의 `status: "done"`, `source: "dooray"`, 16자리 `fetch_id`, 경로가 정확히 `<두레이 데이터>\fetched\<fetch_id>\<name>`일 때만 `<작업 폴더>\AI Widgets 첨부\<세션>\dooray\<fetch_id>\<name>`로 복사(20MB까지). 기록에는 `{k:'fetched', name, size, kind, source}`만.
- 시스템 지침에 그 폴더를 적어 Claude가 작업 폴더 안 사본을 Read로 읽게 함. 대화 삭제 때 첨부 폴더와 함께 지움.

## 13. 기존 MCP 다리

엔진의 **AI 도우미 연결**이 켜져 있으면(`<userData>\mcp\endpoint.json`이 있을 때) `--mcp-config`에 기존 `desk-widgets` 다리를 넣습니다. 엔진 기본값은 꺼짐이고, **첫 실사용(2026-11-08)에서 이것 때문에 위젯 도구 없이 실행되었습니다.** 그래서 꺼져 있거나(off) 도구가 없거나(empty) 다리 파일이 없으면(unavailable) 창 위에 이유와 **위젯 관리 열기**를 보이고, 실행 기록에 남기고, 시스템 지침에 "위젯 도구가 연결되지 않았다고 답하고 다른 서비스 연결을 권하지 말라"를 넣습니다. 켜져 있으면 `tools.json`의 도구 이름을 지침에 넣습니다. init의 `mcp_servers`에서 `ai-chat-host`나 `desk-widgets`가 `connected`가 아니면 오류로 알립니다. 위젯이 엔진 설정을 직접 켜는 방식은 사용자 결정 전이라 넣지 않았습니다. 쓰기·읽기 허용은 사용자가 그 연결에서 정한 대로이고, 그 도구의 호출도 `auto` 판단이나 승인 카드를 거칩니다. 쓰기 허용·카드·10분 되돌리기·기록은 #120·#121 그대로이고 **엔진 변경은 없습니다.** `--strict-mcp-config`로 다른 MCP를 읽지 않으므로 이름 충돌도 없습니다. V3에서는 MCP 환경에도 키가 없습니다(S9). 다리·`ai-chat-host`의 `ELECTRON_RUN_AS_NODE`는 각 서버의 `env`로 줍니다.

Claude Code는 노트 파일을 직접 고칠 수도 있고, 그러면 카드·되돌리기가 없습니다. 지침에 "위젯 데이터는 해당 도구로만"을 넣지만 강제는 아닙니다.

## 14. 실행 관리

### 14.1 동시 작업

기본 1개, 설정으로 최대 3개. 같은 세션은 동시에 이어 가지 않습니다(문서: 메시지가 섞임). 대기열 표시.

### 14.2 중지와 종료

문서는 SIGINT를 권하지만 **Node `child.kill()`은 Windows에서 신호를 보내지 못하고 강제 종료**합니다. 2차 시험에서 SIGINT 경로는 자식이 살아남았고 stdin 닫기는 빨리 끝나지 않았으며, 트리 종료(`taskkill /T`)는 517ms에 자식까지 끝내고 이어 가기도 됐습니다. 그래서 **트리 종료**로 정했습니다. "중단됨"을 기록하고 일부 진행 가능을 표시합니다. 다시 이어 가도 "tool … doesn't get rerun"(문서).

앱 종료 시 진행 중이면 확인 뒤 트리 종료, 대기 카드는 거부. 확인은 위젯만으로 할 수 없어 엔진에 선택 호출 `confirmQuit()`을 더했습니다. 위젯은 바로 답하고 질문은 비동기로 띄우므로 메인 프로세스가 멈추지 않습니다. 사람이 끌 때만 묻습니다. 엔진이 업데이트 설치를 위해 끌 때는 묻지 않고(`quit-gate`), 진행 중 작업이 없어도 묻지 않습니다. 설치 프로그램의 `taskkill`과 Windows 종료·로그아웃은 `before-quit`을 거치지 않으므로(Electron 문서) 질문에 막히지 않습니다. 이때 남은 자식 프로세스는 다음 시작 때 알립니다. 없는 엔진에서는 묻지 않고 트리 종료만 합니다. 비정상 종료면 다음 시작 때 PID 기록과 그 실행의 ID가 명령 줄에 있는지로 **우리가 띄운 `claude`인지 확인한 뒤** 알리기만 하고 끝내지 않습니다. 잠금·자리 비움으로 멈추지 않습니다.

### 14.3 사전 조건 (1차: Claude Code 설치 PC)

| 상태 | 화면 |
|---|---|
| 미설치(`claude --version` 실패) | "Claude Code가 설치된 PC에서 쓸 수 있습니다" + 공식 안내 링크. 대신 설치 안 함 |
| 구버전(v2.1.309 미만) | `claude update` 안내. 2.1.309는 이 구조를 시험한 버전입니다 |
| 필요한 도구 누락(init 목록) | 실행을 멈추고 어떤 도구가 없는지 안내. `--bare` 기본화 대비(16.1.2). 셸은 `Bash`·`PowerShell` 중 하나면 되고, `PowerShell`·`Task`만 없으면 안내만 |
| init의 모드나 키 출처가 요청과 다름 | 실행을 멈추고 안내(8.2장) |
| 키 없음·형식 오류 | 설정 열기. 프로세스 안 띄움 |
| 키 무효(401) | 설정 열기 |
| 키 범위 오류(400, workspace 없음) | 원인과 키 다시 만들기 안내 + 설정 열기(6장). 재시도 안 함 |
| 권한(403), 크레딧, spend limit | 오류 설명과 Console 링크. 재시도 안 함 |
| 지역, 모델 없음(404), 대화 길이, 작업 상한 | 무엇을 바꿀지 안내. 재시도 안 함 |
| 일시 제한(429), 과부하(529·5xx) | "조금 뒤 다시"와 **명령 다시 넣기**. 저절로 보내지 않음 |
| 이어 갈 수 없음 | 읽기 전용과 새 대화 제안 |
| 관리 정책 차단 | 메시지 그대로 |
| `auto` 불가 | Manual + 카드 제안 |
| 검증 안 된 새 버전 | "확인되지 않은 버전" 표시, 파서는 모르는 이벤트 무시 |

로그인 상태는 보지 않습니다. 키만 씁니다.

## 15. 다른 모델: 실행기 경계 (이번에는 경계만)

```
runner.check() -> { installed, version, problems[] }
runner.start({ prompt, cwd, resumeId, model, mode, hostTools, env }) -> handle
handle.events  // text, toolCall, approvalRequest, question, usage, limit, done, error
handle.respond(id, answer); handle.stop()
```

Claude 전용 인자는 이 파일에만 둡니다(구현: `widgets/ai-chat/lib/claude-runner.js`). 세션의 `runner`·`runnerSessionId`, 모델 중립 Markdown 요약으로 다른 실행기를 받을 수 있게 합니다. Gemini·GPT CLI의 약관·인증은 이번에 조사하지 않았고, 확장할 때 먼저 확인합니다.

## 16. 단계

### 16.1 스파이크 (끝남. 결과는 16.1.2, 16.1.3)

**세션이나 팀장은 키를 입력·표시·저장하지 않고 실제 호출도 하지 않습니다.** 도구는 tools/ai-chat-spike/spike.js, 안내는 README입니다.

1. 사용자가 Console에서 전용 workspace와 키를 만들고 spend limit($5 권장)을 정합니다.
2. 사용자가 **자기 터미널**에서 실행합니다. 키는 숨김 입력, 메모리에만, 인자·파일·로그·결과·화면에 쓰지 않습니다. 자식 환경은 허용 목록 + 시험별 키 방식(V1·V2·V3).
3. 사전 점검 뒤 임시 폴더에서만 호출 25번, 기본 모델 `claude-haiku-5-5`, 호출마다 `--max-budget-usd`, 전체 상한 $1. `bypassPermissions`는 쓰지 않습니다.
4. 결과는 `<임시 폴더>/results.json`과 `summary.txt`. 이벤트 종류·필드 이름·값의 형태만 남기고 경로·이메일·ID를 가립니다. 끝에 키가 없는지 검사합니다. 사전 점검이나 호출에서 인증·권한·범위·크레딧·한도 오류가 나면 바로 멈추고 원인을 안내합니다(종료 코드 3).
5. 사용자가 요약을 붙여 넣거나 경로를 알려 줍니다. S8은 Console에서 사용자가 확인합니다.

자동 시험(`engine/test/ai-chat-spike.test.js`)은 가짜 `claude`로 키 비노출·상한·임시 폴더를 확인합니다.

| # | 확인 | 영향 |
|---|---|---|
| S1 | `--bare -p --permission-mode auto`가 되는지, 모델 alias, 비용 | 기본 모드 |
| S2 | bare + `--tools`(도구, `--agents`, 웹) 대 격리한 non-bare(도구, 웹), PowerShell(Git Bash 없는 PC) | **넓은 범위, bare 유지 여부(C2)** |
| S3 | prompt tool 입력·출력, `auto`와의 전환, `AskUserQuestion` 전달 | 카드, C안 전환 |
| S4 | API 키에서 `rate_limit_event` 필드·빈도 | 한도 UI |
| S5 | V1·V2·V3의 init 모드, 명령·MCP 환경의 키, 헬퍼 재실행 가능 여부, `CLAUDE_CODE_MCP_ALLOWLIST_ENV` | **키 안전과 `auto`(C3·C4)** |
| S6 | Windows 중지: stdin 닫기, 트리 종료, 이어 가기 | 중지, C안 전환 |
| S7 | `total_cost_usd`와 Console Cost 차이 | 추정 문구 |
| S8 | Max 연결 조직 키에서 크레딧 차감(구독 한도 그대로인지) | 안내 문구 |

예상 비용: 약 $0.10(추정), 상한 $1.

#### 16.1.2 2차 결과와 사용자 결정 (2026-11-07)

2차 실행: 사전 점검 200, 25번 실행, 추정 $0.1716(이 중 $0.15는 중지 시험 3번을 예산으로 계산한 값). 호출 하나는 대부분 $0.001 미만이고 웹 검색 + 읽기 호출이 $0.014입니다. Claude Code 2.1.309. 1차의 "미확인"은 이 결과로 대체합니다.

| 항목 | 결과 |
|---|---|
| bare 도구 | `Bash, Edit, PowerShell, Read`뿐. `--tools`로 `Write, WebSearch, WebFetch, Agent, AskUserQuestion`이 더해지지 않음 |
| 격리 non-bare 도구 | `WebSearch, WebFetch, Write` 있음. 웹 검색·읽기 실제 사용. `Agent` 이름은 없고 `Task`. `CronCreate, PushNotification, SendMessage, Workflow, DesignSync` 등도 보임. `AskUserQuestion`은 `auto` 목록에 없고 `default`에 있음 |
| 스킬·플러그인 | bare와 non-bare 모두 "스킬 18, 플러그인 3". `--disable-slash-commands`로 스킬이 0개가 됨(16.1.3) |
| 키 V1 | `default` 강제, 명령 환경에 키 없음 |
| 키 V2 | `auto`, 명령에 키 보임. MCP는 `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`이면 없음 |
| 키 V3 open | `auto`, 환경에 키 없음, 헬퍼 재요청으로 키 획득됨 |
| 키 V3 once | **`auto`, 환경에 키 없음, 재요청 거절** |
| 승인 | approve 입력 키는 `input, tool_name, tool_use_id`. allow·deny 동작. `auto`에서 파일 쓰기는 카드 없이 통과 |
| 질문 | `ask_user`는 `auto`에서 동작. `AskUserQuestion`은 approve까지 오지만 답 전달 미확인 |
| 한도·비용 | `rate_limit_event` 0번. `total_cost_usd` 있음. 중단된 실행은 비용 미보고 |
| 중지 | SIGINT 경로: 279ms에 끝났지만 **probe가 살아남음**. stdin 닫기: 빨리 끝나지 않음. 트리 종료: 517ms, probe 죽음, 이어 가기 됨 |

**사용자 결정**. S9를 통과해 확정했습니다(16.1.3).

| 항목 | 결정 |
|---|---|
| 실행 | 격리 non-bare: `claude -p` + `CLAUDE_CONFIG_DIR=<위젯 전용 폴더>` + `--setting-sources user --strict-mcp-config` |
| 키 | V3 `apiKeyHelper`, 실행마다 새 키 서버와 일회용 값, 한 번만 응답 |
| 승인 | 기본 `auto`. `bypassPermissions`는 공개판에 없음 |
| 질문 | 위젯 MCP `ask_user` |
| 중지 | 프로세스 트리 종료. 멈춘 작업은 `--resume`으로 이어 감 |
| 잔여 | 월 예산 − 추정 사용액. `rate_limit_event`는 오면 표시만 |

**남는 위험 (공개판 안내에 그대로 적음)**
- 같은 Windows 계정으로 실행되는 프로그램은 저장된 키를 풀 수 있습니다(DPAPI). 위젯이 실행한 명령도 같은 계정이므로, 환경에 키가 없고 헬퍼가 한 번만 응답해도 **`secrets.json`을 직접 풀면 키를 얻을 수 있습니다**. V3 once는 우발적 노출과 단순 재요청을 막는 것이지 격리가 아닙니다.
- 그래서 **전용 workspace 키와 낮은 spend limit이 필요합니다**. "키가 새지 않는다"고 말하지 않습니다.
- `auto`는 "does not guarantee safety"입니다(문서).
- 실행이 키를 받기 전에 다른 프로그램이 일회용 값을 알아내 먼저 요청하면 Claude Code가 거절당합니다. 이때는 실패로 보이고, 위젯은 "다른 프로그램이 키를 요청했을 수 있음"으로 안내합니다.

**추가로 지킬 것 (문서)**: non-bare `-p`는 신뢰하지 않은 폴더에서도 `.claude/settings.json`의 hook과 `.mcp.json` 서버를 실행합니다. 문서가 제시한 막는 방법이 `--setting-sources user`이고 이를 필수로 둡니다([permissions](https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder)). S9에서 폴더의 `CLAUDE.md`·스킬·명령·hook·`.mcp.json`이 모두 영향이 없음을 확인했으므로 `disableAllHooks`와 `CLAUDE_CODE_DISABLE_CLAUDE_MDS`는 넣지 않습니다.

**긴 작업과 헬퍼 TTL: 안 A로 결정.** 문서: 헬퍼 값은 기본 5분 캐시, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`로 변경, 401·403이면 조용히 재시도합니다. S9 3번: open은 6초 TTL 뒤 헬퍼를 다시 불렀고, once는 거절돼 stderr에 `apiKeyHelper failed: exited 1`이 났지만 실행은 성공으로 끝났습니다. 24시간 TTL이 실제로 유지되는지는 **미확인**입니다(16.5). 그래서 실행이 **실패로 끝나고** 헬퍼 거절이 있었을 때만 위젯이 새 키 서버로 `--resume`을 한 번 자동 시도합니다. 세션 ID가 없거나 다시 실패하면 "다른 프로그램이 키를 요청했을 수 있음"으로 안내합니다. 안 비교:

| 안 | 방법 | 평가 |
|---|---|---|
| **A (결정)** | TTL을 실행 수명보다 길게(24시간). 실행마다 새 일회용 값, 한 번 응답. 재요청으로 실패하면 위젯이 새 키 서버로 `--resume`을 **한 번** 자동 시도 | 키 응답 창이 가장 짧음. TTL 상한이 있으면 긴 작업에서 재개가 일어남(문서에 상한 없음, 미확인) |
| B | TTL마다 한 번 응답 허용(마지막 응답 뒤 TTL이 지나면 다시 한 번) | 일회용 값을 아는 명령도 만료 직후 먼저 받을 수 있음. 먼저 받으면 Claude Code가 거절당해 드러남. 긴 작업이 끊기지 않음 |
| C | 만료마다 새 일회용 값으로 교체 | 헬퍼 명령은 시작 때 고정이므로 다음 값을 헬퍼가 알 방법이 또 필요합니다. B보다 나은 점이 작고 복잡해 비추천 |

만료와 무관하게 재요청이 잦아 작업이 자주 끊기면 B로 다시 올립니다.

**남길 도구 (S9 4번으로 확정)**: `Read, Edit, Write, Glob, Grep, Bash, PowerShell, WebSearch, WebFetch, Task`. `ToolSearch`는 없어도 `ask_user`와 WebFetch가 동작했으므로 넣지 않습니다. `--tools`로 다음이 빠짐을 확인했습니다: `CronCreate, CronDelete, CronList, DesignSync, EnterWorktree, ExitWorktree, ListAgents, Monitor, NotebookEdit, PushNotification, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, Workflow`. 이유는 위젯 작업과 무관하거나, 실행이 끝난 뒤 남는 예약·백그라운드를 만들기 때문입니다. **`PowerShell`은 요청했지만 빠졌습니다**(16.1.3).

**`--bare` 기본화**: 문서는 "will become the default for `-p` in a future release"라고 하며, 이를 끄는 옵션은 headless 문서와 2.1.309의 `--help`에 **없습니다**(S9 7번). 기본화되면 이 구조의 전제가 깨질 수 있습니다. 위젯은 검증한 버전을 표시하고(14.3), init의 도구 목록에 필요한 도구가 없으면 멈추고 알립니다. 그때 대안은 bare + 위젯 MCP 웹 도구 또는 Agent SDK입니다. 새 버전마다 `--help`를 다시 확인합니다.

**중단된 실행의 비용**: `total_cost_usd`가 오지 않습니다. 위젯 추정 사용액에는 받은 `assistant` 이벤트의 usage를 메시지별로 한 번씩 가격표로 계산해 더하고 "추정"으로 표시합니다(10장).

#### 16.1.3 S9 결과 (2026-11-07 사용자 실행, Claude Code 2.1.309, 호출 9번, 추정 $0.0102)

16.1.2의 구조를 그대로 재시험해 **확정**했습니다. 판정 "실패"가 나온 4번 도구 시험은 PowerShell만의 문제입니다(사용자 확인).

| # | 확인 | 결과 |
|---|---|---|
| 1 | 조합 | **통과.** 키 출처 `apiKeyHelper`, 모드 `auto`, 명령·MCP 환경에 키 없음, 재요청 거절 |
| 2 | 이어 가기 | **통과.** `--resume`은 실행마다 새 키 서버로 동작 |
| 3 | 헬퍼 TTL | open은 6초 TTL 뒤 헬퍼를 다시 부름. once는 거절돼 stderr에 `apiKeyHelper failed: exited 1`이 났지만 실행은 성공. 24시간 유지는 **미확인**. **안 A로 결정** |
| 4 | 도구 줄이기 | 불필요한 도구가 빠짐. `ToolSearch` 없이 `ask_user`, WebFetch 동작. **`PowerShell`이 빠짐**(Git Bash 있는 PC, 헬퍼 인증). **`CLAUDE_CODE_USE_POWERSHELL_TOOL=1`을 자식 환경에 넣기로 함, 실제 확인은 16.5** |
| 5 | 로그인·기록 | 키 없으면 `Not logged in`으로 실패(사용자 로그인을 읽지 않음). 기록은 전용 `CLAUDE_CONFIG_DIR`에만 쌓이고 지우면 이어 가기 안 됨 |
| 5 | 작업 폴더 | `CLAUDE.md`, 스킬, 명령, hook, `.mcp.json` 모두 영향 없음 |
| 6 | 스킬·플러그인 | `--disable-slash-commands`면 스킬 0개. 내장 플러그인 3개(`cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`, 모두 builtin)는 남음. **이 옵션을 쓰는 것을 추천하고 실행기에 넣음** |
| 7 | bare 기본화 | `--help`에 non-bare 유지 옵션 없음 |
| | 한도 | `rate_limit_event` 0번 |

#### 16.1.1 1차 실행 결과 (2026-11-07, Claude Code 2.1.309, 기록용: 판단은 16.1.2와 16.1.3이 대체)

숨김 입력과 키 검사는 정상이었고, 호출 19번이 **모두 실패**했습니다(비용 $0). 모델 응답을 받은 호출이 없으므로 S1~S7의 판단 자료가 아닙니다. init 단계까지의 사실은 다음과 같습니다.

| 사실 | 근거 | 영향 |
|---|---|---|
| 모든 호출이 `API Error: 400 This API key is not scoped to a workspace…` | 실행 결과, Authentication 문서와 일치 | 안내 잘못(README 고침). 위젯도 안내 필요(6장, 14.3) |
| SCRUB=1이면 init 모드가 항상 `default`. stderr에 `Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set` | 실행 결과. **문서에는 없음** | **C3(`auto`)과 C4(환경 정리)가 충돌** |
| bare에서 `--tools`로 웹이 늘지 않음. Read,Edit,Write,Bash,PowerShell,WebSearch,WebFetch,Agent → Bash, Edit, PowerShell, Read. `Read,Write` → Read. `Read,AskUserQuestion` → Read | 실행 결과의 init(모델 호출 전 단계) | C2 재판단. bare에서는 `AskUserQuestion`도 없을 가능성 |
| MCP 연결됨, host 환경에 키 없음 | 실행 결과 | SCRUB=1일 때의 값. V3은 16.1.2·16.1.3 |

이때의 선택지(V1·V2·V3, bare와 non-bare 비교)와 당시 판단은 16.1.2의 결정으로 대체되어 git 이력에만 둡니다.

### 16.2 구현 세션 분담

| 세션 | 내용 |
|---|---|
| 1 | 스파이크 결과 반영(문서 갱신, A/C 확정). **끝남** |
| 2 | 위젯 뼈대, 키 설정(DPAPI), 동의 화면, 사전 조건, 실행기·파서·허용 환경. **끝남**(최소 창: 명령을 보내 결과 글을 받음) |
| 3 | 창, 세션 목록·기록, 중지·종료, 대기열. **끝남** |
| 4 | `ai-chat-host`, 승인·질문 카드, 다리 연결. **끝남** |
| 5 | 비용·예산 띠, 서버 오류 안내. **끝남** |
| 6 | 피드백, 요약, 버전, 비밀 검사, 오염 대책, 찾기. **끝남** |
| 7 | 문서, 개인정보, 위키 등록. **끝남**. 소개 페이지는 공개 때(16.8의 초안) |

### 16.3 비용 추정 (실측 아님)

S9 기준 작은 호출은 Haiku로 대부분 $0.001 미만이었지만, 큰 작업의 실측은 아직 없습니다. 아래는 고정 부분을 약 6,000토큰으로 가정한 값입니다. 가격 2026-11-07 [Pricing](https://platform.claude.com/docs/en/about-claude/pricing).

| 작업 | 요청 | 캐시 쓰기 | 캐시 읽기 | 출력 | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|---|---|---|---|
| 작은 작업 + 요약 | 5 | 9,460 | 33,770 | 1,120 | $0.08 | $0.04 | $0.002 |
| 중간 작업(평균 맥락 5만) | 30 | 60,000 | 1,250,000 | 8,000 | $0.71 | $0.36 | $0.02 |

하루 작은 작업 3번이면 Opus 월 약 $7, 작은 3번·중간 3번이면 약 $71입니다. 공개 사용자는 자기 비용이므로 첫 실행에서 모델을 고르게 하고 이 표의 범위를 보입니다. 스파이크 뒤 실측으로 고칩니다.

### 16.4 자동 시험 (실제 호출 없음)

`widgets/ai-chat/test`. 가짜 `claude`(`fake-claude.js`)가 stream-json을 재생하고 `--mcp-config`의 서버를 Claude Code처럼 실제로 띄워 부릅니다. `page.test.js`는 실제 페이지를 숨긴 Electron 창에서 돌리고 로컬 서버로 요청을 셉니다.
- 인자: `--bare` 없음, 격리 옵션과 `--tools` 항상, `bypassPermissions`·`dontAsk` 거부, 셸 없음, 인자에 키 없음, `--resume`에 옵션 재전달.
- 환경: 허용 목록만, 금지 변수 제거, 키 없으면 프로세스 안 띄움, 헬퍼가 cmd·PowerShell·Git Bash에서 같음.
- 키: IPC·기록·로그·오류·카드·요약 전부에 키 없음, 평문 저장 거절, Admin 키 거절.
- 주입: 수동 모드에서 카드 없이 쓰기 안 됨(요약의 지시 포함), 모델 글이 카드 버튼을 흉내 내지 못함, 원격 이미지·링크가 요청을 내지 않음, 스크립트 `click()`으로 승인·저장 안 됨.
- 파서, 대기열, 세션별 기록 삭제, 종료 확인, 예산, 오류 표, 요약, 사전 조건.
- 공개 사본: 위젯·문서·미공개 구역이 나가지 않음.

### 16.5 내부 테스트

- 새 위젯은 개발 중 `0.0.x`, `-test.N`으로 Gitea 사전 릴리스(정책 "단계 배포"). 버전은 배포 때 사용자에게 확인합니다.
- 사용자가 자기 PC에 설치해 실제 키로 확인합니다. 절차: 내부 테스트 체크리스트.
- **자동 시험으로 볼 수 없어 여기서 확인할 것**:
  - `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`일 때 init 목록에 `PowerShell`이 나오는지(Git Bash 있는 PC). Git Bash 없는 PC에서 자동으로 켜지는지.
  - 실제 Claude Code가 `ai-chat-key.cmd`를 실행해 키를 받는지(시험은 cmd·PowerShell·Git Bash 각각에서 스크립트만 확인). 설치본 엔진 exe의 Node 모드 포함.
  - 24시간 TTL이 유지되는지, 키 재요청 실패 때 자동 `--resume`이 작업을 잇는지.
  - `ToolSearch` 없이 WebSearch가 불리는지.
  - 연결 확인(`GET /v1/models`)이 workspace 범위 오류를 잡는지.
  - 실제 실행에서 프로세스 트리 종료.
  - 세션별 `CLAUDE_CONFIG_DIR`에서 `--resume`이 되는지, 세션마다 첫 실행 지연이 있는지, 지우면 이어 가기가 안 되는지.
  - `--include-partial-messages`의 글자 표시, 쓰기 제한 키가 2.1.314 미만에서 오류 없이 무시되는지, deny 규칙이 실제로 막는지(`%APPDATA%\chilgong88` deny가 세션 폴더의 자동 메모리에 끼치는 영향 포함).
  - 앱 종료 확인은 엔진 변경이 있어 새 엔진에서만 동작.
  - 기억: 실제 Claude가 "기억해 둬"에 save_memory를 부르는지, 자동 메모리가 정말 꺼졌는지(설정 폴더에 memory가 생기지 않는지), 다음 대화에서 규칙을 따르는지.
  - 정정: 실제 Claude Code에서 멈춘 뒤 `--resume`이 매끄럽게 이어지는지, 멈춘 차례의 일부 결과를 Claude가 아는지.
  - 두레이 원본: auto 방식에서 두레이 알림 카드가 실제로 뜨는지, 대기 줄과 받지 않음 표시, 사본을 Read로 읽는지.
  - 첨부: Claude가 Read로 이미지를 실제로 보는지(PNG·JPEG, 큰 이미지), PDF·오피스 파일을 어떻게 읽는지, 수동 모드에서 첨부 읽기에 카드가 뜨는지, 실제 탐색기 복사 → Ctrl+V가 파일로 붙는지.
  - 실제 Claude Code가 엔진 exe의 Node 모드로 `ai-chat-host`를 띄우는지(`env`의 `ELECTRON_RUN_AS_NODE`), 설치본에서 다리 경로(`app.asar.unpacked`)가 맞는지, 토큰이 든 `--mcp-config` 파일이 끝나고 지워지는지.
  - 수동 모드에서 파일 수정이 카드 없이 일어나지 않는지, `auto`에서 카드가 얼마나 자주 나오는지.
  - `ToolSearch` 없이 다리 도구가 불리는지.
  - `--append-system-prompt-file`이 S9 조합에서 그대로 되는지, 모델이 요약 목록을 보고 `read_recipe`를 부르는지, 요약 요청이 도구 없이 끝나는지.
  - `api_retry` 이벤트의 실제 필드 이름(`attempt`, `max_retries`, `retry_delay_ms`, `error`, `error_status`는 문서 기준, 실제 실행 미확인), 오류 글의 실제 모양, Console 금액과 추정의 차이(S7), 이어 간 실행과 중단된 실행의 합산.

### 16.6 정식 배포

1. 공개 전 체크리스트(16.7) 통과, 사용자 승인.
2. `widgets/ai-chat/widget.json` 버전 확정 → `npm run widget -- widgets/ai-chat` → 설치 확인 → 커밋·푸시.
3. `release-notes/widget-ai-chat-v<버전>.md`, `npm run release -- ai-chat …`(Gitea + 공개 GitHub), `site/releases.json` 기록과 `npm run site:build`, 사이트 배포.
4. 위키 게시, 변경 이력, 정책 행, 이슈 닫기.

### 16.7 공개 전 체크리스트 (사람이 확인)

- [ ] Commercial Terms, Usage Policy, Legal, Trademark 원문을 읽고 소개 문구·동의 화면과 대조(요약 도구로 읽은 항목).
- [ ] 게시자 Console 조직에서 Commercial Terms 동의.
- [x] 4.5의 문의를 보냈고, C8 결정대로 처리(답 없음, 2026-11-23 사용자가 공개 진행 결정).
- [ ] 스파이크 결과 반영(S9까지 끝남), S7·S8 확인, 비용 표 실측.
- [ ] 실제 주입 시험, 키 누출 시험 통과.
- [ ] 동의 화면이 8.1 그대로 나오는지.
- [ ] 소개 페이지·이름·아이콘에 Anthropic 제휴처럼 보이는 표현과 로고가 없는지.
- [ ] 코드 서명 상태 안내 확인(C7: 서명 없이 공개, 소개 페이지에 SmartScreen 경고와 SHA-256 확인 안내).

### 16.8 소개·안내 문서

- **사용자 가이드**: [AI Widgets 위젯](ai-chat.md)과 `user-guide.md`의 표시 구역.
- **개인정보 안내**: `privacy.md`의 표시 구역.
- **공개 때 할 일**: `user-guide.md`, `privacy.md`, `widget-dev.md`의 미공개 표시 지우기, `scripts/public-export.json`에서 ai-chat 줄 지우기, 아래 초안 넣기, `scripts/site-build.js`의 스크린샷 표.
  - **2026-11-23 공개 준비(0.1.1)에서 한 것**: 미공개 표시를 지움. `public-export.json`에서 위젯·이 설계·사용법·릴리스 노트를 공개로 돌리고, **내부 테스트 절차(`ai-chat-internal-test.md`, 실제 키로 하는 개발자 절차)와 시험 도구(`tools/ai-chat-spike`, 실제 유료 호출)는 비공개로 남김**. 소개 초안을 `site/public/showcase.json`에 넣음(제휴 없음, 서명 없음·SmartScreen, SHA-256 확인 문구 포함, 로고 없음). README에 소개 추가. 릴리스 노트 초안 `release-notes/widget-ai-chat-v0.1.1.md`.
  - **2026-11-23 이어서**: 사용자 승인으로 `widget.json`을 **0.1.1**로 올림. 스크린샷 3장(`docs/images/ai-chat.png`, `ai-chat-tools.png`, `ai-chat-approval.png`)은 `node widgets/ai-chat/test/screenshots.js`로 만듦: 실제 위젯 코드와 대화 페이지를 숨긴 창에서 돌리고, 지어낸 실행을 재생하는 `test/demo-claude.js`와 가짜 키를 씀(실제 키·API 호출 없음, 화면에 창 없음). 정보 줄의 작업 폴더(임시 폴더)는 지어낸 경로로 바꿔 찍고, 실제 경로가 보이면 멈춤. `showcase.json`, `SCREENSHOTS`, 사용법, README에 연결.
  - **남은 것(배포 담당)**: 빌드·릴리스·사이트 배포·위키.
- **소개 페이지 초안** (`products.json`의 설명은 `widget.json`에서 옴. 지금 사이트 파일에 넣지 않습니다. 제휴가 없음을 작게 적고, 로고를 쓰지 않으며, 문구는 16.7에서 사람이 확인합니다):

```json
"ai-chat": {
  "features": [
    "말로 시키면 이 PC의 Claude Code가 작업하고 결과를 돌려줌",
    "대화 목록과 이어 가기, 대화별 기록 삭제",
    "승인과 질문은 카드로, 입력 전문을 보고 직접 결정",
    "만족한 작업을 요약해 두었다가 비슷한 일에 다시 사용",
    "월 예산 기준 잔여 추정 표시와 작업 상한"
  ],
  "requires": "Claude Code가 설치된 PC와 내 Anthropic API 키가 필요합니다. 사용한 만큼 내 Anthropic 조직에 청구됩니다. 내 Windows 계정 권한으로 실행되며 작업 폴더는 격리 공간이 아닙니다. Anthropic과 제휴한 제품이 아닙니다.",
  "images": []
}
```
- **코드 서명 미적용 안내**: **서명 없이 공개합니다(C7, 사용자 결정 2026-11-23).** SignPath 승인이 나면 서명판으로 교체합니다([code-signing](code-signing.md)). 사유: 신청(2026-10-24) 뒤 한 달간 응답이 없고, 엔진과 다른 위젯도 서명 없이 배포 중이며, 서명은 법적·기술적 필수가 아닙니다. 이 위젯은 사용자 PC에서 프로그램을 실행하고 키를 다루므로 소개 페이지·설치 안내에 "SmartScreen 경고가 뜰 수 있음, 다운로드 페이지와 SHA-256 확인"을 눈에 띄게 적습니다(`site/showcase.json`의 `requires`).

## 17. 이전 결정 정리

| 이전 | 지금 |
|---|---|
| 구독 경로, 조건부 분기(B8) | **삭제**. 서면 허용 시 재검토 |
| `--bare` 사용 | **쓰지 않음**(웹 도구 없음). 기본화 위험이 다시 생겨 도구 검사로 대비(16.1.2) |
| `bypassPermissions` 선택 설정 | **공개판에서 삭제** |
| 새 폴더 첫 사용 확인 | **유지**(설정 차단 때문이 아니라 위험을 실행 전에 알리려고, 8.3장) |
| 위젯은 키 저장 안 함 | **되살림**(DPAPI, 6장) |
| 구독 한도 % 표시, `/usage` | **삭제**, 예산 기반 추정 |
| 사전 조건 `claude auth status` | **삭제**, 키만 확인 |
| 위젯 형태, 세션, 카드, 요약, 다리 연결, 실행기 경계 | 유지 |
| 엔진 API 변경 | 없음 유지 |

## 18. 개인정보 안내

[개인정보 안내](privacy.md)의 "AI Widgets 위젯"에 있습니다. 기록 위치, 세션별 삭제, 잠긴 노트를 넘기지 않는다는 것(#133으로 캘린더 도구의 틈을 고침, 캘린더 1.1.3까지는 남음)을 현재 상태로 적었습니다.

## 19. 사용자 결정 (2026-11-07. C1~C4는 2차 시험 뒤 16.1.2로 갱신, S9 통과로 확정. C7·C8은 2026-11-23 갱신: 서명 없이 공개)

| # | 결정 | 추천 → **결정** |
|---|---|---|
| C1 | 실행 구조 | **설치본 `claude -p`, 격리 non-bare**(전용 `CLAUDE_CONFIG_DIR`, `--setting-sources user --strict-mcp-config --disable-slash-commands`, `--tools`). `--bare`는 쓰지 않음(웹 도구 없음). 막히면 Agent SDK JS + 설치본. 실행 파일 동봉(344.8MB)은 설치 조건을 없앨 2차 후보 |
| C2 | 웹 도구와 넓은 범위 | **격리 non-bare로 내장 웹 도구 사용**(bare는 `--tools`로 안 늘어남, 16.1.2) |
| C3 | 승인 모드 | **기본 `auto`, 못 쓰면 Manual + 카드, `bypassPermissions`는 공개판에 없음**. SCRUB 대신 V3을 써서 `auto`를 유지(16.1.2). 질문은 `ask_user`, 중지는 트리 종료 |
| C4 | 키 위험 고지 | **환경 정리 + 전용 workspace·낮은 한도 권장 + "유출 가능성을 없앨 수 없음" 명시**. 환경 정리는 **V3 `apiKeyHelper` 한 번 응답**(16.1.2). 같은 계정 프로그램은 저장 키를 풀 수 있어 전용 키·낮은 한도 필요 |
| C5 | 잔여 표시 | **사용자 월 예산 − 위젯 추정 사용액을 "추정"으로, Console 링크, 기본 예산 $20, 작업 상한 $3, Admin 키 안 받음** |
| C6 | 기본 모델 | **첫 실행에서 사용자가 고름**(기본 선택 Opus 5.5, 추정 비용 함께 표시). 사용자 비용이므로 저렴한 쪽을 대신 정하지 않음 |
| C7 | 코드 서명 | ~~SignPath 서명 뒤 공개~~(2026-11-07) → **서명 없이 공개. SignPath 승인이 나면 서명판으로 교체**(사용자 결정 2026-11-23). 사유: 신청(2026-10-24) 뒤 한 달간 응답 없음, 엔진과 다른 위젯도 서명 없이 배포 중, 서명은 법적·기술적 필수가 아님. 대신 소개 페이지에 SmartScreen 경고와 SHA-256 확인 안내 |
| C8 | Anthropic 문의 | **보내되 공개를 막는 조건으로는 두지 않음**: 답이 없으면 일정 기간 뒤 사용자가 판단. 부정적 답이면 공개 중단. **2026-11-23: 답이 없어 사용자가 공개 진행을 결정.** 나중에 부정적 답이 오면 공개를 멈춤 |
