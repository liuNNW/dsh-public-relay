#!/usr/bin/env node
/**
 * diagnose.mjs — 诊断「设置里看不到 DSH 中转卡片」的原因
 *
 * 只读，不改任何东西。逐项检查本插件实际依赖的装载路径：
 *   1. 插件是否装在 profile 本地 node_modules（与 MiMo 同位）
 *   2. profile 的 cordis.patch.yml 是否有 dsh-relay 条目，且顶层是合法数组
 *   3. schemastery 版本是否支持 .volatile()（设置页表单的必要条件）
 *   4. 宿主可选的 dsh-tools / dsh-settings 是否可解析
 *   5. 插件源码能否真正 import（含 Config 构造）
 *   6. 当前是否有 dsh 进程在跑，以及它的启动时间
 *
 * 用法：node plugin/tools/diagnose.mjs [--profile desktop]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const pIdx = args.indexOf('--profile');
const profileName = pIdx >= 0 && args[pIdx + 1] ? args[pIdx + 1] : 'desktop';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profilesDir = path.join(HOME, 'profiles');
const profileDir = path.join(profilesDir, profileName);
const pluginDir = path.join(profileDir, 'node_modules', 'dsh-relay');
const sharedPluginDir = path.join(profilesDir, 'node_modules', 'dsh-relay');
const patchFile = path.join(profileDir, 'cordis.patch.yml');
const manifest = path.join(profileDir, 'package.json');

const problems = [];
function out(s = '') { console.log(s); }
function head(t) { out(); out(`── ${t} ──`); }
function ok(s) { out(`  ✓ ${s}`); }
function bad(s) { out(`  ✗ ${s}`); problems.push(s); }
function info(s) { out(`  · ${s}`); }

out('dsh-relay 诊断');
out(`DSH_HOME : ${HOME}`);
out(`profile  : ${profileName}`);

// ── 1. 插件安装位置 ──
head('1. 插件安装位置');
const required = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/relay.js', 'lib/config.js', 'lib/dsh-cookie.js'];
if (!fs.existsSync(pluginDir)) {
  bad(`profile 本地没有插件：${pluginDir}`);
  out('      → 这会让 schemastery 解析到共享目录的旧版本（缺 .volatile()），设置页可能没表单');
  out('      → 重新运行 install.ps1 可修复');
} else {
  ok(`已装在 profile 本地：${pluginDir}`);
  const missing = required.filter((f) => !fs.existsSync(path.join(pluginDir, f)));
  if (missing.length === 0) ok('运行时文件齐备');
  else bad(`缺少文件：${missing.join(', ')}`);
}
if (fs.existsSync(sharedPluginDir)) {
  info(`注意：共享目录也有一份（${sharedPluginDir}）。两份并存时以 profile 本地为准，建议删掉共享目录那份。`);
}

// ── 2. cordis.patch.yml 条目 ──
head('2. cordis.patch.yml 条目（这是本插件真正的装载路径）');
let yaml = null;
let profileReq = null;
try {
  profileReq = createRequire(manifest);
  yaml = profileReq('js-yaml');
} catch {
  try { yaml = createRequire(import.meta.url)('js-yaml'); } catch { yaml = null; }
}

if (!fs.existsSync(patchFile)) {
  bad(`找不到 ${patchFile}`);
} else {
  const text = fs.readFileSync(patchFile, 'utf8');
  const hasRowText = /^-\s*id:\s*dsh-relay\s*$/m.test(text);
  const hasPlaceholder = /^\s*\[\s*\]\s*$/m.test(text);
  const hasOtherEntry = text.split(/\r?\n/).some((l) => /^- /.test(l));

  if (yaml) {
    const T = (k) => new yaml.Type('tag:yaml.org,2002:js', {
      kind: k, resolve: () => true, construct: (d) => ({ __js: d }),
    });
    try {
      const doc = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([T('scalar'), T('sequence'), T('mapping')]) });
      if (!Array.isArray(doc)) {
        bad(`顶层不是 YAML 数组（解析为 ${doc === null ? 'null' : typeof doc}）→ dsh 会拒绝启动该 profile`);
        out('      → node plugin/tools/fix-web-patch.mjs "' + patchFile + '"');
      } else {
        ok(`顶层是 YAML 数组（${doc.length} 项）`);

        // 关键：dsh 的 applyEntryPatches 只对**带 insert:** 的 patch 新增条目；
        // 不带 insert 的按 id 去已有树里找目标，找不到就静默丢弃。
        // 所以判据是「存在一个 insert 块，其下含 id=dsh-relay」。
        const insertBlock = doc.find((e) => e && Array.isArray(e.insert)
          && e.insert.some((r) => r && r.id === 'dsh-relay'));
        const bareRow = doc.find((e) => e && e.id === 'dsh-relay');

        if (insertBlock) {
          const row = insertBlock.insert.find((r) => r && r.id === 'dsh-relay');
          ok('含 dsh-relay 条目（insert 结构，会被真正加载）');
          const cfg = row.config;
          if (cfg && typeof cfg === 'object') {
            info(`config = ${JSON.stringify(cfg)}`);
            const expect = ['enabled', 'listenHost', 'listenPort', 'password', 'forceLoopback'];
            const missingKeys = expect.filter((k) => !(k in cfg));
            if (missingKeys.length > 0) info(`未显式给出的键（走 schema 默认）：${missingKeys.join(', ')}`);
          } else {
            info('条目没有 config 段：全部字段走 schema 默认值（允许）');
          }
          if (bareRow) {
            bad('同时存在裸条目（- id: dsh-relay 不带 insert）：dsh 会静默丢弃它，只会造成困惑');
            out('      → node plugin/tools/clean-relay-rows.mjs "' + profileDir + '"');
          }
        } else if (bareRow) {
          bad('条目缺少 insert: 包裹 → dsh 当成「修改已有条目」，找不到目标就静默丢弃，插件不会被加载');
          out('      → node plugin/tools/set-relay-row.mjs "' + profileDir + '"');
          out('      → node plugin/tools/clean-relay-rows.mjs "' + profileDir + '"');
        } else {
          bad('数组里没有 dsh-relay 条目 → 插件不会被加载');
          out('      → node plugin/tools/set-relay-row.mjs "' + profileDir + '"');
        }
      }
    } catch (err) {
      bad(`YAML 解析失败：${String(err.message).split('\n')[0]}`);
      if (hasPlaceholder && hasOtherEntry) {
        out('      → 文件里同时有 [] 占位和 - 条目（两个顶层文档）');
        out('      → node plugin/tools/repair-patch-array.mjs "' + patchFile + '"');
      }
    }
  } else {
    info('（本机无 js-yaml，仅文本校验）');
    if (hasRowText) ok('文本上存在 dsh-relay 条目');
    else bad('文本上没有 dsh-relay 条目');
    if (hasPlaceholder && hasOtherEntry) bad('同时存在 [] 占位与 - 条目：YAML 顶层会是两个文档，需要修');
  }
}

// ── 3. schemastery（设置页表单的必要条件）──
head('3. schemastery 版本（决定设置页是否显示表单字段）');
if (!profileReq) {
  info('无法用 profile 锚点解析，跳过');
} else {
  let dir = null;
  for (const sp of (profileReq.resolve.paths('@deepseek-ai/schemastery') || [])) {
    const p = path.join(sp, '@deepseek-ai/schemastery', 'package.json');
    if (fs.existsSync(p)) { dir = path.dirname(p); break; }
  }
  if (!dir) {
    bad('解析不到 @deepseek-ai/schemastery → 插件会降级为「无表单」');
  } else {
    const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    const entry = fs.existsSync(path.join(dir, 'lib', 'index.mjs'))
      ? path.join(dir, 'lib', 'index.mjs')
      : path.join(dir, 'lib', 'index.cjs');
    const hasVolatile = fs.readFileSync(entry, 'utf8').includes('volatile');
    if (hasVolatile) ok(`${version}（支持 .volatile()，设置页会有表单）`);
    else {
      bad(`${version} 不支持 .volatile() → 设置页可能不显示表单字段`);
      out('      → 把插件装到 profile 本地 node_modules（install.ps1 就是这么做的）');
    }
    info(`来源：${dir}`);
  }
}

// ── 4. 宿主可选依赖 ──
head('4. 宿主可选依赖（缺失均自动降级，不算阻断）');
if (profileReq) {
  for (const n of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-settings']) {
    let found = false;
    for (const sp of (profileReq.resolve.paths(n) || [])) {
      if (fs.existsSync(path.join(sp, n, 'package.json'))) { found = true; break; }
    }
    if (found) ok(n);
    else info(`${n} 解析不到（对应功能跳过）`);
  }
}

// ── 5. 真实 import（端到端装载检查）──
head('5. 插件能否真正 import（含 Config 构造）');
if (fs.existsSync(path.join(pluginDir, 'lib', 'index.js'))) {
  try {
    const mod = await import(pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href);
    ok(`import 成功：name=${mod.name} inject=${JSON.stringify(mod.inject)}`);
    if (typeof mod.Config === 'function') {
      try {
        const cfg = mod.Config({});
        const keys = Object.keys(cfg);
        ok(`Config 构造成功，字段：${keys.join(', ')}`);
      } catch (err) {
        bad(`Config 构造抛错：${err.message}`);
      }
    } else {
      bad('没有导出 Config → 设置页不会有表单');
    }
  } catch (err) {
    bad(`import 失败：${String(err.message).split('\n')[0]}`);
  }
} else {
  info('插件未安装，跳过');
}

// ── 5b. 自动会话（autoSession）可用性 ──
//
// 这是最容易「静默失效」的一环：开关在 UI 上开着，但因为读不到 dsh 的会话密钥，
// 实际并不会代签，用户仍然会撞上 dsh 的 authentication required，而日志里
// 只有一行 warn。所以单独成一节，直接把「能不能用」摆在明面上。
head('5b. 自动会话（autoSession）可用性');
if (fs.existsSync(path.join(pluginDir, 'lib', 'dsh-cookie.js'))) {
  const home = HOME;
  const credFile = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(credFile)) {
    bad(`读不到凭据文件：${credFile} → 自动进入不可用（仍需 dsh 打印的 ?token=）`);
  } else {
    try {
      const { createSessionSigner } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'dsh-cookie.js')).href);
      const signer = createSessionSigner({ credentialsFile: credFile, log: () => {} });
      const st = signer.status();
      if (st.ready) {
        ok('读到了 dsh 的签名密钥（自动进入可用）');
        info(`凭据文件：${credFile}`);
        info(`Cookie 有效期：${Math.round(st.maxAgeMs / 86400000)} 天（与 dsh 一致）`);
        // 往返自检：签一个再用复刻的 dsh 解码逻辑解回来，确认格式没跑偏
        const name = signer.checkout('127.0.0.1:1', undefined);
        if (name && name.injected === true) ok('代签往返自检通过（签得出、格式正确）');
        else info(`代签自检未通过：${name && name.reason}`);
      } else {
        bad(`读不到密钥：${st.lastError} → 自动进入不可用`);
        out('      → 检查该文件里是否有 client-connection/browser-session 记录及其 payload.secret');
      }
    } catch (err) {
      bad(`加载 dsh-cookie.js 失败：${String(err.message).split('\n')[0]}`);
    }
  }
} else {
  info('插件副本里没有 lib/dsh-cookie.js → 跑着的是不支持自动会话的旧版');
  out('      → 重新运行 plugin\\install.ps1 并完全重启 dsh');
}

// ── 6. 运行中的 dsh 进程 ──
head('6. 运行中的 dsh 进程');
out('  （插件在启动时组装；进程早于安装时间就不会加载本插件，必须完全重启）');
try {
  const { execSync } = await import('node:child_process');
  const raw = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like \'%DeepSeek%\'\\" | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress"',
    { encoding: 'utf8', timeout: 15000 },
  ).trim();
  let list = [];
  try { list = JSON.parse(raw); } catch { list = []; }
  if (!Array.isArray(list)) list = list ? [list] : [];
  if (list.length === 0) info('没有检测到 dsh 进程');
  else {
    for (const p of list) {
      const t = String(p.CreationDate || '');
      // CIM 的日期形如 /Date(1712345678901)/ 或 ISO
      const m = /\/Date\((\d+)\)\//.exec(t);
      const when = m ? new Date(Number(m[1])) : (t ? new Date(t) : null);
      info(`PID ${p.ProcessId}  启动 ${when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : t}`);
    }
    out('  → 若这些进程的启动时间早于插件安装时间，请完全退出 dsh（含托盘）再打开');
  }
} catch {
  info('（无法枚举进程，跳过）');
}

// ── 结论 ──
head('结论');
if (problems.length === 0) {
  out('  未发现阻断项。');
  out('  若 UI 里仍看不到卡片，最可能的原因是：当前 dsh 是在插件安装之前启动的。');
  out('  完全退出 DeepSeek Harness（含系统托盘）再重新打开即可。');
} else {
  out(`  发现 ${problems.length} 个阻断项：`);
  for (const p of problems) out(`    - ${p}`);
  out();
  out('  这些必须先处理，否则 dsh 加载不到本插件，设置页永远不会有卡片。');
}
process.exitCode = problems.length === 0 ? 0 : 1;
