// Downloads the NSIS toolchain electron-builder uses (same version, same checksums, same cache folder)
// so a widget build on CI needs no throwaway engine build (#101). Prints the paths and, on GitHub
// Actions, passes them to later steps as MAKENSIS / STDUTILS_PLUGINS (read by tools/widget-kit).
// Uses electron-builder internals; the version is pinned by package-lock.json and a change fails here.
const fs = require('fs');
const path = require('path');
const { getMakeNsisPath, getNsisPluginsPath } = require('app-builder-lib/out/toolsets/windows');

async function main() {
  // No toolsets/custom binaries in package.json: the defaults are what "npm run dist" uses.
  const makensis = (await getMakeNsisPath()).path;
  const plugins = path.join(await getNsisPluginsPath(), 'x86-unicode');
  for (const p of [makensis, path.join(plugins, 'StdUtils.dll')]) {
    if (!fs.existsSync(p)) throw new Error(`NSIS download incomplete: ${p} is missing`);
  }
  console.log(`makensis: ${makensis}\nplugins:  ${plugins}`);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `MAKENSIS=${makensis}\nSTDUTILS_PLUGINS=${plugins}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
