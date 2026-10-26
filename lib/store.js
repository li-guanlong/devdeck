// devdeck.json 的持久化：原子写 + 上一版备份 + 损坏文件隔离。
// 目的：一次坏写/断电/半截 JSON 不能把用户的全部项目配置静默清零。
const fs = require('fs');
const path = require('path');

function createStore(dir, opts = {}) {
  const file = path.join(dir, 'devdeck.json');
  const backupFile = file + '.bak';
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  function readArray(p) {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : null;
  }

  function quarantine(reason) {
    let stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '');
    let dst = path.join(dir, `devdeck.corrupt-${stamp}.json`);
    let i = 1;
    while (fs.existsSync(dst)) dst = path.join(dir, `devdeck.corrupt-${stamp}-${i++}.json`);
    try {
      fs.renameSync(file, dst);
      log(`配置解析失败（${reason}），已隔离为 ${path.basename(dst)}`);
    } catch (e) {
      log(`配置解析失败（${reason}），隔离文件失败：${e.message}`);
    }
  }

  function load() {
    // 主文件不存在：优先恢复上一版备份（例如上次写入后进程被杀）
    if (!fs.existsSync(file)) {
      try {
        const bak = readArray(backupFile);
        if (bak) { log('主配置不存在，已从 devdeck.json.bak 恢复'); return bak; }
      } catch {}
      return [];
    }
    try {
      const arr = readArray(file);
      if (arr) return arr;
      quarantine('顶层不是数组');
    } catch (e) {
      quarantine(e.message);
    }
    // 坏文件已隔离，用备份兜底，避免用户配置直接消失
    try {
      const bak = readArray(backupFile);
      if (bak) { log('已从 devdeck.json.bak 恢复配置'); return bak; }
    } catch {}
    return [];
  }

  function save(list) {
    const json = JSON.stringify(Array.isArray(list) ? list : [], null, 2);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, json, 'utf8');
    // 保留上一版：新内容落盘前先把旧文件复制为 .bak
    try { if (fs.existsSync(file)) fs.copyFileSync(file, backupFile); } catch {}
    fs.renameSync(tmp, file); // 原子替换：崩溃时要么旧文件，要么新文件，不会半截
  }

  return { file, backupFile, load, save };
}

module.exports = { createStore };
