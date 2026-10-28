// Product versions for the release scripts (#109): "X.Y.Z" for public releases and "X.Y.Z-test.N" (any semver
// prerelease) for internal test builds, which go to Gitea only as prereleases and never to GitHub or the site.
// Ordering follows semver: 1.1.1-test.1 < 1.1.1-test.2 < 1.1.1.

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** "1.1.1-test.1" -> { core: [1, 1, 1], pre: ['test', '1'] }; pre is [] for a public version; null when invalid. */
function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  if (!m) return null;
  return { core: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.') : [] };
}

/** Whether a version has a prerelease part (an internal test build such as 1.1.1-test.1). */
function isPrerelease(v) {
  return Boolean(parseVersion(v)?.pre.length);
}

/** Semver precedence like a sort comparator; NaN when either side is not a valid version. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  // A version without a prerelease part is newer than any prerelease of it.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i];
    const q = y.pre[i];
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const TAG_RE = /^(?:engine|widget-([a-z0-9][a-z0-9-]*?))-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** "engine-v1.1.1-test.1" -> { product: 'engine', version: '1.1.1-test.1' }, "widget-<id>-v<version>" likewise; null otherwise. */
function parseTag(tag) {
  const m = TAG_RE.exec(String(tag || ''));
  if (!m || !parseVersion(m[2])) return null;
  return { product: m[1] || 'engine', version: m[2] };
}

/** Whether a release tag names an internal test version (engine-v1.1.1-test.1, widget-clock-v1.1.1-test.1). */
function isPrereleaseTag(tag) {
  return isPrerelease(parseTag(tag)?.version);
}

// ---------- unreleased widgets (#111) ----------
// A widget at 0.0.x (a new widget before its official release, e.g. 할 일 노트 0.0.1) stays on Gitea like an internal
// test build: Gitea prereleases only, never GitHub (source or release), the download site, the CI product list or
// release:all. Its first official version (0.1.0 or later, decided with the user) lifts this.

/** Whether a version never leaves Gitea: an internal test build (X.Y.Z-test.N) or an unreleased widget (0.0.x). */
function isGiteaOnly(v) {
  const p = parseVersion(v);
  return Boolean(p && (p.pre.length || (p.core[0] === 0 && p.core[1] === 0)));
}

/** Whether a widget manifest is a widget before its official release (version 0.0.x, any prerelease part). */
function isUnreleasedWidget(manifest) {
  const p = parseVersion(manifest?.version);
  return Boolean(p && p.core[0] === 0 && p.core[1] === 0);
}

// ---------- frozen widgets (#110, #111) ----------
// A widget that gets no new versions has "frozen": { "since": "<last public version>", "successor": "<widget id>" }
// in widget.json. It stays at that version: release:all, the CI product list, dist:test and the same-version rule
// (docs/policies.md) skip it, and the download site keeps offering its last release with a pointer to the successor.

/** Whether a widget manifest (widget.json) is frozen. */
function isFrozen(manifest) {
  return Boolean(manifest && manifest.frozen && typeof manifest.frozen === 'object' && !Array.isArray(manifest.frozen));
}

/**
 * The checked "frozen" block of a widget manifest: { since, successor }, or null when the widget is not frozen.
 * Throws when it is malformed: since must be a public X.Y.Z equal to the manifest version, successor another widget id.
 */
function frozenOf(manifest, file = 'widget.json') {
  if (manifest?.frozen === undefined) return null;
  if (!isFrozen(manifest)) throw new Error(`${file}: "frozen" must be an object { since, successor }`);
  const { since, successor } = manifest.frozen;
  if (!parseVersion(since) || isPrerelease(since)) throw new Error(`${file}: frozen.since "${since}" is not a public X.Y.Z version`);
  if (since !== manifest.version) throw new Error(`${file}: a frozen widget stays at frozen.since (${since}), but version is ${manifest.version}`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(successor || '') || successor === manifest.id) throw new Error(`${file}: frozen.successor "${successor}" is not another widget id`);
  return { since, successor };
}

module.exports = { VERSION_RE, parseVersion, isPrerelease, compareVersions, parseTag, isPrereleaseTag, isFrozen, frozenOf, isGiteaOnly, isUnreleasedWidget };
