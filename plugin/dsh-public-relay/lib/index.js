/**
 * index.js — dsh-public-relay 宿主端
 *
 * 职责（按依赖强度排列）：
 *   1. 从 ctx.webServer 热读**本进程真实监听端口**（UI 上「当前 dsh 端口」的来源）；
 *   2. 按配置启动/停止内嵌中转（lib/relay.js）；
 *   3. 在 ctx.webServer 上注册 `/dsh-public-relay/*` 路由 —— 配置读写、状态、启停
 *      全部走这里，**不依赖 dsh 的 settings 服务**（原因见 lib/config.js 顶部）；
 *   4. 可选：用 tools 服务注册两个全局工具（服务缺失时静默跳过）。
 *
 * 版本适配要点（0.2.x）：
 *   · 不再导出 `Config`：schemastery 的 `.volatile()` 语义在 0.2.x 由 DSH 自己
 *     的构建包装，第三方 schema 拿不到 volatile 提交链路，导出了也不会被写入。
 *     配置改由本插件自己的 JSON 文件持有，跨版本稳定。
 *   · 路由用 `ctx.effect(() => ctx.webServer.register(...))` 持有，卸载即注销。
 *   · 工具定义直接写成 ToolDefinition（不 import `@deepseek-ai/dsh-tools`），
 *     少一个可能解析失败的依赖；`defineTool` 只是语法糖。
 *
 * 0.2.3 安全加固：管理路由（/config、/control）增加鉴权
 *   · 原本唯一的门禁是 `isTrustedWrite` 的 Origin 嗅探，而中转在 rewriteHeaders
 *     里会把 Host / Origin 一起改写成上游回环权威 —— 任何经中转进来的管理
 *     请求都按构造「同源」。那个判据挡得住跨站网页，挡不住持有中转口令
 *     （或根本没口令）的任何客户端。现在要求 bearer token / relay_session
 *     cookie，口令为空时只允许回环对端。
 *   · `isTrustedWrite` 本身也收紧：缺 Origin 不再无条件放行（改为「回环对端
 *     才放行」），`dsh-app://` 改为精确匹配而非前缀匹配。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createRelay } from './relay.js';
import { createSessionSigner } from './dsh-cookie.js';
import { isAdminRequest, isLoopbackPeer, makeAuth } from './auth.js';
import {
  CONFIG_FILENAME, DEFAULTS, diffFromDefaults, normalizeConfig, toStorable,
} from './config.js';

export const name = 'dsh-public-relay';

/** 只硬依赖 webServer：没有它既读不到真实端口，也没地方挂路由。 */
export const inject = ['webServer'];

/** 路由前缀。与 client.js 里的 API_PREFIX 必须一致。 */
const ROUTE_PREFIX = '/dsh-public-relay';

/** 请求体上限。 */
const MAX_BODY_BYTES = 32 * 1024;

// ─────────────────────────── 小工具 ───────────────────────────

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/** Electron 自渲染页面的私有 scheme。精确匹配，不用前缀。 */
const DSH_APP_ORIGIN = 'dsh-app://app';

/**
 * 决定一个**会改状态**的请求是否同源（CSRF 防护，与 `isAdminRequest` 互补）。
 *
 * 它只回答「这是不是跨站来的」，**不回答「调用者有没有权限」** —— 后者由
 * `isAdminRequest` 负责。两者都要过。
 *
 * 与旧版（isTrustedApiRequest 同构）的三处收紧：
 *
 *   ① **缺 Origin 不再无条件放行**。旧实现「无 Origin → 放行」，理由是浏览器
 *      对跨站写请求必带 Origin。但那只约束浏览器 —— curl、脚本、SSRF、
 *      WebView 全都可以不带 Origin 而畅通无阻。现在：缺 Origin 时，只有
 *      **回环对端**放行（本机 curl 仍可用），其余 403。
 *   ② `dsh-app://` 改为**精确匹配** `dsh-app://app`。前缀匹配会接受
 *      `dsh-app://evil` 这类网页伪造不出的字符串（HTTP 头里可以随便写）。
 *   ③ 无 Host 一律拒绝（保留）。
 *
 * http(s) 仍要求 Origin 与 Host 同 authority。
 */
function isTrustedWrite(request) {
  if (request.headers.host === undefined) return false;
  const origin = request.headers.origin;
  // ① 无 Origin：只放过本机客户端
  if (origin === undefined) return isLoopbackPeer(request);
  if (origin === DSH_APP_ORIGIN) return true;   // ② 精确匹配
  try {
    return new URL(origin).host === request.headers.host;   // ③ 同 authority
  } catch {
    return false;
  }
}

/**
 * 管理路由（/config、/control）的鉴权。
 *
 * 通过条件（二者之一）：
 *   · 持有中转口令：bearer token 或 relay_session cookie 校验通过；
 *   · **口令为空**：只允许回环对端。
 *
 * 为什么要 bearer：口径很直白 —— **持有中转口令即持有管理权限**。中转口令
 * 本来就是唯一那道边界，管理路由没有理由比数据面更宽松；而 bearer 由口令
 * HMAC 派生，持有者只有本地工具/CLI 与已登录浏览器（口令是 write-only 的，
 * 浏览器端拿不到原值，也就没法自己造一个）。
 *
 * 口令为空时 `makeAuth('')` 返回 null，bearer/cookie 都无从校验，于是退化为
 * 「仅回环」。含义要说清楚：**这不等于「无认证开放」** —— 监听在 0.0.0.0 时
 * 非回环客户端同样 403，配置面不会因为忘记设口令就彻底裸露在本机之外。
 */
function isAuthorizedAdmin(request, password) {
  const auth = makeAuth(password);
  if (auth !== null && isAdminRequest(request, auth)) return true;
  return auth === null && isLoopbackPeer(request);
}

/** 带体积上限的 JSON body 读取。 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 解析本 profile 的目录（配置文件放这里）。
 *
 * 宿主在 `ctx.profileContext` 上提供**两个不同的位置**（0.1.7+）：
 *   · `dir`  —— 这个 profile 自己的目录（cordis.patch.yml / package.json 所在）
 *   · `home` —— `$DSH_HOME` 根目录（所有 profile 的父目录）
 * 配置属于「这个 profile」，所以优先用 `dir`。
 *
 * 回退顺序：
 *   1. `profileContext.dir`
 *   2. `DSH_PROFILE_DIR` 环境变量
 *   3. `$DSH_HOME/profiles/$DSH_PROFILE`
 *   4. `$DSH_HOME`
 */
function resolveProfileHome(ctx) {
  try {
    const dir = ctx?.profileContext?.dir;
    if (typeof dir === 'string' && dir !== '') return dir;
  } catch {
    /* 老版本没有 profileContext */
  }
  const envDir = process.env.DSH_PROFILE_DIR;
  if (typeof envDir === 'string' && envDir !== '') return envDir;

  try {
    const home = ctx?.profileContext?.home;
    if (typeof home === 'string' && home !== '') {
      const profile = ctx?.profileContext?.name || process.env.DSH_PROFILE;
      if (typeof profile === 'string' && profile !== '') return path.join(home, 'profiles', profile);
      return home;
    }
  } catch {
    /* 忽略 */
  }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE;
  if (typeof profile === 'string' && profile !== '') return path.join(dshHome, 'profiles', profile);
  return dshHome;
}

// ─────────────────────────── 插件主体 ───────────────────────────

export function apply(ctx, entryConfig) {
  const log = (level, message) => {
    const line = `[dsh-public-relay] ${message}`;
    try {
      if (level === 'error') ctx.logger?.error?.(line);
      else if (level === 'warn') ctx.logger?.warn?.(line);
      else ctx.logger?.info?.(line);
    } catch {
      /* 日志失败不影响功能 */
    }
  };

  // ── 配置：文件为准，entry config 只做首次种子 ──
  const home = resolveProfileHome(ctx);
  const configFile = path.join(home, CONFIG_FILENAME);
  let current = normalizeConfig(loadStoredConfig() ?? entryConfig);

  /**
   * 读落盘配置。
   * 文件不存在 / 解析失败 / 版本不符 → 返回 null，由调用方用 entry config 兜底。
   */
  function loadStoredConfig() {
    try {
      const text = fs.readFileSync(configFile, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch (err) {
      if (err?.code !== 'ENOENT') log('warn', `读取配置文件失败，改用 cordis.patch.yml 的 config：${err?.message || err}`);
      return null;
    }
  }

  /** 原子写回配置（临时文件 + rename），失败只记日志、不抛。 */
  function saveConfig(config) {
    try {
      fs.mkdirSync(home, { recursive: true });
      const temp = `${configFile}.tmp-${process.pid}`;
      fs.writeFileSync(temp, `${JSON.stringify(toStorable(config), null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, configFile);
      return true;
    } catch (err) {
      log('warn', `写入配置文件失败（本次修改仅在内存中生效）：${err?.message || err}`);
      return false;
    }
  }

  /** 当前生效配置（热读：每次调用取最新对象）。 */
  const readConfig = () => current;

  /** 本进程 dsh 的真实监听端点，惰性读取（webServer 可能尚未 listen）。 */
  function getDshEndpoint() {
    const ws = ctx.webServer;
    let host = '127.0.0.1';
    let port = DEFAULTS.listenPort;
    try {
      const bound = ws?.host;
      if (typeof bound === 'string' && bound !== '' && bound !== '0.0.0.0' && bound !== '::') host = bound;
      const p = ws?.port;
      if (typeof p === 'number' && p > 0) port = p;
    } catch (err) {
      log('warn', `读取 webServer 端点失败，退回默认：${err?.message || err}`);
    }
    return { host, port };
  }

  // ── dsh 会话代签器 ──
  const sessionSigner = createSessionSigner({ log });

  /**
   * 取 dsh 本进程当前的启动令牌（launchToken），用于**验真** `?token=` 交换。
   *
   * ── 为什么需要 ──
   *
   * dsh 每次启动生成一个随机 launchToken，只在 `GET /?token=<它>` 上接受一次
   * 交换。中转旧实现只看「形状」（`GET /` + 一个非空 token）就跳过自己的口令
   * 认证 —— 于是浏览器书签里那条**上一次启动**的旧 URL 也能绕过中转口令，
   * 随后必然被 dsh 以 401 拒绝。用户看到的是「不用输口令就进去了，但所有
   * 操作都报 dsh web authentication required」，而正确行为应是给中转登录页。
   *
   * ── 从哪里取 ──
   *
   * dsh 的 connection 服务（`ctx.get('connection')`，HostConnectionService）
   * 上挂着 `browserAuth.launchToken`。中转是跑在同一进程里的插件，所以能直接
   * 读到它 —— 不需要读日志、不需要 hook 进程。
   *
   * 拿不到就返回 null：调用方（relay）会按「不可验证 → 一律要求中转口令」
   * 处理。这是安全默认，代价只是失去 token 免密的便利。
   *
   * @returns {string|null}
   */
  function resolveLaunchToken() {
    const candidates = [
      () => ctx.get?.('connection'),
      () => ctx.connection,
      () => ctx.root?.get?.('connection'),
      () => ctx.root?.connection,
    ];
    for (const read of candidates) {
      let service;
      try {
        service = read();
      } catch {
        continue;   // 这一层不可用，试下一层
      }
      if (service === null || typeof service !== 'object') continue;
      try {
        const token = service.browserAuth?.launchToken;
        if (typeof token === 'string' && token !== '') return token;
      } catch {
        /* 属性不可读，继续 */
      }
    }
    return null;
  }

  // ── 中转实例 ──
  const relay = createRelay({
    getDshEndpoint, getConfig: readConfig, log, sessionSigner, resolveLaunchToken,
  });

  /**
   * 配置变化时联动中转。
   *
   * 只有「开关」与「监听参数」需要动监听器；其余字段（口令、autoSession、
   * forceLoopback、compressWebSocket）都是**请求期热读**的 —— relay 的
   * `cfg()` 每次请求都重新调用 `getConfig()`，所以不需要重启。
   *
   * 这里的 key 只用来跳过「没有实际变化」的重复 reconcile。它只包含
   * 影响监听的字段，是**正确的**：别的字段改了却重启中转，反而会踢掉所有
   * 在线连接。口令热生效这一点由 relay 内的 `authCache`（按 password 值
   * 重新派生）保证，已在测试里覆盖。
   *
   * 并发保护：reconcile 可能被 HTTP 路由与启动定时器同时触发，用一个
   * 串行链避免两次 start/stop 交错（否则会出现「stop 把刚起来的监听又拆了」）。
   */
  let lastApplied = null;
  let reconcileChain = Promise.resolve();
  function reconcile(reason) {
    const run = async () => {
      const cfg = readConfig();
      const st = relay.status();
      const key = `${cfg.enabled}|${cfg.listenHost}|${cfg.listenPort}`;
      if (key === lastApplied) return;
      try {
        if (!cfg.enabled) {
          if (st.state === 'running') {
            await relay.stop();
            log('info', `配置变更（${reason}）：中转已停止`);
          }
        } else if (st.state !== 'running') {
          const started = await relay.start();
          log('info', `配置变更（${reason}）：中转 ${started.state === 'running' ? '已启动' : '启动失败 ' + (started.lastError || '')}`);
        } else if (cfg.listenHost !== st.listen.host || cfg.listenPort !== st.listen.port) {
          await relay.stop();
          const started = await relay.start();
          log('info', `配置变更（${reason}）：中转已按新监听参数重启（${started.state}）`);
        }
        lastApplied = key;
      } catch (err) {
        log('error', `同步中转状态失败：${err?.message || err}`);
      }
    };
    // 排队执行，保证同一时刻只有一次 start/stop 在跑
    reconcileChain = reconcileChain.then(run, run);
    return reconcileChain;
  }

  /**
   * 组装给 UI 的完整状态。
   *
   * **口令绝不出现在这里。**
   *
   * 这个快照同时通过 `/dsh-public-relay/status` 返回给任何能访问中转的客户端
   * （而中转就是暴露在公网上的那一面）。旧实现直接把整份 config 展开，
   * 于是 `GET /status` 就把明文口令吐了出来 —— 口令又是唯一边界，
   * 等于一次读请求换来永久完全控制。现在只暴露 `hasPassword` 布尔值，
   * 口令的「写」走独立的 write-only 通道（见 writeConfig 的 password 处理）。
   */
  function snapshot() {
    const status = relay.status();
    const dsh = getDshEndpoint();
    const config = readConfig();
    const session = sessionSigner.status();
    // 脱敏：只保留「有没有设口令」，不提供任何形式的还原
    const { password: _password, ...publicConfig } = config;
    return {
      ...status,
      dshPort: dsh.port,
      dshAddress: status.dsh?.address ?? null,
      config: publicConfig,
      hasPassword: Boolean(config.password),
      defaults: (() => {
        const { password: _dp, ...rest } = DEFAULTS;
        return rest;
      })(),
      overrides: (() => {
        const { password: _op, ...rest } = diffFromDefaults(config);
        return rest;
      })(),
      configFile,
      session: {
        ...session,
        enabled: config.autoSession === true,
        blockedByEmptyPassword: config.autoSessionBlocked === true,
      },
    };
  }

  /** 开关动作统一入口（UI 的启停按钮、HTTP 路由、工具共用）。 */
  async function control(action) {
    switch (action) {
      case 'start': {
        const st = await relay.start();
        lastApplied = `${readConfig().enabled}|${st.listen.host}|${st.listen.port}`;
        return { ok: st.state === 'running', status: snapshot(), error: st.lastError };
      }
      case 'stop': {
        await relay.stop();
        return { ok: true, status: snapshot(), error: null };
      }
      case 'toggle': {
        if (relay.status().state === 'running') {
          await relay.stop();
          return { ok: true, status: snapshot(), error: null };
        }
        const st = await relay.start();
        return { ok: st.state === 'running', status: snapshot(), error: st.lastError };
      }
      case 'status':
      default:
        return { ok: true, status: snapshot(), error: null };
    }
  }

  /** 写配置：归一化 → 落盘 → 联动中转。 */
  /**
   * 写配置：归一化 → 落盘 → 联动中转。
   *
   * **口令是 write-only 的**（因为 status 不再返回它，UI 也拿不到原值）：
   *   · 请求里不带 `password` 字段   → 保持原口令不变
   *   · 带 `password: ""`            → 明确清空（关闭认证）
   *   · 带 `password: "new"`          → 设为新口令
   *
   * 之所以要区分「不带」与「空串」：UI 的输入框永远是空的（不回填），
   * 若把「空」当成「清空」，用户每次保存其他设置都会把自己的口令清掉。
   */
  async function writeConfig(patch) {
    const source = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const merged = { ...toStorable(readConfig()) };

    /**
     * 先剥离原型污染键，再做任何赋值。
     *
     * `JSON.parse` 会把 `{"__proto__":{...}}` 建成一个**自有属性**，于是
     * `Object.assign` 会触发 `Object.prototype` 上的 `__proto__` setter ——
     * 这是本函数里唯一一处「把外部对象灌进原型链」的机会。
     *
     * 目前没有可利用的后果：随后的 normalizeConfig 会按固定形状重建一个全新
     * 对象，被污染的原型不会活到落盘。但那依赖的是「下游恰好会重建」这个
     * 间接事实 —— 一旦以后有人改成透传某个字段，防护就无声消失了。
     * 按纵深防御在这里挡掉，成本是三行。
     */
    const rest = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === 'password' || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      rest[key] = value;
    }
    Object.assign(merged, rest);
    // 只有显式出现 password 字段时才改口令（长度夹取由 normalizeConfig 统一做，
    // 所以这里必须排在剥离之后：不能因为键被过滤就漏掉口令更新）。
    if (Object.hasOwn(source, 'password')) {
      merged.password = typeof source.password === 'string' ? source.password : String(source.password ?? '');
    }
    const candidate = normalizeConfig(merged);
    current = candidate;
    const persisted = saveConfig(candidate);
    lastApplied = null;   // 强制 reconcile 走一遍
    await reconcile('http config');
    return { ok: true, status: snapshot(), error: null, persisted };
  }

  // ── HTTP 路由：/dsh-public-relay/* ──
  const routeDisposer = ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      let pathname = '/';
      try {
        pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname;
      } catch {
        return sendJson(response, 400, { ok: false, error: 'malformed request url' });
      }
      const route = pathname.slice(ROUTE_PREFIX.length) || '/';

      try {
        // 只读：状态快照。GET 便于直接访问排查，POST 兼容统一调用方式。
        if (route === '/status' || route === '/') {
          if (request.method !== 'GET' && request.method !== 'POST') {
            response.writeHead(405, { allow: 'GET, POST' });
            response.end();
            return;
          }
          return sendJson(response, 200, { ok: true, ...snapshot() });
        }

        // 写：启停
        if (route === '/control') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          if (!isTrustedWrite(request) || !isAuthorizedAdmin(request, readConfig().password)) {
            // 响应体不回显 origin/host 原值（见 task-5 的同类清理）：
            // 头值是攻击者可控的，回显只会变成一个 header 反射预言机。
            return sendJson(response, 403, { ok: false, error: 'forbidden' });
          }
          const body = await readJsonBody(request);
          const result = await control(typeof body.action === 'string' ? body.action : 'status');
          return sendJson(response, result.ok ? 200 : 502, result);
        }

        // 写：配置保存
        if (route === '/config') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          if (!isTrustedWrite(request) || !isAuthorizedAdmin(request, readConfig().password)) {
            return sendJson(response, 403, { ok: false, error: 'forbidden' });
          }
          const body = await readJsonBody(request);
          const patch = body.config && typeof body.config === 'object' ? body.config : {};
          return sendJson(response, 200, await writeConfig(patch));
        }

        // 未知子路由：不回显 route 原值。
        // route 派生自 request.url，是攻击者完全可控的输入；回显它只会把这个
        // 端点变成一个反射预言机，且响应体随输入无界增长。固定文案即可 ——
        // 调用方拿到 404 已经知道是哪条路由。
        return sendJson(response, 404, { ok: false, error: 'unknown route' });
      } catch (error) {
        const message = error?.message || String(error);
        log('error', `路由 ${route} 出错：${message}`);
        if (!response.headersSent) sendJson(response, 400, { ok: false, error: message });
        else response.destroy();
      }
    },
  }), 'dsh-public-relay: /dsh-public-relay routes');

  // ── 生命周期：boot 时按配置起中转；卸载时停中转、注销路由 ──
  ctx.effect(() => {
    let disposed = false;
    void (async () => {
      // 等 webServer 完成 listen，避免用兜底端口先起一次又改。
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (disposed) return;
      await reconcile('boot');
    })();
    return () => {
      disposed = true;
      try {
        routeDisposer?.();
      } catch {
        /* 已注销 */
      }
      void relay.stop();
    };
  }, 'dsh-public-relay: relay lifecycle');

  // ── 可选：全局工具（tools 服务缺失时静默跳过）──
  registerTools();

  function registerTools() {
    let tools;
    try {
      tools = ctx.get?.('tools');
    } catch {
      tools = undefined;
    }
    if (!tools || typeof tools.register !== 'function') return;

    /**
     * 两个工具共用的 JSON 输出定义。
     *
     * `schema` 必须是 dsh 支持子集里的**原生 JSON Schema**，且输出侧只要
     * object 根：`{ type: 'object' }` 在 0.1.x 与 0.2.x 都被接受
     * （`{ type: 'json' }` 是 defineTool 的作者语法糖，只在 0.1.x 有）。
     */
    const jsonOutput = {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    };

    try {
      ctx.effect(() => tools.register({
        name: 'relay_status',
        description: 'Report the dsh-public-relay plugin: the real dsh port this process serves on, the relay listen port and upstream target, whether the relay is running, its error state, and the effective configuration. Call this whenever the user asks which port dsh is on or what the relay is doing.',
        // ToolDefinition.parameters 是**原生 JSON Schema**（object 根）。
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: jsonOutput,
        execute: async () => snapshot(),
      }), 'dsh-public-relay: relay_status tool');

      ctx.effect(() => tools.register({
        name: 'relay_control',
        description: "Start, stop or toggle the dsh-public-relay TCP relay, or read its status. action must be one of 'start', 'stop', 'toggle', 'status'. The relay forwards a local port to this dsh process with Host/Origin rewriting; start/stop take effect immediately without a restart.",
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['start', 'stop', 'toggle', 'status'],
              description: "One of 'start', 'stop', 'toggle', 'status'.",
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: jsonOutput,
        execute: async (args) => {
          const action = args && typeof args.action === 'string' ? args.action : 'status';
          return control(action);
        },
      }), 'dsh-public-relay: relay_control tool');
      log('info', '已注册全局工具 relay_status / relay_control');
    } catch (err) {
      log('warn', `工具注册失败，插件其余功能不受影响：${err?.message || err}`);
    }
  }

  const initial = getDshEndpoint();
  log('info', `宿主半就绪：dsh 端口 ${initial.port} → 中转 ${current.listenHost}:${current.listenPort}（配置 ${configFile}）`);
}

export default { name, inject, apply };
