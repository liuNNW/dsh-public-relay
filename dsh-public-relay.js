#!/usr/bin/env node
/**
 * dsh-public-relay.js — DSH Web 中转脚本 + dsh web 守护进程（配合樱花映射 TCP 内网穿透）
 *
 * 用法：
 *   node dsh-public-relay.js [--port <port>] [--no-watchdog] [--no-force-loopback] [--help]
 *
 * 功能：
 *   1. 启动 dsh web 子进程并守护（崩溃自动重启，日志写入 dsh-web.log）
 *   2. 启动 HTTP 反向代理（Host/Origin 改写放行信任栅栏 + WebSocket upgrade）
 *   3. 默认 --force-loopback（公网可看插件列表）；口令留空时启动即随机生成并打印
 *
 * 零第三方依赖，仅用 Node 内置模块。
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────── 参数解析 ───────────────────────────

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3081,
  target: 'http://127.0.0.1:3080',
};

const HELP = `
dsh-public-relay — DSH Web 中转脚本（樱花映射 TCP 内网穿透）

用法:
  node dsh-public-relay.js [选项]

功能:
  1. 启动 dsh web 子进程并守护（崩溃自动重启，日志写入 dsh-web.log）
  2. 启动 HTTP 反向代理中转（Host/Origin 改写 + WebSocket upgrade）

选项:
  --host <ip>          中转监听地址（默认 127.0.0.1）
  --port <port>        中转监听端口（默认 3081；樱花映射隧道「本地端口」填这个值）
  --target <url>       上游 dsh web 地址（默认 http://127.0.0.1:3080）
  --password <口令>    访问口令（默认留空 → 启动时随机生成并打印；传空字符串可完全关闭认证）
  --no-watchdog        不启动 dsh web 守护（只跑中转，dsh web 需手动启动）
  --no-force-loopback  关闭强制回环（默认开启，关闭后公网看不到插件列表）
  --help               显示本帮助

示例:
  node dsh-public-relay.js                        # 一键启动（守护 dsh web + 中转）
  node dsh-public-relay.js --port 9000            # 换个中转端口
  node dsh-public-relay.js --no-watchdog          # 只跑中转，不启动 dsh web
  node dsh-public-relay.js --password '其他口令'   # 换个口令
`;

function fail(msg) {
  console.error(`dsh-public-relay: ${msg}`);
  console.error(HELP);
  process.exit(1);
}

function parseArgs(argv) {
  const env = process.env;
  const cfg = {
    host: env.DSH_RELAY_HOST || DEFAULTS.host,
    port: env.DSH_RELAY_PORT || String(DEFAULTS.port),
    target: env.DSH_RELAY_TARGET || DEFAULTS.target,
    /**
     * 访问口令。
     *
     * 默认值刻意留空 → 首次启动时**自动生成一个随机口令并打印**。
     *
     * 为什么不再有硬编码默认口令：本仓库是公开的，任何写进源码的口令
     * 都等于「全世界都知道的口令」。而中转的典型场景正是把 dsh 暴露到
     * 公网 —— 一个已知口令等于没有口令。自动生成既保持了「装上就能用」，
     * 又不把安全性赌在用户会去改它上面。
     */
    password: env.DSH_RELAY_PASSWORD || '',
    forceLoopback: true,                      // 默认开启
    watchdog: true,                           // 默认开启
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`缺少参数值: ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      case '--host':
        cfg.host = next();
        break;
      case '--port':
        cfg.port = next();
        break;
      case '--target':
        cfg.target = next();
        break;
      case '--password':
        cfg.password = next();
        break;
      case '--no-watchdog':
        cfg.watchdog = false;
        break;
      case '--force-loopback':
        cfg.forceLoopback = true;
        break;
      case '--no-force-loopback':
        cfg.forceLoopback = false;
        break;
      default:
        fail(`未知参数: ${a}`);
    }
  }
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port 必须是 0-65535 的整数，收到: ${JSON.stringify(cfg.port)}`);
  cfg.port = port;
  return cfg;
}

// ─────────────────────────── 上游目标 ───────────────────────────

function resolveTarget(raw) {
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    fail(`无法解析 --target: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:') fail(`--target 目前只支持 http://（收到 ${url.protocol}//），DSH web 是纯 HTTP 服务`);
  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // 去掉 IPv6 方括号
  const port = url.port ? Number(url.port) : 80;
  return {
    // 给上游 http.request 用的连接参数
    hostname,
    port,
    // 改写 Host / Origin 用的权威（URL.host 会规范化，IPv6 带方括号、默认端口省略）
    authority: url.host,
    origin: `${url.protocol}//${url.host}`,
  };
}

// ─────────────────────────── 头部改写 ───────────────────────────

// hop-by-hop 头：逐跳语义，不能透传；upgrade 场景单独保留 connection/upgrade
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function rewriteHeaders(headers, forUpgrade, target) {
  const h = { ...headers };
  h.host = target.authority;                     // 栅栏要求 Host 是回环权威
  if (h.origin) h.origin = target.origin;        // 栅栏要求 Origin == Host 权威
  for (const k of HOP_BY_HOP) delete h[k];
  if (forUpgrade) {
    h.connection = 'Upgrade';
    h.upgrade = h.upgrade || 'websocket';
  }
  return h;
}

function stripHopByHop(headers) {
  const h = { ...headers };
  for (const k of HOP_BY_HOP) delete h[k];
  return h;
}

function serializeHeaders(headers) {
  let out = '';
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    for (const val of Array.isArray(v) ? v : [v]) out += `${k}: ${val}\r\n`;
  }
  return out;
}

// ─────────────────────────── 可选口令认证 ───────────────────────────

function makeAuth(password) {
  const secret = crypto.createHmac('sha256', 'dsh-public-relay').update(password).digest();
  const cookieName = 'relay_session';
  const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

  function signToken(exp) {
    const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  function verifyToken(token) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return typeof exp === 'number' && exp > Date.now();
    } catch {
      return false;
    }
  }

  function parseCookies(req) {
    const out = {};
    const raw = req.headers.cookie;
    if (!raw) return out;
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      try {
        const k = decodeURIComponent(part.slice(0, eq).trim());
        const v = decodeURIComponent(part.slice(eq + 1).trim());
        out[k] = v;
      } catch {
        /* 忽略非法 cookie */
      }
    }
    return out;
  }

  const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-public-relay 登录</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f1115;color:#e6e6e6;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1d24;border:1px solid #2c313c;border-radius:12px;padding:32px;width:320px}
  h1{font-size:18px;margin:0 0 4px} p{color:#9aa3b2;font-size:13px;margin:0 0 20px}
  input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #3a4150;
        background:#12141a;color:#e6e6e6;font-size:14px}
  button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#3b82f6;
         color:#fff;font-size:14px;cursor:pointer}
  button:hover{background:#2f6fe0}
  .err{color:#f87171;font-size:13px;margin-top:10px}
</style>
</head>
<body>
  <form class="card" method="post" action="/__login">
    <h1>dsh-public-relay 访问口令</h1>
    <p>请输入启动时设置的口令以继续</p>
    <input type="password" name="password" placeholder="口令" autocomplete="off" autofocus required>
    <button type="submit">进入</button>
    ${'__ERR__'}
  </form>
</body>
</html>`;

  return { cookieName, signToken, verifyToken, parseCookies, LOGIN_PAGE, COOKIE_TTL_MS };
}

// ─────────────────────────── 主逻辑 ───────────────────────────

const config = parseArgs(process.argv.slice(2));

/**
 * 没给口令时自动生成一个，而不是回落到某个写死在源码里的默认值 ——
 * 本仓库是公开的，任何硬编码口令都等于「全世界都知道的口令」，而本工具的
 * 典型场景正是把 dsh 暴露到公网。生成后打印到控制台，用户按提示保存复用。
 *
 * 「显式要求关闭认证」有两处入口，都尊重用户意图、不生成口令：
 *   · `--password ''`（命令行显式传空）
 *   · `DSH_RELAY_PASSWORD=''`（环境变量显式传空）
 * 两者都意味着用户清楚自己在做什么（仅限本机 / 受信网络）。
 */
const passwordGivenExplicitly =
  process.argv.includes('--password') || Object.hasOwn(process.env, 'DSH_RELAY_PASSWORD');
let generatedPassword = null;
if (config.password === '' && !passwordGivenExplicitly) {
  generatedPassword = crypto.randomBytes(12).toString('base64url');
  config.password = generatedPassword;
}

const TARGET = resolveTarget(config.target);
const AUTH = config.password ? makeAuth(config.password) : null;
const UPSTREAM = { hostname: TARGET.hostname, port: TARGET.port };

function log(method, path, status, remote, ms) {
  console.log(`[${new Date().toISOString()}] ${method} ${path} ${status} ${remote || '?'} ${ms}ms`);
}

// ─────────────────────────── dsh web 守护进程（诊断增强版）───────────────────────────

let dshProcess = null;      // 当前 dsh web 子进程
let dshPid = null;           // 进程组 PID（detached 模式下用于杀整棵树）
let watchdogLog = null;      // 日志文件流
let restartTimer = null;
let restartCount = 0;
const WATCHDOG_LOG_FILE = path.join(__dirname, 'dsh-web.log');
const RESTART_DELAY_MS = 5000;
const RAPID_CRASH_THRESHOLD = 3;
const RAPID_CRASH_WINDOW_MS = 30000;
const rapidCrashes = [];    // 最近崩溃时间戳

// 诊断：跟踪每次 dsh web 的输出情况
let dshStartTime = null;
let dshStdoutLines = 0;
let dshStderrLines = 0;
let dshLastStdout = '';
let dshLastStderr = '';

function watchdogLogLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { if (watchdogLog) watchdogLog.write(line + '\n'); } catch {}
}

function isRapidCrash() {
  const now = Date.now();
  rapidCrashes.push(now);
  while (rapidCrashes.length && now - rapidCrashes[0] > RAPID_CRASH_WINDOW_MS) rapidCrashes.shift();
  return rapidCrashes.length >= RAPID_CRASH_THRESHOLD;
}

// 检查 dsh 自己的日志目录（$DSH_HOME 或 ~/.dsh）
function checkDshLogs() {
  try {
    const os = require('node:os');
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const logDir = path.join(dshHome, 'logs');
    if (!fs.existsSync(logDir)) {
      watchdogLogLine(`  dsh 日志目录不存在: ${logDir}`);
      return;
    }
    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .sort()
      .slice(-3); // 最新的 3 个
    if (files.length === 0) {
      watchdogLogLine(`  dsh 日志目录为空: ${logDir}`);
      return;
    }
    watchdogLogLine(`  dsh 日志目录: ${logDir}`);
    for (const f of files) {
      const fp = path.join(logDir, f);
      const stat = fs.statSync(fp);
      watchdogLogLine(`    ${f} (${(stat.size / 1024).toFixed(1)} KB, ${stat.mtime.toISOString()})`);
    }
  } catch (e) {
    watchdogLogLine(`  检查 dsh 日志失败: ${e.message}`);
  }
}

function startDshWeb() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  restartCount++;

  // 重置诊断计数器
  dshStartTime = Date.now();
  dshStdoutLines = 0;
  dshStderrLines = 0;
  dshLastStdout = '';
  dshLastStderr = '';

  watchdogLogLine(`═══ dsh web 启动（第 ${restartCount} 次）═══`);
  watchdogLogLine(`  命令: dsh web`);
  watchdogLogLine(`  工作目录: ${process.cwd()}`);
  watchdogLogLine(`  Node: ${process.version}`);
  watchdogLogLine(`  平台: ${process.platform} ${process.arch}`);

  // detached: true → 子进程独立于父进程（Windows 下父进程退出不会连带杀掉）
  // shell: true → Windows 需要通过 cmd.exe 找到 dsh.cmd
  dshProcess = spawn('dsh', ['web'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: true,
    windowsHide: true,
  });

  dshPid = dshProcess.pid;
  watchdogLogLine(`  PID: ${dshPid}`);

  dshProcess.stdout.on('data', (d) => {
    const lines = d.toString().trimEnd();
    for (const line of lines.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      dshStdoutLines++;
      dshLastStdout = trimmed;
      watchdogLogLine(`[dsh-web] ${trimmed}`);
    }
  });

  dshProcess.stderr.on('data', (d) => {
    const lines = d.toString().trimEnd();
    for (const line of lines.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      dshStderrLines++;
      dshLastStderr = trimmed;
      watchdogLogLine(`[dsh-web ERR] ${trimmed}`);
    }
  });

  dshProcess.on('exit', (code, signal) => {
    const uptimeSec = ((Date.now() - dshStartTime) / 1000).toFixed(1);
    dshProcess = null;
    dshPid = null;

    const reason = signal ? `signal=${signal}` : `exit code=${code}`;
    watchdogLogLine(`═══ dsh web 退出（${reason}）═══`);
    watchdogLogLine(`  存活时长: ${uptimeSec} 秒`);
    watchdogLogLine(`  stdout 行数: ${dshStdoutLines}`);
    watchdogLogLine(`  stderr 行数: ${dshStderrLines}`);
    if (dshLastStdout) watchdogLogLine(`  最后 stdout: ${dshLastStdout}`);
    if (dshLastStderr) watchdogLogLine(`  最后 stderr: ${dshLastStderr}`);

    // 静默崩溃检测：非正常退出 + 没有任何输出
    if (code !== 0 && code !== 130 && dshStdoutLines <= 1 && dshStderrLines === 0) {
      watchdogLogLine('');
      watchdogLogLine('  ⚠⚠⚠ 静默崩溃：dsh web 退出前没有任何错误输出 ⚠⚠⚠');
      watchdogLogLine('  可能原因:');
      watchdogLogLine('    1. Windows 杀毒软件拦截（检查 Windows Defender 历史记录）');
      watchdogLogLine('    2. Node.js 原生模块崩溃（不经过 JS 错误处理）');
      watchdogLogLine('    3. 系统内存不足（检查任务管理器）');
      watchdogLogLine('    4. dsh web 内部调用了 process.exit(1)');
      watchdogLogLine('  排查步骤:');
      watchdogLogLine('    a. 检查 Windows 事件查看器 → Windows 日志 → 应用程序');
      watchdogLogLine('    b. 在 CMD 中手动运行: dsh web > dsh-stdout.log 2>&1');
      watchdogLogLine('    c. 运行: node --version 确认 Node 正常');
      checkDshLogs();
      watchdogLogLine('');
    }

    // exit code 0 或 130(Ctrl+C) = 正常退出，不重启
    if (code === 130 || code === 0) {
      watchdogLogLine('正常退出，守护不再重启');
      return;
    }

    if (isRapidCrash()) {
      watchdogLogLine(`⚠ 快速崩溃（${RAPID_CRASH_THRESHOLD} 次/${RAPID_CRASH_WINDOW_MS / 1000}秒），暂停 30 秒`);
      restartTimer = setTimeout(startDshWeb, 30000);
      return;
    }

    watchdogLogLine(`${RESTART_DELAY_MS / 1000} 秒后重启...`);
    restartTimer = setTimeout(startDshWeb, RESTART_DELAY_MS);
  });

  dshProcess.on('error', (err) => {
    watchdogLogLine(`dsh web 启动失败: ${err.message}（请确认 dsh 已安装并在 PATH 中）`);
  });
}

function stopDshWeb() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (dshPid) {
    watchdogLogLine('正在停止 dsh web（杀进程组）...');
    try {
      process.kill(-dshPid, 'SIGTERM');
    } catch {
      try { if (dshProcess) dshProcess.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => {
      try { process.kill(-dshPid, 'SIGKILL'); } catch {}
    }, 2000).unref();
    dshPid = null;
    dshProcess = null;
  }
}

// ── 全局异常捕获（防止静默退出）──
process.on('uncaughtException', (err) => {
  watchdogLogLine(`[FATAL] uncaughtException: ${err.stack || err.message}`);
  setTimeout(() => process.exit(1), 500).unref();
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  watchdogLogLine(`[FATAL] unhandledRejection: ${msg}`);
  setTimeout(() => process.exit(1), 500).unref();
});

// ── 进程退出日志（记录退出码，便于排查）──
process.on('exit', (code) => {
  // exit 事件里只能同步操作，直接写文件
  try { fs.appendFileSync(WATCHDOG_LOG_FILE, `[${new Date().toISOString()}] relay 进程退出，exit code=${code}\n`); } catch {}
  console.log(`dsh-public-relay: 进程退出 (code=${code})`);
});

// ── 心跳定时器：确保事件循环永远不为空 ──
// 即使 HTTP server 空闲、dsh web 没启动，心跳也能保持 Node 进程活着
// 不调用 unref()，这样它就是一个强活引用，阻止 Node 自动退出
setInterval(() => {
  // 空操作，仅保持事件循环活跃
  // 如果觉得日志太多可以去掉，这里故意不输出
}, 60_000);

// 认证拦截：未登录时返回登录页 / 401；处理 /__login 提交
function authGate(req, res, socket) {
  if (!AUTH) return true;
  const token = AUTH.parseCookies(req)[AUTH.cookieName];
  if (AUTH.verifyToken(token)) return true;

  // 登录提交
  if (req.method === 'POST' && req.url === '/__login') {
    let body = '';
    let over = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) over = true;
    });
    req.on('end', () => {
      if (over) {
        if (res) { res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }); res.end('payload too large'); }
        return;
      }
      const input = new URLSearchParams(body).get('password') || '';
      const ha = crypto.createHash('sha256').update(input).digest();
      const hb = crypto.createHash('sha256').update(config.password).digest();
      const ok = crypto.timingSafeEqual(ha, hb);
      // 失败延时，拖慢暴力破解
      setTimeout(() => {
        if (!res.headersSent) {
          if (ok) {
            const exp = Date.now() + AUTH.COOKIE_TTL_MS;
            res.writeHead(302, {
              location: '/',
              'set-cookie': `${AUTH.cookieName}=${AUTH.signToken(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH.COOKIE_TTL_MS / 1000)}`,
              'cache-control': 'no-store',
            });
            res.end();
          } else {
            const page = AUTH.LOGIN_PAGE.replace('__ERR__', '<div class="err">口令错误，请重试</div>');
            res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(page);
          }
        }
      }, ok ? 0 : 400);
    });
    return false;
  }

  // 未登录
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const page = AUTH.LOGIN_PAGE.replace('__ERR__', '');
    if (res) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    }
    return false;
  }
  if (res) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('dsh-public-relay: 未登录（需要访问口令）。\n');
  } else if (socket) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\ndsh-public-relay: 未登录（需要访问口令）');
    socket.destroy();
  }
  return false;
}

// ── 强制回环判定：bundle 改写 ──
// DSH 依据 window.location.hostname 判定是否"本机回环"（127/localhost/[::1]），
// 公网域名命中 false，导致设置平面降级为"memory"（插件配置显示为空）。
// --force-loopback 启用时，拦截并改写 dsh-client-connection 的 client bundle，
// 把 isLoopback 的判定改为 unconditionally true。

const CONN_BUNDLE_PATHNAME = '/plugins/@deepseek-ai/dsh-client-connection/client.js';
const LOOPBACK_REGEX = /isLoopback:\s+pageLocation === void 0 \|\| isLoopbackHostname\(pageLocation\.hostname\)/g;

function shouldPatchBundle(req) {
  if (!config.forceLoopback) return false;
  try { return new URL(req.url, 'http://x').pathname === CONN_BUNDLE_PATHNAME; }
  catch { return false; }
}

// 仅对目标 bundle 走缓冲代理，执行字节替换后返回
function handlePatchedBundle(req, res) {
  const t0 = Date.now();
  const remote = req.socket.remoteAddress;
  const headers = rewriteHeaders(req.headers, false, TARGET);
  // 剥离压缩，保证上游返回明文，改写才能命中
  delete headers['accept-encoding'];
  headers['accept-encoding'] = 'identity';

  const proxyReq = http.request({ ...UPSTREAM, method: req.method, path: req.url, headers, agent: false });
  const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), 15000);

  proxyReq.on('response', (proxyRes) => {
    clearTimeout(timer);
    const status = proxyRes.statusCode;
    const upstreamHeaders = stripHopByHop(proxyRes.headers);

    // 非 200 或已压缩 → 原样透传（不改写），并记录
    const encoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
    if (status !== 200 || (encoding && encoding !== 'identity')) {
      if (encoding && encoding !== 'identity') {
        console.log(`[force-loopback] 上游响应已压缩 (${encoding})，已按原样透传`);
      }
      res.writeHead(status, proxyRes.statusMessage, upstreamHeaders);
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
      log(req.method, req.url, status, remote, Date.now() - t0);
      return;
    }

    // 收集 body
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      const original = Buffer.concat(chunks);
      let body = original.toString('utf-8');

      // 字节替换：容忍空白漂移（正则）
      const patched = body.replace(LOOPBACK_REGEX, 'isLoopback: true');

      if (patched !== body) {
        console.log(`[force-loopback] 已改写 bundle：${body.length} → ${patched.length} 字节`);
        delete upstreamHeaders['content-length'];       // 长度已变
        delete upstreamHeaders['transfer-encoding'];    // 用固定的 content-length
        upstreamHeaders['content-length'] = Buffer.byteLength(patched, 'utf-8');
        upstreamHeaders['cache-control'] = 'no-store';  // 避免跨次版本缓存混乱
        res.writeHead(200, upstreamHeaders);
        res.end(patched);
      } else {
        console.log('[force-loopback] 警告：未找到目标模式，可能 dsh 已升级，已按原样转发');
        res.writeHead(status, upstreamHeaders);
        res.end(original);
      }
      log(req.method, req.url, 200, remote, Date.now() - t0);
    });
    proxyRes.on('error', () => res.destroy());
  });

  proxyReq.on('error', (err) => {
    clearTimeout(timer);
    log(req.method, req.url, 502, remote, Date.now() - t0);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`relay: 无法连接上游 ${TARGET.origin}（${err.code || err.message}）。请确认 dsh web 已启动。\n`);
    } else {
      res.destroy();
    }
  });

  req.on('error', () => proxyReq.destroy());
  req.on('aborted', () => proxyReq.destroy());
  res.on('error', () => proxyReq.destroy());
  res.on('close', () => { if (!res.writableEnded && !proxyReq.destroyed) proxyReq.destroy(); });
  req.pipe(proxyReq);
}

// ── HTTP 请求代理 ──
function handleRequest(req, res) {
  const t0 = Date.now();
  const remote = req.socket.remoteAddress;
  if (!authGate(req, res)) return;

  // 命中目标 bundle → 走缓冲改写路径
  if (shouldPatchBundle(req)) return handlePatchedBundle(req, res);

  const headers = rewriteHeaders(req.headers, false, TARGET);
  const proxyReq = http.request({ ...UPSTREAM, method: req.method, path: req.url, headers, agent: false });
  const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), 15000);

  proxyReq.on('response', (proxyRes) => {
    clearTimeout(timer);
    res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, stripHopByHop(proxyRes.headers));
    proxyRes.pipe(res);
    proxyRes.on('error', () => res.destroy());
    log(req.method, req.url, proxyRes.statusCode, remote, Date.now() - t0);
  });

  proxyReq.on('error', (err) => {
    clearTimeout(timer);
    log(req.method, req.url, 502, remote, Date.now() - t0);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`relay: 无法连接上游 ${TARGET.origin}（${err.code || err.message}）。请确认 dsh web 已启动。\n`);
    } else {
      res.destroy();
    }
  });

  req.on('error', () => proxyReq.destroy());
  req.on('aborted', () => proxyReq.destroy());
  res.on('error', () => proxyReq.destroy());
  res.on('close', () => {
    if (!res.writableEnded && !proxyReq.destroyed) proxyReq.destroy();
  });
  req.pipe(proxyReq);
}

// ── WebSocket upgrade 代理 ──
function handleUpgrade(req, socket, head) {
  const t0 = Date.now();
  const remote = socket.remoteAddress;
  // 先兜住客户端异常，避免 unhandled 'error' 崩溃
  socket.on('error', () => socket.destroy());
  if (!authGate(req, null, socket)) return;

  const headers = rewriteHeaders(req.headers, true, TARGET);
  const proxyReq = http.request({ ...UPSTREAM, method: 'GET', path: req.url, headers, agent: false });
  const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), 15000);

  proxyReq.on('upgrade', (proxyRes, upstreamSocket, head2) => {
    clearTimeout(timer);
    const h = stripHopByHop(proxyRes.headers);
    h.connection = 'Upgrade';
    if (!h.upgrade) h.upgrade = 'websocket';
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${serializeHeaders(h)}\r\n`);
    if (head2 && head2.length) upstreamSocket.unshift(head2);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const kill = () => { upstreamSocket.destroy(); socket.destroy(); };
    upstreamSocket.on('error', kill);
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    log(req.method, req.url, 101, remote, Date.now() - t0);
  });

  // 上游拒绝握手（如 403/502）：把状态码透传给客户端
  proxyReq.on('response', (proxyRes) => {
    clearTimeout(timer);
    const status = proxyRes.statusCode || 502;
    socket.write(`HTTP/1.1 ${status} ${proxyRes.statusMessage || ''}\r\n${serializeHeaders(stripHopByHop(proxyRes.headers))}\r\n`);
    proxyRes.pipe(socket);
    proxyRes.on('end', () => socket.end());
    proxyRes.on('error', () => socket.destroy());
    log(req.method, req.url, status, remote, Date.now() - t0);
  });

  proxyReq.on('error', (err) => {
    clearTimeout(timer);
    log(req.method, req.url, 502, remote, Date.now() - t0);
    if (socket.writable) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nrelay: 无法连接上游 DSH Web（请确认 dsh web 已启动）');
      socket.destroy();
    }
  });

  proxyReq.end();
}

// ── 服务器装配与启动 ──
const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`dsh-public-relay: 端口 ${config.port} 已被占用，换一个端口（--port）再试。`);
    process.exit(1);
  }
  throw err;
});

// 启动 dsh web 守护进程
if (config.watchdog) {
  try {
    watchdogLog = fs.createWriteStream(WATCHDOG_LOG_FILE, { flags: 'a' });
  } catch {}
  startDshWeb();
}

server.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  console.log('────────────────────────────────────────────────────────────');
  console.log(`dsh-public-relay: 中转监听 ${config.host}:${port}，转发到 ${TARGET.origin}`);
  console.log(`dsh-public-relay: 樱花映射 TCP 隧道的「本地端口」请填 ${port}`);
  if (config.watchdog) {
    console.log(`dsh-public-relay: dsh web 守护已启动（崩溃自动重启，日志：dsh-web.log）`);
  }
  if (AUTH) {
    if (generatedPassword !== null) {
      console.log(`dsh-public-relay: 访问口令（本次随机生成）: ${config.password}`);
      console.log('dsh-public-relay: 记下它；下次用 --password 或 DSH_RELAY_PASSWORD 复用同一个口令');
    } else {
      console.log(`dsh-public-relay: 访问口令: ${config.password}`);
    }
  }
  if (config.forceLoopback) {
    console.log('dsh-public-relay: 已启用 force-loopback（公网可看插件列表，Ctrl+F5 硬刷新生效）');
  }
  console.log('────────────────────────────────────────────────────────────');
});

let isShuttingDown = false;
function shutdown() {
  if (isShuttingDown) return;  // 防止重复调用
  isShuttingDown = true;
  watchdogLogLine('收到关闭信号，正在清理...');
  stopDshWeb();
  server.close(() => {
    watchdogLogLine('relay 已关闭，退出');
    process.exit(0);
  });
  // 3 秒兜底强退
  setTimeout(() => { try { process.exit(0); } catch {} }, 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Windows: 关闭窗口时也会触发
process.on('SIGHUP', shutdown);
