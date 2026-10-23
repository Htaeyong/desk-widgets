// CalDAV client (read side): discovery, collection tags and time-ranged event reads, with HTTP Basic auth.
// Server behaviour ported from my_calendar_sync (CalDavClient.kt / CalDavOrigin.kt):
//   - redirects are followed by hand so PROPFIND/REPORT keep method, body, Depth and auth (iCloud sends
//     caldav.icloud.com to a per-user pNN-caldav.icloud.com), within a limit;
//   - the password only ever goes to the origin the account started at (iCloud: its two CalDAV host shapes);
//     https only, no downgrade, a foreign href or Location is refused instead of followed;
//   - a calendar-query answered with href/etag only (Naver) is completed with calendar-multiget, then GET;
//   - the queried collection itself in a REPORT answer (Dooray, without the trailing slash) is not an event.
const W = require('./webdav');
const { SourceError, readCapped, hostOf } = require('./http');

const TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 20 * 1024 * 1024;
const MULTIGET_BATCH = 50;

const ICLOUD = (host) => host === 'caldav.icloud.com' || /^p[0-9]+-caldav\.icloud\.com$/.test(host);

/** Whether the credentials of `from` may be sent to `to` (same https origin; iCloud CalDAV hosts are one service). */
function sameService(from, to) {
  let a;
  let b;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return false;
  }
  if (b.protocol !== 'https:' || a.protocol !== 'https:') return false;
  if (b.username || b.password) return false;
  if ((a.port || '443') !== (b.port || '443')) return false;
  const ha = a.hostname.toLowerCase();
  const hb = b.hostname.toLowerCase();
  return ha === hb || (ICLOUD(ha) && ICLOUD(hb));
}

/**
 * Checks a server address typed by the user: https only, a host, no user:pass@. A bare host gets https://.
 * Returns { url } or { error } (Korean).
 */
function checkServer(input) {
  let text = String(input || '').trim();
  if (!text) return { error: 'CalDAV 서버 주소를 넣으세요.' };
  if (/\s/.test(text)) return { error: '서버 주소에 공백이 있습니다.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    return { error: '서버 주소 형식이 올바르지 않습니다. 예: https://cal.example.com' };
  }
  if (u.protocol !== 'https:') return { error: '비밀번호를 보호하기 위해 https:// 주소만 쓸 수 있습니다.' };
  if (u.username || u.password) return { error: '주소에 아이디·비밀번호를 넣지 말고 아래 칸에 넣으세요.' };
  if (!u.hostname || !/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname.startsWith('.') || u.hostname.endsWith('.')) {
    return { error: '서버 주소 형식이 올바르지 않습니다. 예: https://cal.example.com' };
  }
  return { url: u.href.replace(/\/+$/, '') + '/' };
}

const resolve = (base, href) => new URL(href, base).href;
const trimSlash = (u) => u.replace(/\/+$/, '');

class CalDavClient {
  /**
   * @param {{ username: string, password: string, fetch?: Function, timeoutMs?: number, authHint?: string }} opts
   * authHint: the message for 401 (providers word it differently: plan / admin / app password).
   */
  constructor({ username, password, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, authHint }) {
    this.auth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.authHint = authHint || '로그인이 거절되었습니다. 아이디와 앱 전용 비밀번호를 확인하세요.';
  }

  /**
   * One WebDAV request, following redirects by hand within the account's origin.
   * Returns { url (final), status, text, headers }. 401 -> SourceError 'auth'; 412 -> 'conflict'; other non-2xx
   * -> 'http-<n>' unless allowed (e.g. 404 for a probe). extra: more headers (If-Match, If-None-Match).
   */
  async request(url, method, { depth, body, allow = [], contentType = 'application/xml; charset=utf-8', extra = {} } = {}) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = { Authorization: this.auth, 'User-Agent': 'DeskWidgets-Calendar' };
        if (depth !== undefined) headers.Depth = depth;
        if (body) headers['Content-Type'] = contentType;
        Object.assign(headers, extra);
        let res;
        try {
          res = await this.fetch(current, { method, headers, body, redirect: 'manual', signal: controller.signal });
        } catch (err) {
          if (controller.signal.aborted) throw new SourceError(`응답 시간이 초과되었습니다 (${hostOf(current)}).`, 'timeout');
          throw new SourceError(`연결하지 못했습니다 (${hostOf(current)}): ${err.cause?.code || err.message}`, 'network');
        }
        if (res.status === 401) throw new SourceError(this.authHint, 'auth', 401);
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          const next = resolve(current, location);
          if (!sameService(current, next)) throw new SourceError(`서버가 다른 주소(${hostOf(next)})로 보내려 해서 비밀번호를 보내지 않았습니다.`, 'untrusted');
          current = next;
          continue;
        }
        if (res.status === 412 && !allow.includes(412)) {
          throw new SourceError('다른 곳(다른 기기나 캘린더 앱)에서 이 일정이 바뀌었습니다. 새로 받은 내용을 확인한 뒤 다시 시도하세요.', 'conflict', 412);
        }
        if ((res.status < 200 || res.status >= 300) && !allow.includes(res.status)) {
          throw new SourceError(httpMessage(res.status, current), `http-${res.status}`, res.status);
        }
        let text;
        try {
          text = await readCapped(res, controller, MAX_BYTES);
        } catch (err) {
          if (err instanceof SourceError) throw err;
          if (controller.signal.aborted) throw new SourceError(`응답 시간이 초과되었습니다 (${hostOf(current)}).`, 'timeout');
          throw new SourceError(`받는 중 연결이 끊겼습니다: ${err.message}`, 'network');
        }
        return { url: current, status: res.status, text, headers: res.headers };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SourceError(`리디렉션이 너무 많습니다 (${hostOf(url)}).`, 'redirects');
  }

  /** An href from a response, resolved against the URL it came from; refused when it leaves the service. */
  href(base, href) {
    const url = resolve(base, href);
    if (!sameService(base, url)) throw new SourceError(`서버가 다른 주소(${hostOf(url)})를 가리켜서 비밀번호를 보내지 않았습니다.`, 'untrusted');
    return url;
  }

  /** current-user-principal -> calendar-home-set. Tries the server URL, then /.well-known/caldav. */
  async discoverHome(baseUrl) {
    const starts = [baseUrl, resolve(baseUrl, '/.well-known/caldav')].filter((u, i, a) => a.indexOf(u) === i);
    let principal = null;
    for (const start of starts) {
      const res = await this.request(start, 'PROPFIND', { depth: '0', body: W.PROPFIND_PRINCIPAL, allow: [404, 405] });
      const href = res.status < 300 ? W.nestedHref('current-user-principal', res.text) : null;
      if (href) {
        principal = this.href(res.url, href);
        break;
      }
    }
    if (!principal) throw new SourceError(`아이디와 비밀번호는 통과했지만 서버(${hostOf(baseUrl)})가 캘린더 위치를 알려 주지 않았습니다. 이 계정에서 CalDAV가 켜져 있는지 확인하세요.`, 'discovery');
    const res = await this.request(principal, 'PROPFIND', { depth: '0', body: W.PROPFIND_HOME });
    const home = W.nestedHref('calendar-home-set', res.text);
    if (!home) throw new SourceError(`서버(${hostOf(baseUrl)})가 캘린더 홈을 알려 주지 않았습니다. 이 계정에서 CalDAV가 켜져 있는지 확인하세요.`, 'discovery');
    return this.href(res.url, home);
  }

  /** Calendars (VEVENT collections) under the home: [{ url, name, color, canWrite, ctag }]. */
  async listCalendars(homeUrl) {
    const res = await this.request(homeUrl, 'PROPFIND', { depth: '1', body: W.PROPFIND_CALENDARS });
    return W.parseMultiStatus(res.text)
      .filter((r) => r.isCalendar && r.supportsVEvent && (r.status === null || r.status < 300))
      .map((r) => {
        const url = this.href(res.url, r.href);
        return { url, name: r.displayName || decodeURIComponent(trimSlash(url).split('/').pop() || '캘린더'), color: W.normalizeColor(r.color), canWrite: r.canWrite, ctag: r.ctag };
      });
  }

  async discover(baseUrl) {
    return this.listCalendars(await this.discoverHome(baseUrl));
  }

  /** The collection's getctag / sync-token, or null (then the caller reads in full). Never throws except for auth. */
  async collectionTag(calendarUrl) {
    try {
      const res = await this.request(calendarUrl, 'PROPFIND', { depth: '0', body: W.PROPFIND_TAG });
      return W.collectionTag(res.text);
    } catch (err) {
      if (err.code === 'auth') throw err;
      return null;
    }
  }

  /** iCalendar texts of the resources with VEVENTs overlapping [fromMs, toMs). */
  async readEvents(calendarUrl, fromMs, toMs) {
    return (await this.readResources(calendarUrl, fromMs, toMs)).map((r) => r.ics);
  }

  /** Resources with VEVENTs overlapping [fromMs, toMs): [{ href (absolute URL), etag, ics }]. */
  async readResources(calendarUrl, fromMs, toMs) {
    const res = await this.request(calendarUrl, 'REPORT', { depth: '1', body: W.calendarQuery(fromMs, toMs) });
    const isCollection = (r) => r.isCalendar || r.href.endsWith('/') || trimSlash(resolve(res.url, r.href)) === trimSlash(res.url);
    const resources = W.parseMultiStatus(res.text).filter((r) => !isCollection(r));
    const failed = resources.find((r) => r.status !== null && (r.status < 200 || r.status >= 300) && r.status !== 404);
    if (failed) throw new SourceError(`캘린더 서버가 일부 일정을 주지 않았습니다 (HTTP ${failed.status}).`, `http-${failed.status}`, failed.status);
    const texts = resources.filter((r) => r.calendarData).map((r) => ({ href: this.href(res.url, r.href), etag: r.etag, ics: r.calendarData }));
    const missing = resources.filter((r) => !r.calendarData && r.status !== 404).map((r) => r.href);
    if (!missing.length) return texts;
    // Naver lists only href/etag: fetch the bodies with calendar-multiget, then GET what is still missing.
    const got = new Map();
    for (let i = 0; i < missing.length; i += MULTIGET_BATCH) {
      const batch = missing.slice(i, i + MULTIGET_BATCH);
      const mg = await this.request(calendarUrl, 'REPORT', { depth: '1', body: W.calendarMultiget(batch) });
      for (const r of W.parseMultiStatus(mg.text)) if (r.calendarData && (r.status === null || r.status < 300)) got.set(trimSlash(resolve(mg.url, r.href)), { etag: r.etag, ics: r.calendarData });
    }
    for (const href of missing) {
      const url = this.href(res.url, href);
      if (got.has(trimSlash(url))) {
        texts.push({ href: url, ...got.get(trimSlash(url)) });
        continue;
      }
      const one = await this.request(url, 'GET', { allow: [404, 410] });
      if (one.status < 300 && one.text.includes('BEGIN:VEVENT')) texts.push({ href: url, etag: etagOf(one.headers), ics: one.text });
    }
    return texts;
  }

  // ---- writes (#48): always conditional ----

  /** The resource as the server holds it now: { etag, ics }, or null when it is gone. */
  async getResource(url) {
    const res = await this.request(this.href(url, url), 'GET', { allow: [404, 410] });
    if (res.status === 404 || res.status === 410) return null;
    return { etag: etagOf(res.headers), ics: res.text };
  }

  /**
   * Creates (ifNoneMatch '*') or replaces (ifMatch etag) a resource. Returns the new ETag when the server
   * gives one. 412 -> SourceError 'conflict'. An unconditional PUT is never sent.
   */
  async putResource(url, ics, { ifMatch, ifNoneMatch } = {}) {
    if (!ifMatch && ifNoneMatch !== '*') throw new SourceError('조건 없는 쓰기는 하지 않습니다.', 'unconditional');
    const extra = ifMatch ? { 'If-Match': quoteEtag(ifMatch) } : { 'If-None-Match': '*' };
    const res = await this.request(this.href(url, url), 'PUT', { body: ics, contentType: 'text/calendar; charset=utf-8', extra });
    return etagOf(res.headers);
  }

  /** Deletes a resource if it is still the version we saw. Returns false when it was already gone. */
  async deleteResource(url, { ifMatch } = {}) {
    if (!ifMatch) throw new SourceError('조건 없는 삭제는 하지 않습니다.', 'unconditional');
    const res = await this.request(this.href(url, url), 'DELETE', { allow: [404, 410], extra: { 'If-Match': quoteEtag(ifMatch) } });
    return !(res.status === 404 || res.status === 410);
  }
}

/** ETag header without W/ and quotes (the form the multistatus reader keeps), or null. */
function etagOf(headers) {
  const v = headers?.get?.('etag');
  return v ? v.replace(/^W\//, '').replace(/^"|"$/g, '') : null;
}
const quoteEtag = (etag) => `"${String(etag).replace(/^"|"$/g, '')}"`;

function httpMessage(status, url) {
  const host = hostOf(url);
  if (status === 403) return `접근이 거부되었습니다 (${host}, HTTP 403). 이 계정에 그 캘린더를 볼 권한이 있는지 확인하세요.`;
  if (status === 404 || status === 410) return `캘린더를 찾을 수 없습니다 (${host}, HTTP ${status}). 설정에서 캘린더를 다시 찾아 보세요.`;
  if (status === 429) return `요청이 너무 많다고 서버가 거절했습니다 (${host}). 잠시 뒤 다시 시도합니다.`;
  if (status >= 500) return `캘린더 서버 오류입니다 (${host}, HTTP ${status}). 잠시 뒤 다시 시도합니다.`;
  return `캘린더 서버가 요청을 거절했습니다 (${host}, HTTP ${status}).`;
}

module.exports = { CalDavClient, checkServer, sameService, TIMEOUT_MS, MAX_REDIRECTS, MAX_BYTES, MULTIGET_BATCH };
