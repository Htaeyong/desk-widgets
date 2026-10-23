// The widget owns presentation and cadence; the engine owns every native measurement.
const path = require('path');
const { DEFAULTS, sanitize } = require('./settings');

const FRAMES = { main: { width: 380, height: 470, minWidth: 260, minHeight: 160 } };

function create(ctx) {
  const store = ctx.createStore({ file: path.join(ctx.dataDir, 'settings.json'), defaults: DEFAULTS, sanitize });
  let host = null;
  let sampler = null;
  let timer = null;
  let running = false;
  let paused = false;
  let current = null;

  const view = () => ({ ...store.load(), locale: ctx.app?.locale?.() || 'ko-KR' });
  const payload = () => ({ metrics: current, settings: { showCores: store.load().showCores }, locale: view().locale });

  function sample() {
    if (!running || paused || !sampler) return;
    const windows = host.desktopWindows();
    if (!windows.some((window) => !window.isDestroyed?.() && window.isVisible?.() && !ctx.system.isWindowCovered?.(window))) {
      sampler.reset();
      return;
    }
    current = sampler.read();
    host.emit('metrics', payload());
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!running) return;
    timer = setInterval(sample, store.load().intervalMs);
    timer.unref?.();
    sample();
  }

  function save(values = {}) {
    const before = store.load();
    store.save({
      intervalMs: values.intervalMs,
      historyMs: values.historyMs,
      showCores: values.showCores,
      alwaysOnTop: values.alwaysOnTop,
      ...(typeof values.themeId === 'string' ? { themeId: values.themeId } : {}),
      ...(values.themeOpacity && typeof values.themeOpacity === 'object' ? { themeOpacity: values.themeOpacity } : {}),
    });
    const after = store.load();
    if (running) {
      if (after.intervalMs !== before.intervalMs || after.historyMs !== before.historyMs) {
        sampler?.close();
        sampler = ctx.system.createSampler({ intervalMs: after.intervalMs, historyMs: after.historyMs });
        schedule();
      }
      if (after.alwaysOnTop !== before.alwaysOnTop) host.setPinned(after.alwaysOnTop);
      if (after.themeId !== before.themeId) host.reload();
      if (JSON.stringify(after.themeOpacity) !== JSON.stringify(before.themeOpacity)) host.applyBackground();
      host.emit('settings', payload());
    }
    ctx.sendToSettings?.('settings-changed', view());
    return { ok: true };
  }

  host = ctx.useThemes({
    store,
    builtinDir: path.join(ctx.dir, 'themes'),
    userDir: path.join(ctx.dataDir, 'themes'),
    kitDir: path.join(ctx.dir, 'kit'),
    defaultTheme: 'graph',
    contractVersions: [1],
    frames: FRAMES,
    methods: { getState: { run: () => payload(), preview: 'allow' } },
    events: ['metrics', 'settings'],
    menuItems: () => [
      { label: view().locale.startsWith('ko') ? '항상 위에 표시' : 'Always on top', type: 'checkbox', checked: store.load().alwaysOnTop, click: (item) => save({ ...store.load(), alwaysOnTop: item.checked }) },
    ],
  });

  return {
    start() {
      if (!ctx.system?.createSampler) throw new Error('Engine API 1.5 is required');
      running = true;
      sampler = ctx.system.createSampler({ intervalMs: store.load().intervalMs, historyMs: store.load().historyMs });
      host.open();
      schedule();
    },
    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      sampler?.close();
      sampler = null;
      current = null;
      host.close();
    },
    setPaused(reason) {
      paused = Boolean(reason);
      if (paused) sampler?.reset();
      else sample();
    },
    focus: () => host.focus(),
    desktopWindows: () => host.desktopWindows(),
    settings: { get: view, save, handlers: host.settingsHandlers() },
  };
}

module.exports = { create };
