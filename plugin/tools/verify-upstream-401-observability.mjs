/**
 * verify-upstream-401-observability.mjs — 验证「上游 401 观测」是否生效
 *
 * 做法：起一个「一律回 401」的假上游，让 relay 转发过去，
 * 然后读 relay.status().upstream401 看是否记录到了上下文。
 */
'use strict';

import http from 'node:http';
import { createRelay } from '../dsh-public-relay/lib/relay.js';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';

/** 假上游：一律 401，模拟 dsh 拒绝。 */
const upstream = http.createServer((req, res) => {
  res.writeHead(401, { 'content-type': 'text/plain' });
  res.end('unauthorized');
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

const relayPort = await new Promise((r) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

const logs = [];
const relay = createRelay({
  getDshEndpoint: () => ({ host: '127.0.0.1', port: upPort }),
  getConfig: () => ({
    listenHost: '127.0.0.1', listenPort: relayPort, targetHost: null, targetPort: null,
    allowOffHostTarget: false, password: 'pw', forceLoopback: false,
    autoSession: true, compressWebSocket: false,
  }),
  log: (lvl, msg) => logs.push(`${lvl}: ${msg}`),
  sessionSigner: createSessionSigner({ log: () => {} }),
  resolveLaunchToken: () => 'tok',
});
await relay.start();

// 登录
const cookie = await new Promise((resolve) => {
  const p = Buffer.from('password=pw');
  const q = http.request({
    host: '127.0.0.1', port: relayPort, path: '/__login', method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': p.length },
  }, (res) => {
    res.resume();
    res.on('end', () => resolve((res.headers['set-cookie'] || [])[0]?.split(';')[0] || ''));
  });
  q.end(p);
});

// 打一个会 401 的请求
const r = await new Promise((resolve) => {
  const body = Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: 'obs-1', method: 'session/prompt', payload: { args: {} },
  }));
  const q = http.request({
    host: '127.0.0.1', port: relayPort, path: '/api/session/prompt', method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'content-length': body.length },
  }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  q.end(body);
});

const st = relay.status();
const obs = st.upstream401;

console.log(`请求结果: status=${r.status}`);
console.log('');
console.log('── upstream401 观测 ──');
console.log(`  count = ${obs.count}`);
if (obs.last === null) {
  console.log('  ❌ last 为空 —— 观测没生效');
} else {
  console.log(`  last.method = ${obs.last.method}`);
  console.log(`  last.path   = ${obs.last.path}`);
  console.log(`  upstreamAuthority = ${obs.last.upstreamAuthority}`);
  console.log(`  sentRelaySession  = ${obs.last.sentRelaySession}`);
  console.log(`  注入的 dsh-auth cookie 数 = ${obs.last.sentDshCookies.length}`);
  for (const c of obs.last.sentDshCookies) {
    console.log(`    · nameHash=${c.nameHash} v=${c.version} authority=${c.authority}`);
    console.log(`      ageMs=${c.ageMs} remainMs=${c.remainMs}`);
  }
  console.log(`  样本保留数 = ${obs.samples.length}`);
}

console.log('');
console.log('── 相关日志 ──');
for (const l of logs.filter((x) => x.includes('upstream-401'))) console.log(`  ${l}`);

const pass = obs.count === 1 && obs.last !== null && obs.last.path === '/api/session/prompt';
console.log('');
console.log(pass ? '✅ 观测生效：能记录到上游 401 的完整上下文' : '❌ 观测未按预期工作');
process.exitCode = pass ? 0 : 1;

await relay.stop();
upstream.close();
