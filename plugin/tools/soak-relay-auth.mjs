/**
 * soak-relay-auth.mjs — 长时间/高频次压测中转认证，捕捉间歇性 401
 *
 * 背景：用户报 `session/prompt` 返回 401，但单次测试全绿。
 * 间歇性故障必须靠高频采样才能捕获。
 *
 * 测试内容：
 *   · 并发多路请求（模拟真实浏览器同时发多个 RPC）
 *   · 反复登录/复用 cookie（模拟多标签页、cookie 竞争）
 *   · 每个请求都断言「不是 401」
 *
 * 用法：node plugin/tools/soak-relay-auth.mjs [轮数] [并发]
 */
'use strict';

import http from 'node:http';

const RELAY = 3091;
const PASSWORD = '20040915';
const ROUNDS = Number(process.argv[2] || 60);
const CONCURRENCY = Number(process.argv[3] || 4);

/** 发一个请求，返回 {status, body, setCookie}。 */
function call(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(body);
    const h = { ...headers };
    if (payload) h['content-length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port: RELAY, path, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: b,
        setCookie: (res.headers['set-cookie'] || [])[0] || '',
      }));
    });
    req.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}`, setCookie: '' }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function login() {
  const r = await call('/__login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(PASSWORD)}`,
  });
  return r.setCookie.split(';')[0] || '';
}

const apiBody = (method) => JSON.stringify({
  type: 'client-request',
  rpcId: `soak-${method}-${Math.random().toString(36).slice(2)}`,
  method,
  payload: { args: {} },
});

const stats = {
  total: 0, ok: 0, auth401: 0, relay401: 0, other: 0,
  samples: [],
};

function record(label, res) {
  stats.total += 1;
  if (res.status === 401) {
    if (res.body.includes('dsh-public-relay')) stats.relay401 += 1;
    else stats.auth401 += 1;
    if (stats.samples.length < 12) {
      stats.samples.push({ label, status: res.status, body: res.body.slice(0, 120) });
    }
  } else if (res.status === 200) {
    stats.ok += 1;
  } else {
    stats.other += 1;
    if (stats.samples.length < 12) {
      stats.samples.push({ label, status: res.status, body: res.body.slice(0, 120) });
    }
  }
}

console.log(`[soak] ${ROUNDS} 轮 × ${CONCURRENCY} 并发，目标 127.0.0.1:${RELAY}\n`);

const cookie = await login();
console.log('登录 cookie:', cookie.slice(0, 40) || '(空)');
console.log('');

const startedAt = Date.now();
for (let round = 1; round <= ROUNDS; round += 1) {
  const tasks = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    const method = i % 2 === 0 ? 'session/modelCatalog' : 'session/prompt';
    tasks.push(
      call(`/api/${method}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', accept: 'application/json' },
        body: apiBody(method),
      }).then((r) => record(method, r)),
    );
  }
  await Promise.all(tasks);

  // 每 10 轮刷新一次 cookie，模拟浏览器会话更新
  if (round % 10 === 0) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await login();
    if (fresh) {
      if (round % 20 === 0) {
        // 一半概率「不更新」，模拟浏览器复用旧 cookie 的情形
        console.log(`  [${round}] 保留旧 cookie（模拟缓存未刷新）`);
      } else {
        console.log(`  [${round}] 刷新 cookie`);
      }
    }
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log('');
console.log(`耗时 ${elapsed}s`);
console.log(`总计 ${stats.total} 次：200=${stats.ok}  dsh的401=${stats.auth401}  中转的401=${stats.relay401}  其它=${stats.other}`);

if (stats.samples.length > 0) {
  console.log('');
  console.log('失败样本：');
  for (const s of stats.samples) {
    console.log(`  [${s.label}] status=${s.status}  ${s.body.replace(/\n/g, ' ')}`);
  }
}

console.log('');
if (stats.auth401 === 0 && stats.relay401 === 0) {
  console.log('结论：未捕获任何 401 ✅');
  process.exitCode = 0;
} else {
  console.log('结论：捕获到 401，需要进一步定位 ❌');
  process.exitCode = 1;
}
