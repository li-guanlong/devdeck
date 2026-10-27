# DevDeck · by GLNB — v1.0

本机多项目开发工作台：统一管理多个 dev server（Vite / Next / Turbo / Vue-CLI / Node 脚本 / 纯静态页面）的启停、端口占用发现、运行日志聚合，一处看板替代 N 个终端窗口。

## 功能一览

- **本地项目管理**：新增 / 编辑 / 删除 / 一键启动 / 批量启动，填目录后自动识别架构、包管理器、默认端口与启动命令（`GET /api/inspect`）。
- **运行中服务发现**：`netstat -ano` + CIM 进程快照（含 CPU 差分、内存），自动圈定 node 服务与静态托管进程，展示监听端口与局域网 URL。
- **静态页面托管**：无 `package.json` 的纯 HTML 目录（如大屏）走内置 `static-serve.js` 托管，需配置端口；源码版用系统 Node，EXE 版用内置 Node（`ELECTRON_RUN_AS_NODE`）。
- **端口治理**：启动前判占（409 + 占用者说明）、自动推荐空闲端口、一键换端口重启；`vue-cli-service` 只走 `PORT/HOST` 环境变量，Turbo 透传 `-- -- --port --strictPort --host`。**端口参数透传分隔符按包管理器区分**：npm / yarn / bun 需 `--`（它们会吞掉），pnpm 不能加 `--`（pnpm 8 会把它原样透传给脚本，导致 `vite` 把后续 `--port` 当位置参数、端口静默失效回落默认 5173）。
- **日志聚合**：日志集中落 `DATA_DIR/logs/{id}.log`（源码版 `logs/`，EXE 版 `%APPDATA%\DevDeck\logs`，UTF-8），不再写进用户项目目录；看板看尾 80 行 + SSE 实时流，超 5MB 自动瘦身到 1MB；旧版项目目录 `.devdeck-*.log` 与 CMP 遗留 `.cmp-start*.log` 首次访问自动迁移。
- **辅助诊断**：规则引擎（无 LLM）按日志画像 + 端口归属 + 进程树聚类输出 error/warn/info 结论卡，每条带可执行动作（启动 / 终止占用者 / 换端口 / 安装依赖 / 看日志）。
- **桌面壳**：Electron 主窗口 + 托盘（关窗隐藏）+ 桌面悬浮卡 + 开机自启 + 原生目录选择；**单实例锁**防止双开抢端口。
- **悬浮卡**：卡片高度按内容自适应（项目少时不留大片空白，最多 400px 超出滚动）；拖到屏幕边缘（26px 内）自动吸附，停稳后缩成极简边缘条；**点击细条展开**，移开 0.5s 缩回；头部 `🧲` 按钮可一键吸附 / 取消吸附；支持左/右/上/下四条边与多屏。
- **悬浮卡内选地址打开**：每个服务的「打开 ▾」在卡片内**内联展开**全部可访问地址（`localhost` + 各局域网 IP），**左键打开、右键复制**；单地址服务直接打开不展开。不用浮层是因为窗口只有 300px 宽，浮层必被窗口边界裁掉。

## 快速开始

```powershell
cd devdeck
pnpm install
pnpm dev        # 开发：node server.js
pnpm run desktop  # 桌面：electron .（内置服务 + 窗口），双击桌面 DevDeck 图标等价
```

浏览器打开 `http://127.0.0.1:3300`（桌面版端口从 3300 起自动找空闲）。

桌面一键启动：项目根 `启动DevDeck.vbs`（无黑窗）+ 桌面 `DevDeck.lnk` 快捷方式，双击即 `pnpm run desktop`。

## 测试

```powershell
pnpm test          # node --test tests，每个测试文件独立子进程（推荐）
pnpm test:inproc   # 受限环境：公司电脑若禁止子进程/命名管道，用单进程顺序跑
```

覆盖七层（共 49 个用例）：

- `tests/sanitize.test.js` — 转义原语（`&`/`<`/`>`/引号、null 归一）
- `tests/render-xss.test.js` — 把真实 `sanitize.js` + `app.js` 放进 vm，验证恶意项目配置渲染后不产生标签
- `tests/service-match.test.js` — 运行中服务 ↔ 本地项目归属匹配：端口漂移撞车时按进程命令行目录认领、端口唯一才兜底、反向匹配不误报「运行中」、父目录前缀不误配
- `tests/request-guard.test.js` — 控制面 Host/Origin 校验（DNS rebinding、跨站请求）
- `tests/store.test.js` — 配置原子写、`.bak` 回滚、坏 JSON 隔离
- `tests/overlay-geometry.test.js` — 悬浮卡吸附判定、停靠条位置（含任务栏夹取）、点击展开位置、光标命中判定、多屏偏移
- `tests/api.test.js` — 真实加载 `server.js`（`child_process` 打桩，不启动真实进程），验证 403 拦截、CRUD、导入合并、kill 白名单、启动命令下发（含 pnpm / npm 端口参数分隔符差异）、静态项目参数、spawn 失败兜底

## 打包分发（v1 流程）

```powershell
pnpm run dist:verify   # 打包 + 自动验包，断言 app.asar.unpacked\static-serve.js 存在
```

- 产物：`release-new/` 下 setup.exe；安装后桌面/开始菜单即有图标。
- 验包失败（`Cannot find module ... static-serve.js` 的旧坑）直接 `exit 1`，不要分发。
- EXE 版配置在 `%APPDATA%\DevDeck\devdeck.json`，源码版在项目根 `devdeck.json`；EXE 首次启动若 userData 为空会自动从源码目录迁移一次。
- 网页 ↔ EXE 迁移：项目页“导出”存 JSON，到另一端“导入”（按 id 合并，同目录自动合并为一条并记 `merged`，不再长出重复）。

## 配置与数据

| 项 | 位置 | 说明 |
|---|---|---|
| 项目配置 | 源码 `devdeck.json` / EXE `%APPDATA%\DevDeck\devdeck.json` | 原子写 + `.bak`，坏文件隔离为 `devdeck.corrupt-*.json`；`POST /api/config/import` 按 id+目录去重合并 |
| 运行日志 | 源码 `logs/` / EXE `%APPDATA%\DevDeck\logs\{id}.log` | 10 分钟瘦身扫描，`DELETE /api/start-log` 清零；孤儿日志保留 30 天 |
| 诊断日志 | `%TEMP%\devdeck-boot.log` | 桌面壳启动/端口/异常 |
| 悬浮卡状态 | EXE userData `overlay-state.json` / 开发 `%TEMP%` | 位置/置顶/停靠边记忆（高度由内容自适应，不落盘） |

## 接口

- `GET /api/node-services` 运行中服务发现（含静态托管）
- `GET/POST/PUT/DELETE /api/custom-projects` 项目 CRUD
- `POST /api/start-project`、`POST /api/start-all`
- `POST /api/kill-service`（仅 node/静态托管且占端口的进程，拒绝误杀）
- `GET /api/check-port`、`GET /api/free-port`
- `GET /api/start-log`、`GET /api/start-log/stream`（SSE）、`DELETE /api/start-log`
- `GET /api/inspect`、`GET /api/browse-dir`（服务端目录浏览）
- `POST /api/diagnose` 结构化诊断（`findings[] + summary`）
- `POST /api/install-deps` 一键安装依赖（按 lockfile 选 pnpm/yarn/npm/bun）
- `GET /api/config/export`、`POST /api/config/import`

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| EXE 里静态项目起不来，日志 `Cannot find module ... app.asar\static-serve.js` | 旧包未解包 | 重跑 `dist:verify` 后重装 |
| 运行中服务看不到 `:5179` | 旧版只采样 `node.exe`，EXE 里静态进程名是 DevDeck.exe | 已修（按命令行 `static-serve.js` 圈定），重装新包 |
| 启动报 `项目不存在`（404） | 页面卡片 id 与后端当前 `devdeck.json` 对不上（两端各一份） | 整页刷新后重试；对齐两端配置 |
| 两条同目录同端口 | 两边各建一次 + 导入只按 id 合并 | 删一条；新版导入已按目录合并 |
| `:5179` 被占（409） | 源码版 + EXE 版双开 | 新版单实例锁会拦；关掉另一个再起 |
| 停靠细条会挡住屏幕边缘一小块点击 | 细条改为“点击展开”，窗口必须接收鼠标，无法再穿透 | 点击细条展开后点头部 `🧲` 取消吸附，改为浮动卡片 |
| 启动了 A 项目，运行中却显示 B 项目名 | 端口没钉住：vite 回落到默认 5173，恰好等于 B 的配置端口，旧匹配逻辑按端口抢先认领 | 已修（匹配改为「命令行目录优先、端口唯一才兜底」）；同时修掉 pnpm 多传 `--` 导致端口静默失效。重启该服务即恢复 |
| 悬浮卡「打开」下拉被窗口截断/显示不全 | 浮层被 300px 固定宽度的透明窗口裁掉 | 已修（改为卡内内联展开，窗口高度自适应跟随） |
| 打包报 `EBUSY / EPERM: rmdir|unlink ...release-new\win-unpacked` | 还有 DevDeck.exe 实例在跑，锁住了产物目录 | 完全退出 DevDeck 后重跑：`Get-Process DevDeck -EA SilentlyContinue \| Stop-Process -Force` |

## 安全

- 控制面（kill / 日志 / 配置）只绑 `127.0.0.1`，不暴露局域网；页面平铺的局域网 URL 是各 dev server 自带监听，便于手机访问。
- **`/api/*` 增加 Host/Origin 校验**（`lib/request-guard.js`）：只接受回环 Host；带 Origin 的请求必须来自同一端口。用于挡 DNS rebinding 与跨站直连——否则任意网页都能驱动本机的 kill/启动接口。
- **前端渲染统一转义**（`public/sanitize.js`）：项目名/目录/命令/进程命令行一律经 `DDSafe` 转义后才进 DOM，动态卡片改事件委托，不再拼 `onclick`。配置导入的 JSON 视为不可信输入。
- `server.js` 用 `spawn` 参数化 PowerShell（-EncodedCommand UTF-16LE），目录/命令含引号已转义；`kill-service` 仅允许终止占端口的 node/静态托管进程，拒绝 DevDeck 自身。
- 悬浮卡「右键复制地址」走主进程 `clipboard.writeText`（IPC `overlay:copy-text`），不用渲染端的 `navigator.clipboard`（悬浮窗里常被权限策略拦截）；地址仍只接受 `http(s)` 才 `shell.openExternal`。
- 配置以服务端 `devdeck.json` 为唯一真相；`localStorage` 只做离线缓存，离线新增的「仅本地」项在连上服务后自动补录。

## P0 安全修复（分支 fix/p0-hardening）

- 修复：配置内容 → 前端 XSS → 本地命令执行（导入恶意 JSON 即可触发）——所有渲染路径统一转义
- 修复：控制面 API 无 Host/Origin 校验，可被 DNS rebinding 驱动——新增请求守卫
- 修复：悬浮卡「终止/重启」结果提示丢失（`overlay-toast` 无人监听）——主窗口接上监听，悬浮卡也内置 toast
- 修复：服务端配置与 `localStorage` 双真相导致删除后仍显示、启动报 404——改为服务端唯一真相
- 新增：`tests/`（20 个用例）与 `pnpm test` / `pnpm test:inproc`

## P1 稳定性修复（分支 fix/p1-stability）

- 配置持久化改为**原子写 + `.bak` + 损坏隔离**（`lib/store.js`）：坏 JSON 不再静默清零，坏文件改名留证并用上一版恢复
- 启动健壮性：目录不存在直接给可读错误；`spawn` 同步抛错与异步 `error` 都有人接（不再拖垮服务）；静态项目不再被追加 `--port`
- 悬浮卡：折叠时同步窗口高度（透明区域不再挡住桌面点击）——折叠功能后续已移除，改为内容自适应高度；折叠/置顶以 `overlay-state.json` 为唯一状态源，去掉每 4 秒的状态轮写
- 一键启动改为**并行等待**各项目就绪，结果里区分「端口被占失败」和「超时未监听」
- 默认端口统一为 `3300`（与 README / 页面提示一致，`PORT` 环境变量仍可覆盖）
- 进程采样不再重复启动，`exec` 同步异常只记 `boot.log`，不影响服务启动
- 测试增至 29 个用例（新增 `tests/store.test.js` 与 4 条 API 回归）

## 0.1.2 / 0.1.3 / 0.1.4 变更（P2 运行时优化 + 悬浮卡，分支 fix/p2-runtime）

- **日志迁出用户项目目录**：统一 `DATA_DIR/logs/{id}.log`，旧 `.devdeck-*.log` / `.cmp-start*.log` 首次访问自动搬运；孤儿日志保留 30 天
- **托盘菜单状态实时**：每次重建菜单按 `overlayWin.isVisible()` 计算「悬浮卡片」勾选态，隐藏/显示后不再残留旧状态
- **进程采样降频**：CIM 采样 5s → 15s，请求触发补采设 10s 下限，并避免上一轮未返回时叠加 PowerShell
- **0.1.3 修复悬浮卡折叠高度**：实测非 resizable 的透明无边框窗口上 `setSize()` 是空操作，改用 `setBounds()`；折叠高度由渲染端按真实面板高度上报（不再写死），宽度固定设计值避免每次 +1px 漂移（折叠功能后续已移除，改为内容自适应高度）
- **0.1.4 悬浮卡边缘停靠**：拖到屏幕边缘 26px 内自动吸附，450ms 后缩成极简边缘条（竖条 32×120 / 横条 120×38，Windows 最小窗口限制）；几何计算抽到 `lib/overlay-geometry.js` 并有单测
- **悬浮卡高度自适应**：渲染端按实际内容实测高度上报，主进程限制 100–400px 并保持窗口在工作区内；项目少时不再固定 400px 留白，超出部分列表滚动
- **细条改为点击展开**：停靠态细条不再鼠标穿透，点击才展开（悬停只做高亮放大反馈），避免鼠标扫过边缘误触；展开后移开 0.5s 缩回
- **移除折叠功能**：原头部折叠按钮改为 `🧲` 吸附按钮（浮动态吸附到最近边缘 / 展开态取消吸附退回浮动），`collapsed` 状态与相关高度逻辑已清理
- 安装包版本 `0.1.4`

## 0.1.4 修订（服务名归属修复 + 悬浮卡选地址打开）

> 沿用 `0.1.4` 版本号（未升版），新安装包覆盖同名文件；如需区分请手动改 `package.json` 的 `version` 后重新打包。

### 修复：启动的明明是 A 项目，卡片却显示 B 项目名

两个 bug 叠加，表象是"名字错了"，实际是**端口根本没生效**。

1. **pnpm 端口透传失效（根因，`server.js`）**

   `launch()` 原来统一拼 `pnpm serve -- --port 5188 --strictPort`。实测 pnpm 8.15 会把 `--` **原样透传给脚本**（npm / yarn / bun 会吞掉），于是 vite 收到的首个参数是 `"--"`，cac 视其为"选项结束"，后续 `--port/--strictPort` 全被当成位置参数（root）——端口配置静默失效，回落到默认 `5173`。

   | 命令 | 脚本实际收到的 argv |
   |---|---|
   | `pnpm serve -- --port 5188 --strictPort` | `["--","--port","5188","--strictPort"]` ✘ |
   | `pnpm serve --port 5188 --strictPort` | `["--port","5188","--strictPort"]` ✔ |
   | `npm run serve -- --port 5188` | `["--port","5188"]` ✔ |

   改为按包管理器选择分隔符（pnpm 用空格，其余用 ` -- `），turbo 场景再多保留一层 `--`。

2. **前端匹配"端口优先"导致张冠李戴（`public/app.js`、`public/overlay.js`）**

   旧 `matchLocal` 是 `items.find(端口命中 || 目录命中)`，`find` 取第一个命中：漂移到 5173 的 DSSDT 进程被排在数组前面的「分层分群项目【HCP】」按端口抢先认领。

   更危险的连带伤害是卡片上的「🔄 重启」：`data-id` 取的是匹配到的项目，对着 DSSDT 点重启会**拿 HCP 的配置去拉起 HCP**。

   改为：**命令行目录命中优先**（多个命中取最长目录，避免父目录前缀抢认）→ **端口唯一命中才兜底**。新增反向 `serviceOf()` 给本地项目找运行中服务，`paintCustomStatus` 复用同一口径，主看板与悬浮卡统一种算法。

### 新增：悬浮卡「打开 ▾」支持多地址选择 + 右键复制

上一版用 `position: fixed` 做浮层菜单，但悬浮卡是**固定 300px 宽的透明窗口**，菜单向右/向下延伸会被窗口边界裁掉（截图里 `192.168.0.106:8084` 正好断在末尾）。

改为**卡内内联展开**（地址列表参与正常文档流，窗口高度自适应跟随）：

- 多地址服务点「打开 ▾」展开全部地址（`localhost` + 各局域网 IP），单地址直接打开
- 每条地址：**左键打开**（`shell.openExternal`）、**右键复制**（主进程 `clipboard.writeText`）
- 展开的地址面板自动 `scrollIntoView`（含窗口变高后补滚一次），不再被列表下边界挡住
- 5s 轮询重渲染时保留已展开状态，服务消失才收起

### 测试

- 新增 `tests/service-match.test.js`（5 例）：用真实漂移命令行做回归，覆盖目录认领、端口唯一兜底、共用端口不猜、反向不误认、父目录前缀不误配
- `tests/api.test.js` 新增 2 例：pnpm 场景断言命令行**不含** `-- --port`；npm 场景断言**保留** `--`
- 用例总数 42 → 49

### 打包备注

`npm run dist` 报 `EBUSY / EPERM: rmdir|unlink ...release-new\win-unpacked` 的唯一原因是**本机还有 DevDeck.exe 实例在跑**，锁住了产物目录。打包前先完全退出：

```powershell
Get-Process DevDeck -ErrorAction SilentlyContinue | Stop-Process -Force
npm run dist:verify
```

## v1.0 变更

- 静态托管 EXE 路径候选兜底 + 缺失明确报错
- 进程采样圈定 `static-serve.js` 宿主（不限 `node.exe`）
- 配置导入按目录去重（`merged` 计数）
- 单实例锁 + userData 首次迁移
- `dist:verify` 打包验包脚本
