#!/usr/bin/env node
/**
 * read-asar-file.mjs — 从 Electron app.asar 里读出一个文件的文本
 *
 * 用途：dsh 的宿主代码（含插件版本校验）打包在 app.asar 内，普通 fs 看不到。
 * asar 格式：8 字节 pickle 头 + JSON 目录树 + 拼接的文件内容；
 * 每个文件项记录 { offset, size }，offset 相对「内容区起点」= 8 + JSON 长度
 * 向上对齐到 4 字节 + 4 字节 pickle padding。
 *
 * 用法：node read-asar-file.mjs <app.asar> <内部路径关键字> [--max N]
 *   例：node read-asar-file.mjs app.asar incompatible
 *       node read-asar-file.mjs app.asar dsh-plugin-manager/lib/index.js
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const asar = args[0];
const needle = args[1];
const maxIdx = args.indexOf('--max');
const maxBytes = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 200000;

if (!asar || !needle) {
  console.error('usage: node read-asar-file.mjs <app.asar> <path-substring> [--max N]');
  process.exit(2);
}
if (!fs.existsSync(asar)) {
  console.error(`not found: ${asar}`);
  process.exit(2);
}

const fd = fs.openSync(asar, 'r');
try {
  /**
   * asar 头是 Chromium pickle：
   *   [u32 payloadSize][u32 jsonLen][json...][padding]
   * 其中 payloadSize = 4(自身) + 4(jsonLen) + jsonLen，整个头再对齐到 4 字节。
   * 所以 JSON 从偏移 8 开始，长度是第 2 个 u32。
   */
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const payloadSize = head.readUInt32LE(0);
  let jsonLen = head.readUInt32LE(4);

  // 个别版本把 payloadSize 当作 header 总长；两种都试
  if (jsonLen <= 0 || jsonLen > 128 * 1024 * 1024) jsonLen = payloadSize - 8;
  if (jsonLen <= 0 || jsonLen > 128 * 1024 * 1024) {
    console.error(`unexpected asar header: payloadSize=${payloadSize} jsonLen=${jsonLen}`);
    process.exit(1);
  }

  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 8);
  const text = jsonBuf.toString('utf8').replace(/\0+$/, '');
  let tree;
  try {
    tree = JSON.parse(text);
  } catch (err) {
    // 末尾可能有 pickle 对齐填充；截到最后一个 }
    const end = text.lastIndexOf('}');
    if (end < 0) {
      console.error(`asar JSON 解析失败：${err.message}`);
      process.exit(1);
    }
    tree = JSON.parse(text.slice(0, end + 1));
  }

  // 内容区起点 = 头总长（8 + jsonLen 对齐到 4） + 4 字节内容长度前缀
  const headerTotal = 8 + jsonLen + ((4 - ((8 + jsonLen) % 4)) % 4);
  const contentBase = headerTotal + 4;

  const matches = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix === '' ? name : `${prefix}/${name}`;
      if (child.files) walk(child, p);
      else if (p.includes(needle)) matches.push({ path: p, ...child });
    }
  };
  walk(tree, '');

  if (matches.length === 0) {
    console.error(`没有匹配 "${needle}" 的文件`);
    process.exit(1);
  }

  console.log(`匹配到 ${matches.length} 个文件（内容区起点 ${contentBase}）：`);
  for (const m of matches.slice(0, 20)) console.log(`  ${m.path}  offset=${m.offset} size=${m.size}`);

  // 读第一个匹配
  const m = matches.find((x) => /\.(js|mjs|cjs|json|ts)$/.test(x.path)) || matches[0];
  const size = Math.min(m.size, maxBytes);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, contentBase + Number(m.offset));
  console.log(`\n===== ${m.path}（前 ${size} / ${m.size} 字节）=====\n`);
  console.log(buf.toString('utf8'));
} finally {
  fs.closeSync(fd);
}
