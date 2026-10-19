#!/usr/bin/env node
/**
 * probe-ws-wire.mjs — 实测「经中转打开会话」时，**线缆上**到底走了多少字节
 *
 * 这是压缩收益的唯一硬指标：不是解压后的逻辑大小，而是浏览器 socket
 * 真实收发的字节数。
 *
 * 做法：连中转的 /api/remote.mux，声明 permessage-deflate，发一个
 * `session/follow` open 帧，然后：
 *   · 统计 ws 解压后交付给应用的字节（logic）
 *   · 同时挂到 client 的底层 socket 上统计真实收到的字节（wire）
 * 两者之比就是压缩率。
 *
 * 对照：连 dsh 直连（不声明压缩），wire ≈ logic（无压缩）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';
import { makeAuth } from '../dsh-public-relay/lib/relay.js';

const DSH = 19387;
const RELAY = 3091;
const OBSERVE_MS = Number(process.argv[2] || 25000);

function latestSession() {
  const root = 'C:/Users/LIU/.dsh/sessions';
  let best = null;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/^session(\.[\w]+)?\.jsonl\.zstd$/.test(e.name)) continue;
      const id = path.basename(dir);
      if (!/^session-[0-9a-f-]{36}$/.test(id)) continue;
      try {
        const m = fs.statSync(p).mtimeMs;
        if (best === null || m > best.m) best = { id, m, file: p };
      } catch { /* 跳过 */ }
    }
  };
  walk(root);
  return best;
}

const signer = createSessionSigner({
  credentialsFile: process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : 'C:/Users/LIU/.dsh/.credentials.yaml',
});
const dshCookie = signer.checkout(`127.0.0.1:${DSH}`, undefined).cookieHeader;
const auth = makeAuth(process.argv[3] || '20040915');
const relayCookie = auth ? `${auth.cookieName}=${auth.signToken(Date.now() + 86400000)}` : '';

const { default: WS } = await import(
  `file:///${process.env.USERPROFILE.replace(/\\/g, '/')}/.dsh/profiles/desktop/node_modules/ws/wrapper.mjs`
);

const target = latestSession();
if (target === null) { console.error('找不到会话样本'); process.exit(1); }
console.log(`样本会话 ${target.id}（磁盘 ${(fs.statSync(target.file).size / 1048576).toFixed(2)} MB）\n`);

/**
 * 打开一次 follow 流，分别统计 wire / logic 字节。
 * @param {number} port - 目标端口
 * @param {string} cookie - Cookie
 * @param {boolean} deflate - 是否声明 permessage-deflate
 */
function measure(port, cookie, deflate) {
  return new Promise((resolve) => {
    const r = {
      wire: 0, logic: 0, frames: 0, why: 'pending',
      extensions: '(none)', opened: false,
    };
    const ws = new WS(`ws://127.0.0.1:${port}/api/remote.mux`, {
      headers: { cookie },
      perMessageDeflate: deflate ? { threshold: 1024 } : false,
      maxPayload: 256 * 1024 * 1024,
    });
    const finish = (why) => {
      if (r.why !== 'pending') return;
      r.why = why;
      try { ws._socket?.destroy(); } catch { /* 已关 */ }
      resolve(r);
    };
    ws.on('open', () => {
      r.opened = true;
      r.extensions = ws.extensions || '(none)';
      // 只统计这条连接真实收到的字节（压缩后）
      ws._socket.on('data', (chunk) => { r.wire += chunk.length; });
      ws.send(JSON.stringify({
        type: 'open',
        streamId: 'wire-1',
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId: target.id },
              assistantStream: true,
              maxMessages: 500,
              turnWindow: { minMessages: 50, minTurns: 2 },
            },
          },
        },
      }));
      setTimeout(() => finish('window'), OBSERVE_MS);
    });
    ws.on('message', (data) => {
      r.frames += 1;
      r.logic += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
      // 收到第一帧就等于「打开会话」已完成，可以提前收工
      finish('first-frame');
    });
    ws.on('close', () => finish('closed'));
    ws.on('error', (e) => finish(`error:${e.code || e.message}`));
  });
}

const direct = await measure(DSH, dshCookie, false);
const relayed = await measure(RELAY, relayCookie, true);

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
console.log('① 直连 dsh（不压缩）');
console.log(`   extensions=${direct.extensions}  ${direct.frames} 帧`);
console.log(`   应用收到（logic） ${mb(direct.logic)}`);
console.log(`   线缆实际（wire）  ${mb(direct.wire)}`);
console.log('');
console.log('② 经中转（浏览器侧 permessage-deflate）');
console.log(`   extensions=${relayed.extensions}  ${relayed.frames} 帧`);
console.log(`   应用收到（logic） ${mb(relayed.logic)}`);
console.log(`   线缆实际（wire）  ${mb(relayed.wire)}`);
console.log('');
if (relayed.logic > 0 && relayed.wire > 0) {
  const ratio = relayed.logic / relayed.wire;
  const saved = direct.wire - relayed.wire;
  console.log('结论：');
  console.log(`  同一会话经中转传输 ${mb(relayed.wire)}（直连 ${mb(direct.wire)}）`);
  console.log(`  压缩比 ${ratio.toFixed(1)}x，省下 ${mb(saved)}`
    + `（${direct.wire > 0 ? ((saved / direct.wire) * 100).toFixed(1) : '0'}%）`);
  console.log(`  载荷完整性：logic 一致？${relayed.logic === direct.logic ? '是' : `否（${relayed.logic} vs ${direct.logic}）`}`);
} else {
  console.log('未能取得完整测量（可能超时）；看上面两组数字判断。');
}
