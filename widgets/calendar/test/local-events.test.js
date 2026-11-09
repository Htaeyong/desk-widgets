const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createLocalEvents, keepUid } = require('../lib/local-events');

test('local events persist independently and never become remote writes', () => {
  const files = new Map();
  let changes = 0;
  const ctx = {
    dataDir: 'C:\\calendar-test',
    createStore: ({ file, defaults, sanitize }) => ({
      load: () => sanitize(files.get(path.basename(file)) || defaults),
      save: (next) => files.set(path.basename(file), sanitize(next)),
    }),
  };
  const events = createLocalEvents(ctx, () => changes++);
  const fields = { title: 'Local meeting', allDay: true, start: '2026-10-21', end: '2026-10-22', location: '', description: '' };
  const created = events.write('create', null, fields);
  assert.equal(created.ok, true);
  assert.equal(events.list(new Date(2026, 9, 21).getTime(), new Date(2026, 9, 22).getTime())[0].title, fields.title);
  assert.equal(events.list(new Date(2026, 9, 22).getTime(), new Date(2026, 9, 23).getTime()).length, 0);
  const reopened = createLocalEvents(ctx, () => changes++);
  assert.equal(reopened.find(created.uid).title, fields.title);
  assert.equal(reopened.write('edit', created.uid, { ...fields, title: 'Moved', start: '2026-10-23', end: '2026-10-24' }).ok, true);
  assert.equal(events.list(new Date(2026, 9, 21).getTime(), new Date(2026, 9, 22).getTime()).length, 0);
  assert.equal(reopened.write('delete', created.uid).ok, true);
  assert.equal(events.all().length, 0);
  assert.equal(changes, 3);
});

test('a kept copy of a note (#128): one per note and due, however often it is asked', () => {
  const files = new Map();
  let changes = 0;
  const ctx = {
    dataDir: 'C:\\calendar-test',
    createStore: ({ file, defaults, sanitize }) => ({
      load: () => sanitize(files.get(path.basename(file)) || defaults),
      save: (next) => files.set(path.basename(file), sanitize(next)),
    }),
  };
  const events = createLocalEvents(ctx, () => changes++);
  const task = { id: 'n1', dueAt: new Date(2026, 9, 21, 23, 59).getTime(), dateOnly: true };
  const uid = keepUid(task);
  assert.match(uid, /^local:[a-f0-9]{24}$/, 'the same form as any local event, so it syncs and survives the store');
  assert.equal(uid, keepUid({ ...task }));
  assert.notEqual(uid, keepUid({ ...task, dueAt: task.dueAt + 86400000 }), 'a moved due is another deadline');
  assert.notEqual(uid, keepUid({ ...task, id: 'n2' }));
  const fields = { title: 'Report', allDay: true, start: '2026-10-21', end: '2026-10-22', location: '', description: '' };
  assert.deepEqual(events.keep(uid, fields), { ok: true, uid, existing: false });
  assert.deepEqual(events.keep(uid, { ...fields, title: 'Changed' }), { ok: true, uid, existing: true });
  assert.equal(events.all().length, 1);
  assert.equal(events.find(uid).title, 'Report');
  assert.equal(changes, 1);
  assert.equal(events.keep(keepUid({ ...task, id: 'n2' }), { ...fields, title: '' }).ok, false);
  assert.equal(events.all().length, 1);
  // An ordinary event from here on: the user edits and deletes it like any other.
  assert.equal(events.write('edit', uid, { ...fields, title: 'Mine now' }).ok, true);
  assert.equal(events.write('delete', uid).ok, true);
  assert.equal(events.all().length, 0);
});
