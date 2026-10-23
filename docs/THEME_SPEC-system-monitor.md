# 시스템 모니터 테마 규격 v1

공통 테마 설치·격리·미리보기 규칙은 [테마 규격](THEME_SPEC.md)에 있습니다. 시스템 모니터 테마는 `theme.json`에 `"widget": "system-monitor"`, `"contractVersion": 1`을 지정합니다. 사용자의 PC 상태를 읽기만 하며, 테마에는 Windows API나 Node 접근 권한이 없습니다.

## 내장 테마

| 테마 | 표시 |
|---|---|
| `graph` | 기본 다크 글래스 카드, CPU 최근 기록 그래프와 전체 항목 |
| `ocean` | 기존 파란 그라데이션 그래프 (`graph` 상속) |
| `bar` | 항목별 막대 |
| `mini` | 작은 상태 표시 |

모든 내장 테마의 배경은 엔진의 `--theme-bg-alpha` 값을 사용합니다. 불투명도를 낮춰도 글자·측정 카드·버튼은 읽을 수 있도록 유지합니다.

## 데이터

`window.widget.api.getState()`는 `{ metrics, settings, locale }`를 반환합니다. 측정 전에는 `metrics`가 `null`일 수 있습니다. 이후 `window.widget.on('metrics', handler)`가 새 측정값을, `window.widget.on('settings', handler)`가 설정 변경을 같은 모양으로 전달합니다. `settings.showCores`는 코어별 CPU 표시 옵션입니다. `locale`은 표시 언어 선택에 사용합니다.

`metrics`의 수치 단위는 다음과 같습니다.

| 필드 | 의미 |
|---|---|
| `at`, `intervalMs` | 측정 시각과 설정한 측정 간격, 밀리초 |
| `cpu.percent`, `cpu.cores[]` | 전체·코어별 CPU 사용률, 0~100% |
| `cpu.history[]` | 최근 CPU 기록 `{ at, percent }`; 기록 기간은 설정값 |
| `memory` | `{ total, free, used, percent }`; 용량은 바이트 |
| `disks[]` | 드라이브별 `{ drive, total, free, used, percent }`; 용량은 바이트 |
| `diskIo` | `{ readBytesPerSec, writeBytesPerSec }`, 바이트/초 |
| `network` | `{ downBytesPerSec, upBytesPerSec }`, 바이트/초 |
| `gpu.percent` | GPU Engine 카운터 사용률, 0~100% |
| `battery` | 배터리가 있으면 `{ percent, charging }`, 없으면 `null` |
| `uptimeSeconds` | 시스템 가동 시간, 초 |

지원하지 않는 장치나 사용할 수 없는 성능 카운터는 해당 값이 `null`입니다. 테마는 다른 측정값은 계속 표시하고, `null`을 0으로 표시하지 않아야 합니다. 메모리·디스크 용량은 알맞은 단위로 바꾸어 표시합니다. CPU 기록은 새로고침 간격이나 사용자의 자리 비움으로 표본 간격이 달라질 수 있으므로 `at`을 기준으로 그립니다.

## 호출과 실행 범위

테마가 호출할 수 있는 위젯 메서드는 읽기 전용 `getState()` 하나입니다. 테마 미리보기에서도 호출할 수 있습니다. 측정은 엔진 API 1.5의 `ctx.system` 서비스가 수행하고, 위젯이 꺼졌거나 사용자가 자리를 비운 동안 중지합니다. 표시할 창이 없거나 다른 창에 완전히 가려졌을 때도 새 측정값을 만들지 않습니다. 투명하거나 특수한 창 때문에 가림을 확정할 수 없으면 측정을 계속합니다. 테마는 측정 자체를 시작하거나 Windows API를 직접 호출할 수 없습니다.
