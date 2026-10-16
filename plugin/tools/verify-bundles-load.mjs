#!/usr/bin/env node
/**
 * verify-bundles-load.mjs — 纯文件操作，验证 bundles 机制下插件能被组进树
 *
 * 为什么用脚本：要写 YAML/JSON 到临时目录，shell 里写会被 PowerShell 吞引号
 * 并加 BOM。全部用 node 的 fs 完成。
 *
 * 它做的事：
 *   1. 建临时 DSH_HOME（web profile，bundles 里含 dsh-relay）
 *   2. 链共享 node_modules 供解析 dsh 自身模块
 *   3. 装插件到 profile 本地 node_modules
 *   4. 先跑 dump-config，确认组合树含 dsh-relay
 *   5. 再真实启动 dsh web，确认插件日志
 *   6. 清理
 *
 * 用法：node plugin/tools/verify-bundles-load.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const PLUGIN_SRC = path.resolve(import.meta.dirname, '..', 'dsh-relay');
const REAL_SHARED = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules');
const tmp = path.join(os.tmpdir(), `dsh-bundles-${Date.now()}`);
const webDir = path.join(tmp, 'profiles', 'web');

const say = (s = '') => console.log(s);
const head = (t) => { say(); say(`── ${t} ──`); };

function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  head('搭建临时环境（bundles 路径）');
  say(`  ${tmp}`);

  w(path.join(webDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-relay'] } },
  }, null, 2)}\n`);
  w(path.join(webDir, 'cordis.yml'), '[]\n');
  w(path.join(webDir, 'cordis.patch.yml'), '[]\n');
  w(path.join(tmp, '.credentials.yaml'), 'version: "1"\nrefs: {}\nrecords: {}\n');

  // 插件到 profile 本地
  const dst = path.join(webDir, 'node_modules', 'dsh-relay');
  fs.mkdirSync(path.join(dst, 'lib'), { recursive: true });
  for (const f of ['package.json', 'cordis.patch.yml']) fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(dst, f));
  for (const f of fs.readdirSync(path.join(PLUGIN_SRC, 'lib'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(PLUGIN_SRC, 'lib', f), path.join(dst, 'lib', f));
  }
  say('  插件已装到 profile 本地 node_modules');

  // 共享回退链接（dsh 自身模块）
  const fb = path.join(tmp, 'profiles', 'node_modules');
  const linkRes = spawnSync('cmd', ['/c', 'mklink', '/J', fb, REAL_SHARED], { stdio: 'pipe' });
  say(`  共享回退链接：${linkRes.status === 0 ? 'OK' : '失败（dsh 会自愈）'}`);

  const env = { ...process.env, DSH_HOME: tmp };

  // dump-config
  head('dump-config：组合树是否含 dsh-relay');
  const dump = spawnSync('dsh', ['--profile', 'web', '--dump-config'], { env, encoding: 'utf8', shell: true, timeout: 180000 });
  const stdout = dump.stdout || '';
  const stderr = dump.stderr || '';
  say(`  退出码 ${dump.status}`);
  const hit = /dsh-relay/.test(stdout);
  if (hit) {
    say('  ✓ 组合树含 dsh-relay');
    const ls = stdout.split('\n');
    const i = ls.findIndex((l) => /dsh-relay/.test(l));
    for (const l of ls.slice(Math.max(0, i - 2), i + 5)) say(`    ${l}`);
  } else {
    say('  ✗ 不含');
    if (stderr.trim()) {
      say('  stderr：');
      for (const l of stderr.split('\n').slice(0, 8)) say(`    ${l}`);
    }
  }

  // 真实启动
  head('真实启动 dsh web');
  const outFile = path.join(tmp, 'boot.out.log');
  const errFile = path.join(tmp, 'boot.err.log');
  const out = fs.openSync(outFile, 'w');
  const err = fs.openSync(errFile, 'w');
  const { spawn } = await import('node:child_process');
  const child = spawn('dsh', ['web', '--no-open'], { env, stdio: ['ignore', out, err], shell: true, windowsHide: true });

  let listening = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -EA SilentlyContinue | Where-Object {$_.LocalPort -in 3080,3091} | Select-Object -ExpandProperty LocalPort) -join ','"],
      { encoding: 'utf8', timeout: 15000 });
    if (/3080/.test(r.stdout || '')) { listening = true; break; }
  }
  say(`  3080 监听：${listening ? '是' : '否'}`);

  const outText = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  const errText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';

  head('插件日志');
  const relayLogs = outText.split('\n').filter((l) => /dsh-relay/.test(l));
  if (relayLogs.length) for (const l of relayLogs) say(`  ${l.trim()}`);
  else say('  （无 dsh-relay 日志）');

  const ports = spawnSync('powershell', ['-NoProfile', '-Command',
    "(Get-NetTCPConnection -State Listen -EA SilentlyContinue | Where-Object {$_.LocalPort -in 3080,3091} | Select-Object -ExpandProperty LocalPort) -join ','"],
    { encoding: 'utf8', timeout: 15000 });
  say(`  监听端口：${String(ports.stdout || '').trim() || '(无)'}`);

  if (errText.trim()) {
    head('stderr（前 10 行）');
    for (const l of errText.split('\n').slice(0, 10)) say(`  ${l}`);
  }

  // 清理
  head('清理');
  try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  await sleep(2000);
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  spawnSync('cmd', ['/c', `for /f "tokens=5" %a in ('netstat -ano ^| findstr :3091 ^| findstr LISTENING') do taskkill /F /PID %a`], { stdio: 'pipe' });
  if (fs.existsSync(fb)) { try { fs.unlinkSync(fb); } catch { /* junction */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力 */ }
  say('  已清理');

  const pass = hit && relayLogs.length > 0;
  head('结论');
  say(pass ? '  ✓ bundles 路径下插件成功加载（与 MiMo 同机制）' : '  ✗ 未成功');
  return pass ? 0 : 1;
}

process.exitCode = await main();
