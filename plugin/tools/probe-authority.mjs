/**
 * probe-authority.mjs — 验证中转为真实 dsh 代签时用的 authority 是否被接受
 *
 * 背景：2026-10-20 排查「经中转访问首页返回 dsh 的 401」时，确认：
 *   · 直连 dsh + 代签 cookie → 200 ok:true（代签本身有效）
 *   · 经中转 → 401
 * 需要判定：中转转发时的 Host 与代签 payload 里的 authority 是否一致。
 */
'use strict';

import http from 'node:http';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';
import { resolveTarget } from '../dsh-public-relay/lib/relay.js';

/**
 * 端口可通过参数覆盖：node probe-authority.mjs [port]
 * 默认 19387（desktop profile 的 dsh 端口）。
 */
const DSH_PORT = Number(process.argv[2] || 19387);
const BODY = Buffer.from(JSON.stringify({
  type: 'client-request',
  rpcId: 'probe-authority',
  method: 'session/modelCatalog',
  payload: { args: {} },
}));

function callApi(hostHeader, cookieHeader) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: DSH_PORT,
      path: '/api/session/modelCatalog',
      method: 'POST',
      headers: {
        host: hostHeader,
        cookie: cookieHeader,
        'content-type': 'application/json',
        'content-length': BODY.length,
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.end(BODY);
  });
}

const signer = createSessionSigner({ log: () => {} });
console.log('signer.status():', JSON.stringify(signer.status()));
console.log('');

const candidates = [
  '127.0.0.1:19387',
  'localhost:19387',
  `127.0.0.1:${DSH_PORT}`,
];

for (const authority of candidates) {
  const out = signer.checkout(authority, undefined);
  const cookieName = out.name;
  const r = await callApi(authority, out.cookieHeader);
  const ok = r.status === 200 && r.body.includes('"ok":true');
  console.log(`authority=${authority}`);
  console.log(`  cookieName : ${cookieName}`);
  console.log(`  injected   : ${out.injected} (${out.reason})`);
  console.log(`  Host 一致  : ${authority}`);
  console.log(`  → status=${r.status} ${ok ? '✅ ok:true' : '❌ ' + r.body.slice(0, 80)}`);
  console.log('');
}

// 关键对照：Host 与 authority 不一致时会怎样
console.log('── 对照：Host 与签名 authority 不一致（模拟中转改了 Host 但签错 authority）──');
{
  const authority = '127.0.0.1:19387';
  const out = signer.checkout(authority, undefined);
  const r = await callApi('localhost:19387', out.cookieHeader);   // Host 变了
  console.log(`  签名 authority=${authority}，但 Host=localhost:19387`);
  console.log(`  → status=${r.status} ${r.status === 200 ? '仍通过（dsh 未强校验）' : '被拒 ❌ ' + r.body.slice(0, 60)}`);
}
