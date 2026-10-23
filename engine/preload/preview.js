const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('previewApi', {
  getState: () => ipcRenderer.invoke('preview:get-state'),
  step: (delta) => ipcRenderer.invoke('preview:step', delta),
  apply: () => ipcRenderer.invoke('preview:apply'),
  close: () => ipcRenderer.invoke('preview:close'),
  onState: (callback) => ipcRenderer.on('preview:state', (_e, state) => callback(state)),
});
