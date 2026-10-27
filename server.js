// DevDeck · by GLNB —— 本机开发工作台后端（Express 5）
// 只做三件事：发现运行中的 node 服务、管理本地项目启停、聚合运行日志。
// 无监控采样、无历史/告警，零第三方采集依赖。
const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createRequestGuard } = require('./lib/request-guard');
const { createStore } = require('./lib/store');

const app = express();
app.disable('x-powered-by');
// 安全：控制面 API 能启停进程并执行项目启动命令，先校验 Host/Origin（挡 DNS rebinding 与跨站请求），再解析请求体
app.use(createRequestGuard());
app.use(express.json());
// 默认端口与 README / 页面提示保持一致（桌面版也从 3300 起找空闲；可用 PORT 覆盖）
const PORT = Number(process.env.PORT) || 3300;
const DATA_DIR = process.env.DEVDECK_DATA_DIR || __dirname;
// 打包后 static-serve 不走系统 node：exe 用户机器可能没装 Node，用 exe 内置的 Node 跑（ELECTRON_RUN_AS_NODE）
function packagedApp() {
  try { const er = require('electron'); return !!(er && er.app && er.app.isPackaged); } catch { return false; }
}
const BOOT_LOG = path.join(os.tmpdir(), 'devdeck-boot.log');
const NCPU = (os.cpus() || []).length || 1;

// ===================== node 进程采样（单条 CIM 查询，含 CPU 差分） =====================
// 一条 Get-CimInstance 拿全：pid / 命令行 / 内存 / 内核+用户 CPU 时间（100ns）；CPU% 用两次快照差分。
let nodeProcs = new Map(); // pid -> { command, memMB, cpu }
let nodeProcPrev = null; // { t, map: pid -> cpuSec }
// 采样降频：每次采样都要起一个 PowerShell（约数百 ms CPU），空闲 15s 一次足够；
// 有请求时最多每 10s 补采一次，保证看板刷新/诊断拿到的新鲜度，同时不回到"每 5s 起一次"的开销。
const SAMPLE_INTERVAL_MS = 15000;
const SAMPLE_MIN_GAP_MS = 10000;
let sampleInflight = false;
let lastSampleAt = 0;
function sampleNodeProcs() {
  if (process.platform !== 'win32') return;
  if (sampleInflight) return; // 上一轮 CIM 还没回来，别叠加进程
  sampleInflight = true;
  lastSampleAt = Date.now();
  try {
    exec('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'node.exe\' -or ($_.CommandLine -and $_.CommandLine.Contains(\'static-serve.js\')) } | Select-Object ProcessId,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress -Depth 2"',
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
        sampleInflight = false;
        try {
          if (e || !out) return;
          const now = Date.now(), cur = new Map(), cpuSec = {};
          for (const r of parseCimJson(out)) {
            const pid = Number(r.ProcessId); if (!pid) continue;
            const ws = Number(r.WorkingSetSize) || 0, kt = Number(r.KernelModeTime) || 0, ut = Number(r.UserModeTime) || 0;
            cur.set(pid, { command: String(r.CommandLine == null ? '' : r.CommandLine), memMB: ws / 1048576 });
            cpuSec[pid] = (kt + ut) / 1e7;
          }
          if (nodeProcPrev) {
            const dt = (now - nodeProcPrev.t) / 1000;
            if (dt > 0.5) for (const [pid, info] of cur) {
              const p = nodeProcPrev.map[pid];
              info.cpu = (p === undefined) ? 0 : Math.max(0, ((cpuSec[pid] - p) / dt / NCPU) * 100);
            }
          } else {
            for (const info of cur.values()) info.cpu = 0;
          }
          nodeProcs = cur;
          nodeProcPrev = { t: now, map: cpuSec };
        } catch {}
      });
  } catch (e) {
    sampleInflight = false;
    // 同步抛错（被安全软件拦截 / PowerShell 被策略禁用 / EPERM）不能让整个服务起不来
    try { fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} SAMPLE FAIL ${e && e.message}\n`); } catch {}
  }
}
function ensureFreshSample() { if (Date.now() - lastSampleAt >= SAMPLE_MIN_GAP_MS) sampleNodeProcs(); }
sampleNodeProcs();
setInterval(sampleNodeProcs, SAMPLE_INTERVAL_MS);

let cachedIps = [];
let cachedIpsAt = 0;
function localIps() {
  if (Date.now() - cachedIpsAt < 60000 && cachedIps.length) return cachedIps;
  try {
    const out = [];
    for (const arr of Object.values(os.networkInterfaces() || {})) {
      for (const n of arr || []) {
        if (n && n.family === 'IPv4' && !n.internal && !/^169\.254\./.test(n.address)) out.push(n.address);
      }
    }
    cachedIps = [...new Set(out)].slice(0, 4); cachedIpsAt = Date.now();
  } catch {}
  return cachedIps;
}

// ===================== 监听端口 =====================
let cachedNetstat = null;
let cachedNetstatAt = 0;
const NETSTAT_TTL = 4000;
function getListeningPorts() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    exec('netstat -ano', { maxBuffer: 8 * 1024 * 1024, timeout: 2500 }, (err, stdout) => {
      if (err) return resolve(null);
      const map = new Map();
      const re = /(TCP|UDP)\s+\[?[0-9a-fA-F:.]*\]?:(\d+)\s+\S+\s+LISTENING\s+(\d+)/gi;
      let m;
      while ((m = re.exec(stdout))) {
        const pid = parseInt(m[3], 10), port = parseInt(m[2], 10);
        if (pid && port) {
          if (!map.has(pid)) map.set(pid, new Set());
          map.get(pid).add(port);
        }
      }
      resolve(map);
    });
  });
}
function getListeningPortsCached() {
  if (cachedNetstat && Date.now() - cachedNetstatAt < NETSTAT_TTL) return Promise.resolve(cachedNetstat);
  return getListeningPorts().then(map => {
    if (map) { cachedNetstat = map; cachedNetstatAt = Date.now(); }
    return map;
  });
}
function dropNetstatCache() { cachedNetstat = null; cachedNetstatAt = 0; } // 写操作后立即失效：kill/start 后复查端口必须看到实时状态，不吃 4s 旧缓存

// ===================== 工具函数 =====================
function detectStack(cmd) {
  if (/static-serve/i.test(cmd || '')) return '静态页面';
  const c = (cmd || '').toLowerCase();
  if (c.includes('vite')) return 'Vite';
  if (c.includes('next')) return 'Next.js';
  if (c.includes('nuxt')) return 'Nuxt';
  if (c.includes('nest')) return 'NestJS';
  if (c.includes('turbo')) return 'Turborepo';
  if (c.includes('webpack')) return 'Webpack';
  if (c.includes('rollup')) return 'Rollup';
  if (c.includes('express')) return 'Express';
  if (c.includes('koa')) return 'Koa';
  return 'Node.js';
}
function extractName(cmd) {
  let m0 = String(cmd || '').match(/static-serve\.js["\s]+["\s]*([^"\s]+)/i);
  if (m0) { const b = m0[1].replace(/\\/g, '/').split('/').filter(Boolean); return '静态:' + (b[b.length - 1] || '页面'); }
  const c = cmd || '';
  let m = c.match(/_using_[^\\\"]*[\\\/]([\w.\-]+)/i);
  if (m) return m[1];
  m = c.match(/([\w.\-]+\.(?:js|cjs|mjs))/i);
  if (m) return m[1];
  m = c.match(/\\([\w-]+)\\bin\\[\w-]+\.js/i);
  if (m) return m[1];
  return 'node 服务';
}

// ===================== 运行中服务发现 =====================
async function buildNodeServices() {
  ensureFreshSample(); // 看板轮询触发补采（受 10s 最小间隔约束）
  try {
    const netstatMap = await getListeningPortsCached();
    if (!netstatMap || netstatMap.size === 0) return { services: [], localIps: localIps() };
    const services = [];
    for (const [pid, ports] of netstatMap.entries()) {
      const proc = nodeProcs.get(pid);
      if (!proc) continue;
      const command = proc.command || '';
      services.push({
        pid, name: pid === process.pid ? 'DevDeck（自身）' : extractName(command), command: command.slice(0, 180),
        stack: detectStack(command), ports: [...ports].sort((a, b) => a - b),
        mem: (proc.memMB || 0).toFixed(1), cpu: (proc.cpu || 0).toFixed(1), isSelf: pid === process.pid
      });
    }
    const ips = localIps();
    for (const s of services) {
      s.urls = [];
      for (const p of s.ports) {
        s.urls.push(`http://localhost:${p}/`);
        for (const ip of ips) s.urls.push(`http://${ip}:${p}/`);
      }
    }
    return { services: services.sort((a, b) => parseFloat(b.mem) - parseFloat(a.mem)), localIps: ips };
  } catch (e) { return null; }
}
app.get('/api/node-services', async (req, res) => {
  const r = await buildNodeServices();
  if (!r) return res.status(500).json({ error: '采集失败' });
  res.json(r);
});

// ===================== 终止服务（连带子进程树） =====================
async function killNodePid(pid) {
  pid = parseInt(pid, 10);
  if (!pid || !isFinite(pid)) return { error: '无效的 PID' };
  if (pid === process.pid) return { error: '不能终止 DevDeck 自身' };
  const netstatMap = await getListeningPortsCached();
  const isNode = nodeProcs.has(pid);
  const hasPort = !!(netstatMap && netstatMap.has(pid));
  if (!isNode || !hasPort) return { error: '该进程不在 node 项目服务列表中，已拒绝终止' };
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      exec(`taskkill /PID ${pid} /T /F`, (err, stdout, stderr) => {
        if (err) resolve({ error: `终止失败: ${stderr || err.message}` });
        else resolve({ ok: true, pid });
      });
    });
  }
  try {
    try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }, 3000);
    return { ok: true, pid };
  } catch (e) { return { error: e.message }; }
}
app.post('/api/kill-service', async (req, res) => {
  try {
    const pid = parseInt(req.body && req.body.pid, 10);
    if (!pid || !isFinite(pid)) return res.status(400).json({ error: '无效的 PID' });
    const r = await killNodePid(pid);
    if (r.error) {
      const code = /无效|自身|拒绝/.test(r.error) ? 400 : 500;
      return res.status(code).json({ error: r.error });
    }
    dropNetstatCache();
    res.json({ ok: true, pid: r.pid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===================== 本地项目 CRUD =====================
// 持久化交给 lib/store：原子写 + .bak + 损坏文件隔离，解析失败不再静默清零
const store = createStore(DATA_DIR, {
  log: msg => { try { fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} STORE ${msg}\n`); } catch {} }
});
function loadCustom() { return store.load(); }
function saveCustom(list) { store.save(list); }

app.get('/api/custom-projects', (req, res) => res.json(loadCustom()));
app.post('/api/custom-projects', (req, res) => {
  const { name, dir, cmd, port, stack } = req.body || {};
  if (!name || !dir || (!cmd && !/静态/.test(stack || ''))) return res.status(400).json({ error: '名称 / 启动目录 / 启动命令均必填' });
  if (port !== undefined && port !== null && port !== '') {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return res.status(400).json({ error: '端口号无效（需为 1-65535 的整数）' });
    const dup = loadCustom().find(x => Number(x.port) === p);
    if (dup) return res.status(400).json({ error: `端口 ${p} 已被自定义项目「${dup.name}」占用，请改用其他端口` });
  }
  const list = loadCustom();
  const item = {
    id: Date.now().toString(36), name: String(name).slice(0, 60),
    dir: String(dir), cmd: String(cmd),
    port: (port !== undefined && port !== null && port !== '') ? Number(port) : null,
    stack: (stack !== undefined && stack !== null && stack !== '') ? String(stack).slice(0, 30) : null,
    createdAt: Date.now()
  };
  list.push(item); saveCustom(list);
  res.json(item);
});
// ===================== 配置导入导出（网页 ↔ exe 迁移：两端 devdeck.json 口径一致，按 id 合并） =====================
app.get('/api/config/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="devdeck-config.json"');
  res.json({ app: 'devdeck', version: 1, exportedAt: new Date().toISOString(), items: loadCustom() });
});
app.post('/api/config/import', (req, res) => {
  const body = req.body || {};
  const arr = Array.isArray(body) ? body : body.items;
  if (!Array.isArray(arr)) return res.status(400).json({ error: '文件格式不对：需要 items 数组' });
  const cur = loadCustom();
  const byId = new Map(cur.map(x => [String(x.id), x]));
  const normDir = (d) => String(d || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const byDir = new Map(cur.map(x => [normDir(x.dir), x]));
  let added = 0, updated = 0, skipped = 0, merged = 0;
  const errs = [];
  for (const raw of arr.slice(0, 200)) {
    const name = String((raw && raw.name) || '').trim().slice(0, 60);
    const dir = String((raw && raw.dir) || '').trim();
    if (!name || !dir) { skipped++; continue; }
    let port = (raw && raw.port !== undefined && raw.port !== null && raw.port !== '') ? Number(raw.port) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) { errs.push(`「${name}」端口无效已跳过`); skipped++; continue; }
    const cmd = String((raw && raw.cmd) || '');
    const stack = raw && raw.stack ? String(raw.stack).slice(0, 30) : null;
    if (!cmd && !/静态/.test(stack || '')) { errs.push(`「${name}」缺启动命令已跳过`); skipped++; continue; }
    const id = raw && raw.id ? String(raw.id) : Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    if (byId.has(id)) { Object.assign(byId.get(id), { name, dir, cmd, port, stack }); updated++; }
    else if (byDir.has(normDir(dir))) { Object.assign(byDir.get(normDir(dir)), { name, dir, cmd, port, stack }); updated++; merged++; }
    else { const item = { id, name, dir, cmd, port, stack, createdAt: Date.now() }; cur.push(item); byId.set(id, item); byDir.set(normDir(dir), item); added++; }
  }
  try { saveCustom(cur); } catch (e) { return res.status(500).json({ error: '写入配置失败：' + e.message }); }
  res.json({ ok: true, added, updated, skipped, merged: merged || 0, errs: errs.slice(0, 10) });
});
app.delete('/api/custom-projects/:id', async (req, res) => {
  const item = loadCustom().find(x => x.id === req.params.id);
  const list = loadCustom().filter(x => x.id !== req.params.id);
  saveCustom(list);
  if (item) { try { await fs.promises.unlink(logPathFor(item)); } catch {} }
  res.json({ ok: true });
});
app.put('/api/custom-projects/:id', (req, res) => {
  const list = loadCustom();
  const idx = list.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '项目不存在' });
  const { name, dir, cmd, port, stack } = req.body || {};
  if (port !== undefined) {
    if (port === null || port === '') list[idx].port = null;
    else {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return res.status(400).json({ error: '端口号无效（需为 1-65535 的整数）' });
      const dup = list.find(x => x.id !== req.params.id && Number(x.port) === p);
      if (dup) return res.status(400).json({ error: `端口 ${p} 已被自定义项目「${dup.name}」占用` });
      list[idx].port = p;
    }
  }
  if (name !== undefined && name !== '') list[idx].name = String(name).slice(0, 60);
  if (dir !== undefined && dir !== '') list[idx].dir = String(dir);
  if (cmd !== undefined && cmd !== '') list[idx].cmd = String(cmd);
  if (stack !== undefined) list[idx].stack = stack ? String(stack).slice(0, 30) : null;
  saveCustom(list);
  res.json(list[idx]);
});

// ===================== 端口占用查询 =====================
async function findPortOwner(port) {
  try {
    const portNum = Number(port);
    let pid = null;
    const netstatMap = await getListeningPortsCached();
    if (netstatMap) { for (const [p, ports] of netstatMap.entries()) { if (ports.has(portNum)) { pid = p; break; } } }
    if (!pid) return null;
    const proc = nodeProcs.get(pid);
    const ownerProject = loadCustom().find(x => x.dir && proc && proc.command && String(proc.command).toLowerCase().includes(String(x.dir).toLowerCase()));
    return { pid, name: 'node 服务', isNode: !!proc, project: ownerProject ? ownerProject.name : null };
  } catch (e) { return null; }
}
/* 同进程树判定：启动器多为父进程（PowerShell/cmd 包装），实际监听端口的是子进程 node，
   直接比 PID 会误报“双跑或错位”。查祖先链：任一互为祖先即视为自家人 */
let ppidCache = null, ppidCacheAt = 0;
function getPpidMap() {
  return new Promise((resolve) => {
    if (ppidCache && Date.now() - ppidCacheAt < 10000) return resolve(ppidCache);
    if (process.platform !== 'win32') { ppidCache = new Map(); ppidCacheAt = Date.now(); return resolve(ppidCache); }
    exec('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"',
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
        const map = new Map();
        try {
          if (!e && out) for (const r of parseCimJson(out)) {
            if (Number(r.ProcessId)) map.set(Number(r.ProcessId), Number(r.ParentProcessId) || 0);
          }
        } catch {}
        ppidCache = map; ppidCacheAt = Date.now();
        resolve(map);
      });
  });
}
async function sameProcTree(p1, p2) {
  p1 = Number(p1); p2 = Number(p2);
  if (!p1 || !p2) return false;
  if (p1 === p2) return true;
  try {
    const map = await getPpidMap();
    for (const pair of [[p1, p2], [p2, p1]]) {
      let cur = pair[0], n = 0;
      while (cur && n++ < 12) { if (cur === pair[1]) return true; cur = map.get(cur); }
    }
  } catch {}
  return false;
}
/* 进程启动时刻（诊断实例画像：运行时长），失败返回空表不阻塞诊断 */
function procStartMap(pids) {
  const list = [...new Set((pids || []).map(Number).filter(Boolean))].slice(0, 20);
  if (!list.length || process.platform !== 'win32') return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const filter = list.map(p => `ProcessId=${p}`).join(' or ');
    exec('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-CimInstance Win32_Process -Filter \\"' + filter + '\\" | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress"',
      { timeout: 8000, maxBuffer: 1024 * 1024 }, (e, out) => {
        const map = new Map();
        try {
          if (!e && out) for (const r of parseCimJson(out)) {
            if (Number(r.ProcessId)) { const t = cimDate(r.CreationDate); if (t) map.set(Number(r.ProcessId), t); }
          }
        } catch {}
        resolve(map);
      });
  });
}
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '分';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '小时' + (m % 60 ? (m % 60) + '分' : '');
  return Math.floor(h / 24) + '天' + (h % 24 ? (h % 24) + '小时' : '');
}
function portBusyMsg(port, owner) {
  const who = owner.project ? `项目「${owner.project}」` : (owner.isNode ? `node 服务（PID ${owner.pid}）` : `进程（PID ${owner.pid}）`);
  return `端口 ${port} 已被 ${who} 占用。请先停止占用方，或修改本项目端口后再启动。`;
}
async function firstFreePort(from, range = 200) {
  let start = Number(from);
  if (!Number.isInteger(start) || start < 1 || start > 65535) start = 3000;
  for (let p = start; p < Math.min(start + range, 65536); p++) {
    const owner = await findPortOwner(p);
    if (!owner) return p;
  }
  return null;
}
app.get('/api/check-port', async (req, res) => {
  const p = Number(req.query.port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return res.status(400).json({ error: '端口号无效' });
  const owner = await findPortOwner(p);
  res.json({ port: p, free: !owner, owner });
});
app.get('/api/free-port', async (req, res) => {
  const p = await firstFreePort(req.query.from || 3000);
  if (!p) return res.status(404).json({ error: '附近 200 个端口都被占用' });
  res.json({ port: p });
});

// ===================== 项目启动（PowerShell 脱离进程树，窗口零弹出） =====================
function readScriptText(dir, cmd) {
  try {
    const m = String(cmd || '').match(/(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([^\s]+)/i);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir || '', 'package.json'), 'utf8'));
    return (pkg.scripts || {})[(m && m[1]) || ''] || '';
  } catch { return ''; }
}
function scriptUsesTurbo(dir, cmd) {
  try {
    const m = String(cmd || '').match(/(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([^\s]+)/i);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir || '', 'package.json'), 'utf8'));
    const script = (pkg.scripts || {})[(m && m[1]) || ''] || '';
    if (/turbo/i.test(script)) return true;
  } catch {}
  return /turbo/i.test(String(cmd || ''));
}

function launch(item) {
  const log = logPathFor(item);
  migrateLegacyLog(item);
  const port = Number(item.port) || 0;
  // cwd 不存在时 spawn 会异步报 ENOENT；提前判掉，给出可读错误而不是一条没头没尾的失败
  let dirStat = null;
  try { dirStat = item.dir ? fs.statSync(item.dir) : null; } catch {}
  if (!dirStat || !dirStat.isDirectory()) throw new Error('启动目录不存在或不是文件夹：' + (item.dir || '(未配置)'));
  // 端口透传链：pnpm serve -- -- --port → turbo → 任务 → vite 真正监听；
  // strictPort 让占位直接失败进日志，不静默漂到别的端口；
  // 以 root package.json 的 script 文本判断 turbo，不信表单 stack 字段；
  // --host 0.0.0.0 统一绑定，避免 127.0.0.1 与 0.0.0.0 同端口共存的访问混乱。
  let effCmd = item.cmd;
  const isStatic = /静态/.test(String(item.stack || ''));
  if (isStatic) {
    if (!port) throw new Error('静态页面需配置端口');
    // 打包后 static-serve.js 通过 asarUnpack 落在真实文件（asar 内路径 exe 直接跑不了），用 exe 内置 Node 执行；
    // 风险提示：旧安装包可能没 unpack（日志报 Cannot find module ...app.asar\static-serve.js），此处按候选逐个 existsSync 兜底，仍找不到则抛错进项目日志
    let srv = path.join(__dirname, 'static-serve.js');
    if (packagedApp()) {
      const cands = [
        path.join(process.resourcesPath, 'app.asar.unpacked', 'static-serve.js'),
        path.join(path.dirname(process.execPath), 'resources', 'app.asar.unpacked', 'static-serve.js'),
        path.join(process.resourcesPath, 'app.asar', 'static-serve.js'),
      ];
      srv = cands.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || cands[0];
    }
    if (!fs.existsSync(srv) && !/\.asar[\\/]/.test(srv)) throw new Error('找不到 static-serve.js：' + srv + '（旧版安装包未解包，请重装新版 exe）');
    effCmd = packagedApp()
      ? `set "ELECTRON_RUN_AS_NODE=1" && "${process.execPath}" "${srv}" "${item.dir}" ${port}`
      : `node "${srv}" "${item.dir}" ${port}`;
  }
  // 静态托管自己按位置参数收端口，不能再追加 --port（否则会污染命令行与进程识别）
  if (port && !isStatic && !/--port[=\s]|[\s-]p[=\s]?\d|PORT\s*=/.test(item.cmd)) {
    const scriptText = readScriptText(item.dir, item.cmd);
    const isVueCli = /vue-cli-service\s+serve/.test(scriptText);
    if (!isVueCli) {
      // vue-cli-service 只认 PORT/HOST 环境变量，绝不能拼 -- 参数（devServer v3 会将其当 entry 解析导致编译失败）
      // 透传分隔符随包管理器不同：npm / yarn / bun 会吞掉第一个 "--"，而 pnpm（8.x 实测）会把它原样透传给脚本，
      // 于是 vite 收到的第一个参数成了 "--"，其后的 --port/--strictPort 全被当成位置参数，端口配置静默失效、
      // 回落到默认 5173，再撞上别的项目的配置端口，最终被前端错认成别的项目名。pnpm 不加 "--" 即可。
      const sep = /^\s*pnpm(\s|$)/i.test(item.cmd) ? ' ' : ' -- ';
      const turbo = scriptUsesTurbo(item.dir, item.cmd);
      if (turbo) {
        const hostFlag = /--host[=\s]/.test(item.cmd) ? '' : ' --host 0.0.0.0';
        effCmd += `${sep}-- --port ${port} --strictPort${hostFlag}`; // turbo 还要再吃掉一层 "--" 才轮到任务
      } else {
        effCmd += `${sep}--port ${port} --strictPort`;
      }
    }
  }
  const prefix = port ? `set "PORT=${port}" && ` : '';
  const hostPrefix = (port && /vue-cli-service\s+serve/.test(readScriptText(item.dir, item.cmd)) && !/HOST\s*=/.test(item.cmd)) ? 'set "HOST=0.0.0.0" && ' : '';
  const fullCmd = `chcp 65001 >nul && ${prefix}${hostPrefix}${effCmd} >> "${log}" 2>&1`; // chcp 65001：cmd 默认 GBK 出中文，改 UTF-8 落盘
  const psScript = 'Start-Process -FilePath \'cmd.exe\' -ArgumentList \'/d\',\'/s\',\'/c\',\'' +
    fullCmd.replace(/'/g, "''") + '\' -WorkingDirectory \'' + item.dir.replace(/'/g, "''") +
    '\' -WindowStyle Hidden';
  const psB64 = Buffer.from(psScript, 'utf16le').toString('base64');
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', psB64], {
      cwd: item.dir, windowsHide: true, stdio: 'ignore'
    });
  } catch (e) {
    throw new Error('启动器进程创建失败：' + ((e && e.message) || e));
  }
  // 异步错误（ENOENT/EPERM/被安全软件拦截）必须有人接，否则会变成未捕获异常
  child.on('error', (e) => {
    try { fs.appendFileSync(log, `\n[devdeck] 启动器进程异常：${(e && e.message) || e}\n`); } catch {}
  });
  if (!child.pid) throw new Error('启动器进程创建失败（powershell.exe 不可用？详见项目日志）');
  child.unref();
  return child;
}
app.post('/api/start-project', async (req, res) => {
  const { id } = req.body || {};
  const item = loadCustom().find(x => x.id === id);
  if (!item) return res.status(404).json({ error: '项目不存在' });
  if (item.port) {
    const owner = await findPortOwner(item.port);
    if (owner) return res.status(409).json({ error: portBusyMsg(item.port, owner), suggestPort: await firstFreePort(item.port) });
  }
  try {
    const child = launch(item);
    dropNetstatCache();
    res.json({ ok: true, pid: child.pid, name: item.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/start-all', async (req, res) => {
  const ids = (req.body && req.body.ids) || null;
  const list = loadCustom().filter(x => !ids || ids.includes(x.id));
  const results = [];
  for (const item of list) {
    if (item.port) {
      const owner = await findPortOwner(item.port);
      if (owner) { results.push({ id: item.id, name: item.name, ok: false, error: portBusyMsg(item.port, owner), suggestPort: await firstFreePort(item.port) }); continue; }
    }
    try {
      const child = launch(item);
      results.push({ id: item.id, name: item.name, pid: child.pid, ok: true });
    } catch (e) { results.push({ id: item.id, name: item.name, ok: false, error: e.message }); }
  }
  dropNetstatCache();
  res.json(results);
});

// ===================== 运行日志管理 =====================
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_BYTES = 1 * 1024 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_CLEAN_MS = 10 * 60 * 1000;
// 日志不再写进用户项目目录（避免污染业务仓库 / 触发它们的 git 状态）：
// 统一放 DATA_DIR/logs（源码版=仓库 logs/，EXE=userData/logs），旧位置首次访问时自动迁移。
const LOG_DIR = path.join(DATA_DIR, 'logs');
function ensureLogDir() { try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {} }
ensureLogDir();

function logPathFor(item) {
  const safe = String(item.id || 'x').replace(/[^a-zA-Z0-9_-]/g, '') || 'x';
  return path.join(LOG_DIR, `${safe}.log`);
}
function migrateLegacyLog(item) {
  // 旧版日志在项目目录：.devdeck-{id}.log（本工具）与 .cmp-start*.log（CMP 遗留），首次访问时搬到 LOG_DIR
  try {
    if (!item || !item.dir) return;
    ensureLogDir();
    const cur = logPathFor(item);
    if (fs.existsSync(cur)) return;
    const safe = String(item.id || 'x').replace(/[^a-zA-Z0-9_-]/g, '') || 'x';
    const cands = [
      path.join(item.dir, `.devdeck-${safe}.log`),
      path.join(item.dir, '.cmp-start.log'),
      path.join(item.dir, `.cmp-start-${safe}.log`)
    ];
    for (const legacy of cands) {
      try {
        if (legacy !== cur && fs.existsSync(legacy)) { fs.renameSync(legacy, cur); return; }
      } catch {}
    }
  } catch {}
}
function stripAnsi(t) { return String(t == null ? '' : t).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[0-9]+(;[0-9]+)*m/g, ''); }
/* CIM 一律走 ConvertTo-Json 解析：CSV 遇命令含逗号/双引号会字段错位，JSON 无此问题。
   兼容单对象/数组两种形状；PS 5.1 的 /Date(…)/ 与 PS7 的 ISO 时间都认。 */
function parseCimJson(out) {
  try {
    const j = JSON.parse(String(out == null ? '' : out).trim());
    return (Array.isArray(j) ? j : [j]).filter(x => x && typeof x === 'object');
  } catch { return []; }
}
function cimDate(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 0 ? v : 0;
  const m = String(v).match(/Date\((-?\d+)/);
  if (m) { const t = Number(m[1]); return t > 0 ? t : 0; }
  const t = new Date(v).getTime();
  return t > 0 ? t : 0;
}
async function readTail(file, n) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const stat = await fh.stat();
    const len = Math.min(stat.size, n);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, stat.size - len);
    let text = buf.toString('utf8');
    if (stat.size > n) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    return { text, size: stat.size, mtime: stat.mtime };
  } finally { await fh.close(); }
}
async function trimLog(file) {
  try {
    const st = await fs.promises.stat(file);
    if (st.size <= LOG_MAX_BYTES) return false;
    const { text } = await readTail(file, LOG_KEEP_BYTES);
    await fs.promises.writeFile(file, text, 'utf8');
    return true;
  } catch { return false; }
}
async function cleanLogs() {
  const items = loadCustom();
  await Promise.all(items.map(async (i) => { await trimLog(logPathFor(i)); }));
  // 孤儿日志（项目已删除）保留 30 天后清理；日志已集中存放，不再需要靠删日志腾项目目录
  try {
    const keep = new Set(items.map(i => path.basename(logPathFor(i))));
    for (const f of await fs.promises.readdir(LOG_DIR)) {
      if (!/\.log$/i.test(f) || keep.has(f)) continue;
      const fp = path.join(LOG_DIR, f);
      const st = await fs.promises.stat(fp).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 30 * 24 * 3600 * 1000) await fs.promises.unlink(fp).catch(() => {});
    }
  } catch {}
}
setTimeout(cleanLogs, 30 * 1000);
setInterval(cleanLogs, LOG_CLEAN_MS);

app.get('/api/start-log', async (req, res) => {
  const item = loadCustom().find(x => x.id === req.query.id);
  if (!item) return res.status(404).json({ error: '项目不存在' });
  migrateLegacyLog(item); // 旧版日志在项目目录，先搬过来再读
  const log = logPathFor(item);
  if (!fs.existsSync(log)) return res.json({ exists: false, lines: [], hint: '还没有日志：命令可能尚未执行，或进程启动即退出。请先点"启动"。' });
  try {
    const { text, size, mtime } = await readTail(log, LOG_TAIL_BYTES);
    res.json({ exists: true, lines: text.split(/\r?\n/).slice(-80), size, mtime });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 日志实时流 SSE
app.get('/api/start-log/stream', async (req, res) => {
  const item = loadCustom().find(x => x.id === req.query.id);
  if (!item) { res.status(404).end(); return; }
  migrateLegacyLog(item);
  const log = logPathFor(item);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  let lastSize = fs.existsSync(log) ? fs.statSync(log).size : 0;
  const timer = setInterval(async () => {
    try {
      if (!fs.existsSync(log)) { res.write('event: waiting\ndata: {"exists":false}\n\n'); return; }
      const st = fs.statSync(log);
      if (st.size === lastSize) return;
      if (st.size < lastSize) { lastSize = st.size; return; } // 日志被瘦身裁短：重置偏移，否则负长度 Buffer 抛错被吞、流永久卡死
      const fh = await fs.promises.open(log, 'r');
      const buf = Buffer.alloc(st.size - lastSize);
      await fh.read(buf, 0, buf.length, lastSize);
      await fh.close();
      lastSize = st.size;
      res.write(`event: line\ndata: ${JSON.stringify({ text: buf.toString('utf8') })}\n\n`);
    } catch {}
  }, 800);
  req.on('close', () => clearInterval(timer));
});

app.delete('/api/start-log', async (req, res) => {
  const item = loadCustom().find(x => x.id === req.query.id);
  if (!item) return res.status(404).json({ error: '项目不存在' });
  try {
    await fs.promises.unlink(logPathFor(item));
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return res.json({ ok: true, note: '日志本就不存在' });
    res.status(500).json({ error: e.message });
  }
});

// ===================== 项目探测（新增表单：填目录后自动识别名称/架构/端口/命令） =====================
app.get('/api/inspect', (req, res) => {
  const dir = req.query.dir || '';
  if (!dir) return res.status(400).json({ error: '缺少目录参数' });
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '目录不存在：' + dir });
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    try {
      const files = fs.readdirSync(dir);
      if (files.some(f => /\.html?$/i.test(f))) {
        return res.json({ name: dir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '静态页面', stack: '静态页面', defaultPort: null, cmdCandidates: [], packageManager: null, isStatic: true });
      }
    } catch {}
    return res.status(404).json({ error: '该目录没有 package.json，也没有 HTML 文件' });
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
    const scripts = pkg.scripts || {};
    const scriptNames = Object.keys(scripts);
    let stack = 'Node.js';
    if (deps.vite || /vite/i.test(scripts.serve || '') || /vite/i.test(scripts.dev || '')) stack = 'Vite';
    else if (deps.next) stack = 'Next.js';
    else if (deps.nuxt) stack = 'Nuxt';
    else if (deps['@nestjs/core']) stack = 'NestJS';
    else if (deps.turbo || (pkg.packageManager || '').includes('turbo')) stack = 'Turborepo';
    else if (deps.webpack || deps['@vue/cli-service'] || /vue-cli-service/i.test(scripts.serve || '')) stack = 'Webpack';
    else if (deps.rollup) stack = 'Rollup';
    else if (deps.express) stack = 'Express';
    else if (deps.koa) stack = 'Koa';
    let defaultPort = null;
    if (stack === 'Vite') defaultPort = 5173;
    else if (stack === 'Next.js' || stack === 'Nuxt' || stack === 'NestJS' || stack === 'Express') defaultPort = 3000;
    const cmdAll = [scripts.dev, scripts.serve, scripts.start].filter(Boolean).join(' ');
    const pm = cmdAll.match(/--port[=\s](\d+)|-p[=\s](\d+)|PORT=(\d+)/i);
    if (pm) defaultPort = parseInt(pm[1] || pm[2] || pm[3], 10);
    let strictPort = false;
    for (const f of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
      const fp = path.join(dir, f);
      if (!fs.existsSync(fp)) continue;
      try {
        const txt = fs.readFileSync(fp, 'utf8');
        const m = txt.match(/port\s*:\s*(\d{2,5})/);
        if (m) defaultPort = parseInt(m[1], 10);
        if (/strictPort\s*:\s*true/.test(txt)) strictPort = true;
      } catch {}
      break;
    }
    let pmName = 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) pmName = 'yarn';
    else if (fs.existsSync(path.join(dir, 'package-lock.json'))) pmName = 'npm';
    const runners = pmName === 'yarn' ? ['yarn', 'pnpm', 'npm run'] : pmName === 'npm' ? ['npm run', 'pnpm', 'yarn'] : ['pnpm', 'npm run', 'yarn'];
    const cmds = [];
    for (const k of ['serve', 'dev', 'start']) {
      if (!scripts[k]) continue;
      for (const r of runners) { cmds.push(`${r} ${k}`); if (cmds.length >= 5) break; }
      if (cmds.length >= 5) break;
    }
    if (!cmds.length) for (const k of scriptNames.slice(0, 5)) cmds.push(`${runners[0]} ${k}`);
    if (!cmds.length) {
      if (fs.existsSync(path.join(dir, 'vite.config.js')) || fs.existsSync(path.join(dir, 'vite.config.ts'))) cmds.push(`${pmName} dev`);
      else if (fs.existsSync(path.join(dir, 'src', 'index.js')) || fs.existsSync(path.join(dir, 'index.js'))) cmds.push(`${pmName} start`);
    }
    res.json({ name: pkg.name || '', stack, defaultPort, strictPort, scripts: scriptNames, cmdCandidates: cmds.slice(0, 6), packageManager: pmName });
  } catch (e) { res.status(400).json({ error: 'package.json 解析失败: ' + e.message }); }
});

// ===================== 服务端目录浏览（内置文件选择器：不经过系统上传框，返回真实绝对路径） =====================
app.get('/api/browse-dir', (req, res) => {
  let dir = (req.query.dir || '').trim();
  try {
    if (!dir) {
      if (process.platform === 'win32') {
        const drives = [];
        for (let c = 65; c <= 90; c++) {
          const d = String.fromCharCode(c) + ':\\';
          try { fs.accessSync(d); drives.push(d); } catch {}
        }
        return res.json({ dir: '', parent: null, drives, entries: [] });
      }
      dir = process.env.USERPROFILE || process.env.HOME || '/';
    }
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return res.status(400).json({ error: '不是目录：' + dir });
    const full = path.resolve(dir);
    const entries = [];
    for (const n of fs.readdirSync(full)) {
      if (n.startsWith('.')) continue;
      try {
        entries.push({ name: n, isDir: fs.statSync(path.join(full, n)).isDirectory() });
      } catch {}
    }
    entries.sort((a, b) => ((b.isDir ? 1 : 0) - (a.isDir ? 1 : 0)) || a.name.localeCompare(b.name, 'zh-CN'));
    const parent = path.dirname(full) === full ? null : path.dirname(full);
    res.json({ dir: full, parent, entries: entries.slice(0, 500) });
  } catch (e) { res.status(400).json({ error: '目录读取失败：' + e.message }); }
});

// ===================== 辅助诊断（规则引擎，不依赖 LLM：日志尾部 + 端口 + 进程） =====================
app.post('/api/diagnose', async (req, res) => {
  try {
    ensureFreshSample(); // 诊断结论依赖最新的进程/端口画像
    const { id } = req.body || {};
    const item = loadCustom().find(x => x.id === id);
    if (!item) return res.status(404).json({ error: '项目不存在' });
    const evidence = { project: item, timestamp: new Date().toISOString() };
    const dirLow = String(item.dir || '').toLowerCase();
    // 0. 配置与依赖健康
    evidence.dirExists = !!(item.dir && fs.existsSync(item.dir));
    const pkgPath = item.dir ? path.join(item.dir, 'package.json') : '';
    evidence.hasPkg = !!(pkgPath && fs.existsSync(pkgPath));
    evidence.hasNodeModules = !!(item.dir && fs.existsSync(path.join(item.dir, 'node_modules')));
    evidence.isStatic = /静态/.test(String(item.stack || ''));
    // 1. 日志画像（12KB，近 80 行）：错误计数 + 关键样本，而非整段堆砌
    const log = logPathFor(item);
    evidence.hasLog = fs.existsSync(log);
    const profile = { eaddr: 0, noModule: [], errors: 0, depWarn: 0, ready: false, readyMs: null, errSamples: [] };
    if (fs.existsSync(log)) {
      try {
        const { text, size, mtime } = await readTail(log, 12 * 1024);
        const lines = text.split(/\r?\n/).slice(-80).map(stripAnsi);
        evidence.logTail = lines.slice(-40);
        evidence.logSize = size; evidence.logMtime = mtime;
        const mods = new Set();
        for (const l of lines) {
          if (/EADDRINUSE|address already in use/i.test(l)) profile.eaddr++;
          const mm = l.match(/cannot find module '([^']+)'/i);
          if (mm && mods.size < 5) mods.add(mm[1]);
          if (/DEPRECATION WARNING/i.test(l)) { profile.depWarn++; continue; }
          if (/ready in (\d+)\s*ms/i.test(l)) { profile.ready = true; profile.readyMs = Number(RegExp.$1); }
          if (/Local:\s+https?:\/\//i.test(l)) profile.ready = true;
          if (/error|EADDRINUSE|failed|cannot find|ERR_/i.test(l) && profile.errSamples.length < 5) profile.errSamples.push(l.slice(0, 200));
        }
        profile.errors = profile.errSamples.length;
        profile.noModule = [...mods];
      } catch {}
    } else evidence.logTail = ['(无日志文件)'];
    evidence.logProfile = profile;
    // 2. 端口占用
    let owner = null;
    if (item.port) {
      owner = await findPortOwner(item.port);
      evidence.portStatus = { port: item.port, occupied: !!owner, owner: owner || null };
    } else evidence.portStatus = null;
    // 3. 进程实例分析：先按命令行圈定同目录进程，再按进程树聚类——父子/祖孙归为同一实例，
    //    互无关联的才算独立实例。单项目正常就有 2~3 个 node 进程（包管理器包装 + 服务本体），数个数判双跑必误报
    const group = [];
    if (item.dir) {
      for (const [pid, p] of nodeProcs) {
        if (String(p.command || '').toLowerCase().includes(dirLow)) {
          group.push({ pid, mem: Number((p.memMB || 0).toFixed(1)), cpu: Number(((p.cpu || 0)).toFixed(1)), cmd: String(p.command || '').slice(0, 160) });
        }
      }
    }
    let netmap = null;
    try { netmap = await getListeningPortsCached(); } catch {}
    const portsOf = (pid) => (netmap && netmap.get(pid)) ? [...netmap.get(pid)] : [];
    const inGroup = new Set(group.map(g => g.pid));
    let ppidMap = new Map();
    try { ppidMap = await getPpidMap(); } catch {}
    // 上溯整条祖先链（含 cmd/ps 等非 node 中间层）：链上遇到的组内最高成员即树根，避免中间层把一家人拆散
    const treeRoot = (pid) => { let cur = pid, root = pid, guard = 0; const seen = new Set([pid]); while (guard++ < 25) { const par = ppidMap.get(cur); if (!par || par === cur || seen.has(par)) break; seen.add(par); cur = par; if (inGroup.has(cur)) root = cur; } return root; };
    const treeMap = new Map();
    group.forEach(g => { const r = treeRoot(g.pid); if (!treeMap.has(r)) treeMap.set(r, []); treeMap.get(r).push(g); });
    const roleOf = (cmd) => {
      const c = String(cmd || '').toLowerCase();
      if (/static-serve\.js/.test(c)) return '静态托管';
      if (/vite/.test(c)) return 'Vite 服务';
      if (/next-server|next[\\/]dist/.test(c)) return 'Next 服务';
      if (/turbo/.test(c)) return 'Turbo 编排';
      if (/pnpm|npm-cli|yarn|bun/.test(c)) return '包管理器包装';
      return 'Node 进程';
    };
    let startMap = new Map();
    try { startMap = await procStartMap(group.map(g => g.pid)); } catch {}
    const nowTs = Date.now();
    const instances = [...treeMap.entries()].map(([root, members]) => {
      const ports = new Set(); members.forEach(m => portsOf(m.pid).forEach(p => ports.add(p)));
      const listeners = members.filter(m => portsOf(m.pid).length).map(m => m.pid);
      const roles = [...new Set(members.map(m => roleOf(m.cmd)))];
      const starts = members.map(m => startMap.get(m.pid)).filter(Boolean);
      const oldest = starts.length ? Math.min(...starts) : null;
      return { root, count: members.length, pids: members.map(m => m.pid), listeners, ports: [...ports].sort((a, b) => a - b), roles, uptime: oldest ? fmtDur(nowTs - oldest) : '—' };
    });
    // 主实例：优先占着配置端口的那棵树
    instances.sort((a, b) => {
      const ap = item.port && a.ports.includes(Number(item.port)) ? 0 : 1;
      const bp = item.port && b.ports.includes(Number(item.port)) ? 0 : 1;
      return ap - bp || b.count - a.count;
    });
    const actualSet = new Set();
    group.forEach(g => portsOf(g.pid).forEach(p => actualSet.add(p)));
    let hit = null;
    if (instances.length) {
      const t0 = instances[0];
      const g0 = group.find(g => g.pid === t0.root) || group[0];
      hit = { pid: t0.root, mem: g0.mem.toFixed(1), cpu: g0.cpu.toFixed(1) };
    }
    try {
      if (!hit && item.port && netmap) {
        for (const [pid, ports] of netmap) {
          if (ports.has(Number(item.port))) {
            const p = nodeProcs.get(pid);
            hit = { pid, mem: p ? p.memMB.toFixed(1) : '?', cpu: p && p.cpu ? p.cpu.toFixed(1) : '?' };
            portsOf(pid).forEach(x => actualSet.add(x));
            break;
          }
        }
      }
    } catch {}
    evidence.group = group.map(g => ({ pid: g.pid, mem: g.mem, cpu: g.cpu }));
    evidence.instances = instances;
    evidence.actualPorts = [...actualSet].sort((a, b) => a - b);
    evidence.processRunning = !!hit;
    evidence.process = hit;
    // 4. 结构化结论：每条含等级/标题/依据/可执行动作，前端直接渲染为操作卡
    const F = [];
    const push = (level, title, detail, actions) => F.push({ level, title, detail: detail || '', actions: actions || [] });
    const ACT_LOG = [{ act: 'open-log', label: '查看完整日志', cls: 'btn-ghost' }];
    const ownerPid = owner && owner.pid;
    let ownerIsOurs = false;
    if (owner && evidence.processRunning && hit) {
      const ownerProc = nodeProcs.get(ownerPid);
      const ownerSameDir = !!(item.dir && ownerProc && ownerProc.command && String(ownerProc.command).toLowerCase().includes(dirLow));
      // 同组但分属不同独立实例不算自家人（真双跑时第二棵树也含目录关键字）
      const ownerInOwnTree = ownerPid && instances.length === 1 && inGroup.has(ownerPid);
      ownerIsOurs = ownerPid === hit.pid || owner.project === item.name || ownerSameDir && instances.length <= 1 || ownerInOwnTree || await sameProcTree(ownerPid, hit.pid);
    }
    const ownerDesc = owner ? `${owner.project ? `项目「${owner.project}」` : '未知进程'}（PID ${ownerPid}）` : '';
    const killActs = ownerPid ? [{ act: 'kill-owner', label: `终止占用者 PID ${ownerPid}`, cls: 'btn-red' }] : [];
    // —— 配置与依赖
    if (!item.dir) push('error', '未配置启动目录', '请先编辑项目补上启动目录。', [{ act: 'edit', label: '去编辑', cls: 'btn-blue' }]);
    else if (!evidence.dirExists) push('error', '启动目录不存在', `“${item.dir}”不存在（目录被移动/删除，或盘符变化）。`, [{ act: 'edit', label: '去修正', cls: 'btn-blue' }]);
    if (evidence.dirExists && !evidence.hasPkg && !evidence.isStatic) push('warn', '目录下没有 package.json', '多半选错了层级（多套/少进一层）。点本地项目“📁 浏览”重新定位到项目根。', ACT_LOG);
    if (evidence.hasPkg && !evidence.hasNodeModules && !evidence.isStatic && !profile.noModule.length) push('error', '依赖未安装（缺 node_modules）', '此时启动必报 cannot find module，先装依赖。', [{ act: 'install', label: '一键安装依赖', cls: 'btn-blue' }, ...ACT_LOG]);
    // —— 进程存活
    if (!evidence.processRunning) {
      // 未运行≠故障：按证据分级——日志有报错才是 error，否则只是“没启动”
      const START_ACT = [{ act: 'start', label: '▶ 启动该项目', cls: 'btn-green' }];
      if (profile.eaddr || profile.noModule.length || profile.errSamples.length) {
        const hint = profile.errSamples.length ? `日志末条报错：${profile.errSamples[profile.errSamples.length - 1]}` : '曾有端口冲突或缺模块记录。';
        push('error', '进程未运行（日志中有报错）', hint, [...START_ACT, ...ACT_LOG]);
      } else if (evidence.hasLog && profile.ready) {
        push('warn', '进程已退出', '此前运行正常（日志有就绪记录），可能是手动停止或崩溃后退出，可直接再启动。', [...START_ACT, ...ACT_LOG]);
      } else {
        push('info', '项目当前未启动', evidence.hasLog ? '日志无报错，点启动即可运行。' : '从无运行记录，点启动开始运行。', [...START_ACT, ...ACT_LOG]);
      }
    } else {
      // 实例数>1 时再分两种：多个实例都在监听才是真双跑（error）；多余的不占端口多半是旧包装残留（info）
      const withPorts = instances.filter(t => t.ports.length);
      if (withPorts.length > 1) {
        const desc = instances.map((t, i) => `实例${i + 1}：树根 PID ${t.root}（${t.roles.join('/')}，${t.count} 个进程，运行 ${t.uptime}，监听 ${t.ports.length ? t.ports.map(x => ':' + x).join('、') : '无端口'}）`).join('\n');
        const killActs = withPorts.slice(1).map(t => ({ act: 'kill-pid', arg: t.listeners[0] || t.root, label: `终止多余实例（PID ${t.listeners[0] || t.root}）`, cls: 'btn-red' }));
        push('error', `真双跑：${withPorts.length} 个实例同时在监听`, `${desc}\n同一目录多个互无关联的进程树都在占端口，请求会被随机分到不同实例。保留主实例（实例1），终止多余。`, [...killActs, { act: 'goto-run', label: '去运行中服务核对', cls: 'btn-blue' }, ...ACT_LOG]);
      } else if (instances.length > 1) {
        const desc = instances.map((t, i) => `实例${i + 1}：树根 PID ${t.root}（${t.roles.join('/')}，运行 ${t.uptime}，监听 ${t.ports.length ? t.ports.map(x => ':' + x).join('、') : '无端口'}）`).join('\n');
        push('info', '同目录有多余进程，但均未监听端口', `${desc}\n多半是旧包装进程残留或启动器中间层，不影响当前服务。介意可到运行中服务清理。`, [{ act: 'goto-run', label: '去运行中服务查看', cls: 'btn-blue' }, ...ACT_LOG]);
      } else if (owner && ownerPid !== (hit && hit.pid) && ownerIsOurs && instances.length) {
        const t = instances[0];
        push('info', '单实例运行，端口由子进程监听', `进程树共 ${t.count} 个进程（${t.roles.join(' + ')}），:${item.port} 由 PID ${ownerPid} 监听，树根 PID ${t.root}。父拉子监听是常规形态。`, ACT_LOG);
      }
      if (hit && Number(hit.cpu) > 85) push('warn', `CPU 偏高（${hit.cpu}%，单次采样）`, '若持续居高，多半是死循环或轮询过密，结合日志确认。', ACT_LOG);
      if (hit && parseFloat(hit.mem) > 1500) push('warn', `内存偏高（${hit.mem}M）`, 'Vite 大项目 dev 常驻数百 M 属正常，超 1.5G 留意泄漏，可重启释放。', ACT_LOG);
    }
    // —— 端口归属
    if (owner && !owner.project && !ownerIsOurs) push('error', `端口 ${item.port} 被异主占用`, `占用者：${ownerDesc}。先停对方，或给本项目换端口。`, [...killActs, { act: 'free-port', label: '换空闲端口并重启', cls: 'btn-blue' }, ...ACT_LOG]);
    if (owner && evidence.processRunning && ownerPid !== (hit && hit.pid) && !ownerIsOurs) push('error', `端口 ${item.port} 错位`, `占用者 ${ownerDesc} 不是本项目进程（PID ${hit && hit.pid}）。`, [...killActs, { act: 'free-port', label: '换空闲端口并重启', cls: 'btn-blue' }, ...ACT_LOG]);
    // 归属正常时的说明由单实例/多实例分支输出（带进程树画像），此处不再重复，避免结论互掐
    // 日志×现状互证：历史报错要和当前状态对上，不各说各话
    if (profile.eaddr) {
      if (owner && owner.project && owner.project !== item.name) push('error', `端口被「${owner.project}」占用（日志 EADDRINUSE ×${profile.eaddr}）`, `当前占用者与日志中的冲突一致：上次启动就是被它抢占失败。停对方，或给本项目换端口。`, [...killActs, { act: 'free-port', label: '换空闲端口并重启', cls: 'btn-blue' }, ...ACT_LOG]);
      else if (!owner) push('warn', '日志有 EADDRINUSE 记录，但端口当前空闲', '属历史冲突，占用者已退出，可直接启动。', [{ act: 'start', label: '▶ 启动该项目', cls: 'btn-green' }, ...ACT_LOG]);
      else push('info', '日志有 EADDRINUSE 历史记录', '当前端口归属正常，属此前某次启动的冲突残留，可忽略。', ACT_LOG);
    }
    if (profile.noModule.length) {
      const mods = profile.noModule.slice(0, 3).join('、') + (profile.noModule.length > 3 ? ' 等' : '');
      if (!evidence.hasNodeModules && !evidence.isStatic) push('error', `缺模块：${mods}`, '依赖缺失或安装不完整。', [{ act: 'install', label: '一键安装依赖', cls: 'btn-blue' }, ...ACT_LOG]);
      else push('info', '日志中的缺模块可能是历史记录', `当时缺：${mods}；当前 node_modules 已存在。若再次报缺模块再重装。`, ACT_LOG);
    }
    // —— 配置漂移：配了 X，实际在听 Y（如 Vite 非 strictPort 漂移）
    if (item.port && evidence.actualPorts.length && !evidence.actualPorts.includes(Number(item.port))) {
      const ap = evidence.actualPorts[0];
      push('warn', `配置漂移：配了 :${item.port}，实际在听 :${ap}`, '启动命令没钉死端口（多半缺 --strictPort），服务漂到了别的口。建议把配置改成实际端口，或重启让其回到配置端口。', [{ act: 'adopt-port', label: `改配置为 :${ap}`, cls: 'btn-blue' }, ...ACT_LOG]);
    }
    if (profile.depWarn && !F.some(f => f.level === 'error')) push('info', `有 ${profile.depWarn} 条 DeprecationWarning`, '多为 Sass legacy API 之类上游警告，不影响运行，升级依赖可消。', ACT_LOG);
    if (!F.length) push('ok', '一切正常', '进程在运行、端口归属一致、依赖齐全、日志无错误关键字。', ACT_LOG);
    const summary = {
      status: F.some(f => f.level === 'error') ? 'error' : (F.some(f => f.level === 'warn') ? 'warn' : 'ok'),
      err: F.filter(f => f.level === 'error').length,
      warn: F.filter(f => f.level === 'warn').length,
      info: F.filter(f => f.level === 'info').length
    };
    res.json({ evidence, findings: F, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===================== 一键安装依赖（诊断联动：缺 node_modules 时后台执行，进度进项目日志） =====================
app.post('/api/install-deps', async (req, res) => {
  try {
    const { id } = req.body || {};
    const item = loadCustom().find(x => x.id === id);
    if (!item) return res.status(404).json({ error: '项目不存在' });
    if (!item.dir || !fs.existsSync(item.dir)) return res.status(400).json({ error: '启动目录不存在' });
    if (!fs.existsSync(path.join(item.dir, 'package.json'))) return res.status(400).json({ error: '没有 package.json，无需安装' });
    let pm = 'pnpm';
    if (fs.existsSync(path.join(item.dir, 'yarn.lock'))) pm = 'yarn';
    else if (fs.existsSync(path.join(item.dir, 'package-lock.json'))) pm = 'npm';
    else if (fs.existsSync(path.join(item.dir, 'bun.lockb'))) pm = 'bun';
    const log = logPathFor(item);
    ensureLogDir();
    try { fs.appendFileSync(log, `\n[devdeck] ${new Date().toLocaleString('zh-CN', { hour12: false })} 开始 ${pm} install\n`); } catch {}
    if (process.platform === 'win32') {
      const fullCmd = `chcp 65001 >nul && ${pm} install >> "${log}" 2>&1`;
      const psScript = 'Start-Process -FilePath \'cmd.exe\' -ArgumentList \'/d\',\'/s\',\'/c\',\'' +
        fullCmd.replace(/'/g, "''") + '\' -WorkingDirectory \'' + item.dir.replace(/'/g, "''") +
        '\' -WindowStyle Hidden';
      const psB64 = Buffer.from(psScript, 'utf16le').toString('base64');
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', psB64], {
        cwd: item.dir, windowsHide: true, stdio: 'ignore'
      });
      child.unref();
    } else {
      const child = spawn(pm, ['install'], { cwd: item.dir, detached: true, stdio: 'ignore' });
      child.unref();
    }
    res.json({ ok: true, pm });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===================== 启动 =====================
app.use(express.static(path.join(__dirname, 'public')));

let server = null;
// 安全：控制面只绑回环地址。同机前端/Electron 走 localhost；页面上平铺的局域网 URL 是各 dev server
// 自带的监听地址（手机可访问），DevDeck 自身的 kill/log/配置 API 不再暴露给同网段。如需远程管理请走 SSH 端口转发。
// 测试用：DEVDECK_NO_LISTEN=1 时只导出 app，由测试自己 listen(0) 拿随机端口。
if (process.env.DEVDECK_NO_LISTEN !== '1') {
  server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`DevDeck 已启动：http://127.0.0.1:${PORT}（仅本机可访问）`);
    try { fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} LISTEN ${PORT}\n`); } catch {}
  });
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用。`);
      if (!process.versions.electron) process.exit(1);
      return;
    }
    throw e;
  });
}

module.exports = { app, PORT };
