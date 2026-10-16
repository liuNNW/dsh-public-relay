#!/usr/bin/env node
/**
 * fix-credentials-version.mjs — 把 .credentials.yaml 的 version 改成字符串
 *
 * 为什么需要：npm 版 dsh CLI 的 credentials-local 解析器要求该字段是**字符串**，
 * 而 Electron 版写入的是 YAML 数字 `version: 1`。于是同一个文件在 Electron 里正常、
 * 在 npm CLI 里报：
 *   credentials-local: the value for "version" in ... must be a string
 *   → dsh: plugin tree failed to load
 *
 * 这是**预先存在**的环境问题，与本插件无关（把插件完全移除后同样报错）。
 * 本脚本只做这一处最小改动，并支持 --revert 还原。
 *
 * 用法：
 *   node fix-credentials-version.mjs [<DSH_HOME>]            # 修
 *   node fix-credentials-version.mjs [<DSH_HOME>] --check    # 只检查
 *   node fix-credentials-version.mjs [<DSH_HOME>] --revert   # 还原
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const revert = args.includes('--revert');
const home = args.find((a) => !a.startsWith('--'))
  || process.env.DSH_HOME
  || path.join(os.homedir(), '.dsh');

const file = path.join(home, '.credentials.yaml');
if (!fs.existsSync(file)) {
  console.error(`[fix-credentials] 找不到 ${file}`);
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const m = /^version:\s*(.+?)\s*$/m.exec(text);
if (!m) {
  console.error('[fix-credentials] 文件里没有顶层 version 字段');
  process.exit(1);
}

const rawValue = m[1];
const isQuoted = /^["']/.test(rawValue);
console.log(`[fix-credentials] 当前 version 值：${JSON.stringify(rawValue)}（${isQuoted ? '字符串，合法' : '未加引号，被解析为数字'})`);

if (checkOnly) {
  process.exit(isQuoted ? 0 : 1);
}

if (revert) {
  // 还原：把引号去掉，恢复成 YAML 数字
  if (!isQuoted) {
    console.log('[fix-credentials] 本来就是数字形式，无需还原');
    process.exit(0);
  }
  const bare = rawValue.replace(/^["']|["']$/g, '');
  fs.writeFileSync(file, text.replace(/^version:\s*.+?\s*$/m, `version: ${bare}`), 'utf8');
  console.log(`[fix-credentials] 已还原为 version: ${bare}`);
  process.exit(0);
}

if (isQuoted) {
  console.log('[fix-credentials] 已是字符串形式，无需改动');
  process.exit(0);
}

const bare = rawValue.replace(/^["']|["']$/g, '');
const out = text.replace(/^version:\s*.+?\s*$/m, `version: "${bare}"`);
fs.writeFileSync(file, out, 'utf8');

// 回读校验
const after = fs.readFileSync(file, 'utf8');
const ok = /^version:\s*["'][^"']*["']\s*$/m.test(after);
console.log(`[fix-credentials] 已改为 version: "${bare}"（校验${ok ? '通过' : '失败'}）`);
process.exitCode = ok ? 0 : 1;
