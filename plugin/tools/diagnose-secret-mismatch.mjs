/**
 * diagnose-secret-mismatch.mjs — 判定中转代签的 cookie 为什么会被 dsh 拒绝
 *
 * 用户报「间歇性出现 dsh web authentication required」（这是 dsh **index 路由**的
 * 文案，不是 /api 的 "unauthorized"）。说明 GET / 被 dsh 拒绝。
 *
 * dsh 的 authenticate() 有五个拒绝条件：
 *   ① authority 不匹配
 *   ② 签名对不上（secret 不一致）
 *   ③ payload.issuedAt > now（时钟/未来签发）
 *   ④ payload.expiresAt <= now（已过期）
 *   ⑤ payload.expiresAt - issuedAt > maxAgeMilliseconds（**有效期超过 dsh 的上限**）
 *
 * 第 ⑤ 条最阴险：中转按 30 天签，如果 dsh 的 cookieMaxAgeDays 更小，
 * 那么**每一条**代签 cookie 都会被拒 —— 但只在某些路径上暴露。
 *
 * 本脚本逐条验证，并直接对 dsh 做「用当前 secret 签 → 请求 GET / 」的实测。
 */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';

const DSH = 19387;
const AUTH = `127.0.0.1:${DSH}`;

/** 请求 dsh，返回状态码与正文。 */
function get(pathname, cookieHeader) {
  return new Promise((resolve) => {
    const headers = { host: AUTH };
    if (cookieHeader) headers.cookie = cookieHeader;
    const q = http.request({ host: '127.0.0.1', port: DSH, path: pathname, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 80) }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    q.end();
  });
}

const signer = createSessionSigner({ log: () => {} });
const st = signer.status();
console.log('── 代签器状态 ──');
console.log(`  ready=${st.ready} hasSecret=${st.hasSecret} maxAgeMs=${st.maxAgeMs} (${(st.maxAgeMs / 86400000).toFixed(1)} 天)`);
console.log(`  credentials=${st.credentialsFile}`);
console.log('');

// ── 1) 用代签 cookie 请求 GET /（用户看到的就是这条路径）──
const out = signer.checkout(AUTH, undefined);
const r1 = await get('/', out.cookieHeader);
console.log('── GET / （index 路由，用户看到的 401 文案来源）──');
console.log(`  injected=${out.injected} reason=${out.reason}`);
console.log(`  status=${r1.status}  body=${r1.body}`);
console.log(`  → ${r1.status === 200 ? '✅ 通过' : '❌ 被拒'}`);
console.log('');

// ── 2) 用代签 cookie 请求 /api（另一条 401 文案）──
const body = Buffer.from(JSON.stringify({
  type: 'client-request', rpcId: 'sec-1', method: 'session/modelCatalog', payload: { args: {} },
}));
const r2 = await new Promise((resolve) => {
  const q = http.request({
    host: '127.0.0.1', port: DSH, path: '/api/session/modelCatalog', method: 'POST',
    headers: { host: AUTH, cookie: out.cookieHeader, 'content-type': 'application/json', 'content-length': body.length },
  }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 80) }));
  });
  q.end(body);
});
console.log('── POST /api/session/modelCatalog ──');
console.log(`  status=${r2.status}  body=${r2.body}`);
console.log(`  → ${r2.status === 200 ? '✅ 通过' : '❌ 被拒'}`);
console.log('');

// ── 3) 逐条检查 payload 的五个拒绝条件 ──
console.log('── payload 五条件自查 ──');
const raw = (out.cookieHeader.split(';').map((s) => s.trim()).find((s) => s.startsWith('dsh-auth-')) || '');
const val = raw.split('=')[1] || '';
let p = null;
try {
  p = JSON.parse(Buffer.from(val.split('.')[1], 'base64url').toString('utf8'));
} catch { /* ignore */ }

if (p) {
  const now = Date.now();
  console.log(`  authority = ${p.authority}`);
  console.log(`    ① 与 dsh 收到的 Host(${AUTH}) 一致: ${p.authority === AUTH ? '是 ✅' : '否 ❌'}`);
  console.log(`  issuedAt  = ${p.issuedAt}  (now=${now}, 差 ${p.issuedAt - now}ms)`);
  console.log(`    ③ 未签发于未来: ${p.issuedAt <= now ? '是 ✅' : '否 ❌'}`);
  console.log(`  expiresAt = ${p.expiresAt}  (now=${now}, 剩 ${((p.expiresAt - now) / 86400000).toFixed(1)} 天)`);
  console.log(`    ④ 未过期: ${p.expiresAt > now ? '是 ✅' : '否 ❌'}`);
  const span = p.expiresAt - p.issuedAt;
  console.log(`  有效期跨度 = ${span}ms (${(span / 86400000).toFixed(2)} 天)`);
  console.log(`    ⑤ 不超过 dsh 上限(未知，需比对): 中转配置 ${(st.maxAgeMs / 86400000).toFixed(1)} 天`);
  console.log(`    ⑤ 跨度 <= 中转 maxAgeMs: ${span <= st.maxAgeMs ? '是 ✅' : '否 ❌'}`);
}

// ── 4) 关键：dsh 的 cookieMaxAgeDays 到底是多少 ──
console.log('');
console.log('── dsh 侧 cookieMaxAgeDays 配置 ──');
const profilePatch = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const patchText = fs.existsSync(profilePatch) ? fs.readFileSync(profilePatch, 'utf8') : '';
const m = /cookieMaxAgeDays:\s*(\d+)/.exec(patchText);
console.log(`  profile patch 里: ${m ? `${m[1]} 天` : '未配置（用默认 30 天）'}`);

// ── 5) 时钟一致性 ──
console.log('');
console.log('── 时钟 ──');
console.log(`  本机 now = ${Date.now()}`);
console.log(`  中转签的 issuedAt = ${p?.issuedAt ?? '?'}`);
console.log(`  差值 = ${p ? p.issuedAt - Date.now() : '?'} ms`);
