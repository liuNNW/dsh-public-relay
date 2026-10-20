/**
 * verify-sidebar-fixed.mjs — 验证 better-sidebar 升级后 /sidebar/* 是否真正可用
 *
 * 对比基线（升级前 0.25.0，宿主半加载失败）：
 *   GET  /sidebar/api/session.cwd  -> 404 空 body
 *   POST /sidebar/api/session.cwd  -> 405 空 body（dsh fallback）
 *
 * 升级后（0.28.0，宿主半已加载）应看到 better-sidebar 自己的 JSON 错误
 * （method-error / bad-request），而不是 dsh fallback 的空 405。
 */
'use strict';

import http from 'node:http';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';

const DSH = 19387;

const signer = createSessionSigner({ log: () => {} });
const signed = signer.checkout(`127.0.0.1:${DSH}`, undefined);

function call(path, method, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const payload = body === null ? null : Buffer.from(body);
    const headers = {
      cookie: signed.cookieHeader,
      host: `127.0.0.1:${DSH}`,
      accept: '*/*',
      ...extraHeaders,
    };
    if (payload !== null) {
      headers['content-type'] = headers['content-type'] || 'application/json';
      headers['content-length'] = payload.length;
    }
    const q = http.request({ host: '127.0.0.1', port: DSH, path, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    if (payload !== null) q.write(payload);
    q.end();
  });
}

/** dsh fallback 的 405 特征是「空 body」；插件的 405 带 JSON。 */
function classify(r) {
  if (r.status === 405 && r.body.trim() === '') return 'dsh fallback（路由未注册）❌';
  if (r.status === 405 && r.body.includes('method-error')) return '插件自身的方法校验 ✅';
  if (r.status === 400 && r.body.includes('bad-request')) return '插件已响应（参数不对）✅';
  if (r.status === 200) return '正常 200 ✅';
  if (r.status === 404 && r.body.trim() === '') return 'dsh fallback 404（路由未注册）❌';
  return `其它 (${r.status})`;
}

console.log('═══ /sidebar/api/* ═══\n');
const apiCases = [
  ['/sidebar/api/session.cwd', 'POST', JSON.stringify({})],
  ['/sidebar/api/session.phase', 'POST', JSON.stringify({})],
];
for (const [p, m, b] of apiCases) {
  const r = await call(p, m, b);
  console.log(`  ${m} ${p}`);
  console.log(`     status=${r.status}  ${classify(r)}`);
  console.log(`     body=${r.body.slice(0, 110) || '(空)'}`);
  console.log('');
}

console.log('═══ /sidebar/bundle / /sidebar/file ═══\n');
const otherCases = [
  ['/sidebar/bundle/client.js', 'GET', null],
  ['/sidebar/file/README.md', 'GET', null],
];
for (const [p, m, b] of otherCases) {
  const r = await call(p, m, b);
  console.log(`  ${m} ${p}`);
  console.log(`     status=${r.status}  ${classify(r)}`);
  console.log(`     body=${r.body.slice(0, 110) || '(空)'}`);
  console.log('');
}

console.log('═══ 结论 ═══');
const probe = await call('/sidebar/api/session.cwd', 'POST', '{}');
const isFallback = probe.status === 405 && probe.body.trim() === '';
if (isFallback) {
  console.log('  ❌ /sidebar/api 仍落进 dsh fallback —— 宿主半仍未加载');
  process.exitCode = 1;
} else {
  console.log('  ✅ /sidebar/api 已由 better-sidebar 接管 —— 宿主半加载成功');
  process.exitCode = 0;
}
