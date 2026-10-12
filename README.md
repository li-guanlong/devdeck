# DevDeck · by GLNB

本机开发工作台：在一处管理多个 dev server（Vite / Next / Turbo / Node 脚本）的启停，
自动发现端口占用、自动找空闲端口、日志聚合在 Web 看板里看。

## 启动

```powershell
pnpm install        # 或 npm install
pnpm start          # node server.js，默认端口 3300
```

浏览器打开 http://localhost:3300

`PORT` 环境变量可改端口：
```powershell
$env:PORT=3310; node server.js
```

桌面壳（托盘 / 开机自启 / 原生目录选择框）：

```powershell
pnpm install          # 会装上 devDependencies 的 electron
pnpm run desktop      # electron .，内置服务 + 桌面窗口
```

安全说明：控制面 API 只监听 127.0.0.1（仅本机可调 kill / 日志 / 配置接口）；
页面上平铺的局域网 URL 是各 dev server 自带的监听地址，手机可直接访问，无需 DevDeck 本身暴露。

## 前置依赖（exe 版必看）

- 用户启动的命令（`pnpm serve`、`vite` 等）需要本机装好 Node.js 18+ 和对应包管理器（PATH 可用）；
  exe 本体不捆绑这些，只自带"静态页面"托管所需的运行时；
- 网页 ↔ exe 迁移配置：本地项目页点"⬇ 导出"存 JSON，到另一端点"⬆ 导入"即可（按 id 合并）；
- 打包 exe：`pnpm run dist`（产物在 `release/`，不进 git）。

## 配置

- 项目配置存在 `devdeck.json`（服务端）+ 浏览器 localStorage（双写互备）。
- 运行日志落在各项目目录下 `.devdeck-{id}.log`，超 5MB 自动瘦身。
- 从 CMP 迁移过来的旧日志（`.cmp-start*.log`）首次启动该项目时自动改名沿用。

## 接口

- `GET /api/node-services` 运行中 node 服务发现
- `GET/POST/PUT/DELETE /api/custom-projects` 项目 CRUD
- `POST /api/start-project`、`POST /api/start-all`
- `POST /api/kill-service`
- `GET /api/check-port`、`GET /api/free-port`
- `GET /api/start-log`、`GET /api/start-log/stream`、`DELETE /api/start-log`
