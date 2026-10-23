// Preload of the mail composer window (#68, widget UI): one IPC channel to the widget's main code.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name, arg) => ipcRenderer.invoke('mail-composer', name, arg);
contextBridge.exposeInMainWorld('mailComposer', {
  init: () => call('init'),
  update: (fields) => call('update', fields),
  pickFiles: () => call('pickFiles'),
  suggest: (q, exclude) => call('suggest', { q, exclude }),
  removeFile: (id) => call('removeFile', { id }),
  send: (fields) => call('send', fields),
  discard: () => call('discard'),
});
