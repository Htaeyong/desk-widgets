// Preload of the AI chat window (#129): one IPC channel to the widget's main code, which checks the sender.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('aiChat', {
  call: (name, arg) => ipcRenderer.invoke('ai-chat-widget', name, arg),
  on: (callback) => {
    const listener = (_event, name, payload) => callback(name, payload);
    ipcRenderer.on('ai-chat-widget:event', listener);
    return () => ipcRenderer.removeListener('ai-chat-widget:event', listener);
  },
  /** The path of a file the user dropped or pasted, or '' (a file from a web page has none). */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
});
