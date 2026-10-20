/**
 * inspect-dsh-plugins.mjs — 通过 inspector 的 CDP 查 dsh 运行中的插件状态
 *
 * 目的：确认 `dsh-better-sidebar` 的宿主半为什么没注册 /sidebar/* 路由。
 * inspector 的 CDP 目标在 Host realm（Node 侧），能访问 dsh 的运行态。
 *
 * 用法：node plugin/tools/inspect-dsh-plugins.mjs [关键字]
 */
'use strict';

const KEYWORD = process.argv[2] || 'sidebar';

const list = await (await fetch('http://127.0.0.1:9230/json/list')).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (page === undefined) throw new Error('没有可用的 page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;

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
        resolve(m.result?.result?.value ?? null);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => resolve(null), 8000);
  });
}

// 1) 列出全局可见的 dsh 相关对象
const globals = await evaluate(`(() => {
  const names = Object.getOwnPropertyNames(globalThis).filter(n => /dsh|cordis|loader|ctx/i.test(n));
  return JSON.stringify(names);
})()`);
console.log('全局相关对象:', globals);

// 2) 尝试拿到 loader / ctx 并列出 entries
const entries = await evaluate(`(() => {
  const tries = [];
  const g = globalThis;
  for (const key of Object.getOwnPropertyNames(g)) {
    if (!/ctx|loader|app|root/i.test(key)) continue;
    const v = g[key];
    if (!v || typeof v !== 'object') continue;
    if (v.loader && typeof v.loader.entries === 'function') {
      try {
        const list = [...v.loader.entries()].map(e => ({
          id: e.id ?? e.options?.id,
          name: e.options?.name ?? e.name,
          disabled: e.disabled ?? false,
        }));
        return JSON.stringify({ via: key, count: list.length, list });
      } catch (err) { tries.push(key + ': ' + err.message); }
    }
  }
  return JSON.stringify({ error: 'no loader found', tries });
})()`);

console.log('');
console.log('插件 entries:');
let parsed = null;
try { parsed = JSON.parse(entries); } catch { console.log(entries); }

if (parsed && parsed.list) {
  console.log(`  共 ${parsed.count} 个（via ${parsed.via}）\n`);
  for (const e of parsed.list) {
    const hit = JSON.stringify(e).toLowerCase().includes(KEYWORD.toLowerCase());
    console.log(`  ${hit ? '★' : ' '} ${String(e.id).padEnd(28)} ${String(e.name).padEnd(46)} disabled=${e.disabled}`);
  }
} else {
  console.log(entries);
}
process.exit(0);
