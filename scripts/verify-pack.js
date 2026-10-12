// 打包验包：断言 static-serve 解包 + 关键文件齐全，避免 EXE 里静态托管起不来
const fs = require('fs');
const path = require('path');
const base = path.join(__dirname, '..', 'release-new', 'win-unpacked', 'resources');
const must = [
  path.join(base, 'app.asar.unpacked', 'static-serve.js'),
  path.join(base, 'app.asar'),
];
let fail = 0;
for (const p of must) {
  const ok = fs.existsSync(p);
  console.log((ok ? 'PASS ' : 'FAIL ') + p);
  if (!ok) fail++;
}
if (fail) { console.error('验包失败：static-serve 未解包，EXE 里静态托管必报 Cannot find module'); process.exit(1); }
console.log('验包通过');
