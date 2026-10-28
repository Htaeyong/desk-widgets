// Releases every product whose current version is not fully released yet (#100), engine first, then the widgets
// in widget.json "order", then rebuilds and deploys the download site so it lists the new versions.
//
// Usage: npm run release:all -- <notes dir> [options]
//   <notes dir>   folder with <tag>.md for each product to release (release-notes/)
//   --dry-run     show what would be published, released and deployed; change nothing
//   --build       build missing installers first (npm run dist / npm run widget -- widgets/<id>)
//   --no-github   Gitea only (GitHub is on when GITHUB_* are in .env)
//   --no-site     skip site:build + site:deploy
//   --env <file>  read .env from another file
// A product counts as released when its tag has a release with the installer on Gitea and (with GitHub) GitHub.
// Before releasing, GitHub main must hold the public copy of HEAD: if not, publish-github.js --push runs first.
// Frozen widgets (#111, widget.json "frozen") are never in the product list: they stay at their last release.
// Widgets before their official release (0.0.x, #111) are not either: release them one by one with npm run release
// (Gitea prerelease only).
// Internal test run (#109): when any product version is a prerelease (X.Y.Z-test.N), everything goes to Gitea
// only as prereleases: no publish-github, no GitHub release, no site build/deploy (--github is refused).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { productInfo, releaseProduct, loadEnv, hasGithub } = require('./release');
const { giteaSide, githubSide, findGithubCommit, releaseState } = require('./release-api');
const { isFrozen, isUnreleasedWidget } = require('./version');

const root = path.join(__dirname, '..');

/**
 * Which sides this run uses. infos: productInfo() of every product; opts: parseArgs(); githubConfigured: GITHUB_*
 * in .env. Returns { github, site, testTags } (testTags: the prerelease tags that make this an internal test run).
 */
function planRun(infos, opts, githubConfigured) {
  const testTags = infos.filter((i) => i.prerelease).map((i) => i.tag);
  if (!testTags.length) return { github: opts.github ?? githubConfigured, site: opts.site, testTags };
  if (opts.github) throw new Error(`Internal test versions (${testTags.join(', ')}): GitHub takes public versions (X.Y.Z) only (drop --github)`);
  return { github: false, site: false, testTags };
}

/** "engine" then widget ids by widget.json "order" (as on the download page); frozen and 0.0.x widgets (#111) are left out. */
function productOrder(baseDir = root) {
  const dir = path.join(baseDir, 'widgets');
  const widgets = fs.readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, 'widget.json')))
    .map((id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'widget.json'), 'utf8')))
    .filter((m) => !isFrozen(m) && !isUnreleasedWidget(m))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.id.localeCompare(b.id))
    .map((m) => m.id);
  return ['engine', ...widgets];
}

function parseArgs(argv) {
  const opts = { dryRun: false, build: false, github: undefined, site: true, envFile: undefined, notesDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--build') opts.build = true;
    else if (a === '--no-github') opts.github = false;
    else if (a === '--github') opts.github = true;
    else if (a === '--no-site') opts.site = false;
    else if (a === '--env') {
      if (!argv[i + 1]) throw new Error('--env needs a file');
      opts.envFile = path.resolve(argv[++i]);
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else if (!opts.notesDir) opts.notesDir = path.resolve(a);
    else throw new Error(`Unexpected argument ${a}`);
  }
  if (!opts.notesDir) throw new Error('Usage: npm run release:all -- <notes dir> [--dry-run] [--build] [--no-github] [--no-site] [--env <file>]');
  return opts;
}

/**
 * Products to release: [{ product, tag, notes, built, gitea, github }] for every product not complete on a side.
 * states(tag, assetName) -> { gitea, github } where each is "missing" | "partial" | "complete" (github null = off).
 */
async function pendingProducts(products, notesDir, states) {
  const out = [];
  for (const product of products) {
    const info = productInfo(product);
    const name = path.basename(info.asset);
    const s = await states(info.tag, name);
    if (s.gitea === 'complete' && (s.github === null || s.github === 'complete')) continue;
    out.push({ product, tag: info.tag, asset: info.asset, notes: path.join(notesDir, `${info.tag}.md`), built: fs.existsSync(info.asset), ...s });
  }
  return out;
}

function run(cmd, args, { dryRun, log }) {
  log(`${dryRun ? 'would run' : 'run'}: ${[cmd, ...args].join(' ')}`);
  if (dryRun) return;
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

async function main(argv = process.argv.slice(2), log = console.log) {
  const opts = parseArgs(argv);
  const { env } = loadEnv(opts.envFile);
  const products = productOrder();
  const plan = planRun(products.map((p) => productInfo(p)), opts, hasGithub(env));
  const { github } = plan;
  if (plan.testTags.length) {
    log(`Internal test run (${plan.testTags.join(', ')}): Gitea prereleases only; GitHub, publish-github and the site are skipped.`);
  }
  if (github && !hasGithub(env)) throw new Error('Missing GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN in .env (or use --no-github)');
  if (!env.GITEA_BASE_URL || !env.GITEA_OWNER || !env.GITEA_REPO || !env.GITEA_TOKEN) throw new Error('Missing GITEA_* values in .env');
  const envArgs = opts.envFile ? ['--env', opts.envFile] : [];
  const gitea = giteaSide({ baseUrl: env.GITEA_BASE_URL, owner: env.GITEA_OWNER, repo: env.GITEA_REPO, token: env.GITEA_TOKEN });
  const gh = github ? githubSide({ owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN }) : null;

  const pending = await pendingProducts(products, opts.notesDir, async (tag, name) => ({
    gitea: await releaseState(gitea, tag, name),
    github: gh ? await releaseState(gh, tag, name) : null,
  }));
  if (!pending.length) log('Every product version is already released.');
  for (const p of pending) log(`- ${p.tag}: Gitea ${p.gitea}${gh ? `, GitHub ${p.github}` : ''}${p.built ? '' : ', installer not built'}`);
  const missingNotes = pending.filter((p) => !fs.existsSync(p.notes));
  if (missingNotes.length) throw new Error(`Missing release notes: ${missingNotes.map((p) => path.relative(root, p.notes)).join(', ')}`);

  for (const p of pending.filter((x) => !x.built)) {
    if (!opts.build && !opts.dryRun) throw new Error(`${path.relative(root, p.asset)} is not built (build it, or use --build)`);
    if (opts.build) run('npm', p.product === 'engine' ? ['run', 'dist'] : ['run', 'widget', '--', `widgets/${p.product}`], { dryRun: opts.dryRun, log });
  }

  if (pending.length && gh) {
    // The new tags are made at HEAD; GitHub needs its public copy (unless every pending tag already exists on Gitea).
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    try {
      await findGithubCommit(gh, head, { isEquivalent: (a, b) => require('./release').samePublicTree(a, b, { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO }) });
      log(`GitHub main has the public copy of ${head.slice(0, 7)}.`);
    } catch (err) {
      log(`GitHub: ${err.message}`);
      run('node', ['scripts/publish-github.js', '--push', ...envArgs], { dryRun: opts.dryRun, log });
    }
  }

  for (const p of pending) {
    log(`\n== ${p.tag}`);
    await releaseProduct(p.product, { notesFile: p.notes, dryRun: opts.dryRun, github, envFile: opts.envFile, log });
  }

  if (plan.site) {
    log('\n== download site');
    // site-deploy.js runs site:build first, so products.json matches the released versions.
    run('node', ['scripts/site-deploy.js', ...envArgs], { dryRun: opts.dryRun, log });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { productOrder, pendingProducts, parseArgs, planRun };
