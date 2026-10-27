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


  /* ===== 置顶 + 吸附：状态以主进程 overlay-state.json 为唯一真相 ===== */
  let pinned = true;
  const card = $('card');

  function applyPinned() { $('pin').classList.toggle('on', pinned); $('pin').textContent = pinned ? '📌' : '📍'; }
  function pushState(patch) { try { if (window.overlayAPI && window.overlayAPI.reportPos) window.overlayAPI.reportPos(patch); } catch {} }

  /* ===== 形态：normal（完整卡片）/ docked（贴边极简条）/ peek（点击展开） ===== */
  let mode = 'normal';
  let dockEdge = null;

  function applyMode(m) {
    const st = m || {};
    mode = st.mode || 'normal';
    dockEdge = st.edge || null;
    document.body.classList.toggle('docked-ui', mode === 'docked');
    ['left', 'right', 'top', 'bottom'].forEach(e => document.body.classList.remove('dock-' + e));
    if (mode === 'docked' && dockEdge) document.body.classList.add('dock-' + dockEdge);
    // 吸附按钮：普通态=吸附到最近边缘；展开态=退回浮动卡片
    const t = $('dockBtn');
    if (t) {
      t.textContent = (mode === 'normal') ? '🧲' : '⇱';
      t.title = (mode === 'normal') ? '吸附到屏幕边缘' : '取消吸附，恢复浮动';
    }
    // 极简条高亮由主进程 hover 状态驱动，形态切换时先清掉旧高亮
    const dt = $('dockTab');
    if (dt) dt.classList.remove('is-hover');
    if (mode !== 'docked') scheduleAutoHeight(); // 卡片可见时按内容自适应高度
  }

  // 内容高度自适应：按实际子元素高度求和（list 是 flex:1，scrollHeight 会被拉满，不能直接量）
  let autoHeightTimer = null;
  let hasRendered = false;
  function scheduleAutoHeight() {
    clearTimeout(autoHeightTimer);
    autoHeightTimer = setTimeout(reportAutoHeight, 30);
  }
  function reportAutoHeight() {
    if (mode === 'docked' || !hasRendered) return;
    try {
      const panel = document.querySelector('#card .panel');
      if (!panel) return;
      const head = document.querySelector('#card .head');
      const foot = document.querySelector('#card .foot');
      const box = $('list');
      const csList = getComputedStyle(box);
      let listH = (parseFloat(csList.paddingTop) || 0) + (parseFloat(csList.paddingBottom) || 0);
      Array.from(box.children).forEach(ch => {
        const r = ch.getBoundingClientRect();
        const cm = getComputedStyle(ch);
        listH += r.height + (parseFloat(cm.marginTop) || 0) + (parseFloat(cm.marginBottom) || 0);
      });
      const csCard = getComputedStyle(card);
      const pad = (parseFloat(csCard.paddingTop) || 0) + (parseFloat(csCard.paddingBottom) || 0);
      // +2 是 panel 上下边框，+1 留给 Windows 透明窗口的 1px 虚边
      const total = Math.ceil(pad + (head ? head.offsetHeight : 0) + listH + (foot ? foot.offsetHeight : 0) + 2 + 1);
      if (window.overlayAPI && window.overlayAPI.setAutoHeight) window.overlayAPI.setAutoHeight(total);
    } catch {}
  }

  $('dockBtn').addEventListener('click', () => {
    if (window.overlayAPI && overlayAPI.toggleDock) overlayAPI.toggleDock();
  });
  $('pin').addEventListener('click', () => {
    pinned = !pinned;
    applyPinned();
    if (window.overlayAPI) window.overlayAPI.setAlwaysOnTop(pinned);
    pushState({ pinned });
  });

  // 点击极简条 → 展开为卡片（停靠态不再靠悬停误触）
  const dockTabEl = $('dockTab');
  if (dockTabEl) dockTabEl.addEventListener('click', () => {
    if (window.overlayAPI && overlayAPI.expand) overlayAPI.expand();
  });

  // 启动时从主进程读一次：避免"按钮显示未置顶、窗口实际置顶"这类错位
  (async function initOverlayState() {
    let st = null;
    try {
      st = (window.overlayAPI && window.overlayAPI.getState) ? await window.overlayAPI.getState() : null;
      if (st && typeof st.pinned === 'boolean') pinned = st.pinned;
    } catch {}
    applyPinned();
    applyMode(st || { mode: 'normal' }); // 形态以主进程为准（可能是启动即停靠）
  })();

  // 主进程形态变更：吸附停靠 / 点击展开 / 退出停靠
  if (window.overlayAPI && overlayAPI.onMode) overlayAPI.onMode(applyMode);
  // 主进程 hover 状态 → 驱动极简条的悬停高亮
  if (window.overlayAPI && overlayAPI.onHover) overlayAPI.onHover((v) => {
    const tab = $('dockTab');
    if (tab) tab.classList.toggle('is-hover', !!v);
  });

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
  function normDir(d) { return String(d || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); }
  function matchLocal(s) {
    const cmd = String(s.command || '').toLowerCase();
    let best = null, bestLen = 0;
    for (const x of projects) {
      const d = normDir(x.dir);
      if (!d || !cmd.includes(d)) continue;
      if (d.length > bestLen) { best = x; bestLen = d.length; }
    }
    if (best) return best;
    const ports = (s.ports || []).map(Number);
    const byPort = projects.filter(x => x.port && ports.includes(Number(x.port)));
    return byPort.length === 1 ? byPort[0] : null;
  }
  // 显示名：命中配置项目则用项目名；否则回退命令行提取名
  function dispName(s) {
    const m = matchLocal(s);
    return (m && m.name) ? m.name : (s.name || 'node 服务');
  }

  /* ===== 打开地址：卡内内联展开（不用浮层，避免被 300px 小窗口裁掉） ===== */
  let openUrlPid = null; // 当前展开地址列表的服务 PID（字符串），null=全部收起
  function applyUrlPanel() {
    const box = $('list');
    if (!box) return;
    box.querySelectorAll('.item').forEach(it => {
      const on = openUrlPid != null && String(it.dataset.pid) === String(openUrlPid);
      const panel = it.querySelector('.urls');
      const btn = it.querySelector('.ibtn.open');
      if (panel) panel.hidden = !on;
      if (btn) {
        btn.textContent = on ? '打开 ▴' : '打开 ▾';
        btn.classList.toggle('on', on);
      }
    });
    scheduleAutoHeight(); // 展开/收起改变了内容高度，窗口要跟着长
  }
  /* 复制地址：走主进程 clipboard，比 navigator.clipboard 在悬浮窗里更可靠 */
  function copyUrl(u) {
    const url = String(u || '');
    if (!url) return;
    try { if (window.overlayAPI && window.overlayAPI.copyText) window.overlayAPI.copyText(url); } catch {}
    notify('已复制 ' + url);
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
    hasRendered = true;
    // 5s 轮询会重渲染：保留用户已展开的地址列表，只是服务消失时才收起
    if (openUrlPid != null && !list.some(s => String(s.pid) === String(openUrlPid))) openUrlPid = null;
    $('cnt').textContent = list.length;
    const box = $('list');
    if (!list.length) { box.innerHTML = '<div class="empty">暂无运行中的 dev server</div>'; scheduleAutoHeight(); return; }
    box.innerHTML = list.map((s, i) => {
      const urls = (s.urls || []).slice();
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
      return `<div class="item" data-pid="${escAttr(s.pid)}">
        <div class="row1">
          <div class="nm" title="${safeName}"><b>${nm}</b><div class="pid">${sub}</div></div>
          <span class="port">:${escHtml(firstPort == null ? '-' : firstPort)}</span>
          <div class="ops">
            <button class="ibtn open" ${urls.length ? '' : 'disabled'} data-url="${escAttr(urls.length === 1 ? urls[0] : '')}" title="${urls.length > 1 ? '展开地址列表（右键条目可复制）' : '打开地址'}">打开 ▾</button>
            ${rebootBtn}
            <button class="ibtn kill" data-pid="${escAttr(s.pid)}" data-name="${safeName}">终止</button>
          </div>
        </div>
        ${urls.length > 1 ? `<div class="urls" hidden>${urls.map(u =>
          `<button class="url-row" data-url="${escAttr(u)}" title="${escAttr(u)}">` +
            `<span class="u">${escHtml(String(u).replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>` +
            `<span class="hint">右键复制</span>` +
          `</button>`
        ).join('')}</div>` : ''}
        <div class="row2">
          <div class="meta"><span>PID <b>${escHtml(s.pid)}</b></span><span>内存 <b>${escHtml(s.mem)}M</b></span><span>CPU <b>${escHtml(s.cpu)}%</b></span></div>
        </div>
      </div>`;
    }).join('');
    // 打开按钮：单地址直接打开；多地址在卡内展开列表（内联，不会超出窗口被裁）
    box.querySelectorAll('.ibtn.open').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = b.closest('.item');
      const rows = [...(item ? item.querySelectorAll('.url-row') : [])].map(x => x.dataset.url);
      // 单地址时没有内联列表（不生成 .url-row），地址落在按钮的 data-url 上
      if (!rows.length) {
        const one = b.dataset.url;
        if (one && window.overlayAPI) window.overlayAPI.openExternal(one);
        return;
      }
      openUrlPid = (openUrlPid != null && String(openUrlPid) === String(item.dataset.pid)) ? null : item.dataset.pid;
      applyUrlPanel();
      // 列表是滚动容器：展开的地址面板要滚进可视区，否则被窗口下边界挡成"显示不全"
      if (openUrlPid != null) {
        const panel = item.querySelector('.urls');
        const keep = () => { if (panel) try { panel.scrollIntoView({ block: 'nearest' }); } catch {} };
        keep();
        setTimeout(keep, 80); // 窗口高度自适应后（约 30ms）再滚一次，保证完全露出
      }
    }));
    // 地址条目：左键打开，右键复制（悬浮即可看清完整地址）
    box.querySelectorAll('.url-row').forEach(r => {
      r.addEventListener('click', (e) => {
        e.stopPropagation();
        const u = r.dataset.url;
        if (u && window.overlayAPI) window.overlayAPI.openExternal(u);
        openUrlPid = null; applyUrlPanel();
      });
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        copyUrl(r.dataset.url);
      });
    });
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
    applyUrlPanel(); // 恢复展开态 + 重新计算窗口高度
  }

  // 位置由主进程在窗口 move 时持久化；置顶在切换时按需上报，不再每 4s 轮写状态文件
  fetchServices();
  loadProjects();
  setInterval(() => { if (!document.hidden) fetchServices(); }, 5000);
  setInterval(loadProjects, 30000); // 项目配置 30s 同步一次（服务/项目变化自动更新名称）
})();
