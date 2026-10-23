// Detects when the user is away so polling can stop: screen locked, system suspended,
// or no keyboard/mouse input for a while. Emits 'change' with the pause reason or null.
const { EventEmitter } = require('events');

const CHECK_INTERVAL_MS = 3000;

class PresenceMonitor extends EventEmitter {
  /**
   * @param {{ powerMonitor?: Electron.PowerMonitor, getIdleMinutes: () => number }} opts
   *   getIdleMinutes returns the away threshold in minutes; 0 disables idle detection.
   */
  constructor({ powerMonitor, getIdleMinutes }) {
    super();
    this.power = powerMonitor || require('electron').powerMonitor;
    this.getIdleMinutes = getIdleMinutes;
    this.locked = false;
    this.suspended = false;
    this.idle = false;
    this.reason = null;
    this.timer = null;
  }

  start() {
    this.power.on('lock-screen', () => this.set({ locked: true }));
    this.power.on('unlock-screen', () => this.set({ locked: false, idle: false }));
    this.power.on('suspend', () => this.set({ suspended: true }));
    this.power.on('resume', () => this.set({ suspended: false }));
    // Idle time is a cheap local call, so a short interval keeps the return-to-desk refresh quick.
    this.timer = setInterval(() => this.checkIdle(), CHECK_INTERVAL_MS);
    this.checkIdle();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  checkIdle() {
    const minutes = this.getIdleMinutes();
    const idle = minutes > 0 && this.power.getSystemIdleTime() >= minutes * 60;
    if (idle !== this.idle) this.set({ idle });
  }

  set(changes) {
    Object.assign(this, changes);
    const reason = this.locked ? 'locked' : this.suspended ? 'suspended' : this.idle ? 'idle' : null;
    if (reason === this.reason) return;
    this.reason = reason;
    this.emit('change', reason);
  }
}

module.exports = { PresenceMonitor };
