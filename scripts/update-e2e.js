// End-to-end check of the in-app update (#104) against a local server, without the real site or GitHub and
// without running any installer. Builds a real widget installer (clock, version 1.0.1 by default), serves it with
// a fake products.json behind a redirect, and drives engine/main/updates.js: check -> download -> SHA-256 check ->
// the point where the engine would open the installer (stopped there). Also: wrong hash, foreign host, 404.
//
// Usage: node scripts/update-e2e.js [--installer <exe>] [--port 5077] [--serve]
//   --installer  use this installer instead of building one (its name gives the widget and version)
//   --serve      keep the server running afterwards for a manual run of the app in test mode:
//                DESK_WIDGETS_UPDATE_URL=http://127.0.0.1:<port>/products.json DESK_WIDGETS_UPDATE_DRY_RUN=1 npm start
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { UpdateManager } = require('../engine/main/updates');

const root = path.join(__dirname, '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('--port') || 5077);
const base = `http://127.0.0.1:${port}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-update-e2e-'));

function buildInstaller() {
  const given = arg('--installer');
  if (given) return path.resolve(given);
  const out = path.join(work, 'build');
  console.log('building the clock widget installer 1.0.1 (tools/widget-kit) ...');
  execFileSync(process.execPath, [path.join(root, 'tools', 'widget-kit', 'build.js'), path.join(root, 'widgets', 'clock'), '--version', '1.0.1', '--out', out], { stdio: 'pipe' });
  return path.join(out, 'DeskWidgets-ClockWidget-Setup-1.0.1.exe');
}

function productsFor({ file, size, sha256, url, version }) {
  const pub = JSON.parse(fs.readFileSync(path.join(root, 'site', 'public', 'products.json'), 'utf8'));
  pub.widgets = pub.widgets.map((w) => (w.id === 'clock' ? { ...w, download: { version, tag: `widget-clock-v${version}`, file, url, size, sha256 } } : w));
  return pub;
}

async function main() {
  const installer = buildInstaller();
  const file = path.basename(installer);
  const version = /-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(file)[1];
  const bytes = fs.readFileSync(installer);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  console.log(`installer ${file}: ${bytes.length} bytes, sha256 ${sha256}`);

  let products = null;
  const served = [];
  const server = http.createServer((req, res) => {
    served.push(req.url);
    if (req.url === '/products.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(products));
    }
    // Like GitHub: the release URL redirects to the file host.
    if (req.url === `/releases/download/widget-clock-v${version}/${file}`) {
      res.writeHead(302, { Location: `${base}/assets/${file}?sig=test` });
      return res.end();
    }
    if (req.url.startsWith(`/assets/${file}`)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
      return res.end(bytes);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const results = [];
  const scenario = async (name, download, expect) => {
    products = productsFor({ file, size: bytes.length, sha256, url: `${base}/releases/download/widget-clock-v${version}/${file}`, version, ...download });
    const launched = [];
    const tempRoot = path.join(work, name.replace(/\W+/g, '-'));
    const m = new UpdateManager({
      engineVersion: require('../package.json').version,
      engineApi: require('../engine/main/widgets').ENGINE_API,
      listWidgets: () => [{ id: 'clock', name: '시계', version: '1.0.0', source: 'installed' }],
      productsUrl: `${base}/products.json`,
      dev: true,
      stateFile: path.join(work, `${name.replace(/\W+/g, '-')}.json`),
      tempRoot,
      // Where main.js would call shell.openPath (UAC). Stopped here: report what would be opened.
      launch: async (f) => {
        const head = fs.readFileSync(f).subarray(0, 2).toString();
        launched.push({ file: f, mz: head === 'MZ', same: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === sha256 });
        return '';
      },
      log: () => {},
    });
    const snap = await m.check({ manual: true });
    const clock = snap.items.find((i) => i.id === 'clock');
    const res = clock.status === 'available' ? await m.install('clock') : { ok: false, message: `status ${clock.status}` };
    const leftovers = fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot).flatMap((d) => fs.readdirSync(path.join(tempRoot, d))) : [];
    const ok = expect({ clock, res, launched, leftovers });
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: status ${clock.status}, ${res.ok ? `would open ${launched[0]?.file} (MZ ${launched[0]?.mz}, sha256 ${launched[0]?.same ? 'ok' : 'BAD'})` : res.message}${leftovers.length ? `, left ${leftovers.join(',')}` : ''}`);
  };

  await scenario('good installer', {}, ({ res, launched }) => res.ok && launched.length === 1 && launched[0].mz && launched[0].same);
  await scenario('wrong hash', { sha256: '0'.repeat(64) }, ({ res, launched, leftovers }) => !res.ok && /SHA-256/.test(res.message) && !launched.length && !leftovers.length);
  await scenario('wrong size', { size: bytes.length - 1 }, ({ res, launched, leftovers }) => !res.ok && /크기/.test(res.message) && !launched.length && !leftovers.length);
  await scenario('foreign host in products.json', { url: `https://evil.example/${file}` }, ({ clock, launched }) => clock.status === 'unknown' && !launched.length);
  await scenario('missing file (404)', { url: `${base}/releases/download/widget-clock-v${version}/nope/${file}` }, ({ res, launched }) => !res.ok && /HTTP 404/.test(res.message) && !launched.length);

  console.log(`\nrequests: ${served.length}, work folder ${work}`);
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `${failed} scenario(s) FAILED` : 'all scenarios passed');
  if (process.argv.includes('--serve')) {
    products = productsFor({ file, size: bytes.length, sha256, url: `${base}/releases/download/widget-clock-v${version}/${file}`, version });
    console.log(`\nserving ${base}/products.json (Ctrl+C to stop)`);
    return;
  }
  server.close();
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
