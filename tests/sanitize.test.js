// 渲染转义：P0-1（配置 → 前端 XSS → 本地命令执行）的最小回归测试
const { test } = require('node:test');
const assert = require('node:assert');
const { escapeHtml, escapeAttr } = require('../public/sanitize');

test('转义标签与事件属性载荷，杜绝 HTML 注入', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const out = escapeHtml(payload);
  assert.equal(out, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.ok(!out.includes('<'));
  assert.ok(!out.includes('>'));
});

test('先转义 &，避免实体被二次解码', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('&lt;script&gt;'), '&amp;lt;script&amp;gt;');
});

test('单双引号都转义，属性值不会被截断', () => {
  assert.equal(escapeAttr(`a'b"c`), 'a&#39;b&quot;c');
});

test('非字符串输入归一化，不产生 "undefined" 文本', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});
