/**
 * auth.js — 中转与管理路由的认证原语
 *
 * 从 relay.js 抽出（原 makeAuth / verifyToken / parseCookies / LOGIN_PAGE /
 * 登录限流）。抽出来的理由有两个：
 *
 *   1. **管理路由的鉴权要用同一套凭据**。`/dsh-public-relay/config` 与
 *      `/control` 是改配置（监听地址、上游目标、口令）的高危面，必须校验
 *      持有中转口令的人，而不是只靠一个 Origin 嗅探。
 *   2. **`isLoopbackPeer` 需要被两个文件共用**（index.js 的管理路由鉴权、
 *      relay.js 的登录限流取键）。两处各写一份必然漂移，所以集中在这里。
 *
 * ── 为什么 Origin 嗅探不足以保护管理路由 ──
 *
 * `isTrustedWrite`（index.js）原本就是管理路由唯一的门禁，而中转在
 * `rewriteHeaders` 里会把 Host / Origin 一并改写成上游回环权威。也就是说
 * 任何经中转进来的管理请求，到达 dsh 时 Origin 与 Host 天然相等 —— 判据按
 * 构造必然通过。它挡得住跨站网页，挡不住握着中转口令（或根本无口令）的
 * 任何客户端。
 *
 * 因此这里的边界是：**持有中转口令 = 持有管理权限**。bearer token 由口令
 * HMAC 派生，cookie 则是登录后下发的 relay_session，两者都只能由知道口令的
 * 一方构造；口令是 write-only 的（宿主半不回读），浏览器端拿不到原值。
 *
 * ── 口令为空时 ──
 *
 * `makeAuth('')` 返回 null，bearer 与 cookie 校验都无从进行。此时管理路由
 * **只允许回环对端**（127.0.0.1 / ::1）：本机 UI 与 CLI 仍可用，经中转来的
 * 请求一律 403。注意这不是「无认证开放」—— 监听在 0.0.0.0 时非回环客户端
 * 也会一并被拒，配置面因此不会因为忘记设口令就彻底裸露。
 */
'use strict';

import crypto from 'node:crypto';

/** 中转会话 cookie 名。 */
export const RELAY_COOKIE_NAME = 'relay_session';

/** 回环对端地址（大小写与 IPv6 写法都要认）。 */
const LOOPBACK_ADDRESSES = new Set([
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
]);

/**
 * 取连接的直连对端地址。
 *
 * **只认 socket，不看任何请求头** —— 这是整套限流与鉴权的地基：一旦采信
 * 客户端可写的头（X-Forwarded-For 之类），下面所有按 IP 做的判定就都成了
 * 攻击者自己说了算的事。
 */
export function peerAddressOf(req) {
  return req?.socket?.remoteAddress || 'unknown';
}

/** 对端是否为本机回环。 */
export function isLoopbackPeer(req) {
  return LOOPBACK_ADDRESSES.has(String(peerAddressOf(req)).toLowerCase());
}

/** 是否为回环地址字面量（供解析 XFF 时判断该值本身可不可信）。 */
export function isLoopbackAddress(value) {
  return LOOPBACK_ADDRESSES.has(String(value).trim().toLowerCase());
}

/**
 * 从 `Cookie:` 头里取指定名字的值。
 * 与 dsh-cookie.js 的同名函数语义一致（第一个匹配项胜出）。
 */
export function readCookieValue(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/** 解析 Cookie 头成普通对象。 */
export function parseCookies(req) {
  const out = {};
  for (const part of String(req?.headers?.cookie || '').split(';')) {
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

/**
 * HMAC-SHA256 签名 Cookie 会话；空口令返回 null（关闭认证）。
 *
 * @param {string} password 中转口令
 */
export function makeAuth(password) {
  if (!password) return null;
  const secret = crypto.createHmac('sha256', 'dsh-public-relay').update(password).digest();
  const cookieName = RELAY_COOKIE_NAME;
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

  return { cookieName, signToken, verifyToken, parseCookies, COOKIE_TTL_MS, LOGIN_PAGE };
}

/** 从 `Authorization: Bearer <token>` 取 token。 */
export function bearerTokenOf(req) {
  const raw = req?.headers?.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(value.trim());
  return m ? m[1] : undefined;
}

/**
 * 管理路由鉴权：bearer token 或 relay_session cookie 任一有效即放行。
 *
 * 口令为空（auth === null）时**一律拒绝** —— 调用方需自行回落到
 * `isLoopbackPeer`，本函数不替它做这个决定，因为「本地无口令仍可用」
 * 与「公网无口令全拒」是两个不同层次的策略，调用点的语境不同。
 */
export function isAdminRequest(req, auth) {
  if (!auth) return false;
  const bearer = bearerTokenOf(req);
  if (bearer !== undefined && auth.verifyToken(bearer)) return true;
  const cookie = readCookieValue(req?.headers?.cookie, auth.cookieName);
  return cookie !== undefined && auth.verifyToken(cookie);
}

// ─────────────────────────── 登录限流 ───────────────────────────

/**
 * 登录尝试限流（按来源 IP）。
 *
 * 为什么必须有：口令是这个公网面上**唯一**的边界，而失败的 400ms 延时只
 * 是拖慢单条连接，攻击者开 N 条并发就摊平了。
 *
 * ── 0.2.3 加固：取键不再采信 X-Forwarded-For ──
 *
 * 原实现优先读 `x-forwarded-for` 的**第一项**。这是可被请求方任意构造的：
 * 每请求换一个伪造 IP 就能让计数归零，滑动窗口形同虚设，在线爆破速率等于
 * 网络带宽。现在的规则：
 *
 *   · 默认真实地用 `socket.remoteAddress`（唯一不可伪造的事实）；
 *   · 仅当**直连对端本身就是回环**（即确实有个本地隧道/反代在中间）时才
 *     读 XFF，并且取**最后一项** —— 正向代理（nginx / frp / 樱花映射）在
 *     追加链尾，链尾才是它自己看到的那个地址；
 *   · 对端不是回环时，XFF 一律忽略。
 *
 * 剩余的诚实说明：隧道场景下同链的多个客户端会共享「隧道出口 IP」这一个
 * 键，因此限流偏严而非偏松。要按真实客户端细分，需要由隧道层自己来做。
 */
export const LOGIN_WINDOW_MS = 5 * 60 * 1000;
export const LOGIN_MAX_FAILS = 8;
export const LOGIN_TRACK_LIMIT = 4096;

/**
 * 限流键：默认 socket 地址；仅回环对端才采信 XFF 的最后一项。
 */
export function loginKeyOf(req) {
  const peer = peerAddressOf(req);
  if (!isLoopbackAddress(peer)) return peer;
  const forwarded = req?.headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return peer;
}

/**
 * 建一个**实例内**的登录失败表。
 *
 * 原来是模块级单例：一个 relay 实例的失败计数会污染同进程里另一个实例，
 * 而且测试之间会互相污染。表归实例所有后，多实例/多测试互不干扰。
 *
 * 驱逐顺序也一并修正：原先按插入序删最旧（Map 迭代序），而**刷新时不会
 * 改变插入位置**，于是某个高频键即使刚失败过、窗口还很早，也可能被当成
 * 「最旧」丢掉。改为按 `resetAt` 时间序找真正最早到期的那一项。
 *
 * @returns {{ isLimited, record, clear, size, snapshot }}
 */
export function createLoginLimiter({
  windowMs = LOGIN_WINDOW_MS,
  maxFails = LOGIN_MAX_FAILS,
  limit = LOGIN_TRACK_LIMIT,
} = {}) {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const failures = new Map();

  function evictIfNeeded() {
    if (failures.size < limit) return;
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, rec] of failures) {
      if (rec.resetAt < oldestAt) { oldestAt = rec.resetAt; oldestKey = key; }
    }
    if (oldestKey !== null) failures.delete(oldestKey);
  }

  return {
    /** 该来源当前是否已被限流。 */
    isLimited(req) {
      const key = loginKeyOf(req);
      const rec = failures.get(key);
      if (rec === undefined) return false;
      if (Date.now() >= rec.resetAt) { failures.delete(key); return false; }
      return rec.count >= maxFails;
    },
    /** 记录一次失败（成功登录应调 clear）。 */
    record(req) {
      const key = loginKeyOf(req);
      const now = Date.now();
      const rec = failures.get(key);
      if (rec === undefined || now >= rec.resetAt) {
        evictIfNeeded();
        failures.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      rec.count += 1;
    },
    /** 登录成功，清空该来源的计数（正常用户误输几次不会被惩罚）。 */
    clear(req) {
      failures.delete(loginKeyOf(req));
    },
    /** 当前表大小（测试用）。 */
    size() { return failures.size; },
    /** 快照（测试用）。 */
    snapshot() { return Object.fromEntries(failures); },
  };
}

/** 登录页。口令错误等提示以 `__ERR__` 占位。 */
export const LOGIN_PAGE = `<!DOCTYPE html>
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