// 悬浮卡停靠几何：纯函数，便于单元测试。
// 概念：
//   - 普通态：300×400 的卡片，可拖动；
//   - 吸附：卡片任一边距屏幕工作区边缘 <= SNAP_PX 时贴边；
//   - 停靠（极简）：缩成 14×120（左右）或 120×14（上下）的边缘条；
//   - 悬停展开（peek）：从边缘条展开为完整卡片，且始终朝屏幕内侧展开。
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function edges(workArea) {
  return {
    left: workArea.x,
    top: workArea.y,
    right: workArea.x + workArea.width,
    bottom: workArea.y + workArea.height
  };
}

// 返回距离最近的屏幕边缘（dist 可能为负：窗口有一部分已在屏幕外，也算"贴边"）
function nearestEdge(bounds, workArea) {
  const e = edges(workArea);
  const cands = [
    { edge: 'left', dist: bounds.x - e.left },
    { edge: 'right', dist: e.right - (bounds.x + bounds.width) },
    { edge: 'top', dist: bounds.y - e.top },
    { edge: 'bottom', dist: e.bottom - (bounds.y + bounds.height) }
  ];
  cands.sort((a, b) => a.dist - b.dist);
  return cands[0];
}

// 停靠条：以当前窗口中心对齐到该边缘；sizes = { vertical: {w,h}, horizontal: {w,h} }
// 注意：Windows 对窗口有最小尺寸（实测 32×38），所以竖条 32 宽、横条 38 高，别设更小。
function dockBounds(edge, bounds, workArea, sizes) {
  const e = edges(workArea);
  const vertical = edge === 'left' || edge === 'right';
  const w = vertical ? sizes.vertical.w : sizes.horizontal.w;
  const h = vertical ? sizes.vertical.h : sizes.horizontal.h;
  let x = bounds.x;
  let y = bounds.y;
  if (edge === 'left') {
    x = e.left;
    y = clamp(bounds.y + bounds.height / 2 - h / 2, e.top, e.bottom - h);
  } else if (edge === 'right') {
    x = e.right - w;
    y = clamp(bounds.y + bounds.height / 2 - h / 2, e.top, e.bottom - h);
  } else if (edge === 'top') {
    y = e.top;
    x = clamp(bounds.x + bounds.width / 2 - w / 2, e.left, e.right - w);
  } else {
    y = e.bottom - h;
    x = clamp(bounds.x + bounds.width / 2 - w / 2, e.left, e.right - w);
  }
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

// 悬停展开：卡片贴住同一条边、朝屏幕内侧让出 gap，并在另一轴保持居中
function peekBounds(edge, tabBounds, workArea, card, gap) {
  const e = edges(workArea);
  let x = tabBounds.x;
  let y = tabBounds.y;
  if (edge === 'left') {
    x = e.left + gap;
    y = clamp(tabBounds.y + tabBounds.height / 2 - card.h / 2, e.top, e.bottom - card.h);
  } else if (edge === 'right') {
    x = e.right - card.w - gap;
    y = clamp(tabBounds.y + tabBounds.height / 2 - card.h / 2, e.top, e.bottom - card.h);
  } else if (edge === 'top') {
    y = e.top + gap;
    x = clamp(tabBounds.x + tabBounds.width / 2 - card.w / 2, e.left, e.right - card.w);
  } else {
    y = e.bottom - card.h - gap;
    x = clamp(tabBounds.x + tabBounds.width / 2 - card.w / 2, e.left, e.right - card.w);
  }
  return { x: Math.round(x), y: Math.round(y), width: card.w, height: card.h };
}

module.exports = { clamp, nearestEdge, dockBounds, peekBounds };
