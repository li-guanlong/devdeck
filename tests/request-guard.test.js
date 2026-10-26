// 请求校验：P0-2（DNS rebinding / 跨站直连 → 本地命令执行）的最小单元测试
const { test } = require('node:test');
const assert = require('node:assert');
const { checkHost, checkOrigin } = require('../lib/request-guard');

test('回环 Host 放行（IPv4 / localhost / IPv6）', () => {
  assert.equal(checkHost('127.0.0.1:3300', 3300), true);
  assert.equal(checkHost('localhost:3300', 3300), true);
  assert.equal(checkHost('LOCALHOST:3300', 3300), true);
  assert.equal(checkHost('[::1]:3300', 3300), true);
  assert.equal(checkHost('127.0.0.1', 3300), true);
});

test('DNS rebinding 与非回环 Host 一律拒绝', () => {
  assert.equal(checkHost('evil.example:3300', 3300), false);
  assert.equal(checkHost('127.0.0.1.evil.example:3300', 3300), false);
  assert.equal(checkHost('192.168.1.9:3300', 3300), false);
  assert.equal(checkHost('', 3300), false);
  assert.equal(checkHost(undefined, 3300), false);
});

test('Host 端口与本连接不一致时拒绝（防端口复用/隧道错配）', () => {
  assert.equal(checkHost('127.0.0.1:5199', 3300), false);
});

test('Origin：缺失（同源 GET / 本机工具）放行，同源放行', () => {
  assert.equal(checkOrigin(undefined, 3300), true);
  assert.equal(checkOrigin('', 3300), true);
  assert.equal(checkOrigin('http://127.0.0.1:3300', 3300), true);
  assert.equal(checkOrigin('http://localhost:3300', 3300), true);
});

test('Origin：跨站 / 非回环 / 非法值拒绝', () => {
  assert.equal(checkOrigin('http://evil.example', 3300), false);
  assert.equal(checkOrigin('https://evil.example:3300', 3300), false);
  assert.equal(checkOrigin('null', 3300), false);
  assert.equal(checkOrigin('file:///C:/x.html', 3300), false);
});

test('Origin 端口与本地端口不一致时拒绝', () => {
  assert.equal(checkOrigin('http://127.0.0.1:5199', 3300), false);
});
