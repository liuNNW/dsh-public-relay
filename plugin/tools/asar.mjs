#!/usr/bin/env node
/**
 * asar.mjs — 读 Electron app.asar（零依赖）
 *
 * 为什么重写：旧版 read-asar-file.mjs 假设 JSON 头从偏移 8 开始、内容区 = 头长 + 4，
 * 对当前 dsh 桌面版（0.2.1-rc.2）的 asar 解析失败（实际 JSON 从偏移 12 开始）。
 * 这里按真实结构实现，并同时提供「列目录 / 读文件 / 按内容搜索」三种能力。
 *
 * asar 结构（Chromium pickle）：
 *   [u32 4]                     第一个 pickle 的载荷长度（固定 4）
 *   [u32 headerPickleSize]      第二个 pickle 的载荷长度
 *   [u32 jsonLen]               = headerPickleSize - 4
 *   [json jsonLen 字节]
 *   [padding 到 4 字节对齐]
 *   [内容区]                    每项的 offset/size 相对内容区起点
 *
 * 用法：
 *   node asar.mjs <app.asar> ls  [路径前缀]
 *   node asar.mjs <app.asar> cat <内部路径>
 *   node asar.mjs <app.asar> grep <正则> [路径前缀] [--max N] [--files]
 *   node asar.mjs <app.asar> info
 */
import fs from 'node:fs';

const [, , asarPath, command = 'info', ...rest] = process.argv;

if (!asarPath) {
  console.error('usage: node asar.mjs <app.asar> <ls|cat|grep|info> [...]');
  process.exit(2);
}

/**
 * 解析 asar 头，返回 { tree, contentBase }。
 *
 * 真实布局（实测 dsh 0.2.1-rc.2，也是 Electron asar 的标准布局）：
 *   0x00 u32 = 4               第一个 pickle 的载荷长度
 *   0x04 u32 = headerPickleSize 整个 head pickle 的长度（含它自己的 8 字节前缀）
 *   0x08 u32 = headerPickleSize - 4
 *   0x0C u32 = jsonLen          JSON 字符串字节数
 *   0x10 起 = JSON 本体
 *   contentBase = 16 + jsonLen（jsonLen 已按 4 字节对齐）
 */
function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const firstPickle = head.readUInt32LE(0);
  const headerPickleSize = head.readUInt32LE(4);
  let jsonLen = head.readUInt32LE(12);
  const fileSize = fs.statSync(file).size;
  const plausible = (n) => Number.isFinite(n) && n > 0 && n < 256 * 1024 * 1024 && 16 + n <= fileSize;
  if (!plausible(jsonLen)) jsonLen = headerPickleSize - 8;
  if (!plausible(jsonLen)) throw new Error(`unexpected asar header: firstPickle=${firstPickle} headerPickleSize=${headerPickleSize} jsonLen=${jsonLen}`);

  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const text = jsonBuf.toString('utf8');
  let tree;
  try {
    tree = JSON.parse(text);
  } catch (err) {
    const end = text.lastIndexOf('}');
    if (end < 0) throw new Error(`asar JSON parse failed: ${err.message}`);
    tree = JSON.parse(text.slice(0, end + 1));
  }
  const contentBase = 16 + jsonLen;
  return { fd, tree, contentBase };
}

/** 深度优先遍历条目，产出 { path, entry }。 */
function* walk(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix === '' ? name : `${prefix}/${name}`;
    if (child.files) yield* walk(child, p);
    else yield { path: p, entry: child };
  }
}

function readEntry(fd, contentBase, entry) {
  // 符号链接条目只有 link 字段，没有 size/offset
  if (entry.link !== undefined) return Buffer.alloc(0);
  const size = Number(entry.size);
  const offset = Number(entry.offset);
  if (!Number.isFinite(size) || !Number.isFinite(offset) || size <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, contentBase + offset);
  // unpacked 条目（原生模块）在 app.asar.unpacked 里，这里返回空
  return entry.unpacked ? Buffer.alloc(0) : buf;
}

const { fd, tree, contentBase } = readHeader(asarPath);

try {
  if (command === 'info') {
    let files = 0;
    let bytes = 0;
    for (const { entry } of walk(tree)) {
      files += 1;
      bytes += Number(entry.size) || 0;
    }
    console.log(JSON.stringify({ asarPath, contentBase, files, bytes }, null, 2));
  } else if (command === 'ls') {
    const prefix = rest[0] ?? '';
    const out = [];
    for (const { path, entry } of walk(tree)) {
      if (prefix === '' || path.startsWith(prefix)) out.push(`${path} (${entry.size})`);
    }
    console.log(out.slice(0, 4000).join('\n'));
    if (out.length > 4000) console.log(`… 共 ${out.length} 项，只显示前 4000`);
  } else if (command === 'cat') {
    const target = rest[0];
    if (!target) throw new Error('cat needs an internal path');
    let found = null;
    for (const { path, entry } of walk(tree)) {
      if (path === target) { found = entry; break; }
    }
    if (found === null) throw new Error(`not found in asar: ${target}`);
    process.stdout.write(readEntry(fd, contentBase, found));
  } else if (command === 'grep') {
    const maxIdx = rest.indexOf('--max');
    const maxBytes = maxIdx >= 0 ? Number(rest[maxIdx + 1]) : 400;
    const filesOnly = rest.includes('--files');
    const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg.startsWith('--')) { if (arg === '--max') i += 1; continue; }
      positional.push(arg);
    }
    const pattern = positional[0];
    if (!pattern) throw new Error('grep needs a regular expression');
    const prefix = positional[1] ?? '';
    const re = new RegExp(pattern, 'gi');
    let hits = 0;
    for (const { path, entry } of walk(tree)) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      if (!/\.(js|mjs|cjs|json|ts|yml|yaml|md|txt|css|html)$/.test(path)) continue;
      const buf = readEntry(fd, contentBase, entry);
      if (buf.length === 0) continue;
      const text = buf.toString('utf8');
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m === null) continue;
      hits += 1;
      if (filesOnly) {
        console.log(path);
        continue;
      }
      const start = Math.max(0, m.index - Math.floor(maxBytes / 2));
      const slice = text.slice(start, start + maxBytes);
      console.log(`\n===== ${path} @${m.index} =====\n${slice}`);
      if (hits >= 40) { console.log('\n[hit limit 40]'); break; }
    }
    if (hits === 0) console.log('(no match)');
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} finally {
  fs.closeSync(fd);
}
