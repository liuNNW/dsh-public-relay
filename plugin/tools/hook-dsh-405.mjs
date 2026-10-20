/**
 * hook-dsh-405.mjs — 在 dsh 进程内挂钩 webServer，记录它收到的所有请求
 *
 * ── 为什么需要这个工具 ──
 *
 * 2026-10-20 排查「桌面端点开侧边栏文档 → HTTP 405」时，纯静态分析卡住了：
 * dsh 里有 6 处会返 405（fallback / open-in-app / hmr / file-upload /
 * inspector / frontend-static），光看源码无法确定实际命中哪一处；
 * 而桌面端页面跑在 `dsh-app://app`（Electron 自定义 scheme），
 * 普通浏览器抓包、curl 都碰不到它的请求。
 *
 * dsh 自带 experimental-inspector，在 127.0.0.1:9230 暴露了 CDP。
 * 它的 target 能在 **Host realm**（Node 侧）执行代码 ——
 * 于是可以在 dsh 自己的进程里挂钩 `http.Server`，
 * **看到它收到的每一个请求**（method / url / 关键头）。
 *
 * 这比代理层好在：不需要改端口、不需要改配置、不影响任何行为（只读记录）。
 *
 * ── 用法 ──
 *
 *   node plugin\tools\hook-dsh-405.mjs [秒数]      # 注入钩子并监听
 *   node plugin\tools\read-405-hits.mjs            # 随时读取已记录的请求
 *
 *   在监听期间操作 dsh 界面（点开文件、展开侧边栏…），
 *   然后运行 read-405-hits.mjs 看记录。
 *
 * 钩子常驻在 dsh 进程里，直到 dsh 退出。
 */
'use strict';

const SECONDS = Number(process.argv[2] || 30);

const list = await (await fetch('http://127.0.0.1:9230/json/list')).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (page === undefined) throw new Error('没有可用的 page target');

console.log(`[hook] 目标：${page.title}  ${page.url}`);
console.log(`[hook] 在 Host realm 挂钩 http.Server，监听 ${SECONDS}s`);
console.log('[hook] 请在桌面端点开一个文档文件…\n');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;

function send(method, params = {}) {
  id += 1;
  ws.send(JSON.stringify({ id, method, params }));
  return id;
}

const HOOK = `
(() => {
  try {
    // ESM realm 里没有 require；Node 22 提供 process.getBuiltinModule
    const http = (typeof process !== 'undefined' && process.getBuiltinModule)
      ? process.getBuiltinModule('node:http')
      : null;
    if (http === null) return 'ERR: 拿不到 node:http';

    globalThis.__dshReqLog = globalThis.__dshReqLog || [];

    /*
     * 钩 'request' 而不是 'response'：
     * 'request' 在请求刚进来时就触发，与响应如何写出无关 ——
     * 405 可能由任何一层产生（路由方法检查、fallback、认证拒绝），
     * 钩 'response' 依赖它一定被 emit，而 dsh 的某些路径不 emit。
     *
     * 每次注入都重装（先摘掉上一次的），保证钩的是当前这版实现。
     */
    if (http.Server.prototype.__dshOrigEmit) {
      http.Server.prototype.emit = http.Server.prototype.__dshOrigEmit;
      delete http.Server.prototype.__dshOrigEmit;
    }
    const origEmit = http.Server.prototype.emit;
    http.Server.prototype.__dshOrigEmit = origEmit;
    http.__dsh405Hooked = true;

    http.Server.prototype.emit = function (event, ...args) {
      try {
        if (event === 'request') {
          const req = args[0];
          globalThis.__dshReqLog.push({
            method: req ? req.method : null,
            url: req ? req.url : null,
            host: req ? req.headers.host : null,
            ua: req ? req.headers['user-agent'] : null,
            accept: req ? req.headers.accept : null,
            contentType: req ? req.headers['content-type'] : null,
            at: new Date().toISOString(),
          });
          if (globalThis.__dshReqLog.length > 800) globalThis.__dshReqLog.shift();
        }
      } catch {}
      return origEmit.apply(this, [event, ...args]);
    };
    return 'hooked(request)';
  } catch (e) {
    return 'ERR: ' + String(e && e.message || e);
  }
})()
`;

ws.addEventListener('open', () => {
  send('Runtime.enable');
  send('Runtime.evaluate', { expression: HOOK, returnByValue: true });
  console.log('[hook] 钩子已注入\n');
});

ws.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  } catch {
    return;
  }
  if (msg.id !== undefined) {
    const v = msg.result?.result?.value;
    if (v !== undefined) console.log('[hook] 注入结果:', v);
    return;
  }
});

setTimeout(async () => {
  // 读取命中记录
  const hits = await new Promise((resolve) => {
    const myId = id + 1;
    id = myId;
    ws.send(JSON.stringify({
      id: myId,
      method: 'Runtime.evaluate',
      params: { expression: 'JSON.stringify(globalThis.__dsh405Hits || [])', returnByValue: true },
    }));
    const onMsg = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (m.id === myId) {
        ws.removeEventListener('message', onMsg);
        try { resolve(JSON.parse(m.result.result.value)); } catch { resolve([]); }
      }
    };
    ws.addEventListener('message', onMsg);
    setTimeout(() => resolve([]), 5000);
  });

  console.log(`\n[hook] 捕获 ${hits.length} 条 405：\n`);
  if (hits.length === 0) {
    console.log('未捕获 —— 请在监听期间点开文档文件。');
  } else {
    for (const h of hits) {
      console.log(`  ${h.method} ${h.url}`);
      console.log(`     host=${h.host}  accept=${h.accept}`);
      console.log(`     ua=${String(h.ua ?? '').slice(0, 90)}`);
      console.log(`     at=${h.at}`);
      console.log('');
    }
  }
  ws.close();
  process.exit(0);
}, SECONDS * 1000);

ws.addEventListener('error', (e) => {
  console.error('[hook] WebSocket 错误:', e?.message ?? e);
  process.exit(1);
});
