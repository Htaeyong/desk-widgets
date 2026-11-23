// #133: a password-locked note (#124) is "no note" to the AI assistant tools. The calendar still shows its due
// (the title and due are plain in the file), but list_events, upcoming_events, search_events and list_ddays leave
// it out. A 할 일 노트 that does not say whether a note is locked (before #133) is treated as locked there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../index');
const { DEFAULTS, sanitize } = require('../lib/settings');
const { withThemeHost } = require('./theme-host');
const { cleanTools } = require('../../../engine/main/mcp-host');
const { eventRef } = require('../lib/mcp-tools');

const NOW = new Date(2026, 9, 19, 9, 0).getTime(); // Mon 2026-10-19 09:00 local
const at = (d, h) => new Date(2026, 9, d, h, 0).getTime();

function setup(notes) {
  let state = sanitize({ ...DEFAULTS, localEnabled: true, ddayEnabled: true });
  let tools = null;
  const integrations = {
    status: (id) => (id === 'todonote' ? { installed: true, enabled: true, running: true, peerEnabled: true, brokerAvailable: true, capabilities: ['notes-calendar-share'] } : { installed: false, running: false, capabilities: [] }),
    setEnabled: () => true,
    onEvent: () => () => {},
    onStatus: () => () => {},
    call: async (id, method) => {
      if (method === 'notes.snapshot') return { ok: true, result: { tasks: notes.map((n) => ({ ...n })) } };
      throw new Error(method);
    },
  };
  const { ctx, th } = withThemeHost({
    dir: path.join(__dirname, '..'),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cal-lock-')),
    createStore: () => ({ load: () => state, save: (v) => { state = sanitize({ ...state, ...v }); } }),
    openExternal() {},
    sendToSettings() {},
    integrations,
    mcp: { registerTools: (list) => ((tools = list), true) },
  });
  const widget = create(ctx, { now: () => NOW });
  const call = async (name, input = {}) => cleanTools(tools).find((t) => t.name === name).run(input, { client: 'test' });
  return { widget, th, call };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const titles = (out) => out.data.items.map((i) => i.title);

const NOTES = [
  { id: 'open1', title: '공개 보고', dueAt: at(21, 15), dateOnly: false, completedAt: null, repeat: null, source: null, locked: false },
  { id: 'lock1', title: '비밀 마감', dueAt: at(22, 10), dateOnly: false, completedAt: null, repeat: null, source: null, locked: true },
];

test('#133 the calendar shows a locked note\'s due, the AI tools do not see it', async (t) => {
  const s = setup(NOTES);
  s.widget.start();
  t.after(() => s.widget.stop());
  await settle();
  const range = { from: new Date(2026, 9, 19).getTime(), to: new Date(2026, 9, 26).getTime() };
  const shown = (await s.th.call('events.list', [[range]]))[0].filter((e) => e.sourceId === 'todonote').map((e) => e.title);
  assert.deepEqual(shown.sort(), ['공개 보고', '비밀 마감'], 'the widget itself still shows both');

  const list = await s.call('list_events', { from: '2026-10-19', to: '2026-10-25' });
  assert.ok(titles(list).includes('공개 보고'));
  assert.ok(!JSON.stringify(list).includes('비밀 마감'), 'list_events');
  assert.ok(!JSON.stringify(list).includes('lock1'));
  const upcoming = await s.call('upcoming_events', { days: 7 });
  assert.ok(titles(upcoming).includes('공개 보고'));
  assert.ok(!JSON.stringify(upcoming).includes('비밀 마감'), 'upcoming_events');
  const search = await s.call('search_events', { query: '비밀' });
  assert.equal(search.data.items.length, 0, 'search_events');
  assert.equal(search.data.total, 0);
  await assert.rejects(s.call('update_event', { id: eventRef({ sourceId: 'todonote', calendarId: 'todonote', uid: 'todonote:lock1' }), title: 'x' }), /할 일 노트의 마감은/);
});

test('#133 a D-day linked to a locked note is left out of list_ddays', async (t) => {
  const s = setup(NOTES);
  s.widget.start();
  t.after(() => s.widget.stop());
  await settle();
  const link = (id) => ({ sourceId: 'todonote', calendarId: 'todonote', uid: `todonote:${id}` });
  assert.equal((await s.th.call('ddays.save', [{ title: '비밀 마감', date: '2026-10-22', link: link('lock1') }])).ok, true);
  assert.equal((await s.th.call('ddays.save', [{ title: '공개 보고', date: '2026-10-21', link: link('open1') }])).ok, true);
  assert.equal((await s.th.call('ddays.save', [{ title: '시험', date: '2026-10-31' }])).ok, true);
  const out = await s.call('list_ddays');
  assert.deepEqual(titles(out).sort(), ['공개 보고', '시험']);
  assert.ok(!JSON.stringify(out).includes('비밀 마감'));
});

test('#133 a 할 일 노트 that does not say "locked" (older version): its notes stay on the calendar, not in the AI tools', async (t) => {
  const old = NOTES.map(({ locked, ...n }) => n);
  const s = setup(old);
  s.widget.start();
  t.after(() => s.widget.stop());
  await settle();
  const range = { from: new Date(2026, 9, 19).getTime(), to: new Date(2026, 9, 26).getTime() };
  assert.equal((await s.th.call('events.list', [[range]]))[0].filter((e) => e.sourceId === 'todonote').length, 2);
  const list = await s.call('list_events', { from: '2026-10-19', to: '2026-10-25' });
  assert.equal(list.data.items.filter((i) => i.source_type === 'todonote').length, 0);
  assert.equal((await s.call('search_events', { query: '보고' })).data.items.length, 0);
  assert.equal((await s.th.call('ddays.save', [{ title: '공개 보고', date: '2026-10-21', link: { sourceId: 'todonote', calendarId: 'todonote', uid: 'todonote:open1' } }])).ok, true);
  assert.equal((await s.call('list_ddays')).data.items.length, 0);
});
