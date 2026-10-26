// DevDeck · by GLNB —— 前端：运行中服务 + 本地项目（无监控图表、无轮询重采样，10s 拉一次服务列表）
// 安全：项目名/目录/命令/进程命令行都来自配置或操作系统，进 HTML 前必须经 DDSafe 转义。
const { escapeHtml: escHtml, escapeAttr: escAttr } = window.DDSafe;
function switchTab(t) {
  const run = t === 'run';
  document.getElementById('tabRun').classList.toggle('on', run); document.getElementById('tabCustom').classList.toggle('on', !run);
  document.getElementById('paneRun').style.display = run ? '' : 'none'; document.getElementById('paneCustom').style.display = run ? 'none' : '';
  document.getElementById('svcBar').style.display = run ? '' : 'none';
}

/* ===== 运行中服务：卡片 + 全部地址平铺可点击 ===== */
let lastServices = []; // 最近一次服务快照（供本地项目启动按钮“运行中”状态匹配）
function stackCls(st) {
  const s = String(st || '').toLowerCase();
  if (s === 'vite') return 'tag vite';
  if (s === 'next.js' || s === 'nuxt') return 'tag next';
  if (s.includes('nest') || s.includes('koa') || s.includes('express')) return 'tag nest';
  if (s.includes('turbo')) return 'tag turbo';
  if (s.includes('静态')) return 'tag static';
  if (s.includes('node')) return 'tag node';
  return 'tag';
}
function svcOps(s, m) {
  const name = escAttr(dispName(s));
  let html = `<button class="btn btn-red" data-act="kill" data-pid="${escAttr(s.pid)}" data-name="${name}">终止</button>`;
  if (m) html += ` <button class="btn btn-blue" data-act="restart" data-pid="${escAttr(s.pid)}" data-id="${escAttr(m.id)}" data-name="${name}" title="先终止再按本地项目「${escAttr(m.name)}」配置重新启动">🔄 重启</button>`;
  return html;
}
/* 运行中服务 ↔ 本地项目匹配：命中则优先显示本地项目名称 */
function matchLocal(s) {
  const items = (typeof lsGet === 'function' && lsGet()) || [];
  return items.find(x =>
    (x.port && (s.ports || []).includes(Number(x.port))) ||
    (x.dir && s.command && String(s.command).toLowerCase().includes(String(x.dir).toLowerCase())));
}
function dispName(s) {
  const m = matchLocal(s);
  return (m && m.name) ? m.name : s.name;
}
const svcSel = new Set();
function syncSvcSel() {
  document.querySelectorAll('#paneRun .selbox').forEach(c => { const p = Number(c.dataset.spid); if (c.checked) svcSel.add(p); else svcSel.delete(p); });
  const all = document.getElementById('svcAll');
  const boxes = document.querySelectorAll('#paneRun .selbox');
  if (all) all.checked = boxes.length > 0 && [...boxes].every(c => c.checked);
  const n = document.getElementById('svcSelN');
  if (n) n.textContent = boxes.length ? `（${svcSel.size}/${boxes.length}）` : '';
}
function toggleSvcAll() {
  const all = document.getElementById('svcAll');
  document.querySelectorAll('#paneRun .selbox').forEach(c => { c.checked = all.checked; });
  syncSvcSel();
}
function updateNodeServices(data) {
  const list = ((data && data.services) || []).filter(s => !s.isSelf); // DevDeck 自身不进列表展示
  lastServices = list;
  document.getElementById('cntRun').textContent = list.length;
  const box = document.getElementById('paneRun');
  if (!list.length) { box.innerHTML = '<div class="empty">暂无运行中的 node 项目服务 — 切到“本地项目”一键启动</div>'; svcSel.clear(); paintCustomStatus(list); syncSvcSel(); return; }
  box.innerHTML = list.map((s, i) => {
    const groups = (s.ports || []).map(p => {
      const all = (s.urls || []).filter(u => u.includes(':' + p + '/'));
      const main = all.find(u => u.includes('localhost')) || all[0];
      const lans = all.filter(u => u !== main);
      const label = u => escHtml(u.replace(/^http:\/\//, '').replace(/\/$/, ''));
      return `<div class="svc-port-grp"><span class="svc-port-tag">:${escHtml(p)}</span>` +
        (main ? `<a class="addr main" href="${escAttr(main)}" target="_blank" rel="noopener" title="${escAttr(main)}">${label(main)} ↗</a>` : '') +
        lans.map(u => `<a class="addr" href="${escAttr(u)}" target="_blank" rel="noopener" title="${escAttr(u)}">${label(u)} ↗</a>`).join('') + `</div>`;
    }).join('');
    const nmRaw = String(dispName(s) || '');
    const m = matchLocal(s);
    return `<div class="svc-card" title="${escAttr(s.command || '')}">
  <input type="checkbox" class="selbox" data-spid="${escAttr(s.pid)}" ${svcSel.has(s.pid) ? 'checked' : ''}><div class="svc-idx">${i + 1}</div>
  <div class="svc-name"><b>${escHtml(nmRaw)}</b><div class="pid">PID ${escHtml(s.pid)}${nmRaw !== s.name ? ' · ' + escHtml(s.name) : ''}</div></div>
  <div class="svc-meta"><div class="m">内存 <b>${escHtml(s.mem)}M</b></div><div class="m">CPU <b>${escHtml(s.cpu)}%</b></div></div>
  <div class="svc-urls">${groups || '<span style="color:var(--mut)">—</span>'}</div>
  <div class="svc-ops"><span class="${stackCls(s.stack)}">${escHtml(s.stack)}</span>  ${svcOps(s, m)}</div></div>`;
  }).join('');
  bindSvcActions();
  paintCustomStatus(list);
  for (const p of [...svcSel]) { if (!list.some(x => x.pid === p)) svcSel.delete(p); }
  syncSvcSel();
}
/* 卡片重渲染后统一绑事件：动态 HTML 里不再拼 onclick，避免把外部字符串当代码执行 */
function bindSvcActions() {
  document.querySelectorAll('#paneRun .selbox').forEach(c => c.addEventListener('change', syncSvcSel));
  document.querySelectorAll('#paneRun [data-act]').forEach(b => b.addEventListener('click', () => {
    const pid = Number(b.dataset.pid);
    if (b.dataset.act === 'kill') killService(pid, b.dataset.name || '', b);
    else restartService(pid, b.dataset.id, b.dataset.name || '', b);
  }));
}
/* 自定义行 ↔ 运行中服务实时关联：运行中则启动按钮变“运行中”禁用态（重启/终止请到运行中服务操作） */
function paintCustomStatus(services) {
  const items = lsGet(); if (!items.length) return;
  for (const x of items) {
    const btn = customStartBtns.get(x.id); if (!btn || !document.body.contains(btn) || btn.dataset.busy) continue; // 启动进行中不抢按钮
    const match = (services || []).find(s =>
      (x.port && (s.ports || []).includes(Number(x.port))) ||
      (x.dir && s.command && String(s.command).toLowerCase().includes(String(x.dir).toLowerCase())));
    if (match) {
      btn.disabled = true; btn.className = 'btn btn-green'; btn.innerHTML = '● 运行中';
      btn.title = `PID ${match.pid}${(match.ports || []).length ? '，端口 ' + match.ports.join('/') : ''}，点“运行中服务”查看 / 终止`;
      const box = btn.closest('.cproj-card') && btn.closest('.cproj-card').querySelector('.selbox');
      if (box) { box.disabled = true; box.checked = false; box.title = '运行中，不可勾选启动'; }
      customSel.delete(x.id);
    }
    else {
      btn.disabled = false; btn.className = 'btn btn-green'; btn.innerHTML = '▶ 启动'; btn.title = '启动该项目';
      const box = btn.closest('.cproj-card') && btn.closest('.cproj-card').querySelector('.selbox');
      if (box) { box.disabled = false; box.title = ''; }
    }
  }
  syncCustomSel(); // 刷新全选计数与全部启动禁用态
}
async function killService(pid, name, btn) {
  if (!await confirmDlg(`终止「${name}」(PID ${pid})？\n将连带结束其拉起的子进程。`, '终止服务')) return;
  const old = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; btn.textContent = '终止中…'; }
  try {
    const r = await fetch('/api/kill-service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
    let j = {}; try { j = await r.json(); } catch { j = { error: '服务返回异常' }; }
    if (!r.ok) { await alertDlg(`终止失败：${j.error || ('HTTP ' + r.status)}`, 'err'); return; }
    await new Promise(res => setTimeout(res, 1500)); await fetchAllData(true);
    const still = [...document.querySelectorAll('#paneRun .svc-card')].some(el => el.textContent.includes('PID ' + pid));
    if (still) await alertDlg(`已下发终止(PID ${pid})，但进程仍在列表中，可能有子进程残留，请再点一次终止。`, 'warn');
    else toast(`已终止 ${name}(PID ${pid})`, 'ok');
  } catch (e) { await alertDlg(`请求失败，没连上 DevDeck 服务：${e.message}\n请确认服务正在运行后重试。`, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old || '终止'; } fetchAllData(true); }
}
/* 重启 = 终止 + 按纳管配置重新拉起；等旧进程消失、等端口释放再起，避免撞 409 */
async function restartService(pid, projId, name, btn) {
  const proj = ((typeof lsGet === 'function' && lsGet()) || []).find(x => String(x.id) === String(projId));
  if (!proj) { await alertDlg('找不到该服务对应的本地项目配置，无法重启（只能终止）', 'warn'); return; }
  if (!await confirmDlg(`重启「${name}」？\n先终止 PID ${pid}，再按本地项目「${proj.name}」的配置重新启动。`, '重启服务')) return;
  const old = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; btn.textContent = '重启中…'; }
  try {
    const ok = await restartCore(pid, proj, null);
    if (!ok) return;
  } catch (e) { await alertDlg(`请求失败，没连上 DevDeck 服务：${e.message}\n请确认服务正在运行后重试。`, 'err'); }
  finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = old || '🔄 重启'; } fetchAllData(true); }
}
async function restartCore(pid, proj, say) {
  const info = say || toast;
  const r = await fetch('/api/kill-service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
  let j = {}; try { j = await r.json(); } catch { j = { error: '服务返回异常' }; }
  if (!r.ok) { await alertDlg(`「${proj.name}」终止失败：${j.error || ('HTTP ' + r.status)}，重启中止`, 'err'); return false; }
  let gone = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(res => setTimeout(res, 1000));
    try { const d = await getJSON('/api/node-services'); gone = !((d && d.services) || []).some(x => x.pid === pid); } catch { }
    if (gone) break;
  }
  if (!gone) { await alertDlg(`「${proj.name}」旧进程(PID ${pid})仍在，可能是子进程残留，重启中止以防双跑。请先手动终止。`, 'warn'); return false; }
  if (proj.port) { // 进程没了≠端口释放了：等端口空闲再起，否则必撞 409
    let free = false, owner = null;
    for (let i = 0; i < 15; i++) {
      try { const c = await getJSON('/api/check-port?port=' + proj.port); free = !!c.free; owner = c.owner; } catch { }
      if (free) break;
      await new Promise(res => setTimeout(res, 1000));
    }
    if (!free) { await alertDlg(`「${proj.name}」旧进程已退，但端口 ${proj.port} 仍被占用${owner ? '（PID ' + owner.pid + '）' : ''}。\n重启中止以防错位，请稍后手动点启动。`, 'warn'); return false; }
  }
  info(`旧进程已退出${proj.port ? '、端口已释放' : ''}，正在重新启动「${proj.name}」…`, 'info');
  await startOne(proj.id, proj.name, proj.port, null, false, true);
  return true;
}
/* 重启所选：只重启勾选的服务（跟全选挂钩）；勾选中未纳管的跳过，逐个串行 */
async function restartAllManaged(btn) {
  syncSvcSel();
  const pids = [...svcSel];
  if (!pids.length) { toast('请先勾选要重启的运行中服务', 'warn'); return; }
  let list = [];
  try { const d = await getJSON('/api/node-services'); list = ((d && d.services) || []).filter(s => !s.isSelf); } catch (e) { await alertDlg(`获取服务列表失败：${e.message}`, 'err'); return; }
  const jobs = [], skipNames = [];
  for (const s of list.filter(x => pids.includes(x.pid))) {
    const m = matchLocal(s);
    if (m) jobs.push({ s, m }); else skipNames.push(s.name);
  }
  if (!jobs.length) { toast('勾选的都是未纳管的外部进程，没有可重启的（只能终止）', 'warn'); return; }
  if (!await confirmDlg(`重启所选 ${jobs.length} 个服务？\n${jobs.map(x => '· ' + (x.m.name || x.s.name)).join('\n')}${skipNames.length ? '\n\n另有 ' + skipNames.length + ' 个未纳管（' + skipNames.join('、') + '）将跳过' : ''}`, '重启所选')) return;
  const old = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; }
  let okN = 0; const fails = [];
  try {
    for (let i = 0; i < jobs.length; i++) {
      const { s, m } = jobs[i];
      if (btn) btn.textContent = `重启中 ${i + 1}/${jobs.length}…`;
      try { if (await restartCore(s.pid, m, () => {})) okN++; else fails.push(m.name || s.name); }
      catch (e) { fails.push((m.name || s.name) + '：' + e.message); }
    }
    if (!fails.length) toast(`重启所选完成（${okN} 个）`, 'ok');
    else await alertDlg(`重启结束：成功 ${okN} 个，失败 ${fails.length} 个：\n${fails.join('\n')}`, 'warn');
  } finally { if (btn) { btn.disabled = false; btn.textContent = old || '🔄 重启所选'; } fetchAllData(true); }
}
async function stopSvcSelected() {
  const pids = [...svcSel];
  if (!pids.length) { toast('请先勾选要终止的运行中服务', 'warn'); return; }
  let okN = 0; const fails = [];
  for (const pid of pids) {
    try {
      const r = await fetch('/api/kill-service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) okN++; else fails.push('PID ' + pid + (j.error ? '(' + j.error + ')' : ''));
    } catch (e) { fails.push('PID ' + pid + '(请求失败)'); }
  }
  svcSel.clear(); const all = document.getElementById('svcAll'); if (all) all.checked = false;
  toast('终止命令已下发，等待进程退出…', 'info');
  await new Promise(res => setTimeout(res, 2000)); // 给进程留退出时间，否则立刻刷新会看到“假存活”
  await fetchAllData(true);
  try {
    const chk = await getJSON('/api/node-services');
    const alive = new Set((((chk && chk.services) || [])).map(x => x.pid));
    const still = pids.filter(p => alive.has(p));
    if (still.length) toast('以下进程仍在运行（可能有子进程残留），请再点一次全部终止：PID ' + still.join('、'), 'warn', 7000);
    else toast('终止完成：成功 ' + okN + '/' + pids.length + (fails.length ? ('；失败：' + fails.join('、')) : ''), fails.length ? 'warn' : 'ok');
  } catch { toast('终止完成：成功 ' + okN + '/' + pids.length, 'ok'); }
}

/* ===== 本地项目 ===== */
const LS_KEY = 'devdeck_projects';
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
const lsSet = l => { try { localStorage.setItem(LS_KEY, JSON.stringify(l)); } catch { } };
const customSel = new Set();
function syncCustomSel() {
  document.querySelectorAll('#customList .selbox').forEach(c => { if (c.checked) customSel.add(c.dataset.cid); else customSel.delete(c.dataset.cid); });
  const all = document.getElementById('customAll');
  const boxes = document.querySelectorAll('#customList .selbox');
  if (all) all.checked = boxes.length > 0 && [...boxes].every(c => c.checked);
  const cn = document.getElementById('customSelN'); if (cn) cn.textContent = boxes.length ? `（${customSel.size}/${boxes.length}）` : '';
  const sb = document.getElementById('btnStartAll'); if (sb) sb.disabled = customSel.size === 0;
}
function toggleCustomAll() {
  const all = document.getElementById('customAll');
  document.querySelectorAll('#customList .selbox').forEach(c => { if (!c.disabled) c.checked = all.checked; });
  syncCustomSel();
}
const customStartBtns = new Map(); // id -> 启动按钮（不用 id 拼 DOM id，导入的 id 不可信）
function customCardHtml(x) {
  const name = String(x.name == null ? '' : x.name);
  const dir = String(x.dir == null ? '' : x.dir);
  const cmd = String(x.cmd == null ? '' : x.cmd);
  const stack = String(x.stack || 'Node.js');
  const port = (x.port === 0 || x.port) ? String(x.port) : '';
  const localTag = x.localOnly ? '<span class="tag" title="仅存浏览器本地，连上服务后自动补录">仅本地</span>' : '';
  return `<div class="cproj-card" data-cid="${escAttr(x.id)}" data-name="${escAttr(name)}" data-port="${escAttr(port)}">
 <input type="checkbox" class="selbox" data-cid="${escAttr(x.id)}" ${customSel.has(x.id) ? 'checked' : ''}>
 <div class="cproj-main"><b>${escHtml(name)}</b><div style="margin-top:4px"><span class="${stackCls(stack)}">${escHtml(stack)}</span>${port ? `<span class="port-pill" title="启动前将检测该端口占用" style="margin-left:5px">:${escHtml(port)}</span>` : ''}${localTag}</div></div>
 <div class="cproj-dir" title="${escAttr(dir)}">${escHtml(dir)}</div><div class="cproj-cmd" title="${escAttr(cmd)}">${escHtml(cmd)}</div>
 <div class="cproj-ops">
 <button class="btn btn-green" data-act="start">▶ 启动</button>
 <button class="btn btn-ghost" data-act="edit">编辑</button>
 <button class="btn btn-ghost" data-act="log">日志</button>
 <button class="btn btn-ghost" data-act="diag" title="自动收集证据诊断">🤖 诊断</button>
 <button class="btn btn-ghost" data-act="del">删除</button></div></div>`;
}
function renderCustom(l) {
  document.getElementById('cntCustom').textContent = l.length;
  const box = document.getElementById('customList');
  customStartBtns.clear();
  box.innerHTML = l.length ? l.map(customCardHtml).join('') : '<div class="empty">还没有本地项目 — 点“+ 新增项目”手动添加</div>';
  box.querySelectorAll('.cproj-card').forEach(card => {
    const id = card.dataset.cid;
    const name = card.dataset.name;
    const port = card.dataset.port ? Number(card.dataset.port) : null;
    const btn = card.querySelector('[data-act="start"]');
    if (btn) {
      customStartBtns.set(id, btn);
      btn.addEventListener('click', () => startOne(id, name, port, btn));
    }
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openEdit(id));
    card.querySelector('[data-act="log"]').addEventListener('click', () => showLog(id, name));
    card.querySelector('[data-act="diag"]').addEventListener('click', () => diagnose(id));
    card.querySelector('[data-act="del"]').addEventListener('click', () => delCustom(id));
    const cb = card.querySelector('.selbox');
    if (cb) cb.addEventListener('change', syncCustomSel);
  });
  syncCustomSel();
}
/* 配置源：服务端 devdeck.json 是唯一真相；localStorage 只做离线缓存 + “仅本地”待补录项 */
async function loadCustom() {
  try {
    const r = await fetch('/api/custom-projects');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json();
    const arr = Array.isArray(list) ? list : [];
    // 离线期间新增、尚未落库的项目：连上后补录，失败则继续保留在本地待下次重试
    const pending = lsGet().filter(x => x.localOnly && !arr.some(y => String(y.id) === String(x.id)));
    let synced = 0;
    for (const it of pending) {
      try {
        const body = { name: it.name, dir: it.dir, cmd: it.cmd, port: it.port, stack: it.stack };
        const pr = await fetch('/api/custom-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (pr.ok) { arr.push(await pr.json()); synced++; } else { arr.push(it); }
      } catch { arr.push(it); }
    }
    lsSet(arr); renderCustom(arr);
    if (synced) toast(`已把 ${synced} 个离线新增项目补录到服务端`, 'ok');
  } catch {
    renderCustom(lsGet()); // 服务端不可达：仅展示缓存，不写回、不合并
  }
}
async function addCustom() {
  const name = fName.value.trim(), dir = fDir.value.trim(), cmd = fCmd.value.trim(), port = fPort.value.trim(), stack = fStack.value.trim();
  if (!name || !dir || (!cmd && !/静态/.test(stack))) return toast('名称 / 目录必填（静态页面无需命令）', 'warn');
  if (/静态/.test(stack) && !port) return toast('静态页面必须配置端口', 'warn');
  try {
    const r = await fetch('/api/custom-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, dir, cmd, port: port || null, stack: stack || null }) });
    const j = await r.json();
    if (!r.ok) return toast('添加失败：' + (j.error || '未知错误'), 'err');
    closeAdd(); await loadCustom(); toast(`已添加「${j.name}」`, 'ok');
  } catch (e) {
    const item = { id: 'local' + Date.now().toString(36), name, dir, cmd, port: port ? Number(port) : null, stack: stack || null, localOnly: true };
    const cur = lsGet(); cur.push(item); lsSet(cur); renderCustom(cur);
    toast('已暂存到浏览器本地（未连上 DevDeck 服务，启动需先 node server.js）', 'warn'); return;
  }
  fName.value = fDir.value = fCmd.value = fPort.value = ''; fStack.value = '';
}
/* 配置导入导出：导出本地全量（含仅存浏览器的），导入走服务端按 id 合并后重新拉取 */
function cfgExport() {
  const items = lsGet();
  if (!items.length) return toast('没有可导出的本地项目', 'warn');
  const blob = new Blob([JSON.stringify({ app: 'devdeck', version: 1, exportedAt: new Date().toISOString(), items }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'devdeck-config.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`已导出 ${items.length} 个项目配置`, 'ok');
}
async function cfgImportPicked(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  let body = null;
  try { body = JSON.parse(await f.text()); }
  catch { return toast('文件解析失败：不是有效的 JSON', 'err'); }
  try {
    const r = await fetch('/api/config/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('导入失败：' + (j.error || r.status), 'err');
    await loadCustom(); await fetchAllData(true);
    toast(`导入完成：新增 ${j.added}，更新 ${j.updated}${j.skipped ? `，跳过 ${j.skipped}` : ''}${(j.errs || []).length ? '（' + j.errs.join('；') + '）' : ''}`, j.errs && j.errs.length ? 'warn' : 'ok', 7000);
  } catch (e) { toast('导入请求失败：' + e.message, 'err'); }
}
async function delCustom(id) {
  const it = lsGet().find(x => x.id === id);
  if (!await confirmDlg(`删除本地项目「${it ? it.name : id}」？\n（仅删除配置，不影响已启动的进程）`, '删除项目')) return;
  try {
    const r = await fetch('/api/custom-projects/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast('删除失败：' + (j.error || r.status), 'err'); return; }
    await loadCustom(); toast(`已删除「${it ? it.name : id}」`, 'ok');
  } catch (e) { toast('删除请求失败：' + e.message + '（配置未改动）', 'err'); }
}
function toast(msg, type = 'info', ms = 4500) {
  const box = document.getElementById('toasts') || (() => { const d = document.createElement('div'); d.id = 'toasts'; document.body.appendChild(d); return d; })();
  const t = document.createElement('div'); t.className = 'toast ' + (type === 'info' ? '' : type); t.textContent = msg; box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, ms);
}
/* ===== 主题弹窗：单例复用，无泄漏 ===== */
let dlgResolve = null;
function dlgShow({ title = '提示', body = '', okText = '确定', cancelText = null, danger = false, kind = '' }) {
  document.getElementById('dlgTitle').textContent = title;
  const b = document.getElementById('dlgBody'); b.textContent = body; b.className = 'dlg-body ' + kind;
  const f = document.getElementById('dlgFoot'); f.innerHTML = '';
  const mkBtn = (txt, cls, fn) => { const el = document.createElement('button'); el.className = 'btn ' + cls; el.textContent = txt; el.onclick = fn; f.appendChild(el); return el; };
  document.getElementById('dlgModal').classList.add('show');
  return new Promise(res => {
    if (dlgResolve) dlgResolve(false); // 防重入：旧等待直接取消，避免悬挂 promise
    dlgResolve = res;
    if (cancelText !== null) mkBtn(cancelText, 'btn-ghost', () => dlgClose(false));
    const ok = mkBtn(okText, danger ? 'btn-red' : 'btn-blue', () => dlgClose(true));
    ok.focus();
  });
}
function dlgClose(val) {
  document.getElementById('dlgModal').classList.remove('show');
  if (dlgResolve) { const r = dlgResolve; dlgResolve = null; r(val); }
}
function confirmDlg(msg, title = '请确认') { return dlgShow({ title, body: msg, okText: '确定', cancelText: '取消', danger: /终止|删除|确定删除/.test(msg + title) }); }
function alertDlg(msg, type = 'info') { return dlgShow({ title: type === 'err' ? '操作失败' : type === 'warn' ? '注意' : type === 'ok' ? '成功' : '提示', body: msg, okText: '知道了', kind: type === 'err' ? 'err' : type === 'warn' ? 'warn' : type === 'ok' ? 'ok' : '' }); }
/* 端口实时检测：输入即查占用，被占时点击提示直接填入可用端口 */
let portDeb = null, portSuggest = null;
async function checkPortHint() {
  const el = document.getElementById('portHint'); const v = fPort.value.trim();
  portSuggest = null; if (!v) { el.textContent = ''; return; }
  el.textContent = '检测中…'; el.className = 'st wait';
  try {
    const r = await fetch('/api/check-port?port=' + encodeURIComponent(v)); const j = await r.json();
    if (!r.ok) { el.textContent = j.error || '无效端口'; el.className = 'st err'; return; }
    if (j.free) { el.textContent = '● 可用'; el.className = 'st run'; }
    else {
      const f = await fetch('/api/free-port?from=' + encodeURIComponent(v)).then(x => x.json()).catch(() => null);
      portSuggest = f && f.port;
      el.textContent = `● 被${j.owner && (j.owner.project || j.owner.name) || '占用'}${portSuggest ? `，点击换 :${portSuggest}` : ''}`;
      el.className = 'st err';
    }
  } catch { el.textContent = '检测失败'; el.className = 'st err'; }
}
/* 内置目录选择器：服务端浏览生成真实路径并回填启动目录；Electron 下仍用原生对话框 */
let dirTarget = null, dirCur = '', dirParent = null;
async function pickDir(targetId) {
  dirTarget = targetId;
  if (window.ddAPI && ddAPI.pickDir) {
    let p = null;
    try { p = await ddAPI.pickDir(); } catch (e) { toast('目录选择失败：' + e.message, 'err'); return; }
    if (!p) return; // 用户取消
    dirApply(p);
    return;
  }
  document.getElementById('dirModal').classList.add('show');
  const cur = (document.getElementById(targetId) || {}).value || '';
  dirLoad(cur);
}
async function dirLoad(dir) {
  const list = document.getElementById('dirList'), curEl = document.getElementById('dirCur'), tip = document.getElementById('dirTip');
  list.innerHTML = '<li class="dim">加载中…</li>'; tip.textContent = '';
  try {
    let r = await fetch('/api/browse-dir?dir=' + encodeURIComponent(dir || ''));
    let j = await r.json();
    if (!r.ok) { // 输入路径无效时退回根（此电脑/家目录）
      if (dir) { dirLoad(''); return; }
      throw new Error(j.error || ('HTTP ' + r.status));
    }
    dirCur = j.dir || ''; dirParent = j.parent || null;
    curEl.textContent = j.dir || '此电脑';
    curEl.title = j.dir || '';
    document.getElementById('dirUp').disabled = !j.parent && !j.dir;
    const esc = s => escHtml(s);
    let html = '';
    (j.drives || []).forEach(d => { html += `<li class="drv" data-d="${escAttr(d)}"><span>💽 ${esc(d)}</span></li>`; });
    (j.entries || []).forEach(e => {
      if (e.isDir) html += `<li class="dir" data-d="${escAttr(e.name)}"><span>📁 ${esc(e.name)}</span></li>`;
      else html += `<li class="f"><span>📄 ${esc(e.name)}</span>${/^(package\.json)$/i.test(e.name) ? '<b class="pkg">项目标识</b>' : ''}</li>`;
    });
    list.innerHTML = html || '<li class="dim">空目录</li>';
    list.querySelectorAll('li[data-d]').forEach(li => li.onclick = () => {
      const base = dirCur || '';
      dirLoad(li.classList.contains('drv') ? li.dataset.d : (base ? base.replace(/[\\/]+$/, '') + '\\' + li.dataset.d : li.dataset.d));
    });
    if ((j.entries || []).some(e => !e.isDir && /^package\.json$/i.test(e.name))) tip.textContent = '✔ 检测到 package.json，选定当前目录即可';
    else if (j.dir) tip.textContent = '进入含 package.json 的项目根目录后点“选定目录”';
  } catch (e) { list.innerHTML = '<li class="dim">加载失败：' + escHtml(e.message || e) + '</li>'; }
}
function dirGoUp() {
  const list = document.getElementById('dirList');
  if (dirParent) dirLoad(dirParent);
  else if (dirCur) dirLoad('');
  else if (list) list.querySelector('.drv') || toast('已在最顶层', 'warn');
}
function dirConfirm() {
  if (!dirCur) return toast('请先进入一个目录', 'warn');
  closeDirModal();
  dirApply(dirCur);
}
function dirApply(p) {
  const input = document.getElementById(dirTarget || 'fDir');
  if (!input) return;
  input.value = p;
  if ((dirTarget || 'fDir') === 'fDir') inspectDir(p);
  else toast('已填入目录：' + p, 'ok');
}
function closeDirModal() { document.getElementById('dirModal').classList.remove('show'); }
/* 目录探测：读 package.json 自动填名称/架构/端口/命令候选 */
async function inspectDir(dir) {
  if (!dir) return toast('请先填写启动目录', 'warn');
  try { syncStaticCmd(document.getElementById('fStack'), document.getElementById('fCmd')); } catch (e) {}
  const stEl = document.createElement('span'); stEl.className = 'st wait'; stEl.textContent = '探测中…';
  const anchor = document.querySelector('#addModal .dir-box'); if (anchor) anchor.appendChild(stEl);
  try {
    const r = await fetch('/api/inspect?dir=' + encodeURIComponent(dir));
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast('探测失败：' + (j.error || ('HTTP ' + r.status)), 'warn', 5000); return; }
    const j = await r.json();
    if (j.name) fName.value = j.name;
    if (j.stack) fStack.value = j.stack;
    if (j.defaultPort && !fPort.value) { fPort.value = j.defaultPort; checkPortHint(); }
    if (j.isStatic) { fCmd.value = '内置静态托管（无需命令）'; fCmd.disabled = true; }
    else { fCmd.disabled = false; }
    ddSetOptions('ddCmd', [...(j.cmdCandidates || []), ...DD_PRESETS.cmd]);
    if ((j.cmdCandidates || []).length) fCmd.value = j.cmdCandidates[0];
    toast(`已识别：${j.name || dir.split(/[\\/]/).pop()} · ${j.stack || 'Node.js'}${j.defaultPort ? (' · 默认端口 ' + j.defaultPort) : ''}${(j.cmdCandidates || []).length ? (' · 建议命令 ' + j.cmdCandidates[0]) : ''}`, 'ok', 6000);
  } catch (e) { toast('探测请求失败：' + e.message, 'err'); }
  finally { stEl.remove(); }
}
/* ===== 自定义下拉引擎（单例绑定，无泄漏；支持输入过滤 + 动态换候选） ===== */
const DD_PRESETS = {
  stack: ['Vite', 'Next.js', 'Nuxt', 'NestJS', 'Express', 'Koa', 'Turborepo', 'Webpack', 'Node.js', '静态页面', '其他'],
  port: ['5173', '3000', '3001', '8080', '8000', '5000', '9527', '9000', '4200', '7000'],
  cmd: ['pnpm serve', 'pnpm dev', 'pnpm start', 'npm run dev', 'npm start', 'yarn dev', 'turbo run serve', 'vite', 'nodemon src/index.js', 'node src/index.js']
};
const ddOpts = {};
function ddSetOptions(ddId, arr) { ddOpts[ddId] = [...new Set(arr.filter(Boolean))]; ddRender(ddId, ''); }
function ddRender(ddId, kw) {
  const box = document.getElementById(ddId); if (!box) return;
  const ul = box.querySelector('.dd-list'); const k = (kw || '').toLowerCase();
  const hit = (ddOpts[ddId] || []).filter(o => o.toLowerCase().includes(k));
  ul.innerHTML = hit.length ? hit.map(o => `<li data-v="${escAttr(o)}">${escHtml(o)}</li>`).join('')
    : '<li class="dim">无匹配，直接回车用输入值</li>';
  ul.querySelectorAll('li[data-v]').forEach(li => li.onmousedown = e => {
    e.preventDefault();
    box.querySelector('input').value = li.dataset.v; ddClose(ddId);
  });
}
function ddOpen(ddId) {
  document.querySelectorAll('.dd.open').forEach(d => { if (d.id !== ddId) d.classList.remove('open'); });
  const box = document.getElementById(ddId); if (!box) return; box.classList.add('open');
  ddRender(ddId, box.querySelector('input').value);
  ddPlace(ddId);
}
/* 下拉悬浮定位：弹窗滚动区会裁剪 absolute 子元素，改 fixed 贴输入框 + 空间不足自动上翻 */
function ddPlace(ddId) {
  const box = document.getElementById(ddId); if (!box || !box.classList.contains('open')) return;
  const ul = box.querySelector('.dd-list'); const inp = box.querySelector('input'); if (!ul || !inp) return;
  if (!box.closest('.modal')) { ul.removeAttribute('style'); return; } // 主页面保持原 absolute 定位
  const r = inp.getBoundingClientRect();
  const H = 208, gap = 6, pad = 8;
  const below = window.innerHeight - r.bottom - gap - pad;
  const above = r.top - gap - pad;
  const down = below >= 120 || below >= above;
  const maxH = Math.min(H, Math.max(120, down ? below : above));
  ul.style.position = 'fixed'; ul.style.left = r.left + 'px'; ul.style.width = r.width + 'px';
  ul.style.maxHeight = maxH + 'px'; ul.style.zIndex = '9999'; ul.style.right = 'auto';
  ul.style.top = down ? (r.bottom + gap) + 'px' : (r.top - gap - ul.offsetHeight) + 'px';
}
function ddClose(ddId) { const box = document.getElementById(ddId); if (!box) return; box.classList.remove('open'); const ul = box.querySelector('.dd-list'); if (ul) ul.removeAttribute('style'); }
/* 滚动/缩放时已展开的下拉跟随输入框 */
['scroll', 'resize'].forEach(ev => window.addEventListener(ev, () => { document.querySelectorAll('.dd.open').forEach(d => ddPlace(d.id)); }, { capture: true, passive: true }));
function bindDropdown(ddId, inputId, options) {
  ddOpts[ddId] = [...options];
  const box = document.getElementById(ddId); if (!box || box.dataset.bound) return; box.dataset.bound = '1'; // 防重复绑定
  const inp = box.querySelector('input');
  inp.addEventListener('focus', () => ddOpen(ddId));
  inp.addEventListener('input', () => { ddOpen(ddId); ddRender(ddId, inp.value); });
  inp.addEventListener('keydown', e => { if (e.key === 'Escape') ddClose(ddId); });
  inp.addEventListener('blur', () => setTimeout(() => ddClose(ddId), 120));
}
document.addEventListener('mousedown', e => { document.querySelectorAll('.dd.open').forEach(d => { if (!d.contains(e.target)) ddClose(d.id); }); });
async function svcPorts() {
  try {
    const d = await fetch('/api/node-services').then(r => r.json()); const l = Array.isArray(d) ? d : (d.services || []);
    return new Set(l.flatMap(s => s.ports || []));
  } catch { return new Set(); }
}
async function waitPort(port, before, tries = 15) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const set = await svcPorts();
    if (port && set.has(Number(port))) return { ok: true, port: Number(port) };
    const fresh = [...set].filter(p => !before.has(p));
    if (fresh.length) return { ok: true, port: fresh[0], auto: true };
  }
  return { ok: false };
}
function fmtSize(b) { b = Number(b) || 0; if (b >= 1048576) return (b / 1048576).toFixed(1) + 'MB'; if (b >= 1024) return (b / 1024).toFixed(0) + 'KB'; return b + 'B'; }
let curLogId = null, logES = null;
async function showLog(id, name) {
  curLogId = id; openLogModal(name);
  const box = document.getElementById('logBody'); box.textContent = '加载中…';
  document.getElementById('logMeta').textContent = '';
  try {
    const r = await fetch('/api/start-log?id=' + encodeURIComponent(id)); const j = await r.json();
    if (!r.ok) { box.textContent = '读取失败：' + (j.error || r.status); return; }
    box.textContent = j.exists ? (stripAnsiFE(j.lines.join('\n')) || '(日志为空)') : (j.hint || '暂无日志');
    if (j.exists) document.getElementById('logMeta').textContent = fmtSize(j.size) + (j.mtime ? (' · ' + new Date(j.mtime).toLocaleString('zh-CN', { hour12: false })) : '');
    box.scrollTop = box.scrollHeight;
    startLogStream(id);
  } catch (e) { box.textContent = '请求失败：' + e.message; }
}
async function delLog() {
  if (!curLogId) return;
  try {
    const r = await fetch('/api/start-log?id=' + encodeURIComponent(curLogId), { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('删除失败：' + (j.error || r.status), 'err');
    toast('运行日志已清除', 'ok'); showLog(curLogId, document.getElementById('logTitle').textContent.replace(/^启动日志 — /, ''));
  } catch (e) { toast('删除请求失败：' + e.message, 'err'); }
}
function openLogModal(name) {
  document.getElementById('logTitle').textContent = '启动日志 — ' + name;
  document.getElementById('logModal').classList.add('show');
}
function closeLogModal() { stopLogStream(); document.getElementById('logModal').classList.remove('show'); }
function stripAnsiFE(s) { return String(s == null ? '' : s).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[0-9]+(;[0-9]+)*m/g, ''); }
function startLogStream(id) {
  stopLogStream();
  try {
    logES = new EventSource('/api/start-log/stream?id=' + encodeURIComponent(id));
    logES.addEventListener('line', ev => {
      try {
        const box = document.getElementById('logBody');
        if (box.textContent === '加载中…' || box.textContent === '(日志为空)') box.textContent = '';
        box.textContent += stripAnsiFE(JSON.parse(ev.data).text);
        box.scrollTop = box.scrollHeight;
      } catch {}
    });
  } catch {}
}
function stopLogStream() { try { if (logES) logES.close(); } catch {} logES = null; }
/* 辅助诊断：状态横幅 + 结论卡片（一键处置） + 证据折叠区 */
let lastDiag = null, diagArg = null;
function diagActArg(act, arg) { diagArg = arg; return diagAct(act); }
const DIAG_ICON = { error: '⛔', warn: '⚠️', info: 'ℹ️', ok: '✅' };
function diagEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
async function diagnose(id) {
  document.getElementById('diagModal').classList.add('show');
  document.getElementById('diagBody').innerHTML = '<div class="empty">正在收集证据包…</div>';
  try {
    const r = await fetch('/api/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const j = await r.json();
    if (!r.ok) { document.getElementById('diagBody').innerHTML = '<div class="empty">诊断失败：' + diagEsc(j.error || r.status) + '</div>'; return; }
    lastDiag = j;
    const s = j.summary || { status: 'ok', err: 0, warn: 0, info: 0 };
    const bannerTxt = s.status === 'error' ? `发现 ${s.err} 项错误${s.warn ? `、${s.warn} 项警告` : ''}` : s.status === 'warn' ? `发现 ${s.warn} 项警告` : (s.info ? `无异常，有 ${s.info} 条提示` : '各项指标正常');
    const bannerIcon = s.status === 'ok' && s.info ? DIAG_ICON.info : DIAG_ICON[s.status];
    const ev = j.evidence || {}, p = ev.project || {};
    const kv = [
      ['项目', p.name || '—'], ['目录', p.dir || '未配置'], ['命令', p.cmd || '—'],
      ['配置端口', (ev.portStatus && ev.portStatus.port) || '未配置'],
      ['实际监听', (ev.actualPorts && ev.actualPorts.length ? ev.actualPorts.map(x => ':' + x).join('、') : '无')],
      ['进程', ev.process ? `PID ${ev.process.pid}（内存 ${ev.process.mem}M，CPU ${ev.process.cpu}%）` : '未运行'],
      ['进程实例', (ev.instances && ev.instances.length ? ev.instances.map((t, i) => `#${i + 1} 树根${t.root}（${(t.roles || []).join('/')}×${t.count}，监听${t.ports.length ? t.ports.map(x => ':' + x).join('、') : '无'}，运行${t.uptime || '—'}）`).join('；') : '无')],
      ['依赖', ev.hasPkg ? (ev.hasNodeModules ? 'package.json ✔ / node_modules ✔' : 'package.json ✔ / node_modules ✘') : (ev.isStatic ? '静态页面（免依赖）' : '无 package.json')],
      ['日志画像', ev.logProfile ? `EADDRINUSE×${ev.logProfile.eaddr} · 报错行×${ev.logProfile.errors} · 缺模块${ev.logProfile.noModule.length ? '：' + ev.logProfile.noModule.join('、') : '无'}${ev.logProfile.ready ? ` · 已就绪${ev.logProfile.readyMs != null ? `（${ev.logProfile.readyMs}ms）` : ''}` : ''}` : '—']
    ].map(([k, v]) => `<div class="diag-kv"><span>${k}</span><b>${diagEsc(v)}</b></div>`).join('');
    const cards = (j.findings || []).map(f => `
      <div class="diag-card ${f.level}">
        <div class="diag-card-h"><span>${DIAG_ICON[f.level] || '•'}</span><b>${diagEsc(f.title)}</b></div>
        ${f.detail ? `<div class="diag-detail">${diagEsc(f.detail)}</div>` : ''}
        ${(f.actions || []).length ? `<div class="diag-acts">${f.actions.map(a => `<button class="btn ${a.cls || 'btn-ghost'}" onclick="diagActArg('${a.act}', ${a.arg == null ? 'null' : JSON.stringify(a.arg)})">${diagEsc(a.label)}</button>`).join('')}</div>` : ''}
      </div>`).join('');
    document.getElementById('diagBody').innerHTML =
      `<div class="diag-banner ${s.status}"><b>${bannerIcon} ${bannerTxt}</b><button class="btn btn-ghost" onclick="diagAct('rerun')">↻ 重新诊断</button></div>` +
      cards +
      `<details class="diag-ev"><summary>证据包（${diagEsc(ev.timestamp ? new Date(ev.timestamp).toLocaleString('zh-CN', { hour12: false }) : '')}）</summary><div class="diag-kvs">${kv}</div><pre>${diagEsc((ev.logTail || []).slice(-20).join('\n'))}</pre></details>`;
  } catch (e) { document.getElementById('diagBody').innerHTML = '<div class="empty">请求失败：' + diagEsc(e.message) + '</div>'; }
}
async function diagAct(act) {
  const d = lastDiag; if (!d) return;
  const ev = d.evidence || {}, p = ev.project || {}, id = p.id, name = p.name || '';
  if (act === 'rerun') return diagnose(id);
  if (act === 'goto-run') { closeDiag(); switchTab('run'); return; }
  if (act === 'open-log') { closeDiag(); showLog(id, name); return; }
  if (act === 'edit') { closeDiag(); openEdit(id); return; }
  if (act === 'start') { closeDiag(); await startOne(id, name, (p.port != null ? p.port : null), null); return; }
  if (act === 'kill-owner' || act === 'kill-pid') {
    const pid = act === 'kill-pid' ? Number(diagArg) : (ev.portStatus && ev.portStatus.owner && ev.portStatus.owner.pid);
    diagArg = null;
    if (!pid) return toast('目标进程已消失', 'warn');
    closeDiag();
    await killService(pid, act === 'kill-pid' ? `多余实例（PID ${pid}，连带其子进程）` : `端口${ev.portStatus.port}占用者`, null);
    setTimeout(() => diagnose(id), 2000);
    return;
  }
  if (act === 'free-port') {
    try {
      const f = await fetch('/api/free-port?from=' + encodeURIComponent(ev.portStatus.port)).then(x => x.json()).catch(() => null);
      if (!f || !f.port) return toast('没找到可用端口', 'err');
      if (!await confirmDlg(`把「${name}」的端口从 ${ev.portStatus.port} 改为 ${f.port}${ev.process ? ' 并重启' : ''}？`, '换端口')) return;
      const u = await fetch('/api/custom-projects/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: f.port }) });
      if (!u.ok) return toast('改端口失败', 'err');
      const cur = lsGet(); const it = cur.find(c => c.id === id); if (it) it.port = f.port; lsSet(cur); renderCustom(cur);
      closeDiag();
      if (ev.process && ev.process.pid) await restartService(ev.process.pid, id, name);
      else { toast(`已改为 :${f.port}，点启动生效`, 'ok'); fetchAllData(true); }
      setTimeout(() => diagnose(id), 2500);
    } catch (e) { toast('换端口失败：' + e.message, 'err'); }
    return;
  }
  if (act === 'adopt-port') {
    const ap = ev.actualPorts && ev.actualPorts[0];
    if (!ap) return;
    if (!await confirmDlg(`把「${name}」的配置端口改为实际监听的 :${ap}？`, '修正配置')) return;
    try {
      const u = await fetch('/api/custom-projects/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: ap }) });
      if (!u.ok) return toast('修改失败', 'err');
      const cur = lsGet(); const it = cur.find(c => c.id === id); if (it) it.port = ap; lsSet(cur); renderCustom(cur);
      toast(`已改为 :${ap}`, 'ok'); diagnose(id);
    } catch (e) { toast('修改失败：' + e.message, 'err'); }
    return;
  }
  if (act === 'install') {
    if (!await confirmDlg(`对「${name}」执行一键安装依赖？\n输出会追加进项目日志，可在日志弹窗跟踪进度。`, '安装依赖')) return;
    try {
      const r = await fetch('/api/install-deps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const jj = await r.json().catch(() => ({}));
      if (!r.ok) return toast('下发失败：' + (jj.error || r.status), 'err');
      toast(`已开始 ${jj.pm} install，完成后重新诊断`, 'ok'); closeDiag(); showLog(id, name);
    } catch (e) { toast('请求失败：' + e.message, 'err'); }
    return;
  }
}
function closeDiag() { document.getElementById('diagModal').classList.remove('show'); }
async function startOne(id, name, port, btn, retried, noSwitch) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.dataset.busy = '1'; btn.classList.add('busy'); btn.innerHTML = '<span class="spin"></span>启动中…'; }
  try {
    const r = await fetch('/api/start-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    let j = {}; try { j = await r.json(); } catch { j = { error: '服务返回异常' }; }
    if (!r.ok) {
      if (r.status === 409 && j.suggestPort && !retried && !noSwitch) { // 端口被占：一键换可用端口并重试（仅一次；重启场景禁用）
        if (await confirmDlg(`「${name}」的端口 ${port} 被占用。\n${j.error}\n\n是否改用可用端口 ${j.suggestPort} 并重新启动？`, '端口被占')) {
          try {
            const u = await fetch('/api/custom-projects/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: j.suggestPort }) });
            if (u.ok) {
              const cur = lsGet(); const it = cur.find(c => c.id === id); if (it) it.port = j.suggestPort; lsSet(cur); renderCustom(cur);
              return startOne(id, name, j.suggestPort, btn, true);
            }
          } catch { }
        }
        toast(`「${name}」启动失败：${j.error}`, 'err'); return;
      }
      if (r.status === 409 && noSwitch) { toast(`「${name}」重启中止：端口 ${port} 仍被占用（${j.error || ''}），请稍后手动点启动`, 'err', 8000); return; }
      toast(`「${name}」启动失败：${j.error || ('HTTP ' + r.status)}`, 'err'); return;
    }
    toast(`「${name}」命令已执行(PID ${j.pid || '?'})，正在等待服务就绪…`, 'info');
    const before = await svcPorts();
    const w = await waitPort(port, before);
    if (w.ok) {
      toast(`「${name}」启动成功，端口 ${w.port} 已在监听`, 'ok'); switchTab('run');
    }
    else if (!port) { toast(`「${name}」已执行（未配置端口无法自动确认，请切到“已启动服务”核对）`, 'warn'); switchTab('run'); }
    else {
      toast(`「${name}」命令执行了，但 30 秒内没检测到监听端口，点该行“日志”按钮看具体报错（多半是项目自身报错退出）`, 'warn', 8000); switchTab('run');
    }
  } catch (e) { toast(`没连上 DevDeck 服务：${e.message}（确认服务在运行后重试）`, 'err', 6000); }
  finally { if (btn) { delete btn.dataset.busy; btn.classList.remove('busy'); btn.disabled = false; btn.innerHTML = old || '▶ 启动'; } fetchAllData(true); } // paint 随后按实际存活校准按钮
}
/* ===== 编辑本地项目 ===== */
let editId = null;
function syncStaticCmd(stackInp, cmdInp) { var isSt = /静态/.test(stackInp.value || ''); if (isSt) { cmdInp.value = '内置静态托管（无需命令）'; } else if (cmdInp.value === '内置静态托管（无需命令）') { cmdInp.value = ''; } cmdInp.disabled = isSt; }
function openAdd() {
  fName.value = fDir.value = fCmd.value = fPort.value = ''; fStack.value = '';
  document.getElementById('portHint').textContent = '';
  bindDropdown('ddStack', 'fStack', DD_PRESETS.stack);
  bindDropdown('ddPort', 'fPort', DD_PRESETS.port);
  bindDropdown('ddCmd', 'fCmd', DD_PRESETS.cmd);
  try { syncStaticCmd(document.getElementById('fStack'), document.getElementById('fCmd')); } catch (e) {}
  document.getElementById('fPort').oninput = () => { clearTimeout(portDeb); portDeb = setTimeout(checkPortHint, 500); };
  document.getElementById('portHint').onclick = () => { if (portSuggest) { fPort.value = portSuggest; checkPortHint(); } };
  document.getElementById('addModal').classList.add('show');
}
function closeAdd() { document.getElementById('addModal').classList.remove('show'); }
function openEdit(id) {
  const x = lsGet().find(c => c.id === id); if (!x) return toast('项目不存在', 'err'); editId = id;
  document.getElementById('eName').value = x.name || '';
  document.getElementById('eStack').value = x.stack || '';
  document.getElementById('ePort').value = x.port || '';
  document.getElementById('eDir').value = x.dir || '';
  document.getElementById('eCmd').value = x.cmd || '';
  bindDropdown('ddEStack', 'eStack', DD_PRESETS.stack);
  bindDropdown('ddEPort', 'ePort', DD_PRESETS.port);
  bindDropdown('ddECmd', 'eCmd', DD_PRESETS.cmd);
  try { syncStaticCmd(document.getElementById('eStack'), document.getElementById('eCmd')); } catch (e) {}
  document.getElementById('editModal').classList.add('show');
}
function closeEdit() { editId = null; document.getElementById('editModal').classList.remove('show'); }
async function saveEdit() {
  if (!editId) return;
  const body = {
    name: document.getElementById('eName').value.trim(), stack: document.getElementById('eStack').value.trim() || null,
    port: document.getElementById('ePort').value.trim() || null, dir: document.getElementById('eDir').value.trim(), cmd: document.getElementById('eCmd').value.trim()
  };
  if (!body.name || !body.dir || (!body.cmd && !/静态/.test(body.stack || ''))) return toast('名称 / 目录必填（静态页面无需命令）', 'warn');
  if (/静态/.test(body.stack || '') && !body.port) return toast('静态页面必须配置端口', 'warn');
  try {
    const r = await fetch('/api/custom-projects/' + encodeURIComponent(editId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('保存失败：' + (j.error || r.status), 'err');
    closeEdit(); await loadCustom(); fetchAllData(true); toast('已保存', 'ok');
  } catch (e) {
    const cur = lsGet(); const i = cur.findIndex(c => c.id === editId); if (i >= 0) cur[i] = { ...cur[i], ...body, port: body.port ? Number(body.port) : null };
    lsSet(cur); renderCustom(cur); closeEdit(); toast('已保存到本地（服务端不可达，连上后以服务端配置为准）', 'warn');
  }
}
async function startAll() {
  const b = document.getElementById('btnStartAll'); const old = b ? b.innerHTML : '';
  const ids = [...customSel];
  if (!ids.length) { toast('请先勾选要启动的本地项目', 'warn'); return; }
  if (b) { b.disabled = true; b.classList.add('busy'); b.innerHTML = '<span class="spin"></span>启动中…'; }
  toast('已下发全部启动命令，逐个等待服务就绪…', 'info');
  try {
    const beforeAll = await svcPorts(); // 快照必须在启动前，否则“新端口”判定失效
    const r = await fetch('/api/start-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }); const j = await r.json();
    const items = Array.isArray(j) ? j : [];
    for (const x of items) {
      if (!x.ok) { continue; }
      const cfg = lsGet().find(c => c.id === x.id);
      const w = await waitPort(cfg && cfg.port, beforeAll, 8);
    }
    const okN = items.filter(x => x.ok).length;
    const fails = items.filter(x => !x.ok);
    toast(`一键启动完成：成功 ${okN}/${items.length}` + (fails.length ? ('；失败：' + fails.map(x => x.name + (x.suggestPort ? `(端口被占，可改 :${x.suggestPort})` : (x.error ? '（' + x.error + '）' : ''))).join('、')) : ''), okN === items.length ? 'ok' : 'warn', 7000);
    switchTab('run');
  } catch (e) { toast(`请求失败，没连上 DevDeck 服务：${e.message}`, 'err', 6000); }
  finally { if (b) { b.classList.remove('busy'); b.innerHTML = old || '▶ 全部启动'; } syncCustomSel(); fetchAllData(true); }
}

/* ===== 明暗主题（默认亮色） ===== */
const THEME_KEY = 'devdeck_theme';
function themeGet() { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; } }
function applyTheme(t) { document.documentElement.dataset.theme = (t === 'light' ? 'light' : ''); try { localStorage.setItem(THEME_KEY, t); } catch { } var b = document.getElementById('themeBtn'); if (b) b.textContent = (t === 'light' ? '☀️ 亮色' : '🌙 深色'); }
function toggleTheme() { var n = themeGet() === 'light' ? 'dark' : 'light'; applyTheme(n); toast(n === 'light' ? '已切换亮色主题' : '已切换暗色主题', 'info'); }

/* ===== 数据拉取（服务列表 10s 轮询；项目配置启动时 + 操作后同步） ===== */
async function getJSON(url) { const r = await fetch(url); return r.json(); }
function showErr(e) {
  console.error(e);
  const b = document.getElementById('connErr'); b.style.display = '';
  document.getElementById('connMsg').textContent = '（' + e.message + '）';
}
function markOk() {
  document.getElementById('connErr').style.display = 'none';
  document.getElementById('updateTime').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
let suspendRender = false; // 窗口拖拽/移动中由 Electron 通知置 true，停稳后恢复并补刷一次
if (window.winState && window.winState.onMoving) {
  window.winState.onMoving(moving => {
    suspendRender = moving;
    if (!moving) fetchAllData();
  });
}
// 手动刷新：只拉服务接口（运行中服务列表 + 本地项目按钮状态）
async function manualRefreshServices(btn) {
  if (btn && btn.classList.contains('refreshing')) return;
  if (btn) btn.classList.add('refreshing');
  const t0 = Date.now();
  try { await fetchServices(); }
  finally { const wait = Math.max(0, 800 - (Date.now() - t0)); setTimeout(function () { if (btn) btn.classList.remove('refreshing'); }, wait); }
}
async function fetchServices() {
  if (suspendRender) return;
  try {
    const d = await getJSON('/api/node-services');
    if (suspendRender) return;
    updateNodeServices(d); markOk();
  } catch (e) { showErr(e); }
}
async function fetchAllData() {
  if (suspendRender) return;
  await fetchServices();
}
// 悬浮卡的操作结果（终止/重启）转发到主窗口 toast；主窗口隐藏时悬浮卡自身也会提示
if (window.ddAPI && typeof ddAPI.onOverlayToast === 'function') {
  ddAPI.onOverlayToast(msg => toast(String(msg), 'info'));
}
setInterval(() => { if (!document.hidden) fetchServices(); }, 10000);
applyTheme(themeGet());
loadCustom();
fetchServices();
