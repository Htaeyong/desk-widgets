const { contextBridge, ipcRenderer } = require('electron');

// Every call resolves to { ok: true, result } or { ok: false, message }.
contextBridge.exposeInMainWorld('rulesApi', {
  get: () => ipcRenderer.invoke('rules:get'),
  save: (rule) => ipcRenderer.invoke('rules:save', rule),
  remove: (id) => ipcRenderer.invoke('rules:remove', id),
  run: (id) => ipcRenderer.invoke('rules:run', id),
  onChanged: (callback) => ipcRenderer.on('rules:changed', () => callback()),
});
