'use strict';

/**
 * 预加载脚本：只向渲染层暴露最小 API 面（无 Node 直通）。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tl', {
  snapshot: (opts) => ipcRenderer.invoke('tl:snapshot', opts || {}),
  setDemo: (flag) => ipcRenderer.invoke('tl:setDemo', !!flag),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('tl:setAlwaysOnTop', !!flag),
  setCompact: (flag) => ipcRenderer.invoke('tl:setCompact', !!flag),
  closeWindow: () => ipcRenderer.invoke('tl:close'),
  openPath: (p) => ipcRenderer.invoke('tl:openPath', p),
  getPrefs: () => ipcRenderer.invoke('tl:getPrefs'),
  savePrefs: (prefs) => ipcRenderer.invoke('tl:savePrefs', prefs || {}),
});
