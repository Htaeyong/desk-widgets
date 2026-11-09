// Alarm / timer sound (#130): the page's play plan, the user's sound files, the player, and ringing from the widget.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SP = require('../player/plan');
const SND = require('../sound');
const AM = require('../kit/alarm-model');
const TM = require('../kit/timer-model');
const { setup } = require('./fake-host');

const CHIME = path.join(__dirname, '..', 'sounds', 'chime.wav');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `clock-sound-${name}-`));
const dueAlarm = (over = {}) => ({ id: 's', hour: 0, minute: 0, name: '회의', days: [], on: true, since: null, snoozeUntil: Date.now() - 30 * 1000, ...over });
// Settings where these alarms ring as the widget starts (their snooze came due half a minute ago).
const ringing = (alarms, extra = {}) => ({ alarms, alarmCheckedAt: Date.now() - 60 * 1000, ...extra });
const ranOutTimer = () => ({ duration: 120000, startedAt: Date.now() - 200000, elapsed: 0, done: false });
const cardOf = (h, title) => h.notified.filter((n) => n.events[0].title === title).at(-1);

// ---- the page's plan ----
test('plan: repeat counts, "until stopped", and never past the longest time', () => {
  const until = 10_000;
  assert.equal(SP.again(1, 1, 0, until), false, 'once: done after the first end');
  assert.equal(SP.again(1, 3, 0, until), true);
  assert.equal(SP.again(2, 3, 0, until), true);
  assert.equal(SP.again(3, 3, 0, until), false, 'three times: done after the third end');
  assert.equal(SP.again(500, 0, 9_999, until), true, '0 = until stopped');
  assert.equal(SP.again(500, 0, until, until), false, 'until stopped still ends at the longest time');
  assert.equal(SP.again(1, 3, until + 1, until), false);
});

test('plan: read from the query string, odd values clamped', () => {
  const p = SP.readPlan('?src=file%3A%2F%2F%2FC%3A%2Fa.mp3&fallback=file%3A%2F%2F%2FC%3A%2Fchime.wav&repeat=3&volume=0.5&until=123');
  assert.deepEqual(p, { src: 'file:///C:/a.mp3', fallback: 'file:///C:/chime.wav', repeat: 3, volume: 0.5, until: 123 });
  const odd = SP.readPlan('?repeat=99&volume=7&until=x');
  assert.equal(odd.repeat, 1);
  assert.equal(odd.volume, 1);
  assert.equal(odd.until, 0, 'no time: the page plays nothing');
  assert.equal(SP.readPlan('?repeat=0').repeat, 0);
});

test('the default chime is a small PCM WAV shipped with the widget', () => {
  const buf = fs.readFileSync(CHIME);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.readUInt16LE(20), 1, 'PCM');
  assert.ok(buf.length < 150 * 1024, `${buf.length} bytes`);
});

// ---- settings values and files ----
test('alarm sound / repeat: defaults and sanitize', () => {
  const a = AM.sanitizeAlarm({ id: 'a', hour: 7, minute: 0 });
  assert.equal(a.sound, 'default');
  assert.equal(a.repeat, 0, 'until stopped');
  assert.equal(AM.sanitizeAlarm({ id: 'a', hour: 7, minute: 0, sound: '../x', repeat: 4 }).sound, 'default');
  assert.equal(AM.sanitizeAlarm({ id: 'a', hour: 7, minute: 0, repeat: 4 }).repeat, 0, 'only the offered counts');
  assert.equal(AM.sanitizeAlarm({ id: 'a', hour: 7, minute: 0, sound: 'none', repeat: 3 }).repeat, 3);
  assert.equal(AM.repeatText(0), '끌 때까지');
  assert.equal(AM.repeatText(3), '3번');
  assert.deepEqual(
    SND.sanitizeSounds([{ id: 'a1', name: ' 노래 ', file: 'a1.mp3' }, { id: 'default', file: 'x.mp3' }, { id: 'b', file: '..\\b.mp3' }, { id: 'a1', file: 'a1.mp3' }, { id: 'c', file: 'c.exe' }]),
    [{ id: 'a1', name: '노래', file: 'a1.mp3' }],
  );
  assert.equal(SND.sanitizeVolume(140), 100);
  assert.equal(SND.sanitizeMaxSeconds(61), 60);
});

test('files: a picked file is copied into the sounds folder; limits; removal deletes the copy', (t) => {
  const dir = tmp('lib');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, '아침 노래.mp3');
  fs.writeFileSync(src, 'not really mp3');
  const out = SND.addSoundFile(path.join(dir, 'sounds'), [], src, { makeId: () => 'abc' });
  assert.deepEqual(out, { ok: true, sound: { id: 'abc', name: '아침 노래', file: 'abc.mp3' } });
  assert.equal(fs.readFileSync(path.join(dir, 'sounds', 'abc.mp3'), 'utf8'), 'not really mp3');
  fs.rmSync(src);
  assert.ok(fs.existsSync(path.join(dir, 'sounds', 'abc.mp3')), 'the copy stays when the original goes');

  assert.match(SND.addSoundFile(dir, [], path.join(dir, 'a.exe')).message, /소리 파일/);
  assert.match(SND.addSoundFile(dir, [], path.join(dir, 'gone.mp3')).message, /읽을 수 없습니다/);
  const big = path.join(dir, 'big.wav');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, SND.MAX_FILE_BYTES + 1);
  assert.match(SND.addSoundFile(dir, [], big).message, /30MB/);
  const full = Array.from({ length: SND.MAX_SOUNDS }, (_, i) => ({ id: `s${i}`, name: 'x', file: `s${i}.mp3` }));
  assert.match(SND.addSoundFile(dir, full, big).message, /10개/);

  SND.removeSoundFile(path.join(dir, 'sounds'), out.sound);
  assert.equal(fs.existsSync(path.join(dir, 'sounds', 'abc.mp3')), false);
});

test('resolve: chime by default, nothing for 소리 없음, the chime when the file is gone', () => {
  const sounds = [{ id: 'mine', name: '노래', file: 'mine.mp3' }];
  const opts = (exists) => ({ sounds, dir: 'D', defaultFile: 'chime.wav', exists });
  assert.deepEqual(SND.resolveSound('default', opts(() => true)), { file: 'chime.wav', fallback: null, missing: false });
  assert.equal(SND.resolveSound('none', opts(() => true)), null);
  assert.deepEqual(SND.resolveSound('mine', opts(() => true)), { file: path.join('D', 'mine.mp3'), fallback: 'chime.wav', missing: false });
  assert.deepEqual(SND.resolveSound('mine', opts(() => false)), { file: 'chime.wav', fallback: null, missing: true });
  assert.deepEqual(SND.resolveSound('deleted', opts(() => true)), { file: 'chime.wav', fallback: null, missing: false });
});

// ---- player ----
test('player: one sound at a time; stop by key; the page ending by itself; the longest time as a backstop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const opened = [];
  const changes = [];
  const player = SND.createPlayer({
    open: (q) => {
      const fns = [];
      const win = { q, closed: false, close: () => { if (!win.closed) { win.closed = true; fns.forEach((f) => f()); } }, onClosed: (f) => fns.push(f) };
      opened.push(win);
      return win;
    },
    onChange: (key) => changes.push(key),
  });
  assert.equal(player.play({ key: 'alarm-a:1', file: 'a.mp3', fallback: 'chime.wav', repeat: 3, volume: 50, maxSeconds: 60 }), true);
  assert.deepEqual(opened[0].q, { file: 'a.mp3', fallback: 'chime.wav', repeat: 3, volume: 0.5, until: 1_060_000 });
  assert.equal(player.playing(), 'alarm-a:1');

  player.play({ key: 'timer:2', file: 'chime.wav', repeat: 0, maxSeconds: 30 });
  assert.equal(opened[0].closed, true, 'a newer ring replaces the older sound');
  assert.equal(player.stop('alarm-a:1'), false, 'the replaced ring cannot stop the new one');
  assert.equal(player.playing(), 'timer:2');
  assert.equal(player.stop('timer:2'), true);
  assert.equal(opened[1].closed, true);
  assert.equal(player.playing(), null);

  player.play({ key: 'k:3', file: 'chime.wav', repeat: 1, maxSeconds: 30 });
  opened[2].close(); // the page finished its repeats
  assert.equal(player.playing(), null);

  player.play({ key: 'k:4', file: 'chime.wav', repeat: 0, maxSeconds: 30 });
  t.mock.timers.tick(31_000);
  assert.equal(opened[3].closed, false);
  t.mock.timers.tick(1_500);
  assert.equal(opened[3].closed, true, 'closed by main if the page did not stop at its time');
  assert.equal(player.playing(), null);
  assert.deepEqual(changes, ['alarm-a:1', null, 'timer:2', null, 'k:3', null, 'k:4', null]);

  const broken = SND.createPlayer({ open: () => { throw new Error('no window'); } });
  assert.equal(broken.play({ key: 'x:1', file: 'chime.wav' }), false);
  assert.equal(broken.playing(), null);
});

// ---- ringing from the widget ----
test('an alarm rings with its own sound and repeat, at the settings\' volume and longest time', (t) => {
  const dir = tmp('ring');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sounds'));
  fs.writeFileSync(path.join(dir, 'sounds', 'mine.mp3'), 'x');
  const h = setup(
    ringing([dueAlarm({ sound: 'mine', repeat: 3 })], { sounds: [{ id: 'mine', name: '노래', file: 'mine.mp3' }], soundVolume: 40, soundMaxSeconds: 120 }),
    { dataDir: dir },
  );
  t.after(() => h.widget.stop());
  const [win] = h.sound.opened;
  assert.equal(win.query.file, path.join(dir, 'sounds', 'mine.mp3'));
  assert.equal(win.query.fallback, CHIME, 'a file Chromium cannot play falls back to the chime in the page');
  assert.equal(win.query.repeat, 3);
  assert.equal(win.query.volume, 0.4);
  assert.ok(Math.abs(win.query.until - (Date.now() + 120_000)) < 2000);
  assert.equal(cardOf(h, '알람').events[0].sound, false);
  assert.equal(h.lastEmitted('timers').ringing, true, 'the theme shows its stop button');
  win.finish();
  assert.equal(h.lastEmitted('timers').ringing, false);
});

test('a missing sound file rings the chime; 소리 없음 rings silently; no window -> the engine card beeps', (t) => {
  const gone = setup(ringing([dueAlarm({ sound: 'mine' })], { sounds: [{ id: 'mine', name: '노래', file: 'mine.mp3' }] }), { exists: () => false });
  t.after(() => gone.widget.stop());
  assert.equal(gone.sound.opened[0].query.file, CHIME);
  assert.equal(gone.sound.opened[0].query.fallback, null);

  const silent = setup(ringing([dueAlarm({ sound: 'none' })]));
  t.after(() => silent.widget.stop());
  assert.equal(silent.sound.opened.length, 0);
  assert.equal(cardOf(silent, '알람').events[0].sound, false, '소리 없음 means no sound at all');

  const broken = setup(ringing([dueAlarm()]), { soundOpen: () => { throw new Error('no window'); } });
  t.after(() => broken.widget.stop());
  assert.equal(cardOf(broken, '알람').events[0].sound, true, 'falls back to the engine card\'s short sound');
});

test('stopping: 끄기, 5분 뒤 다시, 확인/X (onClose), the theme\'s stop button, turning the widget off', (t) => {
  for (const how of ['off', 'snooze', 'close', 'theme', 'widget-stop', 'alarm-off', 'alarm-remove']) {
    const h = setup(ringing([dueAlarm()]));
    const [win] = h.sound.opened;
    assert.equal(win.closed, false, how);
    const { events, options } = cardOf(h, '알람');
    if (how === 'off' || how === 'snooze') options.onAction(events[0], how);
    else if (how === 'close') options.onClose(events[0]);
    else if (how === 'theme') h.call('sound.stop');
    else if (how === 'widget-stop') h.widget.stop();
    else if (how === 'alarm-off') h.call('alarms.toggle', 's', false);
    else h.call('alarms.remove', 's');
    assert.equal(win.closed, true, how);
    if (how !== 'widget-stop') h.widget.stop();
  }
});

test('the timer rings with the timer\'s sound; 다시 시작 / reset stop it; the card closing later does not stop a newer ring', (t) => {
  const h = setup({ timer: ranOutTimer(), timerSound: 'default', timerRepeat: 2 });
  t.after(() => h.widget.stop());
  const [first] = h.sound.opened;
  assert.equal(first.query.file, CHIME);
  assert.equal(first.query.repeat, 2);
  const card1 = cardOf(h, '타이머 종료');
  card1.options.onAction(card1.events[0], 'restart');
  assert.equal(first.closed, true);
  assert.equal(TM.tmStatus(h.getState().timer), 'running');

  // The timer runs out again: a new card with the same tag replaces the old one, whose onClose comes afterwards.
  h.call('timer.reset');
  h.widget.stop();
  const h2 = setup({ timer: ranOutTimer() });
  t.after(() => h2.widget.stop());
  const a = cardOf(h2, '타이머 종료');
  h2.call('timer.start', 60);
  assert.equal(h2.sound.opened[0].closed, true, 'starting the timer again stops its sound');
  // Two rings in a row: the first card's late onClose leaves the second sound playing.
  const h3 = setup(ringing([dueAlarm(), dueAlarm({ id: 't', name: '둘째' })]));
  t.after(() => h3.widget.stop());
  assert.equal(h3.sound.opened.length, 2, 'the second ring replaced the first sound');
  assert.equal(h3.sound.opened[0].closed, true);
  const firstCard = h3.notified.find((n) => n.events[0].tag === 'clock-alarm-s');
  firstCard.options.onClose(firstCard.events[0]);
  assert.equal(h3.sound.opened[1].closed, false, 'closing the older card leaves the newer sound');
  assert.ok(a);
});

test('alarms from the theme keep or set sound / repeat; MCP alarms get the default sound', async (t) => {
  const h = setup({ sounds: [{ id: 'mine', name: '노래', file: 'mine.mp3' }] }, { mcp: true });
  t.after(() => h.widget.stop());
  const timers = h.lastEmitted('timers') || (await h.call('getState')).result.timers;
  assert.deepEqual(timers.sounds.map((s) => s.id), ['default', 'mine', 'none']);
  assert.ok(!JSON.stringify(timers.sounds).includes('mine.mp3'), 'no file names or paths to themes');
  const add = await h.call('alarms.add', { hour: 7, minute: 0, name: '', days: [], sound: 'mine', repeat: 5 });
  assert.equal(add.ok, true);
  let a = h.getState().alarms[0];
  assert.equal(a.sound, 'mine');
  assert.equal(a.repeat, 5);
  await h.call('alarms.edit', a.id, { hour: 8, minute: 0, name: '', days: [] });
  a = h.getState().alarms[0];
  assert.deepEqual([a.hour, a.sound, a.repeat], [8, 'mine', 5], 'a theme without the sound fields keeps them');
  await h.call('alarms.edit', a.id, { hour: 8, minute: 0, name: '', days: [], sound: 'nope', repeat: 1 });
  assert.equal(h.getState().alarms[0].sound, 'default', 'an unknown sound becomes the chime');

  const tool = h.mcpTools().find((x) => x.name === 'add_alarm');
  await tool.run({ time: '09:30' });
  const m = h.getState().alarms.find((x) => x.hour === 9);
  assert.equal(m.sound, 'default');
  assert.equal(m.repeat, AM.DEFAULT_REPEAT);
});

// ---- settings window ----
test('settings: add / preview / remove a sound file, and save volume, longest time and the timer\'s sound', async (t) => {
  const dir = tmp('settings');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'pick.ogg');
  fs.writeFileSync(src, 'x');
  let picked = src;
  const dialog = { showOpenDialog: async () => (picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] }) };
  const h = setup({}, { dataDir: dir, dialog });
  t.after(() => h.widget.stop());
  const handlers = h.widget.settings.handlers;
  assert.equal(typeof handlers.themes, 'function', 'the engine theme section stays');

  const added = await handlers.addSound();
  assert.equal(added.ok, true);
  const id = added.added;
  assert.deepEqual(added.userSounds, [{ id, name: 'pick' }]);
  assert.ok(fs.existsSync(path.join(dir, 'sounds', `${id}.ogg`)));
  picked = null;
  assert.equal((await handlers.addSound()).added, null, 'cancel adds nothing');

  const prev = handlers.previewSound(id, 30);
  assert.deepEqual(prev, { ok: true, playing: true, missing: false });
  const pw = h.sound.opened.at(-1);
  assert.deepEqual([pw.query.repeat, pw.query.volume], [1, 0.3]);
  assert.equal(h.lastEmitted('timers').ringing, false, 'a preview is no ring: no stop button on the clock');
  assert.deepEqual(h.sentToSettings.at(-1), ['sound-playing', true]);
  handlers.stopPreview();
  assert.equal(pw.closed, true);
  assert.deepEqual(h.sentToSettings.at(-1), ['sound-playing', false]);
  assert.deepEqual(handlers.previewSound('none', 30), { ok: true, playing: false, missing: false });

  h.widget.settings.save({ showSeconds: false, soundVolume: 55, soundMaxSeconds: 300, timerSound: id, timerRepeat: 3 });
  let s = h.getState();
  assert.deepEqual([s.soundVolume, s.soundMaxSeconds, s.timerSound, s.timerRepeat], [55, 300, id, 3]);
  await h.call('alarms.add', { hour: 7, minute: 0, name: '', days: [], sound: id, repeat: 1 });

  const removed = handlers.removeSound(id);
  assert.equal(removed.ok, true);
  s = h.getState();
  assert.deepEqual(s.sounds, []);
  assert.equal(s.timerSound, 'default', 'the timer goes back to the chime');
  assert.equal(s.alarms[0].sound, 'default', 'so do alarms that used it');
  assert.equal(fs.existsSync(path.join(dir, 'sounds', `${id}.ogg`)), false);
  assert.equal(handlers.removeSound('gone').ok, false);
});

test('a preview never cuts off a ring', (t) => {
  const h = setup(ringing([dueAlarm()]));
  t.after(() => h.widget.stop());
  const res = h.widget.settings.handlers.previewSound('default', 50);
  assert.equal(res.ok, false);
  assert.equal(h.sound.opened.length, 1);
  assert.equal(h.sound.opened[0].closed, false);
});
