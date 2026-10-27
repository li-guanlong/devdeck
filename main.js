// DevDeck · by GLNB —— Electron 桌面壳：启动内置服务并打开窗口，关窗隐藏到托盘
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, screen, clipboard } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { nearestEdge, dockBounds, peekBounds, clamp, pointInBounds } = require('./lib/overlay-geometry');

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
const OVERLAY_W = 300, OVERLAY_H = 400; // 悬浮卡宽度固定 300；高度按内容自适应（最大 400，超出滚动）
const OVERLAY_MIN_H = 100;              // 自适应最小高度：只有头部+空列表+底部状态
const SNAP_PX = 26;                 // 距屏幕工作区边缘多少像素内触发吸附
const SNAP_DOCK_DELAY = 450;        // 贴边后多久缩成极简条
// 停靠条尺寸：Windows 对窗口有最小尺寸（实测 32×38），竖条 32 宽、横条 38 高；可见的只是中间那条细线
const DOCK_TAB = { vertical: { w: 32, h: 120 }, horizontal: { w: 120, h: 38 } };
const PEEK_GAP = 6;                 // 点击展开时卡片与屏幕边的间距
const HOVER_POLL_MS = 120;          // 停靠/展开态用全局光标轮询（展开后靠它判断"离开即收起"）
const HOVER_PAD = 10;              // 光标距停靠条多少像素内算"悬停"

// 悬浮卡形态：normal（完整卡片）/ docked（贴边极简条）/ peek（点击后展开）
let overlayMode = 'normal';
let dockEdge = null;   // left | right | top | bottom
let tabBounds = null;  // 极简条位置，peek 收起时回到这里
let autoHeight = OVERLAY_H; // 渲染端实测的内容高度（自适应）
let hoverInside = false;
let hoverPoll = null;
let lastHoverNear = null; // 上次上报的"靠近"状态（null=未上报），避免重复 IPC
let dockTimer = null, peekTimer = null, moveTimer = null, posTimer = null, boundsTimer = null;
let lastProgrammaticAt = 0; // 程序化 setBounds 会触发 move 事件，用它区分"用户拖动"
let suppressSnapUntil = 0;  // 自适应改高度后短暂忽略吸附，避免"内容一变就自动贴边停靠"

function overlayStatePath() {
  // 打包后迁 userData（tmpdir 会被系统清理导致位置记忆丢失）；开发模式保持 tmp 避免污染源码目录
  try {
    if (app.isPackaged) return path.join(app.getPath('userData'), 'overlay-state.json');
  } catch {}
  return path.join(os.tmpdir(), 'devdeck-overlay-state.json');
} // 悬浮窗位置/折叠/置顶记忆

function loadOverlayState() {
  const base = { x: null, y: null, pinned: true, docked: false, edge: null };
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

// 高度自适应：窗口高度跟随内容变化，同时把窗口限制在工作区内。
// 踩坑记录（Windows 实测）：非 resizable 的透明无边框窗口上 setSize() 是空操作，
// 必须用 setBounds()；且系统会给这类窗口 +1px，所以比较要留容差，否则会反复重设。
function setOverlayHeight(h) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayMode !== 'normal') return; // 停靠/展开态尺寸由停靠几何接管
  const b = overlayWin.getBounds();
  const wa = overlayWorkArea();
  const targetH = Math.max(OVERLAY_MIN_H, Math.min(OVERLAY_H, Math.round(h || OVERLAY_H)));
  // 底部越界时上移，避免变高后掉出屏幕
  let y = b.y;
  if (y + targetH > wa.y + wa.height) y = wa.y + wa.height - targetH;
  if (y < wa.y) y = wa.y;
  // 宽度用设计常量：透明窗口的 getBounds() 会带 1px 虚边，回写 b.width 会让窗口每次重设都变宽
  const target = { x: b.x, y: Math.round(y), width: OVERLAY_W, height: targetH };
  const widthOk = Math.abs(b.width - OVERLAY_W) <= 2; // 透明窗口实测会 +1px，留容差
  if (widthOk && Math.abs(b.height - target.height) <= 2 && Math.abs(b.y - target.y) <= 1) return;
  suppressSnapUntil = Date.now() + 900; // 自适应改高度不算"拖动到边缘"，别触发自动停靠
  try { applyOverlayBounds(target); } catch { try { overlayWin.setBounds(target); } catch {} }
  try { saveOverlayState({ ...loadOverlayState(), x: target.x, y: target.y }); } catch {}
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

// ===== 停靠：吸附 → 极简边缘条 → 点击展开 =====
function overlayWorkArea() {
  try { return screen.getDisplayMatching(overlayWin.getBounds()).workArea; }
  catch { try { return screen.getPrimaryDisplay().workArea; } catch { return { x: 0, y: 0, width: 1920, height: 1080 }; } }
}

function applyOverlayBounds(b) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  lastProgrammaticAt = Date.now();
  try { overlayWin.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }); } catch {}
  clearTimeout(boundsTimer);
  // 600ms 内到达的 move 事件视为程序化改尺寸的附带结果，不当用户拖动
  boundsTimer = setTimeout(() => { lastProgrammaticAt = 0; }, 600);
}

// 停靠条复用了同一套窗口穿透开关：普通态不穿透；停靠态也不穿透（要接收点击展开）。
// 停靠条窗口很小（32×120 / 120×38），挡住的边缘区域可接受。
function overlaySetClickThrough(on) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try { overlayWin.setIgnoreMouseEvents(!!on, { forward: false }); } catch {}
}

function cursorNear(bounds, pad) {
  try { return pointInBounds(bounds, screen.getCursorScreenPoint(), pad); }
  catch { return false; }
}

function startHoverPoll() {
  if (hoverPoll) return;
  hoverPoll = setInterval(checkHover, HOVER_POLL_MS);
}

function stopHoverPoll() {
  if (hoverPoll) { clearInterval(hoverPoll); hoverPoll = null; }
  clearTimeout(peekTimer);
  hoverInside = false;
  lastHoverNear = null;
}

// 轮询全局光标：停靠态只更新"悬停高亮"（不再自动展开，展开改为点击细条）；
// 展开态则判断光标是否离开卡片，离开后延时收起。
function checkHover() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayMode === 'docked' && tabBounds) {
    notifyOverlayHover(cursorNear(tabBounds, HOVER_PAD));
    return;
  }
  if (overlayMode === 'peek') {
    const inside = cursorNear(overlayWin.getBounds(), 2);
    if (inside) {
      hoverInside = true;
      clearTimeout(peekTimer);
    } else if (hoverInside) {
      hoverInside = false;
      peekTimer = setTimeout(() => {
        if (overlayMode === 'peek' && !cursorNear(overlayWin.getBounds(), 2)) overlayPeekClose();
      }, 500);
    }
  }
}

function notifyOverlayMode() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const st = loadOverlayState();
  try {
    overlayWin.webContents.send('overlay:mode', {
      mode: overlayMode,
      edge: dockEdge,
      pinned: !!st.pinned
    });
  } catch {}
}

function notifyOverlayHover(near) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (near === lastHoverNear) return;
  lastHoverNear = near;
  try { overlayWin.webContents.send('overlay:hover-state', !!near); } catch {}
}

// 贴到指定边缘并缩成极简条
function overlayDock(edge) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const t = dockBounds(edge, overlayWin.getBounds(), overlayWorkArea(), DOCK_TAB);
  overlayMode = 'docked'; dockEdge = edge; hoverInside = false;
  lastHoverNear = null; // 强制下一次 checkHover 重新上报，避免页面停在旧高亮
  tabBounds = t;
  clearTimeout(dockTimer);
  applyOverlayBounds(t);
  // 细条改为"点击展开"，窗口不能再穿透，否则收不到点击；细条区域很小，挡住边缘一点可接受
  overlaySetClickThrough(false);
  startHoverPoll();
  saveOverlayState({ ...loadOverlayState(), docked: true, edge, x: t.x, y: t.y });
  bootLog(`OVERLAY DOCK ${edge} ${t.x},${t.y} ${t.width}x${t.height}`);
  notifyOverlayMode();
}

// 点击展开：从极简条长成完整卡片（始终朝屏幕内侧展开），高度用内容自适应值
function overlayPeekOpen() {
  if (overlayMode !== 'docked' || !tabBounds) return;
  const cardH = Math.max(OVERLAY_MIN_H, Math.min(OVERLAY_H, Math.round(autoHeight || OVERLAY_H)));
  const b = peekBounds(dockEdge, tabBounds, overlayWorkArea(), { w: OVERLAY_W, h: cardH }, PEEK_GAP);
  overlayMode = 'peek';
  clearTimeout(peekTimer);
  overlaySetClickThrough(false); // 展开后可交互
  applyOverlayBounds(b);
  notifyOverlayMode();
}

function overlayPeekClose() {
  if (overlayMode !== 'peek' || !tabBounds) return;
  overlayMode = 'docked';
  applyOverlayBounds(tabBounds);
  overlaySetClickThrough(false); // 停靠条现在也要能接收点击
  hoverInside = false;
  notifyOverlayMode();
}

// 退出停靠：恢复完整卡片（高度用内容自适应值）
function overlayUndock() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  const wa = overlayWorkArea();
  const st = loadOverlayState();
  const h = Math.max(OVERLAY_MIN_H, Math.min(OVERLAY_H, Math.round(autoHeight || OVERLAY_H)));
  overlayMode = 'normal'; dockEdge = null; tabBounds = null; hoverInside = false;
  clearTimeout(dockTimer); clearTimeout(peekTimer);
  stopHoverPoll();
  lastHoverNear = null;
  overlaySetClickThrough(false);
  let x = clamp(b.x, wa.x, wa.x + wa.width - OVERLAY_W);
  let y = clamp(b.y, wa.y, wa.y + wa.height - h);
  // 展开态本来贴边，直接退回浮动会被"贴边自动吸附"立刻再次吸走；向内挪一截，离开吸附区
  const near = nearestEdge({ x, y, width: OVERLAY_W, height: h }, wa);
  if (near.dist <= SNAP_PX) {
    if (near.edge === 'left') x = clamp(wa.x + SNAP_PX + 8, wa.x, wa.x + wa.width - OVERLAY_W);
    else if (near.edge === 'right') x = clamp(wa.x + wa.width - OVERLAY_W - SNAP_PX - 8, wa.x, wa.x + wa.width - OVERLAY_W);
    else if (near.edge === 'top') y = clamp(wa.y + SNAP_PX + 8, wa.y, wa.y + wa.height - h);
    else y = clamp(wa.y + wa.height - h - SNAP_PX - 8, wa.y, wa.y + wa.height - h);
  }
  applyOverlayBounds({ x, y, width: OVERLAY_W, height: h });
  saveOverlayState({ ...st, docked: false, edge: null, x: Math.round(x), y: Math.round(y) });
  notifyOverlayMode();
}

// 拖动停稳后：吸附 / 更新极简条位置 / 退出停靠
function overlayMoveEnded() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (Date.now() < suppressSnapUntil) return; // 自适应改高度期间别触发吸附
  const since = Date.now() - lastProgrammaticAt;
  if (lastProgrammaticAt && since < 600) { clearTimeout(moveTimer); moveTimer = setTimeout(overlayMoveEnded, 650 - since); return; }
  const b = overlayWin.getBounds();
  const wa = overlayWorkArea();
  const near = nearestEdge(b, wa);

  if (overlayMode === 'peek') { overlayUndock(); return; } // 拖动展开态 = 退出停靠
  if (overlayMode === 'docked') {
    if (near.dist <= SNAP_PX) overlayDock(near.edge);
    else overlayUndock();
    return;
  }

  if (near.dist <= SNAP_PX) {
    // 先贴边（视觉吸附），停稳 450ms 后再变极简条；期间鼠标回到卡片上会取消
    const x = near.edge === 'left' ? wa.x : near.edge === 'right' ? wa.x + wa.width - b.width : b.x;
    const y = near.edge === 'top' ? wa.y : near.edge === 'bottom' ? wa.y + wa.height - b.height : b.y;
    applyOverlayBounds({ x, y, width: b.width, height: b.height });
    saveOverlayState({ ...loadOverlayState(), x: Math.round(x), y: Math.round(y) });
    clearTimeout(dockTimer);
    dockTimer = setTimeout(() => { if (overlayMode === 'normal') overlayDock(near.edge); }, SNAP_DOCK_DELAY);
  } else {
    clearTimeout(dockTimer);
    saveOverlayState({ ...loadOverlayState(), x: b.x, y: b.y });
  }
}

// IPC 只注册一次：重复 createOverlay 不再叠加监听器
function registerOverlayIpc() {
  ipcMain.on('overlay:set-always-on-top', (_e, on) => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setAlwaysOnTop(!!on, 'floating');
    saveOverlayState({ ...loadOverlayState(), pinned: !!on });
  });
  ipcMain.on('overlay:hide', () => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide(); refreshTrayMenu(); });
  ipcMain.on('overlay:open-external', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.on('overlay:copy-text', (_e, text) => { try { clipboard.writeText(String(text == null ? '' : text)); } catch {} });
  ipcMain.on('overlay:toast', (_e, msg) => { try { if (win && !win.isDestroyed()) win.webContents.send('overlay-toast', String(msg)); } catch {} });
  // 只合并传来的字段：悬浮卡只发改动项，避免把另一项误写成 false
  ipcMain.on('overlay:state', (_e, s) => {
    const next = { ...loadOverlayState() };
    if (s && typeof s.pinned === 'boolean') next.pinned = s.pinned;
    saveOverlayState(next);
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setAlwaysOnTop(!!next.pinned, 'floating');
  });
  // 内容高度自适应：渲染端实测高度上报，普通形态直接改窗口，展开态按新高度重排
  ipcMain.on('overlay:auto-height', (_e, h) => {
    const n = Number(h);
    if (!Number.isFinite(n) || n <= 0) return;
    autoHeight = Math.max(OVERLAY_MIN_H, Math.min(OVERLAY_H, Math.round(n)));
    if (overlayMode === 'normal') setOverlayHeight(autoHeight);
    else if (overlayMode === 'peek' && tabBounds) {
      const b = peekBounds(dockEdge, tabBounds, overlayWorkArea(), { w: OVERLAY_W, h: autoHeight }, PEEK_GAP);
      applyOverlayBounds(b);
    }
  });
  // 点击极简条 → 展开为卡片
  ipcMain.on('overlay:expand', () => { if (overlayMode === 'docked') overlayPeekOpen(); });
  // 头部"吸附"按钮：普通态吸附到最近边缘；展开/停靠态退回浮动卡片
  ipcMain.on('overlay:dock-toggle', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (overlayMode === 'normal') {
      const near = nearestEdge(overlayWin.getBounds(), overlayWorkArea());
      overlayDock(near.edge);
    } else {
      overlayUndock();
    }
  });
  // 悬浮卡启动时读主进程状态：形态/置顶以主进程为准
  ipcMain.handle('overlay:get-state', () => {
    const st = loadOverlayState();
    return { pinned: !!st.pinned, mode: overlayMode, edge: dockEdge };
  });
}
registerOverlayIpc();

// ===================== 桌面悬浮卡片窗口 =====================
// 无边框、置顶、透明底小窗，加载 public/overlay.html，复用 /api/node-services 轮询。
// 形态：完整卡片（可拖动、高度自适应）→ 靠近屏幕边缘吸附 → 缩成极简边缘条 → 点击展开。
function createOverlay() {
  const st = loadOverlayState();
  const docked = !!(st.docked && ['left', 'right', 'top', 'bottom'].includes(st.edge));
  overlayMode = docked ? 'docked' : 'normal';
  dockEdge = docked ? st.edge : null;
  const vertical = dockEdge === 'left' || dockEdge === 'right';
  const tabSize = vertical ? DOCK_TAB.vertical : DOCK_TAB.horizontal;
  const width = docked ? tabSize.w : OVERLAY_W;
  const height = docked ? tabSize.h : OVERLAY_H;
  let wa = { x: 0, y: 0, width: 1920, height: 1080 };
  try { wa = screen.getPrimaryDisplay().workArea; } catch {}
  const x = Number.isFinite(st.x) ? st.x : (wa.x + wa.width - OVERLAY_W - 24);
  const y = Number.isFinite(st.y) ? st.y : (wa.y + wa.height - height - 80);
  tabBounds = docked ? { x: Math.round(x), y: Math.round(y), width, height } : null;

  overlayWin = new BrowserWindow({
    width, height, x, y,
    frame: false, transparent: true, alwaysOnTop: !!st.pinned, skipTaskbar: true,
    resizable: false, maximizable: false, fullscreenable: false,
    title: 'DevDeck 悬浮卡片',
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, preload: OVERLAY_PRELOAD }
  });
  overlayWin.setAlwaysOnTop(!!st.pinned, 'floating');
  overlayWin.loadURL(URL + 'overlay.html'); // 走 HTTP 同源加载，overlay 内相对路径 fetch 才能工作
  if (docked) { overlaySetClickThrough(false); startHoverPoll(); } // 启动即停靠：点击展开 + 光标轮询

  // 拖动：停稳后判定吸附/停靠；位置持久化做节流，避免拖动过程中狂写状态文件
  overlayWin.on('move', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(overlayMoveEnded, 320);
    clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      if (overlayMode !== 'normal') return; // 停靠条位置在 dock 时已存
      if (lastProgrammaticAt && Date.now() - lastProgrammaticAt < 600) return;
      const [px, py] = overlayWin.getPosition();
      saveOverlayState({ ...loadOverlayState(), x: px, y: py });
    }, 900);
  });
  overlayWin.on('close', (e) => { if (!isQuiting) { e.preventDefault(); overlayWin.hide(); } }); // 关悬浮窗→隐藏
  overlayWin.on('hide', () => stopHoverPoll()); // 隐藏时停掉光标轮询，避免后台误展开
  overlayWin.on('show', () => { if (overlayMode === 'docked' || overlayMode === 'peek') startHoverPoll(); });
  overlayWin.on('closed', () => { overlayWin = null; stopHoverPoll(); });
  overlayWin.webContents.on('did-finish-load', () => {
    notifyOverlayMode(); // 告诉页面当前形态（极简条 / 完整卡片）；高度由页面实测后回传自适应
  });
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
