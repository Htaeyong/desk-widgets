// Regenerates widgets/dooray/contract/sample-snapshot.json from the fictional mock data.
// Usage: npm run sample
const fs = require('fs');
const path = require('path');
const mock = require('../backend/mock');
const {
  DEFAULT_RULES,
  toTag,
  buildProjectDashboard,
  buildSnapshot,
  buildCategories,
  applyCategoryIds,
  webUrlOf,
} = require('../backend/aggregate');

const now = new Date('2026-10-16T05:00:00.000Z');
const data = mock.build(now);
const tagIndex = new Map(data.tags.map((t) => [t.id, toTag(t)]));
const ctx = { meId: data.me.id, now, rules: DEFAULT_RULES, webUrl: webUrlOf(mock.DOMAIN), tagIndex };
const projects = data.projects.map((p) =>
  buildProjectDashboard(p, data.posts[p.id], { ...ctx, closedRecently: data.closedRecently[p.id] })
);
applyCategoryIds(projects, data.assignments);
const live = new Map(projects.flatMap((p) => p.tasks.open.map((t) => [t.id, t])));
const categories = buildCategories(data.categories, data.assignments, live, { now, rules: DEFAULT_RULES });
const snapshot = buildSnapshot({
  categories,
  status: { state: 'ok', lastSuccessAt: now.toISOString(), nextRefreshAt: new Date(now.getTime() + 45000).toISOString() },
  me: data.me,
  domain: mock.DOMAIN,
  rules: DEFAULT_RULES,
  projects,
  now,
});

const out = path.join(__dirname, '..', 'contract', 'sample-snapshot.json');
fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log(`Wrote ${out} (${projects.length} projects, ${snapshot.summary.counts.open} open tasks)`);
