// "AI 도우미 연결 (MCP)" tools of the clock (#121): what they read, that writes go through the alarm / timer tab
// paths (stored, scheduled, sent to the themes), refusals, undo, and that no tool deletes an alarm.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkInput, cleanTools } = require('../../../engine/main/mcp-host');
const AM = require('../kit/alarm-model');
const TM = require('../kit/timer-model');
const { setup } = require('./fake-host');

// Local wall-clock times. 2026-10-19 is a Monday.
const at = (day, h, m = 0, s = 0) => new Date(2026, 9, day, h, m, s, 0).getTime();
const alarm = (over = {}) => ({ id: 'a1', hour: 7, minute: 30, name: '기상', days: [1, 2, 3, 4, 5], on: true, snoozeUntil: null, since: null, ...over });

/** A started clock at a fixed fake time (Date and setTimeout mocked); `tool(name)(input)` runs a tool like the engine. */
function withClock(t, initial = {}, { now = at(19, 6) } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const h = setup(initial, { mcp: true });
  t.after(() => h.widget.stop());
  const tools = h.mcpTools();
  const tool = (name) => (input = {}) => {
    const spec = tools.find((x) => x.name === name);
    // The engine checks the input against the schema before the widget sees it.
    const bad = checkInput(spec.inputSchema, input);
    if (bad) throw new Error(bad);
    return spec.run(input, { client: 'test', connection: 1 });
  };
  return { ...h, tools, tool };
}

test('the clock declares 2 read and 3 write tools, none deletes; schemas are closed and survive the engine clean-up', (t) => {
  const { tools } = withClock(t);
  assert.deepEqual(tools.map((x) => x.name), ['list_alarms', 'get_timers', 'add_alarm', 'set_alarm_enabled', 'start_timer']);
  assert.deepEqual(tools.filter((x) => x.write).map((x) => x.name), ['add_alarm', 'set_alarm_enabled', 'start_timer']);
  assert.deepEqual(tools.filter((x) => x.idempotent).map((x) => x.name), ['set_alarm_enabled']);
  assert.ok(!tools.some((x) => /delete|remove|trash|clear|stopwatch|setting|theme/.test(x.name)));
  for (const x of tools) {
    assert.equal(x.inputSchema.type, 'object', x.name);
    assert.equal(x.inputSchema.additionalProperties, false, x.name);
    assert.match(x.title, /[가-힣]/, x.name);
  }
  assert.equal(cleanTools(tools).length, tools.length, 'all names and schemas are accepted by the engine');
});

test('without ctx.mcp (engine before API 1.10) the clock starts as before', (t) => {
  const h = setup();
  t.after(() => h.widget.stop());
  assert.equal(h.mcpTools(), null);
  assert.equal(h.calls.open, 1);
});

test('list_alarms: time, days, repeat text, enabled, next ring and "now"', async (t) => {
  const { tool } = withClock(t, { alarms: [alarm(), alarm({ id: 'b2', hour: 22, minute: 5, name: '', days: [], on: false }), alarm({ id: 'c3', hour: 6, minute: 30, days: [0, 6] })] });
  const data = (await tool('list_alarms')()).data;
  assert.equal(data.now, '2026-10-19 06:00');
  assert.equal(data.max_alarms, 20);
  assert.deepEqual(data.alarms[0], {
    id: 'a1', time: '07:30', name: '기상', days: ['mon', 'tue', 'wed', 'thu', 'fri'], repeat: '평일', enabled: true, snoozed_until: null, next: '2026-10-19 07:30',
  });
  assert.deepEqual([data.alarms[1].time, data.alarms[1].repeat, data.alarms[1].enabled, data.alarms[1].next], ['22:05', '한 번', false, null]);
  assert.deepEqual([data.alarms[2].repeat, data.alarms[2].next], ['주말', '2026-10-24 06:30']);
  assert.ok(JSON.stringify(data).length < 12000);
  // Input is closed: unknown fields are refused by the engine check.
  assert.throws(() => tool('list_alarms')({ x: 1 }), /알 수 없는 입력/);
});

test('get_timers: timer status, duration, remaining, end; stopwatch elapsed', async (t) => {
  const now = at(19, 6);
  const { tool, call } = withClock(t, { timer: { duration: 300000, startedAt: now - 60000, elapsed: 0, done: false }, stopwatch: { startedAt: now - 5000, elapsed: 2500 } });
  const data = (await tool('get_timers')()).data;
  assert.equal(data.now, '2026-10-19 06:00');
  assert.deepEqual(data.timer, {
    status: 'running', duration_seconds: 300, duration_text: '5분', remaining_seconds: 240, remaining_text: '04:00', ends_at: '2026-10-19 06:04', set_seconds: 300,
  });
  assert.deepEqual(data.stopwatch, { status: 'running', elapsed_seconds: 7, elapsed_text: '00:07.50' });
  await call('timer.pause');
  await call('stopwatch.reset');
  const after = (await tool('get_timers')()).data;
  assert.deepEqual([after.timer.status, after.timer.ends_at, after.timer.remaining_seconds], ['paused', null, 240]);
  assert.equal(after.stopwatch.status, 'idle');
});

test('add_alarm is stored, sent to the themes and scheduled like an alarm added in the alarm tab; it rings', async (t) => {
  const { tool, call, getState, lastEmitted, notified } = withClock(t);
  const r = await tool('add_alarm')({ time: '6:01', days: [], name: '물 마시기' });
  assert.match(r.summary, /알람 추가: 06:01 물 마시기 \(한 번\)/);
  assert.equal(typeof r.undo, 'function');
  assert.equal(typeof r.open, 'function');
  assert.equal(r.data.now, '2026-10-19 06:00');
  assert.equal(r.data.alarm.next, '2026-10-19 06:01');
  const [a] = getState().alarms;
  assert.equal(a.id, r.data.alarm.id);
  // The same fields the tab's add produces.
  const ui = await call('alarms.add', { hour: 6, minute: 1, name: '물 마시기', days: [] });
  const b = getState().alarms.find((x) => x.id === ui.id);
  const strip = ({ id: _id, ...rest }) => rest;
  assert.deepEqual(strip(a), strip(b));
  assert.equal(lastEmitted('timers').alarms.length, 2);
  // Scheduled: a minute later it rings with the usual card, and the one-time alarm turns off.
  t.mock.timers.tick(61 * 1000);
  const rings = notified.filter((n) => n.events[0].title === '알람');
  assert.ok(rings.some((n) => n.events[0].tag === `clock-alarm-${a.id}`));
  assert.equal(getState().alarms.find((x) => x.id === a.id).on, false);
});

test('add_alarm: repeat days, bad time / day refused, name capped, the 20-alarm limit', async (t) => {
  const { tool, getState } = withClock(t);
  const r = await tool('add_alarm')({ time: '07:30', days: ['fri', 'mon', 'mon'] });
  assert.deepEqual(r.data.alarm.days, ['mon', 'fri']);
  assert.equal(r.data.alarm.repeat, '월·금');
  assert.equal(r.data.alarm.next, '2026-10-19 07:30');
  for (const time of ['24:00', '7:60', '0730', 'x:y', '7']) {
    await assert.rejects(async () => tool('add_alarm')({ time }), /HH:mm|짧습니다/, time);
  }
  await assert.rejects(async () => tool('add_alarm')({ time: '07:00', days: ['monday'] }), /요일/);
  assert.throws(() => tool('add_alarm')({ time: '07:00', name: 'ㄱ'.repeat(21) }), /너무 깁니다/);
  assert.throws(() => tool('add_alarm')({}), /"time" 값이 필요합니다/);
  assert.equal(getState().alarms.length, 1);
  const full = Array.from({ length: AM.MAX_ALARMS }, (_, i) => alarm({ id: `z${i}` }));
  // A second clock, already full.
  t.mock.timers.reset();
  const h2 = withClock(t, { alarms: full });
  await assert.rejects(async () => h2.tool('add_alarm')({ time: '08:00' }), /20개까지/);
  assert.equal(h2.getState().alarms.length, 20);
});

test('add_alarm undo turns the new alarm off (never deletes it)', async (t) => {
  const { tool, getState } = withClock(t);
  const r = await tool('add_alarm')({ time: '08:00', name: '회의' });
  await r.undo();
  const a = getState().alarms.find((x) => x.id === r.data.alarm.id);
  assert.ok(a, 'still there');
  assert.equal(a.on, false);
  assert.equal(AM.nextDue(a, Date.now()), null);
});

test('set_alarm_enabled: off and on through the tab\'s toggle, unchanged when already so, undo puts it back', async (t) => {
  const { tool, getState, lastEmitted } = withClock(t, { alarms: [alarm({ snoozeUntil: at(19, 6, 3) })] });
  const off = await tool('set_alarm_enabled')({ id: 'a1', enabled: false });
  assert.equal(off.summary, '알람 끔: 07:30 기상');
  assert.equal(off.data.alarm.enabled, false);
  assert.equal(getState().alarms[0].on, false);
  assert.equal(getState().alarms[0].snoozeUntil, null, 'turning off drops a snooze, like the tab');
  assert.equal(lastEmitted('timers').alarms[0].on, false);
  const same = await tool('set_alarm_enabled')({ id: 'a1', enabled: false });
  assert.equal(same.unchanged, true);
  assert.equal(same.data.changed, false);
  assert.equal(same.summary, undefined);
  await off.undo();
  assert.equal(getState().alarms[0].on, true);
  assert.equal(getState().alarms[0].since, Date.now());
  const on = await tool('set_alarm_enabled')({ id: 'a1', enabled: true });
  assert.equal(on.unchanged, true);
  await assert.rejects(async () => tool('set_alarm_enabled')({ id: 'nope', enabled: true }), /없는 알람/);
  assert.throws(() => tool('set_alarm_enabled')({ id: 'a1' }), /"enabled" 값이 필요합니다/);
});

test('start_timer starts it like the timer tab, refuses while running, replaces a paused one; it rings at the end', async (t) => {
  const { tool, call, getState, notified } = withClock(t, { timerSeconds: 300 });
  const r = await tool('start_timer')({ minutes: 1, seconds: 30 });
  assert.equal(r.summary, '타이머 시작: 1분 30초 (2026-10-19 06:01 종료)');
  assert.deepEqual([r.data.timer.status, r.data.timer.duration_seconds, r.data.timer.ends_at], ['running', 90, '2026-10-19 06:01']);
  assert.equal(TM.tmStatus(getState().timer), 'running');
  assert.equal(getState().timerSeconds, 90, 'the set time follows, like the tab');
  await assert.rejects(async () => tool('start_timer')({ minutes: 5 }), /이미 타이머가 돌고 있습니다/);
  assert.equal(getState().timer.duration, 90000);
  t.mock.timers.tick(90 * 1000);
  assert.ok(notified.some((n) => n.events[0].title === '타이머 종료'));
  assert.equal(TM.tmStatus(getState().timer), 'done');
  // A paused timer is replaced (not resumed with its old time).
  await call('timer.start', 600);
  t.mock.timers.tick(10 * 1000);
  await call('timer.pause');
  const r2 = await tool('start_timer')({ seconds: 20 });
  assert.equal(getState().timer.duration, 20000);
  assert.equal(TM.tmRemaining(getState().timer, Date.now()), 20000);
  assert.equal(r2.data.timer.remaining_seconds, 20);
});

test('start_timer bounds: nothing or 0 refused, 1439:59 is the most', async (t) => {
  const { tool, getState } = withClock(t);
  await assert.rejects(async () => tool('start_timer')({}), /1초부터/);
  await assert.rejects(async () => tool('start_timer')({ minutes: 0, seconds: 0 }), /1초부터/);
  assert.throws(() => tool('start_timer')({ seconds: 60 }), /59 이하/);
  assert.throws(() => tool('start_timer')({ minutes: 1440 }), /1439 이하/);
  assert.equal(TM.tmStatus(getState().timer), 'idle');
  await tool('start_timer')({ minutes: 1439, seconds: 59 });
  assert.equal(getState().timer.duration, TM.MAX_SECONDS * 1000);
});

test('start_timer undo restores the previous timer; refused once the timer was changed since', async (t) => {
  const { tool, call, getState } = withClock(t, { timerSeconds: 300 });
  await call('timer.start', 600);
  t.mock.timers.tick(60 * 1000);
  await call('timer.pause');
  const paused = getState().timer;
  const r = await tool('start_timer')({ minutes: 2 });
  await r.undo();
  assert.deepEqual(getState().timer, paused);
  assert.equal(getState().timerSeconds, 600);
  assert.equal(TM.tmStatus(getState().timer), 'paused');
  // Changed in the widget after the tool started it: undo leaves it alone.
  await call('timer.reset');
  const r2 = await tool('start_timer')({ minutes: 3 });
  t.mock.timers.tick(5 * 1000);
  await call('timer.pause');
  await assert.rejects(r2.undo, /바뀌어 되돌리지 않았습니다/);
  assert.equal(TM.tmStatus(getState().timer), 'paused');
  assert.equal(getState().timer.duration, 180000);
});

test('writes are refused once the widget is stopped', async (t) => {
  const { tool, widget } = withClock(t);
  widget.stop();
  await assert.rejects(async () => tool('add_alarm')({ time: '07:00' }), /꺼져 있습니다/);
  await assert.rejects(async () => tool('start_timer')({ minutes: 1 }), /꺼져 있습니다/);
});
