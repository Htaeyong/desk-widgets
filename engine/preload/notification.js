const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notificationApi', {
  get: () => ipcRenderer.invoke('notification:get'),
  open: () => ipcRenderer.invoke('notification:open'),
  dismiss: () => ipcRenderer.invoke('notification:dismiss'),
  dismissAll: () => ipcRenderer.invoke('notification:dismiss-all'),
  hover: (hovered) => ipcRenderer.invoke('notification:hover', hovered),
  onTimer: (callback) => ipcRenderer.on('notification:timer', (_e, t) => callback(t)),
  onQueue: (callback) => ipcRenderer.on('notification:queue', (_e, n) => callback(n)),
  // Generic cards (engine API 1.2): a button calls the widget -> { ok, keepOpen } or { ok: false, message }.
  action: (id) => ipcRenderer.invoke('notification:action', String(id)),
  onSound: (callback) => ipcRenderer.on('notification:sound', () => callback()),
  // Widget card menu (engine API 1.1): every call resolves to { ok, items } or { ok: false, message }.
  menuOpen: (open, panelHeight) => ipcRenderer.invoke('notification:menu-open', Boolean(open), Number(panelHeight) || 0),
  menuItems: () => ipcRenderer.invoke('notification:menu-items'),
  menuToggle: (id, checked) => ipcRenderer.invoke('notification:menu-toggle', String(id), Boolean(checked)),
  menuCreate: (text) => ipcRenderer.invoke('notification:menu-create', String(text || '')),
});
