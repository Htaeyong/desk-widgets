// ICS subscription source (read-only): one http(s) .ics address = one calendar.
const { parseIcs } = require('./ical');
const { SourceError, readCapped } = require('./http');

const TIMEOUT_MS = 20000;
const MAX_BYTES = 10 * 1024 * 1024;

function httpMessage(status) {
  if (status === 401 || status === 403) return '접근이 거부되었습니다. 비공개 주소가 바뀌었거나 만료되지 않았는지 확인하세요.';
  if (status === 404 || status === 410) return '주소를 찾을 수 없습니다. 구독 주소를 확인하세요.';
  if (status === 429) return '요청이 너무 많다고 서버가 거절했습니다. 잠시 뒤 다시 시도합니다.';
  if (status >= 500) return `캘린더 서버 오류입니다 (HTTP ${status}). 잠시 뒤 다시 시도합니다.`;
  return `캘린더를 받지 못했습니다 (HTTP ${status}).`;
}

/**
 * Fetches one ICS subscription.
 *   source: { url }; prev: { etag, lastModified } from the last success.
 * Returns { notModified: true } or { validators, calendars: [{ id, name, readOnly, components }] }.
 */
async function fetchIcs(source, { fetch = globalThis.fetch, prev = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SourceError('응답 시간이 초과되었습니다.', 'timeout')), timeoutMs);
  try {
    const headers = { Accept: 'text/calendar, */*;q=0.5', 'User-Agent': 'DeskWidgets-Calendar' };
    if (prev.etag) headers['If-None-Match'] = prev.etag;
    if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
    let res;
    try {
      res = await fetch(source.url, { headers, redirect: 'follow', signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new SourceError('응답 시간이 초과되었습니다.', 'timeout');
      throw new SourceError(`연결하지 못했습니다: ${err.cause?.code || err.message}`, 'network');
    }
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new SourceError(httpMessage(res.status), `http-${res.status}`);
    let text;
    try {
      text = await readCapped(res, controller, MAX_BYTES);
    } catch (err) {
      if (err instanceof SourceError) throw err;
      if (controller.signal.aborted) throw new SourceError('응답 시간이 초과되었습니다.', 'timeout');
      throw new SourceError(`받는 중 연결이 끊겼습니다: ${err.message}`, 'network');
    }
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) {
      throw new SourceError('iCalendar(.ics) 형식이 아닙니다. 로그인 페이지가 아닌 공개/비공개 iCal 주소인지 확인하세요.', 'not-ics');
    }
    const parsed = parseIcs(text);
    return {
      validators: { etag: res.headers.get('etag') || '', lastModified: res.headers.get('last-modified') || '' },
      calendars: [{ id: 'default', name: parsed.name, readOnly: true, components: parsed.events }],
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchIcs, SourceError, TIMEOUT_MS, MAX_BYTES };
