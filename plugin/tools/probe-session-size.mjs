#!/usr/bin/env node
/**
 * probe-session-size.mjs — 量出一个真实会话「首屏历史」有多少字节
 *
 * dsh 的会话日志是**多帧** zstd（每帧一条记录），Node 的 zstdDecompressSync
 * 只解第一帧，所以这里手工按帧边界逐帧解，统计：
 *   · 总记录数 / 解压后总量 / 压缩比
 *   · 首屏历史（PAGE_MESSAGES = 50 条消息窗口）的真实字节量
 *
 * 意义：切一次会话就要拉这么多字节。经隧道时这段是纯等待。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const file = process.argv[2]
  || 'C:/Users/LIU/.dsh/sessions/--D-~6570~636E-~4E0B~8F7D-~91CD~6784vue-~5403~74DC~7F51--/session-401a11c1-9211-4186-b544-0df73de6bcee/session.v4.jsonl.zstd';

const raw = fs.readFileSync(file);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找到下一个帧魔数（用于切帧）。 */
function findNextFrame(buf, from) {
  const idx = buf.indexOf(ZSTD_MAGIC, from + 1);
  return idx < 0 ? buf.length : idx;
}

let offset = 0;
let text = '';
let frames = 0;
let skipped = 0;

while (offset < raw.length) {
  const end = findNextFrame(raw, offset);
  const frame = raw.subarray(offset, end);
  try {
    text += zlib.zstdDecompressSync(frame).toString('utf8');
    frames += 1;
  } catch {
    skipped += 1;
  }
  offset = end;
}

const lines = text.split('\n').filter((l) => l.trim() !== '');
const uncompressed = Buffer.byteLength(text, 'utf8');

console.log(`文件：${path.basename(path.dirname(file))}/${path.basename(file)}`);
console.log(`  压缩后      ${(raw.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  解压后      ${(uncompressed / 1024 / 1024).toFixed(2)} MB`);
console.log(`  压缩比      ${(raw.length / Math.max(uncompressed, 1) * 100).toFixed(1)}%`);
console.log(`  帧 / 记录   ${frames} 帧 / ${lines.length} 条${skipped ? `（${skipped} 帧未能解）` : ''}`);

// 模拟首屏：PAGE_MESSAGES = 50 条「消息」（这里按记录近似，一条记录≈一条事件）
const PAGE = 50;
let acc = 0;
for (let i = 0; i < Math.min(PAGE, lines.length); i += 1) acc += Buffer.byteLength(lines[i], 'utf8');
console.log('');
console.log(`首屏（前 ${Math.min(PAGE, lines.length)} 条记录）：`);
console.log(`  未压缩      ${(acc / 1024).toFixed(0)} KB`);
console.log(`  gzip 后约   ${(zlib.gzipSync(Buffer.from(lines.slice(0, PAGE).join('\n')), { level: 6 }).length / 1024).toFixed(0)} KB`);
console.log('');
console.log('含义：每次切会话都要在隧道上拉这一段。若压缩被绕过（例如中转强制 identity），');
console.log('      这一段会按未压缩量走，是「切换很卡」的直接来源。');
