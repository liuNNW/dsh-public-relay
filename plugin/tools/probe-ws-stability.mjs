#!/usr/bin/env node
/**
 * probe-ws-stability.mjs — 实测穿过中转的 WebSocket 长连接能否活过 dsh 的心跳窗口
 *
 * 背景（已从 dsh 0.2.1-rc.2 源码核实）：
 *   · dsh 的 Remote stream 全部走 /api/remote.mux 这一条 WebSocket
 *   · 服务端每 `websocketHeartbeatIntervalMs` 发一个 Ping（**默认 2000ms**）
 *   · 连续漏 `MAX_MISSED_HEARTBEATS = 2` 次心跳就 socket.terminate()
 *
 * 也就是说默认**容忍窗口只有约 4–6 秒**：隧道一旦抖动到 ping/pong 往返超过
 * 这个量级，服务端会主动掐断 → 浏览器重连 → 重新拉会话历史。这就是
 * 「老是中断」的机制。
 *
 * 已在 profile 的 cordis.patch.yml 里把 `websocketHeartbeatIntervalMs` 调到
 * 15000（容忍约 30–45 秒）。本脚本可以验证改动是否真的落到了运行中的实例上：
 * 看「Ping 个数」—— 40 秒窗口里默认应该是 ~20 个，放宽后应该只有 2–3 个。
 *
 * 本脚本用真实的 ws 客户端（会自动回 pong），直连与经中转各挂一段，
 * 对比存活时长与收到的帧，判断是「中转这一层」还是「隧道本来就不稳」。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';
import { makeAuth } from '../dsh-public-relay/lib/relay.js';

const DSH = 19387;
const RELAY = 3091;
const MUX = '/api/remote.mux';
const OBSERVE_MS = Number(process.argv[2] || 20000);

/**
 * 手写一个最小 WebSocket 客户端：正确回 Pong（这是浏览器自动做的事）。
 * 不引第三方依赖，才能保证「测的就是隧道行为」而不是库行为。
 */
function openSocket(port, cookie, label) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let opened = false;
    let dataFrames = 0;
    let pingFrames = 0;
    let pongFrames = 0;
    let bytes = 0;

    const req = http.request({
      host: '127.0.0.1',
      port,
      path: MUX,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        cookie,
      },
    });

    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* 已关 */ }
      resolve({ label, opened, lived: Date.now() - startedAt, dataFrames, pingFrames, pongFrames, bytes, why });
    };

    let socket = null;
    req.on('upgrade', (_res, upgraded) => {
      socket = upgraded;
      opened = true;

      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        bytes += chunk.length;
        buffer = Buffer.concat([buffer, chunk]);
        // 逐帧扫描：只关心 opcode（不做完整解帧，够本探测用）
        for (;;) {
          if (buffer.length < 2) break;
          const opcode = buffer[0] & 0x0f;
          let len = buffer[1] & 0x7f;
          let offset = 2;
          if (len === 126) { if (buffer.length < 4) break; len = buffer.readUInt16BE(2); offset = 4; }
          else if (len === 127) { if (buffer.length < 10) break; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          const masked = (buffer[1] & 0x80) !== 0;
          if (masked) offset += 4;
          if (buffer.length < offset + len) break;
          const payload = buffer.subarray(offset, offset + len);
          buffer = buffer.subarray(offset + len);

          if (opcode === 0x9) {
            // Ping → 必须回 Pong（浏览器自动做，我们也照做）
            pingFrames += 1;
            const mask = crypto.randomBytes(4);
            const masked = Buffer.from(payload);
            for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
            const frame = Buffer.concat([Buffer.from([0x8a, 0x80 | masked.length]), mask, masked]);
            try { socket.write(frame); pongFrames += 1; } catch { /* 已关 */ }
          } else if (opcode === 0x1 || opcode === 0x2) {
            dataFrames += 1;
          } else if (opcode === 0x8) {
            finish('server-close');
            return;
          }
        }
      });
      socket.on('close', () => finish('socket-close'));
      socket.on('error', (err) => finish(`error:${err.code || err.message}`));
      setTimeout(() => finish('survived-window'), OBSERVE_MS);
    });

    req.on('response', (res) => {
      res.resume();
      res.on('end', () => finish(`http-${res.statusCode}`));
    });
    req.on('error', (err) => finish(`request-error:${err.code || err.message}`));
    req.end();
  });
}

const signer = createSessionSigner({
  credentialsFile: process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : 'C:/Users/LIU/.dsh/.credentials.yaml',
});
const dshCookie = signer.checkout(`127.0.0.1:${DSH}`, undefined).cookieHeader;
const auth = makeAuth(process.argv[3] || '20040915');
const relayCookie = auth ? `${auth.cookieName}=${auth.signToken(Date.now() + 86400000)}` : '';

const direct = await openSocket(DSH, dshCookie, `直连 dsh:${DSH}`);
const relayed = await openSocket(RELAY, relayCookie, `经中转 :${RELAY}`);

console.log(`观察窗口 ${OBSERVE_MS} ms\n`);
for (const r of [direct, relayed]) {
  console.log(r.label);
  console.log(`  握手成功      ${r.opened}`);
  console.log(`  存活          ${(r.lived / 1000).toFixed(1)}s`);
  console.log(`  结束原因      ${r.why}`);
  console.log(`  Ping / Pong   ${r.pingFrames} / ${r.pongFrames}`);
  console.log(`  数据帧 / 字节 ${r.dataFrames} / ${(r.bytes / 1024).toFixed(1)} KB`);
  console.log('');
}

// 心跳间隔是否已放宽：默认 2000ms 时，N 秒窗口里应有 N/2 个 Ping
const expectedDefault = Math.floor(OBSERVE_MS / 2000);
const actualPings = Math.max(direct.pingFrames, relayed.pingFrames);
console.log(`心跳间隔判读：${OBSERVE_MS / 1000}s 窗口内实际 ${actualPings} 个 Ping`
  + `（默认 2000ms 应为约 ${expectedDefault} 个）`);
if (expectedDefault > 3 && actualPings > 0 && actualPings <= Math.ceil(expectedDefault / 5)) {
  console.log(`  → 心跳已被放宽（约 ${Math.round(OBSERVE_MS / Math.max(actualPings, 1) / 1000)}s 一个）`);
} else if (expectedDefault > 3 && actualPings >= expectedDefault * 0.5) {
  console.log('  → 仍是默认 2000ms：cordis.patch.yml 的 typert-gateway 配置可能没生效（需重启 dsh）');
}
console.log('');
console.log('判读：');
if (direct.why === 'survived-window' && relayed.why !== 'survived-window') {
  console.log('  ⚠ 直连能活满窗口，中转被提前掐断 → 问题在中转这一层');
} else if (direct.why !== 'survived-window' && relayed.why !== 'survived-window') {
  console.log('  两者都被掐断 → dsh 的心跳容忍窗口本来就紧（4–6s），隧道抖动会直接触发断连重连');
  console.log('  含义：即使中转完美，隧道 RTT 一旦超过约 4 秒就会掉线；这是「老是中断」的结构性来源');
} else {
  console.log('  两者都活满窗口 → 本机回环链路正常；外网问题出在隧道一侧');
}
