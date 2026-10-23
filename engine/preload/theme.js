// Theme API v1 (see docs/THEME_SPEC.md). This is the only bridge a theme gets.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dooray', {
  apiVersion: 1,
  getContext: () => ipcRenderer.invoke('theme:get-context'),
  getSnapshot: () => ipcRenderer.invoke('theme:get-snapshot'),
  onSnapshot: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onSnapshot requires a function');
    const listener = (_e, snapshot) => callback(snapshot);
    ipcRenderer.on('theme:snapshot', listener);
    return () => ipcRenderer.removeListener('theme:snapshot', listener);
  },
  /**
   * Background opacity changes (v1.8): callback({ opacity }) with 0..1, when the user moves the slider
   * or saves. Only for themes with "background" in theme.json; the --theme-bg-alpha CSS variable is set
   * by the app either way, so most themes never need this. Returns an unsubscribe function.
   */
  onBackground: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onBackground requires a function');
    const listener = (_e, background) => callback(background);
    ipcRenderer.on('theme:background', listener);
    return () => ipcRenderer.removeListener('theme:background', listener);
  },
  refresh: () => ipcRenderer.invoke('theme:refresh'),
  openUrl: (url) => ipcRenderer.invoke('theme:open-url', String(url)),
  openSettings: () => ipcRenderer.invoke('theme:open-settings'),
  openProjectWidget: (projectId) => ipcRenderer.invoke('theme:open-project', String(projectId)),
  /** Saves the user's project order (array of project ids). The next snapshot comes in that order (v1.5). */
  setProjectOrder: (projectIds) => ipcRenderer.invoke('theme:set-project-order', Array.from(projectIds || [], String)),
  /** Opens the app's category manager window, optionally with a category selected (v1.2). */
  openCategoryManager: (categoryId) => ipcRenderer.invoke('theme:open-category-manager', categoryId ? String(categoryId) : ''),
  addToTodo: (taskId) => globalThis.navigator?.userActivation?.isActive
    ? ipcRenderer.invoke('theme:add-to-todo', String(taskId), true)
    : Promise.resolve({ ok: false, message: '클릭이나 키 입력으로만 할 수 있습니다.' }),
  // Personal task categories (stored locally, never sent to Dooray).
  // Every call resolves to { ok: true, result } or { ok: false, message }.
  categories: {
    create: (input) => ipcRenderer.invoke('theme:categories', 'create', input),
    update: (id, changes) => ipcRenderer.invoke('theme:categories', 'update', { ...changes, id }),
    move: (id, delta) => ipcRenderer.invoke('theme:categories', 'move', { id, delta }),
    remove: (id) => ipcRenderer.invoke('theme:categories', 'remove', { id }),
    setTaskCategories: (taskId, categoryIds) =>
      ipcRenderer.invoke('theme:categories', 'setTaskCategories', { taskId, categoryIds }),
    removeClosed: (id) => ipcRenderer.invoke('theme:categories', 'removeClosed', { id: id ?? null }),
  },
  window: {
    close: () => ipcRenderer.invoke('theme:window-close'),
    togglePin: () => ipcRenderer.invoke('theme:window-toggle-pin'),
    getState: () => ipcRenderer.invoke('theme:window-state'),
    /** Resizes this window, keeping its top-left corner on screen. Resolves to the applied size (v1.7). */
    setSize: (width, height) => ipcRenderer.invoke('theme:window-set-size', Number(width), Number(height)),
  },
});
