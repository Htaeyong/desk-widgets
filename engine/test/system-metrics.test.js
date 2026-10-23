const test = require('node:test');
const assert = require('node:assert/strict');
const { SystemMetrics, cpuTicks, cpuUsage } = require('../main/system-metrics');

test('CPU usage is derived from idle and total time deltas for each core', () => {
  const before = cpuTicks([{ times: { idle: 100, user: 100 } }, { times: { idle: 100, user: 100 } }]);
  const after = cpuTicks([{ times: { idle: 150, user: 150 } }, { times: { idle: 190, user: 110 } }]);
  const result = cpuUsage(before, after);
  assert.deepEqual(result.cores, [50, 10]);
  assert.equal(result.total, 30);
  assert.equal(cpuUsage(null, after), null);
});

test('sampler bounds history, reports disk capacity, and preserves missing native values as null', () => {
  let now = 1000;
  let ticks = 0;
  const service = new SystemMetrics({
    clock: () => now,
    system: {
      cpus: () => [{ times: { idle: ticks * 25, user: ticks * 75 } }],
      totalmem: () => 1000,
      freemem: () => 250,
      uptime: () => 30,
    },
    fileSystem: { statfsSync: () => ({ blocks: 100n, bsize: 10n, bavail: 40n }) },
    drives: () => ['C:\\'],
    power: () => null,
    counters: { read: () => ({ diskRead: null, diskWrite: null, networkDown: null, networkUp: null, gpu: null }), close() {} },
    historyMs: 10000,
  });
  service.read();
  ticks += 1;
  now += 2000;
  let sample = service.read();
  assert.equal(sample.cpu.percent, 75);
  assert.equal(sample.memory.percent, 75);
  assert.deepEqual(sample.disks[0], { drive: 'C:\\', total: 1000, free: 400, used: 600, percent: 60 });
  assert.equal(sample.network.downBytesPerSec, null);
  assert.equal(sample.gpu.percent, null);
  for (let i = 0; i < 8; i++) { ticks += 1; now += 2000; sample = service.read(); }
  assert.ok(sample.cpu.history.every((point) => now - point.at <= 10000));
  service.reset();
  assert.equal(service.read().cpu.percent, null);
});
