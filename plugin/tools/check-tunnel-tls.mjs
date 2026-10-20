/**
 * check-tunnel-tls.mjs — 检查隧道证书是否被浏览器信任
 *
 * ── 为什么需要这个工具 ──
 *
 * 2026-10 的一次排查里，症状是「经隧道能打开 dsh 页面，但所有操作都报
 * `transport failure for /api: HTTP 401`」。绕了很多圈才定位到真正原因：
 *
 *   隧道启用了 auto_https，但没有绑定自有域名 → 樱花映射只能签**自签证书**
 *   → 浏览器报 ERR_CERT_AUTHORITY_INVALID → 强行「继续前往」后站点处于
 *   不安全上下文，Cookie 无法正常参与 /api 请求 → 全面 401。
 *
 * 而用 `curl -k`（忽略证书）测一切正常，所以「服务器端测通过」并不能排除
 * 这个问题 —— 恰恰 `-k` 把唯一的线索藏起来了。
 *
 * 本工具就是把这个线索变成一条命令：**证书链到底可不可信**。
 *
 * ── 用法 ──
 *
 *   node plugin\tools\check-tunnel-tls.mjs https://frp-dad.com:16689
 *   node plugin\tools\check-tunnel-tls.mjs frp-dad.com 16689
 *
 * ── 判据 ──
 *
 *   · 链验证通过        → 浏览器不会警告，可以正常用
 *   · UntrustedRoot     → 自签证书，浏览器必然警告（需要绑定域名拿公共 CA 证书）
 *   · 域名不匹配        → 证书 CN/SAN 与访问域名不一致
 *   · 证书过期          → 需要重新签发
 *
 * 退出码：0 = 可信；1 = 有问题；2 = 用法错误或连不上。
 */
'use strict';

import tls from 'node:tls';
import { URL } from 'node:url';
import { X509Certificate } from 'node:crypto';

/** 解析命令行参数成 { host, port, servername }。 */
function parseTarget(argv) {
  if (argv.length === 0) return null;

  const first = argv[0];
  if (/^https?:\/\//i.test(first)) {
    let url;
    try {
      url = new URL(first);
    } catch {
      return null;
    }
    const scheme = url.protocol.toLowerCase();
    const port = url.port ? Number(url.port) : (scheme === 'https:' ? 443 : 80);
    return { host: url.hostname, port, servername: url.hostname, scheme };
  }

  // 允许 `host port` 两个参数
  const host = first;
  const port = argv[1] !== undefined ? Number(argv[1]) : 443;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port, servername: host, scheme: 'https' };
}

/**
 * 连上去取证书并做链验证。
 *
 * 用 `rejectUnauthorized: false`：我们**要**在证书不可信时也能拿到证书本身，
 * 否则错误只能拿到一句 "certificate has expired"/"unable to verify"，看不到
 * 到底是谁签的、签给谁的。真正的判定在下面的 checkServerIdentity + 手动链验证。
 */
function inspectTls({ host, port, servername }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: false,
      timeout: 15000,
    });

    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时（15s）`));
    });

    socket.once('error', (err) => reject(new Error(`连接 ${host}:${port} 失败：${err.message}`)));

    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(true);
      const authorized = socket.authorized;
      const authError = socket.authorizationError;
      const protocol = socket.getProtocol();
      const cipher = socket.getCipher();

      socket.end();

      if (!peer || Object.keys(peer).length === 0) {
        reject(new Error('对端没有提供证书'));
        return;
      }

      // 用 node:crypto 的 X509Certificate 拿更结构化的信息（SAN 等）
      let x509 = null;
      try {
        if (peer.raw) x509 = new X509Certificate(peer.raw);
      } catch {
        /* 拿不到结构化信息就只用 peer 的基础字段 */
      }

      resolve({ peer, x509, authorized, authError, protocol, cipher });
    });
  });
}

/** 从 X509Certificate 里取 SAN 列表。 */
function subjectAltNames(x509) {
  if (x509 === null) return [];
  const raw = x509.subjectAltName;
  if (typeof raw !== 'string' || raw === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** SAN 里是否覆盖了目标域名（支持通配符）。 */
function coversHostname(names, hostname) {
  const host = hostname.toLowerCase();
  for (const entry of names) {
    const value = entry.replace(/^DNS:/i, '').toLowerCase();
    if (value === host) return true;
    if (value.startsWith('*.')) {
      const suffix = value.slice(1);   // '.example.com'
      // 通配符只匹配一级：a.example.com 命中，a.b.example.com 不命中
      if (host.endsWith(suffix)) {
        const head = host.slice(0, host.length - suffix.length);
        if (head !== '' && !head.includes('.')) return true;
      }
    }
  }
  return false;
}

/** 主体与签发者是否相同（自签的强特征）。 */
function looksSelfSigned(peer) {
  const subject = peer.subject || {};
  const issuer = peer.issuer || {};
  const keys = ['CN', 'O', 'OU', 'C', 'L', 'ST'];
  const norm = (obj) => keys.map((k) => String(obj[k] ?? '')).join('|');
  return norm(subject) === norm(issuer) && norm(subject) !== '|||||';
}

/** 把 DN 对象渲染成一行可读文本。 */
function formatDN(dn) {
  if (!dn || typeof dn !== 'object') return '(unknown)';
  const parts = [];
  for (const key of ['CN', 'O', 'OU', 'C']) {
    if (dn[key]) parts.push(`${key}=${dn[key]}`);
  }
  return parts.length > 0 ? parts.join(', ') : '(empty)';
}

async function main() {
  const target = parseTarget(process.argv.slice(2));
  if (target === null) {
    console.error('用法：node plugin\\tools\\check-tunnel-tls.mjs <https://host:port | host [port]>');
    console.error('示例：node plugin\\tools\\check-tunnel-tls.mjs https://frp-dad.com:16689');
    process.exitCode = 2;
    return;
  }

  const label = target.scheme === 'https' ? `https://${target.host}:${target.port}` : `${target.host}:${target.port}`;
  console.log(`[check-tunnel-tls] 目标：${label}\n`);

  let info;
  try {
    info = await inspectTls(target);
  } catch (err) {
    console.error(`  ✗ ${err?.message || err}`);
    console.error('\n  隧道可能没在运行，或域名/端口不对。');
    process.exitCode = 2;
    return;
  }

  const { peer, x509, authorized, authError, protocol } = info;
  const selfSigned = looksSelfSigned(peer);
  const sans = subjectAltNames(x509);
  const hostCovered = sans.length === 0
    ? String(peer.subject?.CN || '').toLowerCase() === target.host.toLowerCase()
    : coversHostname(sans, target.host);

  console.log('  证书信息');
  console.log(`    Subject   : ${formatDN(peer.subject)}`);
  console.log(`    Issuer    : ${formatDN(peer.issuer)}`);
  console.log(`    Valid     : ${peer.valid_from || '?'} ~ ${peer.valid_to || '?'}`);
  console.log(`    Protocol  : ${protocol || '?'}`);
  if (sans.length > 0) console.log(`    SAN       : ${sans.join(', ')}`);
  console.log(`    域名匹配  : ${hostCovered ? '是' : '否'}`);
  console.log(`    自签特征  : ${selfSigned ? '是（Subject == Issuer）' : '否'}`);

  console.log('\n  验证结果');
  if (authorized) {
    console.log('    链验证    : 通过 ✅');
  } else {
    console.log(`    链验证    : 失败 ❌  (${authError || 'unknown'})`);
  }

  // ── 结论 ──
  console.log('\n  结论');
  const problems = [];
  if (!authorized) problems.push(`证书链不受信任（${authError || 'unknown'}）`);
  if (!hostCovered) problems.push('证书不覆盖该域名');
  if (selfSigned) problems.push('证书是自签的');

  if (problems.length === 0) {
    console.log('    证书正常，浏览器不会出现安全警告 ✅\n');
    process.exitCode = 0;
    return;
  }

  for (const p of problems) console.log(`    · ${p}`);

  console.log('\n    浏览器会显示「您的连接不是私密连接」/ ERR_CERT_AUTHORITY_INVALID。');
  console.log('    强行点「继续前往」后，站点处于不安全上下文 —— dsh 的 /api 请求');
  console.log('    会因 Cookie 不能正常参与而全面 401（症状：页面能开、操作全挂）。');
  console.log('\n    修复：给隧道绑定一个域名并使用公共 CA 证书。');
  console.log('    · 樱花映射免费方案（无需自有域名）：https://www.natfrp.com/tunnel/domain');
  console.log('      申请 *.nyat.app 子域 → 绑定到该隧道 → 隧道「自动 HTTPS」设为「自动」→ 重启隧道');
  console.log('      启动后日志应出现「已从服务器为 xxx.nyat.app 加载证书」');
  console.log('    · 自有域名方案：https://doc.natfrp.com/frpc/ssl.html');
  console.log('\n    注意：用 curl -k 测试**不会**暴露这个问题（它忽略证书）。');
  console.log('    必须用真实浏览器，或不加 -k 的 curl。\n');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('检查过程异常：', err);
  process.exitCode = 2;
});
