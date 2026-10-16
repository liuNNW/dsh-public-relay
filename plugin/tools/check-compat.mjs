#!/usr/bin/env node
/**
 * check-compat.mjs — 自检插件的版本兼容性声明
 *
 * ── 为什么需要这个检查 ──
 *
 * dsh 的插件管理器会校验插件 package.json 里的 peerDependencies 与 dshTarget。
 * 一旦不匹配，它返回：
 *
 *   "error": { "code": "incompatible-version",
 *              "incompatible": [{ "name": "...", "peers": {...} }] }
 *   "rows": []        ← 空！插件完全不会被加载
 *
 * 此时的症状极具误导性：dsh 能正常启动、启动日志不报错、插件文件也都在，
 * 但 UI 上**哪里都看不到这个插件**，重启多少次都没用。
 *
 * 最容易踩的写法：把 dsh 自带包（如 @deepseek-ai/dsh-tools）声成
 * "^0.1.0-rc.6" —— semver 的 ^ 对 0.x 预发布版本不匹配同系列的 rc.8，
 * 于是整包被拒。
 *
 * ── 判据（与 @deepseek-ai/dsh-mimo-vision 对齐）──
 *   · peerDependencies 只声明 @deepseek-ai/cordis（用 ~ 固定次版本）
 *   · dshTarget 与运行时主版本一致
 *   · 其余 dsh 自带包一律不写进 peerDependencies，改为运行期 ctx.get() 软获取
 *
 * 用法：node check-compat.mjs <package.json>
 * 退出码 0 = 通过
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const target = process.argv[2];
if (!target) {
  console.error('usage: node check-compat.mjs <package.json>');
  process.exit(2);
}

const file = path.resolve(target);
if (!fs.existsSync(file)) {
  console.error(`[check-compat] 找不到 ${file}`);
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const pluginDir = path.dirname(file);

const problems = [];
const notes = [];

/** 解析 dsh 运行时里某个包的真实版本（以插件自身为锚点，与运行时一致）。 */
function installedVersion(name) {
  try {
    const req = createRequire(path.join(pluginDir, 'package.json'));
    for (const sp of (req.resolve.paths(name) || [])) {
      const p = path.join(sp, name, 'package.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).version;
    }
  } catch { /* 未安装 */ }
  return null;
}

/** 极简 semver 范围匹配：覆盖本场景用到的写法（~x.y.z、^x.y.z、精确、*）。 */
function satisfies(version, range) {
  if (!version || !range || range === '*' || range === '') return true;
  const r = String(range).trim();
  const v = String(version).trim();

  const parse = (s) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(s);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
  };
  const a = parse(v);
  const b = parse(r);
  if (!a || !b) return false;

  // 精确版本（含预发布）
  if (/^\d/.test(r) && !r.startsWith('^') && !r.startsWith('~')) {
    const eq = (x, y) => x.major === y.major && x.minor === y.minor && x.patch === y.patch && (x.pre || '') === (y.pre || '');
    return eq(a, b);
  }

  const op = r[0];
  if (op === '~') {
    // ~x.y.z → 同 major.minor，patch >= z
    if (a.major !== b.major || a.minor !== b.minor) return false;
    if (a.patch < b.patch) return false;
    // 预发布：同 base 时要求 pre 版本 >= 声明；不同则保守判不匹配
    if (b.pre && !a.pre) return false;
    return true;
  }
  if (op === '^') {
    if (b.major > 0) {
      // ^x.y.z → 同 major，>= x.y.z
      if (a.major !== b.major) return false;
      if (a.minor < b.minor) return false;
      if (a.minor === b.minor && a.patch < b.patch) return false;
      return true;
    }
    // ^0.y.z → 只允许同 major.minor（这是 rc 系列踩坑的地方）
    if (a.major !== 0 || b.major !== 0) return false;
    if (a.minor !== b.minor) return false;
    if (a.patch < b.patch) return false;
    // 同一 minor 下：声明了预发布时，运行版若不是预发布 → 视为匹配（正式版更新）
    return true;
  }
  // 不支持其它写法，保守通过（避免误报阻断安装）
  notes.push(`无法判定的范围写法：${range}`);
  return true;
}

// ── 1. peerDependencies ──
//
// 只把「dsh 自带包写进 peers」当成致命问题。实测依据：
//   · @deepseek-ai/dsh-mimo-vision 声明 "@deepseek-ai/cordis": "~4.0.4"，
//     而运行时是 4.0.1 —— 同样不匹配，但它能正常加载。
//   所以 cordis 这条 dsh 并不校验，不能据此报错，否则会误导排查方向。
//   真正致命的是 dsh 自带能力包（dsh-tools / typert-protocol 等）出现在 peers 里：
//   插件管理器会拿它们跟运行时版本比对，rc 系列用 ^ 极易不匹配，
//   一旦不匹配就 incompatible-version、rows 为空、UI 上彻底看不到插件。
const peers = pkg.peerDependencies || {};
const peersMeta = pkg.peerDependenciesMeta || {};
const ALLOWED_PEER_PREFIX = '@deepseek-ai/cordis';

/** 该 peer 是否被标成 optional。 */
const isOptionalPeer = (name) => peersMeta[name]?.optional === true;

for (const [name, range] of Object.entries(peers)) {
  const actual = installedVersion(name);

  // `optional: true` 的 peer 是安全写法 —— 已发布并在市场里的
  // @deepseek-ai/dsh-mimo-vision 与 dsh-plugin-wallpaper-engine 都用它把
  // dsh 自带能力包声明进来。optional 的含义是「宿主没提供也不报错」，
  // 插件管理器不会拿它做 incompatible-version 判定，因此不该判失败。
  if (isOptionalPeer(name)) {
    if (actual === null) notes.push(`${name}@${range}（optional；解析路径内未找到运行时版本，跳过比对）`);
    else notes.push(`${name}@${range} ↔ 运行时 ${actual}（optional，不参与版本拒绝）`);
    continue;
  }

  if (!name.startsWith(ALLOWED_PEER_PREFIX)) {
    problems.push(
      `peerDependencies 声明了**非 optional** 的 ${name}@${range}：dsh 自带能力包必须标 optional，`
      + `否则插件管理器会校验它与运行时版本，不匹配就整包拒绝`
      + `（症状：dsh 启动正常但 UI 里完全没有这个插件）。`
      + `加进 peerDependenciesMeta 标 optional: true，或改为运行期 ctx.get('<服务名>') 软获取。`,
    );
    continue;
  }

  // 允许的 peer：只提示，不判失败
  if (actual === null) notes.push(`${name}@${range}（解析路径内未找到运行时版本，跳过比对）`);
  else notes.push(`${name}@${range} ↔ 运行时 ${actual}（dsh 不校验此条，仅供参考）`);
}

// ── 2. dshTarget ──
const target2 = pkg.dshTarget;
if (!target2) {
  problems.push('缺少 dshTarget：与 MiMo 对齐应声明 dshTarget（如 "0.2.0-rc.2"）');
} else {
  notes.push(`dshTarget: ${target2}`);
}

// ── 3. 结构完整性 ──
if (!pkg.dsh?.bundle?.patch) problems.push('缺少 dsh.bundle.patch → bundles 机制无法装载');
else if (!fs.existsSync(path.join(pluginDir, pkg.dsh.bundle.patch))) {
  problems.push(`dsh.bundle.patch 指向的 ${pkg.dsh.bundle.patch} 不存在`);
} else {
  notes.push(`dsh.bundle.patch: ${pkg.dsh.bundle.patch} ✓`);
}

if (!pkg.dsh?.client?.platform) problems.push('缺少 dsh.client.platform → 浏览器半不会被加载');
else notes.push(`dsh.client.platform: ${pkg.dsh.client.platform} ✓`);

if (pkg.type !== 'module') notes.push('提示：type 建议为 "module"（ESM）');

// ── 输出 ──
console.log(`[check-compat] ${path.basename(pluginDir)}@${pkg.version || '?'}`);
for (const n of notes) console.log(`  · ${n}`);
if (problems.length > 0) {
  console.error(`[check-compat] 发现 ${problems.length} 个会导致「插件不加载」的问题：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exitCode = 1;
} else {
  console.log('[check-compat] 兼容性声明 OK');
  process.exitCode = 0;
}
