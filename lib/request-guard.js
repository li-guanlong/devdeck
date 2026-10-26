// 本机控制面请求校验。
// 目的：DevDeck 的 API 能启停进程、执行项目启动命令，必须挡住两类攻击：
//   1) DNS rebinding：攻击者域名解析到 127.0.0.1，浏览器会把请求当同源，Host 仍是攻击者域名；
//   2) 跨站直连：页面里的 Origin 不属于本机。
// 规则：/api/* 只接受回环 Host；带 Origin 的请求必须来自同一端口。
const LOOPBACK_HOSTS = new Set([
  '127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1', '[0:0:0:0:0:0:0:1]'
]);

// 解析 Host 头（兼容 IPv6 方括号与可选端口）
function splitHost(hostHeader) {
  const raw = String(hostHeader == null ? '' : hostHeader).trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return null;
  return { hostname: m[1], port: m[2] ? Number(m[2]) : null };
}

function isLoopback(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

// Host 必须是回环地址；显式带端口时必须等于本连接的本地端口（防端口错配/隧道复用）
function checkHost(hostHeader, localPort) {
  const h = splitHost(hostHeader);
  if (!h || !isLoopback(h.hostname)) return false;
  if (h.port == null) return true;
  if (!localPort) return true;
  return h.port === Number(localPort);
}

// 无 Origin（同源 GET、本机脚本、curl）放行；有 Origin 则必须是回环 + 同端口
function checkOrigin(origin, localPort) {
  if (origin == null || origin === '') return true;
  let u;
  try { u = new URL(String(origin)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!isLoopback(u.hostname)) return false;
  if (!localPort) return true;
  // URL 未显式带端口时取其协议默认端口
  const p = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return p === Number(localPort);
}

function createRequestGuard() {
  return function requestGuard(req, res, next) {
    if (!req.path || req.path.indexOf('/api/') !== 0) return next();
    const localPort = req.socket && req.socket.localPort;
    if (!checkHost(req.headers && req.headers.host, localPort)) {
      return res.status(403).json({ error: '已拒绝：Host 不是本机回环地址（疑似 DNS rebinding）' });
    }
    if (!checkOrigin(req.headers && req.headers.origin, localPort)) {
      return res.status(403).json({ error: '已拒绝：跨源请求不被允许' });
    }
    return next();
  };
}

module.exports = { createRequestGuard, checkHost, checkOrigin, splitHost };
