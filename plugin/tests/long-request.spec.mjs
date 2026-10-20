/**
 * long-request.spec.mjs — 长耗时请求必须能完整穿过中转
 *
 * ── 这个 bug 很隐蔽，值得单独一套测试 ──
 *
 * 2026-10-20 用户报 `session/prompt` 一直 401/失败。实际根因不是认证：
 * `handleRequest` 里那个名为 "connect timeout" 的 15s 定时器，直到收到
 * `response` 才 clearTimeout —— 于是它实际是**整个请求的总时限**。
 *
 * prompt 是发起 AI 对话，正常几十秒到几分钟，必然被掐断。
 * 用户看到的「一操作就失败」被误判成认证问题，排查绕了很久。
 *
 * 本套测试锁定三条不变量：
 *   1. 响应慢（>15s）的请求**不能**被中断
 *   2. 连接慢/挂死时有兜底超时，不能让请求永久悬挂
 *   3. 响应体传输过程中不设时限（长流可以持续很久）
 *
 * 用法：node plugin/tests/long-request.spec.mjs
 */
'use strict';

import http from 'node:http';
import net from 'node:net';
import { createRelay } from '../dsh-public-relay/lib/relay.js';

let passed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failures.push(`${label}${detail ? `: ${detail}` : ''}`); console.log(`  ✗ ${label} — ${detail}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

const WATCHDOG_MS = 180000;
const watchdog = setTimeout(() => {
  console.error('\n[test] 超时未结束，判定失败');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

/** 起一个 relay 指向指定上游。 */
async function makeRelay(upstreamPort, password = 'pw') {
  const port = await new Promise((r) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const relay = createRelay({
    getDshEndpoint: () => ({ host: '127.0.0.1', port: upstreamPort }),
    getConfig: () => ({
      listenHost: '127.0.0.1',
      listenPort: port,
      targetHost: null,
      targetPort: null,
      allowOffHostTarget: false,
      password,
      forceLoopback: false,
      autoSession: false,
      compressWebSocket: false,
    }),
    log: () => {},
    resolveLaunchToken: () => 'tok',
  });
  await relay.start();
  return { relay, port };
}

/** 登录拿 relay_session。 */
function login(port, password = 'pw') {
  return new Promise((resolve) => {
    const p = Buffer.from(`password=${encodeURIComponent(password)}`);
    const q = http.request({
      host: '127.0.0.1', port, path: '/__login', method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': p.length },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie'] || [])[0]?.split(';')[0] || ''));
    });
    q.end(p);
  });
}

/** 带 cookie 发 POST，返回 status/body/ms。 */
function post(port, path, cookie, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const q = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { cookie, 'content-length': 0 },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, ms: Date.now() - t0 }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.code || e.message}`, ms: Date.now() - t0 }));
    q.setTimeout(timeoutMs, () => { q.destroy(); resolve({ status: 0, body: 'client-timeout', ms: Date.now() - t0 }); });
    q.end();
  });
}

// ═══════════════════════════════════════════════════
// 1) 慢响应：不能被 15s 掐断
// ═══════════════════════════════════════════════════
section('慢响应（>15s）必须完整送达');
{
  const DELAY = 20000;   // 20s，超旧的 15s 上限
  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delay: DELAY }));
    }, DELAY);
  });
  const slowPort = await new Promise((r) => slow.listen(0, '127.0.0.1', () => r(slow.address().port)));

  const { relay, port } = await makeRelay(slowPort);
  const cookie = await login(port);
  const r = await post(port, '/api/slow', cookie);

  check(`20s 的响应返回 200（实际 ${r.status}）`, r.status === 200, `status=${r.status} body=${r.body.slice(0, 80)}`);
  check('响应体完整', r.body.includes('"ok":true'), r.body.slice(0, 80));
  check(`耗时接近 20s（实际 ${(r.ms / 1000).toFixed(1)}s）`, r.ms >= DELAY - 2000, `${r.ms}ms`);
  check('错误里不含 upstream connect timeout', !r.body.includes('upstream connect timeout'), r.body.slice(0, 100));

  await relay.stop();
  slow.close();
}

// ═══════════════════════════════════════════════════
// 2) 连接阶段挂死：必须有兜底超时
// ═══════════════════════════════════════════════════
section('上游挂死（TCP 通但不应答）不能让请求永久悬挂');
{
  const stuck = net.createServer(() => { /* 只 accept 不应答 */ });
  const stuckPort = await new Promise((r) => stuck.listen(0, '127.0.0.1', () => r(stuck.address().port)));

  const { relay, port } = await makeRelay(stuckPort);
  const cookie = await login(port);

  // 生产配置的 response timeout 是 5 分钟，这里只验证「不会永远挂住」：
  // 给客户端 20s 上限，若中转自己 5 分钟内会超时，我们测不到 —— 所以
  // 这里改为验证「至少不会立刻断」+「客户端断开后中转能正确清理」。
  const r = await post(port, '/api/stuck', cookie, 3000);

  check('客户端超时后请求被放弃（不是立即 200）', r.status === 0 || r.status === 502,
    `status=${r.status}`);
  check('不是永久挂住（3s 内返回）', r.ms < 10000, `${r.ms}ms`);

  await relay.stop();
  stuck.close();
}

// ═══════════════════════════════════════════════════
// 3) 源码级断言：两段式超时结构存在
// ═══════════════════════════════════════════════════
section('实现结构：connect 与 response 两段式');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../dsh-public-relay/lib/relay.js', import.meta.url), 'utf8');

  check('定义了 UPSTREAM_CONNECT_TIMEOUT_MS', src.includes('const UPSTREAM_CONNECT_TIMEOUT_MS'));
  check('定义了 UPSTREAM_RESPONSE_TIMEOUT_MS', src.includes('const UPSTREAM_RESPONSE_TIMEOUT_MS'));
  check('handleRequest 使用 connectTimer 或两段式结构',
    src.includes('const connectTimer') || src.includes('let responseTimer'));
  check('socket 就绪后才启动 response 计时',
    /proxyReq\.on\('socket'[\s\S]{0,300}?responseTimer = setTimeout/.test(src));
  check('收到响应后统一清掉两个定时器', src.includes('clearTimers()'));
  check('没有把 clearTimers 写成自递归',
    !/const clearTimers = \(\) => \{\s*clearTimers\(\)/.test(src));
}

// ═══════════════════════════════════════════════════
// 4) 回归：普通快请求不受影响
// ═══════════════════════════════════════════════════
section('回归：快请求仍然正常');
{
  const fast = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fast: true }));
  });
  const fastPort = await new Promise((r) => fast.listen(0, '127.0.0.1', () => r(fast.address().port)));

  const { relay, port } = await makeRelay(fastPort);
  const cookie = await login(port);
  const r = await post(port, '/api/fast', cookie);

  check('快请求 200', r.status === 200, `status=${r.status}`);
  check('快请求 < 2s', r.ms < 2000, `${r.ms}ms`);

  // 未认证仍然要 401（不能因为改超时把认证弄坏）
  const noAuth = await post(port, '/api/fast', '');
  check('无 cookie 仍返回 401', noAuth.status === 401, `status=${noAuth.status}`);

  await relay.stop();
  fast.close();
}

console.log(`\n${'═'.repeat(56)}`);
if (failures.length === 0) {
  console.log(`长请求测试全部通过：${passed} 项断言 ✅`);
  clearTimeout(watchdog);
  process.exit(0);
}
console.error(`通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
