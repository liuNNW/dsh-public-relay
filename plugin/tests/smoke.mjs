#!/usr/bin/env node
/**
 * smoke.mjs — dsh-public-relay 插件验收测试（不依赖 dsh 运行）
 *
 * 直接拿 lib/relay.js 与一个 stub 上游 http server 对打，覆盖：
 *   Host/Origin 改写、口令认证全流程、cookie 验签、bundle 改写、
 *   WebSocket 透传、stop 真放端口、端口占用不崩进程。
 *
 * 运行：node plugin/tests/smoke.mjs
 * 退出码 0 = 全绿；非 0 = 有失败（失败清单打到 stderr）。
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRelay, patchIsLoopback, isLoopbackPatchTarget } from '../dsh-public-relay/lib/relay.js';
import { normalizeConfig, DEFAULTS } from '../dsh-public-relay/lib/config.js';

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

function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

function fail(name, detail) {
  failures.push({ name, detail });
  console.error(`  ✗ ${name}\n      ${detail}`);
}

function check(name, condition, detail) {
  if (condition) ok(name);
  else fail(name, detail || 'assertion failed');
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

/**
 * 加载 `ws`（dsh 自带，不在本仓库的依赖里）。
 *
 * 解析顺序与插件的 `loadWs()` 一致：先 `import('ws')`（profile 里若有提升的
 * 副本就能命中），再回退到 dsh 自带的那份。都拿不到就返回 null ——
 * 此时中转会回退裸 pipe，测试跳过帧代理断言而不是判失败。
 */
let wsModuleCache;
async function loadWsOrNull() {
  if (wsModuleCache !== undefined) return wsModuleCache;
  const candidates = [
    'ws',
    `file:///${(process.env.USERPROFILE || '').replace(/\\/g, '/')}/.dsh/profiles/desktop/node_modules/ws/wrapper.mjs`,
    `file:///${(process.env.USERPROFILE || '').replace(/\\/g, '/')}/.dsh/profiles/node_modules/ws/wrapper.mjs`,
  ];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      const WebSocket = mod.default ?? mod.WebSocket;
      const WebSocketServer = mod.WebSocketServer;
      if (typeof WebSocket === 'function' && typeof WebSocketServer === 'function') {
        wsModuleCache = { default: WebSocket, WebSocket, WebSocketServer };
        return wsModuleCache;
      }
    } catch { /* 试下一个 */ }
  }
  wsModuleCache = null;
  return null;
}

/** 取一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 极简 HTTP 请求（绕过 keep-alive 干扰测试）。 */
function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: options.method || 'GET',
      path,
      headers: { connection: 'close', ...(options.headers || {}) },
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('client timeout')));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** 探测端口是否已被释放（能连上 = 仍在监听）。 */
function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (val) => {
      socket.destroy();
      resolve(val);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

/**
 * 起一个 stub 上游：记录收到的头，并回一个含 isLoopback 的假 bundle。
 *
 * 它还模拟 dsh 的**启动令牌交换**（GET /?token=XXX）：
 *   · token 合法 → 下发 Set-Cookie（名字绑定请求的 authority）+ 302 到 ./
 *   · token 非法/缺失 → 401，正文就是 dsh 那句报错
 * 用来验证中转插件不会把这个交换吃掉。
 */
function startUpstream() {
  const seen = [];
  /** 模拟 dsh：token 交换会按 authority 签一个 cookie，名字随 authority 变。 */
  const issuedCookies = [];
  const bundleSource = [
    'const pageLocation = window.location;',
    'const handle = {',
    '  api,',
    '  isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
    '  hostDescription: {},',
    '};',
  ].join('\n');

  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });

    // —— 模拟 dsh 的授权：只在 GET / 且带正确 token 时签发 cookie ——
    const url = new URL(req.url, 'http://placeholder');
    if (req.method === 'GET' && url.pathname === '/') {
      const token = url.searchParams.get('token');
      if (token === 'GOODTOKEN') {
        const authority = req.headers.host || 'unknown';
        const cookieName = 'dsh-auth-' + Buffer.from(authority).toString('base64url');
        issuedCookies.push({ authority, cookieName });
        res.writeHead(302, {
          'set-cookie': `${cookieName}=signed.${Buffer.from(authority).toString('base64url')}; Path=/; HttpOnly; SameSite=Strict`,
          location: './',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.');
      return;
    }

    if (req.url === '/plugins/??@deepseek-ai/dsh-client-connection/client.js&rev=aaa') {
      // 模拟 dsh 的真实行为：声明了 gzip 就压着回来，并给强缓存头。
      // 中转必须「解压 → 改写 → 按原编码压回」，且保留缓存语义。
      const accept = String(req.headers['accept-encoding'] || '');
      const wantsGzip = accept.includes('gzip');
      const body = wantsGzip ? zlib.gzipSync(bundleSource) : Buffer.from(bundleSource);
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        ...(wantsGzip ? { 'content-encoding': 'gzip' } : {}),
        'content-length': body.length,
      });
      res.end(body);
      return;
    }
    // 白名单之外的同形状 bundle：必须原样透传（保持 gzip、不被缓冲）
    if (req.url === '/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=bbb') {
      const accept = String(req.headers['accept-encoding'] || '');
      const wantsGzip = accept.includes('gzip');
      const payload = 'export const chat = 1; // isLoopback: not really\n'.repeat(2000);
      const body = wantsGzip ? zlib.gzipSync(payload) : Buffer.from(payload);
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        ...(wantsGzip ? { 'content-encoding': 'gzip' } : {}),
        'content-length': body.length,
      });
      res.end(body);
      return;
    }
    if (req.url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host, origin: req.headers.origin ?? null }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });

  /**
   * 上游的 WebSocket 端点：用真正的 ws 服务端回显。
   *
   * 为什么不能再像以前那样裸 socket 回打字节：中转现在做**帧级代理**，
   * 它会解析 WebSocket 帧并重新编码。裸字节对它来说不是合法帧。
   *
   * 同样**不开** perMessageDeflate —— 真实 dsh 就是这样（默认 false），
   * 正好用来验证「只压浏览器↔中转这一段」。
   */
  const upgradeSockets = new Set();
  let upstreamWss = null;
  const readyWss = loadWsOrNull().then((wsMod) => {
    if (wsMod === null) return;
    upstreamWss = new wsMod.WebSocketServer({ noServer: true });
    upstreamWss.on('connection', (ws) => {
      ws.on('message', (data) => ws.send(data));
    });
    server.on('upgrade', (req, socket, head) => {
      upgradeSockets.add(socket);
      socket.on('close', () => upgradeSockets.delete(socket));
      upstreamWss.handleUpgrade(req, socket, head, (ws) => {
        upstreamWss.emit('connection', ws, req);
      });
    });
  }).catch(() => { /* ws 不可用：保持无 upgrade 支持，相关断言会跳过 */ });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => void readyWss.then(() => resolve({
      server,
      seen,
      issuedCookies,
      port: server.address().port,
      bundleSource,
      /**
       * 关闭 stub 上游。
       *
       * server.close() 只在**所有连接**都关闭后才回调，而升级后的 socket 不在
       * Node 的连接跟踪里，光靠 close() 会永不回调，把测试挂死在收尾处 ——
       * 表现为：结论行不打印、退出码停在默认 0、注入的故障也检不出来。
       * 所以这里主动断开，并加超时兜底。
       */
      close: () => new Promise((r) => {
        let done = false;
        const fin = () => { if (!done) { done = true; r(); } };
        const timer = setTimeout(fin, 2000);
        for (const s of [...upgradeSockets]) { try { s.destroy(); } catch { /* 已关 */ } }
        try { upstreamWss?.close(); } catch { /* 已关 */ }
        try { server.closeAllConnections?.(); } catch { /* 老版本 Node */ }
        server.close(() => { clearTimeout(timer); fin(); });
      }),
    })));
  });
}

// ═══════════════════════════ 主流程 ═══════════════════════════

async function main() {
  // ═══ isLoopback 结构化改写（不依赖「候选正则命中」）═══
  //
  // 0.1.x 时代用三条候选正则匹配 dsh 的原文。dsh 一改写法（0.2.x 在判据前面
  // 又加了 `transport?.ownsHost === true ||`）正则就失配，特征还是静默的：
  // 日志里只有一句「未找到目标模式」，公网侧插件列表悄悄变空。
  // 现在改成「找键名 → 按括号深度取整个值表达式 → 整段替换」，与写法无关。
  section('isLoopback 结构化改写');
  {
    const currentShape = 'const h = { api, isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname), generation: 1 };';
    const r1 = patchIsLoopback(currentShape);
    check('0.2.x 写法（含 transport?.ownsHost）被命中', r1.hits === 1, `hits=${r1.hits}`);
    check('改写后值是裸 true', r1.body.includes('isLoopback: true'), r1.body.slice(0, 160));
    check('后续字段未被吞掉', r1.body.includes('generation: 1'), r1.body.slice(0, 160));

    const oldShape = 'const h = {\n  isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),\n  hostDescription: {},\n};';
    const r2 = patchIsLoopback(oldShape);
    check('0.1.x 写法也被命中', r2.hits === 1 && r2.body.includes('isLoopback: true'), r2.body);
    check('多行形态下后续字段保留', r2.body.includes('hostDescription: {}'), r2.body);

    // 不能误改：字段名只是前缀相同、或压根没有这个字段
    const noHit1 = patchIsLoopback('const foo = { isLoopbacking: 1 };');
    check('字段名只是前缀相同时不改', noHit1.hits === 0 && noHit1.body.includes('isLoopbacking: 1'), noHit1.body);
    const noHit2 = patchIsLoopback('function f(){ return 1 }');
    check('没有该字段时不改', noHit2.hits === 0 && noHit2.body === 'function f(){ return 1 }', noHit2.body);
    // 值表达式里既没有 isLoopback 也没有 ownsHost/pageLocation → 不是我们要改的
    const noHit3 = patchIsLoopback('const h = { isLoopback: true };');
    check('值里没有相关标识符时不改（防误伤）', noHit3.hits === 0, noHit3.body);

    // 字符串里的同名文本不能被当成代码改
    const inString = 'const s = "isLoopback: pageLocation"; const h = { isLoopback: pageLocation === void 0 };';
    const r3 = patchIsLoopback(inString);
    check('字符串字面量里的同名文本不被改写',
      r3.body.includes('"isLoopback: pageLocation"'), r3.body);
  }

  section('配置归一化');
  {
    const c = normalizeConfig({
      enabled: 'yes',            // 非 false → true
      listenPort: '99999',       // 越界 → 夹到 65535
      listenHost: '   ',
      targetPort: '',            // 空 → null（自动取 dsh 端口）
      password: 12345,           // 非字符串 → 转字符串
      forceLoopback: 0,          // 非 false → true
    });
    check('越界端口被夹到 65535', c.listenPort === 65535, `got ${c.listenPort}`);
    check('空白 listenHost 退回默认', c.listenHost === DEFAULTS.listenHost, `got ${c.listenHost}`);
    check('空 targetPort 归一为 null', c.targetPort === null, `got ${c.targetPort}`);
    check('数字口令转字符串', c.password === '12345', `got ${JSON.stringify(c.password)}`);
    check('enabled 非 false 即 true', c.enabled === true, `got ${c.enabled}`);
    check('forceLoopback 非 false 即 true', c.forceLoopback === true, `got ${c.forceLoopback}`);

    const d = normalizeConfig({ listenPort: 0, targetPort: 0 });
    check('端口 0 被保留（OS 自动分配）', d.listenPort === 0, `got ${d.listenPort}`);
    check('targetPort 0 归一为 null', d.targetPort === null, `got ${d.targetPort}`);
  }

  const upstream = await startUpstream();
  const relayPort = await freePort();
  const password = 'test-pass-42';

  let config = normalizeConfig({
    enabled: true,
    listenHost: '127.0.0.1',
    listenPort: relayPort,
    targetHost: '127.0.0.1',
    targetPort: upstream.port,
    password,
    forceLoopback: true,
  });

  const relay = createRelay({
    getDshEndpoint: () => ({ host: '127.0.0.1', port: upstream.port }),
    getConfig: () => config,
    log: () => {},
  });

  section('启动');
  {
    const st = await relay.start();
    check('state=running', st.state === 'running', `got ${st.state} / ${st.lastError}`);
    check('监听端口正确', st.listen.port === relayPort, `got ${st.listen.port}`);
    check('上游目标正确', st.target?.origin === `http://127.0.0.1:${upstream.port}`, `got ${st.target?.origin}`);
    check('hasPassword=true', st.hasPassword === true, `got ${st.hasPassword}`);
  }

  section('认证');
  {
    const r401 = await request(relayPort, '/api/ping');
    check('无 cookie → 401', r401.status === 401, `got ${r401.status}`);

    const page = await request(relayPort, '/');
    check('未登录 GET / → 登录页', page.status === 200 && page.body.toString().includes('访问口令'),
      `got ${page.status} / ${page.body.toString().slice(0, 80)}`);

    const bad = await request(relayPort, '/__login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong',
    });
    check('错误口令 → 401 + 错误提示', bad.status === 401 && bad.body.toString().includes('口令错误'),
      `got ${bad.status}`);

    const t0 = Date.now();
    await request(relayPort, '/__login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong',
    });
    const elapsed = Date.now() - t0;
    check('失败固定延时 ≥400ms（拖慢爆破）', elapsed >= 390, `elapsed ${elapsed}ms`);

    const good = await request(relayPort, '/__login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(password)}`,
    });
    check('正确口令 → 302', good.status === 302, `got ${good.status}`);
    const setCookie = good.headers['set-cookie']?.[0] || '';
    check('下发 relay_session cookie', setCookie.startsWith('relay_session='), `got ${setCookie.slice(0, 40)}`);
    check('cookie 带 HttpOnly + SameSite', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), setCookie);

    const cookie = setCookie.split(';')[0];

    // 验签：改一位签名必须被拒
    const [payload, sig] = cookie.split('=')[1].split('.');
    const tamperedSig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    const tampered = await request(relayPort, '/api/ping', { headers: { cookie: `relay_session=${payload}.${tamperedSig}` } });
    check('篡改签名 → 拒绝', tampered.status === 401, `got ${tampered.status}`);

    // 构造过期 payload + 正确签名（拿不到密钥就用原 cookie 的 payload 验正常路径）
    const authed = await request(relayPort, '/api/ping', { headers: { cookie } });
    check('有效 cookie → 放行', authed.status === 200, `got ${authed.status}`);

    // ═══ dsh 启动令牌交换必须被放行（不能被本插件的登录页吃掉）═══
    //
    // 这是最难排查的一类 bug：dsh 的浏览器认证是一次性 token 交换，
    // 只在 `GET /?token=...` 完成。若中转的口令认证把它拦下返回登录页，
    // token 永远到不了 dsh，它的会话 Cookie 一签不出来，用户会一直看到
    //   dsh web authentication required; reopen the URL printed by dsh web
    // 而且再怎么输中转口令也没用 —— 那是两套互不相通的认证。
    section('dsh 启动令牌交换放行');
    {
      // 不带任何 cookie，只带 token：应被转发到上游，而不是返回登录页
      const swap = await request(relayPort, '/?token=GOODTOKEN');
      const bodyText = swap.body.toString();
      check('无 cookie 的 ?token= 请求不被本插件拦下（不返回登录页）',
        !bodyText.includes('dsh-public-relay 访问口令'),
        `返回了登录页，正文前 80 字：${bodyText.slice(0, 80)}`);
      check('上游收到了该请求（status=302）', swap.status === 302, `got ${swap.status}`);
      const cookieHdr = swap.headers['set-cookie']?.[0] || '';
      check('上游下发的 Set-Cookie 被原样透传', cookieHdr.startsWith('dsh-auth-'), `got ${cookieHdr.slice(0, 60)}`);
      check('响应 Location 指向 ./', swap.headers.location === './', `got ${swap.headers.location}`);

      // 关键：cookie 必须绑定「浏览器实际访问的 authority」，而不是上游回环权威。
      // 若这里被改写成 127.0.0.1:<dshPort>，浏览器取不出 cookie，就会一直 401。
      const hostSeen = upstream.seen.filter((x) => String(x.url).includes('token=GOODTOKEN')).pop();
      check('转发时保留了浏览器的 Host（供 dsh 按 authority 签 cookie）',
        hostSeen && hostSeen.headers.host === `127.0.0.1:${relayPort}`,
        `上游看到的 Host = ${hostSeen && hostSeen.headers.host}`);
      const issued = upstream.issuedCookies.pop();
      check('上游按该 authority 签发了 cookie',
        issued && issued.authority === `127.0.0.1:${relayPort}`,
        JSON.stringify(issued));

      // 坏 token：上游应给出它自己的报错，而不是被中转改写
      const badSwap = await request(relayPort, '/?token=WRONG');
      check('坏 token 时上游的 401 正文原样透传',
        badSwap.status === 401 && badSwap.body.toString().includes('authentication required'),
        `got ${badSwap.status} / ${badSwap.body.toString().slice(0, 60)}`);

      // 不带 token 的裸 GET / 仍应是本插件的登录页（两层认证都在）
      const bare = await request(relayPort, '/');
      check('无 token 的裸访问仍是本插件登录页',
        bare.status === 200 && bare.body.toString().includes('dsh-public-relay 访问口令'),
        `got ${bare.status}`);
    }

    // 伪造：自己用随机密钥签一个 payload
    const fakeSecret = crypto.createHmac('sha256', 'dsh-public-relay').update('other-password').digest();
    const fakePayload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString('base64url');
    const fakeSig = crypto.createHmac('sha256', fakeSecret).update(fakePayload).digest('base64url');
    const forged = await request(relayPort, '/api/ping', {
      headers: { cookie: `relay_session=${fakePayload}.${fakeSig}` },
    });
    check('别的口令签出的 token → 拒绝', forged.status === 401, `got ${forged.status}`);

    // ═══ 以下是"已认证"状态下的代理行为，共用一个 cookie ═══
    section('Header 改写（过信任栅栏）');
    {
      const r = await request(relayPort, '/api/ping', {
        headers: { cookie, host: 'evil.example.com:1234', origin: 'http://evil.example.com:1234' },
      });
      check('代理返回 200', r.status === 200, `got ${r.status}`);
      const body = JSON.parse(r.body.toString());
      check('上游看到的 Host 被改写为回环权威', body.host === `127.0.0.1:${upstream.port}`, `got ${body.host}`);
      check('上游看到的 Origin 被改写为同权威', body.origin === `http://127.0.0.1:${upstream.port}`, `got ${body.origin}`);
    }

    section('force-loopback 改写（目标集 + 压缩保持）');
    {
      const TARGET_URL = '/plugins/??@deepseek-ai/dsh-client-connection/client.js&rev=aaa';
      const OTHER_URL = '/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=bbb';

      // ── 目标集判定本身 ──
      check('isLoopbackPatchTarget 命中白名单包', isLoopbackPatchTarget(TARGET_URL) === true,
        `got ${isLoopbackPatchTarget(TARGET_URL)}`);
      check('isLoopbackPatchTarget 放过非白名单包', isLoopbackPatchTarget(OTHER_URL) === false,
        `got ${isLoopbackPatchTarget(OTHER_URL)}`);
      check('isLoopbackPatchTarget 不误命中 SSE 路径', isLoopbackPatchTarget('/plugins/events') === false,
        `got ${isLoopbackPatchTarget('/plugins/events')}`);
      check('isLoopbackPatchTarget 命中批量 combo 里的白名单包',
        isLoopbackPatchTarget('/plugins/??a/client.js,@deepseek-ai/dsh-client-connection/client.js&rev=c') === true,
        'mixed combo not matched');

      // ── 目标包：解压 → 改写 → 按原编码压回，且保留强缓存 ──
      const r = await request(relayPort, TARGET_URL, {
        headers: { cookie, 'accept-encoding': 'gzip' },
      });
      check('目标包返回 200', r.status === 200, `got ${r.status}`);
      check('目标包仍以 gzip 传输（没有被降级成明文）',
        String(r.headers['content-encoding'] || '') === 'gzip',
        `got ${r.headers['content-encoding']}`);
      const decoded = zlib.gunzipSync(r.body).toString('utf-8');
      check('解压后 isLoopback 被改成 true', decoded.includes('isLoopback: true'), decoded.slice(0, 200));
      check('原判定式已不存在', !decoded.includes('isLoopbackHostname(pageLocation.hostname)'), decoded.slice(0, 200));
      check('content-length 等于压缩后字节数',
        Number(r.headers['content-length']) === r.body.length,
        `header=${r.headers['content-length']} actual=${r.body.length}`);
      check('保留上游强缓存（不再强制 no-store）',
        String(r.headers['cache-control'] || '').includes('immutable'),
        `got ${r.headers['cache-control']}`);

      // ── 非目标包：必须原样透传，压缩不被绕过 ──
      const rOther = await request(relayPort, OTHER_URL, {
        headers: { cookie, 'accept-encoding': 'gzip' },
      });
      check('非目标包返回 200', rOther.status === 200, `got ${rOther.status}`);
      check('非目标包保持 gzip（这是启动流量不膨胀的关键）',
        String(rOther.headers['content-encoding'] || '') === 'gzip',
        `got ${rOther.headers['content-encoding']}`);
      check('非目标包字节数与上游一致（没有解压重传）',
        rOther.body.length === Number(rOther.headers['content-length'] || rOther.body.length),
        `body=${rOther.body.length}`);
      check('非目标包保留强缓存',
        String(rOther.headers['cache-control'] || '').includes('immutable'),
        `got ${rOther.headers['cache-control']}`);

      // 关闭 force-loopback 后目标包也应按原样透传
      config = { ...config, forceLoopback: false };
      const r2 = await request(relayPort, TARGET_URL, {
        headers: { cookie, 'accept-encoding': 'gzip' },
      });
      const decoded2 = zlib.gunzipSync(r2.body).toString('utf-8');
      check('forceLoopback=false 时原样透传',
        decoded2.includes('isLoopbackHostname(pageLocation.hostname)'),
        decoded2.slice(0, 200));
      config = { ...config, forceLoopback: true };
    }

    section('WebSocket 帧代理（含 permessage-deflate）');
    {
      // 中转现在对 WS 做**帧级代理**（而不是裸 pipe）：浏览器侧开压缩、
      // 上游侧不开。这样「切会话要拉的 4.6 MB 历史」在隧道上只剩约 1/6。
      // 测试用真实 ws 客户端，因为裸 socket 写裸字节已经不是合法帧了。
      const wsMod = await loadWsOrNull();
      if (wsMod === null) {
        console.log('  · 跳过：本机解析不到 ws（该路径会回退裸 pipe，属预期降级）');
      } else {
        const { default: WS } = wsMod;

        /** 开一条 WS，发一条文本，收一条回显。 */
        const roundtrip = (compress, payload) => new Promise((resolve) => {
          const ws = new WS(`ws://127.0.0.1:${relayPort}/ws`, {
            headers: { cookie },
            ...(compress ? { perMessageDeflate: true } : {}),
          });
          const timer = setTimeout(() => { try { ws.terminate(); } catch { /* 已关 */ } resolve({ ok: false, reason: 'timeout' }); }, 5000);
          ws.on('open', () => {
            ws.send(payload);
          });
          ws.on('message', (data) => {
            clearTimeout(timer);
            const echo = String(data);
            try { ws.terminate(); } catch { /* 已关 */ }
            resolve({ ok: true, echo, extensions: ws.extensions || '(none)' });
          });
          ws.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, reason: err.message }); });
        });

        const plain = await roundtrip(false, 'hello-relay');
        check('WS 握手成功', plain.ok, plain.reason || 'no echo');
        check('双向数据透传一致', plain.echo === 'hello-relay', `echo=${JSON.stringify(plain.echo)}`);

        // 浏览器声明压缩 → 中转侧应协商成功
        const compressed = await roundtrip(true, 'x'.repeat(200000));
        check('浏览器侧协商了 permessage-deflate',
          compressed.ok && String(compressed.extensions).includes('permessage-deflate'),
          `extensions=${compressed && compressed.extensions}`);
        check('大帧压缩后仍能正确透传（内容完整）',
          compressed.ok && compressed.echo.length === 200000,
          `len=${compressed.echo ? compressed.echo.length : 'n/a'}`);

        // 关掉压缩开关后应退回不协商
        config = { ...config, compressWebSocket: false };
        const off = await roundtrip(true, 'hello-relay');
        check('compressWebSocket=false 时不协商压缩',
          off.ok && !String(off.extensions).includes('permessage-deflate'),
          `extensions=${off && off.extensions}`);
        check('关闭压缩后载荷仍正确', off.echo === 'hello-relay', `echo=${JSON.stringify(off.echo)}`);
        config = { ...config, compressWebSocket: true };
      }
    }

    section('未认证的 upgrade 被拒');
    {
      const result = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: relayPort });
        let buf = '';
        const timer = setTimeout(() => { sock.destroy(); resolve(buf); }, 3000);
        sock.on('connect', () => {
          sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        });
        sock.on('data', (d) => { buf += d.toString(); });
        sock.on('close', () => { clearTimeout(timer); resolve(buf); });
        sock.on('error', () => { clearTimeout(timer); resolve(buf); });
      });
      check('无 cookie 的 upgrade → 401', result.includes('401'), result.slice(0, 80));
    }
  }

  section('stop 真正释放端口');
  {
    await relay.stop();
    const still = await portListening(relayPort);
    check('stop 后端口不再监听', still === false, `port ${relayPort} still accepting connections`);

    const st = relay.status();
    check('status 回到 stopped', st.state === 'stopped', `got ${st.state}`);

    await relay.stop();
    ok('重复 stop 幂等不抛错');

    const again = await relay.start();
    check('同一端口可重新绑定', again.state === 'running', `got ${again.state} / ${again.lastError}`);
    await relay.stop();
  }

  section('端口占用不退出进程');
  {
    const squatter = http.createServer(() => {});
    await new Promise((r) => squatter.listen(relayPort, '127.0.0.1', r));

    const st = await relay.start();
    check('state=error', st.state === 'error', `got ${st.state}`);
    check("lastError='port-in-use'", st.lastError === 'port-in-use', `got ${st.lastError}`);

    const alive = relay.status();
    check('实例仍可用（进程没崩）', typeof alive.state === 'string', 'status threw');

    await new Promise((r) => squatter.close(r));
    const retry = await relay.start();
    check('占用解除后能正常启动', retry.state === 'running', `got ${retry.state} / ${retry.lastError}`);
    await relay.stop();
  }

  section('上游不可达 → 502');
  {
    const deadPort = await freePort();
    const deadRelayPort = await freePort();
    const dead = createRelay({
      getDshEndpoint: () => ({ host: '127.0.0.1', port: deadPort }),
      getConfig: () => normalizeConfig({
        listenPort: deadRelayPort, password: '', forceLoopback: false,
      }),
      log: () => {},
    });
    const st = await dead.start();
    check('死端口上仍能启动中转', st.state === 'running', `got ${st.state}`);
    const r = await request(deadRelayPort, '/api/ping');
    check('上游不可达返回 502', r.status === 502, `got ${r.status}`);
    check('502 文案含上游地址', r.body.toString().includes(`127.0.0.1:${deadPort}`), r.body.toString().slice(0, 120));
    // 空口令 = 关闭认证
    check('空口令时 hasPassword=false', dead.status().hasPassword === false, 'auth unexpectedly on');
    await dead.stop();
  }

  await upstream.close();

  // ═══════════════════════════ 结论 ═══════════════════════════
  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`全部通过：${passed} 项断言 ✅`);
    process.exitCode = 0;
    return;
  }
  console.error(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nsmoke 测试自身异常：', err);
process.exitCode = 1;
});
