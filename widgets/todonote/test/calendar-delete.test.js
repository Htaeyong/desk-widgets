// Deleting a note whose due shows on the calendar (#128): the calendar is told right away, and the user chooses
// whether the deadline stays as an event in 내 캘린더. The copy comes first; without it the note stays.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { setup } = require('./fake-engine');

const SECRET = '은행 비밀번호 secret-text';

/** The engine's broker; `calendar` answers a keep request the way the calendar widget does (null: no answer). */
function broker({ capabilities = ['todo-calendar-view', 'note-keep-event'], running = true, peerEnabled = true, calendar = () => ({ ok: true }) } = {}) {
  const handlers = {};
  const published = [];
  return {
    handlers,
    published,
    keeps: () => published.filter(([, p]) => p?.keep).map(([, p]) => p.keep),
    changes: () => published.filter(([e, p]) => e === 'notes.changed' && !p?.keep).length,
    expose: (m, fn) => ((handlers[m] = fn), true),
    setEnabled: () => true,
    publish: (e, p) => {
      published.push([e, p]);
      if (p?.keep) {
        const answer = calendar(p.keep);
        if (answer) Promise.resolve().then(() => handlers['notes.snapshot']({ keepResult: { requestId: p.keep.requestId, ...answer } }, { sourceId: 'calendar' }));
      }
      return true;
    },
    status: () => ({ brokerAvailable: true, installed: true, running, peerEnabled, capabilities }),
    onStatus: () => () => {},
  };
}

async function start(t, b, { initial = { shareCalendar: true }, choose = 0, notes = () => {}, menus = [] } = {}) {
  const s = setup({ initial, integrations: b, menus });
  t.after(() => s.w.stop());
  s.asked = [];
  s.ctx.confirm = async (_win, opts) => (s.asked.push(opts), choose);
  s.writeNote('보고서', { id: 'due1', fm: ['due: 2026-12-01'], body: `${SECRET}\n` });
  notes(s);
  await s.w.start();
  return s;
}

const remove = (s, id = 'due1') => s.call(s.listWindow(), 'trash', { id });
const quiet = () => new Promise((r) => setTimeout(r, 350)); // the coalesced notes.changed of the start has gone out
const told = async (s, b, fn) => {
  await quiet();
  b.published.length = 0;
  await fn();
  assert.equal(await s.until(() => b.changes() > 0, 2000), true, 'the calendar is told');
};
const titles = async (b) => (await b.handlers['notes.snapshot']({}, { sourceId: 'calendar' })).result.tasks.map((x) => x.title);

test('the trash, the archive and back from the archive each tell the calendar right away', async (t) => {
  const b = broker();
  const s = await start(t, b, { notes: (x) => x.writeNote('보관', { id: 'due2', fm: ['due: 2026-12-02'] }) });
  await told(s, b, () => remove(s));
  assert.equal((await titles(b)).includes('보고서'), false);
  await told(s, b, () => s.call(s.listWindow(), 'archive', { id: 'due2' }));
  assert.deepEqual(await titles(b), []);
  await told(s, b, () => s.call(s.listWindow(), 'restore', { id: 'due2' }));
  assert.deepEqual(await titles(b), ['보관']);
  assert.equal(s.asked.length, 1, 'the archive asks nothing');
  assert.deepEqual(b.keeps(), []);
});

test('deleted outside or on another PC, and auto-deleted: nothing is asked or copied, the calendar is told', async (t) => {
  const b = broker();
  const s = await start(t, b, {
    initial: { shareCalendar: true, autoDeleteDays: 7 },
    notes: (x) => fs.utimesSync(x.writeNote('완료된', { id: 'old1', dir: `${x.notes}/완료`, fm: ['due: 2026-01-01', 'completed: 2026-01-02 10:00'] }), new Date(2026, 0, 2), new Date(2026, 0, 2)),
  });
  assert.equal(await s.until(() => s.trashed.length === 1, 2000), true, 'the completed one went by itself');
  await told(s, b, async () => {
    fs.rmSync(s.fileById('due1'));
    await s.call(s.listWindow(), 'refresh');
  });
  assert.deepEqual(await titles(b), []);
  assert.equal(s.asked.length, 0);
  assert.deepEqual(b.keeps(), []);
});

test('a note with a due on the calendar: three choices, cancel by default, and nothing happens on cancel', async (t) => {
  const b = broker();
  const s = await start(t, b, { choose: 2 });
  await remove(s);
  const [asked] = s.asked;
  assert.deepEqual(asked.buttons, ['일정도 지우기', '일정 유지', '취소']);
  assert.equal(asked.defaultId, 2);
  assert.equal(asked.cancelId, 2);
  assert.ok(s.fileById('due1'));
  assert.deepEqual(b.keeps(), []);
});

test('"일정도 지우기": the note goes to the trash, no copy, and the calendar is told', async (t) => {
  const b = broker();
  const s = await start(t, b, { choose: 0 });
  await told(s, b, () => remove(s));
  assert.equal(s.fileById('due1'), null);
  assert.equal(s.trashed.length, 1);
  assert.deepEqual(b.keeps(), []);
});

test('"일정 유지": the calendar copies the title and date, without the body, and only then the note goes', async (t) => {
  let whenAsked = null;
  let s = null;
  const b = broker({ calendar: () => ((whenAsked = s.fileById('due1')), { ok: true }) });
  s = await start(t, b, { choose: 1 });
  await remove(s);
  assert.ok(whenAsked, 'the note was still there while the calendar made the copy');
  assert.equal(s.fileById('due1'), null);
  const [keep] = b.keeps();
  assert.deepEqual(keep.task, { id: 'due1', title: '보고서', dueAt: new Date(2026, 11, 1, 23, 59).getTime(), dateOnly: true });
  assert.ok(!JSON.stringify(b.keeps()).includes(SECRET));
});

test('a failed copy keeps the note and says so', async (t) => {
  const b = broker({ calendar: () => ({ ok: false, message: '내 캘린더가 꺼져 있습니다.' }) });
  const s = await start(t, b, { choose: 1 });
  await remove(s);
  assert.ok(s.fileById('due1'));
  assert.equal(s.trashed.length, 0);
  const said = JSON.stringify(s.listWindow().sent);
  assert.ok(said.includes('일정을 복사하지 못해 노트를 지우지 않았습니다'), said);
  assert.ok(said.includes('내 캘린더가 꺼져 있습니다'), said);
});

test('no answer from the calendar: the note stays until there is one (stopping ends the wait)', async (t) => {
  const b = broker({ calendar: () => null });
  const s = await start(t, b, { choose: 1 });
  const pending = remove(s);
  assert.equal(await s.until(() => b.keeps().length === 1, 2000), true);
  assert.ok(s.fileById('due1'));
  s.w.stop();
  await pending;
  assert.ok(s.fileById('due1'));
  assert.equal(s.trashed.length, 0);
});

test('the copy is made but the note cannot go to the trash: it stays and the user hears both', async (t) => {
  const b = broker();
  const s = await start(t, b, { choose: 1 });
  s.electron.shell.trashItem = async () => { throw new Error('no recycle bin'); };
  await remove(s);
  assert.ok(s.fileById('due1'));
  assert.ok(JSON.stringify(s.listWindow().sent).includes('일정은 내 캘린더에 복사했지만'));
});

test('from the note window: a failure shows on that window and it stays open', async (t) => {
  const b = broker({ calendar: () => ({ ok: false, message: '실패' }) });
  const menus = [];
  const s = await start(t, b, { choose: 1, menus });
  await s.call(s.listWindow(), 'open', { id: 'due1' });
  await s.until(() => s.memoWindows().length === 1);
  const [win] = s.memoWindows();
  await s.call(win, 'init');
  await s.call(win, 'menu', {});
  await menus.at(-1).find((x) => x.label === '휴지통으로 옮기기…').click();
  assert.equal(await s.until(() => JSON.stringify(win.sent).includes('일정을 복사하지 못해'), 2000), true);
  assert.ok(s.fileById('due1'));
  assert.equal(s.memoWindows().length, 1);
  assert.equal(s.asked[0].buttons.length, 3);
});

test('from the note window: "일정도 지우기" closes the window and the note goes', async (t) => {
  const b = broker();
  const menus = [];
  const s = await start(t, b, { choose: 0, menus });
  await s.call(s.listWindow(), 'open', { id: 'due1' });
  await s.until(() => s.memoWindows().length === 1);
  const [win] = s.memoWindows();
  await s.call(win, 'init');
  await s.call(win, 'menu', {});
  await menus.at(-1).find((x) => x.label === '휴지통으로 옮기기…').click();
  assert.equal(await s.until(() => s.fileById('due1') === null, 2000), true);
  assert.equal(s.memoWindows().length, 0);
});

test('an empty new note with a due, closed: removed without asking, and the calendar is told', async (t) => {
  const b = broker();
  const s = await start(t, b);
  await s.call(s.listWindow(), 'new');
  await s.until(() => s.memoWindows().length === 1);
  const [win] = s.memoWindows();
  await s.call(win, 'init');
  await s.call(win, 'setDue', { due: '2026-12-24' });
  await told(s, b, () => s.call(win, 'close'));
  assert.equal(s.noteFiles().length, 1, 'only the first note is left');
  assert.equal(s.asked.length, 0);
  assert.deepEqual(b.keeps(), []);
});

test('a locked note: the copy has its plain title and date, nothing of the text', async (t) => {
  const b = broker();
  const s = await start(t, b, { choose: 1 });
  await s.call(s.listWindow(), 'open', { id: 'due1' });
  await s.until(() => s.memoWindows().length === 1);
  const [win] = s.memoWindows();
  await s.call(win, 'init');
  assert.equal((await s.call(win, 'lock', { password: 'pass-word-1' })).ok, true);
  await remove(s);
  assert.equal(s.fileById('due1'), null);
  assert.deepEqual(Object.keys(b.keeps()[0].task).sort(), ['dateOnly', 'dueAt', 'id', 'title']);
  assert.ok(!JSON.stringify(b.keeps()).includes(SECRET));
});

test('no way to copy: the two usual buttons and an explanation, never a keep request', async (t) => {
  for (const [opts, says] of [
    [{ running: false, peerEnabled: false }, '캘린더 위젯이 없거나 꺼져'],
    [{ peerEnabled: false }, '캘린더 위젯이 없거나 꺼져'],
    [{ capabilities: ['todo-calendar-view'] }, '캘린더 위젯을 업데이트'],
  ]) {
    const b = broker(opts);
    const s = await start(t, b);
    await remove(s);
    assert.deepEqual(s.asked[0].buttons, ['휴지통으로', '취소']);
    assert.match(s.asked[0].detail, new RegExp(says));
    assert.equal(s.fileById('due1'), null);
    assert.deepEqual(b.keeps(), []);
  }
});

test('nothing on the calendar: asked as before (sharing off, no due, completed)', async (t) => {
  const usual = '휴지통에서 되살릴 수 있습니다.';
  const off = await start(t, broker(), { initial: { shareCalendar: false } });
  await remove(off);
  assert.deepEqual(off.asked[0].buttons, ['휴지통으로', '취소']);
  assert.equal(off.asked[0].detail, usual);

  const b = broker();
  const on = await start(t, b, {
    notes: (x) => {
      x.writeNote('그냥', { id: 'plain' });
      x.writeNote('끝남', { id: 'done1', dir: `${x.notes}/완료`, fm: ['due: 2030-10-01', 'completed: 2030-10-02 10:00'] });
    },
  });
  await remove(on, 'plain');
  await remove(on, 'done1');
  assert.equal(on.asked.length, 2);
  for (const asked of on.asked) {
    assert.deepEqual(asked.buttons, ['휴지통으로', '취소']);
    assert.equal(asked.detail, usual);
  }
  assert.deepEqual(b.keeps(), []);
});

test('an engine without integrations: a note with a due is deleted as before', async (t) => {
  const s = setup({ initial: { shareCalendar: true } });
  t.after(() => s.w.stop());
  const asked = [];
  s.ctx.confirm = async (_win, opts) => (asked.push(opts), 0);
  s.writeNote('보고서', { id: 'due1', fm: ['due: 2026-12-01'] });
  await s.w.start();
  await remove(s);
  assert.deepEqual(asked[0].buttons, ['휴지통으로', '취소']);
  assert.equal(s.fileById('due1'), null);
});
