const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PresenceMonitor } = require('../../../engine/main/presence');
const { DashboardService } = require('../backend/service');
const { CategoryStore } = require('../backend/categories');

function fakePower(idleSeconds = 0) {
  const power = new EventEmitter();
  power.idle = idleSeconds;
  power.getSystemIdleTime = () => power.idle;
  return power;
}

test('presence: lock, suspend and idle produce pause reasons', () => {
  const power = fakePower();
  const monitor = new PresenceMonitor({ powerMonitor: power, getIdleMinutes: () => 5 });
  const seen = [];
  monitor.on('change', (r) => seen.push(r));
  monitor.start();
  monitor.stop(); // drive checks manually

  power.emit('lock-screen');
  power.emit('unlock-screen');
  power.emit('suspend');
  power.emit('resume');

  power.idle = 299;
  monitor.checkIdle();
  power.idle = 300;
  monitor.checkIdle();
  power.idle = 2;
  monitor.checkIdle();

  assert.deepEqual(seen, ['locked', null, 'suspended', null, 'idle', null]);
});

test('presence: lock wins over idle, and idle detection can be disabled', () => {
  const power = fakePower(10000);
  let minutes = 0;
  const monitor = new PresenceMonitor({ powerMonitor: power, getIdleMinutes: () => minutes });
  const seen = [];
  monitor.on('change', (r) => seen.push(r));
  monitor.checkIdle(); // disabled: no change
  minutes = 5;
  monitor.checkIdle(); // idle
  monitor.set({ locked: true });
  monitor.set({ locked: false, idle: false });
  assert.deepEqual(seen, ['idle', 'locked', null]);
});

test('service: no polling while paused, immediate refresh on return', async () => {
  const store = new CategoryStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'svc-')), 'c.json'));
  const settings = { pollIntervalSec: 45, dueSoonDays: 3, hiddenProjectIds: [] };
  const svc = new DashboardService({ getSettings: () => settings, isConfigured: () => true, categories: store, useMock: true });

  await svc.refresh();
  assert.ok(svc.timer, 'next refresh scheduled');
  const firstSuccess = svc.getSnapshot().status.lastSuccessAt;

  svc.setPaused('locked');
  assert.equal(svc.timer, null, 'timer cleared while paused');
  assert.equal(svc.getSnapshot().status.paused, true);
  assert.equal(svc.getSnapshot().status.pausedReason, 'locked');
  assert.equal(svc.getSnapshot().status.nextRefreshAt, null);

  // A manual refresh while paused works but does not schedule another one.
  await svc.refresh();
  assert.equal(svc.timer, null);

  await new Promise((r) => setTimeout(r, 5));
  svc.setPaused(null);
  await svc.inFlight;
  const snap = svc.getSnapshot();
  assert.equal(snap.status.paused, false);
  assert.ok(snap.status.lastSuccessAt > firstSuccess, 'refreshed on return');
  assert.ok(svc.timer, 'polling resumed');
  svc.stop();
});
