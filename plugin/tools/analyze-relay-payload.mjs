#!/usr/bin/env node
/**
 * analyze-relay-payload.mjs — 量化「中转对启动/live 流量的放大」
 *
 * 只用真实的 dsh 与真实的中转，不 mock：
 *   1. 用 dsh-cookie 代签一个会话 Cookie（直连 dsh 用）
 *   2. 用 relay 的 makeAuth 签一个中转口令 Cookie（经中转用）
 *   3. 取 index 里的 85 个 combo bundle URL，逐条对比
 *      「直连 gzip 后的字节数」与「经中转后的字节数」
 *   4. 找出哪些 bundle 真的含 isLoopback（应当被改写的那些）
 *
 * 结论用于判断「force-loopback 放开 accept-encoding」的代价有多大。
 */
import http from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createSessionSigner } from '../dsh-public-relay/lib/dsh-cookie.js';
import { makeAuth } from '../dsh-public-relay/lib/relay.js';

const DSH = 19387;
const RELAY = 3091;
const PASSWORD = process.argv[2] || '20040915';

/** 发一个 GET，返回 { status, bytes }；可选解码后取文本。 */
function get(port, path, cookie, { acceptEncoding = 'gzip, br', decode = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: { cookie, 'accept-encoding': acceptEncoding, connection: 'close' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let text = null;
        if (decode) {
          // 简单解码：只处理 gzip / identity（够本脚本用）
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          if (enc === 'gzip') {
            try { text = gunzipSync(raw).toString('utf8'); } catch { text = null; }
          } else if (enc === 'br') {
            try { text = brotliDecompressSync(raw).toString('utf8'); } catch { text = null; }
          } else if (enc === '' || enc === 'identity') {
            text = raw.toString('utf8');
          }
        }
        resolve({ status: res.statusCode, bytes: raw.length, encoding: res.headers['content-encoding'] || 'identity', text });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const signer = createSessionSigner({ credentialsFile: process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : 'C:/Users/LIU/.dsh/.credentials.yaml' });
const dshCookie = signer.checkout(`127.0.0.1:${DSH}`, undefined).cookieHeader;
const auth = makeAuth(PASSWORD);
const relayCookie = auth
  ? `${auth.cookieName}=${auth.signToken(Date.now() + 86400000)}`
  : '';

// ── 1. 取 index，抽出所有 combo URL ──
const index = await get(DSH, '/', dshCookie, { decode: true });
const urls = [...new Set([...index.text.matchAll(/"url":"(plugins\/\?\?[^"]+)"/g)].map((m) => m[1]))];
console.log(`index 直连 ${(index.bytes / 1024).toFixed(1)} KB（${index.encoding}）`);
console.log(`combo bundle 数：${urls.length}\n`);

// ── 2. 逐条对比 ──
let directTotal = 0;
let relayTotal = 0;
let patched = 0;
const patchedList = [];
for (const url of urls) {
  const d = await get(DSH, `/${url}`, dshCookie);
  const r = await get(RELAY, `/${url}`, relayCookie);
  if (d.status !== 200 || r.status !== 200) continue;
  directTotal += d.bytes;
  relayTotal += r.bytes;
  if (r.bytes > d.bytes * 1.2) {
    patched += 1;
    patchedList.push({ url, d: d.bytes, r: r.bytes });
  }
}

console.log('启动时全部 combo bundle 合计：');
console.log(`  直连（gzip）  ${(directTotal / 1024 / 1024).toFixed(2)} MB`);
console.log(`  经中转        ${(relayTotal / 1024 / 1024).toFixed(2)} MB`);
console.log(`  放大          ${directTotal > 0 ? (relayTotal / directTotal).toFixed(2) : '?'}x`);
console.log(`  增量          ${((relayTotal - directTotal) / 1024 / 1024).toFixed(2)} MB`);
console.log(`\n被「解压后再传」的 bundle：${patched} 个`);
for (const p of patchedList.slice(0, 8)) {
  console.log(`  ${(p.d / 1024).toFixed(0)} KB → ${(p.r / 1024).toFixed(0)} KB  ${p.url.slice(0, 90)}`);
}
if (patchedList.length > 8) console.log(`  …其余 ${patchedList.length - 8} 个`);
