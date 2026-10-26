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
  // 读取主进程持久化的状态：形态/折叠/置顶以主进程为准
  getState: () => ipcRenderer.invoke('overlay:get-state'),
  // 鼠标进入/离开窗口：极简条靠它触发"悬停展开 / 离开缩回"
  hover: (inside) => ipcRenderer.send('overlay:hover', !!inside),
  // 主进程通知形态变化：normal（完整卡片）/ docked（极简条）/ peek（停靠后展开）
  onMode: (cb) => ipcRenderer.on('overlay:mode', (_e, m) => cb(m || {}))
});
