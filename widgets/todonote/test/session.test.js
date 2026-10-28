// Saving an open memo and outside changes (#75): debounced atomic saves, our own writes are not "outside" changes,
// an outside change reloads a clean window but becomes a choice when the window has unsaved edits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../lib/library');
const { MemoSession } = require('../lib/session');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A manual clock for the session's save timers: time moves only with tick(). */
function fakeClock() {
  let now = 1000;
  let timers = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const h = { at: now + ms, fn };
      timers.push(h);
      return h;
    },
    clearTimeout(h) {
      timers = timers.filter((x) => x !== h);
    },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers.sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

/** Waits (in real time, generously) until cond() holds: a file write takes as long as the disk needs. */
async function until(cond, what) {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(2);
  }
}

async function setup(body = '처음\n', clock = undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-session-'));
  let ids = {};
  const lib = new Library({ dir, ids: { load: () => ids, save: (m) => (ids = m) } });
  const m = await lib.create({ title: '노트', body });
  await lib.scan();
  const events = [];
  const s = new MemoSession({ library: lib, id: m.id, send: (name, p) => events.push([name, p]), debounceMs: 20, maxWaitMs: 80, retryMs: 30, clock });
  await s.load();
  const bodyOnDisk = () => fs.readFileSync(m.file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  // Another program writes the file (keeps our front matter like editors do).
  const outside = (text) => fs.writeFileSync(m.file, fs.readFileSync(m.file, 'utf8').replace(/(\n---\n)[\s\S]*$/, `$1${text}`));
  return { dir, lib, m, s, events, bodyOnDisk, outside };
}

test('typing is saved after a pause, at most maxWait later, as one atomic write', async () => {
  const clock = fakeClock();
  const { s, events, bodyOnDisk } = await setup('처음\n', clock);
  const saves = () => events.filter(([n]) => n === 'saved').length;
  s.markDirty();
  s.update('하나\n');
  s.update('하나 둘\n');
  clock.tick(19);
  await wait(20);
  assert.equal(bodyOnDisk(), '처음\n', 'not written before the pause (debounce 20)');
  assert.equal(saves(), 0);
  clock.tick(1);
  await until(() => saves() === 1, 'the save after the pause');
  assert.equal(bodyOnDisk(), '하나 둘\n');
  assert.equal(s.hasLocalEdits(), false);
  // Continuous typing (every 10 ms, never a 20 ms pause) is still saved at maxWait (80 ms) after it started.
  for (let n = 0; n < 8; n++) {
    s.update(`계속 ${n}\n`);
    clock.tick(10);
  }
  await until(() => saves() === 2, 'the save at maxWait');
  assert.equal(bodyOnDisk(), '계속 7\n');
});

test('our own write is not an outside change', async () => {
  const { s } = await setup();
  s.update('내가 씀\n');
  await s.flush();
  assert.equal(await s.external(), 'same');
});

test('an outside change reloads a window without unsaved edits', async () => {
  const { s, events, outside } = await setup();
  outside('VS Code에서 고침\n');
  assert.equal(await s.external(), 'reloaded');
  assert.deepEqual(events.pop(), ['reload', { body: 'VS Code에서 고침\n' }]);
  assert.equal(s.diskBody, 'VS Code에서 고침\n');
});

test('an outside change with unsaved edits is a conflict: nothing is overwritten until the user decides', async () => {
  const { s, events, outside, bodyOnDisk } = await setup();
  s.markDirty(); // typed, content not sent yet
  outside('바깥 내용\n');
  assert.equal(await s.external(), 'conflict');
  assert.deepEqual(events.pop(), ['conflict', {}]);
  s.update('내 내용\n');
  await wait(60);
  assert.equal(bodyOnDisk(), '바깥 내용\n', 'held during the conflict');
  // "mine": ours is written over it.
  await s.resolve('mine', '내 내용 최종\n');
  assert.equal(bodyOnDisk(), '내 내용 최종\n');
  assert.equal(s.conflict, null);
});

test('conflict answered "theirs" shows the outside version and drops ours', async () => {
  const { s, events, outside, bodyOnDisk } = await setup();
  s.update('내 것\n'); // pending, not written yet
  outside('남의 것\n');
  assert.equal(await s.external(), 'conflict');
  const r = await s.resolve('theirs', '내 것\n');
  assert.equal(r.body, '남의 것\n');
  assert.deepEqual(events.pop(), ['reload', { body: '남의 것\n' }]);
  await wait(60);
  assert.equal(bodyOnDisk(), '남의 것\n');
  assert.equal(s.hasLocalEdits(), false);
});

test('a save that would overwrite an outside change the watcher has not reported yet becomes a conflict (#108)', async () => {
  const clock = fakeClock();
  const { s, events, outside, bodyOnDisk } = await setup('처음\n', clock);
  s.update('내 것\n'); // save queued
  outside('남의 것\n'); // another program writes before the watcher fires
  clock.tick(20); // our debounced save runs first
  await until(() => events.some(([n]) => n === 'conflict'), 'the conflict');
  assert.equal(bodyOnDisk(), '남의 것\n', 'the outside version is not overwritten');
  assert.equal(events.some(([n]) => n === 'saved'), false);
  assert.equal(await s.external(), 'conflict');
  const r = await s.resolve('theirs', '내 것\n');
  assert.equal(r.body, '남의 것\n');
  assert.equal(bodyOnDisk(), '남의 것\n');
});

test('answering "theirs" while a save is still checking the disk never writes ours over theirs (#108)', async () => {
  const clock = fakeClock();
  const { s, lib, outside, bodyOnDisk } = await setup('처음\n', clock);
  // Hold the save's check of the disk (its library.read) until the user has answered.
  const read = lib.read.bind(lib);
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = false;
  s.update('내 것\n'); // save queued
  outside('남의 것\n'); // another program writes
  const reported = s.external(); // the folder watcher reports it first
  lib.read = async (id) => {
    if (!held && s.writing) {
      held = true;
      await gate;
    }
    return read(id);
  };
  clock.tick(20); // the debounced save starts and waits in its check
  assert.equal(await reported, 'conflict');
  const answered = s.resolve('theirs', '내 것\n');
  release();
  const r = await answered;
  await until(() => !s.writing, 'the save to settle');
  assert.equal(r.body, '남의 것\n');
  assert.equal(bodyOnDisk(), '남의 것\n', 'the outside version is kept');
  assert.equal(s.hasLocalEdits(), false);
});

test('conflict answered "copy" keeps ours in a new memo and shows theirs', async () => {
  const { s, lib, outside, bodyOnDisk } = await setup();
  s.markDirty();
  outside('남의 것\n');
  await s.external();
  const r = await s.resolve('copy', '내 것\n', { createCopy: async (text) => (await lib.create({ title: '노트 (내 사본)', body: text })).id });
  assert.ok(r.copyId);
  assert.equal((await lib.read(r.copyId)).body, '내 것\n');
  assert.equal(bodyOnDisk(), '남의 것\n');
});

test('a deleted file is reported; "mine" writes it again', async () => {
  const { s, lib, m, events } = await setup();
  fs.unlinkSync(m.file);
  await lib.scan();
  assert.equal(await s.external(), 'missing');
  assert.deepEqual(events.pop(), ['missing', {}]);
  // Typing while missing is kept, not written.
  s.update('살림\n');
  await wait(40);
  assert.ok(!fs.existsSync(m.file));
  lib.memos.set(m.id, m); // the window still knows its memo
  await s.resolve('mine', '살림\n');
  assert.match(fs.readFileSync(m.file, 'utf8'), /살림\n$/);
});

test('shutdown writes pending text synchronously; during a conflict it goes to a copy', async () => {
  const a = await setup();
  a.s.update('끄기 직전\n');
  assert.equal(a.s.flushSync(), true);
  assert.equal(a.bodyOnDisk(), '끄기 직전\n');

  const b = await setup();
  b.s.markDirty();
  b.outside('바깥\n');
  await b.s.external();
  b.s.update('내 마지막 글\n');
  assert.equal(b.s.flushSync(), true);
  assert.equal(b.bodyOnDisk(), '바깥\n');
  assert.equal(fs.readFileSync(path.join(b.dir, '노트 (내 사본).md'), 'utf8'), '내 마지막 글\n');
});

test('a failed save keeps the text, reports it and tries again', async () => {
  const clock = fakeClock();
  const { s, lib, events, bodyOnDisk } = await setup('처음\n', clock);
  const real = lib.write.bind(lib);
  let fail = 1;
  lib.write = async (id, body) => {
    if (fail-- > 0) {
      const err = new Error('locked');
      err.code = 'EBUSY';
      throw err;
    }
    return real(id, body);
  };
  s.update('잠겨도 남음\n');
  clock.tick(20); // debounce
  await until(() => events.some(([n]) => n === 'save-error'), 'the save error');
  assert.equal(events.find(([n]) => n === 'save-error')[1].message.includes('다른 프로그램'), true);
  assert.equal(bodyOnDisk(), '처음\n');
  clock.tick(30); // retryMs
  await until(() => events.some(([n]) => n === 'saved'), 'the retry');
  assert.equal(bodyOnDisk(), '잠겨도 남음\n');
});
