// Which product a CI run builds (#101), from the pushed tag or the manual "product" input.
// Usage: node scripts/ci/product.js <tag | engine | widget id>
// Prints the facts and, on GitHub Actions, writes them to $GITHUB_OUTPUT:
//   product, kind (engine|widget), version, tag, title, asset (relative path), notes (release notes file or ""),
//   prerelease (true for an internal test version such as 1.1.1-test.1: the workflow never attaches it to GitHub, #109)
// A tag must match the version in the source (package.json / widget.json): otherwise the run fails.
const fs = require('fs');
const path = require('path');
const { productInfo } = require('../release');

const root = path.join(__dirname, '..', '..');

/** "engine-v1.2.3" -> "engine", "widget-clock-v1.0.0" -> "clock"; anything else is taken as a product name. */
function productFromRef(ref) {
  if (/^engine-v\d/.test(ref)) return { product: 'engine', tag: ref };
  const m = /^widget-([a-z0-9][a-z0-9-]*?)-v\d/.exec(ref);
  if (m) return { product: m[1], tag: ref };
  return { product: ref, tag: null };
}

function resolve(ref) {
  const { product, tag } = productFromRef(String(ref || '').trim());
  const info = productInfo(product);
  if (tag && tag !== info.tag) {
    throw new Error(`tag ${tag} does not match the source version (expected ${info.tag}): bump the version or fix the tag`);
  }
  const notes = path.join('release-notes', `${info.tag}.md`);
  return {
    product,
    kind: product === 'engine' ? 'engine' : 'widget',
    version: info.version,
    tag: info.tag,
    title: info.title,
    asset: path.relative(root, info.asset).replace(/\\/g, '/'),
    notes: fs.existsSync(path.join(root, notes)) ? notes.replace(/\\/g, '/') : '',
    prerelease: info.prerelease,
  };
}

if (require.main === module) {
  try {
    const facts = resolve(process.argv[2]);
    const lines = Object.entries(facts).map(([k, v]) => `${k}=${v}`);
    console.log(lines.join('\n'));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { productFromRef, resolve };
