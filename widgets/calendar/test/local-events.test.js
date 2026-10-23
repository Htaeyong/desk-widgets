const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createLocalEvents } = require('../lib/local-events');

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
