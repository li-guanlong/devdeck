// 匹配回归：运行中服务 ↔ 本地项目归属。真实加载 public/app.js（vm），用极简 DOM 桩只验证匹配规则。
// 场景来源：DSSDT 配置 :5188 但端口没钉住漂到 5173，恰好撞上 HCP 的配置端口 5173，
// 旧逻辑“端口优先”就把它显示成了 HCP —— 项目名张冠李戴，连带“重启”也会拿错配置。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeEl() {
  return {
    dataset: {}, style: {}, textContent: '', innerHTML: '', className: '', title: '',
    disabled: false, checked: false, value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, appendChild() {}, focus() {}, remove() {},
    contains() { return true; }
  };
}

function loadApp(items) {
  const doc = {
    documentElement: { dataset: {} },
    body: { contains: () => true, appendChild() {}, insertAdjacentHTML() {} },
    getElementById: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeEl()
  };
  const cfg = JSON.stringify(items || []);
  const ctx = {
    console,
    document: doc,
    localStorage: { getItem: () => cfg, setItem() {} },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: async () => ({ ok: false, json: async () => [] }),
    URL: { createObjectURL: () => '' },
    Blob: class {},
    addEventListener() {}
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const base = path.join(__dirname, '..', 'public');
  vm.runInContext(fs.readFileSync(path.join(base, 'sanitize.js'), 'utf8'), ctx, { filename: 'sanitize.js' });
  vm.runInContext(fs.readFileSync(path.join(base, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return ctx;
}

const HCP = { id: 'hcp', name: '分层分群项目【HCP】', dir: 'D:\\GitLab-DLLIN\\HCP\\hcp-ui', port: 5173 };
const DSSDT = { id: 'dssdt', name: '供电安全诊断【DSSDT】', dir: 'D:\\GitLab-DLLIN\\DSSDT\\dssdt-web', port: 5188 };
const dssdtSvc = {
  pid: 34212,
  name: 'vite.js',
  command: 'node   "D:\\GitLab-DLLIN\\DSSDT\\dssdt-web\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js" "--port" "5188"',
  ports: [5173]
};

test('端口漂移撞上别的项目端口：按命令行目录认领，显示自己的名字', () => {
  const ctx = loadApp([HCP, DSSDT]);
  assert.equal(ctx.matchLocal(dssdtSvc).id, 'dssdt');
  assert.equal(ctx.dispName(dssdtSvc), '供电安全诊断【DSSDT】');
});

test('命令行不带目录时按端口兜底：端口唯一命中照常认领', () => {
  const ctx = loadApp([HCP, DSSDT]);
  const svc = { pid: 1, name: 'some.js', command: 'node some.js', ports: [5173] };
  assert.equal(ctx.matchLocal(svc).id, 'hcp');
});

test('端口被多个项目配置共用且无目录证据：不猜，保留进程原名', () => {
  const twin = { id: 'twin', name: '重复端口项目', dir: 'D:\\other\\twin', port: 5173 };
  const ctx = loadApp([HCP, twin]);
  const svc = { pid: 2, name: 'some.js', command: 'node some.js', ports: [5173] };
  assert.equal(ctx.matchLocal(svc), null);
  assert.equal(ctx.dispName(svc), 'some.js');
});

test('反向匹配：漂移的服务不会被端口撞车的项目认领为“运行中”', () => {
  const ctx = loadApp([HCP, DSSDT]);
  const services = [dssdtSvc];
  assert.equal(ctx.serviceOf(HCP, services), null, 'HCP 不能认领 DSSDT 的进程');
  assert.equal(ctx.serviceOf(DSSDT, services).pid, 34212);
});

test('目录前缀相似时不误配（取最长目录命中）', () => {
  const parent = { id: 'p', name: '父工程', dir: 'D:\\GitLab-DLLIN\\DSSDT', port: 5100 };
  const child = { id: 'c', name: '子工程', dir: 'D:\\GitLab-DLLIN\\DSSDT\\dssdt-web', port: 5188 };
  const ctx = loadApp([parent, child]);
  assert.equal(ctx.matchLocal(dssdtSvc).id, 'c');
});
