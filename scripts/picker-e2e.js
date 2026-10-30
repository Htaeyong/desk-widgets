// End-to-end check of the first-run widget picker (#96) against a local server, without the real site or GitHub
// and without running any installer. Builds real widget installers (clock, calendar, memo; tools/widget-kit),
// serves them behind a redirect with a fake products.json, and drives engine/main/widget-picker.js: load the list ->
// install the chosen widgets one by one -> stop where the engine would open each installer (UAC). Also: the site
// unreachable, a wrong hash, that 할 일 노트 is checked by default and the merged 스티키 노트 listed last (#117), and that a widget before its
// official release (0.0.x) is never listed.
//
// Usage: node scripts/picker-e2e.js [--port 5078]
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { UpdateManager } = require('../engine/main/updates');
const { WidgetPicker } = require('../engine/main/widget-picker');

const root = path.join(__dirname, '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('--port') || 5078);
const base = `http://127.0.0.1:${port}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-picker-e2e-'));
const IDS = ['clock', 'calendar', 'memo'];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function build(id) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'widgets', id, 'widget.json'), 'utf8'));
  const out = path.join(work, 'build', id);
  execFileSync(process.execPath, [path.join(root, 'tools', 'widget-kit', 'build.js'), path.join(root, 'widgets', id), '--version', '1.1.0', '--out', out], { stdio: 'pipe' });
  const file = fs.readdirSync(out).find((f) => /^DeskWidgets-.*-Setup-.*\.exe$/.test(f));
  return { id, manifest: { ...manifest, version: '1.1.0' }, file, bytes: fs.readFileSync(path.join(out, file)) };
}

async function main() {
  console.log('building widget installers ...');
  const built = IDS.map(build);
  for (const b of built) console.log(`  ${b.file}: ${b.bytes.length} bytes`);

  const pub = JSON.parse(fs.readFileSync(path.join(root, 'site', 'public', 'products.json'), 'utf8'));
  const tagOf = (b) => `widget-${b.id}-v${b.manifest.version}`;
  const downloadOf = (b, sha256 = sha(b.bytes)) => ({ version: b.manifest.version, tag: tagOf(b), file: b.file, url: `${base}/releases/download/${tagOf(b)}/${b.file}`, size: b.bytes.length, sha256 });
  const productsFor = (override = {}) => ({
    ...pub,
    widgets: [
      ...built.map((b) => ({ id: b.id, name: b.manifest.name, description: b.manifest.description, engineApi: b.manifest.engineApi, engineMin: b.manifest.engineMin, version: b.manifest.version, download: downloadOf(b, override[b.id]), ...(b.id === 'memo' ? { merged: { since: b.manifest.version, successor: 'todonote' } } : {}) })),
      // 할 일 노트 is a released widget from 1.1.0 (#111) and a default choice since #117 (스티키 노트 was merged into it).
      { id: 'todonote', name: '할 일 노트', version: '1.1.0', engineApi: '1.8', download: { ...downloadOf(built[0]), version: '1.1.0', tag: 'widget-todonote-v1.1.0', file: 'DeskWidgets-TodoNoteWidget-Setup-1.1.0.exe', url: `${base}/releases/download/widget-todonote-v1.1.0/DeskWidgets-TodoNoteWidget-Setup-1.1.0.exe` } },
      // A widget before its official release must never show up, whatever the server lists.
      { id: 'newwidget', name: '새 위젯', version: '0.0.9', engineApi: '1.8', download: { ...downloadOf(built[0]), version: '0.0.9', tag: 'widget-newwidget-v0.0.9', file: 'DeskWidgets-NewWidget-Setup-0.0.9.exe', url: `${base}/releases/download/widget-newwidget-v0.0.9/DeskWidgets-NewWidget-Setup-0.0.9.exe` } },
    ],
  });

  let products = productsFor();
  let siteDown = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/products.json') {
      if (siteDown) return res.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(products));
    }
    const hit = built.find((b) => req.url === `/releases/download/${tagOf(b)}/${b.file}`);
    if (hit) {
      res.writeHead(302, { Location: `${base}/assets/${hit.file}?sig=test` });
      return res.end();
    }
    const asset = built.find((b) => req.url.startsWith(`/assets/${b.file}`));
    if (asset) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': asset.bytes.length });
      return res.end(asset.bytes);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  };
  const make = (name) => {
    const present = [];
    const launched = [];
    const updates = new UpdateManager({
      engineVersion: require('../package.json').version,
      engineApi: require('../engine/main/widgets').ENGINE_API,
      listWidgets: () => present.map((id) => ({ id, name: id, version: '1.0.0', source: 'installed' })),
      productsUrl: `${base}/products.json`,
      dev: true,
      stateFile: path.join(work, `${name}.json`),
      tempRoot: path.join(work, name),
      // Where main.js would call shell.openPath (UAC). Stopped here: record what would be opened, and let the
      // widget "appear" the way the engine's folder watcher would after the real installer ran.
      launch: async (file) => {
        const bytes = fs.readFileSync(file);
        launched.push({ file: path.basename(file), mz: bytes.subarray(0, 2).toString() === 'MZ', hash: sha(bytes) });
        return '';
      },
      log: () => {},
    });
    const picker = new WidgetPicker({
      updates, listWidgets: () => present.map((id) => ({ id })), pollMs: 1, waitTimeoutMs: 1000, log: () => {},
      sleep: async () => {
        for (const l of launched) {
          const b = built.find((x) => x.file === l.file);
          if (b && !present.includes(b.id)) present.push(b.id);
        }
      },
    });
    return { picker, launched, present };
  };

  {
    const { picker, launched } = make('good');
    const snap = await picker.load();
    const listed = snap.rows.map((r) => `${r.id}${r.checked ? '*' : ''}${r.merged ? '(merged)' : ''}`).join(' ');
    check('list: released widgets only, 할 일 노트 checked, merged 스티키 노트 last and unchecked (#117)', listed === 'clock* calendar* todonote* memo(merged)', listed);
    await picker.start(IDS);
    const q = picker.snapshot().queue;
    check('chosen widgets (a merged one too) install one after another', q.length === 3 && q.every((x) => x.state === 'done') && launched.length === 3, q.map((x) => `${x.id}:${x.state}`).join(' '));
    check('each opened file is a real installer with the published hash', built.every((b, i) => launched[i]?.file === b.file && launched[i].mz && launched[i].hash === sha(b.bytes)));
    await picker.start(['newwidget']);
    check('an unreleased widget id is ignored', launched.length === 3);
  }
  {
    products = productsFor({ calendar: '0'.repeat(64) });
    const { picker, launched } = make('badhash');
    await picker.load();
    await picker.start(IDS);
    const q = picker.snapshot().queue;
    check('wrong hash: that widget fails, the others still install', q.find((x) => x.id === 'calendar').state === 'failed' && /SHA-256/.test(q.find((x) => x.id === 'calendar').message) && launched.length === 2, q.map((x) => `${x.id}:${x.state}`).join(' '));
    products = productsFor();
  }
  {
    siteDown = true;
    const { picker, launched } = make('down');
    const snap = await picker.load();
    await picker.start(IDS);
    check('site unreachable: message, no rows, nothing launched', Boolean(snap.error) && !snap.rows.length && !launched.length, snap.error);
    siteDown = false;
  }

  const left = fs.existsSync(path.join(work, 'badhash')) ? fs.readdirSync(path.join(work, 'badhash')).flatMap((d) => fs.readdirSync(path.join(work, 'badhash', d))).filter((f) => f.includes('Calendar')) : [];
  check('no corrupt download left behind', left.length === 0);
  server.close();
  console.log(`\nwork folder ${work}`);
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
