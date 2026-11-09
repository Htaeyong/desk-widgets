// Minimal Dooray REST API client.
// Auth header format: "Authorization: dooray-api {TOKEN}"

// Dooray rate-limits bursts (HTTP 429). All clients share one pacer:
// at most MAX_IN_FLIGHT requests at a time and MIN_GAP_MS between request starts.
const MAX_IN_FLIGHT = 2;
const MIN_GAP_MS = 120;
const MAX_RETRIES = 3;
const PROJECT_CHUNK = 50;

const pacer = { inFlight: 0, lastStart: 0, queue: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function acquire() {
  return new Promise((resolve) => {
    pacer.queue.push(resolve);
    pump();
  });
}

function pump() {
  if (!pacer.queue.length || pacer.inFlight >= MAX_IN_FLIGHT) return;
  const wait = pacer.lastStart + MIN_GAP_MS - Date.now();
  if (wait > 0) {
    setTimeout(pump, wait);
    return;
  }
  pacer.inFlight++;
  pacer.lastStart = Date.now();
  pacer.queue.shift()();
  pump();
}

function release() {
  pacer.inFlight--;
  pump();
}

function retryDelayMs(res, attempt) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30000);
  return 1000 * 2 ** attempt;
}

// Hosts a file download may be redirected to with the token: the API host itself or a Dooray host.
function trustedRedirect(location, apiBase) {
  let url;
  try {
    url = new URL(location, apiBase);
  } catch {
    return null;
  }
  const api = new URL(apiBase);
  if (url.protocol !== 'https:' && url.origin !== api.origin) return null;
  const host = url.hostname.toLowerCase();
  return host === api.hostname.toLowerCase() || host === 'dooray.com' || host.endsWith('.dooray.com') ? url : null;
}

/**
 * timeoutMs / maxRetries: polling keeps the defaults; the AI tools (#131) pass a short timeout and no
 * 429 retries so a tool answers within the engine's 10 s.
 */
function createClient({ apiBase = 'https://api.dooray.com', token, timeoutMs = 15000, maxRetries = MAX_RETRIES }) {
  if (!token) throw new Error('Dooray API token is not set');

  async function send(url, { redirect = 'follow' } = {}) {
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let res;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `dooray-api ${token}`,
            'Content-Type': 'application/json',
          },
          redirect,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } finally {
        release();
      }
      if (res.status !== 429 || attempt >= maxRetries) return res;
      await sleep(retryDelayMs(res, attempt));
    }
  }

  /** Reads at most maxBytes of a response body; more means the file is too big (null). */
  async function readCapped(res, maxBytes) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel?.();
      return null;
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body || []) {
      total += chunk.length;
      if (total > maxBytes) return null; // leaving the loop early cancels the stream
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * GET of a file (#131). Follows one redirect, and only to the API host or a *.dooray.com https host, since the
   * token goes along. Returns the open response (status 2xx); the caller reads or cancels its body.
   */
  async function openFile(pathname, query = {}) {
    let url = new URL(pathname, apiBase);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    let res = await send(url, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const next = trustedRedirect(res.headers.get('location') || '', apiBase);
      await res.body?.cancel?.();
      if (!next) throw Object.assign(new Error('Dooray file redirect to an unexpected host'), { status: res.status });
      url = next;
      res = await send(url, { redirect: 'manual' });
    }
    if (!res.ok) {
      await res.body?.cancel?.();
      throw Object.assign(new Error(`Dooray API ${res.status} ${res.statusText} for ${url.pathname}`), { status: res.status });
    }
    return res;
  }

  /** A file's bytes (only when the user allowed file contents): { bytes, contentType } or { tooBig: true }. */
  async function requestBytes(pathname, query = {}, { maxBytes }) {
    const res = await openFile(pathname, query);
    const contentType = res.headers.get('content-type') || '';
    const bytes = await readCapped(res, maxBytes);
    return bytes ? { bytes, contentType } : { tooBig: true, contentType };
  }

  async function request(pathname, query = {}) {
    const url = new URL(pathname, apiBase);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await send(url);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err = new Error(`Dooray API ${res.status} ${res.statusText} for ${url.pathname}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // Fetches every page of a list endpoint, stopping at maxItems.
  async function requestAll(pathname, query = {}, { pageSize = 100, maxItems = 1000 } = {}) {
    const items = [];
    let totalCount = 0;
    for (let page = 0; items.length < maxItems; page++) {
      const body = await request(pathname, { ...query, page, size: pageSize });
      const result = body?.result || [];
      totalCount = body?.totalCount ?? result.length;
      items.push(...result);
      if (result.length < pageSize || items.length >= totalCount) break;
    }
    return { items: items.slice(0, maxItems), totalCount, truncated: totalCount > maxItems };
  }

  // Cross-project task queries (GET /project/v1/posts?projectIds=a,b,...).
  // Ids go in chunks so URLs stay short even for users in many projects.
  async function postsAcross(projectIds, query, opts) {
    const merged = { items: [], totalCount: 0, truncated: false };
    for (let i = 0; i < projectIds.length; i += PROJECT_CHUNK) {
      const ids = projectIds.slice(i, i + PROJECT_CHUNK).join(',');
      const part = await requestAll('/project/v1/posts', { ...query, projectIds: ids }, opts);
      merged.items.push(...part.items);
      merged.totalCount += part.totalCount;
      merged.truncated ||= part.truncated;
    }
    return merged;
  }

  return {
    request,
    requestAll,
    requestBytes,
    openFile,
    /** All open tasks of the given projects, newest first. */
    listOpenPostsAcross: (projectIds, maxItems) =>
      postsAcross(projectIds, { postWorkflowClasses: 'backlog,registered,working', order: '-updatedAt' }, { maxItems }),
    /** Closed tasks updated at or after sinceIso. */
    listClosedSince: (projectIds, sinceIso, maxItems) =>
      postsAcross(projectIds, { postWorkflowClasses: 'closed', updatedAt: `${sinceIso}~` }, { maxItems }),
    /** Tasks (any state) created in [fromIso, toIso]; used by condition alerts. */
    listCreatedBetween: (projectIds, fromIso, toIso) =>
      postsAcross(projectIds, { createdAt: `${fromIso}~${toIso}` }, { maxItems: 2000 }),
    /** Tasks (any state) updated at or after sinceIso; only the first page is fetched. */
    listUpdatedSince: (projectIds, sinceIso) =>
      postsAcross(projectIds, { updatedAt: `${sinceIso}~`, order: '-updatedAt' }, { maxItems: 100 }),
    getMyMember: () => request('/common/v1/members/me'),
    // Projects the current user belongs to.
    listMyProjects: (page = 0, size = 100) =>
      request('/project/v1/projects', { member: 'me', page, size }),
    getPost: (postId) => request(`/project/v1/posts/${postId}`),
    /** Tag definitions (name, color, group) of a project. Tasks only carry tag ids. */
    listProjectTags: (projectId) => requestAll(`/project/v1/projects/${projectId}/tags`, {}, { maxItems: 1000 }),
    /** Comments and other logs of a task, newest first. */
    getPostLogs: (projectId, postId, size = 20) =>
      request(`/project/v1/projects/${projectId}/posts/${postId}/logs`, { size, order: '-createdAt' }),
    // Without "type" the API lists public-type projects only; the personal project ("@id") is type=private.
    listAllMyProjects: async () => {
      const shared = await requestAll('/project/v1/projects', { member: 'me' });
      const personal = await requestAll('/project/v1/projects', { member: 'me', type: 'private' });
      const ids = new Set(shared.items.map((p) => String(p.id)));
      const items = [...shared.items, ...personal.items.filter((p) => !ids.has(String(p.id)))];
      return { items, totalCount: items.length, truncated: shared.truncated || personal.truncated };
    },
  };
}

module.exports = { createClient, trustedRedirect };
