'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crossdrop', {
  isDesktop: true,
  platform: process.platform,
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickSaveDir: () => ipcRenderer.invoke('dialog:pickSaveDir'),
  recvBegin: (meta) => ipcRenderer.invoke('recv:begin', meta),
  recvChunk: (id, data) => ipcRenderer.invoke('recv:chunk', { id, data }),
  recvEnd: (id) => ipcRenderer.invoke('recv:end', id),
  recvAbort: (id) => ipcRenderer.invoke('recv:abort', id),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:show', target),
  openPath: (target) => ipcRenderer.invoke('shell:openPath', target)
});
