/**
 * relay.js — DSH 中转核心（纯库，无进程副作用）
 *
 * 职责：在本进程内起一个 HTTP + WebSocket 反向代理，把本机 dsh 的端口
 * 转发到隧道/公网入口，并处理四件 dsh 自身不负责的事：
 *
 *   1. **过信任栅栏**：把 Host/Origin 改写成上游回环权威；
 *   2. **口令认证**：HMAC-SHA256 签名 Cookie 的会话口令（可选）；
 *   3. **代签 dsh 会话 Cookie**：让用户只输中转口令就能进（可选）；
 *   4. **强制回环改写**：把客户端 bundle 里的 `isLoopback` 判定改成恒真（可选）。
 *
 * 0.2.0 相对 0.1.x 的实质改动：
 *
 *   · `isLoopback` 改写不再依赖「候选正则命中」，改成**结构性扫描**：
 *     找到 `isLoopback:` 这个键，再按括号深度找出它后面的整个值表达式，
 *     整段替换成 `true`。dsh 换写法（新增 `transport?.ownsHost`、
 *     改名局部变量、压缩/未压缩差异）都不会让改写失效。
 *   · 命中范围从「某个固定文件路径」改成「任何 content-type 是 JavaScript
 *     的 /plugins/ 响应」——0.2.x 的客户端 bundle 走 combo URL
 *     （/plugins/??a/client.js,b/client.js&rev=…），单资源路径不再是唯一形态。
 *   · 删除「令牌交换单独转发」分支：它与统一转发相互矛盾，而且现在不再需要
 *     （见 prepareForwardHeaders 的说明）。令牌交换按普通请求转发即可。
 *   · 上游端口始终从宿主的 webServer 热读，不写死 3080/19387。
 */
'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';

// ─────────────────────────── 常量 ───────────────────────────

/** hop-by-hop 头：逐跳语义不能透传；upgrade 场景单独保留 connection/upgrade。 */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

const UPSTREAM_CONNECT_TIMEOUT_MS = 15000;
const STOP_DRAIN_TIMEOUT_MS = 2000;

/** 需要改写的客户端资源前缀（client-modules 的 bundle 路由）。 */
const PLUGIN_ROUTE_PREFIX = '/plugins/';

/** 认定为「可改写脚本」的 content-type 前缀。 */
const SCRIPT_CONTENT_TYPES = ['application/javascript', 'text/javascript', 'application/x-javascript', 'module'];

/**
 * 真正需要改写 `isLoopback` 的包。
 *
 * 为什么要这张白名单：`isLoopback` 这个字段只在 0.2.x 的
 * `@deepseek-ai/dsh-client-connection` 里定义（实测全量扫过 85 个 combo
 * bundle，只有它的产物带这个键）。旧实现却对**整个 `/plugins/`** 强制
 * `accept-encoding: identity` 并整体缓冲 —— 结果是 85 个 bundle 全部被解压
 * 重传，实测启动流量从 10.29 MB（gzip）膨胀到 26.18 MB（2.55x）。
 *
 * 只对白名单内的包做「解压 → 改写 → 重压」，其余请求**完全按普通代理透传**，
 * 让 dsh 自己的 gzip 与强缓存照常生效。
 */
const LOOPBACK_PATCH_PACKAGES = [
  '@deepseek-ai/dsh-client-connection',
];

/**
 * WebSocket 压缩参数。
 *
 * `threshold` 是关键：实测会话事件的单帧尺寸中位数只有约 286 B，对这么小的
 * 帧现压现解反而更贵（deflate 头 + CPU）。1024 B 以下不压，既保住小帧的
 * 低延迟，又拿到大帧（历史快照）的绝大部分收益。
 *
 * `level` 用 1：历史帧是 4 MB 量级的重复 JSON，低档位就能压到约 1/5，
 * 而 CPU 开销远低于默认 6 档 —— 压缩本身不该成为新的瓶颈。
 */
const WS_DEFLATE_OPTIONS = {
  threshold: 1024,
  zlibDeflateOptions: { level: 1, memLevel: 8, chunkSize: 16 * 1024 },
  zlibInflateOptions: { chunkSize: 16 * 1024 },
  // 不做 context takeover：每条消息独立压缩，避免跨消息的字典状态占用内存
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
};

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

// ─────────────────────────── isLoopback 改写 ───────────────────────────

/**
 * 从一个表达式起点找出它的结束位置（不含结束符）。
 *
 * 规则：维护 `()[]{}` 深度；跳过字符串字面量；深度为 0 时遇到 `,` `;` `)`
 * `}` 或换行即结束。追踪到越界或深度变负则判定失败（返回 -1）。
 *
 * @param source - 整段脚本
 * @param start - 值表达式的第一个字符位置
 * @returns 结束位置，或 -1（无法可靠判定）
 */
function scanExpressionEnd(source, start) {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; i += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;   // 值表达式在容器结束处终止
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) return i;
    i += 1;
  }
  return -1;
}

/**
 * 找出脚本里所有 `isLoopback: <expr>` 的可替换片段。
 *
 * 只认「键名后跟冒号」的位置，并且要求值表达式里出现 isLoopback / ownsHost /
 * pageLocation 之一 —— 两道闸门保证不会误改无关代码。
 *
 * @param source - 客户端脚本
 * @returns `[start, end)` 区间数组（区间内容可整体替换）
 */
export function findIsLoopbackSpans(source) {
  const KEY = 'isLoopback:';
  const spans = [];
  let cursor = 0;
  for (;;) {
    const at = source.indexOf(KEY, cursor);
    if (at < 0) break;
    const prev = at === 0 ? '' : source[at - 1];
    // 只接受「对象字面量里的键」这一种形态
    if (at !== 0 && !/[{,(\s]/.test(prev)) { cursor = at + KEY.length; continue; }
    const exprStart = at + KEY.length;
    const exprEnd = scanExpressionEnd(source, exprStart);
    if (exprEnd <= exprStart || exprEnd - exprStart > 4000) { cursor = exprStart; continue; }
    const expr = source.slice(exprStart, exprEnd);
    if (!/isLoopback|ownsHost|pageLocation/.test(expr)) { cursor = exprEnd; continue; }
    spans.push([exprStart, exprEnd]);
    cursor = exprEnd;
  }
  return spans;
}

/**
 * 把脚本里的 `isLoopback` 值表达式改写成恒 `true`。
 *
 * 为什么改值而不是改函数：`isLoopbackHostname(...)` 是对**页面地址**的判断，
 * 而经隧道访问时页面地址是公网域名，永远判 false。直接把字段值改成 true
 * 等价于「本次会话视为本机直连」，这正是隧道场景想要的语义。
 *
 * @param source - 客户端脚本
 * @returns `{ body, hits }`；hits=0 表示脚本里没有这个字段
 */
export function patchIsLoopback(source) {
  const spans = findIsLoopbackSpans(source);
  if (spans.length === 0) return { body: source, hits: 0 };
  let body = '';
  let last = 0;
  for (const [start, end] of spans) {
    body += source.slice(last, start) + ' true';
    last = end;
  }
  body += source.slice(last);
  return { body, hits: spans.length };
}

// ─────────────────────────── 目标集判定 ───────────────────────────

/**
 * 这个请求是否指向「需要改写 isLoopback」的客户端 bundle。
 *
 * 两种 URL 形态都要认（0.2.x 的 client-modules 会同时用到）：
 *   · 单资源 combo：`/plugins/??@scope/pkg/client.js&rev=…`
 *   · 批量 combo：  `/plugins/??a/client.js,b/client.js&rev=…`（可能很长）
 *
 * 判定方式：取 `??` 之后、`&rev=` 之前的资源列表，按 `/client.js` 切分，
 * 只要其中有白名单包就返回 true。**不**匹配 `/plugins/events` 这类 SSE 路径。
 *
 * @param url - 原始请求 URL
 * @returns 是否属于改写目标
 */
export function isLoopbackPatchTarget(url) {
  if (typeof url !== 'string' || !url.startsWith(PLUGIN_ROUTE_PREFIX)) return false;
  const q = url.indexOf('??');
  if (q < 0) return false;
  const rest = url.slice(q + 2);
  const amp = rest.indexOf('&');
  const list = amp < 0 ? rest : rest.slice(0, amp);
  if (list === '') return false;
  for (const entry of list.split(',')) {
    if (!entry.endsWith('/client.js')) continue;
    const pkg = entry.slice(0, -'/client.js'.length);
    if (LOOPBACK_PATCH_PACKAGES.includes(pkg)) return true;
  }
  return false;
}

/**
 * 解码上游响应体：按 `content-encoding` 解成明文；解不了就返回 null。
 *
 * 支持 gzip / br / deflate / identity —— 覆盖 dsh 的 webserver 会产出的全部编码
 * （它用 `compression` 中间件，实测协商结果只会是 gzip 或 identity）。
 *
 * @param buffer - 上游原始字节
 * @param encoding - `content-encoding` 头（已 lowercase）
 * @returns 明文 Buffer，或 null（不认识的编码）
 */
export function decodeBody(buffer, encoding) {
  switch (encoding) {
    case '':
    case 'identity':
      return buffer;
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buffer);
    case 'deflate':
      return zlib.inflateSync(buffer);
    case 'br':
      return zlib.brotliDecompressSync(buffer);
    default:
      return null;
  }
}

/**
 * 按同样的 `content-encoding` 压回去，保持与上游一致的传输体积。
 *
 * 只用最快的档位：这些是静态脚本，解压后的体积本来就不大，
 * 压缩档位对整体延迟的影响远小于「不压缩」。
 *
 * @param buffer - 明文（改写后）的字节
 * @param encoding - 原本的 `content-encoding`（已 lowercase）
 * @returns 压缩后的字节；identity 原样返回
 */
export function encodeBody(buffer, encoding) {
  switch (encoding) {
    case '':
    case 'identity':
      return buffer;
    case 'gzip':
    case 'x-gzip':
      return zlib.gzipSync(buffer, { level: 1 });
    case 'deflate':
      return zlib.deflateSync(buffer, { level: 1 });
    case 'br':
      return zlib.brotliCompressSync(buffer, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 1,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
        },
      });
    default:
      throw new Error(`unsupported content-encoding: ${encoding}`);
  }
}

// ─────────────────────────── 口令认证 ───────────────────────────

/** HMAC-SHA256 签名 Cookie 会话；空口令返回 null（关闭认证）。 */
export function makeAuth(password) {
  if (!password) return null;
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
        out[decodeURIComponent(part.slice(0, eq).trim())] = decodeURIComponent(part.slice(eq + 1).trim());
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
    __ERR__
  </form>
</body>
</html>`;

/**
 * 判断这是否是 dsh 自己的启动令牌交换请求（`GET /?token=…`）。
 *
 * 这类请求必须**原样**到达 dsh：token 是一次性凭据，被中转的登录页吃掉就
 * 再也换不出会话 Cookie。它不是越权入口 —— token 本身就是凭证。
 */
function isDshTokenExchange(req) {
  if (req.method !== 'GET') return false;
  try {
    return new URL(req.url, 'http://placeholder').searchParams.has('token');
  } catch {
    return false;
  }
}

/**
 * 这个未认证请求是否应该看到登录页（而不是裸 401）。
 *
 * 两种情形：浏览器请求文档（Accept 含 text/html），或直接访问站点根路径。
 * 其它情况（API、静态资源、WebSocket）一律 401/401 文本 —— 让前端能明确
 * 区分「没登录」与「页面没渲染」。
 */
function wantsLoginPage(req) {
  if (req.method !== 'GET') return false;
  const url = req.url === undefined ? '/' : req.url;
  if (url === '/' || url === '/index.html' || url.startsWith('/?')) return true;
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * 认证入口：未登录时返回登录页 / 401；处理 POST /__login。
 * @returns true 表示已放行，false 表示本函数已接管响应。
 */
function authGate(req, res, socket, auth, password, log) {
  if (!auth) return true;

  // dsh 的启动令牌交换优先放行（见 isDshTokenExchange 注释）。
  if (isDshTokenExchange(req)) {
    log?.('info', `放行 dsh 启动令牌交换：${req.url}`);
    return true;
  }

  const token = auth.parseCookies(req)[auth.cookieName];
  if (auth.verifyToken(token)) return true;

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

  if (wantsLoginPage(req)) {
    if (res) {
      const page = auth.LOGIN_PAGE.replace('__ERR__', '');
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

// ─────────────────────────── 中转实例 ───────────────────────────

/**
 * 建一个中转实例。
 *
 * @param options.getDshEndpoint - () => { host, port }，本进程 dsh 的真实监听端点（惰性求值）
 * @param options.getConfig      - () => 归一化后的配置
 * @param options.log            - (level, message) => void，可选
 * @param options.sessionSigner  - dsh 会话代签器；提供且 autoSession 开启时补签会话 Cookie
 * @returns { start, stop, status }
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
  let boundListen = null;
  let requestCount = 0;
  let patchCount = 0;
  let patchMisses = 0;
  let passthroughCount = 0;
  let authCache = { password: undefined, auth: null };

  /**
   * WebSocket 流量统计。
   *
   * `downlinkPlain` 是**解压前的逻辑字节**（= 浏览器最终看到的数据量），
   * 它与实际线缆字节的比值就是压缩率 —— 这是「切会话到底还卡不卡」的
   * 唯一可核对指标，所以直接暴露到 status 里。
   */
  const wsBytesCounter = { uplink: 0, downlinkPlain: 0 };
  const wsBytesTracker = {
    connections: 0,
    opened: 0,
    open() { this.opened += 1; this.connections += 1; },
    close() { this.connections = Math.max(0, this.connections - 1); },
  };

  /**
   * 打给上游的 keep-alive 连接池。
   *
   * 旧实现每处转发都写 `agent: false`（= 不复用、每个请求新建 TCP）。在
   * 隧道场景下这条链路上每一跳的握手都更贵，实测 TIME_WAIT 会随请求数线性
   * 堆积。这里集中复用一个 agent；WebSocket upgrade 仍不用它（升级连接本来
   * 就是长连接，复用没有意义）。
   *
   * 注意：`stop()` 会 destroy 它，所以 `start()` 必须先确保它可用（见
   * ensureAgent）——否则「停用后再启用」会拿到一个已销毁的 agent。
   */
  let upstreamAgent = createUpstreamAgent();

  function createUpstreamAgent() {
    return new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 60000,
    });
  }

  function ensureAgent() {
    if (upstreamAgent.destroyed === true) upstreamAgent = createUpstreamAgent();
    return upstreamAgent;
  }

  function cfg() {
    const c = getConfig() ?? {};
    return {
      listenHost: c.listenHost || '127.0.0.1',
      listenPort: Number.isInteger(c.listenPort) ? c.listenPort : 3091,
      // 上游覆盖是白名单式重建：新增配置项必须在这里显式带上，
      // 否则会静默变成 undefined，让下游的开关形同虚设。
      targetHost: c.targetHost || null,
      targetPort: c.targetPort == null ? null : Number(c.targetPort),
      password: c.password ?? '',
      forceLoopback: c.forceLoopback !== false,
      autoSession: c.autoSession !== false,
      // 默认开：会话历史走 WS 且是明文，压缩实测能省约 5.8x。
      compressWebSocket: c.compressWebSocket !== false,
    };
  }

  function currentAuth() {
    const password = cfg().password;
    if (authCache.password !== password) authCache = { password, auth: makeAuth(password) };
    return authCache.auth;
  }

  /**
   * 上游目标：显式覆盖优先（代理另一个 dsh 实例的场景），
   * 否则永远取本进程 dsh 的真实端点（热读，不写死端口）。
   */
  function target() {
    const c = cfg();
    const dsh = getDshEndpoint();
    const host = c.targetHost || dsh.host || '127.0.0.1';
    const port = c.targetPort ?? dsh.port;
    return resolveTarget(host, port);
  }

  /**
   * 准备要发往上游的头。
   *
   * 两件事：
   *   1. rewriteHeaders：Host/Origin 改成回环权威，过 dsh 的信任栅栏；
   *   2. autoSession 时补签 dsh 会话 Cookie。
   *
   * 关于第 2 点为什么不用 dsh 的 `?token=` 交换：代签的 Cookie 名与 payload
   * 都绑定「本次请求的 authority」，而 rewriteHeaders 已把 Host 改成回环权威，
   * 所以只要按 TARGET.authority 签，dsh 校验必然通过。反之若保留浏览器的
   * 隧道 authority，就过不了信任栅栏 —— 这也是旧版本要写「先原样、被拒再回退」
   * 两段式的原因。代签把这条弯路整个去掉了。
   *
   * 代签失败一律**不注入**并原样转发：退回「用 dsh 打印的 ?token=」的现状，
   * 不让失败的代签变成完全进不去。
   */
  function prepareForwardHeaders(req, forUpgrade, TARGET, c) {
    const headers = rewriteHeaders(req.headers, forUpgrade, TARGET);
    if (!sessionSigner || c.autoSession === false) return headers;
    if (!c.password) return headers;   // 无口令时不代签：等价于无条件送出 dsh 会话
    try {
      const out = sessionSigner.checkout(TARGET.authority, headers.cookie);
      if (out.injected && out.cookieHeader) headers.cookie = out.cookieHeader;
    } catch (err) {
      log('warn', `[dsh-cookie] 代签失败，本次按原样转发：${err?.message || err}`);
    }
    return headers;
  }

  /** 这个响应是不是可改写的客户端脚本。 */
  function isScriptResponse(proxyRes) {
    const type = String(proxyRes.headers['content-type'] || '').toLowerCase();
    return SCRIPT_CONTENT_TYPES.some((prefix) => type.startsWith(prefix));
  }

  /**
   * force-loopback：改写目标 bundle 的 `isLoopback`。
   *
   * 只对白名单包（见 LOOPBACK_PATCH_PACKAGES）调用；其余 `/plugins/` 请求走
   * 普通转发，压缩与强缓存原样保留。
   *
   * 改写方式是**先按上游给的编码解压、改完再按同一编码压回去**：
   *   · 不再强制 `accept-encoding: identity` —— 那会让 dsh 放弃压缩，
   *     实测把启动流量从 10.29 MB 抬到 26.18 MB；
   *   · 也不再丢掉 `cache-control` —— dsh 的 combo URL 自带 `rev=<hash>`，
   *     内容变了 URL 就变，天然可长期缓存，写 `no-store` 只会让每次刷新重下。
   */
  function handlePatchedScript(req, res, TARGET, c) {
    const headers = prepareForwardHeaders(req, false, TARGET, c);
    // 保留浏览器的 accept-encoding：让上游照常压缩，我们解压再重压。
    // 若上游只肯给 identity，下面的 encoding 分支同样能处理。

    const proxyReq = http.request({
      hostname: TARGET.hostname,
      port: TARGET.port,
      method: req.method,
      path: req.url,
      headers,
      agent: ensureAgent(),
    });
    const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);

    proxyReq.on('response', (proxyRes) => {
      clearTimeout(timer);
      const status = proxyRes.statusCode ?? 502;
      const upstreamHeaders = stripHopByHop(proxyRes.headers);
      const encoding = String(proxyRes.headers['content-encoding'] || '').toLowerCase();

      // 非 200 / 不是 JS / 编码不认识 → 原样 pipe，绝不冒险改字节
      const decodable = encoding === '' || encoding === 'identity'
        || encoding === 'gzip' || encoding === 'x-gzip'
        || encoding === 'deflate' || encoding === 'br';

      if (status !== 200 || !isScriptResponse(proxyRes) || !decodable) {
        if (!decodable) {
          log('warn', `force-loopback: 无法解码的 content-encoding (${encoding})，已按原样透传`);
        }
        res.writeHead(status, proxyRes.statusMessage, upstreamHeaders);
        proxyRes.pipe(res);
        proxyRes.on('error', () => res.destroy());
        return;
      }

      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const original = Buffer.concat(chunks);

        let plain;
        try {
          plain = decodeBody(original, encoding);
        } catch (err) {
          // 解压失败极罕见（上游给了错的 encoding）：透传原字节，别把页面弄坏
          log('warn', `force-loopback: 解压失败（${encoding}），按原样透传：${err?.message || err}`);
          res.writeHead(status, proxyRes.statusMessage, upstreamHeaders);
          res.end(original);
          return;
        }
        if (plain === null) {
          res.writeHead(status, proxyRes.statusMessage, upstreamHeaders);
          res.end(original);
          return;
        }

        const text = plain.toString('utf-8');
        const { body, hits } = patchIsLoopback(text);

        if (hits === 0) {
          // 白名单里但这次没有该字段（dsh 改了实现）：原字节透传，最安全
          patchMisses += 1;
          if (patchMisses <= 3) {
            log('warn', `force-loopback: 该脚本里没有 isLoopback 字段（${req.url}），按原样转发`);
          }
          res.writeHead(status, proxyRes.statusMessage, upstreamHeaders);
          res.end(original);
          return;
        }

        patchCount += 1;
        const patchedBuf = Buffer.from(body, 'utf-8');

        // 原样压回去：浏览器已经声明支持这个编码，压缩后体积才不回退
        let outBuf;
        try {
          outBuf = encodeBody(patchedBuf, encoding);
        } catch (err) {
          log('warn', `force-loopback: 重压失败（${encoding}），改发未压缩：${err?.message || err}`);
          outBuf = patchedBuf;
          delete upstreamHeaders['content-encoding'];
        }

        delete upstreamHeaders['transfer-encoding'];
        upstreamHeaders['content-length'] = outBuf.length;
        // 关键修复：**保留上游的强缓存语义**，不要再写 no-store。
        // combo URL 带 rev=<hash>，改写结果由 (rev, 输入字节) 唯一确定。
        if (upstreamHeaders['cache-control'] === undefined) {
          upstreamHeaders['cache-control'] = 'public, max-age=31536000, immutable';
        }
        log('info', `force-loopback: 已改写 ${hits} 处 isLoopback（明文 ${plain.length} → ${Buffer.byteLength(body, 'utf-8')} 字节，${encoding || 'identity'} 传输 ${original.length} → ${outBuf.length} 字节）`);
        res.writeHead(200, upstreamHeaders);
        res.end(outBuf);
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
   * 转发 dsh 的 `GET /?token=…` 令牌交换，并**保留浏览器的原始 Host/Origin**。
   *
   * 为什么只在「不代签」时才走这条路：
   *
   *   dsh 的 cookie 名与 payload 都绑定「请求的 authority」：
   *       cookieName(authority) = 'dsh-auth-' + base64url(sha256(authority))
   *   若这里把 authority 改写成 127.0.0.1:<dsh端口>，签出的 cookie 属于那个
   *   权威；而浏览器地址栏里是隧道域名/中转端口，取不出来 → 永远
   *   `authentication required`。
   *
   *   但**代签**恰好把这条弯路去掉了：我们按上游权威签 cookie 并直接注入，
   *   dsh 只校验签名与 authority 匹配，与浏览器地址栏无关。所以：
   *     · autoSession 生效中 → 走普通转发（快、只有一个分支）；
   *     · 否则 → 走本函数保留 authority，让 dsh 自己签。
   *
   * 保留 authority 的代价是可能撞上信任栅栏（Host 既非回环也不在
   * trustedHosts 里 → 403）。所以下面做「先原样、被拒再回退回环权威」两段式，
   * 两条路都试过再报错，不把任何一种部署形态卡死。
   */
  function forwardTokenExchange(req, res, TARGET, triedFallback = false) {
    const headers = stripHopByHop(req.headers);

    const proxyReq = http.request({
      hostname: TARGET.hostname,
      port: TARGET.port,
      method: req.method,
      path: req.url,
      headers,
      agent: ensureAgent(),
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
      // 只在还没重试过、且确实是 403/401 时才回退，避免掩盖真实业务错误。
      if (!triedFallback && !retried && (status === 403 || status === 401)) {
        retried = true;
        log('warn', `令牌交换被上游以 ${status} 拒绝（authority 未受信），改用回环权威重试：${req.url}`);
        proxyRes.resume();   // 丢弃这次响应体，随后重发
        forwardTokenExchange(req, res, TARGET, true);
        return;
      }

      // dsh 下发的 Set-Cookie 必须原样透传：它已经是 host-only / Path= /
      // HttpOnly / SameSite，任何改写都会让它失效。
      res.writeHead(status, proxyRes.statusMessage, stripHopByHop(proxyRes.headers));
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

  // ── 普通 HTTP 代理 ──
  function handleRequest(req, res, auth, c) {
    requestCount += 1;
    if (!authGate(req, res, null, auth, c.password, log)) return;

    const TARGET = target();

    // 令牌交换且不代签 → 保留浏览器原始 authority，让 dsh 自己按它签 cookie。
    // 代签生效时不需要这条路（详见 forwardTokenExchange 的说明）。
    if (isDshTokenExchange(req) && !(sessionSigner && c.autoSession !== false && c.password)) {
      return forwardTokenExchange(req, res, TARGET);
    }

    // force-loopback 只对**白名单包**的客户端 bundle 生效（见
    // LOOPBACK_PATCH_PACKAGES）。其余 `/plugins/` 请求按普通代理透传 ——
    // 保留 dsh 的 gzip 与强缓存，这是启动流量不膨胀的关键。
    const patchTarget = c.forceLoopback && isLoopbackPatchTarget(req.url ?? '');
    if (patchTarget) return handlePatchedScript(req, res, TARGET, c);
    if (String(req.url ?? '').startsWith(PLUGIN_ROUTE_PREFIX)) passthroughCount += 1;

    const headers = prepareForwardHeaders(req, false, TARGET, c);
    const proxyReq = http.request({
      hostname: TARGET.hostname,
      port: TARGET.port,
      method: req.method,
      path: req.url,
      headers,
      agent: ensureAgent(),
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

  /**
   * 软获取 `ws`。
   *
   * 解析顺序（与测试里的 `loadWsOrNull` 保持一致）：
   *   1. `import('ws')` —— profile 里若把 ws 提升到顶层就能命中
   *   2. dsh 自带的那份（`$DSH_HOME/profiles/<profile>/node_modules/ws`）
   *      实测 dsh 0.2.x 确实带 ws@8.21，所以这条是常态命中的那条
   *
   * 拿不到时返回 null → 回退裸 pipe（功能降级，不崩）。
   *
   * @returns {Promise<{WebSocket: any, WebSocketServer: any}|null>}
   */
  let wsModulePromise = null;
  function loadWs() {
    if (wsModulePromise === null) {
      wsModulePromise = (async () => {
        const userProfile = (os.homedir() || '').replace(/\\/g, '/');
        const dshHome = (process.env.DSH_HOME || `${userProfile}/.dsh`).replace(/\\/g, '/');
        const profile = process.env.DSH_PROFILE || 'desktop';
        const candidates = [
          'ws',
          `file:///${dshHome}/profiles/${profile}/node_modules/ws/wrapper.mjs`,
          `file:///${dshHome}/profiles/node_modules/ws/wrapper.mjs`,
        ];
        for (const spec of candidates) {
          try {
            const mod = await import(spec);
            const WebSocket = mod.default ?? mod.WebSocket;
            const WebSocketServer = mod.WebSocketServer;
            if (typeof WebSocket === 'function' && typeof WebSocketServer === 'function') {
              return { WebSocket, WebSocketServer };
            }
          } catch { /* 试下一个 */ }
        }
        log('warn', 'ws 不可用，WebSocket 将按裸 pipe 转发（无压缩）');
        return null;
      })();
    }
    return wsModulePromise;
  }

  /** 压缩是否可用（决定走帧代理还是裸 pipe）。 */
  let wsCompressionReady = null;

  /**
   * 一条被帧代理接管的连接。
   *
   * 两端独立协商：浏览器侧开 `perMessageDeflate`，上游 dsh 侧**不开**
   * （保持与改造前完全一致的载荷，dsh 无感）。
   */
  function proxyUpgradeWithFrames({ wsMod, req, socket, head, TARGET, c, rawHeaders }) {
    const { WebSocketServer, WebSocket } = wsMod;

    // 浏览器侧：接受升级并开启压缩（只服务这一条连接，收完即弃）
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: WS_DEFLATE_OPTIONS });
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.close();   // 只服务这一条连接，收完即弃

      // 上游 dsh：**不声明压缩**，载荷与改造前一致。
      // 注意：ws 的构造是异步的，'open' 之前 send 会抛错 —— 用一个队列接住。
      const upstream = new WebSocket(`ws://${TARGET.hostname}:${TARGET.port}${req.url}`, { headers: rawHeaders });
      let upstreamOpen = false;
      const pendingToUpstream = [];

      /** 任一端的关闭理由，透传给另一端。 */
      let closing = false;

      const teardown = (why) => {
        if (closing) return;
        closing = true;
        pendingToUpstream.length = 0;
        try { client.close(); } catch { /* 已关 */ }
        try { upstream.close(); } catch { /* 已关 */ }
        try { client.terminate(); } catch { /* 已关 */ }
        try { upstream.terminate(); } catch { /* 已关 */ }
        wsBytesTracker.close(why);
      };

      // ── 立即挂监听，不要等 'open' ──
      // 这台机器上客户端往往在 upstream 连上之前就发了第一帧；若把监听放在
      // 'open' 回调里注册，那一帧会被 ws 直接丢弃（不会缓存），表现为
      // 「握手成功但没有任何回显」。
      client.on('message', (data, isBinary) => {
        wsBytesCounter.uplink += data.length;
        if (!upstreamOpen) {
          // 上游还没连上：先排队，连上后按序补发
          pendingToUpstream.push({ data, isBinary });
          return;
        }
        try { upstream.send(data, { binary: isBinary }); } catch { teardown('uplink-send-failed'); }
      });

      // dsh → 浏览器：这才是被压缩的大头（历史快照 4.6 MB 单帧）
      upstream.on('message', (data, isBinary) => {
        wsBytesCounter.downlinkPlain += data.length;
        try { client.send(data, { binary: isBinary }); } catch { teardown('downlink-send-failed'); }
      });

      upstream.on('open', () => {
        upstreamOpen = true;
        wsCompressionReady = true;
        // 补发排队帧（保持顺序）
        for (const item of pendingToUpstream) {
          try { upstream.send(item.data, { binary: item.isBinary }); } catch { teardown('uplink-flush-failed'); return; }
        }
        pendingToUpstream.length = 0;
      });

      // 存活语义：把两端的 ping/pong 互相透传，保持 dsh 的心跳判定不变
      client.on('ping', (data) => { try { upstream.ping(data); } catch { /* 已关 */ } });
      upstream.on('ping', (data) => { try { client.ping(data); } catch { /* 已关 */ } });
      client.on('pong', () => { try { upstream.pong(); } catch { /* 已关 */ } });
      upstream.on('pong', () => { try { client.pong(); } catch { /* 已关 */ } });

      client.on('close', (code, reason) => { void code; void reason; teardown('client-close'); });
      upstream.on('close', () => teardown('upstream-close'));
      client.on('error', () => teardown('client-error'));
      upstream.on('error', () => teardown('upstream-error'));

      wsBytesTracker.open();
    });
  }

  /**
   * 裸 socket 转发（`ws` 不可用时 / 用户关掉压缩时的回退路径）。
   *
   * 与改造前完全一致：不解析帧，只做双向 pipe。
   */
  function proxyUpgradeRaw({ req, socket, head, TARGET, c }) {
    const headers = prepareForwardHeaders(req, true, TARGET, c);
    const proxyReq = http.request({
      hostname: TARGET.hostname,
      port: TARGET.port,
      method: 'GET',
      path: req.url,
      headers,
      agent: false,   // 刻意不复用：升级连接会一直持有 socket
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

  function handleUpgrade(req, socket, head, auth, c) {
    socket.on('error', () => socket.destroy());
    if (!authGate(req, null, socket, auth, c.password, log)) return;

    const TARGET = target();

    // 压缩关闭 → 直接走原来的裸 pipe（与改造前行为完全一致）
    if (c.compressWebSocket === false) {
      proxyUpgradeRaw({ req, socket, head, TARGET, c });
      return;
    }

    void loadWs().then((wsMod) => {
      if (wsMod === null) {
        // 拿不到 ws：回退裸 pipe，功能降级但不断链
        wsCompressionReady = false;
        proxyUpgradeRaw({ req, socket, head, TARGET, c });
        return;
      }
      // 上游握手头：与 HTTP 转发同一套（Host/Origin 改写 + 会话代签）
      const headers = prepareForwardHeaders(req, true, TARGET, c);
      proxyUpgradeWithFrames({ wsMod, req, socket, head, TARGET, c, rawHeaders: headers });
    }).catch(() => {
      proxyUpgradeRaw({ req, socket, head, TARGET, c });
    });
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
        // 释放上游连接池：否则 keep-alive 的空闲 socket 会一直挂着，
        // 停用后仍占着到 dsh 的连接。
        try {
          upstreamAgent.destroy();
        } catch {
          /* 已释放 */
        }
        server = null;
        running = false;
        stopping = false;
        boundListen = null;
        log('info', '中转已停止，端口已释放');
        resolve(status());
      };
      const timer = setTimeout(finish, STOP_DRAIN_TIMEOUT_MS);

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
      patchedScripts: patchCount,
      patchMisses,
      passthroughScripts: passthroughCount,
      websocket: {
        compressEnabled: c.compressWebSocket,
        compressionReady: wsCompressionReady,
        openConnections: wsBytesTracker.connections,
        totalConnections: wsBytesTracker.opened,
        uplinkBytes: wsBytesCounter.uplink,
        downlinkBytes: wsBytesCounter.downlinkPlain,
      },
      startedAt: running ? startedAt : null,
      uptimeMs: running ? Date.now() - startedAt : 0,
      lastError,
    };
  }

  return { start, stop, status };
}
