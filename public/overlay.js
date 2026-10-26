// DevDeck 悬浮卡片前端逻辑
// 复用网页端的 /api/node-services 轮询，不依赖后端改动。
// 安全：服务名/项目名来自配置或进程命令行，进 HTML 前一律走 DDSafe 转义。
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { escapeHtml: escHtml, escapeAttr: escAttr } = window.DDSafe;

  /* ===== 卡内提示：悬浮窗没有主窗口的 toast 容器，操作结果就地反馈（并同步转发主窗口） ===== */
  let toastTimer = null;
  function uiToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = String(msg == null ? '' : msg);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }
  function notify(msg) {
    uiToast(msg);
    try { if (window.overlayAPI && window.overlayAPI.toast) window.overlayAPI.toast(String(msg == null ? '' : msg)); } catch {}
  }

  /* ===== 主题：独立存储（devdeck_overlay_theme），初始继承主看板当前主题，之后悬浮卡片单独控制 ===== */
  const MAIN_THEME_KEY = 'devdeck_theme';     // 主看板主题 key
  const OVERLAY_THEME_KEY = 'devdeck_overlay_theme'; // 悬浮卡片独立主题 key
  let overlayTheme = null; // 'light' | 'dark' | null(未设置→跟随主看板)

  function themeApply() {
    const t = overlayTheme || (() => { try { return localStorage.getItem(MAIN_THEME_KEY) || 'light'; } catch { return 'light'; } })();
    // light -> data-theme="light"；dark -> 空（走 :root 默认深色）
    document.documentElement.dataset.theme = (t === 'light') ? 'light' : '';
    const btn = $('theme');
    if (btn) btn.textContent = (t === 'light') ? '🌙' : '☀️'; // 按钮显示“将要切到的主题”
    return t;
  }
  function themeInit() {
    try {
      const v = localStorage.getItem(OVERLAY_THEME_KEY);
      if (v === 'light' || v === 'dark') overlayTheme = v; // 已有独立设置则用之
    } catch {}
    themeApply();
  }
  $('theme').addEventListener('click', () => {
    const cur = themeApply(); // 当前实际主题
    overlayTheme = (cur === 'light') ? 'dark' : 'light';
    try { localStorage.setItem(OVERLAY_THEME_KEY, overlayTheme); } catch {}
    themeApply();
  });
  themeInit();


  /* ===== 折叠/展开状态（记忆） ===== */
  const LS = 'devdeck_overlay';
  function memGet() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } }
  function memSet(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch {} }
  const mem = memGet();

  let collapsed = !!mem.collapsed;
  const card = $('card');

  function applyCollapsed() {
    card.classList.toggle('collapsed', collapsed);
    $('toggle').textContent = collapsed ? '▸' : '▾';
  }
  $('toggle').addEventListener('click', e => {
    collapsed = !collapsed; mem.collapsed = collapsed; memSet(mem); applyCollapsed();
  });
  applyCollapsed();

  /* ===== 置顶开关 ===== */
  let pinned = !!mem.pinned;
  function applyPinned() { $('pin').classList.toggle('on', pinned); $('pin').textContent = pinned ? '📌' : '📍'; }
  $('pin').addEventListener('click', () => {
    pinned = !pinned; mem.pinned = pinned; memSet(mem); applyPinned();
    if (window.overlayAPI) window.overlayAPI.setAlwaysOnTop(pinned);
  });
  applyPinned();

  /* ===== 隐藏 ===== */
  $('close').addEventListener('click', () => { if (window.overlayAPI) window.overlayAPI.hide(); });

  /* ===== 本地项目匹配：运行中服务 ↔ devdeck.json 配置，显示对应项目名称 ===== */
  let projects = [];
  async function loadProjects() {
    try {
      const r = await fetch('/api/custom-projects');
      if (r.ok) { const j = await r.json(); if (Array.isArray(j)) projects = j; }
    } catch {}
  }
  function matchLocal(s) {
    return projects.find(x =>
      (x.port && (s.ports || []).includes(Number(x.port))) ||
      (x.dir && s.command && String(s.command).toLowerCase().includes(String(x.dir).toLowerCase())));
  }
  // 显示名：命中配置项目则用项目名；否则回退命令行提取名
  function dispName(s) {
    const m = matchLocal(s);
    return (m && m.name) ? m.name : (s.name || 'node 服务');
  }

  /* ===== 服务数据拉取 ===== */
  let last = [];
  async function fetchServices() {
    try {
      const r = await fetch('/api/node-services');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      last = ((d && d.services) || []).filter(s => !s.isSelf);
      $('state').textContent = '运行中 ' + last.length + ' 个服务';
      $('state').style.color = '#34d399';
      render(last);
    } catch (e) {
      $('state').textContent = '服务未连接';
      $('state').style.color = '#f87171';
      render([]);
    }
    $('tm').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function render(list) {
    $('cnt').textContent = list.length;
    const box = $('list');
    if (!list.length) { box.innerHTML = '<div class="empty">暂无运行中的 dev server</div>'; return; }
    box.innerHTML = list.map((s, i) => {
      const addr = (s.urls || []).find(u => u.includes('localhost')) || (s.urls || [])[0] || '';
      const rawName = String(dispName(s) || '');           // 原始值：只用于比较，不直接进 DOM
      const nm = escHtml(rawName);                          // 文本节点：转义后渲染
      const safeName = escAttr(rawName);                    // 属性/dataset：转义后写入
      const m = matchLocal(s);
      const sub = (m && m.name && rawName !== s.name)
        ? escHtml(s.name || 'node 服务')
        : 'PID ' + escHtml(s.pid);
      const firstPort = (s.ports || [])[0];
      // 只有命中本地项目配置的服务才能重启（与主看板一致）
      const rebootBtn = m && m.id
        ? `<button class="ibtn reboot" data-pid="${escAttr(s.pid)}" data-id="${escAttr(m.id)}" data-name="${safeName}" title="终止后按项目配置重新启动">重启</button>`
        : '';
      return `<div class="item">
        <div class="row1">
          <div class="nm" title="${safeName}"><b>${nm}</b><div class="pid">${sub}</div></div>
          <span class="port">:${escHtml(firstPort == null ? '-' : firstPort)}</span>
          <div class="ops">
            <button class="ibtn open" ${addr ? '' : 'disabled'} data-url="${escAttr(addr)}" title="打开地址">打开</button>
            ${rebootBtn}
            <button class="ibtn kill" data-pid="${escAttr(s.pid)}" data-name="${safeName}">终止</button>
          </div>
        </div>
        <div class="row2">
          <div class="meta"><span>PID <b>${escHtml(s.pid)}</b></span><span>内存 <b>${escHtml(s.mem)}M</b></span><span>CPU <b>${escHtml(s.cpu)}%</b></span></div>
        </div>
      </div>`;
    }).join('');
    // 打开地址
    box.querySelectorAll('.ibtn.open').forEach(b => b.addEventListener('click', () => {
      const url = b.dataset.url; if (url && window.overlayAPI) window.overlayAPI.openExternal(url);
    }));
    // 终止
    box.querySelectorAll('.ibtn.kill').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      const name = b.dataset.name, pid = b.dataset.pid;
      try {
        const r = await fetch('/api/kill-service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: Number(pid) }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { b.disabled = false; notify('终止失败：' + (j.error || r.status)); return; }
        notify('已终止 ' + name);
        setTimeout(fetchServices, 1200);
      } catch (e) { b.disabled = false; notify('请求失败：' + e.message); }
    }));
    // 重启 = 终止 → 等旧进程消失 → 等端口释放 → 按项目配置重新启动（同主看板 restartCore）
    box.querySelectorAll('.ibtn.reboot').forEach(b => b.addEventListener('click', async () => {
      const pid = Number(b.dataset.pid), id = b.dataset.id, name = b.dataset.name;
      b.disabled = true; const old = b.textContent; b.textContent = '重启中…';
      const toast = notify;
      try {
        const r = await fetch('/api/kill-service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
        let j = {}; try { j = await r.json(); } catch {}
        if (!r.ok) { toast('终止失败：' + (j.error || r.status) + '，重启中止'); return; }
        // 等旧进程消失（最多 10s）
        let gone = false;
        for (let i = 0; i < 10; i++) {
          await new Promise(res => setTimeout(res, 1000));
          try { const d = await (await fetch('/api/node-services')).json(); gone = !((d && d.services) || []).some(x => x.pid === pid); } catch {}
          if (gone) break;
        }
        if (!gone) { toast('旧进程仍在（可能子进程残留），重启中止以防双跑'); return; }
        // 等端口释放（最多 15s）
        const proj = projects.find(x => String(x.id) === String(id));
        if (proj && proj.port) {
          let free = false;
          for (let i = 0; i < 15; i++) {
            try { const c = await (await fetch('/api/check-port?port=' + proj.port)).json(); free = !!c.free; } catch {}
            if (free) break;
            await new Promise(res => setTimeout(res, 1000));
          }
          if (!free) { toast('端口 ' + proj.port + ' 仍被占用，重启中止（可稍后手动启动）'); return; }
        }
        toast('正在重新启动「' + name + '」…');
        const s2 = await fetch('/api/start-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        let j2 = {}; try { j2 = await s2.json(); } catch {}
        if (!s2.ok) { toast('启动失败：' + (j2.error || s2.status)); return; }
        toast('已重启 ' + name);
        setTimeout(fetchServices, 1500);
      } catch (e) { toast('重启请求失败：' + e.message); }
      finally { b.disabled = false; b.textContent = old; }
    }));
  }

  // 位置上报给主进程持久化
  function reportPos() { if (window.overlayAPI && window.overlayAPI.reportPos) window.overlayAPI.reportPos({ collapsed, pinned }); }
  setInterval(reportPos, 4000);

  fetchServices();
  loadProjects();
  setInterval(() => { if (!document.hidden) fetchServices(); }, 5000);
  setInterval(loadProjects, 30000); // 项目配置 30s 同步一次（服务/项目变化自动更新名称）
})();
