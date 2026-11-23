// The user's Anthropic API key: what is accepted, the connection check, and what an API error means.
// Nothing here returns or logs the key, and an answer's text never reaches the user as is.
const KEY_ID = 'anthropic-api-key';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';

/** Why this key is not accepted, or null. Admin keys and subscription tokens are refused (design 6). */
function keyProblem(key) {
  if (!key) return '키를 입력해 주세요.';
  if (key.startsWith('sk-ant-admin')) return '관리자(Admin) 키는 쓰지 않습니다. 전용 workspace의 일반 API 키를 넣어 주세요.';
  if (key.startsWith('sk-ant-oat')) return '구독 로그인 토큰은 쓰지 않습니다. Console에서 만든 API 키를 넣어 주세요.';
  if (!key.startsWith('sk-ant-') || key.length < 20 || /\s/.test(key)) return 'API 키 모양이 아닙니다(sk-ant-로 시작). Console에서 만든 키를 넣어 주세요.';
  return null;
}

/**
 * What an API error text means with what the user should do, or null. The same for the check and for a failed run. `retryable`
 * says whether sending the same thing later can help; nothing here is retried by itself, and the ones that cost nothing to fix
 * by waiting are the only ones that offer it.
 */
function classifyApiError(text) {
  const t = String(text || '');
  if (/not scoped to a workspace|anthropic-workspace-id/i.test(t)) return { kind: 'workspace-scope', retryable: false, link: 'keys', message: '이 키는 workspace 범위가 아닙니다. Console API keys에서 Create key를 누르고 전용 workspace를 골라 키를 다시 만들어 넣어 주세요.' };
  if (/invalid x-api-key|invalid api key|authentication_error|authentication_failed|\b401\b/i.test(t)) return { kind: 'authentication', retryable: false, link: 'keys', message: '키가 거절되었습니다(잘못되었거나 만료·폐기됨). Console에서 키를 확인해 주세요.' };
  if (/permission_error|\b403\b/i.test(t)) return { kind: 'permission', retryable: false, link: 'keys', message: '이 키에 권한이 없습니다. 키의 workspace와 역할을 확인해 주세요.' };
  if (/credit balance|billing_error/i.test(t)) return { kind: 'credit', retryable: false, link: 'billing', message: '크레딧이 없습니다. Console Billing에서 잔액을 확인해 주세요.' };
  if (/reached your specified|enforced_spend_limit_reached/i.test(t)) return { kind: 'spend-limit', retryable: false, link: 'workspaces', message: '사용 한도에 닿았습니다. Console에서 workspace의 spend limit을 확인해 주세요.' };
  if (/unsupported_country|not available in your (country|region)/i.test(t)) return { kind: 'region', retryable: false, message: '이 지역에서는 API를 쓸 수 없습니다. Anthropic의 지원 지역을 확인해 주세요.' };
  if (/not_found_error|model.*not (found|available)|\b404\b/i.test(t)) return { kind: 'model', retryable: false, message: '이 모델을 쓸 수 없습니다. 설정에서 다른 모델을 골라 주세요.' };
  if (/prompt is too long|context.*(too long|exceeded)/i.test(t)) return { kind: 'too-long', retryable: false, message: '대화가 너무 길어졌습니다. 새 대화로 시작해 주세요.' };
  if (/rate_limit_error|rate limit|\b429\b/i.test(t)) return { kind: 'rate-limit', retryable: true, message: '요청이 잠시 제한되었습니다. 조금 뒤 다시 보내 주세요.' };
  if (/overloaded|\b529\b|\b50[023]\b|api_error/i.test(t)) return { kind: 'overloaded', retryable: true, message: 'Anthropic 서버가 일시적으로 응답하지 못했습니다. 조금 뒤 다시 보내 주세요.' };
  return null;
}

/**
 * GET /v1/models: uses no tokens. Only when the user presses the button (design 6). Redirects are refused so the key
 * header cannot follow one anywhere else.
 * @returns {Promise<{ ok: boolean, kind?: string, link?: string, message: string }>}
 */
async function checkConnection(key, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetchImpl(MODELS_URL, {
      method: 'GET',
      redirect: 'error',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, kind: 'network', message: '연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  }
  if (res.ok) return { ok: true, message: '연결되었습니다. 토큰은 쓰지 않았습니다.' };
  let body = '';
  try { body = await res.text(); } catch { /* the status is enough */ }
  const known = classifyApiError(`${res.status} ${body}`);
  return known ? { ok: false, ...known } : { ok: false, kind: 'http', message: `확인하지 못했습니다(HTTP ${res.status}). 잠시 뒤 다시 시도해 주세요.` };
}

module.exports = { KEY_ID, MODELS_URL, keyProblem, classifyApiError, checkConnection };
