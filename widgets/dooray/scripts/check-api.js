// Verifies the Dooray API token and prints the response shape of key endpoints.
// Usage: npm run check-api
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env'), quiet: true });
const { createClient } = require('../backend/dooray');

const dooray = createClient({
  apiBase: process.env.DOORAY_API_BASE || 'https://api.dooray.com',
  token: process.env.DOORAY_API_KEY,
});

const outDir = path.join(__dirname, '..', '..', '..', 'samples');

function save(name, data) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

function describeShape(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? [describeShape(value[0], depth + 1)] : [];
  if (value && typeof value === 'object') {
    if (depth > 3) return '{...}';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describeShape(v, depth + 1)]));
  }
  return value === null ? 'null' : typeof value;
}

async function step(name, fn) {
  try {
    const data = await fn();
    save(name, data);
    console.log(`\n[OK] ${name}`);
    console.log(JSON.stringify(describeShape(data), null, 2));
    return data;
  } catch (err) {
    console.error(`\n[FAIL] ${name}: ${err.message}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
    return null;
  }
}

(async () => {
  await step('members-me', dooray.getMyMember);
  const projects = await step('projects', () => dooray.listMyProjects());
  if (projects?.result) {
    console.log(`\nProjects (${projects.totalCount ?? projects.result.length}):`);
    for (const p of projects.result) console.log(`  - ${p.id}  ${p.code ?? ''}`);
  }
  console.log(`\nRaw responses saved to ${outDir} (gitignored).`);
})();
