// Widget manager bridge: installed widgets (on/off, settings) and engine-wide settings.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engineApi', {
  get: () => ipcRenderer.invoke('engine:get'),
  save: (values) => ipcRenderer.invoke('engine:save', values),
  setEnabled: (id, enabled) => ipcRenderer.invoke('engine:set-enabled', String(id), Boolean(enabled)),
  openWidgetSettings: (id) => ipcRenderer.invoke('engine:open-widget-settings', String(id)),
  openWidgetsFolder: () => ipcRenderer.invoke('engine:open-widgets-folder'),
  close: () => ipcRenderer.invoke('engine:close'),
  /** In-app updates (#104): check now, install one product (user click only), state changes. */
  checkUpdates: () => ipcRenderer.invoke('engine:check-updates'),
  installUpdate: (id) => ipcRenderer.invoke('engine:install-update', String(id)),
  onUpdates: (callback) => ipcRenderer.on('engine:updates', (_e, state) => callback(state)),
  /** Widgets installed, removed, started or stopped while the window is open. */
  onChanged: (callback) => ipcRenderer.on('engine:changed', (_e, state) => callback(state)),
});
