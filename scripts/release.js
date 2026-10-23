// Creates a Gitea release for ONE product and uploads its installer. Products version separately:
//   engine         version in package.json            tag engine-v<version>         asset dist/DeskWidgets-Setup-<version>.exe
//   <widget id>    version in widgets/<id>/widget.json  tag widget-<id>-v<version>   asset dist/DeskWidgets-<productName>-Setup-<version>.exe
// (The old tags v1.0.0-v1.0.3 belong to the pre-split app "Dooray Widget" and are never reused.)
//
// Usage: npm run release -- <engine|widget id> <notes.md>             (build first: npm run dist / npm run widget -- widgets/<id>)
//        npm run release -- <engine|widget id> <notes.md> --dry-run   (show tag, commit and files; change nothing)
//        npm run release -- <engine|widget id> <notes.md> --replace   (rebuilt same version: replace notes and exe)
// The tag is created by Gitea at the current commit (HEAD), which must already be pushed.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const root = path.join(__dirname, '..');

/** What to release for a product name: version, tag, title and installer file. */
function productInfo(product) {
  if (product === 'engine') {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return { version, tag: `engine-v${version}`, title: `Desk Widgets ${version}`, asset: path.join(root, 'dist', `DeskWidgets-Setup-${version}.exe`) };
  }
  const manifestFile = path.join(root, 'widgets', String(product), 'widget.json');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(product || '') || !fs.existsSync(manifestFile)) {
    throw new Error(`Unknown product "${product}": use "engine" or a widget id (${fs.readdirSync(path.join(root, 'widgets')).join(', ')})`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const productName = manifest.package?.productName;
  if (!productName) throw new Error(`${manifestFile}: package.productName is missing`);
  return {
    version: manifest.version,
    tag: `widget-${manifest.id}-v${manifest.version}`,
    title: `Desk Widgets-${productName} ${manifest.version}`,
    asset: path.join(root, 'dist', `DeskWidgets-${productName}-Setup-${manifest.version}.exe`),
  };
}

function headCommit() {
  const sha = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
  const pushed = execSync(`git branch -r --contains ${sha}`, { cwd: root }).toString().trim();
  if (!pushed) throw new Error(`HEAD ${sha.slice(0, 7)} is not pushed yet: push first so the tag points at a published commit`);
  return sha;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  const replace = process.argv.includes('--replace');
  const [product, notesFile] = args;
  if (!product || !notesFile) throw new Error('Usage: npm run release -- <engine|widget id> <notes.md> [--dry-run] [--replace]');

  const info = productInfo(product);
  if (/^v\d/.test(info.tag)) throw new Error(`refusing old-style tag ${info.tag}`);
  const body = fs.readFileSync(notesFile, 'utf8');
  if (!fs.existsSync(info.asset)) throw new Error(`Missing ${path.relative(root, info.asset)} (build it first)`);
  const sha = headCommit();
  console.log(`${info.title}: tag ${info.tag} at ${sha.slice(0, 7)}, ${path.basename(info.asset)} (${(fs.statSync(info.asset).size / 1e6).toFixed(1)} MB)`);
  if (dryRun) return;

  const { GITEA_BASE_URL, GITEA_OWNER, GITEA_REPO, GITEA_TOKEN } = process.env;
  if (!GITEA_BASE_URL || !GITEA_OWNER || !GITEA_REPO || !GITEA_TOKEN) throw new Error('Missing GITEA_* values in .env');
  const api = `${GITEA_BASE_URL.replace(/\/$/, '')}/api/v1/repos/${GITEA_OWNER}/${GITEA_REPO}`;
  const auth = { Authorization: `token ${GITEA_TOKEN}` };

  let release;
  const existing = await fetch(`${api}/releases/tags/${info.tag}`, { headers: auth });
  if (existing.ok) {
    release = await existing.json();
    console.log(`using existing release #${release.id}`);
    if (!replace) throw new Error(`release ${info.tag} already exists: use --replace to update its notes and file`);
    const res = await fetch(`${api}/releases/${release.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`update notes: ${res.status} ${await res.text()}`);
    for (const a of release.assets || []) {
      if (a.name !== path.basename(info.asset)) continue;
      const del = await fetch(`${api}/releases/${release.id}/assets/${a.id}`, { method: 'DELETE', headers: auth });
      if (!del.ok) throw new Error(`delete ${a.name}: ${del.status}`);
      console.log(`deleted old ${a.name}`);
    }
  } else {
    const res = await fetch(`${api}/releases`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: info.tag, target_commitish: sha, name: info.title, body, draft: false, prerelease: false }),
    });
    if (!res.ok) throw new Error(`create release: ${res.status} ${await res.text()}`);
    release = await res.json();
    console.log(`created release #${release.id}`);
  }

  const name = path.basename(info.asset);
  const form = new FormData();
  form.append('attachment', new Blob([fs.readFileSync(info.asset)]), name);
  const up = await fetch(`${api}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: auth, body: form });
  if (!up.ok) throw new Error(`upload ${name}: ${up.status} ${(await up.text()).slice(0, 200)}`);
  console.log(`uploaded ${name}\n\n${release.html_url}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { productInfo };
