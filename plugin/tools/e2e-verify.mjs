#!/usr/bin/env node
/**
 * e2e-verify.mjs — 端到端验证：在干净环境里真实启动 dsh，确认插件被加载
 *
 * 为什么需要独立脚本：搭建临时环境要在 shell 里写 JSON/YAML，PowerShell 会
 * 吞掉嵌套引号、并给 Set-Content -Encoding UTF8 加上 BOM（BOM 会让 dsh 的
 * JSON.parse 直接失败：Unexpected token ''）。用 node 写文件才是可靠的。
 *
 * 它做的事：
 *   1. 在临时目录建一个最小 DSH_HOME（web profile + 干净 credentials）
 *   2. 按与 install.ps1 完全相同的方式装入本插件（profile 本地 + insert 条目）
 *   3. 先跑 dump-config 验证组合树真的含 dsh-public-relay
 *   4. 再真实启动 dsh web，等它 listen，然后请求插件路由
 *   5. 全程收集日志，最后清理
 *
 * 用法：node plugin/tools/e2e-verify.mjs
 * 退出码 0 = 插件在真实 dsh 里被成功加载
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const PLUGIN_SRC = path.resolve(import.meta.dirname, '..', 'dsh-public-relay');
const REAL_PROFILES = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'profiles',
);
const tmpRoot = path.join(os.tmpdir(), `dshrelay-e2e-${Date.now()}`);
const webDir = path.join(tmpRoot, 'profiles', 'web');

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const head = (t) => { say(); say(`── ${t} ──`); };

/** 写 UTF-8 且**绝不带 BOM** 的文件。 */
function writeNoBom(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function tryKill(pids, signal = 'SIGTERM') {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* 已退出 */ }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 起一个 dsh 子进程，返回 { child, out, err }。 */
function bootDsh(args, env) {
  const outFile = path.join(tmpRoot, `boot-${Date.now()}.out.log`);
  const errFile = outFile.replace('.out.', '.err.');
  const out = fs.openSync(outFile, 'w');
  const err = fs.openSync(errFile, 'w');
  const child = spawn('dsh', args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', out, err],
    shell: true,
    windowsHide: true,
    detached: false,
  });
  return { child, outFile, errFile };
}

async function main() {
  head('搭建临时 DSH_HOME（不碰用户数据）');
  say(`  ${tmpRoot}`);

  // 1. 最小 profile
  writeNoBom(path.join(webDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2)}\n`);

  writeNoBom(path.join(webDir, 'cordis.yml'), '[]\n');
  writeNoBom(path.join(webDir, 'cordis.patch.yml'), '[]\n');

  // 干净的 credentials：version 用字符串（npm CLI 的严格解析要求）
  writeNoBom(path.join(tmpRoot, '.credentials.yaml'), 'version: "1"\nrefs: {}\nrecords: {}\n');

  // 2. 装插件（与 install.ps1 相同方式）
  const dst = path.join(webDir, 'node_modules', 'dsh-public-relay');
  fs.mkdirSync(path.join(dst, 'lib'), { recursive: true });
  for (const f of ['package.json', 'cordis.patch.yml']) {
    fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(dst, f));
  }
  for (const f of fs.readdirSync(path.join(PLUGIN_SRC, 'lib'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(PLUGIN_SRC, 'lib', f), path.join(dst, 'lib', f));
  }
  say(`  已装插件到 ${path.relative(tmpRoot, dst)}`);

  // 3. 共享模块回退（dsh 会自愈建立；这里直接链到真实目录以便离线跑）
  const fb = path.join(tmpRoot, 'profiles', 'node_modules');
  if (!fs.existsSync(fb)) {
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', fb, REAL_PROFILES.replace(/\\profiles$/, '\\profiles\\node_modules')], { stdio: 'pipe' });
    say(`  共享回退链接：${r.status === 0 ? 'OK' : 'FAILED（将依赖 dsh 自愈）'}`);
  }

  // 4. 写 insert 条目（复用正式工具）
  for (const tool of ['set-relay-row.mjs', 'clean-relay-rows.mjs']) {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, tool), webDir], { encoding: 'utf8' });
    for (const l of String(r.stdout || '').trim().split('\n')) say(`  ${l}`);
    if (r.status !== 0) say(`  ${tool} 退出码 ${r.status}`);
  }

  const env = { DSH_HOME: tmpRoot };

  // 5. dump-config：组合树必须含 dsh-public-relay
  head('dump-config 组合树检查');
  const dump = spawnSync('dsh', ['--profile', 'web', '--dump-config'], { env: { ...process.env, ...env }, encoding: 'utf8', shell: true, timeout: 120000 });
  const dumpText = `${dump.stdout || ''}${dump.stderr || ''}`;
  const inTree = /dsh-public-relay/.test(dump.stdout || '');
  say(`  退出码 ${dump.status}`);
  if (!inTree) {
    say('  ✗ 组合树不含 dsh-public-relay；dump 输出尾部：');
    for (const l of dumpText.split('\n').slice(-12)) say(`    ${l}`);
    return 1;
  }
  say('  ✓ 组合树含 dsh-public-relay');
  const around = (dump.stdout || '').split('\n');
  const idx = around.findIndex((l) => /dsh-public-relay/.test(l));
  if (idx >= 0) for (const l of around.slice(Math.max(0, idx - 1), idx + 8)) say(`    ${l}`);

  // 6. 真实启动 dsh web
  head('真实启动 dsh web');
  const boot = bootDsh(['web', '--no-open'], env);
  const pids = [boot.child.pid];

  // 等 listen（最多 60s）
  let listening = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const net = spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-NetTCPConnection -State Listen -EA SilentlyContinue | Where-Object { $_.LocalPort -in 3080,3091 } | Select-Object -ExpandProperty LocalPort"],
      { encoding: 'utf8', timeout: 15000 });
    if (/3080/.test(net.stdout || '')) { listening = true; break; }
  }
  say(`  3080 监听：${listening ? '是' : '否'}`);

  const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const outText = readLog(boot.outFile);
  const errText = readLog(boot.errFile);

  head('插件加载证据');
  const relayLogs = outText.split('\n').filter((l) => /dsh-public-relay/.test(l));
  if (relayLogs.length > 0) {
    for (const l of relayLogs) say(`  ${l.trim()}`);
  } else {
    say('  日志里没有 dsh-public-relay 行');
  }

  // 7. 请求插件路由（最能证明宿主半真的挂上了）
  head('宿主半路由探测');
  const probe = spawnSync('powershell', ['-NoProfile', '-Command',
    "try { $r = Invoke-WebRequest 'http://127.0.0.1:3091/dsh-public-relay/status' -UseBasicParsing -TimeoutSec 6; \"$($r.StatusCode) $($r.Content)\" } catch { 'ERR ' + $_.Exception.Message }"],
    { encoding: 'utf8', timeout: 20000 });
  say(`  ${String(probe.stdout || '').trim().slice(0, 400)}`);

  if (errText.trim()) {
    head('stderr（前 12 行）');
    for (const l of errText.split('\n').slice(0, 12)) say(`  ${l}`);
  }

  // 8. 清理
  head('清理');
  tryKill(pids);
  await sleep(2000);
  tryKill(pids, 'SIGKILL');
  await sleep(500);
  // 删掉共享链接避免递归删除
  if (fs.existsSync(fb)) {
    try { fs.unlinkSync(fb); } catch { /* cmd 建的 junction，unlink 可能失败 */ }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  say(`  已停止进程并删除 ${tmpRoot}`);

  const pass = inTree && (relayLogs.length > 0 || /200/.test(probe.stdout || ''));
  head('结论');
  say(pass ? '  ✓ 插件在真实 dsh 中被成功加载' : '  ✗ 未能证明插件被加载（见上方输出）');
  return pass ? 0 : 1;
}

process.exitCode = await main();
