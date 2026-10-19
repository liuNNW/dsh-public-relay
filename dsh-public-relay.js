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
 * ── 为什么代理逻辑直接 import 插件的 lib/ ──────────────────────────────────
 *
 * 本文件此前自带一份「手抄版」代理实现。审计证明它与 lib/ 已经漂移很远，
 * 并且带着一整套 lib/ 里早已修掉的漏洞：
 *
 *   · `serializeHeaders` 不过滤 CR/LF → 上游响应头里的 \r\n 可以注入新响应头
 *     （HTTP response splitting）。lib/relay.js 的同名函数专门做了过滤与头名校验。
 *   · `POST /__login` 在**未认证**状态下无上限地累积 body，且超限后既不 413
 *     也不 destroy —— 免认证的内存耗尽入口。lib/ 版超限即 413 + destroy。
 *   · 完全没有登录限流。lib/ 版有按来源 IP 的滑动窗口。
 *   · Cookie 不带 Secure（HTTPS 隧道下会随明文端口一起发）。
 *   · force-loopback 只认单个固定 pathname + 单一正则，而 0.2.x 客户端走 combo
 *     URL（`/plugins/??…&rev=`），于是**永远命中不了** —— 公网看不到插件列表，
 *     而日志里只有一行 warn，看起来像「正常但没生效」。
 *   · WebSocket upgrade 丢弃客户端握手后的 `head`，首帧直接丢失。
 *
 * 继续「手抄同步」等于每修一处库就要再抄一次、再漂移一次 —— 审计里那些
 * 漏洞正是这样产生的。所以这里改成**单一事实来源**：本文件只负责参数解析、
 * 口令生成、dsh web 守护与日志，代理核心直接用 lib/relay.js 的 createRelay()。
 * lib/ 修一次，插件入口与脚本入口同时受益。
 *
 * 代价：脚本不再是「单文件自包含」，需要与 plugin/ 目录一起分发。
 * 这是有意的取舍 —— 一个自我复制、且复制品比原件弱的副本，比依赖更危险。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

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

  代理核心复用 plugin/dsh-public-relay/lib/relay.js（与插件版同一份代码）。

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

// ─────────────────────────── dsh web 守护进程 ───────────────────────────

let dshProcess = null;      // 当前 dsh web 子进程
let dshPid = null;          // 进程 PID（Windows 下可能是 cmd.exe 的）
let watchdogLog = null;     // 日志文件流
let restartTimer = null;
let restartCount = 0;
const WATCHDOG_LOG_FILE = path.join(__dirname, 'dsh-web.log');
const RESTART_DELAY_MS = 5000;
const RAPID_CRASH_THRESHOLD = 3;
const RAPID_CRASH_WINDOW_MS = 30000;
const rapidCrashes = [];    // 最近崩溃时间戳

/**
 * 关闭流程开始后置位。
 *
 * 之前 stopDshWeb() 只清了 restartTimer，但**正在退出**的子进程随后仍会触发
 * 'exit' 回调，那个回调会在关闭过程中再排一个 startDshWeb 的重设定时器 ——
 * 于是 shutdown 刚把 dsh web 停掉，守护又把它拉起来。
 * 这个标志让 exit 回调知道「已经收摊了」，不再重启。
 */
let shuttingDown = false;

function watchdogLogLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { if (watchdogLog) watchdogLog.write(line + '\n'); } catch { /* 日志失败不应影响主流程 */ }
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
  if (shuttingDown) return;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  restartCount++;

  watchdogLogLine(`═══ dsh web 启动（第 ${restartCount} 次）═══`);
  watchdogLogLine(`  命令: dsh web`);
  watchdogLogLine(`  工作目录: ${process.cwd()}`);
  watchdogLogLine(`  Node: ${process.version}`);
  watchdogLogLine(`  平台: ${process.platform} ${process.arch}`);

  // shell: true → Windows 需要通过 cmd.exe 找到 dsh.cmd。
  // 注意：此时 dshPid 是 **cmd.exe** 的 PID，不是 node 的 —— 见 stopDshWeb。
  dshProcess = spawn('dsh', ['web'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  });

  dshPid = dshProcess.pid;
  watchdogLogLine(`  PID: ${dshPid}`);

  // 按行切分，并保留可能不完整的最后一段（一条 chunk 可能在 \n 处断开）。
  // 之前是对每个 chunk 独立 trimEnd + split，会把跨 chunk 的行截成两半，
  // 日志因此出现莫名其妙的半行。
  let outBuf = '';
  dshProcess.stdout.on('data', (d) => {
    outBuf += d.toString();
    const parts = outBuf.split('\n');
    outBuf = parts.pop();
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed) watchdogLogLine(`[dsh-web] ${trimmed}`);
    }
  });

  let errBuf = '';
  dshProcess.stderr.on('data', (d) => {
    errBuf += d.toString();
    const parts = errBuf.split('\n');
    errBuf = parts.pop();
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed) watchdogLogLine(`[dsh-web ERR] ${trimmed}`);
    }
  });

  dshProcess.on('exit', (code, signal) => {
    dshProcess = null;
    dshPid = null;

    const reason = signal ? `signal=${signal}` : `exit code=${code}`;
    watchdogLogLine(`═══ dsh web 退出（${reason}）═══`);

    // 关键：关闭流程一旦开始，绝不再把它拉起来。
    if (shuttingDown) {
      watchdogLogLine('  中转正在关闭，不再重启 dsh web');
      return;
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

/**
 * 停掉 dsh web 及其子进程。
 *
 * 之前这里用 `process.kill(-pid)` 杀「进程组」，在 Windows 上根本不成立：
 *   · 负 PID 的 kill 在 Windows 无效，抛错；
 *   · 于是退回 dshProcess.kill()，而那只能杀掉 cmd.exe 壳，真正的
 *     `dsh web`（node）子进程活了下来，继续占着 3080；
 *   · 两秒后的 SIGKILL 又在 dshPid 已被置 null 之后才去读它，
 *     process.kill(-null) 指向的是**本进程自己的进程组**。
 *
 * 现在：Windows 用 taskkill /T /F（/T = 连子树一起杀），其它平台才用进程组。
 * 并把 pid 抓进闭包，避免与置空之间的竞态。
 */
function stopDshWeb() {
  shuttingDown = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const pid = dshPid;
  if (!pid) return;

  watchdogLogLine('正在停止 dsh web（连同子进程）...');

  if (process.platform === 'win32') {
    // /T 杀整棵子树，/F 强制。这才是 Windows 上唯一正确的做法。
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      try { if (dshProcess) dshProcess.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { if (dshProcess) dshProcess.kill('SIGTERM'); } catch { /* 已退出 */ }
    }
    const killer = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }, 2000);
    killer.unref();
  }
  dshPid = null;
  dshProcess = null;
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
  try { fs.appendFileSync(WATCHDOG_LOG_FILE, `[${new Date().toISOString()}] relay 进程退出，exit code=${code}\n`); } catch { /* 忽略 */ }
  console.log(`dsh-public-relay: 进程退出 (code=${code})`);
});

// ── 心跳定时器：确保事件循环永远不为空 ──
// 不调用 unref()，这样它就是一个强活引用，阻止 Node 自动退出
setInterval(() => {
  // 空操作，仅保持事件循环活跃
}, 60_000);

// ─────────────────────────── 中转（复用 lib/relay.js）───────────────────────────

const relayLib = path.join(__dirname, 'plugin', 'dsh-public-relay', 'lib', 'relay.js');

/**
 * lib/relay.js 的 createRelay 要的是一个「已归一化的配置对象」与一个
 * 「本进程 dsh 的端点」。本脚本两者都固定在命令行参数上，所以直接给回调。
 *
 * 注意 `allowOffHostTarget`：lib/config.js 的白名单重建里新增了这个开关，
 * 漏掉它会静默变成 undefined（= false），于是任何非回环 --target 都会被
 * 当成「配错了」而拒绝启动 —— 而用户是显式给了 --target 的。
 */
function relayConfig() {
  return {
    listenHost: config.host,
    listenPort: config.port,
    targetHost: TARGET.hostname,
    targetPort: TARGET.port,
    password: config.password,
    forceLoopback: config.forceLoopback,
    autoSession: false,        // 独立脚本没有 dsh 会话代签器
    compressWebSocket: true,
    allowOffHostTarget: true,  // 用户显式给了 --target，尊重之（见上文说明）
  };
}

async function main() {
  let createRelay;
  try {
    ({ createRelay } = await import(pathToFileURL(relayLib).href));
  } catch (err) {
    console.error(`dsh-public-relay: 无法加载代理核心 ${relayLib}`);
    console.error(`  ${err?.message || err}`);
    console.error('  请确认 plugin/dsh-public-relay/lib/ 与本脚本在同一份分发里。');
    process.exit(1);
  }

  const relay = createRelay({
    getDshEndpoint: () => ({ host: TARGET.hostname, port: TARGET.port }),
    getConfig: relayConfig,
    log: (level, message) => {
      if (level === 'error') console.error(`[relay:${level}] ${message}`);
      else if (level === 'warn') console.warn(`[relay:${level}] ${message}`);
      else console.log(`[relay] ${message}`);
    },
    // 独立脚本没有 dsh 会话上下文，sessionSigner 留空即可。
  });

  if (config.watchdog) {
    try {
      watchdogLog = fs.createWriteStream(WATCHDOG_LOG_FILE, { flags: 'a' });
    } catch { /* 日志文件打不开也不该阻止启动 */ }
    startDshWeb();
  }

  const st = await relay.start();
  if (st.state === 'error') {
    console.error(`dsh-public-relay: 中转启动失败（${st.lastError}）`);
    console.error(`dsh-public-relay: 监听 ${config.host}:${config.port} → ${TARGET.origin}`);
    if (st.lastError === 'port-in-use') {
      console.error('dsh-public-relay: 端口已被占用，换一个端口（--port）再试。');
    }
    if (st.lastError === 'off-host-target') {
      console.error('dsh-public-relay: --target 指向回环之外的主机，插件库默认拒绝。');
    }
    process.exit(1);
  }

  const port = st.listen.port;
  console.log('────────────────────────────────────────────────────────────');
  console.log(`dsh-public-relay: 中转监听 ${config.host}:${port}，转发到 ${TARGET.origin}`);
  console.log(`dsh-public-relay: 樱花映射 TCP 隧道的「本地端口」请填 ${port}`);
  if (config.watchdog) {
    console.log('dsh-public-relay: dsh web 守护已启动（崩溃自动重启，日志：dsh-web.log）');
  }
  if (config.password) {
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

  // ── 关闭 ──
  let isShuttingDown = false;
  async function shutdown() {
    if (isShuttingDown) return;   // 防止重复调用
    isShuttingDown = true;
    watchdogLogLine('收到关闭信号，正在清理...');
    stopDshWeb();
    // 兜底强退：relay.stop() 自带 2 秒 drain，正常会先结束。
    // 这个定时器**只能**在关闭流程里挂 —— 之前它被无条件挂在 main() 末尾，
    // 于是每次启动 3 秒后就把整个中转强退了（.unref() 只是不让它撑住事件
    // 循环，并不会阻止它到点触发）。症状极难定位：启动信息一切正常，
    // 端口也确实在监听，然后进程安静地自己没了。
    const bail = setTimeout(() => { try { process.exit(0); } catch { /* 已退出 */ } }, 3000);
    bail.unref();
    await relay.stop().catch(() => { /* 停止中转失败也要退出 */ });
    watchdogLogLine('relay 已关闭，退出');
    process.exit(0);
  }
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  // Windows: 关闭窗口时也会触发
  process.on('SIGHUP', () => { void shutdown(); });
}

main().catch((err) => {
  console.error(`dsh-public-relay: 启动失败：${err?.stack || err}`);
  process.exit(1);
});