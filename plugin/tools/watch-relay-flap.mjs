/**
 * watch-relay-flap.mjs — 持续观测 relay，捕捉「间歇性全 401」的时间窗口
 *
 * 已知现象：
 *   · 13:33 左右，经中转 30/30 全 401（两种文案都有）
 *   · 13:35 之后，同一 relay 又全部 200
 *   · relay 本身没重启（startedAt 不变）
 *
 * 说明 relay 在某个时刻进入过「代签失效」的短暂状态，然后自行恢复。
 *
 * 本脚本每隔 N 毫秒打一次，记录状态码与耗时，一旦出现连续 401 就打印现场。
 * 用法：node plugin/tools/watch-relay-flap.mjs [总秒数] [间隔ms]
 */
'use strict';

import http from 'node:http';

const RELAY = 3091;
const PASSWORD = '20040915';
const TOTAL_SEC = Number(process.argv[2] || 120);
const INTERVAL_MS = Number(process.argv[3] || 500);

function login() {
  return new Promise((resolve) => {
    const p = Buffer.from(`password=${encodeURIComponent(PASSWORD)}`);
    const q = http.request({
      host: '127.0.0.1', port: RELAY, path: '/__login', method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': p.length },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve((res.headers['set-cookie'] || [])[0]?.split(';')[0] || ''));
    });
    q.end(p);
  });
}

function probe(cookie, path) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const q = http.request({
      host: '127.0.0.1', port: RELAY, path, method: 'GET',
      headers: cookie ? { cookie } : {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 70), ms: Date.now() - t0 }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}`, ms: Date.now() - t0 }));
    q.end();
  });
}

const cookie = await login();
console.log(`[watch] cookie=${cookie.slice(0, 40)}`);
console.log(`[watch] 每 ${INTERVAL_MS}ms 打一次 GET /，共 ${TOTAL_SEC}s\n`);

const started = Date.now();
let n = 0;
let fails = 0;
let consecutiveFail = 0;
let firstFailAt = null;

while (Date.now() - started < TOTAL_SEC * 1000) {
  n += 1;
  const r = await probe(cookie, '/');
  if (r.status !== 200) {
    fails += 1;
    consecutiveFail += 1;
    if (firstFailAt === null) firstFailAt = new Date().toISOString();
    if (consecutiveFail <= 3 || consecutiveFail % 10 === 0) {
      console.log(`  ❌ #${n} t=${((Date.now() - started) / 1000).toFixed(1)}s status=${r.status} (${r.ms}ms) 连败=${consecutiveFail}`);
      console.log(`      ${r.body}`);
    }
  } else {
    if (consecutiveFail > 0) {
      console.log(`  ✅ 恢复：#${n} t=${((Date.now() - started) / 1000).toFixed(1)}s（此前连败 ${consecutiveFail} 次）`);
    }
    consecutiveFail = 0;
  }
  await new Promise((r2) => setTimeout(r2, INTERVAL_MS));
}

console.log('');
console.log(`[watch] 共 ${n} 次，失败 ${fails} 次`);
if (firstFailAt !== null) {
  console.log(`[watch] 首次失败于 ${firstFailAt}`);
  console.log('  → relay 存在「代签瞬时失效」窗口，需要继续定位');
} else {
  console.log('[watch] 本轮未捕获失败 —— 故障窗口较窄，需要更长观测或特定触发条件');
}
