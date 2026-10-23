const test = require('node:test');
const assert = require('node:assert/strict');
const { todoDeadline } = require('../todo-integration');

test('Dooray date-only deadlines remain on the local date in Todo', () => {
  const due = todoDeadline({ dueDate: '2026-10-31' });
  assert.equal(due.dateOnly, true);
  assert.equal(new Date(due.dueAt).getFullYear(), 2026);
  assert.equal(new Date(due.dueAt).getMonth(), 9);
  assert.equal(new Date(due.dueAt).getDate(), 31);
  assert.equal(new Date(due.dueAt).getHours(), 23);
  assert.equal(new Date(due.dueAt).getMinutes(), 59);
  const encoded = new Date(2026, 9, 31, 0, 0).toISOString();
  assert.deepEqual(todoDeadline({ dueDate: encoded }), due, 'Dooray also encodes local-midnight dates as ISO instants');
});

test('Dooray timed and missing deadlines preserve their meaning', () => {
  assert.deepEqual(todoDeadline({ deadline: '2026-10-31T02:00:00Z' }), { dueAt: Date.parse('2026-10-31T02:00:00Z'), dateOnly: false });
  assert.deepEqual(todoDeadline({}), { dueAt: null, dateOnly: false });
});
