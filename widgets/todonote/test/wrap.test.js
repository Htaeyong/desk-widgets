// Word wrap per note (#137): a menu item and Alt+Z turn it off for one note; the choice lives in the widget's
// settings (shared with the user's other PCs like the colour), never in the note file, so a locked note keeps it too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../lib/settings');
const { setup } = require('./fake-engine');

const PASSWORD = 'wrap-password-1';
const ID = 'note00000137';

async function widget(t, opts = {}) {
  const s = setup(opts);
  t.after(() => s.w.stop());
  await s.w.start();
  return s;
}

async function openNote(s, { title = '긴 줄', body = `${'아주 긴 줄 '.repeat(40)}\n` } = {}) {
  const file = s.writeNote(title, { id: ID, body });
  await s.w.focus();
  await s.until(() => s.listWindow());
  await s.call(s.listWindow(), 'refresh');
  await s.call(s.listWindow(), 'open', { id: ID });
  await s.until(() => s.memoWindows().length === 1);
  const win = s.memoWindows()[0];
  const init = await s.call(win, 'init');
  return { file, win, init };
}

const lastMeta = (win) => win.sent.filter(([n]) => n === 'meta').map(([, p]) => p).pop();
const wrapItem = (menu) => menu.find((x) => x.label === '자동 줄바꿈');

test('settings keep only noWrap: true (the default sends nothing to other PCs)', () => {
  const memos = { aaaa1111: { noWrap: true }, bbbb2222: { noWrap: false }, cccc3333: { noWrap: 'yes' }, dddd4444: {} };
  const out = S.sanitize({ ...S.DEFAULTS, memos }).memos;
  assert.deepEqual(out.aaaa1111, { noWrap: true });
  assert.deepEqual(out.bbbb2222, {});
  assert.deepEqual(out.cccc3333, {});
  assert.deepEqual(out.dddd4444, {});
});

test('a note wraps by default; the menu turns it off and on without touching the file', async (t) => {
  const menus = [];
  const s = await widget(t, { menus });
  const { file, win, init } = await openNote(s);
  assert.equal(init.meta.wrap, true);
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;

  await s.call(win, 'menu', {});
  const item = wrapItem(menus.at(-1));
  assert.equal(item.type, 'checkbox');
  assert.equal(item.checked, true);
  item.click({ checked: false });
  assert.equal(s.state().memos[ID].noWrap, true);
  assert.equal(lastMeta(win).wrap, false);

  // The menu shows the new state.
  await new Promise((r) => setTimeout(r, 600)); // the menu dedupe window
  await s.call(win, 'menu', {});
  assert.equal(wrapItem(menus.at(-1)).checked, false);

  // Alt+Z from the page flips it back.
  assert.equal((await s.call(win, 'toggleWrap')).ok, true);
  assert.equal(s.state().memos[ID].noWrap, undefined);
  assert.equal(lastMeta(win).wrap, true);

  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('each note has its own setting, and it comes back after a restart', async (t) => {
  const s = await widget(t);
  const { win } = await openNote(s);
  await s.call(win, 'toggleWrap');
  s.writeNote('다른 노트', { id: 'note00000999', body: '짧은 줄\n' });
  await s.call(s.listWindow(), 'refresh');
  await s.call(s.listWindow(), 'open', { id: 'note00000999' });
  await s.until(() => s.memoWindows().length === 2);
  const other = s.memoWindows().find((w) => w !== win);
  assert.equal((await s.call(other, 'init')).meta.wrap, true);
  assert.equal((await s.call(win, 'init')).meta.wrap, false);
});

test('a change from another PC reaches the open window', async (t) => {
  const s = await widget(t);
  const { win } = await openNote(s);
  assert.equal(lastMeta(win)?.wrap ?? true, true);
  s.setState({ memos: { ...s.state().memos, [ID]: { ...s.state().memos[ID], noWrap: true } } });
  s.remoteChange();
  assert.equal(lastMeta(win).wrap, false);
});

test('a locked note: the setting works while locked and unlocked, and never goes into the plain front matter', async (t) => {
  const s = await widget(t);
  const { file, win } = await openNote(s, { body: 'secret long line\n' });
  const r = await s.call(win, 'lock', { password: PASSWORD });
  assert.equal(r.ok, true, r.message);
  assert.equal((await s.call(win, 'toggleWrap')).ok, true);
  assert.equal(lastMeta(win).wrap, false);
  // Closed and opened again: still locked, the setting is shown before the password.
  await s.call(win, 'close');
  await s.call(s.listWindow(), 'open', { id: ID });
  await s.until(() => s.memoWindows().length === 1);
  const again = s.memoWindows()[0];
  const init = await s.call(again, 'init');
  assert.equal(init.meta.locked, true);
  assert.equal(init.meta.unlocked, false);
  assert.equal(init.meta.wrap, false);
  // Toggling is not a text call, so a locked window may do it.
  assert.equal((await s.call(again, 'toggleWrap')).ok, true);
  assert.equal(lastMeta(again).wrap, true);
  assert.equal((await s.call(again, 'unlock', { password: PASSWORD })).ok, true);
  assert.equal(lastMeta(again)?.wrap ?? true, true);
  // The plain front matter holds only what it held before (no wrap or noWrap line).
  const front = fs.readFileSync(file, 'utf8').split(/\n---\n/)[0];
  assert.deepEqual(front.split(/\n/).slice(1).map((l) => l.split(':')[0]).sort(), ['desk-widgets-memo', 'title']);
  assert.equal(path.extname(file), '.md');
});

test('the page: the meta flag sets body.nowrap, and the style turns wrapping off only in the editor', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'memo', 'memo.js'), 'utf8');
  assert.match(js, /classList\.toggle\('nowrap', m\.wrap === false\)/);
  assert.match(js, /e\.code === 'KeyZ'[\s\S]{0,200}api\.call\('toggleWrap'\)/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'memo', 'memo.css'), 'utf8');
  const rule = css.match(/body\.nowrap \.editor \{([^}]*)\}/);
  assert.ok(rule, 'body.nowrap .editor rule');
  assert.match(rule[1], /white-space: pre;/);
  assert.match(rule[1], /overflow-x: auto;/);
  // Images still fit the window (the base rule is not overridden for wrap off).
  assert.match(css, /\.editor img \{[^}]*max-width: 100%/);
  assert.doesNotMatch(css, /body\.nowrap \.editor img/);
});
