/**
 * probe-prompt.mjs — 专门探测 /api/session/prompt 经中转时的认证行为
 *
 * 背景：用户报 `transport failure for /api/session/prompt: HTTP 401`，
 * 而 modelCatalog 是好的。两者都走 /api 同一套认证，但 prompt 有额外语义：
 * 它会构造持久的 user-rpc 消息 source，并读取 principalOf(invocation)。
 *
 * 本脚本对比：relay_session 有效 / 无效 / 不带 三种情况下各端点的表现。
 */
'use strict';

import http from 'node:http';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';

const RELAY_PORT = 3091;
const DSH_PORT = 19387;
const PASSWORD = '20040915';

function post(port, path, headers, bodyText) {
  return new Promise((resolve) => {
    const payload = Buffer.from(bodyText);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { ...headers, 'content-length': payload.length },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    req.end(payload);
  });
}

const login = await post(RELAY_PORT, '/__login',
  { 'content-type': 'application/x-www-form-urlencoded' },
  `password=${encodeURIComponent(PASSWORD)}`);
const setCookie = login.setCookie;
// 需要从响应头拿；上面没取，这里重发一次拿头
const login2 = await new Promise((resolve) => {
  const payload = Buffer.from(`password=${encodeURIComponent(PASSWORD)}`);
  const req = http.request({
    host: '127.0.0.1', port: RELAY_PORT, path: '/__login', method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': payload.length },
  }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode, cookie: (res.headers['set-cookie'] || [])[0]?.split(';')[0] || '' }));
  });
  req.end(payload);
});
const cookie = login2.cookie;
console.log('relay 登录:', login2.status, ' cookie:', cookie.slice(0, 36));
console.log('');

const endpoints = [
  ['session/modelCatalog', { args: {} }],
  ['session/search', { args: { query: '' } }],
  ['session/prompt', { args: { sessionId: 'nonexistent', text: 'hi' } }],
];

for (const [method, payload] of endpoints) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `p-${method}`, method, payload });

  const viaRelay = await post(RELAY_PORT, `/api/${method}`, {
    cookie, 'content-type': 'application/json', accept: 'application/json',
    'sec-fetch-site': 'same-origin',
  }, body);

  const okRelay = viaRelay.body.includes('"ok":true');
  const isAuth401 = viaRelay.status === 401;
  console.log(`${method}`);
  console.log(`  经中转: status=${viaRelay.status} ${okRelay ? '✅ok' : isAuth401 ? '❌401' : viaRelay.body.slice(0, 90)}`);

  // 直连 dsh（代签 cookie）作对照
  const signer = createSessionSigner({ log: () => {} });
  const out = signer.checkout(`127.0.0.1:${DSH_PORT}`, undefined);
  const direct = await post(DSH_PORT, `/api/${method}`, {
    cookie: out.cookieHeader, host: `127.0.0.1:${DSH_PORT}`,
    'content-type': 'application/json',
  }, body);
  const okDirect = direct.body.includes('"ok":true');
  console.log(`  直连dsh: status=${direct.status} ${okDirect ? '✅ok' : direct.status === 401 ? '❌401' : direct.body.slice(0, 90)}`);
  console.log('');
}

// 对照：无 cookie
console.log('── 无 relay_session（应 401）──');
for (const [method, payload] of endpoints) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'noauth', method, payload });
  const r = await post(RELAY_PORT, `/api/${method}`, { 'content-type': 'application/json' }, body);
  console.log(`  ${method}: status=${r.status} body=${r.body.slice(0, 60)}`);
}
