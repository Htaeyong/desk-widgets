// WebDAV / CalDAV request bodies and a small multistatus reader. It matches elements by local name with any
// namespace prefix (servers differ: d:, D:, none) and is not a general XML parser. Ported from
// my_calendar_sync's WebDav.kt, including its server lessons (quote styles, CDATA, character references).

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:supported-calendar-component-set/>
    <d:current-user-privilege-set/>
    <ic:calendar-color/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`;

const PROPFIND_TAG = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>`;

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "20261018T000000Z" from an instant (CalDAV time-range values are UTC, iCalendar basic format). */
const icalUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** calendar-query for VEVENTs overlapping [fromMs, toMs). No <expand>: the widget expands RRULEs itself. */
function calendarQuery(fromMs, toMs) {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${icalUtc(fromMs)}" end="${icalUtc(toMs)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/** calendar-multiget for resources a calendar-query listed without their data (Naver). */
function calendarMultiget(hrefs) {
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
${hrefs.map((h) => `  <d:href>${escapeXml(h)}</d:href>`).join('\n')}
</c:calendar-multiget>`;
}

const P = '(?:[A-Za-z0-9_-]+:)?';
const elementRe = (local, flags = 'gi') => new RegExp(`<${P}${local}\\b[^>]*>([\\s\\S]*?)</${P}${local}\\s*>`, flags);
const first = (local, text) => {
  const m = elementRe(local, 'i').exec(text);
  return m ? m[1] : null;
};

/** CDATA, entities and numeric character references (Dooray escapes Korean names as &#xd669;). */
function unescapeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(x?)([0-9a-f]+);/gi, (m, hex, digits) => {
      const code = Number.parseInt(digits, hex ? 16 : 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&amp;/g, '&');
}

const statusCode = (text) => {
  const m = /HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(first('status', text) || '');
  return m ? Number(m[1]) : null;
};
const ok = (code) => code === null || (code >= 200 && code < 300);

/** Whether a current-user-privilege-set lets the user add events: bind, write or all (not write-content alone). */
const grantsWrite = (set) => new RegExp(`<${P}(all|write|bind)\\s*/?>`, 'i').test(set);

/**
 * Multistatus -> [{ href, status, etag, calendarData, isCalendar, displayName, supportsVEvent, canWrite, color, ctag }].
 * Properties from non-2xx propstats are ignored; status is the response's own status, or its first 2xx propstat.
 */
function parseMultiStatus(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(elementRe('response'))) {
    const block = m[1];
    const hrefRaw = first('href', block);
    if (hrefRaw === null) continue;
    const propstats = [...block.matchAll(elementRe('propstat'))].map((p) => p[1]);
    const codes = propstats.map(statusCode);
    const props = propstats.length ? propstats.filter((_, i) => ok(codes[i])).map((p) => first('prop', p) || '').join('\n') : block;
    const own = statusCode(block.replace(elementRe('propstat'), ''));
    const status = own ?? codes.find((c) => c !== null && ok(c)) ?? codes.find((c) => c !== null) ?? null;
    const resourceType = first('resourcetype', props) || '';
    const compSet = first('supported-calendar-component-set', props);
    const privileges = first('current-user-privilege-set', props);
    const text = (local) => {
      const v = first(local, props);
      const t = v === null ? '' : unescapeXml(v).trim();
      return t || null;
    };
    const etag = text('getetag');
    out.push({
      href: unescapeXml(hrefRaw).trim(),
      status,
      etag: etag ? etag.replace(/^W\//, '').replace(/^"|"$/g, '') : null,
      calendarData: text('calendar-data'),
      isCalendar: new RegExp(`<${P}calendar\\b[^>]*/?>`, 'i').test(resourceType),
      displayName: text('displayname'),
      // No component set = any component. iCloud quotes with ' (name='VEVENT'), others with ".
      supportsVEvent: compSet === null || new RegExp(`<${P}comp\\b[^>]*name=["']VEVENT["']`, 'i').test(compSet),
      canWrite: privileges === null ? null : grantsWrite(privileges),
      color: text('calendar-color'),
      ctag: text('getctag') || text('sync-token'),
    });
  }
  return out;
}

/** href inside <current-user-principal> / <calendar-home-set>. */
function nestedHref(local, xml) {
  const inner = first(local, String(xml || ''));
  if (inner === null) return null;
  const href = first('href', inner);
  return href === null ? null : unescapeXml(href).trim() || null;
}

/** Collection change tag: getctag, else sync-token, else null. */
function collectionTag(xml) {
  const r = parseMultiStatus(xml)[0];
  return r?.ctag || null;
}

/** "#RRGGBB" or "#RRGGBBAA" (Apple calendar-color) -> "#rrggbb", or null. */
function normalizeColor(c) {
  const m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(c || '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

module.exports = {
  PROPFIND_PRINCIPAL,
  PROPFIND_HOME,
  PROPFIND_CALENDARS,
  PROPFIND_TAG,
  icalUtc,
  calendarQuery,
  calendarMultiget,
  parseMultiStatus,
  nestedHref,
  collectionTag,
  normalizeColor,
  unescapeXml,
};
