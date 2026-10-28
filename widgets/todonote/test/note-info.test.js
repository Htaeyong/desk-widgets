// #113: a new note gets an id file name that never changes, and the "정보…" panel tells where it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./fake-engine');

const labels = (items) => items.map((i) => i.label).filter(Boolean);
const pause = () => new Promise((r) => setTimeout(r, 450)); // menus closer than 400 ms apart are one click

test('a new note: "YYYYMMDD-HHmmss-<id>.md" with created: in front matter; renaming and completing keep the file name', async () => {
  const t = setup();
  await t.w.start();
  const list = t.listWindow();
  const before = Date.now();
  await t.call(list, 'new');
  const [win] = t.memoWindows();
  const { meta } = await t.call(win, 'init');
  const { info } = await t.call(win, 'info');
  const name = path.basename(info.file);
  assert.match(name, new RegExp(`^\\d{8}-\\d{6}-${meta.id}\\.md$`));
  assert.equal(path.dirname(info.file), t.notes);
  assert.match(t.read(info.file), /^---\ntitle: 새 노트\ncreated: \d{4}-\d\d-\d\dT[\d:.]+Z\ndesk-widgets-memo: /);
  assert.ok(info.created >= before - 1000 && info.created <= Date.now());
  await t.call(win, 'rename', { title: '새 이름' });
  assert.ok(fs.existsSync(info.file), 'a new title does not rename the file');
  assert.match(t.read(info.file), /\ntitle: 새 이름\n/);
  await t.call(win, 'setDue', { due: '2026-12-24' });
  await t.call(win, 'complete');
  assert.ok(await t.until(() => fs.existsSync(path.join(t.notes, '완료', name))), 'completing moves the file under the same name');
  assert.equal(await t.call(list, 'uncomplete', { id: meta.id }).then((r) => r.ok), true);
  assert.ok(await t.until(() => fs.existsSync(info.file)), 'and back under the same name');
  t.w.stop();
});

test('정보…: title, path, created, modified and size; 경로 복사 copies the path; the to-do list item menu has it too', async () => {
  const menus = [];
  const t = setup({ menus });
  let copied = null;
  t.electron.clipboard = { writeText: (s) => (copied = s) };
  const file = t.writeNote('회의', { id: 'info11', fm: ['title: 회의', 'created: 2026-10-20T00:30:00.000Z', 'due: 2026-12-24'], body: '본문\n' });
  t.setState({ memos: { info11: { open: true } } });
  await t.w.start();
  const [win] = t.memoWindows();
  await t.call(win, 'init');
  const now = library(t).get('info11').file;
  const { info } = await t.call(win, 'info');
  const st = fs.statSync(now);
  assert.deepEqual(info, { title: '회의', file: now, created: Date.parse('2026-10-20T00:30:00.000Z'), modified: Math.round(st.mtimeMs), size: st.size });
  assert.ok(path.isAbsolute(info.file));
  assert.equal(path.dirname(now), path.dirname(file));
  // The note menu: 정보… next to 탐색기에서 보기; clicking it sends the same data to the window.
  await t.call(win, 'menu', {});
  const items = menus.at(-1);
  assert.ok(labels(items).includes('정보…') && labels(items).includes('탐색기에서 보기'));
  win.sent.length = 0;
  items.find((i) => i.label === '정보…').click();
  assert.deepEqual(win.sent.find(([n]) => n === 'info')[1], info);
  assert.deepEqual(await t.call(win, 'copyPath'), { ok: true });
  assert.equal(copied, now);
  // The to-do list's item menu.
  await pause();
  await t.call(t.listWindow() || win, 'todoMenu', { id: 'info11' });
  assert.ok(labels(menus.at(-1)).includes('정보…'));
  t.w.stop();
});

/** The widget's library, through the list view (the test has no direct handle): the note's file by id. */
function library(t) {
  return {
    get: (id) => {
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
      const file = walk(t.notes).find((f) => f.endsWith('.md') && fs.readFileSync(f, 'utf8').includes(`desk-widgets-memo: ${id}`));
      return { file };
    },
  };
}
