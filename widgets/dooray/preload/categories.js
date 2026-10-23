const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('managerApi', {
  get: () => ipcRenderer.invoke('manager:get'),
  action: (action, payload) => ipcRenderer.invoke('manager:action', action, payload),
  openUrl: (url) => ipcRenderer.invoke('manager:open-url', url),
  confirm: (message, detail) => ipcRenderer.invoke('manager:confirm', message, detail),
  onUpdate: (callback) => ipcRenderer.on('manager:snapshot', (_e, state) => callback(state)),
  onSelect: (callback) => ipcRenderer.on('manager:select', (_e, id) => callback(id)),
});
