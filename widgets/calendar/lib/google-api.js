// Google Calendar API v3 client (#114) with an OAuth access token. Requests go only to the Calendar API's own
// address (https://www.googleapis.com/calendar/v3/); a redirect or another host is refused, not followed.
// A 401 drops the cached access token and tries once more with a fresh one; a second 401 means the grant is
// gone ('reauth'). Writes are conditional (If-Match with the event's ETag), like the CalDAV writes (#48).
const { SourceError, readCapped } = require('./http');

const API = 'https://www.googleapis.com/calendar/v3/';
const TIMEOUT_MS = 30000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 20;

const calendarUrl = (googleId) => `${API}calendars/${encodeURIComponent(googleId)}`;
/** The Google calendar id of a calendar URL (settings keep the URL as the calendar's id), or null. */
function googleIdOf(url) {
  const s = String(url || '');
  if (!s.startsWith(`${API}calendars/`)) return null;
  const rest = s.slice(`${API}calendars/`.length);
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}
const eventUrl = (calUrl, eventId) => `${calUrl}/events/${encodeURIComponent(eventId)}`;
const quoteEtag = (etag) => (/^(W\/)?".*"$/.test(String(etag)) ? String(etag) : `"${etag}"`);

class GoogleClient {
  /**
   * @param {{ tokens: { get(id), invalidate(id) }, accountId: string, fetch?: Function, timeoutMs?: number }} opts
   */
  constructor({ tokens, accountId, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
    this.tokens = tokens;
    this.accountId = accountId;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  /** One API request: { status, json, headers }. allow: statuses returned instead of thrown (304, 404, 410, 412). */
  async request(url, { method = 'GET', body, ifMatch, ifNoneMatch, allow = [] } = {}) {
    if (!String(url).startsWith(API)) throw new SourceError('Google 캘린더 주소가 아니어서 요청하지 않았습니다.', 'untrusted');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.get(this.accountId);
      const res = await this.send(url, method, body, token, { ifMatch, ifNoneMatch });
      if (res.status === 401) {
        this.tokens.invalidate(this.accountId);
        if (attempt === 0) continue;
        throw new SourceError('Google이 로그인을 받아 주지 않습니다. 설정에서 이 계정의 "다시 로그인"을 누르세요.', 'reauth', 401);
      }
      if (allow.includes(res.status)) return res;
      if (res.status >= 300 && res.status < 400) throw new SourceError('Google이 다른 주소로 보내려 해서 따라가지 않았습니다.', 'untrusted', res.status);
      if (res.status < 200 || res.status >= 300) throw apiError(res);
      return res;
    }
    throw new SourceError('Google 로그인이 필요합니다.', 'reauth');
  }

  async send(url, method, body, token, { ifMatch, ifNoneMatch }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'DeskWidgets-Calendar' };
      if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
      if (ifMatch) headers['If-Match'] = quoteEtag(ifMatch);
      if (ifNoneMatch) headers['If-None-Match'] = quoteEtag(ifNoneMatch);
      let res;
      try {
        res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) throw new SourceError('Google 캘린더 응답 시간이 초과되었습니다.', 'timeout');
        throw new SourceError(`Google 캘린더에 연결하지 못했습니다: ${err.cause?.code || err.message}`, 'network');
      }
      let text = '';
      if (res.status !== 204 && res.status !== 304) {
        try {
          text = await readCapped(res, controller, MAX_BYTES);
        } catch (err) {
          if (err instanceof SourceError) throw err;
          if (controller.signal.aborted) throw new SourceError('Google 캘린더 응답 시간이 초과되었습니다.', 'timeout');
          throw new SourceError(`받는 중 연결이 끊겼습니다: ${err.message}`, 'network');
        }
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The user's calendar list: [{ url, googleId, name, color, canWrite, primary }]. */
  async listCalendars() {
    const out = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ maxResults: '250', minAccessRole: 'reader' });
      if (pageToken) q.set('pageToken', pageToken);
      const { json } = await this.request(`${API}users/me/calendarList?${q}`);
      for (const c of json?.items || []) {
        if (!c?.id || c.deleted) continue;
        out.push({
          url: calendarUrl(c.id),
          googleId: c.id,
          name: String(c.summaryOverride || c.summary || c.id).slice(0, 100),
          color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor || '') ? c.backgroundColor.toLowerCase() : null,
          canWrite: c.accessRole === 'owner' || c.accessRole === 'writer',
          primary: c.primary === true,
        });
      }
      pageToken = json?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /**
   * Events of a calendar overlapping [fromMs, toMs), recurring series expanded by Google (singleEvents).
   * ifNoneMatch: the list's ETag from the last read of the same window -> { notModified: true } on 304.
   * Resolves { notModified } or { etag, items }.
   */
  async listEvents(calUrl, fromMs, toMs, { ifNoneMatch } = {}) {
    const items = [];
    let pageToken = null;
    let etag = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({
        singleEvents: 'true',
        showDeleted: 'false',
        timeMin: new Date(fromMs).toISOString(),
        timeMax: new Date(toMs).toISOString(),
        maxResults: '2500',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.request(`${calUrl}/events?${q}`, { ifNoneMatch: page === 0 ? ifNoneMatch : undefined, allow: [304] });
      if (res.status === 304) return { notModified: true };
      if (page === 0) etag = res.json?.etag || res.headers?.get?.('etag') || null;
      items.push(...(res.json?.items || []));
      pageToken = res.json?.nextPageToken;
      if (!pageToken) return { etag, items };
    }
    throw new SourceError('일정이 너무 많아 다 받지 못했습니다.', 'too-many');
  }

  /** The event as Google holds it now, or null when it is gone (deleted or cancelled). */
  async getEvent(calUrl, eventId) {
    const res = await this.request(eventUrl(calUrl, eventId), { allow: [404, 410] });
    if (res.status === 404 || res.status === 410 || res.json?.status === 'cancelled') return null;
    return res.json;
  }

  async insertEvent(calUrl, resource) {
    return (await this.request(`${calUrl}/events`, { method: 'POST', body: resource })).json;
  }

  /** Changes only the given properties, if the event is still the version we saw (412 -> 'conflict'). */
  async patchEvent(calUrl, eventId, resource, { ifMatch }) {
    if (!ifMatch) throw new SourceError('조건 없는 쓰기는 하지 않습니다.', 'unconditional');
    return (await this.request(eventUrl(calUrl, eventId), { method: 'PATCH', body: resource, ifMatch })).json;
  }

  /** Deletes the event if it is still the version we saw. Returns false when it was already gone. */
  async deleteEvent(calUrl, eventId, { ifMatch }) {
    if (!ifMatch) throw new SourceError('조건 없는 삭제는 하지 않습니다.', 'unconditional');
    const res = await this.request(eventUrl(calUrl, eventId), { method: 'DELETE', ifMatch, allow: [404, 410] });
    return !(res.status === 404 || res.status === 410);
  }
}

/** A Korean SourceError for a non-2xx API answer. */
function apiError({ status, json }) {
  const reason = json?.error?.errors?.[0]?.reason || json?.error?.status || '';
  if (status === 412) return new SourceError('다른 곳(다른 기기나 Google 캘린더)에서 이 일정이 바뀌었습니다. 새로 받은 내용을 확인한 뒤 다시 시도하세요.', 'conflict', 412);
  if (status === 429 || (status === 403 && /rateLimit|quotaExceeded/i.test(reason))) {
    return new SourceError('Google이 요청이 너무 많다고 잠시 거절했습니다. 잠시 뒤 다시 시도합니다.', 'rate', status);
  }
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason)) {
    return new SourceError('Google 계정 권한이 부족합니다. 설정에서 "다시 로그인"을 눌러 캘린더 권한을 모두 허용하세요.', 'reauth', status);
  }
  if (status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason)) {
    return new SourceError('이 프로그램의 Google 프로젝트에서 Calendar API가 꺼져 있습니다. 개발자에게 알려 주세요.', 'api-disabled', status);
  }
  if (status === 403) return new SourceError('Google이 이 캘린더에 대한 요청을 거부했습니다 (HTTP 403). 쓰기 권한이 있는 캘린더인지 확인하세요.', 'http-403', 403);
  if (status === 404 || status === 410) return new SourceError(`Google 캘린더에서 찾을 수 없습니다 (HTTP ${status}). 설정에서 캘린더를 다시 찾아 보세요.`, `http-${status}`, status);
  if (status >= 500) return new SourceError(`Google 캘린더 서버 오류입니다 (HTTP ${status}). 잠시 뒤 다시 시도합니다.`, `http-${status}`, status);
  return new SourceError(`Google 캘린더가 요청을 거절했습니다 (HTTP ${status}${reason ? `, ${reason}` : ''}).`, `http-${status}`, status);
}

module.exports = { GoogleClient, API, calendarUrl, googleIdOf, eventUrl, apiError };
