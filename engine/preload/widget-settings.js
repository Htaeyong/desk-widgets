// A widget's settings window: the widget's own settings panel inside an engine frame.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetSettingsApi', {
  get: () => ipcRenderer.invoke('widget-settings:get'),
  save: (values) => ipcRenderer.invoke('widget-settings:save', values),
  close: () => ipcRenderer.invoke('widget-settings:close'),
  /** Calls settings.handlers[name] of this widget. */
  call: (name, ...args) => ipcRenderer.invoke('widget-settings:call', String(name), ...args),
  /** Events the widget sends to its settings window, e.g. ('theme-applied', themeId). */
  onEvent: (callback) => ipcRenderer.on('settings:widget-event', (_e, _widgetId, name, payload) => callback(name, payload)),
});
