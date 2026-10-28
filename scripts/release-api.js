// Release hosts for scripts/release.js (#100): the Gitea release (main repo) and the GitHub release (public copy).
// Both sides go through ensureRelease(), which only adds what is missing, so re-running after a partial failure
// completes the release without duplicating it. Network calls use an injected fetch (tests run offline).
// Internal test versions (tags like engine-v1.1.1-test.1, #109) become Gitea prereleases; the GitHub side refuses them.
const fs = require('fs');
const path = require('path');
const { isPrereleaseTag } = require('./version');

const GITHUB_API = 'https://api.github.com';
const CONTENT_TYPES = { '.exe': 'application/vnd.microsoft.portable-executable', '.zip': 'application/zip' };

const short = (sha) => String(sha || '?').slice(0, 7);
const normalize = (text) => String(text || '').replace(/\r\n/g, '\n').trim();

async function failText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

async function check(res, what) {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await failText(res)}`);
  return res;
}

/** "Desk Widgets 2026-10-23 (source 949019e)" -> "949019e" (scripts/publish-github.js commit messages). */
function parseSource(message) {
  return /\(source ([0-9a-f]{7,40})\)/.exec(String(message || ''))?.[1] || null;
}

// ---- Gitea ----

function giteaSide({ baseUrl, owner, repo, token, fetchFn = fetch }) {
  const api = `${String(baseUrl).replace(/\/$/, '')}/api/v1/repos/${owner}/${repo}`;
  const auth = { Authorization: `token ${token}` };
  return {
    label: 'Gitea',
    async getRelease(tag) {
      const res = await fetchFn(`${api}/releases/tags/${encodeURIComponent(tag)}`, { headers: auth });
      if (res.status === 404) return null;
      return (await check(res, `Gitea release ${tag}`)).json();
    },
    /** Commit the tag points at, or null when the tag does not exist. */
    async tagCommit(tag) {
      const res = await fetchFn(`${api}/tags/${encodeURIComponent(tag)}`, { headers: auth });
      if (res.status === 404) return null;
      return (await (await check(res, `Gitea tag ${tag}`)).json()).commit?.sha || null;
    },
    async create({ tag, title, body, target, prerelease = false }) {
      const res = await fetchFn(`${api}/releases`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_name: tag, target_commitish: target, name: title, body, draft: false, prerelease: Boolean(prerelease) }),
      });
      return (await check(res, 'Gitea create release')).json();
    },
    async update(release, { title, body, prerelease = false }) {
      const res = await fetchFn(`${api}/releases/${release.id}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title, body, prerelease: Boolean(prerelease) }),
      });
      return (await check(res, 'Gitea update release')).json();
    },
    async deleteAsset(release, asset) {
      await check(await fetchFn(`${api}/releases/${release.id}/assets/${asset.id}`, { method: 'DELETE', headers: auth }), `Gitea delete ${asset.name}`);
    },
    async upload(release, file, name) {
      const form = new FormData();
      // openAsBlob reads the file from disk while sending instead of loading it into memory first.
      form.append('attachment', await fs.openAsBlob(file), name);
      const res = await fetchFn(`${api}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: auth, body: form });
      return (await check(res, `Gitea upload ${name}`)).json();
    },
  };
}

// ---- GitHub ----

function githubSide({ owner, repo, token, fetchFn = fetch, apiUrl = GITHUB_API }) {
  const api = `${apiUrl}/repos/${owner}/${repo}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'desk-widgets-release',
    Authorization: `Bearer ${token}`,
  };
  const json = (body) => ({ headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // The public copy only ever gets public versions: test tags stay on Gitea (#109).
  const publicOnly = (tag, prerelease) => {
    if (prerelease || isPrereleaseTag(tag)) throw new Error(`GitHub: ${tag} is an internal test version; GitHub releases take public versions (X.Y.Z) only`);
  };
  return {
    label: 'GitHub',
    async getRelease(tag) {
      const res = await fetchFn(`${api}/releases/tags/${encodeURIComponent(tag)}`, { headers });
      if (res.status === 404) return null;
      return (await check(res, `GitHub release ${tag}`)).json();
    },
    async tagCommit(tag) {
      const res = await fetchFn(`${api}/git/ref/tags/${encodeURIComponent(tag)}`, { headers });
      if (res.status === 404) return null;
      const ref = await (await check(res, `GitHub tag ${tag}`)).json();
      return ref.object?.type === 'commit' ? ref.object.sha : null;
    },
    /** Newest commits of a branch: [{ sha, message }]. */
    async commits(branch = 'main', count = 100) {
      const res = await fetchFn(`${api}/commits?sha=${encodeURIComponent(branch)}&per_page=${count}`, { headers });
      return (await (await check(res, `GitHub commits of ${branch}`)).json()).map((c) => ({ sha: c.sha, message: c.commit?.message || '' }));
    },
    async create({ tag, title, body, target, latest, prerelease }) {
      publicOnly(tag, prerelease);
      const res = await fetchFn(`${api}/releases`, {
        method: 'POST',
        ...json({ tag_name: tag, target_commitish: target, name: title, body, draft: false, prerelease: false, make_latest: latest ? 'true' : 'false' }),
      });
      return (await check(res, 'GitHub create release')).json();
    },
    async update(release, { title, body, latest, prerelease }) {
      publicOnly(release.tag_name || '', prerelease);
      const res = await fetchFn(`${api}/releases/${release.id}`, { method: 'PATCH', ...json({ name: title, body, make_latest: latest ? 'true' : 'false' }) });
      return (await check(res, 'GitHub update release')).json();
    },
    async deleteAsset(release, asset) {
      await check(await fetchFn(`${api}/releases/assets/${asset.id}`, { method: 'DELETE', headers }), `GitHub delete ${asset.name}`);
    },
    async upload(release, file, name) {
      const url = String(release.upload_url || '').replace(/\{.*\}$/, '');
      if (!url) throw new Error(`GitHub release ${release.id} has no upload_url`);
      const type = CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
      const res = await fetchFn(`${url}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': type },
        body: await fs.openAsBlob(file, { type }),
      });
      return (await check(res, `GitHub upload ${name}`)).json();
    },
  };
}

/**
 * The GitHub commit that holds the public copy of a Gitea commit. publish-github.js commits say
 * "(source <gitea sha>)": the newest such commit on the branch wins. When the branch has no commit for that
 * source, the newest commit is accepted only if isEquivalent(itsSource, sourceSha) says its public tree is the
 * same (a publish that changed nothing creates no commit). Otherwise it fails: publish first.
 */
async function findGithubCommit(side, sourceSha, { branch = 'main', isEquivalent } = {}) {
  const commits = await side.commits(branch);
  if (!commits.length) throw new Error(`GitHub ${branch} has no commits: publish first (node scripts/publish-github.js --push)`);
  const exact = commits.find((c) => {
    const src = parseSource(c.message);
    return src && String(sourceSha).startsWith(src);
  });
  if (exact) return { sha: exact.sha, how: `commit for source ${short(sourceSha)}` };
  const head = commits[0];
  const headSource = parseSource(head.message);
  if (headSource && isEquivalent && (await isEquivalent(headSource, sourceSha))) {
    return { sha: head.sha, how: `newest commit (source ${headSource}) has the same public files as ${short(sourceSha)}` };
  }
  throw new Error(
    `GitHub ${branch} has no public copy of ${short(sourceSha)} (newest is ${short(head.sha)}, source ${headSource || 'unknown'}): ` +
      'publish it first with node scripts/publish-github.js --push',
  );
}

/**
 * Makes sure one side has the release with its installer, adding only what is missing:
 *   no release           -> create it at target, upload the installer        ("created")
 *   release, no file      -> upload the installer (finishes a failed run)       ("completed")
 *   release + same size   -> nothing                                            ("complete")
 *   --replace             -> update title/notes, delete and upload the file    ("replaced")
 * A file of another size without --replace is an error. dryRun only reads and reports.
 * asset: { file, name, size } (size null when not built yet, dry run only).
 * prerelease: an internal test version (#109): a Gitea prerelease; GitHub refuses it, also in a dry run.
 */
async function ensureRelease(side, { tag, title, body, asset, target, latest = false, prerelease = false, replace = false, dryRun = false, log = console.log }) {
  const L = side.label;
  if (L === 'GitHub' && (prerelease || isPrereleaseTag(tag))) throw new Error(`GitHub: ${tag} is an internal test version; GitHub releases take public versions (X.Y.Z) only`);
  const upload = async (release) => {
    const up = await side.upload(release, asset.file, asset.name);
    if (up && Number.isFinite(up.size) && up.size !== asset.size) {
      await side.deleteAsset(release, up).catch(() => {});
      throw new Error(`${L}: uploaded ${asset.name} is ${up.size} bytes, expected ${asset.size} (deleted, run again)`);
    }
    log(`${L}: uploaded ${asset.name}`);
  };
  let release = await side.getRelease(tag);
  if (!release) {
    const existing = side.tagCommit ? await side.tagCommit(tag) : null;
    if (existing && target && existing !== target) {
      throw new Error(`${L}: tag ${tag} already points at ${short(existing)}, not ${short(target)}: delete the tag or fix the target`);
    }
    if (dryRun) {
      log(`${L}: would create release ${tag} at ${target ? short(target) : '? (no target yet: publish first)'}${side.label === 'GitHub' ? ` (latest: ${latest})` : ''}${prerelease ? ' as a prerelease' : ''} and upload ${asset.name}`);
      return 'create';
    }
    release = await side.create({ tag, title, body, target, latest, prerelease });
    log(`${L}: created ${prerelease ? 'prerelease' : 'release'} ${tag} at ${short(target)}`);
    await upload(release);
    log(`${L}: ${release.html_url || ''}`);
    return 'created';
  }
  const current = (release.assets || []).find((a) => a.name === asset.name);
  if (replace) {
    if (dryRun) {
      log(`${L}: would update the notes of ${tag} and ${current ? 'replace' : 'upload'} ${asset.name}`);
      return 'replace';
    }
    release = { ...release, ...(await side.update(release, { title, body, latest, prerelease })) };
    if (current) {
      await side.deleteAsset(release, current);
      log(`${L}: deleted old ${asset.name}`);
    }
    await upload(release);
    return 'replaced';
  }
  if (normalize(release.body) !== normalize(body)) log(`${L}: notes of ${tag} differ from the file (use --replace to update them)`);
  if (current && (asset.size == null || current.size === asset.size)) {
    log(`${L}: ${tag} already has ${asset.name}`);
    return 'complete';
  }
  if (current) throw new Error(`${L}: ${asset.name} on ${tag} is ${current.size} bytes, the local file ${asset.size}: use --replace to replace it`);
  if (dryRun) {
    log(`${L}: release ${tag} exists without ${asset.name}: would upload it`);
    return 'upload';
  }
  await upload(release);
  return 'completed';
}

/** Read-only state of a release on one side: "missing" | "partial" (no installer) | "complete". */
async function releaseState(side, tag, assetName) {
  const release = await side.getRelease(tag);
  if (!release) return 'missing';
  return (release.assets || []).some((a) => a.name === assetName) ? 'complete' : 'partial';
}

module.exports = { parseSource, giteaSide, githubSide, findGithubCommit, ensureRelease, releaseState, CONTENT_TYPES };
