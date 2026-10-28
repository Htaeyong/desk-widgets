// Releases ONE product: a Gitea release (main repo) and, from #100, the same tag on the public GitHub copy, each
// with its installer. Products version separately:
//   engine         version in package.json            tag engine-v<version>         asset dist/DeskWidgets-Setup-<version>.exe
//   <widget id>    version in widgets/<id>/widget.json  tag widget-<id>-v<version>   asset dist/DeskWidgets-<productName>-Setup-<version>.exe
// (The old tags v1.0.0-v1.0.3 belong to the pre-split app "Dooray Widget" and are never reused.)
//
// Usage: npm run release -- <engine|widget id> <notes.md> [options]   (build first: npm run dist / npm run widget -- widgets/<id>)
//   --dry-run     show tag, commits and what each side would do; change nothing
//   --replace     rebuilt same version: replace notes and installer on both sides
//   --no-github   Gitea only (--github is the default when GITHUB_OWNER/REPO/TOKEN are in .env)
//   --env <file>  read .env from another file (default: .env here)
// The Gitea tag is created at the current commit (HEAD), which must already be pushed. The GitHub tag points at
// the GitHub commit that publish-github.js made from that Gitea commit ("(source <sha>)"): publish first.
// Running it again only adds what is missing on either side (see release-api.js ensureRelease).
// From #104 a GitHub release also records the installer (URL, size, SHA-256 of the exact uploaded file) in
// site/releases.json; site-build.js puts it into products.json, which the engine's in-app update reads.
// From #109 an internal test version (X.Y.Z-test.N, any semver prerelease) is released on Gitea only, as a
// prerelease: no GitHub release and no site/releases.json record (--github with such a version is refused).
// From #111 the same holds for a widget before its official release (0.0.x, e.g. todonote 0.0.1).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { giteaSide, githubSide, findGithubCommit, ensureRelease } = require('./release-api');
const { parseVersion, isPrerelease, compareVersions, frozenOf, isGiteaOnly } = require('./version');

const root = path.join(__dirname, '..');
const RELEASES_FILE = path.join(root, 'site', 'releases.json');

/** A product version must be X.Y.Z or a prerelease X.Y.Z-<pre> (internal test build, e.g. 1.1.1-test.1). */
function checkedVersion(version, file) {
  if (!parseVersion(version)) throw new Error(`${file}: version "${version}" is not X.Y.Z or X.Y.Z-test.N`);
  return version;
}

/** What to release for a product name: version, tag, title, installer file and whether it is a test prerelease. */
function productInfo(product) {
  if (product === 'engine') {
    const version = checkedVersion(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, 'package.json');
    return { id: 'engine', version, prerelease: isPrerelease(version), giteaOnly: isGiteaOnly(version), frozen: null, tag: `engine-v${version}`, title: `Desk Widgets ${version}`, asset: path.join(root, 'dist', `DeskWidgets-Setup-${version}.exe`) };
  }
  const manifestFile = path.join(root, 'widgets', String(product), 'widget.json');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(product || '') || !fs.existsSync(manifestFile)) {
    throw new Error(`Unknown product "${product}": use "engine" or a widget id (${fs.readdirSync(path.join(root, 'widgets')).join(', ')})`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const productName = manifest.package?.productName;
  if (!productName) throw new Error(`${manifestFile}: package.productName is missing`);
  checkedVersion(manifest.version, `widgets/${product}/widget.json`);
  return {
    id: manifest.id,
    version: manifest.version,
    prerelease: isPrerelease(manifest.version),
    giteaOnly: isGiteaOnly(manifest.version), // #111: a test build or an unreleased 0.0.x widget
    frozen: frozenOf(manifest, `widgets/${product}/widget.json`), // #111: { since, successor } or null
    tag: `widget-${manifest.id}-v${manifest.version}`,
    title: `Desk Widgets-${productName} ${manifest.version}`,
    asset: path.join(root, 'dist', `DeskWidgets-${productName}-Setup-${manifest.version}.exe`),
  };
}

/**
 * GitHub's "Latest" badge (and /releases/latest) is one per repository while products version separately, so
 * version order across products means nothing. The engine is what every user installs first: its releases are
 * marked latest, widget releases never are.
 */
function isLatest(product) {
  return product === 'engine';
}

/** SHA-256 (hex) of a file, read as a stream. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Public download URL of a release asset on GitHub (what products.json and the engine use). */
function githubDownloadUrl({ owner, repo }, tag, name) {
  return `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/**
 * Writes one product's released installer into site/releases.json ({ <product>: { version, tag, file, url, size,
 * sha256 } }). An older version never replaces a newer record (re-running an old release). Returns whether written.
 * Test prereleases are never recorded: the site and the in-app update offer public versions only.
 */
function recordRelease(product, record, file = RELEASES_FILE) {
  if (!parseVersion(record.version) || isGiteaOnly(record.version)) throw new Error(`site/releases.json takes public versions (X.Y.Z, not 0.0.x) only, not "${record.version}"`);
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const current = all[product];
  if (current && compareVersions(current.version, record.version) > 0) return false;
  all[product] = record;
  const sorted = Object.fromEntries(Object.keys(all).sort((a, b) => (a === 'engine' ? -1 : b === 'engine' ? 1 : a.localeCompare(b))).map((k) => [k, all[k]]));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');
  return true;
}

/**
 * Whether the installer on the GitHub release is the local file: same size, and when GitHub reports a digest
 * ("sha256:<hex>") the same hash. outcome is ensureRelease's result: a file this run uploaded needs no digest.
 * Returns { ok, reason }.
 */
function githubAssetMatches(remote, { size, sha256 }, outcome) {
  if (!remote) return { ok: false, reason: 'the release has no such installer' };
  if (Number.isFinite(remote.size) && remote.size !== size) return { ok: false, reason: `size ${remote.size} differs from the local ${size}` };
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(remote.digest || ''))?.[1]?.toLowerCase();
  if (digest) return digest === sha256 ? { ok: true } : { ok: false, reason: 'GitHub digest differs from the local file' };
  if (['created', 'completed', 'replaced'].includes(outcome)) return { ok: true };
  return { ok: false, reason: 'GitHub reports no digest and this run did not upload the file' };
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** .env values (file first, then the process environment like dotenv) and the raw file values. */
function loadEnv(file = path.join(root, '.env')) {
  const fileValues = fs.existsSync(file) ? require('dotenv').parse(fs.readFileSync(file)) : {};
  return { env: { ...fileValues, ...process.env }, fileValues };
}

function hasGithub(env) {
  return Boolean(env.GITHUB_OWNER && env.GITHUB_REPO && env.GITHUB_TOKEN);
}

/** The export tool and its rules are internal (not in the public copy); null there. */
function publishTool() {
  try {
    return require('./publish-github');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/**
 * Release notes for GitHub: the same link rewrite as the public copy (internal links to public ones or plain
 * text) and the same forbidden-content check. In the public copy the notes already are public.
 */
function publicNotes(text, notesFile, { fileValues = {}, gh }) {
  const pub = publishTool();
  if (!pub) return text;
  const config = pub.loadConfig();
  const isExcluded = (p) => !!pub.excludedBy(p, config.exclude || []);
  const rel = path.relative(root, path.resolve(notesFile)).split(path.sep).join('/');
  const file = rel.startsWith('..') ? `release-notes/${path.basename(notesFile)}` : rel;
  const { text: out } = pub.rewriteLinks(file, text, { links: config.links, isExcluded, gh });
  const hits = pub.findForbidden(file, out, pub.buildMatchers(config.forbidden || [], fileValues));
  if (hits.length) throw new Error(`public notes ${file}: forbidden content (${hits.map((h) => `line ${h.line} ${h.rule}`).join(', ')})`);
  return out;
}

/**
 * Whether two Gitea commits give the same public tree, `older` being an ancestor of `newer` (a publish of
 * `newer` would change nothing on GitHub).
 */
function samePublicTree(older, newer, gh) {
  const pub = publishTool();
  if (!pub) return false;
  let a;
  try {
    a = git('rev-parse', '--verify', `${older}^{commit}`);
    git('merge-base', '--is-ancestor', a, newer);
  } catch {
    return false;
  }
  const config = pub.loadConfig();
  const tree = (sha) => new Map(pub.buildPublicTree(pub.archive(sha, root).files, { config, env: {}, gh }).files.map((f) => [f.path, f.data]));
  const x = tree(a);
  const y = tree(newer);
  if (x.size !== y.size) return false;
  for (const [p, data] of x) if (!y.has(p) || !y.get(p).equals(data)) return false;
  return true;
}

/** HEAD and whether a remote branch contains it (the Gitea tag must point at a published commit). */
function headCommit() {
  const sha = git('rev-parse', 'HEAD');
  return { sha, pushed: Boolean(git('branch', '-r', '--contains', sha)) };
}

/**
 * Releases one product on Gitea and (unless github is false) GitHub. opts: { notesFile, dryRun, replace,
 * github, envFile, log, fetchFn }. Returns { gitea, github } results of ensureRelease.
 */
async function releaseProduct(product, opts = {}) {
  const { notesFile, dryRun = false, replace = false, log = console.log, fetchFn = fetch } = opts;
  const info = productInfo(product);
  if (/^v\d/.test(info.tag)) throw new Error(`refusing old-style tag ${info.tag}`);
  if (!notesFile || !fs.existsSync(notesFile)) throw new Error(`Missing release notes ${notesFile || ''} for ${info.tag}`);
  const body = fs.readFileSync(notesFile, 'utf8');
  const built = fs.existsSync(info.asset);
  if (!built && !dryRun) throw new Error(`Missing ${path.relative(root, info.asset)} (build it first)`);
  const asset = { file: info.asset, name: path.basename(info.asset), size: built ? fs.statSync(info.asset).size : null };

  const { env, fileValues } = loadEnv(opts.envFile);
  if (info.giteaOnly && opts.github) throw new Error(`${info.tag} is an internal test version or a widget before its official release (0.0.x): GitHub takes public versions only (drop --github)`);
  const github = info.giteaOnly ? false : opts.github ?? hasGithub(env);
  if (github && !hasGithub(env)) throw new Error('Missing GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN in .env (or use --no-github)');
  const { GITEA_BASE_URL, GITEA_OWNER, GITEA_REPO, GITEA_TOKEN } = env;
  if (!GITEA_BASE_URL || !GITEA_OWNER || !GITEA_REPO || !GITEA_TOKEN) throw new Error('Missing GITEA_* values in .env');

  const head = headCommit();
  if (!head.pushed) {
    const msg = `HEAD ${head.sha.slice(0, 7)} is not pushed yet: push first so the tag points at a published commit`;
    if (!dryRun) throw new Error(msg);
    log(`warning: ${msg}`);
  }
  log(`${info.title}: tag ${info.tag}, ${asset.name} (${built ? `${(asset.size / 1e6).toFixed(1)} MB` : 'not built yet'})${dryRun ? ' [dry run]' : ''}`);
  if (info.giteaOnly) log(`${info.version} is an internal test version or not officially released (0.0.x): Gitea prerelease only (no GitHub release, no site/releases.json record)`);

  const gitea = giteaSide({ baseUrl: GITEA_BASE_URL, owner: GITEA_OWNER, repo: GITEA_REPO, token: GITEA_TOKEN, fetchFn });
  // An existing Gitea tag (earlier, partly failed run) decides which commit GitHub must tag; otherwise HEAD.
  const source = (await gitea.tagCommit(info.tag)) || head.sha;

  // Resolve the GitHub side before touching Gitea, so a missing publish stops the run with nothing half done.
  let gh = null;
  if (github) {
    const ghRepo = { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO };
    const side = githubSide({ ...ghRepo, token: env.GITHUB_TOKEN, fetchFn });
    const notes = publicNotes(body, notesFile, { fileValues, gh: ghRepo });
    let target = null;
    try {
      target = await findGithubCommit(side, source, { isEquivalent: (a, b) => samePublicTree(a, b, ghRepo) });
      log(`GitHub: ${info.tag} -> ${target.sha.slice(0, 7)} (${target.how})`);
    } catch (err) {
      if (!dryRun) throw err;
      log(`GitHub: ${err.message}`);
    }
    gh = { side, notes, target };
  }

  // Hash the exact file both sides get, before uploading it.
  const sha256 = built ? await sha256File(info.asset) : null;

  const result = {};
  log(`Gitea: ${info.tag} at ${source.slice(0, 7)}`);
  result.gitea = await ensureRelease(gitea, { tag: info.tag, title: info.title, body, asset, target: source, prerelease: info.giteaOnly, replace, dryRun, log });
  if (gh) {
    result.github = await ensureRelease(gh.side, {
      tag: info.tag,
      title: info.title,
      body: gh.notes,
      asset,
      target: gh.target?.sha || null,
      latest: isLatest(product),
      replace,
      dryRun,
      log,
    });
    if (!dryRun) {
      const ghRepo = { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO };
      const remote = ((await gh.side.getRelease(info.tag))?.assets || []).find((a) => a.name === asset.name);
      const match = githubAssetMatches(remote, { size: asset.size, sha256 }, result.github);
      if (match.ok) {
        const record = { version: info.version, tag: info.tag, file: asset.name, url: githubDownloadUrl(ghRepo, info.tag, asset.name), size: asset.size, sha256 };
        const written = (opts.recordRelease || recordRelease)(info.id, record);
        log(written ? `site/releases.json: ${info.id} ${info.version} (sha256 ${sha256.slice(0, 12)}...) - run npm run site:build and commit it` : `site/releases.json: kept the newer ${info.id} record`);
      } else {
        log(`warning: site/releases.json not updated for ${info.tag}: ${match.reason}`);
      }
    }
  }
  return result;
}

function parseArgs(argv) {
  const opts = { dryRun: false, replace: false, github: undefined, envFile: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--replace') opts.replace = true;
    else if (a === '--github') opts.github = true;
    else if (a === '--no-github') opts.github = false;
    else if (a === '--env') {
      opts.envFile = argv[++i];
      if (!opts.envFile) throw new Error('--env needs a file');
      opts.envFile = path.resolve(opts.envFile);
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const [product, notesFile] = rest;
  if (!product || !notesFile) throw new Error('Usage: npm run release -- <engine|widget id> <notes.md> [--dry-run] [--replace] [--no-github] [--env <file>]');
  await releaseProduct(product, { ...opts, notesFile });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { compareVersions, productInfo, isLatest, sha256File, recordRelease, githubAssetMatches, githubDownloadUrl, RELEASES_FILE, loadEnv, hasGithub, publicNotes, samePublicTree, releaseProduct, parseArgs };
