// DevDeck · by GLNB —— Electron 桌面壳：启动内置服务并打开窗口，关窗隐藏到托盘
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, screen } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 启动诊断日志（%TEMP%/devdeck-boot.log）
const BOOT_LOG = path.join(os.tmpdir(), 'devdeck-boot.log');
function bootLog(m) { try { fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${m}\n`); } catch {} }
process.on('uncaughtException', e => bootLog('UNCAUGHT ' + ((e && e.stack) || e)));
process.on('unhandledRejection', e => bootLog('UNHANDLED ' + ((e && e.stack) || e)));
bootLog('APP START ' + process.execPath);

// 单实例锁：避免源码版 + EXE 版双开抢端口（如 :5179），第二份启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { bootLog('SECOND INSTANCE QUIT'); app.quit(); }
else {
  app.on('second-instance', () => {
    try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.show(); } catch {}
    try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch {}
    refreshTrayMenu();
  });
}

function pickFreePort(from, count) {
  return new Promise(resolve => {
    let p = from;
    const tryOne = () => {
      if (p >= from + count) return resolve(from);
      const s = net.createServer();
      s.once('error', () => { p++; tryOne(); });
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    tryOne();
  });
}

let PORT = 3300;
let URL = '';
let win = null;
let tray = null;
let isQuiting = false;
let overlayWin = null; // 桌面悬浮卡片窗口
const APP_ICON = path.join(__dirname, 'assets', 'favicon-256.png'); // 任务栏/托盘图标（取自 favicon.svg）
const OVERLAY_PRELOAD = path.join(__dirname, 'overlay-preload.js');
const OVERLAY_W = 300, OVERLAY_H = 400, OVERLAY_COLLAPSED_H = 68; // 折叠态只留一条状态栏的高度

function overlayStatePath() {
  // 打包后迁 userData（tmpdir 会被系统清理导致位置记忆丢失）；开发模式保持 tmp 避免污染源码目录
  try {
    if (app.isPackaged) return path.join(app.getPath('userData'), 'overlay-state.json');
  } catch {}
  return path.join(os.tmpdir(), 'devdeck-overlay-state.json');
} // 悬浮窗位置/折叠/置顶记忆

function loadOverlayState() {
  const base = { x: null, y: null, pinned: true, collapsed: false };
  try {
    const f = overlayStatePath();
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j === 'object') return { ...base, ...j };
    }
  } catch {}
  return base;
}
function saveOverlayState(st) { try { fs.writeFileSync(overlayStatePath(), JSON.stringify(st)); } catch {} }

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'DevDeck · by GLNB', autoHideMenuBar: true, backgroundColor: '#e8edf4', icon: APP_ICON,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.setMenuBarVisibility(false);
  win.loadURL(URL);
  win.on('close', (e) => {
    if (!isQuiting) { e.preventDefault(); win.hide(); } // 关窗→隐藏到托盘
  });
  win.on('closed', () => { win = null; });
  let moveTimer = null;
  const setMoving = moving => { try { win && !win.isDestroyed() && win.webContents.send('win-moving', moving); } catch {} };
  win.on('move', () => { setMoving(true); clearTimeout(moveTimer); moveTimer = setTimeout(() => setMoving(false), 350); });
  win.on('resize', () => { setMoving(true); clearTimeout(moveTimer); moveTimer = setTimeout(() => setMoving(false), 350); });
}

// 折叠/展开时同步窗口高度：透明窗口不会让点击穿透，不缩窗会一直挡着桌面。
// 踩坑记录（Windows 实测）：非 resizable 的透明无边框窗口上 setSize() 是空操作，
// 必须用 setBounds()；且系统会给这类窗口 +1px，所以比较要留容差，否则会反复重设。
function setOverlayHeight(h) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  // 宽度用设计常量：透明窗口的 getBounds() 会带 1px 虚边，回写 b.width 会让窗口每折叠一次就宽 1px
  const target = { x: b.x, y: b.y, width: OVERLAY_W, height: Math.max(48, Math.round(h)) };
  const widthOk = Math.abs(b.width - OVERLAY_W) <= 2; // 见下：透明窗口实测会 +1px，留容差
  if (widthOk && Math.abs(b.height - target.height) <= 2) return;
  try { overlayWin.setBounds(target); } catch {}
  // 兜底：极端环境（某些 DPI/主题）仍拦 setBounds 时，临时放开 resizable 再设
  if (Math.abs(overlayWin.getBounds().height - target.height) > 2) {
    try {
      const was = overlayWin.isResizable();
      overlayWin.setResizable(true);
      overlayWin.setBounds(target);
      overlayWin.setResizable(was);
    } catch {}
  }
  bootLog(`OVERLAY HEIGHT ${b.height} -> ${overlayWin.getBounds().height} (target ${target.height})`);
}

function applyOverlayCollapsed() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const st = loadOverlayState();
  setOverlayHeight(st.collapsed ? OVERLAY_COLLAPSED_H : OVERLAY_H);
}

// IPC 只注册一次：重复 createOverlay 不再叠加监听器
function registerOverlayIpc() {
  ipcMain.on('overlay:set-always-on-top', (_e, on) => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setAlwaysOnTop(!!on, 'floating');
    saveOverlayState({ ...loadOverlayState(), pinned: !!on });
  });
  ipcMain.on('overlay:hide', () => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide(); refreshTrayMenu(); });
  ipcMain.on('overlay:open-external', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.on('overlay:toast', (_e, msg) => { try { if (win && !win.isDestroyed()) win.webContents.send('overlay-toast', String(msg)); } catch {} });
  // 只合并传来的字段：悬浮卡只发改动项，避免把另一项误写成 false（旧版把 pinned/collapsed 都强制布尔化）
  ipcMain.on('overlay:state', (_e, s) => {
    const next = { ...loadOverlayState() };
    if (s && typeof s.collapsed === 'boolean') next.collapsed = s.collapsed;
    if (s && typeof s.pinned === 'boolean') next.pinned = s.pinned;
    saveOverlayState(next);
    if (s && typeof s.collapsed === 'boolean') {
      // 渲染端会带上实测折叠高度（panel 实际高度 + 卡片上下 padding），比写死 68 更贴合字体/DPI
      const measured = Number(s.height);
      const h = s.collapsed
        ? (Number.isFinite(measured) && measured >= 48 ? Math.min(measured, OVERLAY_H) : OVERLAY_COLLAPSED_H)
        : OVERLAY_H;
      setOverlayHeight(h);
    }
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setAlwaysOnTop(!!next.pinned, 'floating');
  });
  // 悬浮卡启动时读主进程状态：折叠/置顶以 overlay-state.json 为唯一真相
  ipcMain.handle('overlay:get-state', () => {
    const st = loadOverlayState();
    return { pinned: !!st.pinned, collapsed: !!st.collapsed };
  });
}
registerOverlayIpc();

// ===================== 桌面悬浮卡片窗口 =====================
// 无边框、置顶、透明底小窗，加载 public/overlay.html，复用 /api/node-services 轮询。
function createOverlay() {
  const st = loadOverlayState();
  const H = st.collapsed ? OVERLAY_COLLAPSED_H : OVERLAY_H;
  let wa = { width: 1920, height: 1080 };
  try { wa = screen.getPrimaryDisplay().workArea; } catch {}
  const x = (typeof st.x === 'number') ? st.x : (wa.width - OVERLAY_W - 24);
  const y = (typeof st.y === 'number') ? st.y : (wa.height - H - 80);
  overlayWin = new BrowserWindow({
    width: OVERLAY_W, height: H,
    x, y,
    frame: false, transparent: true, alwaysOnTop: !!st.pinned, skipTaskbar: true,
    resizable: false, maximizable: false, fullscreenable: false,
    title: 'DevDeck 悬浮卡片',
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, preload: OVERLAY_PRELOAD }
  });
  overlayWin.setAlwaysOnTop(!!st.pinned, 'floating');
  overlayWin.loadURL(URL + 'overlay.html'); // 走 HTTP 同源加载，overlay 内相对路径 fetch 才能工作
  // 记录位置（拖动/移动时持久化）
  const savePos = () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      const [px, py] = overlayWin.getPosition();
      saveOverlayState({ ...loadOverlayState(), x: px, y: py });
    }
  };
  overlayWin.on('move', savePos);
  overlayWin.on('close', (e) => { if (!isQuiting) { e.preventDefault(); overlayWin.hide(); } }); // 关悬浮窗→隐藏
  overlayWin.on('closed', () => { overlayWin = null; });
  // 页面加载完成后按持久化状态校正高度（渲染进程状态尚未上报时也不会错位）
  overlayWin.webContents.on('did-finish-load', applyOverlayCollapsed);
  return overlayWin;
}

// 原生目录选择：供新增/编辑弹窗"浏览"按钮调用，返回 Windows 绝对路径（取消返回 null）
ipcMain.handle('pick-dir', async () => {
  try {
    const opts = { title: '选择项目启动目录', properties: ['openDirectory'] };
    const r = (win && !win.isDestroyed()) ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    bootLog('PICK-DIR ' + JSON.stringify(r && r.filePaths));
    return r.canceled ? null : (r.filePaths && r.filePaths[0]) || null;
  } catch (e) { bootLog('PICK-DIR ERR ' + (e && e.message)); return null; }
});

// 托盘菜单每项都按当前真实状态生成：勾选态不能在建菜单时定死（隐藏悬浮卡后要能同步）
function trayMenuTemplate() {
  return [
    { label: '显示主窗口', click: () => { if (win && !win.isDestroyed()) win.show(); } },
    {
      label: '悬浮卡片',
      type: 'checkbox',
      checked: !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()),
      click: (mi) => {
        if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
        if (mi.checked) { overlayWin.show(); overlayWin.focus(); }
        else overlayWin.hide();
        refreshTrayMenu(); // 隐藏/显示后重算勾选态
      }
    },
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (mi) => { app.setLoginItemSettings({ openAtLogin: mi.checked }); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuiting = true; app.quit(); } }
  ];
}
function refreshTrayMenu() {
  if (!tray) return;
  try { tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate())); } catch {}
}
function createTray() {
  const { nativeImage } = require('electron');
  let img = nativeImage.createFromPath(APP_ICON);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('DevDeck · by GLNB');
  refreshTrayMenu();
  tray.on('double-click', () => { if (win && !win.isDestroyed()) win.show(); });
}

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(URL + 'api/node-services'); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

app.whenReady().then(async () => {
  PORT = Number(process.env.PORT) || await pickFreePort(3300, 20);
  process.env.PORT = String(PORT);
  URL = `http://localhost:${PORT}/`;
  bootLog('PORT=' + PORT);
  // 打包后 asar 只读，用户数据（devdeck.json）改写到 Electron userData 目录；开发模式保持 __dirname
  // 首次从源码版迁移：userData 为空但源码目录有配置时自动拷过去，避免“两个相同项目”从头分叉
  if (app.isPackaged && !process.env.DEVDECK_DATA_DIR) {
    try {
      process.env.DEVDECK_DATA_DIR = app.getPath('userData');
      bootLog('DATA_DIR=' + process.env.DEVDECK_DATA_DIR);
      const src = path.join(__dirname, 'devdeck.json');
      const dst = path.join(process.env.DEVDECK_DATA_DIR, 'devdeck.json');
      if (!fs.existsSync(dst) && fs.existsSync(src)) { fs.copyFileSync(src, dst); bootLog('MIGRATED devdeck.json -> userData'); }
    } catch {}
  }
  require('./server');
  bootLog('SERVER REQUIRED');
  const ok = await waitForServer();
  bootLog('SERVER READY=' + ok);
  createWindow();
  createTray();
  createOverlay(); // 桌面悬浮卡片（默认显示）
  refreshTrayMenu(); // 悬浮卡实际可见后再校正一次托盘勾选态
  if (!ok && win) win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('afterbegin','<div style="background:#7f1d1d;color:#fff;padding:8px;text-align:center;font-size:12px">内置服务启动超时</div>')`).catch(() => {});
});

app.on('window-all-closed', () => { if (isQuiting) app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });
