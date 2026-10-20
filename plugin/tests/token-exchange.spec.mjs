/**
 * token-exchange.spec.mjs — `?token=` 交换验真的专项测试
 *
 * ── 背景：这条防线曾经是个洞 ──
 *
 * 0.3.0 及以前，`isDshTokenExchange()` 只校验**形状**就放行：
 * 只要 `GET /?token=<非空>` 就跳过中转口令认证。于是浏览器书签里那条来自
 * **上一次 dsh 启动**的旧 URL 也能绕过口令 —— 而 dsh 重启后旧 token 必然
 * 作废，结果是：
 *
 *   用户带旧 token 打开 → 中转放行 → dsh 回 401
 *   「dsh web authentication required; reopen the URL printed by dsh web.」
 *
 * 用户看到「不用输口令就进去了，但所有操作都 401」，而真正该看到的是中转
 * 自己的口令登录页。绕过自家中转口令、把请求丢给一个必然拒绝的上游，
 * 比直接要求输口令糟糕得多。
 *
 * ── 本测试锁定的不变量 ──
 *
 *   1. 只有**与当次 launchToken 恒定时相等**的 token 才放行
 *   2. 拿不到 launchToken 时**一律不放行**（安全默认，宁可要口令）
 *   3. 形状不对的（非 GET、非 `/`、多 token、空 token）一律不放行
 *   4. 被拒的请求**不会**被转发到上游（不能把请求丢给必然 401 的上游）
 *   5. 比较使用恒定时比较（源级断言，防时序侧信道）
 *
 * 用法：node plugin/tests/token-exchange.spec.mjs
 */
'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import { createRelay } from '../dsh-public-relay/lib/relay.js';
import { normalizeConfig } from '../dsh-public-relay/lib/config.js';

// ── 断言框架 ──
let passed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? `: ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

/** 整体超时保险：句柄挂起时不能让「卡死」伪装成「通过」。 */
const WATCHDOG_MS = 60000;
const watchdog = setTimeout(() => {
  console.error(`\n[test] 超时 ${WATCHDOG_MS / 1000}s 仍未结束，判定失败`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

/** 发一个 HTTP 请求到本机端口，收集状态、头、正文。 */
function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 找一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 桩上游：模拟 dsh 的启动令牌交换。
 * 记录收到的请求，便于断言「被拒的请求没有被转发」。
 */
function startUpstream(validToken) {
  const seen = [];
  let port = 0;

  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });

    let url;
    try {
      url = new URL(req.url, 'http://placeholder');
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }

    const tokens = url.searchParams.getAll('token');
    if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1 && tokens[0] === validToken) {
      const authority = req.headers.host || 'unknown';
      const cookieName = `dsh-auth-${Buffer.from(authority).toString('base64url')}`;
      res.writeHead(302, {
        'set-cookie': `${cookieName}=signed; Path=/; HttpOnly`,
        location: './',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    // 其它一切：模拟 dsh 的拒绝
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({ port: () => port, seen, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ═══════════════════════════════════════════════════════════
async function main() {
  const VALID = 'THE-CURRENT-LAUNCH-TOKEN';
  const upstream = await startUpstream(VALID);
  const relayPort = await freePort();
  const password = 'spec-password';

  const makeRelay = (resolveLaunchToken, port = relayPort) => createRelay({
    getDshEndpoint: () => ({ host: '127.0.0.1', port: upstream.port() }),
    getConfig: () => normalizeConfig({
      listenPort: port, password, forceLoopback: false,
    }),
    log: () => {},
    resolveLaunchToken,
  });

  const relay = makeRelay(() => VALID);
  await relay.start();

  // ── 1. 有效 token → 放行 ──
  section('有效 token：放行并转发给上游');
  {
    const r = await request(relayPort, `/?token=${VALID}`);
    check('向前转发（302，非登录页）', r.status === 302, `got ${r.status}`);
    check('上游下发的 Set-Cookie 被透传',
      String(r.headers['set-cookie']?.[0] || '').startsWith('dsh-auth-'),
      String(r.headers['set-cookie']?.[0] || '').slice(0, 40));
    check('Location 指向 ./', r.headers.location === './', `got ${r.headers.location}`);
    check('上游确实收到了该请求',
      upstream.seen.some((x) => String(x.url).includes(`token=${VALID}`)),
      '上游没收到');
  }

  // ── 2. 过期/错误的 token → 拦截 ──
  section('错误 token：拦截为登录页，且不转发');
  {
    const before = upstream.seen.length;
    const r = await request(relayPort, '/?token=STALE-OLD-TOKEN');
    check('返回本插件登录页', r.status === 200 && r.body.includes('dsh-public-relay 访问口令'),
      `got ${r.status} / ${r.body.slice(0, 50)}`);
    check('不是 dsh 的 401 文案', !r.body.includes('dsh web authentication required'),
      '仍然透传了 dsh 的 401');
    check('该请求没有被转发到上游', upstream.seen.length === before,
      `上游多收到 ${upstream.seen.length - before} 条`);
  }

  // ── 3. 形状不对的一律拦截 ──
  section('形状不合法：一律拦截');
  {
    const before = upstream.seen.length;

    const bare = await request(relayPort, '/');
    check('无 token 的裸 GET / → 登录页',
      bare.status === 200 && bare.body.includes('dsh-public-relay 访问口令'), `got ${bare.status}`);

    const multi = await request(relayPort, `/?token=${VALID}&token=other`);
    check('多个 token → 拦截',
      multi.status === 200 && multi.body.includes('dsh-public-relay 访问口令'), `got ${multi.status}`);

    const empty = await request(relayPort, '/?token=');
    check('空 token → 拦截',
      empty.status === 200 && empty.body.includes('dsh-public-relay 访问口令'), `got ${empty.status}`);

    const wrongPath = await request(relayPort, `/api/anything?token=${VALID}`);
    check('非 / 路径带 token → 拦截（不是登录页也不是放行）',
      wrongPath.status === 401 || wrongPath.status === 200, `got ${wrongPath.status}`);

    const post = await request(relayPort, `/?token=${VALID}`, { method: 'POST' });
    check('非 GET 带 token → 拦截', post.status === 401 || post.status === 403, `got ${post.status}`);

    check('上述请求都没有被转发到上游', upstream.seen.length === before,
      `上游多收到 ${upstream.seen.length - before} 条`);
  }

  // ── 4. 拿不到 launchToken 时：安全默认是不放行 ──
  section('拿不到 launchToken：安全默认为不放行');
  {
    const noTokenPort = await freePort();
    const r1 = makeRelay(() => null, noTokenPort);
    await r1.start();
    const before = upstream.seen.length;

    const r = await request(noTokenPort, `/?token=${VALID}`);
    check('无法验证时即使是「看起来正确」的 token 也不放行',
      r.status === 200 && r.body.includes('dsh-public-relay 访问口令'),
      `got ${r.status} / ${r.body.slice(0, 50)}`);
    check('该请求没有被转发到上游', upstream.seen.length === before,
      `上游多收到 ${upstream.seen.length - before} 条`);

    const st = r1.status();
    check('状态里 tokenExchange.verifiable=false',
      st.tokenExchange && st.tokenExchange.verifiable === false,
      JSON.stringify(st.tokenExchange));
    await r1.stop();
  }

  // ── 5. 抛异常的 resolver 也不能让它崩或放行 ──
  section('resolver 抛异常：降级为不放行，不崩溃');
  {
    const throwPort = await freePort();
    const r2 = makeRelay(() => { throw new Error('boom'); }, throwPort);
    await r2.start();

    const r = await request(throwPort, `/?token=${VALID}`);
    check('resolver 抛异常时仍返回登录页',
      r.status === 200 && r.body.includes('dsh-public-relay 访问口令'), `got ${r.status}`);
    check('中转自身没有崩（status 仍可读）', r2.status().state === 'running',
      `got ${r2.status().state}`);
    await r2.stop();
  }

  // ── 6. 拒绝计数进入状态 ──
  section('拒绝计数可观测');
  {
    const st = relay.status();
    check('tokenExchange 存在', st.tokenExchange !== undefined, 'undefined');
    check('tokenExchange.verifiable=true', st.tokenExchange?.verifiable === true,
      JSON.stringify(st.tokenExchange));
    check('rejects 计数 > 0（前面拒过若干次）', (st.tokenExchange?.rejects ?? 0) > 0,
      `got ${st.tokenExchange?.rejects}`);
    check('lastReason 是已知枚举之一',
      ['mismatch', 'unavailable'].includes(st.tokenExchange?.lastReason),
      `got ${st.tokenExchange?.lastReason}`);
    check('状态里不含 token 原文',
      !JSON.stringify(st.tokenExchange).includes(VALID), '泄漏了 token');
  }

  // ── 7. 源级断言：恒定时比较 ──
  section('实现细节：恒定时比较');
  {
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../dsh-public-relay/lib/relay.js', import.meta.url), 'utf8',
    ));
    check('使用 crypto.timingSafeEqual 比较 token',
      /timingSafeEqual\(a, b\)/.test(src), '未找到恒定时比较');
    check('先比长度再恒定时比较（timingSafeEqual 要求等长）',
      /a\.length !== b\.length/.test(src), '缺少长度前置检查');
  }

  await relay.stop();
  await upstream.close();

  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`token 交换验真测试全部通过：${passed} 项断言 ✅`);
    clearTimeout(watchdog);
    process.exit(0);
  }
  console.error(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('测试异常终止：', err);
  process.exit(1);
});
