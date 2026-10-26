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
  // 上报置顶状态（只传改动项，主进程合并后持久化）
  reportPos: (state) => ipcRenderer.send('overlay:state', state),
  // 上报内容实测高度，主进程据此自适应窗口高度
  setAutoHeight: (h) => ipcRenderer.send('overlay:auto-height', h),
  // 点击极简条 → 展开
  expand: () => ipcRenderer.send('overlay:expand'),
  // 头部"吸附"按钮 → 吸附/取消吸附
  toggleDock: () => ipcRenderer.send('overlay:dock-toggle'),
  // 读取主进程持久化的状态：形态/置顶以主进程为准
  getState: () => ipcRenderer.invoke('overlay:get-state'),
  // 主进程通知形态变化：normal（完整卡片）/ docked（极简条）/ peek（点击后展开）
  onMode: (cb) => ipcRenderer.on('overlay:mode', (_e, m) => cb(m || {})),
  // 主进程通知"鼠标是否靠近停靠条"：驱动细条悬停高亮
  onHover: (cb) => ipcRenderer.on('overlay:hover-state', (_e, v) => cb(!!v))
});
