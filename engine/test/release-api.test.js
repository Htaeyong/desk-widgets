// Release tool on both hosts (#100): Gitea + GitHub releases through fake APIs (no network). A run only adds what
// is missing, so re-running after a partial failure finishes the release without duplicating it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSource, giteaSide, githubSide, findGithubCommit, ensureRelease, releaseState } = require('../../scripts/release-api');
const release = require('../../scripts/release');
const { productOrder, pendingProducts, parseArgs: parseAllArgs } = require('../../scripts/release-all');

const root = path.join(__dirname, '..', '..');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function tempAsset(bytes = 1234, name = 'DeskWidgets-Setup-9.9.9.exe') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-release-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return { file, name, size: bytes };
}

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body ?? '') });

/**
 * In-memory release host. kind 'github' or 'gitea' decides the URL shapes. failUploads makes the next N uploads
 * fail; wrongSize makes the server report another size than it received.
 */
function fakeHost(kind) {
  const state = { releases: [], tags: {}, commits: [], calls: [], nextId: 1, failUploads: 0, wrongSize: false, uploads: [] };
  const base = kind === 'github' ? 'https://api.github.com/repos/o/r' : 'https://gitea.test/api/v1/repos/o/r';
  const byId = (id) => state.releases.find((r) => r.id === Number(id));
  state.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    state.calls.push(`${method} ${url}`);
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    let m;
    if (kind === 'github' && u.host === 'uploads.github.com' && (m = /\/releases\/(\d+)\/assets$/.exec(p))) {
      if (state.failUploads-- > 0) return reply(502, { message: 'bad gateway' });
      const size = init.body.size;
      state.uploads.push({ name: u.searchParams.get('name'), size, type: init.headers['Content-Type'] });
      const asset = { id: state.nextId++, name: u.searchParams.get('name'), size: state.wrongSize ? size - 1 : size };
      byId(m[1]).assets.push(asset);
      return reply(201, asset);
    }
    const rest = p.slice(new URL(base).pathname.length);
    if (method === 'GET' && (m = /^\/releases\/tags\/(.+)$/.exec(rest))) {
      const r = state.releases.find((x) => x.tag_name === m[1]);
      return r ? reply(200, structuredClone(r)) : reply(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = /^\/(?:git\/ref\/tags|tags)\/(.+)$/.exec(rest))) {
      const sha = state.tags[m[1]];
      if (!sha) return reply(404, {});
      return reply(200, kind === 'github' ? { object: { type: 'commit', sha } } : { commit: { sha } });
    }
    if (method === 'GET' && rest === '/commits') return reply(200, state.commits.map((c) => ({ sha: c.sha, commit: { message: c.message } })));
    if (method === 'POST' && rest === '/releases') {
      const b = JSON.parse(init.body);
      const id = state.nextId++;
      const r = { id, tag_name: b.tag_name, target: b.target_commitish, name: b.name, body: b.body, make_latest: b.make_latest, assets: [], html_url: `https://host/${b.tag_name}`, upload_url: `https://uploads.github.com/repos/o/r/releases/${id}/assets{?name,label}` };
      state.releases.push(r);
      state.tags[b.tag_name] = state.tags[b.tag_name] || b.target_commitish;
      return reply(201, structuredClone(r));
    }
    if (method === 'PATCH' && (m = /^\/releases\/(\d+)$/.exec(rest))) {
      Object.assign(byId(m[1]), JSON.parse(init.body));
      return reply(200, structuredClone(byId(m[1])));
    }
    if (method === 'DELETE' && (m = /^\/releases\/(?:(\d+)\/)?assets\/(\d+)$/.exec(rest))) {
      for (const r of state.releases) r.assets = r.assets.filter((a) => a.id !== Number(m[2]));
      return reply(204, null);
    }
    if (kind === 'gitea' && method === 'POST' && (m = /^\/releases\/(\d+)\/assets$/.exec(rest))) {
      if (state.failUploads-- > 0) return reply(500, { message: 'oops' });
      const file = init.body.get('attachment');
      state.uploads.push({ name: u.searchParams.get('name'), size: file.size });
      const asset = { id: state.nextId++, name: u.searchParams.get('name'), size: state.wrongSize ? file.size - 1 : file.size };
      byId(m[1]).assets.push(asset);
      return reply(201, asset);
    }
    return reply(500, { message: `unexpected ${method} ${url}` });
  };
  state.mutations = () => state.calls.filter((c) => !c.startsWith('GET')).length;
  return state;
}

const sides = {
  github: (host) => githubSide({ owner: 'o', repo: 'r', token: 't', fetchFn: host.fetch }),
  gitea: (host) => giteaSide({ baseUrl: 'https://gitea.test/', owner: 'o', repo: 'r', token: 't', fetchFn: host.fetch }),
};
const quiet = () => {};
const base = (asset, extra = {}) => ({ tag: 'engine-v9.9.9', title: 'Desk Widgets 9.9.9', body: 'notes', asset, target: SHA_A, log: quiet, ...extra });

test('parseSource reads the Gitea commit from publish-github commit messages', () => {
  assert.equal(parseSource('Desk Widgets 2026-10-23 (source 949019e)'), '949019e');
  assert.equal(parseSource('Initial commit'), null);
  assert.equal(parseSource(undefined), null);
});

test('findGithubCommit: the commit made from that source, else an equivalent newest commit, else publish first', async () => {
  const host = fakeHost('github');
  const side = sides.github(host);
  host.commits = [
    { sha: SHA_B, message: 'Desk Widgets 2026-10-24 (source 2222222)' },
    { sha: SHA_A, message: 'Desk Widgets 2026-10-23 (source 1111111)' },
  ];
  assert.equal((await findGithubCommit(side, '1111111' + 'f'.repeat(33))).sha, SHA_A);
  assert.equal((await findGithubCommit(side, '2222222' + 'f'.repeat(33))).sha, SHA_B);
  const seen = [];
  const eq = async (older, newer) => { seen.push([older, newer]); return true; };
  assert.equal((await findGithubCommit(side, '3333333' + 'f'.repeat(33), { isEquivalent: eq })).sha, SHA_B);
  assert.deepEqual(seen, [['2222222', '3333333' + 'f'.repeat(33)]]);
  await assert.rejects(findGithubCommit(side, '3333333', { isEquivalent: async () => false }), /publish it first/);
  host.commits = [];
  await assert.rejects(findGithubCommit(side, '3333333'), /no commits/);
});

for (const kind of ['github', 'gitea']) {
  test(`${kind}: creates the release with the installer, a second run changes nothing`, async () => {
    const host = fakeHost(kind);
    const asset = tempAsset();
    assert.equal(await releaseState(sides[kind](host), 'engine-v9.9.9', asset.name), 'missing');
    assert.equal(await ensureRelease(sides[kind](host), base(asset, { latest: true })), 'created');
    assert.equal(host.releases.length, 1);
    assert.equal(host.releases[0].target, SHA_A);
    assert.deepEqual(host.uploads.map((u) => [u.name, u.size]), [[asset.name, 1234]]);
    if (kind === 'github') {
      assert.equal(host.releases[0].make_latest, 'true');
      assert.equal(host.uploads[0].type, 'application/vnd.microsoft.portable-executable');
    }
    const before = host.mutations();
    assert.equal(await ensureRelease(sides[kind](host), base(asset)), 'complete');
    assert.equal(host.mutations(), before);
    assert.equal(await releaseState(sides[kind](host), 'engine-v9.9.9', asset.name), 'complete');
  });

  test(`${kind}: a failed upload is finished by the next run without a second release`, async () => {
    const host = fakeHost(kind);
    const asset = tempAsset();
    host.failUploads = 1;
    await assert.rejects(ensureRelease(sides[kind](host), base(asset)), /upload/);
    assert.equal(await releaseState(sides[kind](host), 'engine-v9.9.9', asset.name), 'partial');
    assert.equal(await ensureRelease(sides[kind](host), base(asset)), 'completed');
    assert.equal(host.releases.length, 1);
    assert.equal(host.releases[0].assets.length, 1);
  });

  test(`${kind}: --replace updates notes and swaps the installer; another size without it is refused`, async () => {
    const host = fakeHost(kind);
    await ensureRelease(sides[kind](host), base(tempAsset(1000)));
    const bigger = tempAsset(2000);
    await assert.rejects(ensureRelease(sides[kind](host), base(bigger)), /--replace/);
    assert.equal(await ensureRelease(sides[kind](host), base(bigger, { body: 'new notes', replace: true })), 'replaced');
    assert.equal(host.releases[0].body, 'new notes');
    assert.deepEqual(host.releases[0].assets.map((a) => a.size), [2000]);
  });

  test(`${kind}: dry run only reads`, async () => {
    const host = fakeHost(kind);
    const lines = [];
    assert.equal(await ensureRelease(sides[kind](host), base({ ...tempAsset(), size: null }, { dryRun: true, log: (l) => lines.push(l) })), 'create');
    assert.equal(host.mutations(), 0);
    assert.match(lines.join('\n'), /would create release engine-v9\.9\.9 at aaaaaaa/);
  });

  test(`${kind}: an upload the server reports with another size is deleted and fails`, async () => {
    const host = fakeHost(kind);
    host.wrongSize = true;
    await assert.rejects(ensureRelease(sides[kind](host), base(tempAsset())), /expected 1234/);
    assert.equal(host.releases[0].assets.length, 0);
  });
}

test('github: a tag that already points at another commit is refused', async () => {
  const host = fakeHost('github');
  host.tags['engine-v9.9.9'] = SHA_B;
  await assert.rejects(ensureRelease(sides.github(host), base(tempAsset())), /already points at bbbbbbb/);
  assert.equal(host.mutations(), 0);
  host.tags['engine-v9.9.9'] = SHA_A;
  assert.equal(await ensureRelease(sides.github(host), base(tempAsset())), 'created');
});

test('GitHub "Latest" goes to engine releases only', () => {
  assert.equal(release.isLatest('engine'), true);
  for (const id of ['dooray', 'clock', 'memo']) assert.equal(release.isLatest(id), false);
});

test('release options: --github is default-on with GITHUB_* values, --no-github turns it off', () => {
  assert.deepEqual(release.parseArgs(['engine', 'n.md', '--dry-run', '--no-github']).opts, { dryRun: true, replace: false, github: false, envFile: undefined });
  assert.equal(release.parseArgs(['engine', 'n.md']).opts.github, undefined);
  assert.equal(release.hasGithub({ GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't' }), true);
  assert.equal(release.hasGithub({ GITHUB_OWNER: 'o', GITHUB_REPO: 'r' }), false);
  assert.throws(() => release.parseArgs(['engine', 'n.md', '--bogus']), /Unknown option/);
  assert.throws(() => release.parseArgs(['engine', 'n.md', '--env']), /--env needs/);
});

const internal = fs.existsSync(path.join(root, 'scripts', 'publish-github.js'));

test('public release notes: internal links rewritten like the public copy', { skip: !internal && 'public copy' }, () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'public-export.json'), 'utf8'));
  const host = config.links.unlink[0];
  const file = path.join(root, 'release-notes', 'engine-v1.0.2.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(host));
  const out = release.publicNotes(text, file, { gh: { owner: 'someone', repo: 'desk-widgets' } });
  assert.ok(!out.includes(host));
  assert.match(out, /https:\/\/github\.com\/someone\/desk-widgets\/blob\/main\/docs\/user-guide\.md/);
  assert.throws(() => release.publicNotes('token: SECRETVALUE123', file, { fileValues: { GITHUB_TOKEN: 'SECRETVALUE123' }, gh: { owner: 'o', repo: 'r' } }), /forbidden/);
});

test('every release note in release-notes/ is publishable', { skip: !internal && 'public copy' }, () => {
  for (const name of fs.readdirSync(path.join(root, 'release-notes'))) {
    const file = path.join(root, 'release-notes', name);
    assert.doesNotThrow(() => release.publicNotes(fs.readFileSync(file, 'utf8'), file, { gh: { owner: 'o', repo: 'r' } }), name);
  }
});

test('release:all: engine first, then every widget; only products not complete on a side', async () => {
  const order = productOrder();
  assert.equal(order[0], 'engine');
  const widgets = fs.readdirSync(path.join(root, 'widgets')).filter((id) => fs.existsSync(path.join(root, 'widgets', id, 'widget.json')));
  assert.deepEqual([...order.slice(1)].sort(), widgets.sort());
  const states = async (tag) => {
    if (tag.startsWith('engine-')) return { gitea: 'complete', github: 'complete' };
    if (tag.startsWith('widget-dooray-')) return { gitea: 'complete', github: 'partial' };
    if (tag.startsWith('widget-clock-')) return { gitea: 'complete', github: null };
    return { gitea: 'missing', github: 'missing' };
  };
  const pending = await pendingProducts(['engine', 'dooray', 'clock', 'memo'], path.join(root, 'release-notes'), states);
  assert.deepEqual(pending.map((p) => p.product), ['dooray', 'memo']);
  assert.equal(path.basename(pending[1].notes), `${release.productInfo('memo').tag}.md`);
  assert.equal(parseAllArgs(['notes', '--dry-run', '--no-site']).site, false);
  assert.throws(() => parseAllArgs([]), /Usage/);
});

test('every current product version has release notes', () => {
  for (const product of productOrder()) {
    const { tag } = release.productInfo(product);
    assert.ok(fs.existsSync(path.join(root, 'release-notes', `${tag}.md`)), `release-notes/${tag}.md`);
  }
});
