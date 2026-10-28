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

test('#111: "할 일에 추가" goes to the sticky notes when they can take it, else the old to-do widget', () => {
  const { todoTargetOf } = require('../todo-integration');
  const broker = (peers) => ({ status: (id) => peers[id] || { installed: false, capabilities: [] } });
  const notes = { installed: true, capabilities: ['notes-receive-external', 'notes.addExternal'] };
  const oldNotes = { installed: true, capabilities: [] }; // sticky notes 1.1.x: no due dates
  const todo = { installed: true, capabilities: ['todo-receive-external'] };
  assert.deepEqual(todoTargetOf(broker({ todonote: notes }), 'todonote'), { id: 'todonote', both: false });
  assert.deepEqual(todoTargetOf(broker({ todo }), 'todonote'), { id: 'todo', both: false });
  assert.deepEqual(todoTargetOf(broker({ todonote: oldNotes, todo }), 'todonote'), { id: 'todo', both: false });
  assert.deepEqual(todoTargetOf(broker({ todonote: notes, todo }), 'todonote'), { id: 'todonote', both: true });
  assert.deepEqual(todoTargetOf(broker({ todonote: notes, todo }), 'todo'), { id: 'todo', both: true });
  assert.deepEqual(todoTargetOf(undefined, 'todonote'), { id: 'todo', both: false }, 'an engine without integrations');
});

test('#111: with both installed, the chosen widget unless only the other one is running', () => {
  const { todoTargetOf } = require('../todo-integration');
  const broker = (peers) => ({ status: (id) => peers[id] || { installed: false, capabilities: [] } });
  const notes = (running) => ({ installed: true, running, capabilities: ['notes-receive-external'] });
  const todo = (running) => ({ installed: true, running, capabilities: ['todo-receive-external'] });
  assert.equal(todoTargetOf(broker({ todonote: notes(false), todo: todo(true) }), 'todonote').id, 'todo', 'the default is off, the to-do list runs');
  assert.equal(todoTargetOf(broker({ todonote: notes(true), todo: todo(false) }), 'todo').id, 'todonote');
  assert.equal(todoTargetOf(broker({ todonote: notes(false), todo: todo(false) }), 'todo').id, 'todo', 'neither runs: the choice, so its message says what to do');
  assert.equal(todoTargetOf(broker({ todonote: notes(true), todo: todo(true), memo: { installed: true, capabilities: [] } }), 'todonote').id, 'todonote', 'the sticky notes are never a target');
});
