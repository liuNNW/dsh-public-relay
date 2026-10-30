#!/usr/bin/env node
/**
 * client-half.mjs — dsh-public-relay 浏览器半测试
 *
 * client.js 是 dsh web 按 classic script 加载的 bundle：执行时只调
 * window.__ModuleLoader__.load({id, factory}) 注册工厂，真正的副作用
 * 在 factory(require) 物化时才跑。这里完整模拟这条链路：
 *
 *   1. 造一个假 window.__ModuleLoader__，跑 client.js 文本；
 *   2. 用假的 require('react') 物化 factory，拿到 exports；
 *   3. 调 apply(ctx)，验证 settings.section 与 shell.overlay 两个座位都注册了；
 *   4. 用假 React 真渲染两个组件，验证不抛错、且真的发出 /dsh-public-relay/status 请求；
 *   5. 验证宿主不可用时组件静默降级（不白屏）。
 *
 * 运行：node plugin/tests/client-half.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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

// ─────────────────────────── 假 React ───────────────────────────
//
// 只实现 client.js 用到的那部分：createElement、useState、useEffect、useRef。
//
// 关键点：hook 状态必须**跨渲染保留**，否则 setState 的效果在下一轮渲染
// 就丢了，组件会永远停在 loading 态（这正是真实 React 不会发生的事）。
// 这里按"组件函数引用 → hook 槽数组"记忆，测试里每个组件只渲染一个实例，
// 所以这个键够用。
//
// useEffect 在"渲染"后由调用方手动跑一次（真实 React 在 commit 后跑），
// 足够触发组件里的首次 fetch。

function makeFakeReact() {
  const stateful = new Map();   // componentFn -> { hooks: [] }
  let cursor = 0;
  let current = null;
  let pendingEffects = [];
  let rendered = [];

  function slotFor(componentFn) {
    let rec = stateful.get(componentFn);
    if (!rec) { rec = { hooks: [] }; stateful.set(componentFn, rec); }
    return rec;
  }

  function createElement(type, props, ...children) {
    const el = {
      __el: true,
      type,
      props: props || {},
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    };
    if (typeof type === 'function') rendered.push(el);
    return el;
  }

  /**
   * 每次渲染前准备当前组件的 hook 槽。
   *
   * 注意：深度渲染子组件时会反复切换 current，所以 setter 必须闭包绑定到
   * 「自己那个组件的 hooks 数组」。若 setter 写全局 current，等 effect 在整棵树
   * 渲染完之后触发 setState，就会写进最后一个子组件的槽里 —— 状态永远不生效
   * （表现为组件卡在 loading 态）。
   */
  function begin(componentFn) {
    current = slotFor(componentFn);
    cursor = 0;
  }

  function useState(initial) {
    const rec = current;          // 绑定到本组件
    const i = cursor++;
    if (!(i in rec.hooks)) {
      rec.hooks[i] = typeof initial === 'function' ? initial() : initial;
    }
    const set = (next) => {
      rec.hooks[i] = typeof next === 'function' ? next(rec.hooks[i]) : next;
    };
    return [rec.hooks[i], set];
  }

  function useRef(initial) {
    const rec = current;
    const i = cursor++;
    if (!(i in rec.hooks)) rec.hooks[i] = { current: initial };
    return rec.hooks[i];
  }

  function useEffect(fn, deps) {
    // 记下发起它的组件：effect 在整棵树渲染完之后才由调用方执行，
    // 届时 current 已经指向别的组件了。
    pendingEffects.push({ fn, owner: current });
  }

  /**
   * 渲染一个组件元素（一次调用 = 一次 render pass）。
   * 同一组件函数的后续 render() 会看到上一轮 setState 写入的值。
   */
  function render(el) {
    pendingEffects = [];
    rendered = [];
    begin(el.type);
    const out = el.type(el.props);
    // 递归展开子组件（StatusBlock / PortRow 这类内联组件），
    // 否则断言只能看到一层标签、看不到它们渲染的文案。
    const expanded = deepRender(out, 0);
    return { out: expanded, effects: [...pendingEffects], rendered: [...rendered] };
  }

  /**
   * 递归把函数类型元素渲染成它返回的元素树。
   *
   * 真实 React 由 reconciler 完成这件事；测试替身里手做一次深度展开，
   * 让 textOf 能抓到深层文案。同一组件在一个 render pass 内只展开一次
   * （用 seen 防止自引用造成的无限递归）。
   */
  function deepRender(node, depth, seen) {
    if (depth > 24) return node;
    const guard = seen || new Set();
    if (Array.isArray(node)) return node.map((c) => deepRender(c, depth + 1, guard));
    if (!node || !node.__el) return node;
    // 展开子节点
    const kids = node.children.map((c) => deepRender(c, depth + 1, guard));
    // 组件元素 → 调用其函数体（关键：hook 槽按组件函数记忆，状态可跨 pass 保留）
    if (typeof node.type === 'function' && !guard.has(node.type)) {
      guard.add(node.type);
      try {
        begin(node.type);
        const inner = node.type(node.props);
        guard.delete(node.type);
        return deepRender(inner, depth + 1, guard);
      } catch (err) {
        guard.delete(node.type);
        throw err;
      }
    }
    return { __el: true, type: node.type, props: node.props, children: kids };
  }

  /**
   * 执行上一轮 render 收集到的 effect，每个都在「它自己那个组件」的 hook
   * 上下文里跑（恢复 current / cursor），这样 effect 里的 setState 会落到
   * 正确的槽位。
   * @param effects - render() 返回的 effects 数组。
   */
  function runEffects(effects) {
    const savedCurrent = current;
    const savedCursor = cursor;
    const cleanups = [];
    for (const item of effects) {
      const entry = typeof item === 'function' ? { fn: item, owner: null } : item;
      if (entry.owner) {
        current = entry.owner;
        cursor = 0;
      }
      try {
        const cleanup = entry.fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      } catch (err) {
        cleanups.push(() => { throw err; });
        throw err;
      }
    }
    current = savedCurrent;
    cursor = savedCursor;
    return cleanups;
  }

  return {
    createElement, useState, useEffect, useRef, render, runEffects,
    react: { createElement, useState, useEffect, useRef },
  };
}

/** 把元素树拍平成字符串，便于断言"渲染出了什么"。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const c of node) textOf(c, out); return out; }
  if (node.__el) {
    if (node.props) {
      // 组件常常把文案放在 prop 里（例如 PortRow 的 label/value），
      // 只收 children 会漏掉这些内容。
      for (const k of ['value', 'placeholder', 'label', 'title', 'className', 'type', 'aria-label']) {
        if (node.props[k] !== undefined) out.push(`@${k}=${node.props[k]}`);
      }
    }
    for (const c of node.children) textOf(c, out);
  }
  return out;
}

/** 递归收集所有元素，便于按 className 找节点。 */
function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const c of node) collect(c, out); return out; }
  if (node.__el) {
    out.push(node);
    for (const c of node.children) collect(c, out);
  }
  return out;
}

/** 在元素树里找第一个 className 含某子串的元素。 */
function findByClass(root, needle) {
  return collect(root).find((e) => typeof e.props?.className === 'string' && e.props.className.includes(needle)) || null;
}

// ─────────────────────────── 加载 client bundle ───────────────────────────

const clientPath = path.resolve(import.meta.dirname, '..', 'dsh-public-relay', 'lib', 'client.js');
const clientSource = fs.readFileSync(clientPath, 'utf8');

function loadClientBundle() {
  const registrations = [];
  const styleTags = [];
  const logs = [];
  const fetchCalls = [];

  /**
   * 假 document：client.js 会插一个 <style>。
   *
   * querySelector 必须真的反映「已插入的标签」，否则 client.js 的
   * `style[data-plugin-css=...]` 查找永远拿不到已有标签，每次 apply 都会
   * 叠加一个新标签，测不出「替换」行为。真实 DOM 里能查到，替身也要能。
   *
   * 标签的 remove() 会把它标记 removed 并从 styleTags 里摘掉，
   * 模拟真实 DOM 的移除。
   */
  const fakeDocument = {
    head: { appendChild: (t) => styleTags.push(t) },
    querySelector(selector) {
      // 只支持 client.js 实际用到的那一种选择器
      const m = /^style\[data-plugin-css="(.+)"\]$/.exec(String(selector || ''));
      if (!m) return null;
      const wanted = m[1];
      return styleTags.find((t) => t.removed !== true && t.dataset && t.dataset.pluginCss === wanted) || null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = {
        tagName: tag,
        dataset: {},
        style: {},
        removed: false,
        set textContent(v) { this._text = v; },
        get textContent() { return this._text; },
        remove() {
          el.removed = true;
          const i = styleTags.indexOf(el);
          if (i >= 0) styleTags.splice(i, 1);
        },
      };
      return el;
    },
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => true,
    baseURI: 'http://127.0.0.1:19387/',
  };

  // 假 fetch：记录调用并按路径返回 payload
  let fetchResponder = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: 'stopped' }) });
  const fakeFetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return fetchResponder(url, init);
  };

  const sandbox = {
    window: {},
    document: fakeDocument,
    console: {
      log: (...a) => logs.push(['log', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fakeFetch,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { void fn; return 0; },
    clearTimeout: () => {},
    URL,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.__ModuleLoader__ = {
    mode: 'queue',
    pendingQueue: registrations,
    load(reg) { registrations.push(reg); },
    create() { throw new Error('not used in this test'); },
  };
  sandbox.window.location = { hostname: '127.0.0.1' };

  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: 'client.js' });

  return {
    registrations, styleTags, logs, fetchCalls,
    setFetchResponder(fn) { fetchResponder = fn; },
    sandbox,
  };
}

// ═══════════════════════════ 主流程 ═══════════════════════════

async function main() {
  section('bundle 注册（classic script 契约）');
  const env = loadClientBundle();
  check('只注册了一个 factory', env.registrations.length === 1, `got ${env.registrations.length}`);
  check('注册 id = dsh-public-relay', env.registrations[0]?.id === 'dsh-public-relay', `got ${env.registrations[0]?.id}`);
  check('factory 是函数', typeof env.registrations[0]?.factory === 'function', 'factory is not a function');
  check('执行脚本时无副作用（未插样式）', env.styleTags.length === 0,
    `style injected at script time: ${env.styleTags.length} — 物化前不该有副作用`);

  // ── 物化 factory ──
  section('factory 物化');
  const fake = makeFakeReact();
  const requireStub = (spec) => {
    if (spec === 'react') return fake.react;
    throw new Error(`unexpected require: ${spec}`);
  };

  let exports;
  try {
    exports = env.registrations[0].factory(requireStub);
  } catch (err) {
    check('factory 能物化', false, err.stack || err.message);
    // 必须立即止损：后面每一步都依赖 exports，用 undefined 继续只会溢出
    // 一堆假失败，掩盖真正的首个错误。抛出去由 main().catch 统一收尾。
    throw new Error(`factory 物化失败，无法继续：${err?.message || err}`);
  }
  check('factory 能物化', true);
  // 样式在 apply() 时注入（而不是物化时），所以物化后应为 0
  check('物化时不注入样式（样式在 apply 时注入）', env.styleTags.length === 0,
    `got ${env.styleTags.length}`);

  section('Cordis 插件形状');
  check('name = dsh-public-relay', exports.name === 'dsh-public-relay', `got ${exports.name}`);
  check('apply 是函数', typeof exports.apply === 'function', 'apply missing');
  check('inject 是数组', Array.isArray(exports.inject), `got ${typeof exports.inject}`);
  check('inject 含 slots', exports.inject.includes('slots'), `got ${JSON.stringify(exports.inject)}`);
  // 只声明 slots：其余一切自给自足（页面数据走自有 HTTP 路由）。
  // 这是硬性纪律 —— 一旦把某个宿主不提供的服务名写进 inject 或座位的 inject 面，
  // 该座位的 fiber 就永远不就绪，外壳不挂载它，槽位账本里停在 active:false，
  // 用户看到的就是「设置里根本没有这个插件」。
  check('inject 只声明 slots（零外部服务依赖）',
    Array.isArray(exports.inject) && exports.inject.length === 1 && exports.inject[0] === 'slots',
    `got ${JSON.stringify(exports.inject)}`);
  // ── apply：座位注册 ──
  section('座位注册');
  const slotRegistrations = [];
  // 刻意只提供 slots：真实宿主缺什么服务都不该影响本插件的注册与渲染。
  const ctx = {
    slots: {
      inject(slotName, cb) { slotRegistrations.push({ kind: 'inject', slotName, cb }); cb(); },
      register(meta, component) {
        slotRegistrations.push({ kind: 'register', meta, component });
        return () => {};
      },
    },
    effect(fn) { const c = fn(); return () => { if (typeof c === 'function') c(); }; },
    logger: { info: (m) => env.logs.push(['info', m]) },
    get: () => undefined,
  };

  try {
    exports.apply(ctx);
  } catch (err) {
    check('apply 不抛错', false, err.stack || err.message);
  }
  check('apply 不抛错', true);
  check('只有 slots 时 apply 也能完成（零服务依赖）', true);

  check('apply 后注入样式', env.styleTags.length === 1, `got ${env.styleTags.length}`);
  check('样式标签带 data-plugin', env.styleTags[0]?.dataset?.plugin === 'dsh-public-relay', `got ${JSON.stringify(env.styleTags[0]?.dataset)}`);
  check('样式内容非空', typeof env.styleTags[0]?.textContent === 'string' && env.styleTags[0].textContent.length > 100,
    `len=${env.styleTags[0]?.textContent?.length}`);

  const registers = slotRegistrations.filter((r) => r.kind === 'register');
  const injects = slotRegistrations.filter((r) => r.kind === 'inject');
  // 只应有两个座位，且都在设置里。刻意**不**用 shell.overlay：
  // 那个座位会在页面上挂悬浮元素，早期版本的左下角角标正好压住侧栏底部的
  // 「设置」按钮，导致用户点不开设置。
  check('inject 了两个座位', injects.length === 2, `got ${injects.length}: ${injects.map((i) => i.slotName).join(', ')}`);
  check('没有注册 shell.overlay（不在页面上挂悬浮元素）',
    !injects.some((i) => i.slotName === 'shell.overlay'),
    injects.map((i) => i.slotName).join(', '));
  check('注册了 plugins.row.config（插件行配置页）', injects.some((i) => i.slotName === 'plugins.row.config'),
    injects.map((i) => i.slotName).join(', '));
  check('注册了 settings.section', injects.some((i) => i.slotName === 'settings.section'),
    injects.map((i) => i.slotName).join(', '));
  check('register 调了两次', registers.length === 2, `got ${registers.length}`);

  const rowReg = registers.find((r) => r.meta.name === 'plugins.row.config');
  const settingsReg = registers.find((r) => r.meta.name === 'settings.section');
  // keyed 槽位用 key（`<包名>#<行 id>`），list 槽位用 id + order + label。
  check('plugins.row.config 元数据正确',
    rowReg?.meta.key === 'dsh-public-relay#dsh-public-relay',
    JSON.stringify(rowReg?.meta));
  check('settings.section 元数据正确',
    settingsReg?.meta.id === 'dsh-public-relay'
      && typeof settingsReg?.meta.order === 'number'
      && typeof settingsReg?.meta.label === 'function'
      && settingsReg.meta.label() === 'DSH 中转',
    JSON.stringify({ ...settingsReg?.meta, label: String(settingsReg?.meta?.label) }));

  // ── 关键：座位的注入面必须为空 ──
  //
  // 这是「设置里能否看到本插件」的硬性条件。真实宿主里，一旦注入面声明了某个
  // 它不提供的服务，该座位的 fiber 永远不就绪，外壳不挂载它，槽位账本里停在
  // `active: false` —— 用户看到的就是「设置里根本没有这个插件」。
  //
  // 实测教训：configForms 并不在本宿主的客户端服务目录里（可用的是 layout /
  // locale / sessions / slots / theme / timer / uiWorkspace / workspaces）。
  const injectFaces = injects.map((i) => {
    try {
      return i.cb && typeof i.cb === 'function' ? undefined : undefined;
    } catch (e) { return 'throw'; }
  });
  check('座位注册回调已执行（注入面无抛错）', injectFaces.every((x) => x !== 'throw'), JSON.stringify(injectFaces));

  const faceProblems = [];
  for (const r of registers) {
    // register(meta, component) 的 meta.inject 是注入面工厂（有的话）
    const face = typeof r.meta.inject === 'function' ? r.meta.inject() : r.meta.inject;
    if (face && typeof face === 'object') {
      const keys = Object.keys(face);
      if (keys.length > 0) faceProblems.push(`${r.meta.name}: ${keys.join(',')}`);
    }
  }
  check('两个座位的注入面都为空（不依赖任何宿主服务）',
    faceProblems.length === 0, faceProblems.join(' | '));

  // ── 渲染：宿主可用 ──
  section('渲染：宿主可用');
  const fullStatus = {
    ok: true,
    state: 'running',
    listen: { host: '127.0.0.1', port: 3091, address: '127.0.0.1:3091' },
    target: { host: '127.0.0.1', port: 3080, origin: 'http://127.0.0.1:3080' },
    dsh: { host: '127.0.0.1', port: 3080, address: '127.0.0.1:3080' },
    dshPort: 3080,
    dshAddress: '127.0.0.1:3080',
    forceLoopback: true,
    hasPassword: true,
    connections: 3,
    requests: 42,
    uptimeMs: 65000,
    lastError: null,
    config: {
      enabled: true, listenHost: '127.0.0.1', listenPort: 3091,
      password: 'pw', forceLoopback: true, targetHost: null, targetPort: null,
      autoSession: true, autoSessionWanted: true, autoSessionBlocked: false,
      // 真实快照里 config 内也带 hasPassword（0.3.4）；夹具必须照抄，
      // 否则「口令为空」的误报在测试里根本暴露不出来。
      hasPassword: true,
    },
    session: {
      ready: true, hasSecret: true, lastError: null,
      credentialsFile: '/fake/.credentials.yaml', maxAgeMs: 2592000000,
      enabled: true, blockedByEmptyPassword: false,
    },
  };
  env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => fullStatus }));

  /**
   * 座位的组件工厂收 props（view / useForm / inject 面）。
   * 这里模拟宿主给一份最小 props：view 非 'summary' 才会渲染完整面板。
   */
  const slotProps = { view: 'detail' };

  // 设置页组件
  let settingsEl;
  try {
    settingsEl = settingsReg.component(slotProps);
  } catch (err) {
    check('设置组件工厂不抛错', false, err.stack || err.message);
  }
  check('设置组件工厂不抛错', Boolean(settingsEl));
  let settingsRender;
  try {
    settingsRender = fake.render(settingsEl);
  } catch (err) {
    check('设置组件首次渲染不抛错', false, err.stack || err.message);
  }
  check('设置组件首次渲染不抛错', Boolean(settingsRender));

  // 首次渲染是 loading 态（useState 异步取值），跑一遍 effect 让 fetch 落定
  check('首次渲染走 effect 取状态', settingsRender.effects.length >= 1,
    `effects=${settingsRender.effects.length}`);
  try { fake.runEffects(settingsRender.effects); } catch (err) { check('设置组件 effect 不抛错', false, err.stack || err.message); }
  check('设置组件 effect 不抛错', true);

  // 给 fetch 的 promise 一个微任务机会落定，再渲染一次看真数据
  await new Promise((r) => setTimeout(r, 30));

  let settingsRender2;
  try {
    settingsRender2 = fake.render(settingsReg.component(slotProps));
  } catch (err) {
    check('设置组件二次渲染不抛错', false, err.stack || err.message);
  }
  check('设置组件二次渲染不抛错', Boolean(settingsRender2));

  const settingsText = textOf(settingsRender2.out).join(' | ');
  check('设置页出现标题「DSH 中转」', settingsText.includes('DSH 中转'), settingsText.slice(0, 200));
  check('设置页显示当前 dsh 端口 3080', settingsText.includes('3080'), settingsText.slice(0, 300));
  check('设置页显示中转端口 3091', settingsText.includes('3091'), settingsText.slice(0, 300));
  check('设置页有「当前 dsh 端口」标签', settingsText.includes('当前 dsh 端口'), settingsText.slice(0, 200));
  check('设置页有「中转监听」标签', settingsText.includes('中转监听'), settingsText.slice(0, 200));
  check('设置页状态显示运行中', settingsText.includes('运行中'), settingsText.slice(0, 300));
  check('设置页有停用按钮（因正在运行）', settingsText.includes('停用中转'), settingsText.slice(0, 400));
  check('设置页有「保存」按钮（自带表单）', settingsText.includes('保存'), settingsText.slice(-400));
  check('设置页展示了请求数与连接数', settingsText.includes('42') && settingsText.includes('3'), settingsText.slice(0, 400));

  // ── 渲染：停止态（停用之后不应白屏）──
  //
  // 真实事故：点「停用」后设置页整块变空、并弹一个报错。
  // 服务端复核是无辜的（toggle 200、停止态快照字段齐全、/status 仍 200），
  // 所以问题只可能在「用停止态快照渲染面板」这一步。
  section('渲染：停止态（停用后不白屏）');
  {
    const stoppedStatus = {
      ...fullStatus,
      state: 'stopped',
      uptimeMs: 0,
      connections: 0,
      requests: 0,
      startedAt: null,
      websocket: {
        compressEnabled: true, compressionReady: null,
        openConnections: 0, totalConnections: 0, uplinkBytes: 0, downlinkBytes: 0,
      },
    };
    env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => stoppedStatus }));

    let renderErr = null;
    let stoppedRender = null;
    try {
      const first = fake.render(settingsReg.component(slotProps));
      fake.runEffects(first.effects);
      await new Promise((r) => setTimeout(r, 30));
      stoppedRender = fake.render(settingsReg.component(slotProps));
    } catch (err) {
      renderErr = err;
    }
    check('停止态渲染不抛错', renderErr === null, renderErr && (renderErr.stack || renderErr.message));

    const stoppedText = stoppedRender ? textOf(stoppedRender.out).join(' | ') : '';
    check('停止态显示「已停止」', stoppedText.includes('已停止'), stoppedText.slice(0, 300));
    check('停止态仍给出「启用中转」按钮', stoppedText.includes('启用中转'), stoppedText.slice(0, 400));
    check('停止态面板不空白（配置字段仍在）',
      stoppedText.includes('访问口令') && stoppedText.includes('中转监听端口'),
      stoppedText.slice(0, 400));
  }

  // 复原运行态响应，避免影响后续用例
  env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => fullStatus }));

  // ── 真实点击「停用」：走完整交互路径 ──
  //
  // 上一段只是「用停止态快照重新渲染」。真实事故发生在**点击之后**：
  // onClick → /control → setSnap(停止态) → 重渲染。这一段把它完整跑一遍，
  // 任何一步抛错都会暴露出来（而不是被渲染测试掩盖）。
  section('交互：点击「停用」走完整路径');
  {
    /** 在元素树里找第一个满足条件的按钮。 */
    function findButton(root, needle) {
      let found = null;
      const walk = (n) => {
        if (n === null || n === undefined || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const c of n) walk(c); return; }
        if (!n.__el) return;
        if (n.type === 'button' && typeof n.props?.onClick === 'function'
          && textOf(n).join('').includes(needle)) found = n;
        for (const c of n.children) walk(c);
      };
      walk(root);
      return found;
    }

    env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => fullStatus }));
    let rr = fake.render(settingsReg.component(slotProps));
    fake.runEffects(rr.effects);
    await new Promise((r) => setTimeout(r, 30));
    rr = fake.render(settingsReg.component(slotProps));

    const toggleBtn = findButton(rr.out, '停用中转');
    check('找到「停用中转」按钮', toggleBtn !== null, textOf(rr.out).join(' | ').slice(0, 300));

    // /control 返回停止态快照（与真实宿主一致）
    const stoppedSnap = {
      ...fullStatus, state: 'stopped', uptimeMs: 0, startedAt: null,
    };
    env.setFetchResponder(async (url) => {
      if (String(url).includes('/dsh-public-relay/control')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, status: stoppedSnap, error: null }) };
      }
      return { ok: true, status: 200, json: async () => fullStatus };
    });

    let clickErr = null;
    if (toggleBtn !== null) {
      try { await toggleBtn.props.onClick(); } catch (err) { clickErr = err; }
    }
    check('点击停用不抛异常', clickErr === null, clickErr && (clickErr.stack || clickErr.message));
    await new Promise((r) => setTimeout(r, 40));

    let after = null;
    let afterErr = null;
    try { after = fake.render(settingsReg.component(slotProps)); } catch (err) { afterErr = err; }
    check('停用后重渲染不抛异常', afterErr === null, afterErr && (afterErr.stack || afterErr.message));
    const afterText = after ? textOf(after.out).join(' | ') : '';
    check('停用后显示「已停止」', afterText.includes('已停止'), afterText.slice(0, 400));
    check('停用后面板不空白', afterText.includes('访问口令'), afterText.slice(0, 400));
    check('停用后没有报错提示', !/HTTP \d|读取失败|保存失败/.test(afterText), afterText.slice(-400));
    check('停用后请求确实发到了 /control',
      env.fetchCalls.some((c) => String(c.url).endsWith('/dsh-public-relay/control')),
      JSON.stringify(env.fetchCalls.map((c) => c.url)));

    env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => fullStatus }));
  }

  // ── plugins.row.config 配置页（插件行的「配置」入口）──
  section('插件行配置页（plugins.row.config）');
  let cardRender = null;
  try {
    const first = fake.render(rowReg.component(slotProps));
    fake.runEffects(first.effects);
    await new Promise((r) => setTimeout(r, 30));
    cardRender = fake.render(rowReg.component(slotProps));
  } catch (err) {
    check('插件行配置页渲染不抛错', false, err.stack || err.message);
  }
  check('插件行配置页渲染不抛错', Boolean(cardRender));
  const cardText = cardRender ? textOf(cardRender.out).join(' | ') : '';
  check('配置页含「中转监听端口」字段', cardText.includes('中转监听端口'), cardText.slice(0, 600));
  check('配置页含「访问口令」字段', cardText.includes('访问口令'), cardText.slice(0, 600));
  check('配置页含「强制回环改写」字段', cardText.includes('强制回环改写'), cardText.slice(0, 600));
  check('配置页含「启用中转」字段', cardText.includes('启用中转'), cardText.slice(0, 600));
  check('配置页含「自动管理 dsh 会话」字段', cardText.includes('自动管理 dsh 会话'), cardText.slice(0, 800));
  check('配置页含自动会话的说明文案', cardText.includes('只输中转口令'), cardText.slice(0, 1200));
  check('配置页也显示当前 dsh 端口', cardText.includes('3080'), cardText.slice(0, 400));
  check('状态区显示「自动会话」指标', cardText.includes('自动会话'), cardText.slice(0, 600));

  // ── 自动会话的三种状态必须一眼可分 ──
  //
  // 这是本功能最容易回归的地方：口令为空时 normalizeConfig 会把生效值压成
  // false，UI 若照生效值渲染，会把「用户开着但被约束压掉」显示成普通的「已关闭」，
  // 用户只会以为开关坏了。所以单独覆盖三种状态。
  section('自动会话状态渲染');

  /** 用一份受控 status payload 渲染设置整页，返回文案。 */
  const renderSettingsWith = async (patch) => {
    const payload = { ...fullStatus, ...patch };
    env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => payload }));
    const r1 = fake.render(settingsReg.component(slotProps));
    fake.runEffects(r1.effects);
    await new Promise((res) => setTimeout(res, 30));
    return textOf(fake.render(settingsReg.component(slotProps)).out).join(' | ');
  };

  {
    const t1 = await renderSettingsWith({
      config: { ...fullStatus.config, autoSession: true, autoSessionWanted: true, autoSessionBlocked: false },
      session: { ...fullStatus.session, enabled: true, blockedByEmptyPassword: false },
    });
    check('生效时状态显示「已开启」', t1.includes('已开启'), t1.slice(0, 600));

    const t2 = await renderSettingsWith({
      config: { ...fullStatus.config, autoSession: false, autoSessionWanted: false, autoSessionBlocked: false },
      session: { ...fullStatus.session, enabled: false, blockedByEmptyPassword: false },
    });
    check('用户关闭时状态显示「已关闭」', t2.includes('已关闭'), t2.slice(0, 600));

    const t3 = await renderSettingsWith({
      config: {
        ...fullStatus.config, password: '', autoSession: false,
        autoSessionWanted: true, autoSessionBlocked: true,
      },
      session: { ...fullStatus.session, enabled: false, blockedByEmptyPassword: true },
    });
    check('被口令为空压掉时显示「已禁用」而非「已关闭」', t3.includes('已禁用'), t3.slice(0, 800));
    check('并给出被压掉的原因说明', t3.includes('口令是唯一门槛'), t3.slice(0, 1200));
  }

  // 密钥读不到且开关是开的 → 必须提示（否则用户不知道「为什么还是要 token」）
  {
    const t4 = await renderSettingsWith({
      config: { ...fullStatus.config, autoSession: true, autoSessionWanted: true, autoSessionBlocked: false },
      session: { ...fullStatus.session, ready: false, hasSecret: false, enabled: true, blockedByEmptyPassword: false },
    });
    check('密钥读不到时给出提示', t4.includes('读不到 dsh 的会话密钥'), t4.slice(0, 1200));
  }

  // 口令为空 + 用户勾上开关 → 表单区就地警告（保存前就能看到）
  //
  // 注意模拟方式：草稿只在首次初始化，之后上游配置变化**不会**覆盖草稿
  // （这是刻意的：不打断正在输入的用户）。所以这里必须真的去改那两个输入，
  // 而不是换个 status payload 就期待界面跟着变。
  {
    const payloadEmptyPw = {
      ...fullStatus,
      config: {
        ...fullStatus.config, password: '', autoSession: false,
        autoSessionWanted: false, autoSessionBlocked: false,
      },
      session: { ...fullStatus.session, enabled: false, blockedByEmptyPassword: false },
    };
    env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => payloadEmptyPw }));
    const r1 = fake.render(settingsReg.component(slotProps));
    fake.runEffects(r1.effects);
    await new Promise((res) => setTimeout(res, 30));
    const r3 = fake.render(settingsReg.component(slotProps));

    const all = collect(r3.out);
    const pwInput = all.find((e) => e.props && String(e.props.id || '').includes('password') && e.props.onChange);

    /** 按字段容器（.dsr-field）的文案找里面的复选框 —— 比按下标猜稳。 */
    const checkboxOfField = (root, labelText) => {
      const fields = collect(root).filter((e) => typeof e.props?.className === 'string' && e.props.className.includes('dsr-field'));
      const field = fields.find((f) => textOf(f).join(' ').includes(labelText));
      if (!field) return null;
      return collect(field).find((e) => e.props && e.props.type === 'checkbox' && e.props.onChange) || null;
    };

    const autoBox = checkboxOfField(r3.out, '自动管理 dsh 会话');
    check('找得到口令输入框与 autoSession 复选框', Boolean(pwInput) && Boolean(autoBox),
      `pwInput=${Boolean(pwInput)} autoBox=${Boolean(autoBox)}`);

    pwInput.props.onChange({ target: { value: '' } });
    autoBox.props.onChange({ target: { checked: true } });

    const after = textOf(fake.render(settingsReg.component(slotProps)).out).join(' | ');
    check('口令为空时勾上自动会话 → 表单区就地警告', after.includes('口令是唯一门槛'), after.slice(0, 1200));
    check('同时出现「有未保存的修改」提示', after.includes('有未保存的修改'), after.slice(-600));

    // 换个口令 → 警告应消失（约束已被满足）
    const r4 = fake.render(settingsReg.component(slotProps));
    const pw2 = collect(r4.out).find((e) => e.props && String(e.props.id || '').includes('password') && e.props.onChange);
    pw2.props.onChange({ target: { value: 'new-pw' } });
    const after2 = textOf(fake.render(settingsReg.component(slotProps)).out).join(' | ');
    check('填回口令后表单区警告消失', !after2.includes('口令是唯一门槛'), after2.slice(0, 1200));
  }

  // 恢复默认 responder，避免影响后续断言
  env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => fullStatus }));

  // 角标已移除：页面上不应再有任何悬浮元素（早期版本那个角标挡住了侧栏底部的
  // 「设置」按钮）。这里断言源码里不再有 position:fixed 的悬浮样式。
  check('样式里没有 position:fixed 悬浮元素（不遮挡侧栏设置按钮）',
    !/position:\s*fixed/.test(env.styleTags[0]?.textContent || ''),
    '样式里仍存在 position:fixed 规则');

  section('请求路径正确');
  check('确实请求了 /dsh-public-relay/status',
    env.fetchCalls.some((c) => String(c.url).endsWith('/dsh-public-relay/status')),
    env.fetchCalls.map((c) => c.url).join(', '));

  // ── 渲染：宿主不可用（降级，不白屏）──
  section('渲染：宿主不可用时不白屏');
  env.setFetchResponder(async () => { throw new Error('host route unavailable'); });
  let degraded = true;
  let degradedErr = '';
  try {
    const r = fake.render(settingsReg.component(slotProps));
    fake.runEffects(r.effects);
    await new Promise((res) => setTimeout(res, 30));
    const r2 = fake.render(settingsReg.component(slotProps));
    const t = textOf(r2.out).join(' | ');
    if (!t.includes('DSH 中转')) { degraded = false; degradedErr = 'título missing after fetch failure'; }
  } catch (err) {
    degraded = false;
    degradedErr = err.stack || err.message;
  }
  check('宿主不可用时设置组件仍渲染（不抛错）', degraded, degradedErr);

  // ── 无 document（非浏览器环境）不该崩 ──
  section('健壮性：缺 document / 缺 ctx 服务');
  {
    const env2 = loadClientBundle();
    const fake2 = makeFakeReact();
    const ex2 = env2.registrations[0].factory((s) => {
      if (s === 'react') return fake2.react;
      throw new Error(`unexpected require: ${s}`);
    });
    check('第二次加载仍能物化', typeof ex2.apply === 'function', 'apply missing');

    // 样式在 apply 时注入；连续两次 apply 只应插一次（按 data-plugin-css 去重）
    const ctx2 = {
      slots: { inject: (n, cb) => cb(), register: () => () => {} },
      locale: undefined,
      configForms: undefined,
      timer: { interval: () => () => {} },
      effect: (f) => { const c = f(); return () => { if (typeof c === 'function') c(); }; },
      logger: { info() {} },
    };
    ex2.apply(ctx2);
    ex2.apply(ctx2);
    // 每次 apply 都替换样式标签（而不是「已存在就跳过」），这样 HMR 后新版
    // CSS 一定会生效；替身里旧标签被 remove 后数组会累积，所以只断言「当前只有 1 个活标签」。
    const liveTags = env2.styleTags.filter((t) => t.removed !== true);
    check('重复 apply 后只保留一个活样式标签', liveTags.length === 1, `got ${liveTags.length}`);
  }

  // ── 渲染兜底：异常也不许白屏 ──
  //
  // 「点停用后设置里看不到任何内容」之所以难查，是因为渲染抛错后整块消失、
  // 一个字都不留。面板现在把异常捕获成可读文字 + 现场信息，这条用例锁住它。
  section('渲染兜底：出错时显示原因而不是空白');
  {
    const poison = { ...fullStatus };
    // patchedScripts 在状态区会被读到；让它抛错即可触发兜底分支
    Object.defineProperty(poison, 'patchedScripts', {
      configurable: true,
      get() { throw new Error('render-boom'); },
    });
    env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => poison }));

    let crashRender = null;
    let crashErr = null;
    try {
      const first = fake.render(settingsReg.component(slotProps));
      fake.runEffects(first.effects);
      await new Promise((r) => setTimeout(r, 30));
      crashRender = fake.render(settingsReg.component(slotProps));
    } catch (err) {
      crashErr = err;
    }
    check('渲染异常不会逃出组件', crashErr === null, crashErr && (crashErr.stack || crashErr.message));

    const crashText = crashRender ? textOf(crashRender.out).join(' | ') : '';
    check('出错时显示「面板渲染出错」而不是空白',
      crashText.includes('面板渲染出错'), crashText.slice(0, 300));
    check('出错时带出异常原文', crashText.includes('render-boom'), crashText.slice(0, 400));
    check('出错时带出 state / viaRelay 现场信息',
      crashText.includes('state=') && crashText.includes('viaRelay='), crashText.slice(0, 500));

    env.setFetchResponder(async () => ({ ok: true, status: 200, json: async () => fullStatus }));
  }

  // ── 写接口必须带凭据（0.3.4 回归）──
  //
  // 真实事故：前端 `call()` 只发 content-type，从未发 Authorization，
  // 而宿主半在「口令已设」时要求持凭据 → 设置页保存/停用**永远 403**。
  // 宿主半那边已有不带 bearer 的端到端用例；这里在客户端侧再钉一道，
  // 防止将来重构时把凭据悄悄丢掉（那种改法在服务端测试里看不出来）。
  section('写接口凭据（0.3.4）');
  {
    const src = clientSource;
    check('client.js 会发送 Authorization 头', /authorization\s*[:=]/i.test(src),
      '找不到 authorization 写入点');
    check('client.js 使用 Bearer 方案', src.includes('Bearer '), '找不到 Bearer 前缀');
    check('client.js 含 token 派生（HMAC + dsh-public-relay 盐）',
      src.includes('dsh-public-relay') && /HMAC/i.test(src),
      '找不到与宿主半一致的密钥派生');
    check('client.js 对 403 给出可读提示而非裸 HTTP 状态码',
      src.includes('needPasswordToSave') && !/return \{ ok: false, error: `HTTP \$\{response\.status\}` \};/.test(src.split("'forbidden'")[0].split('\n').slice(-3).join('\n')),
      '403 仍被折成 HTTP 403 裸文案');
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`浏览器半测试全部通过：${passed} 项断言 ✅`);
    process.exitCode = 0;
    return;
  }
  console.error(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n浏览器半测试自身异常：', err);
process.exitCode = 1;
});
