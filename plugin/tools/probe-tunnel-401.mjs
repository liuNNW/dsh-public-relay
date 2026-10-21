/**
 * probe-tunnel-401.mjs — 经隧道（HTTPS）访问时是否更容易 401
 *
 * 关键怀疑：`isSecureRequest()` 决定 cookie 是否带 `Secure`，
 * 而 dsh 侧的 `requestAudience(headers, secure)` 也依赖 secure：
 *
 *   return secure ? url.origin : url.host;
 *                 ↑ "https://host:port"      ↑ "host:port"
 *
 * 也就是说 **HTTP 与 HTTPS 的 cookie 名字完全不同**！
 * 若中转判断 secure 的方式与 dsh 不一致，签出的 cookie 名就对不上 → 401。
 *
 * 本脚本对比：
 *   · 本机 HTTP 访问（secure=false → authority = host:port）
 *   · 模拟隧道 HTTPS（x-forwarded-proto: https → 中转认为 secure=true）
 *   · 直连 dsh 时 dsh 自己的 secure 判定
 */
'use strict';

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { encodeCookie, cookieNameFor } from '../dsh-public-relay/lib/dsh-cookie.js';

const DSH = 19387;
const RELAY = 3091;
const PASSWORD = '20040915';
const CRED = `${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`;

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

/** dsh 的 requestAudience 复刻：secure 决定用 origin 还是 host。 */
function audienceOf(hostHeader, secure) {
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${hostHeader}`);
    return secure ? url.origin : url.host;
  } catch {
    return undefined;
  }
}

console.log('── cookie 名随 secure 变化（这是 401 的潜在根源）──');
for (const secure of [false, true]) {
  const aud = audienceOf(`127.0.0.1:${DSH}`, secure);
  console.log(`  secure=${String(secure).padEnd(5)} → audience=${aud}`);
  console.log(`     cookieName = ${cookieNameFor(aud).slice(0, 46)}…`);
}
console.log('');

// ── 直连 dsh：两种 audience 的 cookie 分别测试 ──
function getDsh(pathname, cookieHeader, hostHeader) {
  return new Promise((resolve) => {
    const q = http.request({
      host: '127.0.0.1', port: DSH, path: pathname, method: 'GET',
      headers: { host: hostHeader, cookie: cookieHeader },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 40) }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    q.end();
  });
}

console.log('── 直连 dsh：用「host:port」形态的 cookie ──');
const hostAud = audienceOf(`127.0.0.1:${DSH}`, false);
const now = Date.now();
const hostCookie = `${cookieNameFor(hostAud)}=${encodeCookie({
  version: 1, authority: hostAud, issuedAt: now, expiresAt: now + 29 * 86400000,
}, secret)}`;
const r1 = await getDsh('/', hostCookie, `127.0.0.1:${DSH}`);
console.log(`  → ${r1.status}  ${r1.body}`);
console.log('');

console.log('── 直连 dsh：用「https://host:port」形态的 cookie（错配）──');
const originAud = audienceOf(`127.0.0.1:${DSH}`, true);
const originCookie = `${cookieNameFor(originAud)}=${encodeCookie({
  version: 1, authority: originAud, issuedAt: now, expiresAt: now + 29 * 86400000,
}, secret)}`;
const r2 = await getDsh('/', originCookie, `127.0.0.1:${DSH}`);
console.log(`  → ${r2.status}  ${r2.body}`);
console.log('');

// ── 经中转：模拟隧道带 x-forwarded-proto ──
function getRelay(pathname, cookieHeader, extraHeaders = {}) {
  return new Promise((resolve) => {
    const q = http.request({
      host: '127.0.0.1', port: RELAY, path: pathname, method: 'GET',
      headers: { cookie: cookieHeader, ...extraHeaders },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 40) }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    q.end();
  });
}

const login = await new Promise((resolve) => {
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

console.log('── 经中转：不带 x-forwarded-proto（本机 HTTP 场景）──');
const a = await getRelay('/', login, { host: `127.0.0.1:${RELAY}` });
console.log(`  → ${a.status}  ${a.body}`);
console.log('');

console.log('── 经中转：带 x-forwarded-proto: https（隧道场景）──');
const b = await getRelay('/', login, { host: `127.0.0.1:${RELAY}`, 'x-forwarded-proto': 'https' });
console.log(`  → ${b.status}  ${b.body}`);
console.log('');

console.log('── 经中转：带隧道域名 Host + https ──');
const c = await getRelay('/', login, { host: 'frp-dad.com:16689', 'x-forwarded-proto': 'https' });
console.log(`  → ${c.status}  ${c.body}`);
