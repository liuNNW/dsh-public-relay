#!/usr/bin/env node
/**
 * add-bundle.mjs — 往 profile 的 package.json 里加/删一个 bundle 名
 *
 * 为什么不让 PowerShell 做：ConvertTo-Json 会把单元素数组压成标量、
 * 打乱键顺序、并把 UTF-8 中文写成乱码。这里用 node 精确读写 JSON。
 *
 * 用法:
 *   node add-bundle.mjs <profile/package.json> <bundle-name>            # 追加
 *   node add-bundle.mjs <profile/package.json> <bundle-name> --remove   # 移除
 *
 * 幂等：已存在则不重复追加；不存在则移除为空操作。
 * 退出码：0 = 成功（含幂等空操作），1 = 失败，2 = 用法错误。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const positional = args.filter((a) => !a.startsWith('--'));
const [manifestPath, bundleName] = positional;

if (!manifestPath || !bundleName) {
  console.error('usage: node add-bundle.mjs <profile/package.json> <bundle-name> [--remove]');
  process.exit(2);
}

const file = path.resolve(manifestPath);
if (!fs.existsSync(file)) {
  console.error(`[add-bundle] not found: ${file}`);
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
let manifest;
try {
  manifest = JSON.parse(raw);
} catch (err) {
  console.error(`[add-bundle] ${file} 不是合法 JSON：${err.message}`);
  process.exit(1);
}

if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  console.error('[add-bundle] profile manifest 顶层必须是 JSON 对象');
  process.exit(1);
}

// 缺失时按 dsh 的 profile 模板补出结构，而不是直接报错
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const current = manifest.dsh.profile.bundles;
let bundles = Array.isArray(current) ? [...current] : [];

const had = bundles.includes(bundleName);

if (remove) {
  bundles = bundles.filter((n) => n !== bundleName);
} else {
  if (!had) bundles.push(bundleName);
}

manifest.dsh.profile.bundles = bundles;

// 缩进 2 空格 + 末尾换行，与 dsh 自己的 writeProfileManifest 一致
const output = `${JSON.stringify(manifest, null, 2)}\n`;

if (output === raw) {
  console.log(`[add-bundle] 无需改动（${remove ? '不存在' : '已存在'}）：${bundleName}`);
} else {
  fs.writeFileSync(file, output, 'utf8');
  console.log(`[add-bundle] ${remove ? '已移除' : '已追加'} ${bundleName}`);
}

// 回读校验：必须是合法 JSON 且含义正确
const verify = JSON.parse(fs.readFileSync(file, 'utf8'));
const final = verify.dsh?.profile?.bundles;
if (!Array.isArray(final)) {
  console.error('[add-bundle] 回读校验失败：bundles 不是数组');
  process.exit(1);
}
const shouldContain = !remove;
if (final.includes(bundleName) !== shouldContain) {
  console.error(`[add-bundle] 回读校验失败：期望 ${shouldContain ? '包含' : '不含'} ${bundleName}`);
  process.exit(1);
}
console.log(`[add-bundle] bundles = ${JSON.stringify(final)}`);
