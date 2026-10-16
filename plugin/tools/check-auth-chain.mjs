#!/usr/bin/env node
/**
 * check-auth-chain.mjs — 只读诊断「dsh web authentication required」链路
 *
 * dsh 的浏览器认证是一次性 token 交换，中转插件曾经把这一步吃掉，
 * 导致用户输多少次口令都进不去。本脚本逐项确认链路是否通畅：
 *
 *   1. dsh 宿主端口在监听吗
 *   2. 中转端口在监听吗
 *   3. 中转是否放行不带 cookie 的 `GET /?token=...`
 *      —— 若返回插件自己的登录页或 401，说明跑的还是修复前的代码
 *   4. 中转插件版本 / 文件是否含修复
 *   5. 给出下一步动作
 *
 * 用法：node check-auth-chain.mjs [relayPort] [dshPort]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const relayPort = Number(process.argv[2] ?? 3091);
const dshPort = Number(process.argv[3] ?? 19387);
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileName = process.env.DSH_PROFILE || 'desktop';
const pluginDir = path.join(HOME, 'profiles', profileName, 'node_modules', 'dsh-public-relay');

const problems = [];
const say = (s = '') => console.log(s);
const head = (t) => { say(); say(`── ${t} ──`); };

function get(port, pathname, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: pathname,
      headers: { connection: 'close', ...headers }, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err.code || err.message }));
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// ── 1. 端口 ──
head('1. 监听端口');
const dshRoot = await get(dshPort, '/');
if (dshRoot.status === 0) {
  say(`  ✗ dsh 宿主 ${dshPort} 无响应（${dshRoot.error}）`);
  problems.push(`dsh 宿主 ${dshPort} 未监听`);
} else {
  say(`  ✓ dsh 宿主 ${dshPort} 有响应（HTTP ${dshRoot.status}）`);
  if (dshRoot.status === 401) say('      → 401 是 dsh 自己的认证，正常（未带它的 cookie 时）');
}

const relayRoot = await get(relayPort, '/');
if (relayRoot.status === 0) {
  say(`  · 中转 ${relayPort} 无响应（${relayRoot.error}）—— 如果没启用中转，这是正常的`);
} else {
  say(`  ✓ 中转 ${relayPort} 有响应（HTTP ${relayRoot.status}）`);
}

// ── 2. 关键：中转是否放行 token 交换 ──
head('2. 中转是否放行 dsh 的 ?token= 交换（核心检查）');
if (relayRoot.status === 0) {
  say('  · 中转未运行，跳过');
} else {
  const swap = await get(relayPort, '/?token=PROBE_TOKEN_DOES_NOT_MATTER');
  const body = swap.body || '';
  const isOwnLoginPage = body.includes('dsh-public-relay 访问口令');
  const isOwn401 = swap.status === 401 && body.includes('dsh-public-relay');

  if (swap.status === 0) {
    say(`  ✗ 请求失败：${swap.error}`);
    problems.push('中转对 ?token= 请求无响应');
  } else if (isOwnLoginPage || isOwn401) {
    say(`  ✗ 中转把 ?token= 请求拦下了（HTTP ${swap.status}，正文来自本插件）`);
    say('      这就是「输了口令仍然 authentication required」的直接原因：');
    say('      dsh 的一次性启动令牌到不了上游，它的会话 Cookie 一签不出来。');
    say('');
    say('      最可能：运行中的 dsh 是在修复部署**之前**启动的，内存里还是旧代码。');
    say('      处理：完全退出 dsh（含系统托盘）再打开。');
    problems.push('中转拦截了 dsh 的启动令牌交换（需重启 dsh 加载修复）');
  } else {
    say(`  ✓ 中转放行了该请求（HTTP ${swap.status}），上游的响应被透传`);
    if (swap.status === 302) say('      → 302 表示 dsh 接受并签发了会话 Cookie（链路通畅）');
    else if (swap.status === 401) say('      → 401 来自上游 dsh（token 已过期或非法，属正常）');
  }
}

// ── 3. 插件文件是否含修复 ──
head('3. 已部署插件是否含修复');
if (!fs.existsSync(pluginDir)) {
  say(`  · 未找到 ${pluginDir}`);
} else {
  const relayFile = path.join(pluginDir, 'lib', 'relay.js');
  if (!fs.existsSync(relayFile)) {
    say('  ✗ lib/relay.js 缺失');
  } else {
    const src = fs.readFileSync(relayFile, 'utf8');
    const hasFix = src.includes('isDshTokenExchange') && src.includes('forwardTokenExchange');
    const mtime = fs.statSync(relayFile).mtime.toLocaleString();
    say(`  ${hasFix ? '✓' : '✗'} 含令牌交换放行逻辑（文件时间 ${mtime}）`);
    if (!hasFix) {
      say('      → 重新运行 plugin\\install.ps1 部署修复');
      problems.push('部署的插件不含修复');
    }
  }
}

// ── 5. 写操作能否通过（403 修复检查）──
head('5. 写操作是否可用（点「停用」返回 403 的修复检查）');
if (dshRoot.status === 0) {
  say(`  · dsh 宿主 ${dshPort} 无响应，跳过`);
} else {
  /** 只读探测：用 action=status，不会真的切换状态。 */
  const probeWrite = async (origin) => {
    const headers = { 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    return new Promise((resolve) => {
      const body = JSON.stringify({ action: 'status' });
      const req = http.request({
        host: '127.0.0.1', port: dshPort, method: 'POST', path: '/dsh-public-relay/control',
        headers: { ...headers, 'content-length': Buffer.byteLength(body), connection: 'close' },
        agent: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', (err) => resolve({ status: 0, error: err.code || err.message }));
      req.setTimeout(6000, () => req.destroy(new Error('timeout')));
      req.write(body);
      req.end();
    });
  };

  const withElectronOrigin = await probeWrite('dsh-app://app');
  const withNoOrigin = await probeWrite(null);

  // 新代码在 403 时带 detail 字段；旧代码不带 —— 用它判断是否已加载修复
  const hasDetailField = (r) => typeof r.body === 'string' && r.body.includes('"detail"');

  if (withElectronOrigin.status === 200) {
    say('  ✓ Electron 形态的写请求放行（200）—— 修复已生效');
  } else if (withElectronOrigin.status === 403) {
    say(`  ✗ Electron 形态的写请求被拒（403）`);
    if (hasDetailField(withElectronOrigin)) {
      say('      响应里带 detail → 修复代码已加载，但仍判为不可信。');
      say(`      ${withElectronOrigin.body.slice(0, 160)}`);
      problems.push('写操作被 403（修复已加载但判据仍拒绝，需进一步排查）');
    } else {
      say('      响应里没有 detail 字段 → 跑的还是**修复前**的代码。');
      say('      处理：完全退出 dsh（含系统托盘）再打开。');
      problems.push('写操作 403：运行的 dsh 仍是修复前的代码（需重启）');
    }
  } else {
    say(`  ? 写探测返回 HTTP ${withElectronOrigin.status}（${withElectronOrigin.error || ''}）`);
  }

  if (withNoOrigin.status === 200) {
    say('  ✓ 无 Origin 的 POST 也放行（与 dsh 自身策略一致）');
  }
}

// ── 6. 两层认证的正确顺序 ──
head('6. 两层认证的预期顺序（确认你的用法）');
say('  第一次进入必须用 dsh 打印的那个带 ?token= 的 URL：');
say(`    http://<你对外用的地址>:${relayPort}/?token=<dsh 打印的一长串>`);
say('  顺序：');
say('    ① 该请求 → 中转放行（不要求口令）→ dsh 校验 token');
say('    ② dsh 下发自己的 dsh-auth-* Cookie 并 302 到 ./');
say('    ③ 浏览器再访问 / → 中转要求它的口令 → 登录一次（7 天有效）');
say('    ④ 之后放行给 dsh，dsh 已有自己的 Cookie → 正常会话');
say('');
say('  注意：dsh 的 launchToken 每个进程只生成一次、用完即弃。');
say('        若没拿到就重启了，就再重启一次 dsh 取新 URL。');

// ── 结论 ──
head('结论');
if (problems.length === 0) {
  say('  未发现链路问题。');
  say('  若仍看到 authentication required，请确认你是用 dsh 打印的那个带 ?token= 的 URL 首次进入。');
} else {
  say(`  发现 ${problems.length} 个问题：`);
  for (const p of problems) say(`    - ${p}`);
}
process.exitCode = problems.length === 0 ? 0 : 1;
