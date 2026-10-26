// 受限环境（公司电脑禁用子进程/命名管道，`node --test` 无法为每个测试文件拉起子进程）下的测试入口：
// 在同一个 node 进程里顺序加载各测试文件。标准入口仍是 `node --test tests`（隔离更好）。
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();

console.log(`单进程模式：顺序运行 ${files.length} 个测试文件`);
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  require(path.join(dir, f)); // 失败时 node:test 会把 process.exitCode 置 1
}
