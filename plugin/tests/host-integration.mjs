#!/usr/bin/env node
/**
 * host-integration.mjs — dsh-relay 宿主半集成测试
 *
 * 用一个假 ctx 真实 import lib/index.js 并 apply()，验证：
 *   · 从 ctx.webServer 读到真实端口（而不是硬编码）
 *   · /dsh-relay/status 与 /dsh-relay/control 路由真的注册并可调用
 *   · 开关能真正改变中转监听状态（start/stop/toggle）
 *   · effect 清理时自动停中转并释放端口（这是"永久插件 + 随时关"的基础）
 *   · 配置持久化走 credentials 服务（写/读回）
 *
 * 运行：node plugin/tests/host-integration.mjs
 */
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

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
async function startRouteHost(routes) {
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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

/** 通过真实 server 调一个插件路由。 */
async function callRoute(host, method, pathname, options = {}) {
  const headers = { connection: 'close', ...(options.headers || {}) };
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
 * 关键点：插件的配置来源是 settings 命名空间（由 installSettingsSection 接线），
 * 所以这里必须提供一个可用的 settings 假实现 + 能跑 inject(['settings']) 的机制，
 * 否则测不到配置读写这条主路径。
 */
function makeCtx({ webPort, webHost = '127.0.0.1', entryConfig = {} }) {
  const routes = new Map();
  const effects = [];
  const logLines = [];
  const registeredTools = [];
  /** 仿 settings 的注册表：namespace -> { value, revision } */
  const settingsStore = new Map();

  function makeSettingsService() {
    return {
      register(ns, schema, options) {
        // 用 schema 的默认值 resolve 一次，模拟真实解析（defaults + base）
        let resolved;
        try {
          resolved = typeof schema === 'function' ? schema(options?.base ?? {}) : (options?.base ?? {});
        } catch {
          resolved = options?.base ?? {};
        }
        const record = { value: resolved, revision: 0 };
        settingsStore.set(ns, record);
        return {
          get: () => record.value,
          watch: () => () => {},
          async update(patch) {
            record.value = { ...record.value, ...patch };
            record.revision += 1;
          },
          async replace(section) {
            record.value = { ...section };
            record.revision += 1;
          },
        };
      },
      describe: () => [...settingsStore.entries()].map(([ns, r]) => ({
        ns, value: r.value, revision: r.revision, schema: {}, applies: 'live',
      })),
      get: (ns) => settingsStore.get(ns)?.value,
      async update(ns, patch) {
        const r = settingsStore.get(ns);
        if (!r) throw new Error(`namespace not registered: ${ns}`);
        r.value = { ...r.value, ...patch };
        r.revision += 1;
      },
      async replace(ns, section) {
        const r = settingsStore.get(ns);
        if (!r) throw new Error(`namespace not registered: ${ns}`);
        r.value = { ...section };
        r.revision += 1;
      },
      async mutate() { throw new Error('not used in this test'); },
    };
  }

  const settingsService = makeSettingsService();

  const ctx = {
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
    /** installSettingsSection 内部用 ctx.inject(['settings'], cb) 接线。 */
    inject(services, callback) {
      const list = Array.isArray(services) ? services : [services];
      if (list.includes('settings')) {
        const scoped = {
          settings: settingsService,
          effect(fn) {
            const cleanup = fn();
            effects.push({ cleanup, label: 'settings scoped' });
            return () => { if (typeof cleanup === 'function') cleanup(); };
          },
          fiber: { state: 0 },
        };
        callback(scoped);
      }
    },
    get(name) {
      if (name === 'settings') return settingsService;
      if (name === 'tools') {
        return { register: (def) => { registeredTools.push(def); return () => {}; } };
      }
      return undefined;
    },
  };

  return { ctx, routes, effects, logLines, registeredTools, settingsStore };
}

// ═══════════════════════════ 主流程 ═══════════════════════════

async function main() {
  const dshPort = await freePort();
  const relayPort = await freePort();

  const pluginEntry = pathToFileURL(
    path.resolve(import.meta.dirname, '..', 'dsh-relay', 'lib', 'index.js'),
  ).href;
  const mod = await import(pluginEntry);
  const plugin = mod.default ?? mod;
  const applyFn = plugin.apply ?? mod.apply;

  section('插件形状');
  check('导出 name = dsh-relay', (plugin.name ?? mod.name) === 'dsh-relay', `got ${plugin.name ?? mod.name}`);
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
  const host = await startRouteHost(h.routes);

  // 等 effect 里的异步启动落定
  await new Promise((r) => setTimeout(r, 600));

  section('读取本进程真实端口（不硬编码）');
  {
    const status = await callRoute(host, 'GET', '/dsh-relay/status');
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
    // ── 无 Origin → 放行 ──
    //
    // 浏览器对**跨站写请求必然附带 Origin**，所以「没有 Origin」不可能来自跨站。
    // dsh 自己的 isTrustedApiRequest 也是这么判的（origin === undefined → true），
    // 本插件与之对齐。
    const noOrigin = await callRoute(host, 'POST', '/dsh-relay/control', { body: { action: 'status' } });
    check('无 Origin 的 POST → 放行（与 dsh 自身策略一致）', noOrigin.status === 200, `got ${noOrigin.status}`);

    // ── Electron 自渲染页面 → 放行（本次 403 bug 的回归锁）──
    //
    // Electron 的客户端页面跑在 dsh-app://app/ 下，该协议被注册为
    // standard+secure，页面 fetch 会带这个 Origin。
    // 若按「Origin 必须等于 Host」处理，`new URL('dsh-app://app').host` 是 "app"，
    // 与真实 Host 永不相等 → 一律 403，表现就是「设置页按钮点了没反应」。
    const electron = await callRoute(host, 'POST', '/dsh-relay/control', {
      headers: { origin: 'dsh-app://app', host: `127.0.0.1:${host.port}` },
      body: { action: 'status' },
    });
    check('Electron 的 dsh-app:// Origin → 放行', electron.status === 200,
      `got ${electron.status} ${electron.body.slice(0, 120)}`);

    // ── 真正的跨源 → 仍拒绝（安全边界不放宽）──
    const crossOrigin = await callRoute(host, 'POST', '/dsh-relay/control', {
      // 页面在 evil.example.com，请求发往本机：Origin 是攻击者域名，Host 是真实地址
      headers: { origin: 'http://evil.example.com', host: `127.0.0.1:${host.port}` },
      body: { action: 'status' },
    });
    check('跨源 POST → 403', crossOrigin.status === 403, `got ${crossOrigin.status}`);

    // 隧道场景下的跨站也必须拒（Origin 与 Host 不同 authority）
    const tunnelCross = await callRoute(host, 'POST', '/dsh-relay/control', {
      headers: { origin: 'https://evil.example.com', host: 'example.com:3091' },
      body: { action: 'status' },
    });
    check('隧道 authority 下的跨源 POST → 403', tunnelCross.status === 403, `got ${tunnelCross.status}`);

    // ── http 同源 → 放行 ──
    const okOrigin = await callRoute(host, 'POST', '/dsh-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'status' },
    });
    check('http 同源 POST → 200', okOrigin.status === 200, `got ${okOrigin.status}`);

    // 隧道同源（Origin 与 Host 一致）→ 放行
    const tunnelSame = await callRoute(host, 'POST', '/dsh-relay/control', {
      headers: { origin: 'https://example.com:3091', host: 'example.com:3091' },
      body: { action: 'status' },
    });
    check('隧道同源 POST → 200', tunnelSame.status === 200, `got ${tunnelSame.status}`);

    // /config 走同一判据
    const cfgElectron = await callRoute(host, 'POST', '/dsh-relay/config', {
      headers: { origin: 'dsh-app://app', host: `127.0.0.1:${host.port}` },
      body: { config: { listenPort: relayPort } },
    });
    check('Electron Origin 下 /config 也放行', cfgElectron.status === 200,
      `got ${cfgElectron.status} ${cfgElectron.body.slice(0, 120)}`);

    const getOnControl = await callRoute(host, 'GET', '/dsh-relay/control');
    check('control 只接受 POST', getOnControl.status === 405, `got ${getOnControl.status}`);

    const unknown = await callRoute(host, 'GET', '/dsh-relay/nope');
    check('未知子路由 → 404', unknown.status === 404, `got ${unknown.status}`);
  }

  section('开关真正改变监听状态');
  {
    check('启用后端口在监听', await portListening(relayPort) === true, `port ${relayPort} not listening`);

    const stopped = await callRoute(host, 'POST', '/dsh-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'stop' },
    });
    const stopBody = JSON.parse(stopped.body);
    check('stop 返回 ok', stopBody.ok === true, stopped.body);
    check('stop 后状态为 stopped', stopBody.status.state === 'stopped', `got ${stopBody.status.state}`);
    check('stop 后端口已释放', await portListening(relayPort) === false, `port ${relayPort} still listening`);

    const started = await callRoute(host, 'POST', '/dsh-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'start' },
    });
    const startBody = JSON.parse(started.body);
    check('start 返回 ok', startBody.ok === true, started.body);
    check('start 后端口重新监听', await portListening(relayPort) === true, `port ${relayPort} not listening`);

    const toggled = await callRoute(host, 'POST', '/dsh-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'toggle' },
    });
    const toggleBody = JSON.parse(toggled.body);
    check('toggle 关闭中转', toggleBody.status.state === 'stopped', `got ${toggleBody.status.state}`);
    check('toggle 后端口已释放', await portListening(relayPort) === false, `port ${relayPort} still listening`);
  }

  section('配置写入（走 settings 命名空间）');
  {
    const saved = await callRoute(host, 'POST', '/dsh-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { enabled: true, listenPort: relayPort, password: 'new-pass' } },
    });
    check('config 路由返回 200', saved.status === 200, `got ${saved.status}`);

    // 持久化落在 settings 命名空间里（与设置页同一份存储）
    const rec = h.settingsStore.get('dsh-relay');
    check('settings 命名空间已注册', rec !== undefined, 'namespace missing');
    if (rec) {
      check('命名空间里口令已更新', rec.value.password === 'new-pass', `got ${rec.value.password}`);
      check('命名空间里端口正确', Number(rec.value.listenPort) === relayPort, `got ${rec.value.listenPort}`);
      check('写入推进了 revision', rec.revision > 0, `revision=${rec.revision}`);
    }

    const statusAfter = JSON.parse((await callRoute(host, 'GET', '/dsh-relay/status')).body);
    check('新口令立即生效（hasPassword=true）', statusAfter.hasPassword === true, `got ${statusAfter.hasPassword}`);
    check('status 回报 settings 命名空间名', statusAfter.settingsNamespace === 'dsh-relay', `got ${statusAfter.settingsNamespace}`);
  }

  section('自动会话：口令为空时保存的是「用户原意」');
  {
    // 场景：用户把口令清空、但 autoSession 仍想开着。
    // 归一化会把生效值压成 false（安全硬约束），但**写回存储的必须是原意 true** ——
    // 否则用户下次填回口令时开关已被偷偷关掉，且他完全不知道发生过什么。
    const saved = await callRoute(host, 'POST', '/dsh-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { enabled: true, listenPort: relayPort, password: '', autoSession: true } },
    });
    check('清空口令 + 开着自动会话 → 写入成功', saved.status === 200, `got ${saved.status} ${saved.body}`);

    const rec = h.settingsStore.get('dsh-relay');
    check('存储里保留用户原意 autoSession=true',
      rec && rec.value.autoSession === true, JSON.stringify(rec && rec.value.autoSession));

    const snap = JSON.parse((await callRoute(host, 'GET', '/dsh-relay/status')).body);
    check('生效值被压成 false（安全硬约束）', snap.config.autoSession === false, String(snap.config.autoSession));
    check('原意字段仍是 true', snap.config.autoSessionWanted === true, String(snap.config.autoSessionWanted));
    check('status.session 标记被口令为空压掉',
      snap.session && snap.session.blockedByEmptyPassword === true && snap.session.enabled === false,
      JSON.stringify(snap.session));

    // 再把口令填回去 → 开关应自动恢复生效（用户没碰过它）
    const back = await callRoute(host, 'POST', '/dsh-relay/config', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { config: { enabled: true, listenPort: relayPort, password: 'restored-pw', autoSession: true } },
    });
    check('填回口令 → 写入成功', back.status === 200, `got ${back.status}`);
    const snap2 = JSON.parse((await callRoute(host, 'GET', '/dsh-relay/status')).body);
    check('填回口令后自动会话恢复生效（无需用户再动开关）',
      snap2.config.autoSession === true && snap2.config.autoSessionBlocked === false,
      JSON.stringify({ a: snap2.config.autoSession, b: snap2.config.autoSessionBlocked }));
  }

  section('effect 清理 = 停中转 + 释放端口');
  {
    await callRoute(host, 'POST', '/dsh-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort}` },
      body: { action: 'start' },
    });
    check('清理前端口在监听', await portListening(relayPort) === true, 'not listening before cleanup');

    // 触发插件卸载（Cordis 卸载时跑 effect 的 cleanup）
    for (const e of h.effects) {
      if (typeof e.cleanup === 'function') e.cleanup();
    }
    await new Promise((r) => setTimeout(r, 800));

    check('清理后端口已释放', await portListening(relayPort) === false, `port ${relayPort} still listening`);
    check('清理后路由已注销', h.routes.has('/dsh-relay') === false, 'route still registered');
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

    const st = JSON.parse((await callRoute(host2, 'GET', '/dsh-relay/status')).body);
    check('state=error', st.state === 'error', `got ${st.state}`);
    check("lastError='port-in-use'", st.lastError === 'port-in-use', `got ${st.lastError}`);
    check('路由仍可用（插件没崩）', st.dshPort === dshPort2, `got ${st.dshPort}`);

    await new Promise((r) => squatter.close(r));
    await callRoute(host2, 'POST', '/dsh-relay/control', {
      headers: { origin: `http://127.0.0.1:${dshPort2}` },
      body: { action: 'start' },
    });
    const st2 = JSON.parse((await callRoute(host2, 'GET', '/dsh-relay/status')).body);
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

    const st = JSON.parse((await callRoute(host3, 'GET', '/dsh-relay/status')).body);
    check('state=stopped', st.state === 'stopped', `got ${st.state} / ${st.lastError}`);
    check('未占用端口', await portListening(somePort) === false, `port ${somePort} unexpectedly listening`);
    check('仍能读到 dsh 端口', st.dshPort === quietPort, `got ${st.dshPort}`);

    // 关掉之后仍可手动启用
    await callRoute(host3, 'POST', '/dsh-relay/control', {
      headers: { origin: `http://127.0.0.1:${quietPort}` },
      body: { action: 'start' },
    });
    const st2 = JSON.parse((await callRoute(host3, 'GET', '/dsh-relay/status')).body);
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
