/**
 * probe-dsh-cookie-bounds.mjs — 探测 dsh 接受代签 cookie 的确切边界
 *
 * dsh 的 authenticate() 有五个拒绝条件，其中最容易在「边缘」触发的是：
 *   payload.expiresAt - payload.issuedAt > this.maxAgeMilliseconds  → 拒绝
 *
 * 中转按自己的 maxAgeMs（默认 30 天）签。如果 dsh 实际的上限更小，
 * 那么**每一条**代签 cookie 都会被拒 —— 但只在某些路径暴露。
 *
 * 本脚本用真实 secret 签出不同有效期的 cookie，逐个请求 dsh，找出真实上限。
 */
'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import { encodeCookie, cookieNameFor } from '../dsh-public-relay/lib/dsh-cookie.js';

const DSH = 19387;
const AUTH = `127.0.0.1:${DSH}`;
const CRED = `${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`;

import fs from 'node:fs';

/** 从 credentials 取 secret。 */
function readSecret() {
  const text = fs.readFileSync(CRED, 'utf8');
  const m = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/.exec(text);
  if (m === null) throw new Error('未找到 secret');
  return m[1];
}

/** base64url → Buffer（严格校验）。 */
function decodeBase64Url(value) {
  if (typeof value !== 'string' || value.length % 4 === 1) return undefined;
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const buf = Buffer.from(value.split('-').join('+').split('_').join('/') + pad, 'base64');
  const re = buf.toString('base64').split('+').join('-').split('/').join('_').replace(/=+$/, '');
  return re === value ? buf : undefined;
}

const secret = decodeBase64Url(readSecret());
console.log(`secret 前 8 位: ${readSecret().slice(0, 8)}…  长度=${secret?.length ?? '?'}`);
console.log('');

/** 请求 GET /，返回状态码。 */
function getIndex(cookieHeader) {
  return new Promise((resolve) => {
    const q = http.request({
      host: '127.0.0.1', port: DSH, path: '/', method: 'GET',
      headers: { host: AUTH, cookie: cookieHeader },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 40) }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    q.end();
  });
}

const name = cookieNameFor(AUTH);
const DAY = 86400000;

/** 用指定「有效期跨度」签一个 cookie 并测试。 */
async function testSpan(label, spanMs, offsetMs = 0) {
  const now = Date.now() + offsetMs;
  const value = encodeCookie({
    version: 1,
    authority: AUTH,
    issuedAt: now,
    expiresAt: now + spanMs,
  }, secret);
  const r = await getIndex(`${name}=${value}`);
  const days = (spanMs / DAY).toFixed(2);
  console.log(`  ${label.padEnd(28)} 跨度=${String(days).padStart(7)}天  offset=${String(offsetMs).padStart(6)}ms  → ${r.status}`);
  return r.status;
}

console.log('── 有效期跨度扫描（dsh 应接受 <= 其 maxAgeMilliseconds）──');
for (const d of [1, 7, 29, 29.9, 30, 30.001, 31, 60, 365]) {
  await testSpan(`${d} 天`, d * DAY);
}

console.log('');
console.log('── 时钟偏移扫描（dsh 拒绝 issuedAt > now）──');
for (const off of [-5000, -100, 0, 100, 500, 2000, 10000]) {
  await testSpan(`offset ${off}ms`, 30 * DAY, off);
}

console.log('');
console.log('── 对照：中转当前配置 ──');
console.log(`  中转 maxAgeMs = 2592000000 (30.00 天)`);
