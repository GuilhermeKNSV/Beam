// Beam preload script (CommonJS — sandboxed preload scripts cannot use ESM).
// Exposes a minimal, promise-based bridge to the renderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('beam', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  hostRoom: (options) => ipcRenderer.invoke('room:host', options),
  closeRoom: () => ipcRenderer.invoke('room:close'),
  getSources: (type) => ipcRenderer.invoke('capture:sources', type),
  selectSource: (sourceId) => ipcRenderer.invoke('capture:select', sourceId),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: (url) => ipcRenderer.invoke('update:download', url),
  onUpdateProgress: (cb) => { ipcRenderer.on('update:progress', (_e, data) => cb(data)); },
});
