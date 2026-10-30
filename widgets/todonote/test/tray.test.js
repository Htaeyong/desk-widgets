// The tray menu items "새 할 일 노트" and "할 일 노트 목록" (#118): ctx.setTrayItems from engine API 1.9, nothing on older engines.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./fake-engine');

test('#118 the tray item makes a new note, like "새 노트", and opens its window focused', async () => {
  const t = setup({ tray: true });
  await t.w.start();
  const items = t.trayItems();
  assert.deepEqual(items.map(({ id, label }) => ({ id, label })), [{ id: 'new-note', label: '새 할 일 노트' }, { id: 'list', label: '할 일 노트 목록' }]);
  assert.deepEqual(t.trayOptions(), { settings: false }, '"할 일 노트 설정" is left out of the tray');
  assert.equal(typeof items[0].click, 'function');
  assert.equal(t.memoWindows().length, 0);
  let focused = 0;
  t.ctx.beforeFocus = () => focused++;
  items[0].click();
  assert.ok(await t.until(() => t.memoWindows().length === 1));
  const [win] = t.memoWindows();
  win.emit('ready-to-show');
  assert.equal(focused, 1, 'the new note window comes to the front');
  const init = await t.call(win, 'init');
  assert.equal(init.meta.title, '새 노트');
  assert.ok(t.fileById(init.meta.id), 'a note file was made');
  t.w.stop();
});

test('#118 the list tray item opens the list window', async () => {
  const t = setup({ tray: true });
  await t.w.start();
  if (t.listWindow()) await t.call(t.listWindow(), 'close');
  assert.equal(t.listWindow(), undefined);
  t.trayItems().find((i) => i.id === 'list').click();
  assert.ok(await t.until(() => Boolean(t.listWindow())));
  t.w.stop();
});

test('#118 an engine before API 1.9 (no ctx.setTrayItems): the widget starts as before', async () => {
  const t = setup();
  await t.w.start();
  assert.equal(t.trayItems(), null);
  assert.ok(t.listWindow());
  t.w.stop();
});
