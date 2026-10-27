// 控制面集成测试：真实加载 server.js，但把 child_process 打桩（测试环境不真的拉起 PowerShell/cmd）。
// 覆盖：Host/Origin 防护（P0-2）、配置 CRUD、导入合并、kill 拒绝规则、启动命令下发。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// ---- child_process 打桩：记录 spawn 调用，exec 返回空输出（=无进程/无端口） ----
const spawned = [];
let spawnError = null; // 置为 Error 时，下一次 spawn 同步抛错（模拟 EPERM/ENOENT）
const cp = require('child_process');
cp.exec = (cmd, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; }
  setImmediate(() => cb(null, ''));
  return { on() {}, kill() {} };
};
cp.spawn = (file, args) => {
  spawned.push({ file, args });
  if (spawnError) { const e = spawnError; spawnError = null; throw e; }
  return { pid: 4242, unref() {}, on() {} };
};

// ---- 捕获 server.js 注册的定时器，避免测试进程挂住 ----
const intervals = [];
const timeouts = [];
const realSetInterval = global.setInterval;
const realSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = realSetInterval(...a); intervals.push(t); return t; };
global.setTimeout = (...a) => { const t = realSetTimeout(...a); timeouts.push(t); return t; };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-test-'));
process.env.DEVDECK_NO_LISTEN = '1';
process.env.DEVDECK_DATA_DIR = dataDir;
delete process.env.PORT; // 保证断言的是代码里的默认端口

const { app, PORT } = require('../server');

global.setInterval = realSetInterval;
global.setTimeout = realSetTimeout;

let srv = null;
let port = 0;

before(async () => {
  srv = app.listen(0, '127.0.0.1');
  await new Promise(resolve => srv.once('listening', resolve));
  port = srv.address().port;
});

after(() => {
  try { if (srv) { srv.close(); if (srv.closeAllConnections) srv.closeAllConnections(); } } catch {}
  intervals.forEach(clearInterval);
  timeouts.forEach(clearTimeout);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { Connection: 'close', ...headers };
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const loopback = () => ({ Host: `127.0.0.1:${port}` });

test('同源请求放行，且不回传 x-powered-by', async () => {
  const r = await request('GET', '/api/custom-projects', { headers: loopback() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('DNS rebinding：伪造 Host 被 403 拒绝', async () => {
  const r = await request('GET', '/api/custom-projects', { headers: { Host: `evil.example:${port}` } });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Host/);
});

test('局域网地址 Host 也被拒绝（控制面只对回环开放）', async () => {
  const r = await request('GET', '/api/custom-projects', { headers: { Host: `192.168.1.20:${port}` } });
  assert.equal(r.status, 403);
});

test('跨源 Origin 的写操作被 403 拒绝', async () => {
  const r = await request('POST', '/api/custom-projects', {
    headers: { ...loopback(), Origin: 'http://evil.example' },
    body: { name: 'evil', dir: 'D:\\tmp', cmd: 'pnpm dev' }
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /跨源/);
});

test('创建项目：同源 Origin 放行，重复端口 400', async () => {
  const ok = await request('POST', '/api/custom-projects', {
    headers: { ...loopback(), Origin: `http://127.0.0.1:${port}` },
    body: { name: 'P0测试项目', dir: dataDir, cmd: 'pnpm dev', port: 5311, stack: 'Vite' }
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.name, 'P0测试项目');

  const dup = await request('POST', '/api/custom-projects', {
    headers: loopback(),
    body: { name: 'dup', dir: 'D:\\proj\\p0b', cmd: 'pnpm dev', port: 5311 }
  });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /占用/);
});

test('导入：同目录不同 id 合并为一条（added/updated/merged/skipped 计数）', async () => {
  const r = await request('POST', '/api/config/import', {
    headers: loopback(),
    body: {
      items: [
        { id: 'imp-a', name: '导入A', dir: 'D:\\imp\\x', cmd: 'pnpm dev', port: 5312 },
        { id: 'imp-b', name: '导入B', dir: 'D:\\imp\\x\\', cmd: 'pnpm dev', port: 5313 },
        { id: 'imp-c', name: '缺目录', dir: '', cmd: 'x' }
      ]
    }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    { added: r.json.added, updated: r.json.updated, skipped: r.json.skipped, merged: r.json.merged },
    { added: 1, updated: 1, skipped: 1, merged: 1 }
  );
});

test('kill-service 拒绝 DevDeck 自身与非纳管进程', async () => {
  const self = await request('POST', '/api/kill-service', { headers: loopback(), body: { pid: process.pid } });
  assert.equal(self.status, 400);
  assert.match(self.json.error, /自身/);

  const other = await request('POST', '/api/kill-service', { headers: loopback(), body: { pid: 4 } });
  assert.equal(other.status, 400);
});

test('启动项目：命令经 spawn 下发（打桩捕获，不执行真实进程）', async () => {
  const list = await request('GET', '/api/custom-projects', { headers: loopback() });
  const item = list.json.find(x => x.name === 'P0测试项目');
  assert.ok(item);
  const before = spawned.length;
  const r = await request('POST', '/api/start-project', { headers: loopback(), body: { id: item.id } });
  assert.equal(r.status, 200);
  assert.equal(r.json.pid, 4242);
  assert.equal(spawned.length, before + 1);
  assert.equal(spawned[spawned.length - 1].file, 'powershell.exe');
});

// 取最近一次 launch 的 PowerShell 脚本文本（-EncodedCommand 是 UTF-16LE base64）
function lastLaunchScript() {
  const call = spawned[spawned.length - 1];
  const i = call.args.indexOf('-EncodedCommand');
  return Buffer.from(call.args[i + 1], 'base64').toString('utf16le');
}

test('静态项目：命令行只带位置参数端口，不再追加 --port', async () => {
  const created = await request('POST', '/api/custom-projects', {
    headers: loopback(),
    body: { name: '静态页P1', dir: dataDir, cmd: '内置静态托管（无需命令）', port: 5321, stack: '静态页面' }
  });
  assert.equal(created.status, 200);
  const r = await request('POST', '/api/start-project', { headers: loopback(), body: { id: created.json.id } });
  assert.equal(r.status, 200);
  const cmd = lastLaunchScript();
  assert.match(cmd, /static-serve\.js/);
  assert.ok(/\s5321\b/.test(cmd), '端口应作为位置参数传给 static-serve：' + cmd);
  assert.ok(!/--port/.test(cmd), '静态托管不应再拼接 --port：' + cmd);
});

test('pnpm 项目：端口参数不留 "--"（pnpm 会把它透传给脚本，vite 端口直接失效）', async () => {
  const created = await request('POST', '/api/custom-projects', {
    headers: loopback(),
    body: { name: 'pnpmP2', dir: dataDir, cmd: 'pnpm serve', port: 5331, stack: 'Vite' }
  });
  assert.equal(created.status, 200);
  const r = await request('POST', '/api/start-project', { headers: loopback(), body: { id: created.json.id } });
  assert.equal(r.status, 200);
  const cmd = lastLaunchScript();
  assert.match(cmd, /pnpm serve --port 5331 --strictPort/, 'pnpm 应直接传参：' + cmd);
  assert.ok(!/-- --port/.test(cmd), 'pnpm 场景不能出现 "-- --port"：' + cmd);
});

test('npm 项目：保留 "--" 分隔符（npm 会吞掉它，脚本才收得到端口）', async () => {
  const created = await request('POST', '/api/custom-projects', {
    headers: loopback(),
    body: { name: 'npmP3', dir: dataDir, cmd: 'npm run dev', port: 5332, stack: 'Vite' }
  });
  assert.equal(created.status, 200);
  const r = await request('POST', '/api/start-project', { headers: loopback(), body: { id: created.json.id } });
  assert.equal(r.status, 200);
  const cmd = lastLaunchScript();
  assert.match(cmd, /npm run dev -- --port 5332 --strictPort/, 'npm 需要 "--" 分隔：' + cmd);
});

test('spawn 同步抛错（EPERM）：返回 500 且服务不崩', async () => {
  const list = await request('GET', '/api/custom-projects', { headers: loopback() });
  const item = list.json.find(x => x.name === 'P0测试项目');
  spawnError = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  const r = await request('POST', '/api/start-project', { headers: loopback(), body: { id: item.id } });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /启动器进程创建失败/);
  // 服务仍然可用
  const after = await request('GET', '/api/custom-projects', { headers: loopback() });
  assert.equal(after.status, 200);
});

test('启动目录不存在：直接 500 可读错误，不尝试 spawn', async () => {
  const created = await request('POST', '/api/custom-projects', {
    headers: loopback(),
    body: { name: '坏目录', dir: 'D:\\devdeck-not-exist-' + Date.now(), cmd: 'pnpm dev' }
  });
  assert.equal(created.status, 200);
  const before = spawned.length;
  const r = await request('POST', '/api/start-project', { headers: loopback(), body: { id: created.json.id } });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /启动目录不存在/);
  assert.equal(spawned.length, before, '目录不存在时不应调用 spawn');
});

test('运行日志：项目目录旧日志迁移到 DATA_DIR/logs', async () => {
  const created = await request('POST', '/api/custom-projects', {
    headers: loopback(),
    body: { name: '日志迁移', dir: dataDir, cmd: 'pnpm dev' }
  });
  assert.equal(created.status, 200);
  const legacy = path.join(dataDir, '.cmp-start.log');
  fs.writeFileSync(legacy, 'hello-from-cmp\n');
  const r = await request('GET', '/api/start-log?id=' + encodeURIComponent(created.json.id), { headers: loopback() });
  assert.equal(r.status, 200);
  assert.equal(r.json.exists, true);
  assert.match(r.json.lines.join('\n'), /hello-from-cmp/);
  assert.ok(!fs.existsSync(legacy), '旧日志应被移走，不再留在项目目录');
  assert.ok(fs.existsSync(path.join(dataDir, 'logs', created.json.id + '.log')), '日志应落在 DATA_DIR/logs');
});

test('默认端口与文档一致（3300）', () => {
  assert.equal(PORT, 3300);
});
