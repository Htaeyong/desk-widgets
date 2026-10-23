// Every built-in calendar theme page must contain the elements calendar.js needs (#103): the big month theme once
// missed the todo editor added to the default page, and calendar.js threw while loading (an empty calendar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const themesDir = path.join(__dirname, '..', 'themes');
const script = fs.readFileSync(path.join(themesDir, 'default', 'calendar.js'), 'utf8');

/** Ids the script looks up with $('id') and uses without "?." (a missing one throws). */
function requiredIds() {
  const ids = new Set();
  for (const m of script.matchAll(/\$\('([A-Za-z][A-Za-z0-9_-]*)'\)(\?\.)?/g)) {
    if (!m[2]) ids.add(m[1]);
  }
  return ids;
}

for (const theme of fs.readdirSync(themesDir)) {
  const page = path.join(themesDir, theme, 'index.html');
  if (!fs.existsSync(page)) continue;
  test(`calendar theme "${theme}" has every element calendar.js requires`, () => {
    const html = fs.readFileSync(page, 'utf8');
    const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const missing = [...requiredIds()].filter((id) => !present.has(id));
    assert.deepEqual(missing, []);
  });
}

test('calendar.js skips the optional todo editor of a theme without it', () => {
  for (const id of ['todoForm', 'todoCancel', 'todoDateOnly', 'todoEditor']) {
    assert.ok(script.includes(`$('${id}')?.addEventListener`), id);
  }
});
