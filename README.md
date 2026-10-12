# DevDeck · by GLNB — v1.0

本机多项目开发工作台：统一管理多个 dev server（Vite / Next / Turbo / Vue-CLI / Node 脚本 / 纯静态页面）的启停、端口占用发现、运行日志聚合，一处看板替代 N 个终端窗口。

## 功能一览

- **本地项目管理**：新增 / 编辑 / 删除 / 一键启动 / 批量启动，填目录后自动识别架构、包管理器、默认端口与启动命令（`GET /api/inspect`）。
- **运行中服务发现**：`netstat -ano` + CIM 进程快照（含 CPU 差分、内存），自动圈定 node 服务与静态托管进程，展示监听端口与局域网 URL。
- **静态页面托管**：无 `package.json` 的纯 HTML 目录（如大屏）走内置 `static-serve.js` 托管，需配置端口；源码版用系统 Node，EXE 版用内置 Node（`ELECTRON_RUN_AS_NODE`）。
- **端口治理**：启动前判占（409 + 占用者说明）、自动推荐空闲端口、一键换端口重启；`vue-cli-service` 只走 `PORT/HOST` 环境变量，Turbo 透传 `-- -- --port --strictPort --host`。
- **日志聚合**：各项目日志落 `启动目录/.devdeck-{id}.log`（UTF-8），看板看尾 80 行 + SSE 实时流，超 5MB 自动瘦身到 1MB；CMP 遗留 `.cmp-start*.log` 首次启动自动迁移。
- **辅助诊断**：规则引擎（无 LLM）按日志画像 + 端口归属 + 进程树聚类输出 error/warn/info 结论卡，每条带可执行动作（启动 / 终止占用者 / 换端口 / 安装依赖 / 看日志）。
- **桌面壳**：Electron 主窗口 + 托盘（关窗隐藏）+ 桌面悬浮卡 + 开机自启 + 原生目录选择；**单实例锁**防止双开抢端口。

## 快速开始

```powershell
cd devdeck
pnpm install
pnpm dev        # 开发：node server.js
pnpm run desktop  # 桌面：electron .（内置服务 + 窗口），双击桌面 DevDeck 图标等价
```

浏览器打开 `http://127.0.0.1:3300`（桌面版端口从 3300 起自动找空闲）。

桌面一键启动：项目根 `启动DevDeck.vbs`（无黑窗）+ 桌面 `DevDeck.lnk` 快捷方式，双击即 `pnpm run desktop`。

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
| 项目配置 | 源码 `devdeck.json` / EXE `%APPDATA%\DevDeck\devdeck.json` | `POST /api/config/import` 按 id+目录去重合并 |
| 运行日志 | 各项目目录 `.devdeck-{id}.log` | 10 分钟瘦身扫描，`DELETE /api/start-log` 清零 |
| 诊断日志 | `%TEMP%\devdeck-boot.log` | 桌面壳启动/端口/异常 |
| 悬浮卡状态 | EXE userData `overlay-state.json` / 开发 `%TEMP%` | 位置/置顶/折叠记忆 |

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

## 安全

- 控制面（kill / 日志 / 配置）只绑 `127.0.0.1`，不暴露局域网；页面平铺的局域网 URL 是各 dev server 自带监听，便于手机访问。
- `server.js` 用 `spawn` 参数化 PowerShell（-EncodedCommand UTF-16LE），目录/命令含引号已转义；`kill-service` 仅允许终止占端口的 node/静态托管进程，拒绝 DevDeck 自身。

## v1.0 变更

- 静态托管 EXE 路径候选兜底 + 缺失明确报错
- 进程采样圈定 `static-serve.js` 宿主（不限 `node.exe`）
- 配置导入按目录去重（`merged` 计数）
- 单实例锁 + userData 首次迁移
- `dist:verify` 打包验包脚本
