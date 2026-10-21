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
 *
 * 0.2.3 相对 0.2.x 的实质改动：
 *   · 认证原语（makeAuth / verifyToken / parseCookies / LOGIN_PAGE / 登录限流）
 *     迁到 lib/auth.js —— 管理路由的鉴权要与中转共用同一套凭据，而
 *     `isLoopbackPeer` 需要被 index.js 与本文件共用，集中才不会漂移。
 *   · 登录限流取键不再采信可伪造的 X-Forwarded-For 第一项（见 auth.js）。
 *   · 限流表从模块级单例改为实例内状态。
 */
'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';

import {
  createLoginLimiter,
  isLoopbackPeer,
  loginKeyOf,
  makeAuth,
  LOGIN_PAGE,
  LOGIN_WINDOW_MS,
} from './auth.js';
import { isLoopbackTargetHost, LOOPBACK_TARGET_HOSTS } from './config.js';

/**
 * 兼容性再导出：这些符号原先由本文件定义，测试与其它调用方仍从
 * `lib/relay.js` 引入。实现已迁到 lib/auth.js。
 */
export { makeAuth, loginKeyOf, isLoopbackPeer, LOGIN_PAGE };

// ─────────────────────────── 常量 ───────────────────────────

/** hop-by-hop 头：逐跳语义不能透传；upgrade 场景单独保留 connection/upgrade。 */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/**
 * 上游**连接**阶段兜底超时（DNS + TCP + 等 socket 就绪）。
 *
 * 只覆盖「能不能连上」，**不覆盖**「上游什么时候回响应」——
 * 后者见 UPSTREAM_RESPONSE_TIMEOUT_MS 的说明。
 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15000;

/**
 * 上游**响应头**等待上限（连接建立之后才开始计时）。
 *
 * 为什么需要它：上游可能「TCP 连得上但永不应答」（进程挂死、accept 后不处理），
 * 若此时完全没有超时，请求会永久悬挂，客户端只能干等到自己超时。
 *
 * 为什么给到 5 分钟这么宽：
 *   · 这个计时器**只等响应头**，不等响应体。HTTP 代理的响应头是上游处理完
 *     请求后立刻发出的，不存在「合法但要等很久」的情形 —— 慢的是响应体
 *     （AI 流式输出、大文件），而响应体一旦开始传输就不再计时。
 *   · 但 `session/prompt` 这类调用在 dsh 侧可能先做较久的准备（读上下文、
 *     建 session）才回响应头，所以不能设得太紧（旧版 15s 就是这么出事的）。
 *   · 5 分钟足以覆盖「上游活着只是慢」，又能在真挂死时给客户端一个明确失败。
 */
const UPSTREAM_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

const STOP_DRAIN_TIMEOUT_MS = 2000;

/**
 * 单个改写目标脚本允许缓冲的**压缩后**字节上限。
 *
 * handlePatchedScript 必须把整个响应读进内存才能做结构化改写（要按括号深度
 * 扫出 isLoopback 的值表达式），所以这里天然需要一个上限，否则一个超大响应
 * 就能把中转进程的内存吃光。白名单内的目标只有 dsh-client-connection 的
 * combo 产物（实测 10 MB 量级），32 MiB 给了三倍余量。
 *
 * 超限的处理：立刻销毁上游响应并回 502，**不把已缓冲的字节往 res 写** ——
 * 那时还没 writeHead，写出去就是半个响应体，浏览器只会看到一个损坏的脚本。
 */
const MAX_PATCH_BYTES = 32 * 1024 * 1024;

/**
 * 解压/压缩时允许产出的**明文**字节上限。
 *
 * 压缩炸弹的形态就是「压缩后很小、解压后巨大」，而 decodeBody 的产物是要
 * 整份转成字符串再扫描的。给到 64 MiB：比 MAX_PATCH_BYTES 宽裕（压缩后的
 * 32 MiB 理论上能解出远大于自身的内容），但仍是有限的。
 *
 * 注意这条上限**故意不做到「永不触发」**：触发时 zlib 抛错，调用点的 catch
 * 分支会把上游原字节原样透传 —— 页面照常工作，只是这次没做 isLoopback 改写。
 * 这是刻意的降级，不是错误。
 */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

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

/**
 * WS 下行背压阈值（字节）。
 *
 * `WebSocket#bufferedAmount` = 「已进发送队列、尚未写完 socket」的字节数。
 * 它**不随单帧大小跳变**，只反映对端读得有多慢：正常客户端的 TCP 窗口远大于
 * 此值，单帧在下一帧到达前通常已写空，稳态下这个数很小。
 *
 * 为什么是 8 MiB：dsh 的历史快照单帧实测 4~6.6 MB。8 MiB 给单帧留了约
 * 1.2~1.7 倍余量，所以**正常的 4~6 MB 历史帧不会被误伤**；而一旦它真的涨到
 * 8 MiB，说明客户端已经卡死或链路停滞，此时继续排队只会让内存无界增长，
 * 断连是唯一正确的选择。
 *
 * 与 `maxPayload`（64 MB）的分工：maxPayload 挡**单帧**上限，这里管**累计**。
 */
const WS_DOWNLINK_BACKPRESSURE_LIMIT = 8 * 1024 * 1024;

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

/**
 * 把 header 表序列化成 HTTP 头文本（用于手写的 101 / 错误响应）。
 *
 * **必须过滤 CR/LF**：这些值来自上游（`proxyRes.headers`），而上游可能是
 * 任何东西。头值里混进 `\r\n` 就等于往我们手写的响应里注入新头/新响应，
 * 即经典的 HTTP response splitting。
 *
 * （正常路径走 `res.writeHead()` 时由 Node 自己校验，但 101 与错误响应是
 * 我们拼字符串写的，Node 管不到。）
 *
 * @param headers - 头表
 * @returns 可直接拼进响应头的文本
 */
export function serializeHeaders(headers) {
  /** 去掉一切可能截断头的字符。 */
  const clean = (v) => String(v).replace(/[\r\n\0]/g, ' ');
  let out = '';
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    const name = clean(k);
    // 头名不能含冒号/空白，否则同样能造出新头
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    for (const val of Array.isArray(v) ? v : [v]) out += `${name}: ${clean(val)}\r\n`;
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
 * 规则：维护 `()[]{}` 深度；跳过字符串字面量与注释；深度为 0 时遇到
 * `,` `;` `)` `}` 或换行即结束。越界或深度变负则判定失败（返回 -1）。
 *
 * 注释必须跳过：否则 `isLoopback: foo /* } *​/` 这类值会让深度算错，
 * 进而把后半段代码一起吞掉，产出语法错误的 JS（整包白屏）。
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
    const next = source[i + 1];
    // 行注释：跳过后面的全部内容，注释里的括号不算深度
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    // 块注释：同上
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
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
 * 判断某个偏移是否落在字符串 / 注释 / 正则字面量里。
 *
 * 只用来**排除**误命中，不需要完整词法分析：从脚本开头线性扫一遍，
 * 维护「我在不在字面量里」即可。命中位置在字面量里就跳过。
 *
 * @param source - 整段脚本
 * @returns (index: number) => boolean，true 表示该位置在字面量或注释内
 */
function makeLiteralMask(source) {
  const len = source.length;
  /** 每段字面量/注释的 [start, end) 区间 */
  const ranges = [];
  let i = 0;
  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < len && source[i] !== '\n') i += 1;
      ranges.push([start, i]);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(len, i + 2);
      ranges.push([start, i]);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      const quote = ch;
      i += 1;
      while (i < len) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      ranges.push([start, i]);
      continue;
    }
    i += 1;
  }
  return (index) => ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * 找出脚本里所有 `isLoopback: <expr>` 的可替换片段。
 *
 * 四道闸门，缺一不可：
 *   ① 键名必须是 `isLoopback:`；
 *   ② 前一个字符必须是 `{` `,` `(` 或空白（对象字面量键的形态）；
 *   ③ 命中位置**不能落在字符串/注释里**（否则会把注释里的说明文字当代码改，
 *      实测会产出语法错误的 JS）；
 *   ④ 值表达式里必须出现 isLoopback / ownsHost / pageLocation 之一。
 *
 * @param source - 客户端脚本
 * @returns `[start, end)` 区间数组（区间内容可整体替换）
 */
export function findIsLoopbackSpans(source) {
  const KEY = 'isLoopback:';
  const inLiteral = makeLiteralMask(source);
  const spans = [];
  let cursor = 0;
  for (;;) {
    const at = source.indexOf(KEY, cursor);
    if (at < 0) break;
    if (inLiteral(at)) { cursor = at + KEY.length; continue; }
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
      return zlib.gunzipSync(buffer, { maxOutputLength: MAX_DECODED_BYTES });
    case 'deflate':
      return zlib.inflateSync(buffer, { maxOutputLength: MAX_DECODED_BYTES });
    case 'br':
      return zlib.brotliDecompressSync(buffer, {
        params: { [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length },
        maxOutputLength: MAX_DECODED_BYTES,
      });
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
      return zlib.gzipSync(buffer, { level: 1, maxOutputLength: MAX_DECODED_BYTES });
    case 'deflate':
      return zlib.deflateSync(buffer, { level: 1, maxOutputLength: MAX_DECODED_BYTES });
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
//
// makeAuth / LOGIN_PAGE 已迁到 lib/auth.js（见文件头的兼容性再导出）。

/**
 * 判断这是否是 dsh 自己的启动令牌交换请求（`GET /?token=…`）。
 *
 * ── 安全边界（0.2.2 修复）──
 *
 * 这类请求必须**原样**到达 dsh：token 是一次性凭据，被中转的登录页吃掉就
 * 再也换不出会话 Cookie。所以它需要绕过中转自己的口令页。
 *
 * **但绕过必须严格限定在 dsh 真正处理它的那一个请求上**，否则等于开了一个
 * 万能后门。dsh 的 `authorizeIndex` 只在下面这个形状里接受 token：
 *
 *     GET /?token=<唯一一个 token>      ← pathname 必须是 "/"，且 token 恰好一个
 *     GET /?token=…&…                  ← 其它 pathname 一律 401，不认 token
 *
 * 因此这里逐条对齐，任何一条不满足就不算令牌交换（请求会继续走口令认证）：
 *
 *   · method 必须是 GET
 *   · **pathname 必须是 `/`** —— 这是最关键的约束。旧实现只看「有没有 token
 *     参数」，于是 `GET /api/any?token=x` 也能免口令直达 dsh；叠加 autoSession
 *     的代签后，未认证攻击者能拿到完整的 dsh 会话（已实测复现）。
 *   · token 必须恰好一个、且非空
 *
 * @param req - 入站请求
 * @returns true 表示这是 dsh 的启动令牌交换，应原样放行
 */
function isDshTokenExchange(req) {
  if (req.method !== 'GET') return false;
  let url;
  try {
    url = new URL(req.url, 'http://placeholder');
  } catch {
    return false;
  }
  if (url.pathname !== '/') return false;
  const tokens = url.searchParams.getAll('token');
  return tokens.length === 1 && tokens[0] !== '';
}

/**
 * 从一次「形状像启动令牌交换」的请求里取出 token 原文。
 * 只在 isDshTokenExchange 已经返回 true 后调用。
 */
function tokenOfExchange(req) {
  try {
    const url = new URL(req.url, 'http://placeholder');
    const tokens = url.searchParams.getAll('token');
    return tokens.length === 1 ? tokens[0] : null;
  } catch {
    return null;
  }
}

/**
 * 判断这个 `?token=` 是否**确实是本进程当前有效的启动令牌**。
 *
 * ── 为什么必须校验（0.3.1 修复）──
 *
 * 旧实现只校验「形状」就放行：只要 `GET /?token=<非空>` 就跳过中转口令认证。
 * 于是**任何**带 `token` 的 URL —— 包括浏览器书签里那条来自**上一次 dsh 启动**
 * 的旧 URL —— 都能绕过中转口令。而 dsh 重启后旧 token 必然作废，结果是：
 *
 *   用户带旧 token 打开 → 中转放行 → dsh 回 401
 *   「dsh web authentication required; reopen the URL printed by dsh web.」
 *
 * 用户看到的是「不用输口令就进了页面，但所有操作都 401」，而真正该看到的
 * 是**中转自己的口令登录页**。绕过自家中转口令、把请求丢给一个必然拒绝的
 * 上游，比直接要求输口令糟糕得多。
 *
 * ── 拿不到令牌时为什么选择「不放行」──
 *
 * `resolveLaunchToken` 由宿主半注入，从 dsh 的 connection 服务读当前进程的
 * launchToken。读不到（服务未就绪 / 版本差异 / 权限）时无法验证真伪，此时
 * **安全默认是不信任**：退化到「要求输入中转口令」。代价是失去 token 免密
 * 的便利，换来的是永远不会因为一个过期 URL 把人送进死路。
 *
 * 比较用恒定时比较：token 是凭据，`===` 会在首个不同字节处提前返回，
 * 理论上可被时序探测逐字节猜出。
 *
 * @param req - 入站请求
 * @param resolveLaunchToken - () => string|null，返回本进程当前 launchToken
 * @returns {{ ok: boolean, reason: string }}
 *   reason ∈ 'not-exchange' | 'verified' | 'unavailable' | 'mismatch'
 */
function verifyDshTokenExchange(req, resolveLaunchToken) {
  if (!isDshTokenExchange(req)) return { ok: false, reason: 'not-exchange' };
  const token = tokenOfExchange(req);
  if (token === null) return { ok: false, reason: 'mismatch' };

  let expected = null;
  try {
    expected = typeof resolveLaunchToken === 'function' ? resolveLaunchToken() : null;
  } catch {
    expected = null;
  }
  if (typeof expected !== 'string' || expected === '') {
    return { ok: false, reason: 'unavailable' };
  }

  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true, reason: 'verified' }
    : { ok: false, reason: 'mismatch' };
}

/**
 * `?token=` 交换被拒的计数与最近原因。
 *
 * 为什么要有：这个缺陷（带过期 token 的 URL 绕过口令、结果撞上 dsh 的 401）
 * 的症状与「转发出错」长得一样，仅凭 HTTP 状态码分不清。把「拒绝过几次、
 * 最近一次为什么」暴露到状态面板上，下一次同类问题能一眼看出。
 *
 * 只存计数、时间与原因枚举 —— **绝不存 token 原值或 query**：那是凭据。
 */
const tokenExchangeStats = {
  rejects: 0,
  lastReason: null,
  lastRejectAt: null,
};

/**
 * 这个未认证请求是否应该看到登录页（而不是裸 401）。
 *
 * 两种情形：浏览器请求文档（Accept 含 text/html），或直接访问站点根路径。
 * 其它情况（API、静态资源、WebSocket）一律 401/401 文本 —— 让前端能明确
 * 区分「没登录」与「页面没渲染」。
 */
function wantsLoginPage(req) {
  if (req.method !== 'GET') return false;
  const raw = req.url === undefined ? '/' : req.url;
  /*
   * 按 **pathname** 判断，不按整条 URL 前缀。
   *
   * 旧实现里有 `url.startsWith('/?')`，意思是「根路径带任意 query 就当文档请求」。
   * 这在 `?token=` 被单独放行之后几乎不会命中，而且语义是歪的：判「要不要
   * 给登录页」应当只看请求的是什么**资源**，与查询串无关。
   */
  let pathname = raw;
  const cut = raw.indexOf('?');
  if (cut !== -1) pathname = raw.slice(0, cut);
  if (pathname === '/' || pathname === '/index.html') return true;
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * 浏览器到中转这一段是否走 TLS。
 *
 * 中转自己通常是明文 HTTP（监听 127.0.0.1，由隧道终结 TLS），所以不能只看
 * `socket.encrypted`。优先看反向代理常见的 `x-forwarded-proto`，再看本连接
 * 是否是 TLS socket。两者都没有就判明文 —— 此时不加 Secure，否则浏览器
 * 根本不会回传 Cookie，用户会陷入「登录成功但立刻又要求登录」的死循环。
 *
 * @param req - 入站请求
 * @returns 是否按 HTTPS 处理
 */
function isSecureRequest(req) {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') return true;
  return req.socket !== undefined && req.socket.encrypted === true;
}

/**
 * 登录尝试限速（按来源 IP）。
 *
 * 取键规则、阈值常量与限流表都在 auth.js（`loginKeyOf` /
 * `createLoginLimiter`）：取键必须与 index.js 的 `isLoopbackPeer` 共享同一套
 * 「只信 socket、对端非回环就忽略 XFF」的规则，两处各写一份必然漂移。表本身
 * 由 createRelay **按实例**创建 —— 模块级单例会互相污染同一进程里的其它
 * relay 实例，测试之间也会串味。
 *
 * 为什么必须有：口令是这个公网面上**唯一**的边界，而失败的 400ms 延时只是
 * 拖慢单条连接，攻击者开 N 条并发就摊平了。滑动窗口才是真正的屏障。
 *
 * 说明：这是进程内状态，重启即清零；对「拖慢在线爆破」足够，不是对抗分布式
 * 攻击的方案（那需要上游/WAF 层）。隧道场景下同链客户端共享一个键，限流偏严。
 */

/**
 * 认证入口：未登录时返回登录页 / 401；处理 POST /__login。
 * @param limiter - 实例级登录限流表（createLoginLimiter 的返回值）
 * @returns true 表示已放行，false 表示本函数已接管响应。
 */
function authGate(req, res, socket, auth, password, log, limiter, tokenCheck) {
  if (!auth) return true;

  /*
   * dsh 的启动令牌交换优先放行 —— 但**必须验真**（见 verifyDshTokenExchange）。
   *
   * 只有拿到本进程当前 launchToken 且与之相等才放行；否则：
   *   · 不把请求丢给上游（那必然 401，且对用户是「页面能开、操作全挂」的死路）
   *   · 落到下面的常规「未认证」出口 → 展示中转口令登录页
   *
   * 日志里**只记 reason，不记 token 与 query** —— 那是一次性凭据。
   */
  if (tokenCheck !== undefined && tokenCheck !== null) {
    if (tokenCheck.ok) {
      log?.('info', '放行 dsh 启动令牌交换（已验真）');
      return true;
    }
    if (tokenCheck.reason !== 'not-exchange') {
      // 形状像交换但验不过：计数 + 记原因，供状态面板观察。
      // 只记 reason，不记 token 与 query —— 那是一次性凭据。
      tokenExchangeStats.rejects += 1;
      tokenExchangeStats.lastReason = tokenCheck.reason;
      tokenExchangeStats.lastRejectAt = Date.now();
      log?.('warn', `拒绝 ?token= 交换（${tokenCheck.reason}），改为要求中转口令`);
    }
  } else if (isDshTokenExchange(req)) {
    // 没有校验器（老调用点，例如测试里直接调 authGate）：
    // 主路径已一律传 tokenCheck，这里只为兼容既有调用形状。
    log?.('info', '放行 dsh 启动令牌交换');
    return true;
  }

  const token = auth.parseCookies(req)[auth.cookieName];
  if (auth.verifyToken(token)) return true;

  if (req.method === 'POST' && req.url === '/__login') {
    // 限流优先于读 body：被限的请求不该再消耗读取与 hash 的开销
    if (limiter.isLimited(req)) {
      log?.('warn', '登录尝试过于频繁，已临时限流');
      if (res) {
        res.writeHead(429, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': String(Math.ceil(LOGIN_WINDOW_MS / 1000)),
        });
        res.end(auth.LOGIN_PAGE.replace('__ERR__', '<div class="err">尝试过于频繁，请稍后再试</div>'));
      }
      return false;
    }
    let body = '';
    let over = false;
    /** 登录表单上限：口令 + 极少数额外字段足够。 */
    const LOGIN_BODY_LIMIT = 16 * 1024;
    req.on('data', (chunk) => {
      if (over) return;              // 已超限：不再继续累积
      body += chunk;
      if (body.length > LOGIN_BODY_LIMIT) {
        over = true;
        // 立刻丢弃已收内容并断开 —— 只打标记继续读会让这个**免认证**端点
        // 成为内存耗尽入口（慢速灌包时 end 可能永远不来）。
        body = '';
        if (res && !res.headersSent) {
          res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('payload too large');
        }
        req.destroy();
      }
    });
    req.on('error', () => { /* 连接被对端打断，无需处理 */ });
    req.on('end', () => {
      if (over) return;
      const input = new URLSearchParams(body).get('password') || '';
      const ha = crypto.createHash('sha256').update(input).digest();
      const hb = crypto.createHash('sha256').update(password).digest();
      const ok = crypto.timingSafeEqual(ha, hb);
      // 记录失败计数（成功则清零）。必须在延时之外做，否则并发请求
      // 会在延时窗口里全部「看起来还没失败」，限流形同虚设。
      if (ok) limiter.clear(req);
      else limiter.record(req);
      // 失败延时，拖慢暴力破解（真正的屏障是上面的滑动窗口限流）
      setTimeout(() => {
        if (!res || res.headersSent) return;
        if (ok) {
          const exp = Date.now() + auth.COOKIE_TTL_MS;
          // 隧道若是 HTTPS（樱花映射的 https 隧道 / 前面的反代做了 TLS），
          // 就必须带 Secure，否则浏览器可能把 Cookie 也发到明文端口。
          // 判断依据是浏览器实际用的协议：转发头优先，其次看本连接是否 TLS。
          const isSecure = isSecureRequest(req);
          res.writeHead(302, {
            location: '/',
            'set-cookie': `${auth.cookieName}=${auth.signToken(exp)}; Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}; Max-Age=${Math.floor(auth.COOKIE_TTL_MS / 1000)}`,
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

  /*
   * 未认证时的三条出口。
   *
   * 关键点：**upgrade 路径传进来的 res 是 null**。旧实现里的
   * `if (wantsLoginPage(req)) { if (res) {...} return false; }` 在 res 为 null
   * 时什么也不写就返回，socket 既不响应也不关闭 —— 而浏览器发起 WebSocket
   * 握手时默认带 `Accept: text/html`，于是**每个**未认证的 WS 尝试都会漏一个
   * 永不释放的连接（start() 把它们记在 liveSockets 里），构成免认证的
   * fd/内存耗尽。所以这里必须保证：无论 res 是否存在，出口都会关闭连接。
   */
  if (res) {
    if (wantsLoginPage(req)) {
      const page = auth.LOGIN_PAGE.replace('__ERR__', '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    } else {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('dsh-public-relay: 未登录（需要访问口令）。\n');
    }
    return false;
  }
  if (socket) {
    // 裸 socket（upgrade）：一律回 401 并关闭，绝不留悬空连接
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\ndsh-public-relay: 未登录（需要访问口令）');
    } catch { /* 对端已关 */ }
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
 * @param options.resolveLaunchToken - () => string|null，本进程当前 dsh 启动令牌。
 *   用于**验真** `?token=` 交换；拿不到就一律要求中转口令（安全默认）。
 * @returns { start, stop, status }
 */
export function createRelay(options = {}) {
  const {
    getDshEndpoint, getConfig, log = () => {}, sessionSigner = null, resolveLaunchToken = null,
  } = options;

  /** @type {import('node:http').Server|null} */
  let server = null;
  /** @type {Set<import('node:net').Socket>} */
  const liveSockets = new Set();
  let running = false;
  let startedAt = 0;
  let lastError = null;
  let boundListen = null;
  let requestCount = 0;
  let patchCount = 0;
  let patchMisses = 0;
  let passthroughCount = 0;
  let authCache = { password: undefined, auth: null };

  /**
   * 登录失败表：**本实例私有**。
   *
   * 原先是模块级单例，于是同进程里两个 relay 实例（多 profile、或测试并行）
   * 会共用一张表：一边爆破就能把另一边正常用户的计数顶掉，且测试之间会串味。
   * 归实例所有后互不影响，实例销毁时随之回收。
   */
  const loginLimiter = createLoginLimiter();

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
   * 上游 401 的观测记录（只保留最近 N 条，供状态面板与日志用）。
   *
   * 存在理由见 recordUpstream401 的说明：偶发 401 在单次测试里永远复现不了，
   * 必须有「事发当时」的证据留存。
   */
  const upstream401s = { count: 0, last: null, samples: [] };

  /**
   * 记录一次「上游以 401 拒绝了我们的转发」。
   *
   * 这是纯观测：不改变请求、不改变响应、不影响任何判定。
   * 记录内容只够定位问题，不含可用凭据（不写 cookie 签名原文）。
   *
   * @param req - 浏览器侧的入站请求
   * @param proxyRes - 上游的响应
   */
  function recordUpstream401(req, proxyRes) {
    upstream401s.count += 1;
    try {
      const forwarded = proxyRes.req;
      const sentCookie = String(forwarded?.getHeader?.('cookie') ?? '');
      /** 只留 dsh-auth 的「名字前 8 位 + payload 时间字段」，不记签名。 */
      const authCookies = sentCookie.split(';')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('dsh-auth-'))
        .map((s) => {
          const eq = s.indexOf('=');
          const name = eq > 0 ? s.slice(0, eq) : s;
          const value = eq > 0 ? s.slice(eq + 1) : '';
          const info = { nameHash: name.replace('dsh-auth-', '').slice(0, 8), version: null, authority: null, issuedAt: null, expiresAt: null };
          const parts = value.split('.');
          if (parts.length === 3) {
            info.version = parts[0];
            try {
              const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              info.authority = p.authority ?? null;
              info.issuedAt = p.issuedAt ?? null;
              info.expiresAt = p.expiresAt ?? null;
              if (typeof p.issuedAt === 'number' && typeof p.expiresAt === 'number') {
                info.ageMs = Date.now() - p.issuedAt;
                info.remainMs = p.expiresAt - Date.now();
              }
            } catch { /* payload 解析失败就只留名字 */ }
          }
          return info;
        });

      const entry = {
        at: new Date().toISOString(),
        method: req.method,
        path: (req.url ?? '').split('?')[0],
        upstreamAuthority: TARGET_AUTHORITY_FOR_LOG(),
        sentDshCookies: authCookies,
        sentRelaySession: sentCookie.includes('relay_session='),
        clientHost: req.headers.host ?? null,
        clientOrigin: req.headers.origin ?? null,
      };
      upstream401s.last = entry;
      upstream401s.samples.push(entry);
      if (upstream401s.samples.length > 10) upstream401s.samples.shift();

      log('warn', `[upstream-401] ${entry.method} ${entry.path} — 上游拒绝本次转发`
        + `（注入 ${authCookies.length} 条 dsh-auth，authority=`
        + `${authCookies.map((c) => c.authority ?? '?').join(',') || '无'}）`);
    } catch (err) {
      log('warn', `[upstream-401] 记录失败：${err?.message || err}`);
    }
  }

  /** 状态里报告上游 authority（recordUpstream401 用，容忍 target() 抛错）。 */
  function TARGET_AUTHORITY_FOR_LOG() {
    try {
      return target().authority;
    } catch {
      return null;
    }
  }

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
      // 跨主机必须显式知情打开（见 config.js 的 DEFAULTS.allowOffHostTarget）
      allowOffHostTarget: c.allowOffHostTarget === true,
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
    // 两段式超时：connect 只管建连，response 只管等响应头（见 handleRequest 的详细说明）
    const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);
    let responseTimer = null;
    proxyReq.on('socket', () => {
      clearTimeout(timer);
      if (responseTimer === null && !proxyReq.destroyed) {
        responseTimer = setTimeout(
          () => proxyReq.destroy(new Error('upstream response timeout')),
          UPSTREAM_RESPONSE_TIMEOUT_MS,
        );
      }
    });
    const clearTimers = () => {
      clearTimeout(timer);
      if (responseTimer !== null) clearTimeout(responseTimer);
    };

    proxyReq.on('response', (proxyRes) => {
      clearTimers();
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
      // 显式累计字节数：不靠每次 chunks.reduce 求和 —— 一旦超限就要立刻决断，
      // 没必要为了算总数把整份响应再遍历一遍。
      let receivedBytes = 0;
      let overflowed = false;
      proxyRes.on('data', (chunk) => {
        if (overflowed) return;
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_PATCH_BYTES) {
          overflowed = true;
          chunks.length = 0;          // 丢掉已缓冲字节，别让它们流向 res
          proxyRes.destroy();         // 停止从上游读取
          // 此刻还没 writeHead，可以干净地回一个 502；写半个响应体只会让
          // 浏览器拿到一个截断的脚本，比报错更难排查。
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(`relay: 上游脚本超过 ${MAX_PATCH_BYTES} 字节上限，已拒绝改写。\n`);
          } else {
            res.destroy();
          }
          return;
        }
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        if (overflowed) return;
        const original = Buffer.concat(chunks);

        let plain;
        try {
          plain = decodeBody(original, encoding);
        } catch (err) {
          // 解压失败（上游编码不符，或触到 MAX_DECODED_BYTES）：透传原字节。
          // 这条路径必须始终可用 —— 它正是 maxOutputLength 生效时的兜底，
          // 保证「解不动」只降级为「这次不改写」，不会弄坏页面。
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
        // 内容变了，上游那套「按原字节算出来的」校验/长度头全部失效。留着它们
        // 比删掉更糟：浏览器会拿旧 etag 去条件请求，拿到一个 304 空响应，
        // 页面于是用了缓存里的旧脚本 —— 表现为改写「时灵时不灵」。
        delete upstreamHeaders['etag'];
        delete upstreamHeaders['last-modified'];
        delete upstreamHeaders['content-md5'];
        delete upstreamHeaders['content-range'];
        delete upstreamHeaders['digest'];
        delete upstreamHeaders['content-digest'];
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
      clearTimers();
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
    let responseTimer = null;
    const clearTimers = () => {
      clearTimeout(timer);
      if (responseTimer !== null) clearTimeout(responseTimer);
    };
    // 连接阶段兜底；拿到 socket 后转为「等响应头」计时（两段式）
    proxyReq.on('socket', () => {
      clearTimeout(timer);
      if (responseTimer === null && !proxyReq.destroyed) {
        responseTimer = setTimeout(
          () => proxyReq.destroy(new Error('upstream response timeout')),
          UPSTREAM_RESPONSE_TIMEOUT_MS,
        );
      }
    });
    let retried = false;

    proxyReq.on('response', (proxyRes) => {
      clearTimers();
      const status = proxyRes.statusCode || 502;

      // 上游拒绝这个 authority（信任栅栏）：改成回环权威重试一次。
      // 只在还没重试过、且确实是 403/401 时才回退，避免掩盖真实业务错误。
      if (!triedFallback && !retried && (status === 403 || status === 401)) {
        retried = true;
        // 只记 pathname：`req.url` 的 query 里是一次性启动令牌，
        // 写进日志等于把它泄露到日志文件（dsh 自己刻意用 no-referrer 保护它）。
        log('warn', `令牌交换被上游以 ${status} 拒绝（authority 未受信），改用回环权威重试`);
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
      clearTimers();
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
    /*
     * 令牌校验只算一次，结果同时给 authGate（是否放行）与下面的转发分支用。
     *
     * 注意：authGate 通过后，走到这里的 `?token=` 一定是**已验真**的（否则
     * 它已经在 authGate 里被降级成中转登录页并 return 了）。所以下面的
     * forwardTokenExchange 分支只可能是真的交换，不再是任意 token 的后门。
     */
    const tokenCheck = verifyDshTokenExchange(req, resolveLaunchToken);
    if (!authGate(req, res, null, auth, c.password, log, loginLimiter, tokenCheck)) return;

    const TARGET = target();

    // 令牌交换且不代签 → 保留浏览器原始 authority，让 dsh 自己按它签 cookie。
    // 代签生效时不需要这条路（详见 forwardTokenExchange 的说明）。
    if (tokenCheck.ok && !(sessionSigner && c.autoSession !== false && c.password)) {
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
    /*
     * ── 两段式超时（2026-10-20 修复）──
     *
     * 旧实现只有一个 15s 的定时器，且直到收到 `response` 才清除 ——
     * 于是「连接超时」实际变成了**整个请求的总时限**。任何上游响应慢于
     * 15s 的请求都被 destroy，回 502「upstream connect timeout」（而连接
     * 明明是好的）。
     *
     * 受害最重的是 `session/prompt`：它是发起 AI 对话，正常就要几十秒到
     * 几分钟。经中转时必然在 15s 被掐断，用户看到的就是「一操作就失败」。
     *
     * 但**不能**简单地把定时器一到 socket 就清掉：上游若是「TCP 连得上但
     * 永不应答」（进程挂死 / accept 后不处理），请求就会永久悬挂。所以拆成两段：
     *
     *   ① connectTimer  —— 只管 DNS + TCP + 拿到 socket。超时 15s。
     *   ② responseTimer —— socket 就绪后启动，只管「等响应头」。给一个宽松上限
     *                      （响应头迟迟不来 = 上游异常），但**不限制响应体传输
     *                      时长** —— 长任务可以持续输出很久。
     *
     * 响应体一旦开始传输就不再计时：由客户端 abort/close 决定何时放弃，
     * 这正是长连接（AI 对话流）需要的行为。
     */
    const connectTimer = setTimeout(
      () => proxyReq.destroy(new Error('upstream connect timeout')),
      UPSTREAM_CONNECT_TIMEOUT_MS,
    );
    let responseTimer = null;
    proxyReq.on('socket', () => {
      clearTimeout(connectTimer);
      // 连接已建立，转而限制「等响应头」的时间
      if (responseTimer === null && !proxyReq.destroyed) {
        responseTimer = setTimeout(
          () => proxyReq.destroy(new Error('upstream response timeout')),
          UPSTREAM_RESPONSE_TIMEOUT_MS,
        );
      }
    });
    /** 两个定时器一起撤，避免泄漏。 */
    const clearTimers = () => {
      clearTimeout(connectTimer);
      if (responseTimer !== null) clearTimeout(responseTimer);
    };

    proxyReq.on('response', (proxyRes) => {
      clearTimers();
      /*
       * 上游 401 诊断（2026-10-21）。
       *
       * 用户报「发提示词时偶发 401，刷新页面才恢复」。这类故障最难查，因为：
       *   · relay 对上游 401 是**原样透传**，此前不留任何痕迹；
       *   · 偶发意味着单次测试永远复现不了。
       *
       * 这里在不改变任何行为的前提下，把「上游拒绝了我们的转发」记下来：
       * 请求方法/路径、我们实际注入了哪些 dsh-auth-* cookie（含其 payload
       * 里的 authority / issuedAt / expiresAt）、以及是否走了代签。
       *
       * 只记 cookie 的**结构**（名字哈希前 8 位 + 时间字段），不记签名原文，
       * 避免把可用凭据写进日志。
       */
      if (proxyRes.statusCode === 401) recordUpstream401(req, proxyRes);
      res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, stripHopByHop(proxyRes.headers));
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    });

    proxyReq.on('error', (err) => {
      clearTimers();
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
   * 浏览器握手头里**绝不能**复制到上游的那一组 `sec-websocket-*`。
   *
   * 这一组描述的是「浏览器 ↔ 浏览器侧那个 ws 实例」之间已经完成的一次协商。
   * 上游握手是另一次全新的、由 `ws` 客户端库自己发起的连接：
   *
   *   · `sec-websocket-key` / `sec-websocket-version` —— 必须由 ws 客户端库
   *     按 RFC6455 **各自随机生成**。把浏览器的 key 抄过去会让上游对着一个
   *     它没发过的 challenge 做校验，握手直接失败。
   *   · `sec-websocket-extensions` —— 描述浏览器侧已协商的 perMessageDeflate。
   *     上游客户端**不声明**压缩（见下方注释），却收到「对面支持 deflate」
   *     的信号；若上游照着回 `permessage-deflate`，ws 客户端会抛
   *     “Server sent permessage-deflate but client does not support it”。
   *   · `sec-websocket-protocol` —— 浏览器侧的子协议选择与上游无关。
   *
   * 所以整组前缀都剔掉，而不是只剔 extensions/protocol：只剔一部分仍然是
   * 把「一次协商的结果」当成「一次请求的输入」搬过去。
   */
  const WS_STRIP_PREFIX = 'sec-websocket-';

  /** 剔除全部 `sec-websocket-*`，其余（cookie / authorization / 自定义头）保留。 */
  function stripWebSocketHandshakeHeaders(headers) {
    const h = { ...headers };
    for (const k of Object.keys(h)) {
      if (k.toLowerCase().startsWith(WS_STRIP_PREFIX)) delete h[k];
    }
    return h;
  }

  /**
   * 构造上游 WebSocket 的 ws:// URL。
   *
   * 不再用字符串拼接 `` `ws://${host}:${port}${req.url}` ``：
   *   · IPv6：TARGET.hostname 是去掉了方括号的裸地址，拼出来是
   *     `ws://fe80::1:3091/...`，根本不是一个合法 URL；
   *   · req.url 是原始 request-target，任何在路径里合法、在 URL 里不合法的
   *     字符都会让解析结果偏离预期。
   * 用 `new URL(req.url, base)` 让解析器处理 IPv6 与百分号编码。
   */
  function buildUpstreamWsUrl(TARGET, reqUrl) {
    const base = `ws://${authorityOf(TARGET.hostname, TARGET.port)}/`;
    try {
      return new URL(reqUrl ?? '/', base);
    } catch {
      return new URL('/', base);
    }
  }

  /**
   * 一条被帧代理接管的连接。
   *
   * 两端独立协商：浏览器侧开 `perMessageDeflate`，上游 dsh 侧**不开**
   * （保持与改造前完全一致的载荷，dsh 无感）。
   */
  function proxyUpgradeWithFrames({ wsMod, req, socket, head, TARGET, c, rawHeaders }) {
    const { WebSocketServer, WebSocket } = wsMod;

    // 浏览器侧：接受升级并开启压缩（只服务这一条连接，收完即弃）
    // maxPayload 显式给值（ws 默认 100 MB）：dsh 的历史快照实测约 6.6 MB，
    // 给到 64 MB 足够覆盖超大会话，同时挡住「一个帧吃满内存」的滥用。
    // 注意这是**解压后**的限制 —— 压缩炸弹（小帧解出巨大内容）就是靠它兜住。
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: WS_DEFLATE_OPTIONS,
      maxPayload: 64 * 1024 * 1024,
    });
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.close();   // 只服务这一条连接，收完即弃

      // 上游 dsh：**不声明压缩**，载荷与改造前一致。
      // 注意：ws 的构造是异步的，'open' 之前 send 会抛错 —— 用一个队列接住。
      //
      // rawHeaders 来自 prepareForwardHeaders（Host/Origin 改写 + 会话代签），
      // 这里必须再过一遍 stripWebSocketHandshakeHeaders：Handshake 相关的
      // `sec-websocket-*` 全部由 ws 客户端自己生成，抄浏览器的会握手失败。
      const upstream = new WebSocket(buildUpstreamWsUrl(TARGET, req.url), {
        headers: stripWebSocketHandshakeHeaders(rawHeaders),
      });
      let upstreamOpen = false;
      /**
       * 上游连上之前收到的帧。
       *
       * 有界：上游握手期间客户端最多能塞进来的量是有限的一小段（正常情况
       * 就一两帧 RPC 请求）。若不设上限，一个恶意客户端可以在握手窗口里
       * 持续灌大帧，把这段时间内的内存吃光 —— 虽然窗口很短，但没必要留口子。
       */
      const pendingToUpstream = [];
      let pendingBytes = 0;
      const PENDING_BYTES_LIMIT = 8 * 1024 * 1024;
      const PENDING_ITEMS_LIMIT = 256;

      /** 任一端的关闭理由，透传给另一端。 */
      let closing = false;

      const teardown = (why) => {
        if (closing) return;
        closing = true;
        pendingToUpstream.length = 0;
        pendingBytes = 0;
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
          // 上游还没连上：先排队，连上后按序补发（有界，见上面的说明）
          pendingToUpstream.push({ data, isBinary });
          pendingBytes += data.length;
          if (pendingBytes > PENDING_BYTES_LIMIT || pendingToUpstream.length > PENDING_ITEMS_LIMIT) {
            log('warn', 'WS 上游握手期间积压过多帧，主动断开该连接');
            teardown('pending-overflow');
          }
          return;
        }
        try { upstream.send(data, { binary: isBinary }); } catch { teardown('uplink-send-failed'); }
      });

      // dsh → 浏览器：这才是被压缩的大头（历史快照 4.6 MB 单帧）
      //
      // 背压闸门：`client.send()` 在 socket 写缓冲满时**不会**报错，而是把数据
      // 留在 ws 的发送队列里继续涨。没有这道闸门，一个读取慢的客户端 + 一条
      // 持续推送历史的上游，内存增长就是无界的。
      //
      // 阈值取 8 MiB 的理由（dsh 历史快照单帧实测 4~6.6 MB）：
      // `bufferedAmount` 统计的是「已进入发送队列、尚未写完 socket」的字节，
      // **不是**这一帧的大小。正常客户端的 TCP 窗口远大于 8 MiB，单帧通常在
      // 下一帧到达之前就已写空，所以 `bufferedAmount` 在稳态下是个很小的数。
      // 它涨到 8 MiB 意味着「客户端真的卡死 / 链路停滞」，而不是「这一帧大」。
      // 因此正常 4~6 MB 的历史帧不会被误伤；只有连续多帧堵在队列里才触发，
      // 且此时无论等多久都发不出去 —— 断开 + 一行 warn 比继续堆积更好排查。
      // 兜底：`maxPayload` 64 MB 已经挡住单帧上限，这里管的是**累计**。
      upstream.on('message', (data, isBinary) => {
        wsBytesCounter.downlinkPlain += data.length;
        if (client.bufferedAmount > WS_DOWNLINK_BACKPRESSURE_LIMIT) {
          log('warn', `WS 下行背压超限：bufferedAmount=${client.bufferedAmount} B > ${WS_DOWNLINK_BACKPRESSURE_LIMIT} B，会话过大或客户端读取过慢，已断开该连接`);
          teardown('downlink-backpressure');
          return;
        }
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
        pendingBytes = 0;
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
   *
   * 两个方向的「已经读到但还没被 pipe 接管的字节」都必须处理，否则丢帧：
   *
   *   · `head`  —— 客户端在握手请求之后、同一 TCP 段里紧接着发来的字节。
   *     Node 把它交给 'upgrade' 回调而不是留在 socket 流里。对 WS 客户端来说
   *     这常常**就是第一帧 RPC 请求**（浏览器/客户端不等 101 就发）。丢掉它
   *     的表现是「握手成功但没有任何回显」，而且极难排查。
   *   · `head2` —— 上游在 101 之后紧接着发来的字节。
   *
   * 两者都需要在建立 pipe **之前**补写回去，否则顺序会错（迟到的帧排在
   * pipe 进来的数据后面）。
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
    // 两段式：connect 只管建连；握手响应头另给宽松上限（101 之后是长连接，不再计时）
    const timer = setTimeout(() => proxyReq.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);
    let responseTimer = null;
    proxyReq.on('socket', () => {
      clearTimeout(timer);
      if (responseTimer === null && !proxyReq.destroyed) {
        responseTimer = setTimeout(
          () => proxyReq.destroy(new Error('upstream response timeout')),
          UPSTREAM_RESPONSE_TIMEOUT_MS,
        );
      }
    });
    const clearTimers = () => {
      clearTimeout(timer);
      if (responseTimer !== null) clearTimeout(responseTimer);
    };

    proxyReq.on('upgrade', (proxyRes, upstreamSocket, head2) => {
      clearTimers();
      const h = stripHopByHop(proxyRes.headers);
      h.connection = 'Upgrade';
      if (!h.upgrade) h.upgrade = 'websocket';
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${serializeHeaders(h)}\r\n`);
      // 上游 → 客户端：上游在 101 之后紧接着发来的字节。unshift 塞回它的
      // 可读侧，pipe 启动后就会被读到。
      if (head2 && head2.length) upstreamSocket.unshift(head2);
      upstreamSocket.pipe(socket);
      // 客户端 → 上游：同样是 unshift（塞进可读侧），因为 pipe 从可读侧读。
      // **不能**写成 upstreamSocket.write(head) —— 那是写进「要发给上游」的
      // 方向，等于把客户端的首帧当成对端的响应发回去。
      if (head && head.length) upstreamSocket.unshift(head);
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
      clearTimers();
      const status = proxyRes.statusCode || 502;
      socket.write(`HTTP/1.1 ${status} ${proxyRes.statusMessage || ''}\r\n${serializeHeaders(stripHopByHop(proxyRes.headers))}\r\n`);
      proxyRes.pipe(socket);
      proxyRes.on('end', () => socket.end());
      proxyRes.on('error', () => socket.destroy());
    });

    proxyReq.on('error', () => {
      clearTimers();
      if (socket.writable) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nrelay: 无法连接上游 DSH（请确认上游端口在监听）');
        socket.destroy();
      }
    });

    proxyReq.end();
  }

  function handleUpgrade(req, socket, head, auth, c) {
    socket.on('error', () => socket.destroy());
    if (!authGate(req, null, socket, auth, c.password, log, loginLimiter, verifyDshTokenExchange(req, resolveLaunchToken))) return;

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
   * 启停串行化。
   *
   * `start()` 与 `stop()` 都可能被「HTTP 路由」与「启动定时器」并行触发。
   * 没有串行化时会出现：start 正在 listen，此时 stop 拿到 running=false
   * 直接返回，于是 start 起来后没人记得停 —— 端口泄漏、状态与事实不符。
   * 这里把两者都挂到同一条 promise 链上，保证任何时刻只有一个在跑。
   */
  let lifecycleChain = Promise.resolve();
  function serialized(fn) {
    const run = lifecycleChain.then(fn, fn);
    // 链上保留「已结算」的版本，避免一次异常让后续调用全部拒绝
    lifecycleChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 启动中转监听。
   * 端口被占用时**不退出进程**，置 lastError='port-in-use' 并返回失败。
   */
  function start() {
    return serialized(doStart);
  }

  async function doStart() {
    if (running) return status();
    const c = cfg();

    // ── 上游闸门：非回环目标必须显式知情 ──
    //
    // 放在最前面（连端口都不绑），这样「配错 targetHost」的代价是启动失败并
    // 给出可读原因，而不是先占住中转端口再把流量转发到一个不该去的地方。
    // 判据只看**显式配置**的 targetHost：留空（自动）永远走本进程 dsh 的回环端点。
    if (c.targetHost && !c.allowOffHostTarget && !isLoopbackTargetHost(c.targetHost)) {
      lastError = 'off-host-target';
      log('error',
        `拒绝启动：targetHost=${c.targetHost} 不在回环名单内（${LOOPBACK_TARGET_HOSTS.join(', ')}）。`
        + '若确实要代理另一台 dsh，请在配置里显式设置 allowOffHostTarget=true。');
      return status();
    }

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
    return serialized(doStop);
  }

  function doStop() {
    if (!running || !server) {
      running = false;
      server = null;
      return Promise.resolve(status());
    }
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
    let endpointError = null;
    try {
      const dshEp = getDshEndpoint();
      dsh = { host: dshEp.host, port: dshEp.port, address: authorityOf(dshEp.host, dshEp.port) };
      const t = target();
      targetInfo = { host: t.hostname, port: t.port, origin: t.origin };
    } catch (err) {
      // 局部变量，**不写回 lastError**。
      //
      // status() 是纯读函数：UI 每 3 秒轮询一次、relay_status 工具随时可调，
      // 让它改持久状态意味着「看一眼」会改变 relay 的行为 —— 一次偶发的
      // endpoint 读取失败会把 lastError 钉死，之后即使中转正常启动，
      // 状态也会因为这个陈旧值而显示成 error。
      endpointError = `endpoint: ${err?.message || err}`;
    }
    const effectiveError = lastError ?? endpointError;
    const st = running ? 'running' : effectiveError ? 'error' : 'stopped';
    return {
      state: st,
      listen: { host: listenHost, port: listenPort, address: authorityOf(listenHost, listenPort) },
      target: targetInfo,
      // 上游是否落在回环之外：排查「为什么拒绝启动 / 流量去了哪」时一眼可辨
      targetIsOffHost: Boolean(c.targetHost) && !isLoopbackTargetHost(c.targetHost),
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
      /*
       * 上游 401 观测。
       *
       * `count` 累加自本次中转启动；`last` 是最近一次的完整上下文。
       * 偶发 401 在单次测试里复现不了，这里是唯一的「事发当时」证据。
       */
      upstream401: {
        count: upstream401s.count,
        last: upstream401s.last,
        samples: upstream401s.samples,
      },
      /*
       * `?token=` 交换的验真状态。
       *
       * `verifiable=false` 意味着中转拿不到本进程 launchToken，此时所有
       * `?token=` 都会被拒、一律要求中转口令 —— 这是**安全默认**，但用户
       * 会失去「用 dsh 打印的 URL 免密进入」的便利，所以必须能观察到。
       */
      tokenExchange: {
        verifiable: (() => {
          try {
            const t = typeof resolveLaunchToken === 'function' ? resolveLaunchToken() : null;
            return typeof t === 'string' && t !== '';
          } catch {
            return false;
          }
        })(),
        rejects: tokenExchangeStats.rejects,
        lastReason: tokenExchangeStats.lastReason,
        lastRejectAt: tokenExchangeStats.lastRejectAt,
      },
      lastError: effectiveError,
    };
  }

  return { start, stop, status };
}
