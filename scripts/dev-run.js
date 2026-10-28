// Helpers for the dev-only scripts that start the engine offscreen (scripts/screenshots.js, scripts/memory-profile.js).
// #109: such a run must never be seen (no tray icon) and must always end (time limit, child process tree killed).
const Module = require('module');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');

/** A tray stand-in: the engine's calls work, nothing appears in the notification area. */
class HiddenTray extends EventEmitter {
  setToolTip() {}
  setContextMenu() {}
  setImage() {}
  setTitle() {}
  displayBalloon() {}
  destroy() {}
  isDestroyed() {
    return false;
  }
}

/** Gives every later require('electron') a Tray that shows nothing. Call before requiring the engine. */
function hideTray() {
  const electron = require('electron');
  const wrapped = Object.create(electron, { Tray: { value: HiddenTray, enumerable: true } });
  const load = Module._load;
  Module._load = function loadElectron(request, ...rest) {
    return request === 'electron' ? wrapped : load.call(this, request, ...rest);
  };
}

/** Ends a process and everything it started (Windows: taskkill /T). */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

/**
 * Runs this script again as a child (with its own data folder) and waits for it, at most limitMs: then the child's
 * whole process tree is killed. Also killed when this process is told to stop. Resolves to the exit status.
 */
function runChild(execPath, args, { limitMs }) {
  return new Promise((resolve) => {
    const child = spawn(execPath, args, { stdio: 'inherit', windowsHide: true });
    const stop = () => killTree(child.pid);
    const timer = setTimeout(() => {
      console.error(`dev run: no end after ${Math.round(limitMs / 1000)} s, killing it`);
      stop();
    }, limitMs);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      stop(); // anything the child left behind
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
}

/**
 * Ends the engine run: a normal quit first (the engine stops its widgets and cards), app.exit if that does not end
 * within graceMs.
 */
function finish(app, code, graceMs = 10000) {
  setTimeout(() => app.exit(code), graceMs).unref?.();
  app.once('will-quit', () => setImmediate(() => app.exit(code)));
  app.quit();
}

module.exports = { hideTray, killTree, runChild, finish, HiddenTray };
