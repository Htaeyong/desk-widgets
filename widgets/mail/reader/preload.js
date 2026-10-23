// Preload of the mail reader window (#65, widget UI): one IPC channel to the widget's main code. The message
// body is not in this page; it is in an isolated view without a preload (lib/preview.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mailReader', {
  ready: () => ipcRenderer.invoke('mail-reader', 'ready'),
  layout: (rect) => ipcRenderer.invoke('mail-reader', 'layout', rect),
  navigate: (action) => ipcRenderer.invoke('mail-reader', 'navigate', { action }),
  action: (name, extra = {}) => ipcRenderer.invoke('mail-reader', 'action', { ...extra, name }),
  on: (callback) => ipcRenderer.on('mail-reader:event', (_event, name, payload) => callback(name, payload)),
});
