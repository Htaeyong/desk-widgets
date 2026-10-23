// Shared HTTP helpers for calendar sources: errors with Korean messages and a size-capped body read.

/** A failure with a Korean message for the settings window. code: 'auth', 'timeout', 'network', 'http-<n>', ... */
class SourceError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    if (status) this.status = status;
  }
}

const tooLarge = (max) => new SourceError(`응답이 너무 큽니다 (${Math.round(max / 1048576)}MB 초과).`, 'too-large');

/** Reads the body as UTF-8 text, refusing more than maxBytes (aborting the request). */
async function readCapped(res, controller, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw tooLarge(maxBytes);
  if (!res.body?.getReader) {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw tooLarge(maxBytes);
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller?.abort();
      throw tooLarge(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Host of a URL for messages (never the path: CalDAV paths identify the account). */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(알 수 없는 주소)';
  }
}

module.exports = { SourceError, readCapped, hostOf };
