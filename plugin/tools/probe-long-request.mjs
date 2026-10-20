/**
 * probe-long-request.mjs — 验证长耗时请求能否完整穿过中转
 *
 * 背景：用户报 `session/prompt` 返回 401。prompt 是发起 AI 对话，
 * 可能持续数分钟。中转的上游 agent 配了 `timeout: 60000`，
 * 需要确认这个「空闲超时」会不会在中途掐断长请求。
 *
 * 做法：起一个假上游，故意延迟 N 秒才回 200，看中转会不会中途断开。
 * 同时检查中断后客户端看到的是什么状态码（是不是 401）。
 */
'use strict';

import http from 'node:http';
import { createRelay } from '../dsh-public-relay/lib/relay.js';
import { normalizeConfig } from '../dsh-public-relay/lib/config.js';

const DELAYS = [1000, 5000, 30000, 70000];   // 含超过 60s 的用例

/** 起一个延迟响应的假上游。 */
function startSlowUpstream() {
  const server = http.createServer((req, res) => {
    // 从路径里取延迟，如 /slow/70000
    const m = /\/(\d+)$/.exec(req.url || '');
    const delay = m ? Number(m[1]) : 1000;
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'slow', result: { ok: true, delay } }));
    }, delay);
    req.on('close', () => clearTimeout(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, path, timeoutMs, cookie) {
  return new Promise((resolve) => {
    const started = Date.now();
    const headers = { 'content-length': 0 };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: b,
        ms: Date.now() - started,
        aborted: false,
      }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, body: 'client-timeout', ms: Date.now() - started, aborted: true });
    });
    req.on('error', (e) => resolve({
      status: 0, body: `ERR ${e.code || e.message}`, ms: Date.now() - started, aborted: true,
    }));
    req.end();
  });
}

const { server, port: upPort } = await startSlowUpstream();
const relayPort = await new Promise((r) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

const relay = createRelay({
  getDshEndpoint: () => ({ host: '127.0.0.1', port: upPort }),
  getConfig: () => normalizeConfig({ listenPort: relayPort, password: 'pw', autoSession: false }),
  log: (lvl, msg) => { if (lvl !== 'info') console.log(`  [relay:${lvl}] ${msg}`); },
  resolveLaunchToken: () => 'tok',
});
await relay.start();

// 登录拿 cookie
const cookie = await new Promise((resolve) => {
  const payload = Buffer.from('password=pw');
  const req = http.request({
    host: '127.0.0.1', port: relayPort, path: '/__login', method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': payload.length },
  }, (res) => {
    res.resume();
    res.on('end', () => resolve((res.headers['set-cookie'] || [])[0]?.split(';')[0] || ''));
  });
  req.end(payload);
});

console.log(`假上游 ${upPort} → 中转 ${relayPort}`);
console.log(`上游 agent timeout = 60000ms（空闲超时）`);
console.log('');
console.log('延迟  期望      实际 status  耗时        结果');
console.log('─'.repeat(66));

for (const delay of DELAYS) {
  const r = await request(relayPort, `/slow/${delay}`, delay + 40000, cookie);
  const want = delay < 60000 ? '200' : '200（可疑）';
  const okMark = r.status === 200 ? '✅' : '❌';
  console.log(
    `${String(delay).padStart(5)}ms  ${want.padEnd(12)}  ${String(r.status).padEnd(4)}  `
    + `${String(r.ms).padStart(7)}ms  ${okMark} ${r.aborted ? r.body : ''}`,
  );
  if (r.status !== 200) {
    console.log(`         └─ body: ${r.body.slice(0, 100)}`);
  }
}

await relay.stop();
server.close();
console.log('');
console.log('说明：若 70000ms 用例失败，说明 agent 的 60s timeout 会掐断长请求。');
