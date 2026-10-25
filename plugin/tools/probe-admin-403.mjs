/**
 * probe-admin-403.mjs — 验证「桌面端停用中转 → HTTP 403」是否已修复
 *
 * 事故：设置页点「停用」/「保存」→ HTTP 403，怎么都改不了。
 *       状态能读（/status 无鉴权），所以用户看得见配置却改不动。
 *
 * 真因（0.3.4）：
 *   前端 client.js 的 call() 只发 content-type，**从不发 Authorization**；
 *   而后端在「口令已设」时要求 bearer/relay_session，
 *   于是口令一旦设置，设置页写操作**永远 403**。
 *   测试没抓住，是因为所有管理路由用例都替前端带了 `adminAs`（bearer）。
 *
 * 修复：桌面外壳（Origin 精确等于 dsh-app://app 且对端回环）豁免凭据 ——
 *   该 Origin 只有 Electron 外壳页面能产生，网页无法跨源伪造，
 *   中转也会把它改写成 http://target，所以公网面没有放宽。
 *
 * 本脚本用真实 dsh 复核修复后的判定矩阵。
 */
'use strict';

import http from 'node:http';
import fs from 'node:fs';

const DSH = 19387;
const HOST = `127.0.0.1:${DSH}`;
const BODY = JSON.stringify({ action: 'status' });

function control(extraHeaders) {
  return new Promise((resolve) => {
    const payload = Buffer.from(BODY);
    const q = http.request({
      host: '127.0.0.1', port: DSH, path: '/dsh-public-relay/control', method: 'POST',
      headers: {
        host: HOST,
        'content-type': 'application/json',
        'content-length': payload.length,
        ...extraHeaders,
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 80) }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    q.end(payload);
  });
}

console.log('── 真实 dsh 上的 /dsh-public-relay/control ──\n');

const cases = [
  ['桌面壳 dsh-app://app（无凭据）', { origin: 'dsh-app://app' }, 'expect-200'],
  ['伪造 dsh-app://evil（无凭据）', { origin: 'dsh-app://evil' }, 'expect-403'],
  ['http 同源（无凭据）', { origin: `http://${HOST}` }, 'expect-403'],
  ['隧道域名 Origin（无凭据）', { origin: 'https://frp-dad.com:16689' }, 'expect-403'],
  ['无 Origin（本机 curl）', {}, 'expect-403'],
];

let fixed = 0;
let pending = 0;
for (const [label, headers, expect] of cases) {
  const r = await control(headers);
  const ok = expect === 'expect-200' ? r.status === 200 : r.status === 403;
  if (expect === 'expect-200') {
    if (r.status === 200) fixed += 1;
    else pending += 1;
  }
  console.log(`  ${ok ? '✅' : (expect === 'expect-200' ? '⏳' : '❌')} ${label}`);
  console.log(`      → ${r.status}  ${r.body}`);
}

console.log('');
console.log('── 配置与快照 ──');
const cfgPath = `${process.env.USERPROFILE}\\.dsh\\profiles\\desktop\\dsh-public-relay.json`;
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  console.log(`  配置文件 enabled=${cfg.enabled} 口令已设=${cfg.password !== ''}`);
} catch (e) {
  console.log(`  读配置失败：${e.message}`);
}

const snap = await new Promise((resolve) => {
  const q = http.request({
    host: '127.0.0.1', port: DSH, path: '/dsh-public-relay/status', method: 'GET',
    headers: { host: HOST },
  }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve(b));
  });
  q.end();
});
try {
  const j = JSON.parse(snap);
  console.log(`  快照顶层 hasPassword = ${j.hasPassword}`);
  console.log(`  快照 config.hasPassword = ${j.config && j.config.hasPassword}`);
  const bothOk = j.hasPassword === true && j.config && j.config.hasPassword === true;
  console.log(`  → ${bothOk ? '✅ 两处都有（0.3.4 已生效）' : '⏳ 仍缺一处（运行中的插件还是旧代码，需重载）'}`);
} catch { /* ignore */ }

console.log('');
if (fixed > 0) {
  console.log(`✅ 桌面壳无凭据已放行 —— 修复生效（${fixed}/${cases.filter((c) => c[2] === 'expect-200').length}）`);
} else {
  console.log('⏳ 桌面壳仍 403 —— 运行中的插件进程还持有旧代码，重载/重启 dsh 后生效');
}
