/**
 * trace-relay-load.mjs — 追踪中转在「模拟浏览器完整加载」时的行为
 *
 * 目的：判定经中转访问时，首页 → 各 bundle → /api 这条链路上究竟哪一步失败。
 * 特别是 force-loopback 的 patch 是否命中（patchedScripts 一直为 0 很可疑）。
 *
 * 要点：
 *   · 首页 HTML 里的 `&amp;rev=` 是 HTML 转义，真实请求要用 `&rev=`
 *   · combo URL 的 `??` 必须原样发出（不能被当成查询分隔符展开）
 */
'use strict';

import http from 'node:http';

const RELAY_PORT = 3091;
const PASSWORD = '20040915';

function req(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(body);
    const h = { ...headers };
    if (payload) {
      h['content-length'] = payload.length;
      h['content-type'] = h['content-type'] || 'application/json';
    }
    const r = http.request({ host: '127.0.0.1', port: RELAY_PORT, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const login = await req('/__login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: `password=${encodeURIComponent(PASSWORD)}`,
});
const cookie = (login.headers['set-cookie'] || [])[0]?.split(';')[0] || '';
console.log('登录:', login.status, ' cookie:', cookie.slice(0, 36) || '(无)');
console.log('');

const s0 = JSON.parse((await req('/dsh-public-relay/status', { headers: { cookie } })).body.toString());
console.log('初始 patchedScripts =', s0.patchedScripts, ' patchMisses =', s0.patchMisses);
console.log('');

const index = await req('/', { headers: { cookie, accept: 'text/html' } });
const html = index.body.toString();
console.log('首页:', index.status, index.body.length, '字节  是dsh界面:', html.includes('DeepSeek Harness'));
console.log('');

// 提取真实 URL，并还原 HTML 实体
const raw = [];
for (const m of html.matchAll(/href="(plugins\/[^"]+)"/g)) raw.push(m[1]);
for (const m of html.matchAll(/src="([^"]+\.js[^"]*)"/g)) raw.push(m[1]);

const urls = [...new Set(raw.map((u) => u.replace(/&amp;/g, '&')))];
console.log(`发现 ${urls.length} 个脚本 URL，逐个请求（不展开 ??，保留 &rev）：`);
console.log('');

let hitPatch = 0;
const results = [];
for (const u of urls) {
  const path = u.startsWith('/') ? u : `/${u}`;
  let r;
  try {
    r = await req(path, { headers: { cookie, accept: '*/*' } });
  } catch (e) {
    results.push({ path, status: 'ERR', size: 0, note: e.message });
    continue;
  }
  const text = r.body.toString();
  const hasLoop = text.includes('isLoopback');
  const isConn = path.includes('dsh-client-connection');
  if (hasLoop) hitPatch += 1;
  results.push({
    path, status: r.status, size: r.body.length, hasLoop, isConn,
    ctype: r.headers['content-type'] || '',
  });
}

for (const x of results) {
  const flag = x.hasLoop ? '  ★含 isLoopback' : '';
  const connFlag = x.isConn ? '  [含 client-connection]' : '';
  console.log(`  ${x.status}  ${String(x.size).padStart(8)} B  ${x.path.slice(0, 80)}${connFlag}${flag}`);
}

console.log('');
const s1 = JSON.parse((await req('/dsh-public-relay/status', { headers: { cookie } })).body.toString());
console.log('最终 patchedScripts =', s1.patchedScripts, ' patchMisses =', s1.patchMisses,
  ' passthrough =', s1.passthroughScripts);

const api = await req('/api/session/modelCatalog', {
  method: 'POST',
  headers: { cookie, accept: 'application/json' },
  body: JSON.stringify({
    type: 'client-request', rpcId: 'trace-1', method: 'session/modelCatalog', payload: { args: {} },
  }),
});
const apiText = api.body.toString();
console.log('');
console.log('/api/session/modelCatalog:', api.status,
  apiText.match(/"ok":true/) ? '✅ ok:true' : `❌ ${apiText.slice(0, 120)}`);
