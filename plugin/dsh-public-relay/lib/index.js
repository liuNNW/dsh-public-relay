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
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createRelay } from './relay.js';
import { createSessionSigner } from './dsh-cookie.js';
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

/**
 * 决定一个**会改状态**的请求是否可信（CSRF 防护）。
 *
 * 与 dsh 自己的 `isTrustedApiRequest` 同构：
 *   ① 无 Origin → 放行（浏览器对跨站写请求必带 Origin）
 *   ② `dsh-app://` → 放行（Electron 自渲染页面的私有 scheme，网页伪造不出来）
 *   ③ http(s) → Origin 必须与 Host 同 authority
 * 无 Host 一律拒绝。
 */
function isTrustedWrite(request) {
  const host = request.headers.host;
  if (host === undefined) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin === 'string' && origin.startsWith('dsh-app://')) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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

  // ── 中转实例 ──
  const relay = createRelay({ getDshEndpoint, getConfig: readConfig, log, sessionSigner });

  /** 配置变化时联动中转：开关与监听参数是仅有的两处需要动作的。 */
  let lastApplied = null;
  async function reconcile(reason) {
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
    } catch (err) {
      log('error', `同步中转状态失败：${err?.message || err}`);
    }
    lastApplied = key;
  }

  /** 组装给 UI 的完整状态。 */
  function snapshot() {
    const status = relay.status();
    const dsh = getDshEndpoint();
    const config = readConfig();
    const session = sessionSigner.status();
    return {
      ...status,
      dshPort: dsh.port,
      dshAddress: status.dsh?.address ?? null,
      config,
      defaults: DEFAULTS,
      overrides: diffFromDefaults(config),
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
  async function writeConfig(patch) {
    const candidate = normalizeConfig({ ...toStorable(readConfig()), ...patch });
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
          if (!isTrustedWrite(request)) {
            return sendJson(response, 403, {
              ok: false,
              error: 'untrusted origin',
              detail: `origin=${JSON.stringify(request.headers.origin ?? null)} host=${JSON.stringify(request.headers.host ?? null)}`,
            });
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
          if (!isTrustedWrite(request)) {
            return sendJson(response, 403, {
              ok: false,
              error: 'untrusted origin',
              detail: `origin=${JSON.stringify(request.headers.origin ?? null)} host=${JSON.stringify(request.headers.host ?? null)}`,
            });
          }
          const body = await readJsonBody(request);
          const patch = body.config && typeof body.config === 'object' ? body.config : {};
          return sendJson(response, 200, await writeConfig(patch));
        }

        return sendJson(response, 404, { ok: false, error: `unknown dsh-public-relay route: ${route}` });
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
