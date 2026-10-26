// 悬浮卡停靠几何：吸附判定 / 停靠条位置 / 悬停展开位置（含多屏工作区偏移）
const { test } = require('node:test');
const assert = require('node:assert');
const { nearestEdge, dockBounds, peekBounds } = require('../lib/overlay-geometry');

const WA = { x: 0, y: 0, width: 1920, height: 1040 }; // 1920x1080，底部 40px 任务栏
const CARD = { w: 300, h: 400 };
// Windows 实测最小窗口 32×38，停靠条据此设计
const SIZES = { vertical: { w: 32, h: 120 }, horizontal: { w: 120, h: 38 } };

test('吸附判定：贴近右边缘时返回 right，距离正确', () => {
  const near = nearestEdge({ x: 1620, y: 300, width: 300, height: 400 }, WA);
  assert.equal(near.edge, 'right');
  assert.equal(near.dist, 0);
});

test('吸附判定：离所有边都远时返回最小正值（不会被误吸附）', () => {
  const b = { x: 400, y: 500, width: 300, height: 300 };
  const near = nearestEdge(b, WA);
  const dists = [b.x - WA.x, b.y - WA.y, (WA.x + WA.width) - (b.x + b.width), (WA.y + WA.height) - (b.y + b.height)];
  assert.equal(near.dist, Math.min(...dists));
  assert.ok(near.dist > 24, '应远离所有边缘，不触发吸附');
});

test('吸附判定：窗口有一半在屏幕外时距离为负（仍算贴边）', () => {
  const off = nearestEdge({ x: -80, y: 200, width: 300, height: 400 }, WA);
  assert.equal(off.edge, 'left');
  assert.ok(off.dist < 0);
});

test('停靠条：右边缘贴边、垂直居中并夹在任务栏之内', () => {
  const b = dockBounds('right', { x: 1600, y: 900, width: 300, height: 400 }, WA, SIZES);
  assert.deepEqual(b, { x: 1920 - 32, y: 1040 - 120, width: 32, height: 120 });
});

test('停靠条：左边缘用窗口中心定位，竖条 32×120', () => {
  const b = dockBounds('left', { x: 10, y: 100, width: 300, height: 400 }, WA, SIZES);
  assert.equal(b.x, 0);
  assert.equal(b.y, 100 + 200 - 60);
  assert.equal(b.width, 32);
  assert.equal(b.height, 120);
});

test('停靠条：上/下边缘是横条 120×38', () => {
  const top = dockBounds('top', { x: 800, y: 5, width: 300, height: 400 }, WA, SIZES);
  assert.equal(top.y, 0);
  assert.equal(top.x, 800 + 150 - 60);
  assert.equal(top.width, 120);
  assert.equal(top.height, 38);

  const bottom = dockBounds('bottom', { x: 800, y: 700, width: 300, height: 400 }, WA, SIZES);
  assert.equal(bottom.y, 1040 - 38);
  assert.equal(bottom.width, 120);
});

test('悬停展开：右边缘卡片贴边内缩 gap，宽度恢复 300', () => {
  const tab = { x: 1888, y: 500, width: 32, height: 120 };
  const b = peekBounds('right', tab, WA, CARD, 6);
  assert.equal(b.x, 1920 - 300 - 6);
  assert.equal(b.y, 500 + 60 - 200);
  assert.equal(b.width, 300);
  assert.equal(b.height, 400);
});

test('悬停展开：左边缘靠近任务栏时纵向被夹住', () => {
  const tab = { x: 0, y: 1000, width: 32, height: 120 };
  const b = peekBounds('left', tab, WA, CARD, 6);
  assert.equal(b.x, 6);
  assert.equal(b.y, 1040 - 400); // 夹到工作区底边
});

test('悬停展开：上边缘卡片朝下展开并横向居中', () => {
  const tab = { x: 900, y: 0, width: 120, height: 38 };
  const b = peekBounds('top', tab, WA, CARD, 6);
  assert.equal(b.y, 6);
  assert.equal(b.x, 900 + 60 - 150);
});

test('多屏：工作区带偏移（副屏从 x=1920 开始）时坐标正确', () => {
  const wa2 = { x: 1920, y: 0, width: 1920, height: 1040 };
  const tab = dockBounds('right', { x: 3600, y: 400, width: 300, height: 400 }, wa2, SIZES);
  assert.equal(tab.x, 3840 - 32);
  const peek = peekBounds('right', tab, wa2, CARD, 6);
  assert.equal(peek.x, 3840 - 306);
  assert.equal(nearestEdge({ x: 3540, y: 400, width: 300, height: 400 }, wa2).edge, 'right');
});
