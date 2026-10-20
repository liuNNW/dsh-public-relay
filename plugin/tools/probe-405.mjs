/**
 * probe-405.mjs — 定位 dsh 返回 405 的具体路由与方法
 *
 * 背景：用户报告「本地打开文档等内容都显示 HTTP 405」。
 * 已知 dsh 里有三处会返 405：
 *   ① dsh-client-modules: /plugins/... 只允许 GET/HEAD
 *   ② dsh-client-hmr:     /hmr/events 只允许 GET/HEAD
 *   ③ dsh-client-file-upload: /api/... 只允许 POST
 *
 * 本脚本对着这些路由逐个试不同方法，找出哪些组合返回 405。
 */
'use strict';

import http from 'node:http';

const DSH = 19387;

/** 发一个请求到 dsh，返回 status + 关键响应头。 */
function req(path, method = 'GET', extraHeaders = {}) {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port: DSH, path, method,
      headers: { ...extraHeaders },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        allow: res.headers.allow || null,
        ctype: res.headers['content-type'] || null,
        body: b.slice(0, 120),
      }));
    });
    r.on('error', (e) => resolve({ status: 0, allow: null, ctype: null, body: `ERR ${e.message}` }));
    r.end();
  });
}

/** 带 dsh 会话 cookie 的请求（用代签）。 */
async function withAuth() {
  const { createSessionSigner } = await import('../dsh-public-relay/lib/dsh-cookie.js');
  const signer = createSessionSigner({ log: () => {} });
  const out = signer.checkout(`127.0.0.1:${DSH}`, undefined);
  return out.cookieHeader;
}

const cookie = await withAuth();
console.log('代签 cookie 已就绪\n');

const ROUTES = [
  { path: '/plugins/??@deepseek-ai/dsh-client-modules/client.js', label: 'client-modules bundle' },
  { path: '/plugins/??@deepseek-ai/dsh-api-gateway/client.js', label: 'api-gateway bundle' },
  { path: '/hmr/events', label: 'hmr events' },
  { path: '/api/file?path=x.md', label: 'api/file（文档预览）' },
  { path: '/api/session/modelCatalog', label: 'api/session/modelCatalog' },
  { path: '/api/remote.mux', label: 'api/remote.mux' },
  { path: '/', label: 'index' },
];

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'];

console.log('路由'.padEnd(42) + METHODS.map((m) => m.padStart(8)).join(''));
console.log('─'.repeat(42 + METHODS.length * 8));

for (const r of ROUTES) {
  const cells = [];
  for (const m of METHODS) {
    const res = await req(r.path, m, { cookie });
    cells.push(String(res.status).padStart(8));
  }
  console.log(r.label.padEnd(42) + cells.join(''));
}

console.log('');
console.log('=== 出现 405 的组合详情 ===');
for (const r of ROUTES) {
  for (const m of METHODS) {
    const res = await req(r.path, m, { cookie });
    if (res.status === 405) {
      console.log(`  ${m} ${r.path}`);
      console.log(`      allow=${res.allow}  ctype=${res.ctype}`);
      console.log(`      body=${res.body.replace(/\n/g, ' ').slice(0, 100)}`);
    }
  }
}
