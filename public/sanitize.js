// DevDeck 安全渲染工具：浏览器里挂到 window.DDSafe，Node 测试直接 require（UMD 双出口）。
// 所有进入 innerHTML / 属性 / dataset 的项目名、目录、命令、进程命令行都必须先过这里。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DDSafe = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // 文本节点：转义全部 HTML 元字符，杜绝标签注入
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => MAP[ch]);
  }

  // 属性值：与文本同规则（引号已转义，不会截断属性）
  function escapeAttr(value) {
    return escapeHtml(value);
  }

  return { escapeHtml, escapeAttr };
});
