// 配置持久化：原子写 / 上一版备份 / 损坏文件隔离（P1：一次坏写不再清零全部项目）
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../lib/store');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dd-store-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

test('保存后可读回，连续保存保留上一版 .bak', () => {
  const dir = tmpDir();
  try {
    const s = createStore(dir);
    s.save([{ id: 'a' }]);
    assert.deepEqual(s.load(), [{ id: 'a' }]);
    s.save([{ id: 'b' }]);
    assert.deepEqual(s.load(), [{ id: 'b' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.backupFile, 'utf8')), [{ id: 'a' }]);
    assert.equal(fs.readdirSync(dir).filter(f => f.includes('.tmp-')).length, 0, '不应残留临时文件');
  } finally { cleanup(dir); }
});

test('坏 JSON：隔离坏文件并用 .bak 恢复，配置不丢', () => {
  const dir = tmpDir();
  try {
    const s = createStore(dir);
    s.save([{ id: 'a' }, { id: 'b' }]);
    s.save([{ id: 'c' }]);                 // .bak = [a, b]
    fs.writeFileSync(s.file, '{"broken":'); // 模拟写坏
    assert.deepEqual(s.load(), [{ id: 'a' }, { id: 'b' }]);
    assert.equal(s.load().length, 2);       // 再读一次仍稳定（不会再隔离一次）
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('devdeck.corrupt-')), '坏文件应被隔离留证');
  } finally { cleanup(dir); }
});

test('坏 JSON 且无备份：返回空数组、隔离坏文件、不抛异常', () => {
  const dir = tmpDir();
  try {
    const s = createStore(dir);
    fs.writeFileSync(s.file, 'not json at all');
    assert.deepEqual(s.load(), []);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('devdeck.corrupt-')));
  } finally { cleanup(dir); }
});

test('主文件缺失：用 .bak 兜底', () => {
  const dir = tmpDir();
  try {
    const s = createStore(dir);
    s.save([{ id: 'a' }]);
    s.save([{ id: 'b' }]);      // .bak = [a]
    fs.unlinkSync(s.file);
    assert.deepEqual(s.load(), [{ id: 'a' }]);
  } finally { cleanup(dir); }
});

test('顶层不是数组：按损坏处理并隔离', () => {
  const dir = tmpDir();
  try {
    const s = createStore(dir);
    fs.writeFileSync(s.file, '{"not":"array"}');
    assert.deepEqual(s.load(), []);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('devdeck.corrupt-')));
  } finally { cleanup(dir); }
});
