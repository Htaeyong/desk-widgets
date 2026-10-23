// Preload of the memo widget's windows (#75: memo windows and the memo list). One IPC channel to the widget's main
// code, which knows from the sender which window is calling; the page never names a file path except a file the user
// dropped (webUtils gives its path).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('memo', {
  call: (name, arg) => ipcRenderer.invoke('memo-widget', name, arg),
  on: (callback) => {
    const listener = (_event, name, payload) => callback(name, payload);
    ipcRenderer.on('memo-widget:event', listener);
    return () => ipcRenderer.removeListener('memo-widget:event', listener);
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
});
