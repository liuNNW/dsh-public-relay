#!/usr/bin/env node
/**
 * check-compat.mjs — 自检插件的版本兼容性声明
 *
 * ── 为什么需要这个检查 ──
 *
 * dsh 的插件管理器在装载/启用 bundle 前会跑
 * `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`。
 * 一旦不匹配，它返回：
 *
 *   { "code": "incompatible-version",
 *     "incompatible": [{ "name", "version", "runtimeVersion", "requirements" }] }
 *   "rows": []        ← 空！插件完全不会被加载
 *
 * 症状极具误导性：dsh 能正常启动、启动日志不报错、插件文件也都在，
 * 但 UI 上**哪里都看不到这个插件**，重启多少次都没用。
 *
 * ── 判据（已从 0.2.1-rc.2 源码逐行核实，不是推测）──
 *
 * `dsh-app-boot` 的 `unmetRequirements()`：
 *
 *   ① 有 `engines.dsh` → **只看它**，peerDependencies 整个被忽略；
 *      范围为空串 / `workspace:` 一律判不满足。
 *   ② 没有 `engines.dsh` → 逐个检查 peerDependencies 里**名字符合
 *      `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*`** 的项；其余（cordis、
 *      schemastery、react…）根本不看。
 *   ③ `peerDependenciesMeta.optional` **完全不参与判定** —— 标了 optional 的
 *      dsh-* peer 依然会被强制校验。这是最容易踩的一条。
 *   ④ 两者都不声明 → 恒通过（数学上的保证）。
 *   ⑤ 范围比较用 `semver.satisfies(runtime, range, { includePrerelease: true })`，
 *      所以 `^0.2.0` 能匹配 `0.2.1-rc.2`（普通 npm 语义下不行）。
 *
 * `dshTarget` 是**本仓库早期自造的字段，dsh 从不读取**（全量 grep 零命中），
 * 已废弃；本检查会把它报为「无害但无意义」。
 *
 * 用法：node check-compat.mjs <package.json>
 * 退出码 0 = 通过
 */
import fs from 'node:fs';
import path from 'node:path';
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
const warnings = [];
const notes = [];

/** 解析运行时里某个包的真实版本（以插件自身为锚点）。 */
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

/**
 * 读取运行时版本。
 *
 * 注意 `@deepseek-ai/dsh`（无后缀）不是运行时版本来源：共享目录里可能还留着
 * 0.1.0-rc.8 的老副本，读它会得出错误结论。真正可信的来源，按优先级：
 *   1. `@deepseek-ai/dsh-app-boot` —— 兼容性检查本身就是它做的，版本即运行时
 *   2. 环境变量 `DSH_RUNTIME_VERSION`（给 CI / 显式覆盖用）
 *   3. 读不到 → null，比对时跳过并提示
 */
function runtimeVersion() {
  const fromEnv = process.env.DSH_RUNTIME_VERSION;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return installedVersion('@deepseek-ai/dsh-app-boot') || null;
}

/**
 * semver 范围匹配，**对齐 dsh 的 includePrerelease: true 语义**。
 *
 * 覆盖本场景用到的写法：^x.y.z / ~x.y.z / 精确 / >=x.y.z / * 。
 * 判错方向很重要：本检查用于拦截「会导致整包被拒」的写法，
 * 所以不确定时应当报警而不是放行。
 */
function satisfies(version, range) {
  if (!version) return { ok: true, reason: '运行时版本未知，跳过比对' };
  if (!range || range === '' ) return { ok: false, reason: '空范围恒不满足' };
  if (range === '*') return { ok: true, reason: '*' };

  if (range.startsWith('workspace:')) return { ok: false, reason: 'workspace: 在 engines.dsh 里恒不满足' };

  const parse = (s) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(s).trim());
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
  };
  const a = parse(version);
  if (!a) return { ok: false, reason: `无法解析运行时版本 ${version}` };

  // >=x.y.z
  if (range.startsWith('>=')) {
    const b = parse(range.slice(2));
    if (!b) return { ok: false, reason: `无法解析范围 ${range}` };
    const cmp = (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
    if (cmp > 0) return { ok: true, reason: `>= ${range.slice(2)}` };
    if (cmp < 0) return { ok: false, reason: `低于 >= ${range.slice(2)}` };
    // 同 base：includePrerelease 下，带 pre 的运行时仍满足（dsh 的判定就是如此）
    return { ok: true, reason: `>= ${range.slice(2)}（同 base）` };
  }

  const b = parse(range.startsWith('^') || range.startsWith('~') ? range.slice(1) : range);
  if (!b) return { ok: false, reason: `无法解析范围 ${range}` };

  const exact = !range.startsWith('^') && !range.startsWith('~');
  const eqBase = (x, y) => x.major === y.major && x.minor === y.minor && x.patch === y.patch;

  if (exact) {
    return eqBase(a, b) && (a.pre || '') === (b.pre || '')
      ? { ok: true, reason: '精确匹配' }
      : { ok: false, reason: '精确版本不相等' };
  }

  if (range.startsWith('~')) {
    // ~x.y.z → 同 major.minor，patch >= z
    if (a.major !== b.major || a.minor !== b.minor) return { ok: false, reason: '~ 要求同 major.minor' };
    if (a.patch < b.patch) return { ok: false, reason: '~ 要求 patch 不小于声明值' };
    return { ok: true, reason: '~ 匹配' };
  }

  // ^x.y.z
  if (b.major > 0) {
    if (a.major !== b.major) return { ok: false, reason: '^ 要求同 major' };
    if (a.minor < b.minor) return { ok: false, reason: '^ 要求 minor 不小于声明值' };
    if (a.minor === b.minor && a.patch < b.patch) return { ok: false, reason: '^ 要求 patch 不小于声明值' };
    return { ok: true, reason: '^ 匹配（includePrerelease）' };
  }
  // ^0.y.z：0.x 语义 —— 同 major.minor。注意 includePrerelease 让 ^0.2.0 也能匹配 0.2.1-rc.2
  if (a.major !== 0) return { ok: false, reason: '^0.y.z 只匹配 0.x' };
  if (a.minor !== b.minor) return { ok: false, reason: '^0.y.z 要求同 minor' };
  if (a.patch < b.patch) return { ok: false, reason: '^0.y.z 要求 patch 不小于声明值' };
  return { ok: true, reason: '^0.y.z 匹配（includePrerelease）' };
}

const runtime = runtimeVersion();
notes.push(runtime === null ? '运行时版本：未解析到（跳过范围比对）' : `运行时 dsh 版本：${runtime}`);

// ── 1. engines.dsh（存在时完全决定结果）──
const engines = pkg.engines || {};
if (Object.hasOwn(engines, 'dsh')) {
  if (typeof engines.dsh !== 'string') {
    problems.push('engines.dsh 必须是字符串（非字符串会让兼容性检查抛错，等于整包被拒）');
  } else {
    const r = satisfies(runtime, engines.dsh);
    if (r.ok) {
      notes.push(`engines.dsh: ${engines.dsh} ✓（${r.reason}；存在时 peerDependencies 被完全忽略）`);
    } else {
      problems.push(
        `engines.dsh: ${engines.dsh} 不满足 —— ${r.reason}。`
        + `有 engines.dsh 时它**单独决定**结论，peerDependencies 不参与。`,
      );
    }
  }
  // 有 engines.dsh 时 peers 不参与判定，但仍提示畸形类型（会抛错）
  for (const [name, range] of Object.entries(pkg.peerDependencies || {})) {
    if (typeof range !== 'string') problems.push(`peerDependencies[${JSON.stringify(name)}] 必须是字符串（非字符串会抛错）`);
  }
} else {
  // ── 2. peerDependencies 里只有 dsh-* 会被检查 ──
  const peers = pkg.peerDependencies || {};
  if (Object.keys(peers).length === 0) {
    notes.push('既无 engines.dsh 也无 peerDependencies → 恒通过兼容性检查 ✓');
  }

  for (const [name, range] of Object.entries(peers)) {
    if (typeof range !== 'string') {
      problems.push(`peerDependencies[${JSON.stringify(name)}] 必须是字符串（非字符串会抛错）`);
      continue;
    }
    const checked = name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
    if (!checked) {
      notes.push(`${name}@${range}（dsh 不校验这类 peer，仅供参考）`);
      continue;
    }
    const optional = pkg.peerDependenciesMeta?.[name]?.optional === true;
    const r = satisfies(runtime, range);
    if (r.ok) {
      notes.push(`${name}@${range} ✓（${r.reason}${optional ? '；标了 optional 但 dsh 照样校验' : ''}）`);
    } else {
      problems.push(
        `${name}@${range} 不满足 —— ${r.reason}。`
        + `dsh 会据此判 incompatible-version 并整包拒绝加载`
        + `${optional ? '；注意 peerDependenciesMeta.optional **不能**豁免这条检查' : ''}。`,
      );
    }
  }
}

// ── 3. 结构完整性 ──
if (!pkg.dsh?.bundle?.patch) {
  problems.push('缺少 dsh.bundle.patch → bundle 机制无法装载（manager 报 not-bundle）');
} else {
  const patchPath = path.join(pluginDir, pkg.dsh.bundle.patch);
  if (!fs.existsSync(patchPath)) problems.push(`dsh.bundle.patch 指向的 ${pkg.dsh.bundle.patch} 不存在`);
  else notes.push(`dsh.bundle.patch: ${pkg.dsh.bundle.patch} ✓`);
}

if (pkg.dsh?.client && !pkg.dsh.client.platform) {
  problems.push('有 dsh.client 但缺 platform → 浏览器半不会被加载（platform 必须是 "web"）');
} else if (pkg.dsh?.client?.platform && pkg.dsh.client.platform !== 'web') {
  problems.push(`dsh.client.platform = ${JSON.stringify(pkg.dsh.client.platform)}；当前只支持 "web"`);
} else if (pkg.dsh?.client?.platform === 'web') {
  const clientExport = typeof pkg.exports === 'object' ? pkg.exports['./client'] : undefined;
  if (!clientExport) problems.push('声明了 dsh.client 但 exports 里没有 "./client" → 组合期抛错');
  else notes.push('exports["./client"] ✓');
  const external = pkg.dsh.client.external;
  if (Array.isArray(external) && external.length > 0) {
    warnings.push(`dsh.client.external = ${JSON.stringify(external)}：可用的只有外壳冻结的模块表`
      + `（react / react-dom / @deepseek-ai/dsh-client-ui-primitives 等）；其余请求必须由另一个 client 包提供`);
  }
}

// ── 4. 已废弃字段 ──
if (Object.hasOwn(pkg, 'dshTarget')) {
  warnings.push('dshTarget 是早期自造字段，dsh 从不读取（0.2.1-rc.2 全量 grep 零命中），可以删掉');
}
if (Object.hasOwn(pkg.dsh || {}, 'manifestVersion') && typeof pkg.dsh.manifestVersion !== 'number') {
  warnings.push('dsh.manifestVersion 只作文档用途，非数字即可；dsh 不校验它');
}

if (pkg.type !== 'module') notes.push('提示：type 建议为 "module"（ESM）');

// ── 输出 ──
console.log(`[check-compat] ${pkg.name || path.basename(pluginDir)}@${pkg.version || '?'}`);
for (const n of notes) console.log(`  · ${n}`);
for (const w of warnings) console.log(`  ! ${w}`);

if (problems.length > 0) {
  console.error(`[check-compat] 发现 ${problems.length} 个会导致「插件不加载」的问题：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exitCode = 1;
} else {
  console.log('[check-compat] 兼容性声明 OK');
  process.exitCode = 0;
}
