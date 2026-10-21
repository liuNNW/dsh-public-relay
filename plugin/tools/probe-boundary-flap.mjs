/**
 * probe-boundary-flap.mjs — 验证「临界值」导致的间歇性 401
 *
 * 已测出 dsh 的两个硬边界：
 *   ① expiresAt - issuedAt > 30 天  → 401
 *   ② issuedAt > dsh 的 now          → 401（正向偏差 1ms 就拒）
 *
 * 中转的现状：
 *   · 有效期固定签 30 天 → 恰好压在边界①上（>30 才拒，=30 通过，但浮点/毫秒级
 *     差异可能让实际跨度变成 30.0000001 天）
 *   · issuedAt = Date.now()（中转进程）→ 与 dsh 进程的 now 比较，只要 dsh 慢 1ms 就拒
 *
 * 本脚本连续签 200 次并立即请求，统计失败率，验证「临界抖动」是否真实存在。
 */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import { encodeCookie, cookieNameFor } from '../dsh-public-relay/lib/dsh-cookie.js';

const DSH = 19387;
const AUTH = `127.0.0.1:${DSH}`;
const CRED = `${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`;
const ROUNDS = Number(process.argv[2] || 200);

function readSecret() {
  const text = fs.readFileSync(CRED, 'utf8');
  const m = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/.exec(text);
  if (m === null) throw new Error('未找到 secret');
  return m[1];
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || value.length % 4 === 1) return undefined;
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const buf = Buffer.from(value.split('-').join('+').split('_').join('/') + pad, 'base64');
  const re = buf.toString('base64').split('+').join('-').split('/').join('_').replace(/=+$/, '');
  return re === value ? buf : undefined;
}

const secret = decodeBase64Url(readSecret());
const name = cookieNameFor(AUTH);
const DAY = 86400000;

function getIndex(cookieHeader) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const q = http.request({
      host: '127.0.0.1', port: DSH, path: '/', method: 'GET',
      headers: { host: AUTH, cookie: cookieHeader },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0 }));
    });
    q.on('error', (e) => resolve({ status: 0, ms: Date.now() - t0 }));
    q.end();
  });
}

console.log(`连续 ${ROUNDS} 次：签 30 天 cookie（中转现状）→ 立即请求 dsh\n`);

let ok = 0;
let fail = 0;
const failSamples = [];

for (let i = 1; i <= ROUNDS; i += 1) {
  const now = Date.now();
  const span = 30 * DAY;   // 与中转配置一致：2592000000ms
  const value = encodeCookie({
    version: 1, authority: AUTH, issuedAt: now, expiresAt: now + span,
  }, secret);

  const r = await getIndex(`${name}=${value}`);
  if (r.status === 200) {
    ok += 1;
  } else {
    fail += 1;
    if (failSamples.length < 8) {
      failSamples.push({ i, status: r.status, ms: r.ms, issuedAt: now, span });
    }
  }
}

console.log(`结果：200=${ok}  非200=${fail}  失败率=${((fail / ROUNDS) * 100).toFixed(2)}%`);
if (failSamples.length > 0) {
  console.log('\n失败样本：');
  for (const f of failSamples) {
    console.log(`  #${f.i} status=${f.status} (${f.ms}ms) issuedAt=${f.issuedAt} span=${f.span}`);
  }
}

console.log('');
console.log('── 对照：把跨度收紧到 29 天（远离边界①）──');
let ok2 = 0;
let fail2 = 0;
for (let i = 1; i <= Math.min(50, ROUNDS); i += 1) {
  const now = Date.now();
  const span = 29 * DAY;
  const value = encodeCookie({
    version: 1, authority: AUTH, issuedAt: now, expiresAt: now + span,
  }, secret);
  const r = await getIndex(`${name}=${value}`);
  if (r.status === 200) ok2 += 1; else fail2 += 1;
}
console.log(`  200=${ok2}  非200=${fail2}`);

console.log('');
console.log('── 对照：issuedAt 往前挪 1 秒（远离边界②）──');
let ok3 = 0;
let fail3 = 0;
for (let i = 1; i <= Math.min(50, ROUNDS); i += 1) {
  const now = Date.now() - 1000;
  const span = 29 * DAY;
  const value = encodeCookie({
    version: 1, authority: AUTH, issuedAt: now, expiresAt: now + span,
  }, secret);
  const r = await getIndex(`${name}=${value}`);
  if (r.status === 200) ok3 += 1; else fail3 += 1;
}
console.log(`  200=${ok3}  非200=${fail3}`);
