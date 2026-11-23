// #134: the sync tab's options form keeps a checkbox the user changed until it is saved. Before, every state
// update from the engine (each automatic check starts and ends one) drew the saved checkboxes again, so a widget
// unchecked a moment before "설정 저장" (or "지금 동기화") was saved, or synced, as still checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSyncForm } = require('../renderer/sync-form');

test('an unsaved edit survives engine updates until saved', () => {
  const form = createSyncForm();
  const connected = { enabled: true, widgets: [{ id: 'calendar', enabled: true }] };
  assert.equal(form.mayRender(), true, 'a fresh form shows the engine values');
  assert.equal(form.saveBeforeSync(connected), false);
  form.edit(); // the user unchecks 캘린더
  assert.equal(form.mayRender(), false, 'an automatic check must not put the checkbox back');
  assert.equal(form.saveBeforeSync(connected), true, '"지금 동기화" saves the change first');
  assert.equal(form.saveBeforeSync({ enabled: false }), false, 'not connected: nothing to save before a check');
  form.saved();
  assert.equal(form.mayRender(), true);
  assert.equal(form.mayRender({ previewingConnect: true }), false, 'a running connection preview keeps the form as well');
});

test('the manager page wires the form model: loaded before settings.js, used on every update and before "지금 동기화"', () => {
  const dir = path.join(__dirname, '..', 'renderer');
  const html = fs.readFileSync(path.join(dir, 'settings.html'), 'utf8');
  assert.ok(html.indexOf('src="sync-form.js"') > 0 && html.indexOf('src="sync-form.js"') < html.indexOf('src="settings.js"'));
  const js = fs.readFileSync(path.join(dir, 'settings.js'), 'utf8');
  const render = js.slice(js.indexOf('function renderSyncState'), js.indexOf('async function refreshSync'));
  assert.match(render, /syncForm\.mayRender\(/, 'renderSyncState only redraws the form when it may');
  const syncNow = js.slice(js.indexOf('async function runSyncNow'), js.indexOf('async function turnSyncOff'));
  assert.match(syncNow, /syncForm\.saveBeforeSync\(syncUi\.state\) && !await saveSyncOptionsNow\(\)/);
  // The tab says that an unchecked widget is out entirely.
  assert.match(js, /체크를 끈 위젯은 그 위젯 전체\(설정·테마 선택·항목·노트\)/);
});
