#!/usr/bin/env node
/**
 * audit-csrf.mjs — 检验 /dsh-public-relay/config 与 /control 的 CSRF 防护
 *
 * `isTrustedWrite` 的规则：
 *   ① 没有 Origin → 放行
 *   ② Origin 是 dsh-app:// → 放行（Electron 私有 scheme）
 *   ③ 其它 → Origin 必须与 Host 同 authority
 *
 * 关键问题：「没有 Origin 就放行」是否可被跨站利用？
 * 现实约束：浏览器对**跨站**的 POST（表单或 fetch）**一定会带 Origin**，
 * 所以 ① 在浏览器里几乎只可能是同源请求。但要注意两个例外：
 *   · 某些老浏览器的 form POST 在特定情况下不带 Origin
 *   · 非浏览器客户端（curl / 恶意脚本）本来就能直连，不受 CSRF 约束
 * 这里把三种情形都实测一遍，确认行为与注释一致。
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../dsh-public-relay/lib/index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-csrf-'));
const routes = new Map();
const ctx = {
  profileContext: { dir: home, home: os.tmpdir(), name: 'audit' },
  webServer: {
    host: '127.0.0.1',
    port: 19999,
    register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path); },
  },
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const c = fn(); return () => { if (typeof c === 'function') c(); }; },
  get() { return undefined; },
};

apply(ctx, { enabled: false, password: '' });

const handler = routes.get('/dsh-public-relay');
if (handler === undefined) {
  console.error('路由未注册，无法测试');
  process.exit(1);
}

// 起一个真 server 把请求转给 handler
const srv = http.createServer((req, res) => { void handler(req, res); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

function call(method, route, headers = {}, body = null) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const h = { ...headers, connection: 'close' };
    if (payload) {
      h['content-type'] = 'application/json';
      h['content-length'] = payload.length;
    }
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

const HOST = `127.0.0.1:${port}`;
console.log('CSRF 判据实测（/config 是写路由）\n');

const cases = [
  ['无 Origin（非浏览器/同源）', { host: HOST }, 200, '按规则放行'],
  ['同源 Origin', { host: HOST, origin: `http://${HOST}` }, 200, '放行'],
  ['跨站 Origin（http）', { host: HOST, origin: 'http://evil.example.com' }, 403, '应拒绝'],
  ['跨站 Origin（https 隧道）', { host: 'tunnel.example.com', origin: 'https://evil.example.com' }, 403, '应拒绝'],
  ['Electron dsh-app://', { host: HOST, origin: 'dsh-app://app' }, 200, '放行（私有 scheme）'],
  ['Origin 畸形', { host: HOST, origin: 'not a url' }, 403, '应拒绝'],
];

let bad = 0;
for (const [name, headers, expect, note] of cases) {
  const r = await call('POST', '/dsh-public-relay/config', headers, { config: {} });
  const ok = r.status === expect;
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(26)} → ${r.status}（期望 ${expect}；${note}）`);
}

console.log('');
console.log('只读路由 /status：');
for (const m of ['GET', 'POST']) {
  const r = await call(m, '/dsh-public-relay/status', { host: HOST });
  console.log(`  ${m} → ${r.status}`);
}

console.log('');
console.log('方法约束：');
for (const [route, m] of [['/control', 'GET'], ['/config', 'GET']]) {
  const r = await call(m, `/dsh-public-relay${route}`, { host: HOST });
  console.log(`  ${m} ${route} → ${r.status}（期望 405）`);
}

await new Promise((r) => srv.close(r));
fs.rmSync(home, { recursive: true, force: true });
console.log('');
console.log(bad === 0 ? 'CSRF 判据与预期一致 ✅' : `有 ${bad} 项与预期不符 ❌`);
process.exitCode = bad === 0 ? 0 : 1;
