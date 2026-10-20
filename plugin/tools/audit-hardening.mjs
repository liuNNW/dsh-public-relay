#!/usr/bin/env node
/**
 * audit-hardening.mjs — 验证本轮安全加固的实际行为
 *
 * 覆盖：
 *   1. ?token= 绕过已封堵（只在 GET / 且恰好一个非空 token 时放行）
 *   2. upgrade 路径未认证时不再泄漏 socket（H1）
 *   3. 登录失败限流（M2）
 *   4. /__login 超大 body 被立刻断开（H2）
 *   5. 响应头注入被中和（M3）
 */
import http from 'node:http';
import net from 'node:net';
import { createRelay, serializeHeaders } from '../dsh-public-relay/lib/relay.js';
import { normalizeConfig } from '../dsh-public-relay/lib/config.js';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ← ' + (detail || '')}`);
};

const up = http.createServer((req, res) => {
  up.seen.push(req.url);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('REACHED');
});
up.seen = [];
await new Promise((r) => up.listen(0, '127.0.0.1', r));

const relayPort = await new Promise((r) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

/**
 * 本进程「当前有效」的 dsh 启动令牌。
 *
 * 0.3.1 起，`?token=` 交换必须**验真**才放行（见 relay.js 的
 * verifyDshTokenExchange）：只校验形状会让浏览器书签里那条来自上一次 dsh
 * 启动的旧 URL 绕过中转口令，随后被 dsh 401 拒绝 —— 用户看到「页面能开、
 * 操作全挂」，而正确行为是给中转登录页。
 *
 * 这里注入一个固定值，让「合法交换」这条正向断言能真正走到上游。
 */
const LAUNCH_TOKEN = 'realtoken';

const relay = createRelay({
  getDshEndpoint: () => ({ host: '127.0.0.1', port: up.address().port }),
  getConfig: () => normalizeConfig({ listenPort: relayPort, password: 'CORRECT-PW' }),
  log: () => {},
  resolveLaunchToken: () => LAUNCH_TOKEN,
});
await relay.start();

function req(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(body);
    const h = { ...headers, connection: 'close' };
    if (payload) h['content-length'] = payload.length;
    const r = http.request({ host: '127.0.0.1', port: relayPort, path, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}

console.log('1) ?token= 绕过');
{
  // 真正的安全属性是「请求有没有到达上游」，而不是状态码：
  // 未认证访问 / 会拿到登录页（200 是**正确**行为）。
  const before = up.seen.length;
  const multi = await req('/?token=a&token=b');
  const multiReached = up.seen.length > before;
  check('多个 token 不被当作令牌交换（未到上游）', !multiReached, `上游收到 ${up.seen.slice(before).join(',')}`);
  check('多个 token 时返回登录页', multi.body.includes('访问口令'), multi.body.slice(0, 60));

  const before2 = up.seen.length;
  const empty = await req('/?token=');
  const emptyReached = up.seen.length > before2;
  check('空 token 不被当作令牌交换（未到上游）', !emptyReached, `上游收到 ${up.seen.slice(before2).join(',')}`);

  // 合法的令牌交换（GET / 恰好一个 token，且**与当次 launchToken 相等**）必须放行到上游
  const before3 = up.seen.length;
  const good = await req(`/?token=${LAUNCH_TOKEN}`);
  check('合法令牌交换放行到上游', up.seen.length > before3 && good.body.includes('REACHED'),
    `status=${good.status} seen=${up.seen.slice(before3).join(',')}`);

  // 0.3.1 新增：形状合法但**值不对**（如浏览器书签里上一次启动的旧 token）
  // 必须被拦住 —— 否则会绕过中转口令、再把用户丢进 dsh 的 401 死路。
  const before4 = up.seen.length;
  const stale = await req('/?token=STALE-TOKEN-FROM-LAST-BOOT');
  check('过期 token 不放到上游', up.seen.length === before4,
    `上游收到 ${up.seen.slice(before4).join(',')}`);
  check('过期 token 时返回登录页', stale.body.includes('访问口令'), stale.body.slice(0, 60));
}

console.log('');
console.log('2) upgrade 未认证不泄漏 socket（H1）');
{
  const closed = await new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: relayPort });
    let got = '';
    const timer = setTimeout(() => { sock.destroy(); resolve({ closed: false, got }); }, 2500);
    sock.on('connect', () => {
      // 故意带 Accept: text/html —— 这正是旧实现会漏 socket 的条件
      sock.write('GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAccept: text/html\r\n\r\n');
    });
    sock.on('data', (d) => { got += d.toString(); });
    sock.on('close', () => { clearTimeout(timer); resolve({ closed: true, got }); });
    sock.on('error', () => { clearTimeout(timer); resolve({ closed: true, got }); });
  });
  check('带 Accept: text/html 的未认证 upgrade 被关闭', closed.closed, 'socket 仍开着');
  check('并且回了 401', closed.got.includes('401'), JSON.stringify(closed.got.slice(0, 60)));
}

console.log('');
console.log('3) 登录失败限流（M2）');
{
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const r = await req('/__login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9' },
      body: 'password=wrong',
    });
    statuses.push(r.status);
  }
  const limited = statuses.filter((s) => s === 429).length;
  check(`连续 12 次错误口令后出现限流（429 x${limited}）`, limited > 0, statuses.join(','));
  // 正确口令在限流窗口内也应被挡（限流优先）
  const during = await req('/__login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9' },
    body: 'password=CORRECT-PW',
  });
  check('限流窗口内正确口令也被挡（429）', during.status === 429, String(during.status));
  // 另一个 IP 不受影响
  const other = await req('/__login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7' },
    body: 'password=CORRECT-PW',
  });
  check('其他 IP 不受影响（可正常登录）', other.status === 302, String(other.status));
}

console.log('');
console.log('4) 超大登录 body（H2）');
{
  const big = 'password=' + 'x'.repeat(200 * 1024);
  const r = await req('/__login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.99' },
    body: big,
  });
  check(`200KB body → ${r.status}（期望 413 或连接被断）`, r.status === 413 || r.status === 0, String(r.status));
}

console.log('');
console.log('5) 响应头注入（M3）');
{
  const out = serializeHeaders({ upgrade: 'websocket\r\nX-Injected: yes', connection: 'Upgrade', 'bad name': 'v' });
  const lines = out.split('\r\n').filter(Boolean);
  check('注入的 CRLF 被中和（仍只有 2 个头行）', lines.length === 2, JSON.stringify(lines));
  check('非法头名被丢弃', !out.includes('bad name'));
}

await relay.stop();
up.close();
console.log('');
console.log(bad === 0 ? '本轮加固全部生效 ✅' : `${bad} 项未达预期 ❌`);
process.exitCode = bad === 0 ? 0 : 1;
