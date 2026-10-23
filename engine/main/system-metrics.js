// Shared system measurements for widgets. Native Windows calls stay in the engine.
const os = require('os');
const fs = require('fs');

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_HISTORY_MS = 60000;
const PDH_FMT_DOUBLE = 0x200;
const PDH_MORE_DATA = 0x800007d2;

function cpuTicks(cpus) {
  return cpus.map(({ times }) => {
    const total = Object.values(times).reduce((sum, value) => sum + value, 0);
    return { idle: times.idle, total };
  });
}

function cpuUsage(before, after) {
  if (!before || before.length !== after.length) return null;
  const cores = after.map((item, index) => {
    const total = item.total - before[index].total;
    const idle = item.idle - before[index].idle;
    return total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : null;
  });
  const valid = cores.filter(Number.isFinite);
  return { total: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null, cores };
}

function loadPowerStatus() {
  if (process.platform !== 'win32') return () => null;
  try {
    const koffi = require('koffi');
    const kernel = koffi.load('kernel32.dll');
    const STATUS = koffi.struct('DW_SYSTEM_POWER_STATUS', {
      acLineStatus: 'uint8', batteryFlag: 'uint8', batteryLifePercent: 'uint8', systemStatusFlag: 'uint8',
      batteryLifeTime: 'uint32', batteryFullLifeTime: 'uint32',
    });
    const getStatus = kernel.func('bool __stdcall GetSystemPowerStatus(_Out_ DW_SYSTEM_POWER_STATUS *status)');
    return () => {
      const status = {};
      if (!getStatus(status) || status.batteryLifePercent === 255 || (status.batteryFlag & 128)) return null;
      return { percent: status.batteryLifePercent, charging: status.acLineStatus === 1 };
    };
  } catch {
    return () => null;
  }
}

function loadDriveMask() {
  if (process.platform !== 'win32') return () => [];
  try {
    const kernel = require('koffi').load('kernel32.dll');
    const getMask = kernel.func('uint32 __stdcall GetLogicalDrives()');
    const getType = kernel.func('uint32 __stdcall GetDriveTypeW(str16 root)');
    return () => {
      const mask = getMask();
      return Array.from({ length: 26 }, (_, i) => i)
        .filter((i) => mask & (1 << i))
        .map((i) => String.fromCharCode(65 + i) + ':\\')
        .filter((root) => [2, 3].includes(getType(root)));
    };
  } catch {
    return () => [];
  }
}

class WindowsCounters {
  constructor() {
    this.query = null;
    this.counters = {};
    if (process.platform !== 'win32') return;
    try {
      this.koffi = require('koffi');
      const pdh = this.koffi.load('pdh.dll');
      this.Value = this.koffi.struct('DW_PDH_VALUE', { status: 'uint32', value: 'double' });
      this.Item = this.koffi.struct('DW_PDH_ITEM', { name: 'str16', value: this.Value });
      this.openQuery = pdh.func('uint32 __stdcall PdhOpenQueryW(str16 source, intptr userData, _Out_ intptr *query)');
      this.addCounter = pdh.func('uint32 __stdcall PdhAddEnglishCounterW(intptr query, str16 path, intptr userData, _Out_ intptr *counter)');
      this.collect = pdh.func('uint32 __stdcall PdhCollectQueryData(intptr query)');
      this.getValue = pdh.func('uint32 __stdcall PdhGetFormattedCounterValue(intptr counter, uint32 format, _Out_ uint32 *type, _Out_ DW_PDH_VALUE *value)');
      this.getArray = pdh.func('uint32 __stdcall PdhGetFormattedCounterArrayW(intptr counter, uint32 format, _Inout_ uint32 *bytes, _Out_ uint32 *count, _Out_ uint8 *items)');
      this.closeQuery = pdh.func('uint32 __stdcall PdhCloseQuery(intptr query)');
      const query = [null];
      if (this.openQuery(null, 0, query) !== 0) return;
      this.query = query[0];
      const paths = {
        diskRead: '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
        diskWrite: '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec',
        networkDown: '\\Network Interface(*)\\Bytes Received/sec',
        networkUp: '\\Network Interface(*)\\Bytes Sent/sec',
        gpu: '\\GPU Engine(*)\\Utilization Percentage',
      };
      for (const [name, path] of Object.entries(paths)) {
        const counter = [null];
        if (this.addCounter(this.query, path, 0, counter) === 0) this.counters[name] = counter[0];
      }
      this.collect(this.query);
    } catch {
      this.close();
    }
  }

  scalar(counter) {
    if (!counter) return null;
    try {
      const value = {};
      if (this.getValue(counter, PDH_FMT_DOUBLE, [0], value) !== 0 || value.status !== 0) return null;
      return Number.isFinite(value.value) ? Math.max(0, value.value) : null;
    } catch {
      return null;
    }
  }

  array(counter, aggregate = 'sum') {
    if (!counter) return null;
    try {
      const bytes = [0];
      const count = [0];
      const first = this.getArray(counter, PDH_FMT_DOUBLE, bytes, count, null);
      if (first !== PDH_MORE_DATA || bytes[0] <= 0 || bytes[0] > 1024 * 1024) return null;
      const buffer = Buffer.alloc(bytes[0]);
      if (this.getArray(counter, PDH_FMT_DOUBLE, bytes, count, buffer) !== 0) return null;
      const items = this.koffi.decode(buffer, this.Item, count[0]);
      const valid = items.filter((item) => item.value.status === 0 && Number.isFinite(item.value.value));
      if (!valid.length) return null;
      if (aggregate === 'gpu') {
        // Each engine type can include several processes; sum processes within a type and use the busiest type.
        const byType = new Map();
        for (const item of valid) {
          const type = /_engtype_([^)]*)$/i.exec(String(item.name || ''))?.[1] || String(item.name || '');
          byType.set(type, (byType.get(type) || 0) + Math.max(0, item.value.value));
        }
        return Math.max(...byType.values());
      }
      return valid.reduce((sum, item) => sum + Math.max(0, item.value.value), 0);
    } catch {
      return null;
    }
  }

  read() {
    if (!this.query || this.collect(this.query) !== 0) return { diskRead: null, diskWrite: null, networkDown: null, networkUp: null, gpu: null };
    return {
      diskRead: this.scalar(this.counters.diskRead),
      diskWrite: this.scalar(this.counters.diskWrite),
      networkDown: this.array(this.counters.networkDown),
      networkUp: this.array(this.counters.networkUp),
      gpu: this.array(this.counters.gpu, 'gpu'),
    };
  }

  close() {
    if (this.query && this.closeQuery) this.closeQuery(this.query);
    this.query = null;
  }
}

class SystemMetrics {
  constructor({ intervalMs = DEFAULT_INTERVAL_MS, historyMs = DEFAULT_HISTORY_MS, clock = Date.now, system = os, fileSystem = fs, counters = new WindowsCounters(), power = loadPowerStatus(), drives = loadDriveMask() } = {}) {
    this.intervalMs = Math.max(1000, Math.min(10000, intervalMs));
    this.historyMs = Math.max(10000, Math.min(300000, historyMs));
    this.clock = clock;
    this.system = system;
    this.fs = fileSystem;
    this.counters = counters;
    this.power = power;
    this.drives = drives;
    this.lastCpus = null;
    this.history = [];
    this.lastDrives = [];
    this.drivesAt = 0;
  }

  read() {
    const now = this.clock();
    const nextCpus = cpuTicks(this.system.cpus());
    const cpu = cpuUsage(this.lastCpus, nextCpus);
    this.lastCpus = nextCpus;
    if (cpu?.total !== null && cpu) this.history.push({ at: now, percent: cpu.total });
    this.history = this.history.filter((point) => now - point.at <= this.historyMs);
    if (!this.drivesAt || now - this.drivesAt >= 60000) {
      this.lastDrives = this.drives();
      this.drivesAt = now;
    }
    const disks = this.lastDrives.map((drive) => {
      try {
        const stat = this.fs.statfsSync(drive, { bigint: true });
        const total = Number(stat.blocks * stat.bsize);
        const free = Number(stat.bavail * stat.bsize);
        return { drive, total, free, used: Math.max(0, total - free), percent: total ? (total - free) / total * 100 : null };
      } catch {
        return { drive, total: null, free: null, used: null, percent: null };
      }
    });
    const native = this.counters.read();
    const total = this.system.totalmem();
    const free = this.system.freemem();
    return {
      at: now,
      intervalMs: this.intervalMs,
      cpu: { percent: cpu?.total ?? null, cores: cpu?.cores ?? [], history: [...this.history] },
      memory: { total, free, used: Math.max(0, total - free), percent: total ? (total - free) / total * 100 : null },
      disks,
      diskIo: { readBytesPerSec: native.diskRead, writeBytesPerSec: native.diskWrite },
      network: { downBytesPerSec: native.networkDown, upBytesPerSec: native.networkUp },
      gpu: { percent: native.gpu === null ? null : Math.min(100, native.gpu) },
      battery: this.power(),
      uptimeSeconds: this.system.uptime(),
    };
  }

  reset() {
    this.lastCpus = null;
    this.history = [];
  }

  close() {
    this.counters.close?.();
  }
}

module.exports = { SystemMetrics, WindowsCounters, cpuTicks, cpuUsage, DEFAULT_INTERVAL_MS, DEFAULT_HISTORY_MS };
