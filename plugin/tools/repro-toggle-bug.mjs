/**
 * repro-toggle-bug.mjs — 复现「一停用就报错、设置页变空」
 *
 * 步骤：抓 running 快照 → toggle（停用）→ 抓响应 → toggle 回来。
 * 重点看 stop 之后返回的 status 是否缺字段 / 是否 502 / 前端渲染所需字段是否还在。
 */
'use strict';

import http from 'node:http';

const DSH = 19387;
const HOST = `127.0.0.1:${DSH}`;
const ORIGIN = 'dsh-app://app';

function call(method, pathname, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { host: HOST, origin: ORIGIN };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const q = http.request({ host: '127.0.0.1', port: DSH, path: pathname, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    if (payload) q.write(payload);
    q.end();
  });
}

/** 只打印前端渲染要用到的关键字段。 */
function summarize(label, json) {
  console.log(`\n── ${label} ──`);
  if (!json || typeof json !== 'object') {
    console.log('  响应不是对象：', String(json).slice(0, 200));
    return;
  }
  const st = json.status ?? json;
  const keys = Object.keys(st);
  console.log(`  ok=${json.ok}  error=${JSON.stringify(json.error ?? null)}`);
  console.log(`  顶层字段(${keys.length}): ${keys.join(', ')}`);
  console.log(`  state=${st.state}  lastError=${JSON.stringify(st.lastError ?? null)}`);
  console.log(`  listen=${JSON.stringify(st.listen ?? null)}`);
  console.log(`  uptimeMs=${st.uptimeMs}`);
  console.log(`  config?=${st.config !== undefined}  hasPassword=${st.hasPassword}  config.hasPassword=${st.config && st.config.hasPassword}`);
  console.log(`  websocket=${st.websocket === undefined ? 'undefined' : JSON.stringify(st.websocket)}`);
  console.log(`  requests=${st.requests} connections=${st.connections}`);
  console.log(`  session=${st.session === undefined ? 'undefined' : JSON.stringify(st.session)}`);
}

// 1) 当前状态
const before = await call('GET', '/dsh-public-relay/status');
summarize('停用前（running）', JSON.parse(before.body || '{}'));

// 2) 停用
const stop = await call('POST', '/dsh-public-relay/control', { action: 'toggle' });
console.log(`\n═══ toggle（停用）→ HTTP ${stop.status} ═══`);
let stopJson = null;
try { stopJson = JSON.parse(stop.body); } catch { console.log('  响应非 JSON：', stop.body.slice(0, 300)); }
summarize('停用后返回的 status', stopJson);

// 3) 停用后再读 /status（前端轮询会打这个）
const after = await call('GET', '/dsh-public-relay/status');
console.log(`\n═══ 停用后 GET /status → HTTP ${after.status} ═══`);
if (after.status !== 200) console.log('  body:', after.body.slice(0, 300));
else summarize('停用后 GET /status', JSON.parse(after.body || '{}'));

// 4) 恢复运行
const back = await call('POST', '/dsh-public-relay/control', { action: 'toggle' });
console.log(`\n═══ toggle（恢复）→ HTTP ${back.status} ═══`);
try {
  const b = JSON.parse(back.body);
  console.log(`  state=${b.status && b.status.state}  ok=${b.ok}`);
} catch { console.log('  ', back.body.slice(0, 200)); }
