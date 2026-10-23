// Maps API/network errors to short Korean messages shown to users.
function describeApiError(err) {
  if (err.status === 401 || err.status === 403) return '토큰이 올바르지 않거나 권한이 없습니다.';
  if (err.status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도합니다.';
  if (err.status) return `서버 오류 (${err.status})`;
  if (err.name === 'TimeoutError') return '응답 시간이 초과되었습니다.';
  return '서버에 연결할 수 없습니다. API 서버 주소와 네트워크를 확인해 주세요.';
}

module.exports = { describeApiError };
