#!/usr/bin/env node
/**
 * verify-password-modes.mjs — 验证独立脚本的「访问口令」四种输入模式
 *
 * 背景：本仓库是公开的，所以脚本里**不能**留硬编码默认口令。默认行为改成
 * 「启动时随机生成并打印」。这个测试锁住四种模式的语义：
 *
 *   A. 什么都不给              → 随机生成（并打印）
 *   B. DSH_RELAY_PASSWORD=''   → 不生成（用户显式要求关闭认证）
 *   C. --password ''           → 不生成（同上）
 *   D. --password <值>         → 用给定值
 *
 * 用 Node 的子进程与 stdout 抓取来做，避免被外层终端代码页干扰。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// plugin/tests/ → 仓库根是上两级
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dsh-public-relay.js');

/** 起一次脚本，抓 stdout 前若干字节后杀掉。 */
function runOnce({ env = {}, args = [] } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      script, '--no-watchdog', '--port', '0', '--target', 'http://127.0.0.1:9', ...args,
    ], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    const done = () => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    };
    const timer = setTimeout(() => { done(); resolve(out); }, 1800);
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
    child.on('error', () => { clearTimeout(timer); resolve(out); });
  });
}

const cases = [
  { label: 'A 什么都不给 → 随机生成', opts: {}, expectGenerated: true },
  { label: "B DSH_RELAY_PASSWORD='' → 不生成", opts: { env: { DSH_RELAY_PASSWORD: '' } }, expectGenerated: false },
  { label: "C --password '' → 不生成", opts: { args: ['--password', ''] }, expectGenerated: false },
  { label: 'D --password 固定值 → 不生成', opts: { args: ['--password', 'fixed-pw'] }, expectGenerated: false },
];

let failed = 0;
for (const { label, opts, expectGenerated } of cases) {
  const out = await runOnce(opts);
  const generated = /随机生成/.test(out) && /本次随机生成/.test(out);
  const ok = generated === expectGenerated;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}  (generated=${generated}, expected=${expectGenerated})`);
  if (!ok) {
    console.log(`      stdout 前 200 字：${out.slice(0, 200).replace(/\n/g, ' ⏎ ')}`);
  }
}

// 额外一条：随机生成的口令必须真的出现在启动摘要里，可被用户读到
{
  const out = await runOnce({});
  const m = /本次随机生成[^:：]*[:：]\s*(\S+)/.exec(out);
  const pw = m ? m[1] : '';
  const ok = pw.length >= 12;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} 生成的口令被打印且长度足够（len=${pw.length}）`);
}

console.log('');
if (failed === 0) {
  console.log('口令模式验证全部通过 ✅');
  process.exitCode = 0;
} else {
  console.error(`失败 ${failed} 项`);
  process.exitCode = 1;
}
