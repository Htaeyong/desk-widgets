// Time zones for iCalendar wall-clock times: IANA names through Intl, common Windows zone
// names (Outlook / Exchange exports), and a fixed-offset fallback taken from a VTIMEZONE.

// Windows zone id -> IANA (the CLDR "001" territory mapping for the zones people meet most).
const WINDOWS_ZONES = {
  'Korea Standard Time': 'Asia/Seoul',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Singapore Standard Time': 'Asia/Singapore',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'India Standard Time': 'Asia/Kolkata',
  'Arabian Standard Time': 'Asia/Dubai',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'Atlantic Standard Time': 'America/Halifax',
  'SA Eastern Standard Time': 'America/Cayenne',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

const validCache = new Map();
/** Whether Intl knows this IANA zone name. */
function isIana(name) {
  if (!name) return false;
  if (!validCache.has(name)) {
    let ok = false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: name });
      ok = true;
    } catch {
      ok = false;
    }
    validCache.set(name, ok);
  }
  return validCache.get(name);
}

/** "+0900" / "-0530" / "+09:00" -> minutes east of UTC, or null. */
function parseOffset(text) {
  const m = /^([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?$/.exec(String(text || '').trim());
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

/**
 * Resolves a TZID to a zone: { iana } for Intl, { offset } (minutes) for a fixed offset, or null (floating,
 * i.e. the PC's local time). vtimezones maps a TZID to its VTIMEZONE info { location, standardOffset }.
 */
function resolveZone(tzid, vtimezones = {}) {
  if (!tzid) return null;
  const id = String(tzid).replace(/^"|"$/g, '').trim();
  if (!id) return null;
  if (/^(utc|gmt|z)$/i.test(id)) return { iana: 'UTC' };
  if (isIana(id)) return { iana: id };
  if (WINDOWS_ZONES[id]) return { iana: WINDOWS_ZONES[id] };
  // Prefixed names such as "/mozilla.org/20050126_1/Asia/Seoul" or "/citadel.org/.../Europe/Paris".
  const parts = id.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const tail = parts.slice(i).join('/');
    if (tail.includes('/') && isIana(tail)) return { iana: tail };
  }
  const vt = vtimezones[id];
  if (vt?.location && isIana(vt.location)) return { iana: vt.location };
  // "(UTC+09:00) Seoul" style names.
  const inName = /(?:UTC|GMT)\s*([+-]\d{1,2}):?(\d{2})/i.exec(id);
  if (vt && Number.isFinite(vt.standardOffset)) return { offset: vt.standardOffset };
  if (inName) {
    const h = Number(inName[1]);
    const minutes = Math.abs(h) * 60 + Number(inName[2]);
    return { offset: h < 0 || inName[1].startsWith('-') ? -minutes : minutes };
  }
  return null;
}

const fmtCache = new Map();
function formatter(iana) {
  if (!fmtCache.has(iana)) {
    fmtCache.set(
      iana,
      new Intl.DateTimeFormat('en-US', {
        timeZone: iana,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
  }
  return fmtCache.get(iana);
}

/** Offset (ms) of an IANA zone at a UTC instant. */
function ianaOffset(iana, utcMs) {
  if (iana === 'UTC') return 0;
  const parts = {};
  for (const p of formatter(iana).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Wall-clock time in a zone -> UTC ms. zone null = the PC's local time (floating times).
 * A wall time skipped by a DST jump lands one hour later; a repeated one takes the first.
 */
function wallToUtc(w, zone) {
  const { y, m, d, h = 0, mi = 0, s = 0 } = w;
  if (!zone) return new Date(y, m - 1, d, h, mi, s).getTime();
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  if (Number.isFinite(zone.offset)) return guess - zone.offset * 60000;
  let utc = guess - ianaOffset(zone.iana, guess);
  const second = guess - ianaOffset(zone.iana, utc);
  if (second !== utc) {
    // Near a transition: prefer the earlier mapping that reproduces the wall time.
    const candidates = [utc, second].sort((a, b) => a - b);
    utc = candidates.find((c) => c + ianaOffset(zone.iana, c) === guess) ?? Math.max(...candidates);
  }
  return utc;
}

module.exports = { WINDOWS_ZONES, isIana, parseOffset, resolveZone, ianaOffset, wallToUtc };
