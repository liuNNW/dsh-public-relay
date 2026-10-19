#!/usr/bin/env node
/**
 * probe-session-open.mjs — 实测「打开一个会话」在线上传了多少字节
 *
 * 这是「每次切换会话都要加载历史、特别卡」的量化依据。
 *
 * 协议（已从 @deepseek-ai/dsh-api-gateway 源码核实）：
 *   { type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: {...} } } }
 *   下行按 JSON 文本帧推 { type:'item', streamId, value }
 *
 * 关键事实：
 *   · 打开会话走 **WebSocket**（/api/remote.mux），实测未协商 permessage-deflate
 *   · dsh 的 compression 中间件只作用于 HTTP，**完全不覆盖 WS**
 *   · 所以整段历史是**明文**过隧道
 *
 * 本脚本量出：
 *   ① 单个会话打开时的下行字节（直连 / 经中转，应一致 —— 中转不改载荷）
 *   ② 同一份字节用 gzip / br 能压到多少（= WS 压缩的理论收益）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';
import { makeAuth } from '../dsh-public-relay/lib/relay.js';

const DSH = 19387;
const RELAY = 3091;
const OBSERVE_MS = Number(process.argv[2] || 20000);

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
console.log(`样本会话 ${target.id}（磁盘 ${(fs.statSync(target.file).size / 1024 / 1024).toFixed(2)} MB）\n`);

/** 开一条 follow 流，统计下行字节与最大帧。 */
function followStream(port, cookie, label, perMessageDeflate) {
  return new Promise((resolve) => {
    const result = {
      label, opened: false, bytes: 0, frames: 0, largest: 0,
      firstFrameBytes: 0, why: 'pending', negotiated: '(none)', sample: null,
    };
    const ws = new WS(`ws://127.0.0.1:${port}/api/remote.mux`, {
      headers: { cookie },
      ...(perMessageDeflate ? { perMessageDeflate: true } : {}),
    });
    const finish = (why) => {
      if (result.why !== 'pending') return;
      result.why = why;
      try { ws._socket?.destroy(); } catch { /* 已关 */ }
      resolve(result);
    };
    ws.on('open', () => {
      result.opened = true;
      result.negotiated = ws.extensions || '(none)';
      ws.send(JSON.stringify({
        type: 'open',
        streamId: 'probe-1',
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
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      result.bytes += buf.length;
      result.frames += 1;
      if (buf.length > result.largest) result.largest = buf.length;
      if (result.frames === 1) {
        result.firstFrameBytes = buf.length;
        result.sample = buf;
      }
    });
    ws.on('close', () => finish('closed'));
    ws.on('error', (e) => finish(`error:${e.code || e.message}`));
  });
}

const direct = await followStream(DSH, dshCookie, '直连 dsh', false);
const relayed = await followStream(RELAY, relayCookie, '经中转', false);

console.log('① 打开一个会话的下行流量（session/follow，WebSocket）');
for (const r of [direct, relayed]) {
  console.log(`   ${r.label.padEnd(9)} 握手=${r.opened} 结束=${r.why} 扩展=${r.negotiated}`);
  console.log(`   ${''.padEnd(9)} ${String(r.frames).padStart(3)} 帧 / ${(r.bytes / 1024 / 1024).toFixed(2)} MB`
    + `（最大单帧 ${(r.largest / 1024 / 1024).toFixed(2)} MB）`);
}
console.log('');

if (direct.sample !== null) {
  const raw = direct.sample;
  const gz = zlib.gzipSync(raw, { level: 6 });
  const br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
  console.log('② 同一份字节若被压缩（WS 层，目前完全没有）');
  console.log(`   原始      ${(raw.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   gzip      ${(gz.length / 1024 / 1024).toFixed(2)} MB  (${(raw.length / gz.length).toFixed(1)}x)`);
  console.log(`   brotli    ${(br.length / 1024 / 1024).toFixed(2)} MB  (${(raw.length / br.length).toFixed(1)}x)`);
  console.log('');
  console.log('   这就是「切一次会话」在隧道上要走的明文量；压缩后能省下上面的差额。');
}

console.log('');
console.log('判读：');
console.log(`  经中转 / 直连 = ${direct.bytes > 0 ? (relayed.bytes / direct.bytes).toFixed(3) : '?'}（≈1.0 说明中转不改 WS 载荷）`);
console.log('  dsh 的 compression 中间件只作用于 HTTP；WS 帧绕过它 → 历史全程明文');
