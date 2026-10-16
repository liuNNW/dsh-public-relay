/**
 * index.js — dsh-public-relay 宿主端
 *
 * 宿主半职责：
 *   1. 从 ctx.webServer 读**本进程真实监听端口**（UI 上「当前 dsh 端口」的来源，
 *      不硬编码 3080/19387）；
 *   2. 按配置启动/停止内嵌中转（lib/relay.js），配置变更即时生效；
 *   3. 用 installSettingsSection 把 Config 注册成 settings 命名空间 —— 这是
 *      「设置 → 插件 → DSH 中转」那张配置卡片的数据来源（与 MiMo 视觉识别同构）；
 *   4. 在 ctx.webServer 上注册 /dsh-public-relay/* 路由，供 UI 读状态、启停，以及
 *      在原语不可用时提供兜底表单的读写通道。
 *
 * 关于注入：只硬依赖 webServer。settings / tools 走软获取，缺失时分别退回
 * 「配置只有 cordis.patch.yml 一处来源」「跳过工具注册」，插件本体照常工作。
 */
'use strict';

import { createRelay } from './relay.js';
import { createSessionSigner } from './dsh-cookie.js';
import {
  Config, DEFAULTS, SETTINGS_NAMESPACE, diffFromDefaults, normalizeConfig,
} from './config.js';

export const name = 'dsh-public-relay';

/** 导出 Config：宿主据此生成设置页表单。 */
export { Config };

/** 只硬依赖 webServer：没有它既读不到真实端口，也没地方挂路由。 */
export const inject = ['webServer'];

/** 路由前缀。 */
const ROUTE_PREFIX = '/dsh-public-relay';

/** 与 dshmarket 一致的 JSON 应答。 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/**
 * 决定一个**会改状态**的请求是否可信（等价于 CSRF 防护）。
 *
 * 判据与 dsh 自己的 `isTrustedApiRequest`（dsh-client-connection）保持一致 ——
 * 它已经在同一种页面形态下正常工作过，自创一套只会引入不兼容。
 *
 * 三种情形：
 *
 *   ① 无 Origin → 放行
 *      浏览器对**跨站写请求必然附带 Origin**，所以「没有 Origin」不可能来自
 *      跨站攻击（同源请求可能不带，非浏览器客户端也不带）。dsh 自身同样放行。
 *
 *   ② Origin 是 `dsh-app://…` → 放行
 *      Electron 的客户端页面跑在 `dsh-app://app/` 下，该协议被注册为
 *      standard+secure（asar 内的 registerSchemesAsPrivileged），因此页面 fetch
 *      会带这个 Origin 。而 `new URL('dsh-app://app').host` 是字符串 "app"，
 *      与真实 Host（如 127.0.0.1:19387）永不相等 —— 若按 ③ 处理会一律 403，
 *      表现就是「设置页按钮点了没反应、返回 untrusted origin」。
 *      它是应用私有 scheme，普通网页无法把 Origin 伪造成它，故不构成跨站入口。
 *
 *   ③ http(s) → Origin 必须与 Host 同 authority（不放宽）
 *      隧道/反向代理场景仍受保护：跨站页面拿不到同 authority 的 Origin。
 *
 * 无 Host 一律拒绝（无法判断目标权威）。
 */
function isTrustedWrite(request) {
  const host = request.headers.host;
  if (host === undefined) return false;

  const origin = request.headers.origin;

  // ① 无 Origin：跨站请求必带 Origin，故此处可信
  if (origin === undefined) return true;

  // ② Electron 自渲染页面（私有 scheme，网页无法伪造）
  if (typeof origin === 'string' && origin.startsWith('dsh-app://')) return true;

  // ③ 普通 http(s)：必须与 Host 同 authority
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 带体积上限的 JSON body 读取。 */
async function readJsonBody(request, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function apply(ctx, pluginConfig) {
  const log = (level, message) => {
    const line = `[dsh-public-relay] ${message}`;
    if (level === 'error') ctx.logger?.error?.(line) ?? console.error(line);
    else if (level === 'warn') ctx.logger?.warn?.(line) ?? console.warn(line);
    else ctx.logger?.info?.(line) ?? console.log(line);
  };

  /** 本进程 dsh 的真实监听端点，惰性读取（webServer 可能尚未 listen）。 */
  function getDshEndpoint() {
    const ws = ctx.webServer;
    let host = '127.0.0.1';
    let port = DEFAULTS.listenPort;
    try {
      // 配置的绑定宿主；'0.0.0.0' 对上游回连没有意义，统一折成回环。
      const bound = ws?.host;
      if (typeof bound === 'string' && bound !== '' && bound !== '0.0.0.0' && bound !== '::') host = bound;
      const p = ws?.port;
      if (typeof p === 'number' && p > 0) port = p;
    } catch (err) {
      log('warn', `读取 webServer 端点失败，退回默认：${err?.message || err}`);
    }
    return { host, port };
  }

  // ── 配置来源 ──
  //
  // 优先级：settings 命名空间的解析值（用户层 > 本插件的 composition base）
  //        > 组合层 entry config。
  // settings 服务可用时，installSettingsSection 会把 source 指向 scope.get()，
  // 于是「设置页里改的值」自动成为权威来源；服务不在时退回 entry config。
  const entryConfig = normalizeConfig(pluginConfig);
  let source = () => entryConfig;

  /** 当前生效配置（热读：每次调用都取最新值）。 */
  const readConfig = () => normalizeConfig(source());

  // ── dsh 会话代签器 ──
  //
  // 让用户只输中转口令就能进入：转发前按 dsh 的格式替浏览器补签会话 Cookie。
  // 密钥取自 $DSH_HOME/.credentials.yaml 的 client-connection/browser-session 记录
  // （持久不变），所以读文件即可，无需 hook dsh 进程。
  //
  // 生效条件缺一不可：sessionSigner 可用 + autoSession 开启 + 口令非空。
  // 任一不满足就完全维持原行为（仍需 dsh 打印的 ?token=），不会让访问变得更糟。
  const sessionSigner = createSessionSigner({ log });

  // ── 中转实例 ──
  const relay = createRelay({
    getDshEndpoint,
    getConfig: readConfig,
    log,
    sessionSigner,
  });

  // 配置变化时按需联动中转：开关状态与监听参数是仅有的两处需要动作的。
  let lastApplied = null;
  async function reconcile(reason) {
    const cfg = readConfig();
    const st = relay.status();
    const key = `${cfg.enabled}|${cfg.listenHost}|${cfg.listenPort}`;
    if (key === lastApplied) return;

    // 关闭 → 停；开启且未运行 → 起；监听参数变了 → 重启
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
  }

  /** 组装给 UI 的完整状态。 */
  function snapshot() {
    const status = relay.status();
    const dsh = getDshEndpoint();
    const config = readConfig();
    const session = sessionSigner.status();
    return {
      ...status,
      // UI 主要看这两个：本进程 dsh 真实端口 + 中转端口
      dshPort: dsh.port,
      dshAddress: status.dsh?.address ?? null,
      config,
      defaults: DEFAULTS,
      overrides: diffFromDefaults(config),
      settingsNamespace: SETTINGS_NAMESPACE,
      // 自动会话：把「为何生效/为何没生效」直接交代给 UI，避免用户猜
      session: {
        ...session,
        enabled: config.autoSession === true,
        // 用户开了但被「口令为空」这条硬约束压掉
        blockedByEmptyPassword: config.autoSessionBlocked === true,
      },
    };
  }

  /** 开关动作统一入口（UI 的启停按钮与 HTTP 路由共用）。 */
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
        const running = relay.status().state === 'running';
        if (running) {
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

  // ── settings 命名空间：设置页配置卡片的数据来源 ──
  //
  // 与 @deepseek-ai/dsh-mimo-vision 的做法一致：**本插件不 import dsh-settings**，
  // 只导出 `Config` schema，由宿主侧在装载本条目时把它注册成同名 settings 命名空间。
  // 这样有两个好处：
  //   1. 少一个可失败的外部依赖（settings 解析不到也不会让插件挂掉）；
  //   2. schema 用的 schemastery 由宿主自己那份提供，`.volatile()` 一定存在
  //      —— 手写 import 反而可能拿到旧版 schemastery（3.18.1 没有 volatile）。
  //
  // 配置来源：优先 settings 解析值（用户层 > 本插件 composition base），
  // 服务不在时退回 entry config。settings 的变更通过下面的订阅感知。
  let settingsWired = false;
  try {
    const settings = ctx.get?.('settings');
    if (settings && typeof settings.register === 'function') {
      const scope = settings.register(SETTINGS_NAMESPACE, Config, { base: pluginConfig ?? {} });
      source = () => scope.get();
      ctx.effect(() => scope.watch(() => { void reconcile('settings'); }), 'dsh-public-relay: settings watch');
      settingsWired = true;
      log('info', `已注册设置命名空间 ${SETTINGS_NAMESPACE}（设置 → 插件 → DSH 中转）`);
    }
  } catch (err) {
    log('warn', `注册 settings 命名空间失败，配置只来自 cordis.patch.yml：${err?.message || err}`);
  }
  if (!settingsWired) {
    log('info', 'settings 未接线：若宿主自动注册了 Config 也会生效；否则设置页无表单，状态与启停照常');
  }

  // ── HTTP 路由：/dsh-public-relay/* ──
  const routeDisposer = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      let pathname = '/';
      try {
        pathname = new URL(request.url ?? '/', 'http://x').pathname;
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
          const action = typeof body.action === 'string' ? body.action : 'status';
          const result = await control(action);
          return sendJson(response, result.ok ? 200 : 502, result);
        }

        // 写：兜底表单的配置保存（原语不可用时用）。
        // settings 服务在时优先走它，保证与设置页共用同一份存储。
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
          const result = await writeConfig(patch);
          return sendJson(response, result.ok ? 200 : 502, result);
        }

        return sendJson(response, 404, { ok: false, error: `unknown dsh-public-relay route: ${route}` });
      } catch (error) {
        const message = error?.message || String(error);
        log('error', `路由 ${route} 出错：${message}`);
        if (!response.headersSent) sendJson(response, 400, { ok: false, error: message });
        else response.destroy();
      }
    },
  });

  /**
   * 写配置：优先落到 settings 命名空间（与设置页同一份存储），
   * 服务不可用时仅作用于本进程。
   */
  async function writeConfig(patch) {
    const candidate = normalizeConfig({ ...readConfig(), ...patch });
    try {
      const settings = ctx.get?.('settings');
      if (settings?.update) {
        await settings.update(SETTINGS_NAMESPACE, {
          enabled: candidate.enabled,
          listenHost: candidate.listenHost,
          listenPort: candidate.listenPort,
          password: candidate.password,
          forceLoopback: candidate.forceLoopback,
          // 写「用户原意」而不是 candidate.autoSession：后者在口令为空时被强制
          // 压成 false，若回写它就等于把用户的开关偷偷关掉，下次填回口令也不会
          // 自动恢复。这里存原意，生效与否由 normalizeConfig 每次判。
          autoSession: candidate.autoSessionWanted,
        });
        await reconcile('http config');
        return { ok: true, status: snapshot(), error: null };
      }
    } catch (err) {
      log('warn', `写入 settings 失败，本次修改仅作用于当前进程：${err?.message || err}`);
    }
    // 无 settings：临时覆盖 entry config
    const merged = candidate;
    source = () => merged;
    await reconcile('http config (volatile)');
    return { ok: true, status: snapshot(), error: null, volatile: true };
  }

  // ── 生命周期 ──
  ctx.effect(() => {
    let disposed = false;
    void (async () => {
      // 等 settings 接线落定（installSettingsSection 是异步 import），
      // 再按当时的生效配置决定是否启动，避免用 entry 值先起一次又改。
      await new Promise((r) => setTimeout(r, 50));
      if (disposed) return;
      await reconcile('boot');
    })();
    return () => {
      disposed = true;
      routeDisposer?.();
      void relay.stop();
    };
  }, 'dsh-public-relay: relay lifecycle + http routes');

  // ── 可选：全局工具（tools 服务缺失时静默跳过）──
  void (async () => {
    let defineTool;
    try {
      ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
    } catch (err) {
      log('warn', `@deepseek-ai/dsh-tools 不可用，跳过工具注册：${err?.message || err}`);
      return;
    }
    const tools = ctx.get?.('tools');
    if (!tools?.register) return;

    const jsonOutput = {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    };

    try {
      ctx.effect(() => tools.register(defineTool({
        name: 'relay_status',
        description: 'Report the dsh-public-relay plugin: the real dsh port this process is serving on, the relay listen port and upstream target, whether the relay is running, its error state, and the effective configuration. Call this whenever the user asks which port dsh is on or what the relay is doing.',
        parameters: {},
        output: jsonOutput,
        execute: async () => snapshot(),
      })));

      ctx.effect(() => tools.register(defineTool({
        name: 'relay_control',
        description: "Start, stop or toggle the dsh-public-relay TCP relay, or read its status. action must be one of 'start', 'stop', 'toggle', 'status'. The relay forwards a local port to this dsh process with Host/Origin rewriting, and start/stop take effect immediately without a restart.",
        // 注意参数形状：defineTool 的 parameters 是「属性表」
        // （每个键一个 ParameterPropertySpec），不是 JSON Schema 的
        // {type:'object',properties} 包装 —— 写成后者会在注册期抛
        // "unsupported JSON schema: parameters.type must be a value schema object"。
        parameters: {
          action: {
            type: 'string',
            required: true,
            description: "One of 'start', 'stop', 'toggle', 'status'.",
          },
        },
        output: jsonOutput,
        execute: async (args) => {
          const action = typeof args?.action === 'string' ? args.action : 'status';
          return control(action);
        },
      })));
      log('info', '已注册全局工具 relay_status / relay_control');
    } catch (err) {
      log('warn', `工具注册失败，插件其余功能不受影响：${err?.message || err}`);
    }
  })();

  const initial = getDshEndpoint();
  log('info', `宿主半就绪：dsh 端口 ${initial.port} → 中转 ${entryConfig.listenHost}:${entryConfig.listenPort}`);
}

export default { name, inject, Config, apply };
