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
  /** First-run widget picker (#96): list, install the chosen ones one by one, skip, open a downloaded installer. */
  pickerLoad: () => ipcRenderer.invoke('engine:picker-load'),
  pickerStart: (ids) => ipcRenderer.invoke('engine:picker-start', Array.isArray(ids) ? ids.map(String) : []),
  pickerRetry: (id) => ipcRenderer.invoke('engine:picker-retry', String(id)),
  pickerSkip: (id) => ipcRenderer.invoke('engine:picker-skip', String(id)),
  pickerOpenFile: () => ipcRenderer.invoke('engine:picker-open-file'),
  pickerOpenSite: () => ipcRenderer.invoke('engine:picker-open-site'),
  onPicker: (callback) => ipcRenderer.on('engine:picker', (_e, state) => callback(state)),
  onUpdates: (callback) => ipcRenderer.on('engine:updates', (_e, state) => callback(state)),
  /** Widgets installed, removed, started or stopped while the window is open. */
  onChanged: (callback) => ipcRenderer.on('engine:changed', (_e, state) => callback(state)),
  /** Local-folder sync (#108): the engine owns all connection and conflict decisions. */
  getSyncState: () => ipcRenderer.invoke('engine:sync-get'),
  pickSyncFolder: () => ipcRenderer.invoke('engine:sync-pick-folder'),
  createSyncFolder: (root) => ipcRenderer.invoke('engine:sync-create-folder', root),
  previewSyncConnect: (values) => ipcRenderer.invoke('engine:sync-preview-connect', values),
  applySyncConnect: (decision) => ipcRenderer.invoke('engine:sync-apply-connect', decision),
  syncNow: () => ipcRenderer.invoke('engine:sync-now'),
  resolveSync: (decision) => ipcRenderer.invoke('engine:sync-resolve', decision),
  configureSync: (values) => ipcRenderer.invoke('engine:sync-configure', values),
  disableSync: () => ipcRenderer.invoke('engine:sync-disable'),
  listSyncUndo: () => ipcRenderer.invoke('engine:sync-undo-list'),
  undoSync: (request) => ipcRenderer.invoke('engine:sync-undo', request),
  onSyncChanged: (callback) => ipcRenderer.on('engine:sync-changed', (_e, state) => callback(state)),
});
