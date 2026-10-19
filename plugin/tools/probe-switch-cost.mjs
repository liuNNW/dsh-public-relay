#!/usr/bin/env node
/**
 * probe-switch-cost.mjs — 「来回切换会话」到底是每次都拉历史，还是只有首次
 *
 * 决定方案的关键问题：
 *   · 若切回已打开过的会话也要重拉 → 每次切换都付 4.6 MB，压缩是唯一正解
 *   · 若只有首次打开才拉 → 真正要修的是「客户端不该丢弃已打开的会话实例」
 *
 * 做法：模拟客户端的真实调用序列（open A → open B → 再 open A），
 * 每次重新开一条 follow 流，量下行字节。
 *
 * 注意：这里量的是**服务端每次都愿意给多少**，不代表浏览器一定重新要。
 * 两者之差正是「客户端实例保留」带来的省流。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';

const DSH = 19387;
const OBSERVE_MS = Number(process.argv[2] || 12000);

function sessionsByRecency(limit) {
  const root = 'C:/Users/LIU/.dsh/sessions';
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/^session(\.[\w]+)?\.jsonl\.zstd$/.test(e.name)) continue;
      const id = path.basename(dir);
      if (!/^session-[0-9a-f-]{36}$/.test(id)) continue;
      try { out.push({ id, m: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }); } catch { /* 跳过 */ }
    }
  };
  walk(root);
  out.sort((a, b) => b.m - a.m);
  return out.slice(0, limit);
}

const signer = createSessionSigner({ credentialsFile: 'C:/Users/LIU/.dsh/.credentials.yaml' });
const cookie = signer.checkout(`127.0.0.1:${DSH}`, undefined).cookieHeader;
const { default: WS } = await import(
  `file:///${process.env.USERPROFILE.replace(/\\/g, '/')}/.dsh/profiles/desktop/node_modules/ws/wrapper.mjs`
);

const samples = sessionsByRecency(2);
if (samples.length < 2) { console.error('需要至少两个会话样本'); process.exit(1); }
console.log(`A = ${samples[0].id}（磁盘 ${(samples[0].size / 1048576).toFixed(2)} MB）`);
console.log(`B = ${samples[1].id}（磁盘 ${(samples[1].size / 1048576).toFixed(2)} MB）\n`);

function openOnce(sessionId) {
  return new Promise((resolve) => {
    const r = { bytes: 0, frames: 0, why: 'pending' };
    const ws = new WS(`ws://127.0.0.1:${DSH}/api/remote.mux`, { headers: { cookie } });
    const finish = (why) => {
      if (r.why !== 'pending') return;
      r.why = why;
      try { ws._socket?.destroy(); } catch { /* 已关 */ }
      resolve(r);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'open',
        streamId: 's1',
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId },
              assistantStream: true,
              maxMessages: 500,
              turnWindow: { minMessages: 50, minTurns: 2 },
            },
          },
        },
      }));
      setTimeout(() => finish('window'), OBSERVE_MS);
    });
    ws.on('message', (d) => {
      r.bytes += Buffer.isBuffer(d) ? d.length : Buffer.byteLength(String(d));
      r.frames += 1;
    });
    ws.on('close', () => finish('closed'));
    ws.on('error', (e) => finish(`error:${e.code || e.message}`));
  });
}

const a1 = await openOnce(samples[0].id);
const b1 = await openOnce(samples[1].id);
const a2 = await openOnce(samples[0].id);

const fmt = (r) => `${(r.bytes / 1048576).toFixed(2)} MB / ${r.frames} 帧`;
console.log('调用序列（每次都是一条全新的 follow 流）：');
console.log(`  ① open A  ${fmt(a1)}`);
console.log(`  ② open B  ${fmt(b1)}`);
console.log(`  ③ open A  ${fmt(a2)}`);
console.log('');
console.log('判读：');
console.log('  ③ 与 ① 相等 → 服务端每次都愿意给全量；是否重付完全取决于客户端是否复用实例');
console.log('  服务端没有「已发送过就跳过」的机制，所以省流只能靠：客户端保留实例，或传输压缩');
