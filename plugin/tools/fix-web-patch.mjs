#!/usr/bin/env node
/**
 * fix-web-patch.mjs — 修 web profile 的 cordis.patch.yml 顶层数组问题
 *
 * 背景（这是 dsh-web.log 里那些"静默崩溃"的真因）：
 *   ~/.dsh/profiles/web/cordis.patch.yml 当前只有注释，YAML 解析为 null。
 *   dsh 的 parsePatchList 要求顶层是数组，于是抛
 *   `overlay ... must be a top-level YAML array of loader patch entries`，
 *   web profile 直接起不来。
 *
 * 本脚本做**最小修正**：只保证顶层是一个数组，完整保留原有注释与内容。
 * 已经合法的文件不动。
 *
 * 用法:
 *   node fix-web-patch.mjs <path-to-cordis.patch.yml> [--check]
 *   --check 只报告不改动（退出码 0=合法，1=不合法）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('usage: node fix-web-patch.mjs <cordis.patch.yml> [--check]');
  process.exit(2);
}

const file = path.resolve(target);
if (!fs.existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(2);
}

/** 就近解析 js-yaml（dsh 的模块回退目录里有）。 */
function loadYaml() {
  const candidates = [
    path.join(path.dirname(file), 'node_modules'),
    path.join(path.dirname(path.dirname(file)), 'node_modules'),   // profiles/node_modules
    process.cwd(),
  ];
  for (const base of candidates) {
    try {
      const req = createRequire(path.join(base, '_probe.js'));
      return req('js-yaml');
    } catch { /* 试下一个锚点 */ }
  }
  throw new Error('cannot resolve js-yaml from any anchor; pass a profile dir that has it');
}

const yaml = loadYaml();
const original = fs.readFileSync(file, 'utf8');

let parsed;
let parseError = null;
try {
  parsed = yaml.load(original);
} catch (err) {
  parseError = err;
}

const alreadyArray = Array.isArray(parsed);

if (checkOnly) {
  console.log(JSON.stringify({
    file,
    isArray: alreadyArray,
    value: alreadyArray ? `array(len=${parsed.length})` : (parsed === null ? 'null' : typeof parsed),
    parseError: parseError ? parseError.message : null,
  }, null, 2));
  process.exit(alreadyArray ? 0 : 1);
}

if (alreadyArray) {
  console.log(`[fix-web-patch] 已是合法 YAML 数组（len=${parsed.length}），不动：${file}`);
  process.exit(0);
}

if (parseError) {
  console.error(`[fix-web-patch] 文件存在 YAML 语法错误，拒绝改动以免掩盖问题：${parseError.message}`);
  process.exit(1);
}

// 顶层是 null（纯注释）或标量/映射：保留原内容，末尾补一个空数组。
// 追加的注释说明为什么必须这样，方便以后的人看懂。
const note = [
  '',
  '# ── 顶层必须是 YAML 数组 ──',
  '# 上面全部是注释时，YAML 把整个文档解析为 null，dsh 会以',
  '#   "overlay ... must be a top-level YAML array of loader patch entries"',
  '# 拒绝启动本 profile。下面这行空数组表示"没有补丁"，不影响任何既有配置。',
  '# 要加补丁，就把条目写在下面（例如：- insert: [{ id: xxx, name: yyy }]）。',
  '[]',
  '',
].join('\n');

const fixed = original.replace(/\s*$/, '') + '\n' + note;
fs.writeFileSync(file, fixed, 'utf8');

// 立即回读校验
const verify = yaml.load(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(verify)) {
  console.error('[fix-web-patch] 修正后仍不是数组，已回滚');
  fs.writeFileSync(file, original, 'utf8');
  process.exit(1);
}

console.log(`[fix-web-patch] 已修：${file}`);
console.log(`[fix-web-patch]   ${Buffer.byteLength(original, 'utf8')} → ${Buffer.byteLength(fixed, 'utf8')} 字节，注释全保留，顶层现为 array(len=${verify.length})`);
