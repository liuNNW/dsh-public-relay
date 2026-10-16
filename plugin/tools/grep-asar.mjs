#!/usr/bin/env node
/**
 * grep-asar.mjs — 在 Electron app.asar 的原始字节里搜文本并打印上下文
 *
 * 用途：dsh 宿主的部分代码（含认证逻辑）只存在于 app.asar 内，普通 fs 看不到。
 * 这个脚本不需要正确解析 asar 目录树 —— 直接在字节流里找目标字符串，
 * 把前后若干字节按文本打印出来，足以看清实现。
 *
 * 用法：node grep-asar.mjs <app.asar> "<needle>" [before] [after]
 */
import fs from 'node:fs';

const [, , asarPath, needle, beforeArg, afterArg] = process.argv;
if (!asarPath || !needle) {
  console.error('usage: node grep-asar.mjs <app.asar> "<needle>" [before] [after]');
  process.exit(2);
}
if (!fs.existsSync(asarPath)) {
  console.error(`not found: ${asarPath}`);
  process.exit(2);
}

const before = Number(beforeArg ?? 900);
const after = Number(afterArg ?? 900);

const CHUNK = 4 * 1024 * 1024;
const buf = Buffer.alloc(CHUNK);
const fd = fs.openSync(asarPath, 'r');

let offset = 0;
let overlap = Buffer.alloc(0);
let hits = 0;
const MAX_HITS = 6;

try {
  while (hits < MAX_HITS) {
    const read = fs.readSync(fd, buf, 0, CHUNK, offset);
    if (read <= 0) break;

    const merged = Buffer.concat([overlap, buf.subarray(0, read)]);
    const base = offset - overlap.length;

    let from = 0;
    for (;;) {
      const idx = merged.indexOf(Buffer.from(needle, 'utf8'), from);
      if (idx < 0) break;
      hits++;
      const start = Math.max(0, idx - before);
      const end = Math.min(merged.length, idx + needle.length + after);
      const slice = merged.subarray(start, end);
      console.log(`\n===== 命中 ${hits}（文件偏移约 ${base + idx}）=====\n`);
      console.log(slice.toString('utf8').replace(/\0/g, '\\0'));
      from = idx + needle.length;
      if (hits >= MAX_HITS) break;
    }

    // 保留尾部作为下一次的重叠区，避免跨块漏掉
    overlap = merged.subarray(Math.max(0, merged.length - needle.length - 8));
    offset += read;
  }

  if (hits === 0) console.log(`没有找到 "${needle}"`);
} finally {
  fs.closeSync(fd);
}
