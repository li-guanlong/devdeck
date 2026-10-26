// DevDeck 悬浮卡片 preload：为悬浮窗暴露安全能力（无 nodeIntegration）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  // 通知主进程切换置顶（主进程判断来源窗口）
  setAlwaysOnTop: (on) => ipcRenderer.send('overlay:set-always-on-top', on),
  // 隐藏悬浮窗口（回到托盘/桌面）
  hide: () => ipcRenderer.send('overlay:hide'),
  // 用系统默认浏览器打开外部 URL
  openExternal: (url) => ipcRenderer.send('overlay:open-external', url),
  // 提示气泡（主进程调用，或直接回传）
  toast: (msg) => ipcRenderer.send('overlay:toast', msg),
  // 上报折叠/置顶状态（只传改动项，主进程合并后持久化）
  reportPos: (state) => ipcRenderer.send('overlay:state', state),
  // 读取主进程持久化的状态：折叠/置顶以 overlay-state.json 为唯一真相
  getState: () => ipcRenderer.invoke('overlay:get-state')
});
