// DevDeck 预加载脚本：窗口移动状态（保持 contextIsolation 安全模型）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winState', {
  onMoving: (cb) => ipcRenderer.on('win-moving', (_e, moving) => cb(moving))
});

// 原生能力：Windows 目录选择框（main.js ipcMain.handle('pick-dir')），返回绝对路径或 null
contextBridge.exposeInMainWorld('ddAPI', {
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  // 悬浮卡操作结果 -> 主窗口 toast（main.js 转发 'overlay-toast'）
  onOverlayToast: (cb) => ipcRenderer.on('overlay-toast', (_e, msg) => cb(String(msg == null ? '' : msg)))
});
