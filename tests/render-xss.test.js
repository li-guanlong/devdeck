// 渲染回归：把 public/ 下真实的 sanitize.js + app.js 放进 vm，用极简 DOM 桩验证
// 「恶意项目配置进不了 HTML」——覆盖 P0-1 的最终落点（而不只是转义函数本身）。
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

function loadApp() {
  const doc = {
    documentElement: { dataset: {} },
    body: { contains: () => true, appendChild() {}, insertAdjacentHTML() {} },
    getElementById: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeEl()
  };
  const ctx = {
    console,
    document: doc,
    localStorage: { getItem: () => null, setItem() {} },
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

test('项目卡片：恶意名称/目录/命令被转义，不会生成标签', () => {
  const ctx = loadApp();
  const html = ctx.customCardHtml({
    id: 'x"><img src=x onerror=alert(1)>',
    name: '<img src=x onerror=alert(1)>',
    dir: 'D:\\<script>alert(1)</script>',
    cmd: '" onmouseover="alert(1)',
    port: 5173,
    stack: 'Vite'
  });
  assert.ok(!html.includes('<img'), '不应出现原始 <img 标签');
  assert.ok(!html.includes('<script'), '不应出现原始 <script 标签');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), '名称应被实体化后作为文本显示');
  assert.ok(html.includes('&quot; onmouseover=&quot;alert(1)'), '命令中的引号应被转义');
});

test('项目卡片：正常中文/端口/架构仍能正确渲染', () => {
  const ctx = loadApp();
  const html = ctx.customCardHtml({ id: 'abc', name: '南网项目', dir: 'D:\\GitLab-DLLIN\\tsfe-ui', cmd: 'pnpm serve', port: 5178, stack: 'Vite' });
  assert.ok(html.includes('南网项目'));
  assert.ok(html.includes(':5178'));
  assert.ok(html.includes('data-port="5178"'));
  assert.ok(html.includes('data-act="start"'));
});
