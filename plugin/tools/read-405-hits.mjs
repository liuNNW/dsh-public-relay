/**
 * read-405-hits.mjs — 读取钩子记录到的 dsh 请求（配合 hook-dsh-405.mjs）
 *
 * 钩子记录 dsh webServer 收到的**每一个**请求（method + url + 关键头）。
 * 拿到日志后与「哪些请求返回了 405」对照，就能定位到具体是哪个路径。
 */
'use strict';

const list = await (await fetch('http://127.0.0.1:9230/json/list')).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (page === undefined) throw new Error('没有可用的 page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;

// 等连接就绪，否则 send 会抛 InvalidStateError
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
  setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000);
});

function evaluate(expr) {
  return new Promise((resolve) => {
    const myId = ++id;
    const onMsg = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (m.id === myId) {
        ws.removeEventListener('message', onMsg);
        try { resolve(JSON.parse(m.result.result.value)); } catch { resolve(null); }
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => resolve(null), 6000);
  });
}

const diag = await evaluate(`(() => {
  try {
    const http = process.getBuiltinModule('node:http');
    return JSON.stringify({
      hooked: !!http.__dsh405Hooked,
      logLen: (globalThis.__dshReqLog || []).length,
    });
  } catch (e) { return JSON.stringify({ err: String(e.message) }); }
})()`);

const log = await evaluate('JSON.stringify(globalThis.__dshReqLog || [])');

console.log('── 诊断 ──');
console.log(JSON.stringify(diag));
console.log('');

if (log === null || log.length === 0) {
  console.log('没有记录。先运行 hook-dsh-405.mjs 注入钩子。');
  process.exit(0);
}

console.log(`记录到 ${log.length} 个请求。最后 40 个：\n`);
for (const r of log.slice(-40)) {
  console.log(`  ${String(r.method).padEnd(7)} ${String(r.url).slice(0, 90)}`);
  console.log(`      host=${r.host}  accept=${String(r.accept ?? '').slice(0, 40)}  ct=${r.contentType ?? '-'}`);
}
process.exit(0);
