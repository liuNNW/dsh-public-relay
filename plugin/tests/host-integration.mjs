#!/usr/bin/env node
/**
 * host-integration.mjs — dsh-public-relay 宿主半集成测试
 *
 * 用一个假 ctx 真实 import lib/index.js 并 apply()，验证：
 *   · 从 ctx.webServer 读到真实端口（而不是硬编码）
 *   · /dsh-public-relay/status 与 /dsh-public-relay/control 路由真的注册并可调用
 *   · 开关能真正改变中转监听状态（start/stop/toggle）
 *   · effect 清理时自动停中转并释放端口（这是"永久插件 + 随时关"的基础）
 *   · 配置持久化走 credentials 服务（写/读回）
 *
 * 运行：node plugin/tests/host-integration.mjs
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeAuth } from '../dsh-public-relay/lib/auth.js';

// ── 整体超时保险 ──
// 若测试因句柄挂起而无法推进，Node 会在无活动句柄时静默退出、退出码停在默认 0，
// 把「挂死」伪装成「通过」。硬超时确保任何卡住都变成明确的失败。
const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.error(`\n[test] 超时 ${WATCHDOG_MS / 1000}s 仍未结束，判定失败（可能有句柄挂起）`);
  process.exitCode = 1;
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.error(`  ✗ ${name}\n      ${detail || 'assertion failed'}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function portListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; sock.destroy(); resolve(v); };
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
    setTimeout(() => fin(false), 1500);
  });
}

/**
 * 起一个真实 HTTP server，把请求分发给插件注册的"最长匹配"处理器。
 *
 * 为什么不用伪造的 IncomingMessage/ServerResponse：伪造对象不会自发
 * 产生 'end'/'data' 事件，handler 里 `for await (const chunk of request)`
 * 会永久挂住。真实 server 才有正确的请求生命周期。
 */
async function startRouteHost(routes, listenPort = 0) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const key = [...routes.keys()]
      .filter((k) => pathname === k || pathname.startsWith(k + '/'))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no route');
      return;
    }
    Promise.resolve(routes.get(key)(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err?.message || err));
      } else {
        res.destroy();
      }
    });
  });
  await new Promise((r) => server.listen(listenPort, '127.0.0.1', r));
  const port = server.address().port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * 经真实中转打一个管理路由，返回状态码。
 *
 * 用来复现本次加固针对的真实攻击面：请求先过中转的数据面认证，再被
 * rewriteHeaders 改写成同源（Origin 与 Host 都变成回环权威）后到达 dsh。
 * 也就是说这条路径上 Origin 判据按构造必然通过 —— 只有凭据能挡住。
 *
 * @param login - true 时先 POST /__login 换 relay_session 再带 cookie
 */
async function callViaRelay(relayPort, pathname, password, body, options = {}) {
  const headers = { connection: 'close', 'content-type': 'application/json' };
  if (options.login === true) {
    const loginRes = await httpRequest(relayPort, 'POST', '/__login',
      'application/x-www-form-urlencoded', `password=${encodeURIComponent(password)}`);
    const setCookie = loginRes.headers['set-cookie']?.[0] || '';
    if (!setCookie.startsWith('relay_session=')) return loginRes.status;
    headers.cookie = setCookie.split(';')[0];
  }
  const payload = JSON.stringify(body ?? {});
  headers['content-length'] = Buffer.byteLength(payload);
  const res = await httpRequest(relayPort, 'POST', pathname, 'application/json', payload, headers);
  return res.status;
}

/** 一个最小的 HTTP 客户端（相对 callRoute 不设 Host，好让中转看到真实 authority）。 */
function httpRequest(port, method, path, contentType, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'content-type': contentType, ...extraHeaders },
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('route call timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * 由中转口令派生一个管理路由用的 bearer token。
 *
 * 0.2.3 起管理路由（/config、/control）不再只靠 Origin 嗅探 —— 必须持有口令
 * （bearer 或 relay_session）。测试于是要像真实调用方那样带上凭据，否则
 * 「同源但无凭据 → 403」这条新边界根本测不到。
 */
function adminAuth(password) {
  const secret = crypto.createHmac('sha256', 'dsh-public-relay').update(password).digest();
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** 通过真实 server 调一个插件路由。 */
async function callRoute(host, method, pathname, options = {}) {
  const headers = { connection: 'close', ...(options.headers || {}) };
  if (options.adminAs !== undefined) {
    headers.authorization = `Bearer ${adminAuth(options.adminAs)}`;
  }
  // 浏览器发同源请求时，Host 与 Origin 的 authority 必然一致；
  // 这里照做，好让同源校验走真实路径（而不是被测试伪造的头误导）。
  if (headers.origin !== undefined && headers.host === undefined) {
    try { headers.host = new URL(headers.origin).host; } catch { /* 非法 origin 保持原样 */ }
  }
  let body;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['content-type'] = headers['content-type'] || 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: host.port, method, path: pathname, headers, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('route call timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * 假 Cordis ctx：只实现插件用到的那部分。
 *
 * **配置来源已变更（0.2.0）**：插件不再依赖 settings 命名空间，配置由它自己
 * 的 JSON 文件持有（路径来自 ctx.profileContext.home）。所以这里提供一个
 * 临时目录作为 profile home，避免测试写脏真实 profile。
 */
function makeCtx({ webPort, webHost = '127.0.0.1', entryConfig = {} }) {
  const routes = new Map();
  const effects = [];
  const logLines = [];
  const registeredTools = [];
  // 每个 ctx 一份独立的临时 profile home（测试之间互不干扰，也不碰真实 ~/.dsh）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-test-'));

  const ctx = {
    // 与真实宿主一致：dir 是这个 profile 的目录，home 是 $DSH_HOME 根。
    profileContext: { dir: home, home: path.dirname(home), name: 'test' },
    webServer: {
      host: webHost,
      port: webPort,
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    logger: {
      info: (m) => logLines.push(['info', m]),
      warn: (m) => logLines.push(['warn', m]),
      error: (m) => logLines.push(['error', m]),
    },
    effect(fn, label) {
      const cleanup = fn();
      effects.push({ cleanup, label });
      return () => { if (typeof cleanup === 'function') cleanup(); };
    },
    get(name) {
      if (name === 'tools') {
        return { register: (def) => { registeredTools.push(def); return () => {}; } };
      }
      // 故意不提供 settings：0.2.0 起插件不依赖它，这条路径必须照样工作。
      return undefined;
    },
  };

  /** 读插件落盘的配置文件（测试断言用）。 */
  function readConfigFile() {
    const file = path.join(home, 'dsh-public-relay.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  return { ctx, routes, effects, logLines, registeredTools, home, readConfigFile };
}

// ═══════════════════════════ 主流程 ═══════════════════════════

async function main() {
  const dshPort = await freePort();
  const relayPort = await freePort();

  const pluginEntry = pathToFileURL(
    path.resolve(import.meta.dirname, '..', 'dsh-public-relay', 'lib', 'index.js'),
  ).href;
  const mod = await import(pluginEntry);
  const plugin = mod.default ?? mod;
  const applyFn = plugin.apply ?? mod.apply;

  section('插件形状');
  check('导出 name = dsh-public-relay', (plugin.name ?? mod.name) === 'dsh-public-relay', `got ${plugin.name ?? mod.name}`);
  const inject = plugin.inject ?? mod.inject;
  check('inject 含 webServer', Array.isArray(inject) && inject.includes('webServer'), `got ${JSON.stringify(inject)}`);
  check('导出 apply 函数', typeof applyFn === 'function', 'apply missing');

  // ── 应用插件：假 webServer 报告"dsh 真实端口"= dshPort ──
  const h = makeCtx({ webPort: dshPort });
  applyFn(h.ctx, {
    enabled: true,
    listenHost: '127.0.0.1',
    listenPort: relayPort,
    password: 'integration-pass',
    forceLoopback: true,
  });

  // 真实 HTTP server，把请求分发给插件注册的路由
  //
  // 固定用 dshPort 起：中转的上游就是它，随机端口会让 relay 侧 502，
  // 经中转的那几条断言就测不到真实路径了。
  const host = await startRouteHost(h.routes, dshPort);

  // 等 effect 里的异步启动落定
  await new Promise((r) => setTimeout(r, 600));

  section('读取本进程真实端口（不硬编码）');
  {
    const status = await callRoute(host, 'GET', '/dsh-public-relay/status');
    check('status 路由已注册', status.status === 200, `got ${status.status}`);
    const body = JSON.parse(status.body);
    check('dshPort 等于 ctx.webServer.port', body.dshPort === dshPort, `got ${body.dshPort}, expected ${dshPort}`);
    check('dshAddress 含该端口', String(body.dshAddress).includes(String(dshPort)), `got ${body.dshAddress}`);
    check('中转指向该 dsh 端口', body.target?.port === dshPort, `got ${JSON.stringify(body.target)}`);
    check('state=running', body.state === 'running', `got ${body.state} / ${body.lastError}`);
    check('hasPassword=true', body.hasPassword === true, `got ${body.hasPassword}`);
  }

  section('路由鉴权与写操作的可信判据');
  {
    const PW = 'integration-pass';   // 本段开始时生效的口令

    // ═══ 0.2.3 回归锁：同源但**无凭据** → 必须 403 ═══
    //
    // 这正是本次加固堵掉的洞。旧实现只查 Origin，于是「Origin 与 Host 相同」
    // 就算通过 —— 而经中转进来的请求恰恰总满足这一条（rewriteHeaders 把
    // Host/Origin 都改写成回环权威），判据按构造失效。现在必须持有口令。
    const noCred = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { listenPort: relayPort } },
    });
    check('同源但无 bearer/cookie → /config 403', noCred.status === 403,
      `got ${noCred.status} ${noCred.body.slice(0, 120)}`);

    const noCredCtrl = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'status' },
    });
    check('同源但无凭据 → /control 403', noCredCtrl.status === 403, `got ${noCredCtrl.status}`);

    // 错口令的 bearer 同样不行（防止「有 Authorization 头就放行」这种写法）
    const wrongCred = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { listenPort: relayPort } },
      adminAs: 'not-the-password',
    });
    check('错误口令的 bearer → 403', wrongCred.status === 403, `got ${wrongCred.status}`);

    // 正确 bearer → 放行
    const withCred = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { listenPort: relayPort } },
      adminAs: PW,
    });
    check('正确 bearer → /config 200', withCred.status === 200,
      `got ${withCred.status} ${withCred.body.slice(0, 120)}`);

    // ═══ 经中转进来时 403（承上：Origin/Host 已被改写成同源，仍必须凭口令）═══
    //
    // 这条用真实中转打过来：先登录换到 relay_session，再经中转发管理请求。
    // 没有 relay_session 时中转会把它挡在数据面之外（401），压根到不了 dsh。
    {
      const relayed = await callViaRelay(relayPort, '/dsh-public-relay/config', PW, {
        config: { listenPort: relayPort },
      });
      check('经中转无鉴权访问 /config → 403（未登录被中转挡在数据面）',
        relayed === 403 || relayed === 401,
        `got ${relayed}`);

      // 带 relay_session 的，经中转才应当真的到达 dsh（200）
      const relayedAuth = await callViaRelay(relayPort, '/dsh-public-relay/config', PW, {
        config: { listenPort: relayPort },
      }, { login: true });
      check('经中转带 relay_session → 200', relayedAuth === 200, `got ${relayedAuth}`);
    }

    // ── 无 Origin：仅回环对端放行 ──
    //
    // callRoute 走 127.0.0.1，属回环 → 仍可用（本机 curl 场景不回归），
    // 但**鉴权**照旧要求凭据。
    const noOrigin = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      body: { action: 'status' },
      adminAs: PW,
    });
    check('回环对端 + 无 Origin + 有凭据 → 200', noOrigin.status === 200,
      `got ${noOrigin.status} ${noOrigin.body.slice(0, 120)}`);

    // ── Electron 自渲染页面 → 放行（本次 403 bug 的回归锁）──
    //
    // Electron 的客户端页面跑在 dsh-app://app/ 下，该协议被注册为
    // standard+secure，页面 fetch 会带这个 Origin。
    // 若按「Origin 必须等于 Host」处理，`new URL('dsh-app://app').host` 是 "app"，
    // 与真实 Host 永不相等 → 一律 403，表现就是「设置页按钮点了没反应」。
    // 0.2.3 起这里改成**精确匹配** dsh-app://app（原先是前缀匹配）。
    const electron = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: 'dsh-app://app', host: `127.0.0.1:${host.port}` },
      body: { action: 'status' },
      adminAs: PW,
    });
    check('Electron 的 dsh-app:// Origin → 放行', electron.status === 200,
      `got ${electron.status} ${electron.body.slice(0, 120)}`);

    // 前缀匹配曾会接受这种伪造串 —— HTTP 头里可以随便写 dsh-app://anything
    const forgedAppOrigin = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: 'dsh-app://evil', host: `127.0.0.1:${host.port}` },
      body: { action: 'status' },
      adminAs: PW,
    });
    check('伪造的 dsh-app://evil Origin → 403（不再前缀匹配）',
      forgedAppOrigin.status === 403, `got ${forgedAppOrigin.status}`);

    // ── 真正的跨源 → 仍拒绝（安全边界不放宽）──
    const crossOrigin = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: 'http://evil.example.com', host: `127.0.0.1:${host.port}` },
      body: { action: 'status' },
      adminAs: PW,
    });
    check('跨源 POST → 403', crossOrigin.status === 403, `got ${crossOrigin.status}`);

    // 隧道场景下的跨站也必须拒（Origin 与 Host 不同 authority）
    const tunnelCross = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: 'https://evil.example.com', host: 'example.com:3091' },
      body: { action: 'status' },
      adminAs: PW,
    });
    check('隧道 authority 下的跨源 POST → 403', tunnelCross.status === 403, `got ${tunnelCross.status}`);

    // ── http 同源 → 放行 ──
    const okOrigin = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'status' },
      adminAs: PW,
    });
    check('http 同源 POST → 200', okOrigin.status === 200, `got ${okOrigin.status}`);

    // 隧道同源（Origin 与 Host 一致）→ 放行
    const tunnelSame = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: 'https://example.com:3091', host: 'example.com:3091' },
      body: { action: 'status' },
      adminAs: PW,
    });
    check('隧道同源 POST → 200', tunnelSame.status === 200, `got ${tunnelSame.status}`);

    // /config 走同一判据
    const cfgElectron = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: 'dsh-app://app', host: `127.0.0.1:${host.port}` },
      body: { config: { listenPort: relayPort } },
      adminAs: PW,
    });
    check('Electron Origin 下 /config 也放行', cfgElectron.status === 200,
      `got ${cfgElectron.status} ${cfgElectron.body.slice(0, 120)}`);

    // ═══ 0.3.4 回归锁：桌面外壳**没有** bearer 时也必须能改设置 ═══
    //
    // 为什么单开一段：上面所有 Electron 用例都带了 `adminAs`（bearer），
    // 而真实前端 client.js 的 `call()` **从来不发 Authorization** ——
    // 于是「测试全绿、线上永远 403」，用户看到的就是「停用点了没反应」。
    // 下面几条故意不带任何凭据，复刻真实前端的调用形状。
    {
      const shellCtrl = await callRoute(host, 'POST', '/dsh-public-relay/control', {
        headers: { origin: 'dsh-app://app', host: `127.0.0.1:${host.port}` },
        body: { action: 'status' },
      });
      check('桌面外壳 Origin 无凭据 → /control 200（真实前端路径）', shellCtrl.status === 200,
        `got ${shellCtrl.status} ${shellCtrl.body.slice(0, 160)}`);

      const shellCfg = await callRoute(host, 'POST', '/dsh-public-relay/config', {
        headers: { origin: 'dsh-app://app', host: `127.0.0.1:${host.port}` },
        body: { config: { forceLoopback: true } },
      });
      check('桌面外壳 Origin 无凭据 → /config 200（真实前端路径）', shellCfg.status === 200,
        `got ${shellCfg.status} ${shellCfg.body.slice(0, 160)}`);

      // 「停用中转」按钮走的就是 toggle
      const shellToggle = await callRoute(host, 'POST', '/dsh-public-relay/control', {
        headers: { origin: 'dsh-app://app', host: `127.0.0.1:${host.port}` },
        body: { action: 'toggle' },
      });
      check('桌面外壳 Origin 无凭据 → 能停用中转（toggle 200）', shellToggle.status === 200,
        `got ${shellToggle.status} ${shellToggle.body.slice(0, 160)}`);

      const shellToggleBack = await callRoute(host, 'POST', '/dsh-public-relay/control', {
        headers: { origin: 'dsh-app://app', host: `127.0.0.1:${host.port}` },
        body: { action: 'toggle' },
      });
      check('再 toggle 一次恢复运行', shellToggleBack.status === 200,
        `got ${shellToggleBack.status} ${shellToggleBack.body.slice(0, 160)}`);

      // 豁免只认精确的 dsh-app://app，不是任意 dsh-app:// 前缀
      const forgedShell = await callRoute(host, 'POST', '/dsh-public-relay/control', {
        headers: { origin: 'dsh-app://evil', host: `127.0.0.1:${host.port}` },
        body: { action: 'status' },
      });
      check('伪造 dsh-app://evil 且无凭据 → 403', forgedShell.status === 403,
        `got ${forgedShell.status}`);

      // 安全边界不放宽：普通 http 同源且无凭据仍然拒绝
      const plainNoCred = await callRoute(host, 'POST', '/dsh-public-relay/control', {
        headers: { origin: `http://127.0.0.1:${dshPort}` },
        body: { action: 'status' },
      });
      check('http 同源无凭据 → 仍 403（豁免只给桌面外壳）', plainNoCred.status === 403,
        `got ${plainNoCred.status}`);
    }

    // ═══ 0.3.4 回归锁：hasPassword 必须出现在 config 内 ═══
    //
    // 前端 draftFrom() 读的是 `config.hasPassword`；此前 snapshot 只把它放在
    // 顶层，于是 UI 恒认定「口令为空」，界面一直挂着「请先填一个访问口令」。
    {
      const res = await callRoute(host, 'GET', '/dsh-public-relay/status');
      const snap = JSON.parse(res.body || '{}');
      check('snapshot 顶层 hasPassword === true', snap.hasPassword === true,
        JSON.stringify(snap).slice(0, 200));
      check('snapshot config.hasPassword === true（前端读的是这里）',
        snap.config !== undefined && snap.config.hasPassword === true,
        JSON.stringify(snap.config || {}).slice(0, 200));
      check('snapshot 不含口令原值', !res.body.includes(PW), '口令被写进了状态快照');
    }

    // ═══ 前端派生算法契约：WebCrypto 版必须与 makeAuth 一致 ═══
    //
    // client.js 是 classic script，无法 import 宿主模块，只能内联同一套派生。
    // 任一侧改动而另一侧没同步 → 一律 403，且症状极难定位。锁死这条契约。
    {
      const subtle = crypto.webcrypto.subtle;
      const enc = new TextEncoder();
      const hmacKey = await subtle.importKey('raw', enc.encode('dsh-public-relay'),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const secret = await subtle.sign('HMAC', hmacKey, enc.encode(PW));
      const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString('base64url');
      const msgKey = await subtle.importKey('raw', new Uint8Array(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = Buffer.from(new Uint8Array(await subtle.sign('HMAC', msgKey, enc.encode(payload))))
        .toString('base64url');
      const token = `${payload}.${sig}`;
      const auth = makeAuth(PW);
      check('WebCrypto 派生的 token 能被后端 makeAuth 接受',
        auth !== null && auth.verifyToken(token) === true,
        '前端与后端的 token 派生算法已漂移');
    }

    // 403 响应体不回显 origin/host 原值（头值是攻击者可控的，回显即反射预言机）
    check('403 响应体不含 origin 原值', !/evil\.example\.com/.test(crossOrigin.body),
      crossOrigin.body.slice(0, 200));
    check('403 响应体不含 host 原值', !crossOrigin.body.includes('127.0.0.1:'),
      crossOrigin.body.slice(0, 200));

    const getOnControl = await callRoute(host, 'GET', '/dsh-public-relay/control');
    check('control 只接受 POST', getOnControl.status === 405, `got ${getOnControl.status}`);

    const unknown = await callRoute(host, 'GET', '/dsh-public-relay/nope');
    check('未知子路由 → 404', unknown.status === 404, `got ${unknown.status}`);
  }

  section('开关真正改变监听状态');
  {
    check('启用后端口在监听', await portListening(relayPort) === true, `port ${relayPort} not listening`);

    const stopped = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'stop' },
      adminAs: 'integration-pass',
    });
    const stopBody = JSON.parse(stopped.body);
    check('stop 返回 ok', stopBody.ok === true, stopped.body);
    check('stop 后状态为 stopped', stopBody.status.state === 'stopped', `got ${stopBody.status.state}`);
    check('stop 后端口已释放', await portListening(relayPort) === false, `port ${relayPort} still listening`);

    const started = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'start' },
      adminAs: 'integration-pass',
    });
    const startBody = JSON.parse(started.body);
    check('start 返回 ok', startBody.ok === true, started.body);
    check('start 后端口重新监听', await portListening(relayPort) === true, `port ${relayPort} not listening`);

    const toggled = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'toggle' },
      adminAs: 'integration-pass',
    });
    const toggleBody = JSON.parse(toggled.body);
    check('toggle 关闭中转', toggleBody.status.state === 'stopped', `got ${toggleBody.status.state}`);
    check('toggle 后端口已释放', await portListening(relayPort) === false, `port ${relayPort} still listening`);
  }

  section('配置写入（自有 JSON 文件，不依赖 settings 服务）');
  {
    const saved = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { enabled: true, listenPort: relayPort, password: 'new-pass' } },
      adminAs: 'integration-pass',
    });
    check('config 路由返回 200', saved.status === 200, `got ${saved.status}`);

    // 持久化落在 profile home 下的 JSON 文件里
    const rec = h.readConfigFile();
    check('配置文件已写出', rec !== undefined, 'config file missing');
    if (rec) {
      check('文件里口令已更新', rec.password === 'new-pass', `got ${rec.password}`);
      check('文件里端口正确', Number(rec.listenPort) === relayPort, `got ${rec.listenPort}`);
      check('文件里没有派生字段', rec.autoSessionWanted === undefined, JSON.stringify(Object.keys(rec)));
    }

    const statusAfter = JSON.parse((await callRoute(host, 'GET', '/dsh-public-relay/status')).body);
    check('新口令立即生效（hasPassword=true）', statusAfter.hasPassword === true, `got ${statusAfter.hasPassword}`);
    check('status 回报配置文件路径', statusAfter.configFile === path.join(h.home, 'dsh-public-relay.json'),
      `got ${statusAfter.configFile}`);
  }

  section('自动会话：口令为空时保存的是「用户原意」');
  {
    // 场景：用户把口令清空、但 autoSession 仍想开着。
    // 归一化会把生效值压成 false（安全硬约束），但**写回存储的必须是原意 true** ——
    // 否则用户下次填回口令时开关已被偷偷关掉，且他完全不知道发生过什么。
    const saved = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { enabled: true, listenPort: relayPort, password: '', autoSession: true } },
      // 当前口令是 'new-pass'（上一段刚写进去的）—— 必须用它鉴权。
      // 注意：这次写入会把口令清空，所以下一段要换成 restored-pw。
      adminAs: 'new-pass',
    });
    check('清空口令 + 开着自动会话 → 写入成功', saved.status === 200, `got ${saved.status} ${saved.body}`);

    const rec = h.readConfigFile();
    check('存储里保留用户原意 autoSession=true',
      rec !== undefined && rec.autoSession === true, JSON.stringify(rec && rec.autoSession));

    const snap = JSON.parse((await callRoute(host, 'GET', '/dsh-public-relay/status')).body);
    check('生效值被压成 false（安全硬约束）', snap.config.autoSession === false, String(snap.config.autoSession));
    check('原意字段仍是 true', snap.config.autoSessionWanted === true, String(snap.config.autoSessionWanted));
    check('status.session 标记被口令为空压掉',
      snap.session && snap.session.blockedByEmptyPassword === true && snap.session.enabled === false,
      JSON.stringify(snap.session));

    // 再把口令填回去 → 开关应自动恢复生效（用户没碰过它）
    const back = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { enabled: true, listenPort: relayPort, password: 'restored-pw', autoSession: true } },
      // 口令刚被上一段清空 → auth 为 null → 只允许回环对端。
      // 这里的 callRoute 正是从 127.0.0.1 发的，所以无需凭据。
    });
    check('填回口令 → 写入成功', back.status === 200, `got ${back.status}`);
    const snap2 = JSON.parse((await callRoute(host, 'GET', '/dsh-public-relay/status')).body);
    check('填回口令后自动会话恢复生效（无需用户再动开关）',
      snap2.config.autoSession === true && snap2.config.autoSessionBlocked === false,
      JSON.stringify({ a: snap2.config.autoSession, b: snap2.config.autoSessionBlocked }));
  }

  section('原型污染防护与响应脱敏');
  {
    const PW = 'restored-pw';   // 上一段结束时生效的口令

    // ── writeConfig 必须剥离 __proto__ / constructor ──
    //
    // JSON.parse 会把 {"__proto__":{...}} 建成自有属性，Object.assign 会
    // 因此触发 Object.prototype 的 setter。这是唯一一处外部对象进原型的口子。
    // body 必须是**字符串**：写成对象字面量的话 __proto__ 会当场改掉原型，
    // 测的就不是插件的防护而是测试自己造出的污染了。
    const polluted = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: `{"config":{"__proto__":{"polluted":"yes"},"constructor":{"x":1},"listenPort":${relayPort}}}`,
      adminAs: PW,
    });
    check('携带 __proto__ 的配置写入仍成功（不 500）', polluted.status === 200,
      `got ${polluted.status} ${polluted.body.slice(0, 160)}`);
    check('Object.prototype 未被污染', ({}).polluted === undefined, `got ${({}).polluted}`);
    check('Object.prototype.constructor 未被改写',
      ({}).constructor === Object, 'constructor clobbered');

    const rec = h.readConfigFile();
    check('落盘文件里没有 __proto__ 键',
      rec !== undefined && !Object.keys(rec).includes('__proto__'),
      JSON.stringify(rec && Object.keys(rec)));

    // ── 403 / 404 响应体不回显攻击者可控的输入 ──
    const evil = await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: 'http://evil.example.com', host: `127.0.0.1:${host.port}` },
      body: { action: 'status' },
      adminAs: PW,
    });
    check('跨源 403', evil.status === 403, `got ${evil.status}`);
    check('403 响应体不回显 origin', !/evil\.example\.com/.test(evil.body), evil.body.slice(0, 200));
    check('403 响应体不回显 host', !evil.body.includes(`127.0.0.1:${dshPort}`), evil.body.slice(0, 200));

    const nf = await callRoute(host, 'GET', '/dsh-public-relay/nope');
    check('未知路由 404', nf.status === 404, `got ${nf.status}`);
    check('404 响应体不回显路由原值', !nf.body.includes('nope'), nf.body.slice(0, 200));

    // ── session.credentialsFile 脱敏（configFile 保持原样，它是给本机 UI 的）──
    const snap = JSON.parse((await callRoute(host, 'GET', '/dsh-public-relay/status')).body);
    const cf = String(snap.session?.credentialsFile ?? '');
    check('session.credentialsFile 只给 basename',
      cf !== '' && !cf.includes('/') && !cf.includes('\\'), cf);
    check('session.credentialsFile 就是约定文件名', cf === '.credentials.yaml', cf);
    check('configFile 仍保留完整路径（给本机 UI 定位用）',
      snap.configFile === path.join(h.home, 'dsh-public-relay.json'), String(snap.configFile));
    check('session 里不含凭据目录的父路径',
      !JSON.stringify(snap.session || {}).includes(h.home), JSON.stringify(snap.session));

    // ── 口令超长被夹取且被告知 ──
    const longRes = await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { password: 'z'.repeat(1000), autoSession: true } },
      adminAs: PW,
    });
    check('超长口令写入成功', longRes.status === 200, `got ${longRes.status}`);
    const snap2 = JSON.parse(longRes.body).status;
    check('status 告知口令已被夹取', snap2.config.passwordTruncated === true,
      String(snap2.config.passwordTruncated));
    check('报告原始长度 1000', snap2.config.passwordRawLength === 1000,
      String(snap2.config.passwordRawLength));
    const rec2 = h.readConfigFile();
    check('落盘口令是 512 而非 1000', String(rec2.password).length === 512,
      String(rec2.password).length);

    // 复原成短口令，供后续用例使用
    await callRoute(host, 'POST', '/dsh-public-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { password: PW, autoSession: true } },
      adminAs: 'z'.repeat(512),
    });
  }

  section('effect 清理 = 停中转 + 释放端口');
  {
    await callRoute(host, 'POST', '/dsh-public-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'start' },
      adminAs: 'restored-pw',
    });
    check('清理前端口在监听', await portListening(relayPort) === true, 'not listening before cleanup');

    // 触发插件卸载（Cordis 卸载时跑 effect 的 cleanup）
    for (const e of h.effects) {
      if (typeof e.cleanup === 'function') e.cleanup();
    }
    await new Promise((r) => setTimeout(r, 800));

    check('清理后端口已释放', await portListening(relayPort) === false, `port ${relayPort} still listening`);
    check('清理后路由已注销', h.routes.has('/dsh-public-relay') === false, 'route still registered');
    await host.close();
  }

  section('端口被占用时插件不崩');
  {
    const squatter = http.createServer(() => {});
    await new Promise((r) => squatter.listen(relayPort, '127.0.0.1', r));

    const dshPort2 = await freePort();
    const h2 = makeCtx({ webPort: dshPort2 });
    applyFn(h2.ctx, {
      enabled: true, listenHost: '127.0.0.1', listenPort: relayPort, password: 'x', forceLoopback: true,
    });
    const host2 = await startRouteHost(h2.routes);
    await new Promise((r) => setTimeout(r, 600));

    const st = JSON.parse((await callRoute(host2, 'GET', '/dsh-public-relay/status')).body);
    check('state=error', st.state === 'error', `got ${st.state}`);
    check("lastError='port-in-use'", st.lastError === 'port-in-use', `got ${st.lastError}`);
    check('路由仍可用（插件没崩）', st.dshPort === dshPort2, `got ${st.dshPort}`);

    await new Promise((r) => squatter.close(r));
    await callRoute(host2, 'POST', '/dsh-public-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort2}` },
      body: { action: 'start' },
      adminAs: 'x',
    });
    const st2 = JSON.parse((await callRoute(host2, 'GET', '/dsh-public-relay/status')).body);
    check('占用解除后能启用', st2.state === 'running', `got ${st2.state} / ${st2.lastError}`);

    for (const e of h2.effects) if (typeof e.cleanup === 'function') e.cleanup();
    await new Promise((r) => setTimeout(r, 500));
    await host2.close();
  }

  section('可选工具注册（tools 服务缺失时不该让插件崩）');
  {
    // 真实的 dsh-tools 在本机可解析，所以这条路径应该真的注册成功。
    // 参数形状写错会在注册期抛 "unsupported JSON schema: parameters.type ..."，
    // 这里用真 defineTool 校验形状，避免回归。
    const toolsDir = await import('node:fs').then((fs) => fs.existsSync(
      'C:/Users/LIU/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/package.json',
    ));
    if (!toolsDir) {
      console.log('  · 跳过：本机没有 @deepseek-ai/dsh-tools');
    } else {
      let defineTool;
      try {
        ({ defineTool } = await import(
          pathToFileURL('C:/Users/LIU/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js').href
        ));
      } catch (err) {
        console.log(`  · 跳过：无法 import dsh-tools（${err.message}）`);
      }
      if (defineTool) {
        // relay_control 的 parameters 形状：必须是属性表，不能是 JSON Schema 包装
        let controlOk = true;
        let controlErr = '';
        try {
          defineTool({
            name: 'relay_control_test',
            description: 'shape check',
            parameters: { action: { type: 'string', required: true, description: 'x' } },
            output: { schema: { type: 'json' }, render: () => [] },
            execute: async () => ({}),
          });
        } catch (err) {
          controlOk = false;
          controlErr = err?.message || String(err);
        }
        check('relay_control 的参数形状被 defineTool 接受', controlOk, controlErr);

        // 反向对照：JSON Schema 包装形式应当被拒（确认测试确实能发现该错误）
        let badRejected = false;
        try {
          defineTool({
            name: 'relay_control_bad_shape',
            description: 'shape check',
            parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
            output: { schema: { type: 'json' }, render: () => [] },
            execute: async () => ({}),
          });
        } catch {
          badRejected = true;
        }
        check('JSON Schema 包装形式确实会被拒（对照）', badRejected, 'bad shape was accepted — test is not discriminating');
      }
    }
  }

  section('配置 enabled=false 时不自动启动');
  {
    const quietPort = await freePort();
    const somePort = await freePort();
    const h3 = makeCtx({ webPort: quietPort });
    applyFn(h3.ctx, { enabled: false, listenPort: somePort, password: 'x' });
    const host3 = await startRouteHost(h3.routes);
    await new Promise((r) => setTimeout(r, 500));

    const st = JSON.parse((await callRoute(host3, 'GET', '/dsh-public-relay/status')).body);
    check('state=stopped', st.state === 'stopped', `got ${st.state} / ${st.lastError}`);
    check('未占用端口', await portListening(somePort) === false, `port ${somePort} unexpectedly listening`);
    check('仍能读到 dsh 端口', st.dshPort === quietPort, `got ${st.dshPort}`);

    // 关掉之后仍可手动启用
    await callRoute(host3, 'POST', '/dsh-public-relay/control', {
      headers: { origin: `http://127.0.0.1:${quietPort}` },
      body: { action: 'start' },
      adminAs: 'x',
    });
    const st2 = JSON.parse((await callRoute(host3, 'GET', '/dsh-public-relay/status')).body);
    check('enabled=false 后仍可手动启用', st2.state === 'running', `got ${st2.state} / ${st2.lastError}`);

    for (const e of h3.effects) if (typeof e.cleanup === 'function') e.cleanup();
    await new Promise((r) => setTimeout(r, 400));
    await host3.close();
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`宿主半集成测试全部通过：${passed} 项断言 ✅`);
    process.exitCode = 0;
    return;
  }
  console.error(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n集成测试自身异常：', err);
process.exitCode = 1;
});
