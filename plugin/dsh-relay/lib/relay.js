/**
 * relay.js — DSH 中转核心（纯库，无进程副作用）
 *
 * 移植自工作区根的 dsh-relay.js，改动集中在四处「独立进程假设」：
 *   1. 删除 process.exit() / fail() / 打印 HELP —— 改抛异常或记入 lastError；
 *   2. 删除整个 dsh web watchdog（startDshWeb/stopDshWeb/快速崩溃/心跳/SIGINT）——
 *      插件就跑在 dsh 进程内，没有子进程可守，宿主本身不会退出；
 *   3. EADDRINUSE 不再退出，记 lastError='port-in-use' 并保持 stopped，交给 UI；
 *   4. 上游 target 惰性求值（默认取本进程 webServer 的真实端口），不再写死 3080。
 *
 * 另外 stop() 真正释放端口：server.close() 只停止接受新连接，
 * keep-alive 连接与已升级的 WebSocket 会让端口继续挂着，必须逐个 destroy。
 */
'use strict';

import http from 'node:http';
import crypto from 'node:crypto';

// ─────────────────────────── 常量 ───────────────────────────

/** force-loopback 要改写的 client bundle 路径。 */
export const CONN_BUNDLE_PATHNAME = '/plugins/@deepseek-ai/dsh-client-connection/client.js';

/**
 * isLoopback 判定式的候选正则。
 *
 * 第一个是当前 dsh rc.8 的精确原文（已实测匹配）：
 *   isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),
 * 其后两个容忍 dsh 升级后的空白/换行漂移。全部失配时按原样透传并告警，
 * 绝不错改其它内容。
 */
export const LOOPBACK_PATTERNS = [
  /isLoopback:\s+pageLocation === void 0 \|\| isLoopbackHostname\(pageLocation\.hostname\)/g,
  /isLoopback:\s*pageLocation\s*===\s*void 0\s*\|\|\s*isLoopbackHostname\(\s*pageLocation\.hostname\s*\)/g,
  /isLoopback:\s*[A-Za-z_$][\w$]*\s*===\s*void 0\s*\|\|\s*isLoopbackHostname\(/g,
];

/** hop-by-hop 头：逐跳语义不能透传；upgrade 场景单独保留 connection/upgrade。 */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

const UPSTREAM_CONNECT_TIMEOUT_MS = 15000;
const STOP_DRAIN_TIMEOUT_MS = 2000;

// ─────────────────────────── 头部工具 ───────────────────────────

/** 改写 Host/Origin 为上游回环权威，过 dsh 的信任栅栏；剥离 hop-by-hop 头。 */
export function rewriteHeaders(headers, forUpgrade, target) {
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

export function stripHopByHop(headers) {
  const h = { ...headers };
  for (const k of HOP_BY_HOP) delete h[k];
  return h;
}

export function serializeHeaders(headers) {
  let out = '';
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    for (const val of Array.isArray(v) ? v : [v]) out += `${k}: ${val}\r\n`;
  }
  return out;
}

/** 把 host/port 组成 URL 权威（IPv6 补方括号）。 */
export function authorityOf(host, port) {
  const h = String(host).replace(/^\[|\]$/g, '');
  const needsBrackets = h.includes(':');
  const shown = needsBrackets ? `[${h}]` : h;
  return port === 80 || port === undefined || port === null ? shown : `${shown}:${port}`;
}

/** 由 host/port 产出连接参数 + 权威（authority）与 origin。 */
export function resolveTarget(host, port) {
  const authority = authorityOf(host, port);
  return { hostname: host, port, authority, origin: `http://${authority}` };
}

// ─────────────────────────── 口令认证 ───────────────────────────

/** HMAC-SHA256 签名 Cookie 会话；空口令返回 null（关闭认证）。 */
export function makeAuth(password) {
  if (!password) return null;
  const secret = crypto.createHmac('sha256', 'dsh-relay').update(password).digest();
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

  return { cookieName, signToken, verifyToken, parseCookies, COOKIE_TTL_MS, LOGIN_PAGE };
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-relay 登录</title>
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
    <h1>dsh-relay 访问口令</h1>
    <p>请输入启动时设置的口令以继续</p>
    <input type="password" name="password" placeholder="口令" autocomplete="off" autofocus required>
    <button type="submit">进入</button>
    __ERR__
  </form>
</body>
</html>`;

/**
 * 判断这是否是 **dsh 自己的启动令牌交换**请求。
 *
 * dsh 的浏览器认证是一次性 token 交换（见 dsh-client-connection 的
 * browser-auth 说明）：
 *   进程启动 → 生成随机 launchToken → 打印/打开 http://<authority>/?token=XXX
 *   → frontend-static 把它交给 authorizeIndex，**只在 `GET /` 接受该 token**
 *   → 写 `dsh-auth-*` 签名 Cookie（名字与 payload 都绑定 authority）→ 302 到 ./
 *   → 之后每个 RPC 请求都要求这个 Cookie，缺失就 401
 *
 * 这个请求必须**原样透传到上游**。如果被本插件的口令认证拦住（返回登录页），
 * token 就永远到不了 dsh，它的 Cookie 一签不出来，用户会一直看到
 *   dsh web authentication required; reopen the URL printed by dsh web
 * 而且再怎么输本插件的口令也没用 —— 那是两套互不相通的认证。
 *
 * @param req - 入站请求
 * @returns true 表示应放行给上游 dsh
 */
function isDshTokenExchange(req) {
  if (req.method !== 'GET') return false;
  try {
    const url = new URL(req.url, 'http://placeholder');
    return url.searchParams.has('token');
  } catch {
    return false;
  }
}

/**
 * 认证入口：未登录时返回登录页 / 401；处理 POST /__login。
 * @returns true 表示已放行，false 表示本函数已接管响应。
 */
function authGate(req, res, socket, auth, password, log) {
  if (!auth) return true;

  // dsh 的启动令牌交换优先放行 —— 必须早于本插件自己的任何认证判断，
  // 否则 token 被登录页吃掉，dsh 的会话永远建不起来（见函数注释）。
  if (isDshTokenExchange(req)) {
    log?.('info', `放行 dsh 启动令牌交换：${req.url}`);
    return true;
  }

  const token = auth.parseCookies(req)[auth.cookieName];
  if (auth.verifyToken(token)) return true;

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
        if (res) {
          res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('payload too large');
        }
        return;
      }
      const input = new URLSearchParams(body).get('password') || '';
      const ha = crypto.createHash('sha256').update(input).digest();
      const hb = crypto.createHash('sha256').update(password).digest();
      const ok = crypto.timingSafeEqual(ha, hb);
      // 失败延时，拖慢暴力破解
      setTimeout(() => {
        if (!res || res.headersSent) return;
        if (ok) {
          const exp = Date.now() + auth.COOKIE_TTL_MS;
          res.writeHead(302, {
            location: '/',
            'set-cookie': `${auth.cookieName}=${auth.signToken(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(auth.COOKIE_TTL_MS / 1000)}`,
            'cache-control': 'no-store',
          });
          res.end();
        } else {
          log?.('warn', '登录口令错误');
          const page = auth.LOGIN_PAGE.replace('__ERR__', '<div class="err">口令错误，请重试</div>');
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(page);
        }
      }, ok ? 0 : 400);
    });
    return false;
  }

  // 未登录
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    if (res) {
      const page = auth.LOGIN_PAGE.replace('__ERR__', '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    }
    return false;
  }
  if (res) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('dsh-relay: 未登录（需要访问口令）。\n');
  } else if (socket) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\ndsh-relay: 未登录（需要访问口令）');
    socket.destroy();
  }
  return false;
}

// ─────────────────────────── 中转实例 ───────────────────────────

/**
 * 建一个中转实例。
 *
 * @param options.getDshEndpoint - () => { host, port }，本进程 dsh 的真实监听端口（惰性求值）
 * @param options.getConfig      - () => { listenHost, listenPort, password, forceLoopback, targetHost, targetPort, autoSession }
 * @param options.log            - (level, message) => void，可选
 * @param options.sessionSigner  - dsh 会话代签器（createSessionSigner 的返回值）。
 *                                 提供且 autoSession 开启时，会在转发前替浏览器补签
 *                                 dsh 的会话 Cookie，用户只输中转口令即可进入。
 *                                 省略则完全维持原行为（需要 dsh 打印的 ?token=）。
 * @returns { start, stop, status, patchBundle }
 */
export function createRelay(options = {}) {
  const { getDshEndpoint, getConfig, log = () => {}, sessionSigner = null } = options;

  /** @type {import('node:http').Server|null} */
  let server = null;
  /** @type {Set<import('node:net').Socket>} */
  const liveSockets = new Set();
  let running = false;
  let stopping = false;
  let startedAt = 0;
  let lastError = null;
  /** 实际绑定的监听参数（只有它需要重新 listen 才能改）。 */
  let boundListen = null;
  let requestCount = 0;
  /** 按口令缓存 auth 对象：口令变了立即重建，运行中改口令无需重启。 */
  let authCache = { password: undefined, auth: null };

  function cfg() {
    const c = getConfig() ?? {};
    return {
      listenHost: c.listenHost || '127.0.0.1',
      listenPort: Number.isInteger(c.listenPort) ? c.listenPort : 3091,
      password: c.password ?? '',
      forceLoopback: c.forceLoopback !== false,
      targetHost: c.targetHost || null,
      targetPort: c.targetPort == null ? null : Number(c.targetPort),
      // 注意：这是白名单式重建，新增配置项必须在这里显式带上，
      // 否则会静默变成 undefined，让下游的开关形同虚设
      // （autoSession 曾因漏掉这一行而「关不掉」）。
      autoSession: c.autoSession !== false,
    };
  }

  /**
   * 当前生效的认证器。口令是热配置：改了立刻重建，不用重启中转。
   * getConfig() 每次调用都读最新值，所以这里只需按口令值缓存。
   */
  function currentAuth() {
    const password = cfg().password;
    if (authCache.password !== password) {
      authCache = { password, auth: makeAuth(password) };
    }
    return authCache.auth;
  }

  /** 上游目标：显式覆盖优先，否则取本进程 dsh 的真实端口（热读）。 */
  function target() {
    const c = cfg();
    const dsh = getDshEndpoint();
    const host = c.targetHost || dsh.host || '127.0.0.1';
    const port = c.targetPort ?? dsh.port;
    return resolveTarget(host, port);
  }

  function shouldPatchBundle(req, c) {
    if (!c.forceLoopback) return false;
    try {
      return new URL(req.url, 'http://x').pathname === CONN_BUNDLE_PATHNAME;
    } catch {
      return false;
    }
  }

  /**
   * 按需替浏览器补签 dsh 的会话 Cookie，并返回最终要发往上游的头。
   *
   * 为什么绑定 TARGET.authority：转发时 rewriteHeaders 会把 Host 改写成它，
   * 而 dsh 校验 `payload.authority === 本次请求的 Host` —— 两者必须一致，
   * 否则签出来的 cookie 会被判为「authority 不匹配」而拒绝。
   *
   * 失败一律**不注入**并原样转发：退回「需要 dsh 打印的 ?token=」的现状，
   * 不让代签的失败变成完全进不去。
   *
   * @param req    - 入站请求
   * @param forUpgrade - 是否 WebSocket upgrade
   * @param TARGET - 上游目标
   * @param c      - 当前配置
   */
  function prepareForwardHeaders(req, forUpgrade, TARGET, c) {
    const headers = rewriteHeaders(req.headers, forUpgrade, TARGET);

    if (!sessionSigner || c.autoSession === false) return headers;
    // 没有中转口令时不代签：否则等于把 dsh 会话无条件送出去。
    if (!c.password) return headers;

    try {
      const out = sessionSigner.checkout(TARGET.authority, headers.cookie);
      if (out.injected && out.cookieHeader) {
        headers.cookie = out.cookieHeader;
      }
    } catch (err) {
      log('warn', `[dsh-cookie] 代签失败，本次按原样转发：${err?.message || err}`);
    }
    return headers;
  }

  // ── bundle 改写（缓冲代理）──
  function handlePatchedBundle(req, res, TARGET, c) {
    // 走统一的转发头准备：bundle 请求同样需要补签会话 Cookie，
    // 否则浏览器拿不到 authenticated 的页面就会停在 401 页，bundle 也不会被请求。
    const headers = prepareForwardHeaders(req, false, TARGET, c);
    // 剥离压缩，保证上游返回明文，改写才能命中
    delete headers['accept-encoding'];
    headers['accept-encoding'] = 'identity';

    const proxyReq = http.request({
      hostname: TARGET.hostname,
      port: TARGET.port,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    });
    const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);

    proxyReq.on('response', (proxyRes) => {
      clearTimeout(timer);
      const status = proxyRes.statusCode;
      const upstreamHeaders = stripHopByHop(proxyRes.headers);
      const encoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();

      // 非 200 或已压缩 → 原样透传（不改写）
      if (status !== 200 || (encoding && encoding !== 'identity')) {
        if (encoding && encoding !== 'identity') {
          log('warn', `force-loopback: 上游响应已压缩 (${encoding})，已按原样透传`);
        }
        res.writeHead(status, proxyRes.statusMessage, upstreamHeaders);
        proxyRes.pipe(res);
        proxyRes.on('error', () => res.destroy());
        return;
      }

      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const original = Buffer.concat(chunks);
        const body = original.toString('utf-8');

        // 逐个候选正则试，命中即停；全部失配则原样转发并告警
        let patched = body;
        let hit = false;
        for (const re of LOOPBACK_PATTERNS) {
          re.lastIndex = 0;
          patched = body.replace(re, 'isLoopback: true');
          if (patched !== body) {
            hit = true;
            break;
          }
        }

        if (hit) {
          log('info', `force-loopback: 已改写 bundle ${body.length} → ${patched.length} 字节`);
          delete upstreamHeaders['content-length'];
          delete upstreamHeaders['transfer-encoding'];
          upstreamHeaders['content-length'] = Buffer.byteLength(patched, 'utf-8');
          upstreamHeaders['cache-control'] = 'no-store';   // 避免跨版本缓存混乱
          res.writeHead(200, upstreamHeaders);
          res.end(patched);
        } else {
          log('warn', 'force-loopback: 未找到目标模式，可能 dsh 已升级，已按原样转发（公网侧插件列表可能为空）');
          res.writeHead(status, upstreamHeaders);
          res.end(original);
        }
      });
      proxyRes.on('error', () => res.destroy());
    });

    proxyReq.on('error', (err) => {
      clearTimeout(timer);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`relay: 无法连接上游 ${TARGET.origin}（${err.code || err.message}）。\n`);
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

  // ── dsh 启动令牌交换的专门转发 ──

  /**
   * 转发 dsh 的 `GET /?token=...` 令牌交换，并**保留浏览器原始的 Host/Origin**。
   *
   * 为什么不复用 rewriteHeaders：
   *   它把 Host/Origin 写成上游回环权威，是为了过 `isTrustedApiRequest` 的信任栅栏。
   *   但 dsh 的 cookie 名与 payload 都绑定「请求的 authority」：
   *       cookieName(authority) = 'dsh-auth-' + sha256(authority)
   *   若这里把 authority 改写成 127.0.0.1:<dsh端口>，签出的 cookie 就属于那个
   *   权威；而浏览器地址栏里是隧道域名或中转端口，两者不等 → cookie 取不出来
   *   → 永远 `authentication required`。
   *
   * 代价与取舍：保留原始 Host 意味着 `isTrustedApiRequest` 可能拒绝它
   *   （Host 既不是 loopback 也不在 trustedHosts 里 → 403）。
   *   这正是本方案要用户侧做的一件事：把中转对外使用的 authority 写进 dsh 的
   *   `trustedHosts`；或者由下面的 403 回退分支自动改用回环权威重试一次
   *   （cookie 会挂到回环权威，用户需要以该地址访问；见 README 排障）。
   *
   * 因此这里做「先原样、被拒再回退」两段式，两条路都试过再报错，
   * 不把任何一种部署形态卡死。
   */
  function forwardTokenExchange(req, res, TARGET, triedFallback = false) {
    // 保留浏览器的 authority；只剥离逐跳头，不做 Host/Origin 改写。
    const headers = stripHopByHop(req.headers);

    const proxyReq = http.request({
      hostname: TARGET.hostname,
      port: TARGET.port,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    });
    const timer = setTimeout(
      () => proxyReq.destroy(new Error('upstream connect timeout')),
      UPSTREAM_CONNECT_TIMEOUT_MS,
    );
    let retried = false;

    proxyReq.on('response', (proxyRes) => {
      clearTimeout(timer);
      const status = proxyRes.statusCode || 502;

      // 上游拒绝这个 authority（信任栅栏）：改成回环权威重试一次。
      // 只有在还没重试过、且确实是 403/401 时才回退，避免掩盖真实业务错误。
      if (!triedFallback && !retried && (status === 403 || status === 401)) {
        retried = true;
        log('warn', `令牌交换被上游以 ${status} 拒绝（authority 未受信），改用回环权威重试：${req.url}`);
        proxyRes.resume(); // 丢弃这次响应体，随后重发
        forwardTokenExchange(req, res, TARGET, true);
        return;
      }

      const outHeaders = stripHopByHop(proxyRes.headers);
      // dsh 会下发 Set-Cookie（dsh-auth-*）。必须原样透传：它已经是 host-only /
      // Path=/ / HttpOnly / SameSite=Strict，属性正确，任何改写都会让它失效。
      res.writeHead(status, proxyRes.statusMessage, outHeaders);
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    });

    proxyReq.on('error', (err) => {
      clearTimeout(timer);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`relay: 无法连接上游 ${TARGET.origin}（${err.code || err.message}）。\n`);
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

  // ── HTTP 代理 ──
  function handleRequest(req, res, auth, c) {
    requestCount++;
    if (!authGate(req, res, null, auth, c.password, log)) return;

    const TARGET = target();
    if (shouldPatchBundle(req, c)) return handlePatchedBundle(req, res, TARGET, c);

    // dsh 的启动令牌交换：单独转发，走「保留浏览器原始 authority」的头策略。
    // 理由见 isDshTokenExchange 的注释 —— dsh 要按请求的 authority 签名 cookie，
    // 若把它改写成上游回环权威，签出的 cookie 会挂到 127.0.0.1:19387 上，
    // 而浏览器实际访问的是隧道域名/中转端口，于是 cookie 永远对不上、一直 401。
    if (isDshTokenExchange(req)) {
      return forwardTokenExchange(req, res, TARGET);
    }

    // 统一走 prepareForwardHeaders：它会改写 Host/Origin，并在开启
    // autoSession 时替浏览器补签 dsh 的会话 Cookie。
    const headers = prepareForwardHeaders(req, false, TARGET, c);
    const proxyReq = http.request({
      hostname: TARGET.hostname,
      port: TARGET.port,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    });
    const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);

    proxyReq.on('response', (proxyRes) => {
      clearTimeout(timer);
      res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, stripHopByHop(proxyRes.headers));
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    });

    proxyReq.on('error', (err) => {
      clearTimeout(timer);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`relay: 无法连接上游 ${TARGET.origin}（${err.code || err.message}）。\n`);
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
  function handleUpgrade(req, socket, head, auth, c) {
    socket.on('error', () => socket.destroy());
    if (!authGate(req, null, socket, auth, c.password, log)) return;

    const TARGET = target();
    // WebSocket 也要补签：dsh 的 RPC 下行流与事件推送都走 upgrade，
    // 没有会话 Cookie 会被直接拒握手。
    const headers = prepareForwardHeaders(req, true, TARGET, c);
    const proxyReq = http.request({
      hostname: TARGET.hostname,
      port: TARGET.port,
      method: 'GET',
      path: req.url,
      headers,
      agent: false,
    });
    const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);

    proxyReq.on('upgrade', (proxyRes, upstreamSocket, head2) => {
      clearTimeout(timer);
      const h = stripHopByHop(proxyRes.headers);
      h.connection = 'Upgrade';
      if (!h.upgrade) h.upgrade = 'websocket';
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${serializeHeaders(h)}\r\n`);
      if (head2 && head2.length) upstreamSocket.unshift(head2);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const kill = () => {
        upstreamSocket.destroy();
        socket.destroy();
      };
      upstreamSocket.on('error', kill);
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
    });

    // 上游拒绝握手（如 403/502）：把状态码透传给客户端
    proxyReq.on('response', (proxyRes) => {
      clearTimeout(timer);
      const status = proxyRes.statusCode || 502;
      socket.write(`HTTP/1.1 ${status} ${proxyRes.statusMessage || ''}\r\n${serializeHeaders(stripHopByHop(proxyRes.headers))}\r\n`);
      proxyRes.pipe(socket);
      proxyRes.on('end', () => socket.end());
      proxyRes.on('error', () => socket.destroy());
    });

    proxyReq.on('error', () => {
      clearTimeout(timer);
      if (socket.writable) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nrelay: 无法连接上游 DSH（请确认上游端口在监听）');
        socket.destroy();
      }
    });

    proxyReq.end();
  }

  // ── 启停 ──

  /**
   * 启动中转监听。
   * 端口被占用时**不退出进程**，置 lastError='port-in-use' 并返回失败。
   */
  async function start() {
    if (running) return status();
    if (stopping) await stop();
    const c = cfg();

    const srv = http.createServer((req, res) => {
      try {
        handleRequest(req, res, currentAuth(), cfg());
      } catch (err) {
        lastError = `request handler: ${err?.message || err}`;
        log('error', lastError);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('relay: internal error\n');
        } else {
          res.destroy();
        }
      }
    });

    srv.on('upgrade', (req, socket, head) => {
      try {
        handleUpgrade(req, socket, head, currentAuth(), cfg());
      } catch (err) {
        lastError = `upgrade handler: ${err?.message || err}`;
        log('error', lastError);
        socket.destroy();
      }
    });

    srv.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });

    // 跟踪所有 socket，stop() 时逐个 destroy —— 否则 keep-alive 与已升级的
    // WebSocket 会让端口继续挂着，close() 永不返回。
    srv.on('connection', (socket) => {
      liveSockets.add(socket);
      socket.on('close', () => liveSockets.delete(socket));
    });

    const listenError = await new Promise((resolve) => {
      const onError = (err) => {
        srv.removeListener('listening', onListening);
        resolve(err);
      };
      const onListening = () => {
        srv.removeListener('error', onError);
        resolve(null);
      };
      srv.once('error', onError);
      srv.once('listening', onListening);
      try {
        srv.listen(c.listenPort, c.listenHost);
      } catch (err) {
        srv.removeListener('listening', onListening);
        resolve(err);
      }
    });

    if (listenError) {
      try {
        srv.close();
      } catch {
        /* 未成功监听，忽略 */
      }
      lastError = listenError.code === 'EADDRINUSE'
        ? 'port-in-use'
        : `listen-failed: ${listenError.code || listenError.message}`;
      log('error', `中转监听 ${c.listenHost}:${c.listenPort} 失败：${lastError}`);
      return status();
    }

    server = srv;
    running = true;
    startedAt = Date.now();
    lastError = null;
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : c.listenPort;
    boundListen = { host: c.listenHost, port };
    log('info', `中转监听 ${c.listenHost}:${port} → ${target().origin}`);
    return status();
  }

  /**
   * 停止中转并**真正释放端口**。
   * 幂等：重复调用安全；等待在途连接关闭，最多 STOP_DRAIN_TIMEOUT_MS。
   */
  function stop() {
    if (!running || !server) {
      running = false;
      server = null;
      return Promise.resolve(status());
    }
    stopping = true;
    const srv = server;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          srv.closeAllConnections?.();
        } catch {
          /* 老版本 Node 无此方法 */
        }
        for (const socket of [...liveSockets]) {
          try {
            socket.destroy();
          } catch {
            /* 已关闭 */
          }
        }
        liveSockets.clear();
        server = null;
        running = false;
        stopping = false;
        boundListen = null;
        log('info', '中转已停止，端口已释放');
        resolve(status());
      };
      const timer = setTimeout(finish, STOP_DRAIN_TIMEOUT_MS);

      // 强制断开 keep-alive 与已升级的 WS，close 回调才能及时到
      try {
        srv.closeAllConnections?.();
      } catch {
        /* 忽略 */
      }
      for (const socket of [...liveSockets]) {
        try {
          socket.destroy();
        } catch {
          /* 忽略 */
        }
      }
      srv.close(() => finish());
    });
  }

  /** 当前状态快照（UI 与工具都读它）。 */
  function status() {
    const c = cfg();
    // 监听部分：运行中用实际绑定值，停止时用配置值（UI 才能预先显示将要绑定的端口）
    const listenHost = running && boundListen ? boundListen.host : c.listenHost;
    const listenPort = running && boundListen ? boundListen.port : c.listenPort;
    let targetInfo = null;
    let dsh = null;
    try {
      const dshEp = getDshEndpoint();
      dsh = { host: dshEp.host, port: dshEp.port, address: authorityOf(dshEp.host, dshEp.port) };
      const t = target();
      targetInfo = { host: t.hostname, port: t.port, origin: t.origin };
    } catch (err) {
      lastError = lastError ?? `endpoint: ${err?.message || err}`;
    }
    const st = running ? 'running' : lastError ? 'error' : 'stopped';
    return {
      state: st,
      listen: { host: listenHost, port: listenPort, address: authorityOf(listenHost, listenPort) },
      target: targetInfo,
      dsh,
      forceLoopback: c.forceLoopback,
      hasPassword: Boolean(c.password),
      connections: liveSockets.size,
      requests: requestCount,
      startedAt: running ? startedAt : null,
      uptimeMs: running ? Date.now() - startedAt : 0,
      lastError,
    };
  }

  return { start, stop, status };
}
