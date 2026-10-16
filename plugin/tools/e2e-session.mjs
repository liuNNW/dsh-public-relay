#!/usr/bin/env node
/**
 * e2e-session.mjs — 真实端到端验证：经中转只输口令就能进入 dsh
 *
 * 与单元测试不同，这里连的是**真实运行的 dsh**、用**真实凭据文件**，
 * 因此能证明「自动管理会话」在真实环境里成立。
 *
 * 流程：
 *   1. 起一个中转实例，指向真实 dsh（默认 127.0.0.1:19387）
 *   2. 不做任何 dsh 认证，直接请求 / → 应被中转的登录页拦下（401/登录页）
 *   3. 用中转口令登录，拿到 relay_session
 *   4. 再请求 / → 中转自动补签 dsh 会话 → 应拿到应用页面（含 __DSH_BOOT__）
 *   5. 反证：autoSession=false 时应拿不到应用页面
 *
 * 用法：node plugin/tools/e2e-session.mjs [dshPort]
 */
import http from 'node:http';
import net from 'node:net';
import { createRelay } from '../dsh-relay/lib/relay.js';
import { createSessionSigner } from '../dsh-relay/lib/dsh-cookie.js';
import { normalizeConfig } from '../dsh-relay/lib/config.js';

const dshPort = Number(process.argv[2] ?? 19387);
const PASSWORD = 'e2e-test-password';

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

function req(port, path, { method = 'GET', cookie, redirect } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close' };
    if (cookie) headers.cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        setCookie: res.headers['set-cookie']?.[0] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('timeout')));
    if (method === 'POST') {
      const b = `password=${encodeURIComponent(PASSWORD)}`;
      r.setHeader('content-type', 'application/x-www-form-urlencoded');
      r.setHeader('content-length', Buffer.byteLength(b));
      r.write(b);
    }
    r.end();
  });
}

async function main() {
  // 先确认真实 dsh 活着
  section('前置检查');
  try {
    const probe = await req(dshPort, '/');
    check(`真实 dsh (${dshPort}) 有响应`, probe.status === 401 || probe.status === 200,
      `status=${probe.status}`);
    if (probe.status === 401) {
      console.log('      （401 是 dsh 自己的认证，说明它运行中且未认证 —— 正是要验证的场景）');
    }
  } catch (err) {
    console.error(`  ✗ 连不上 dsh ${dshPort}：${err.message}`);
    console.error('    请先启动 dsh，或用参数指定端口：node e2e-session.mjs <port>');
    process.exitCode = 1;
    return;
  }

  const signer = createSessionSigner({ log: (l, m) => console.log(`      [signer] ${m}`) });
  const sst = signer.status();
  section('代签器状态');
  check('读到了 dsh 的签名密钥', sst.ready === true, JSON.stringify(sst));
  if (!sst.ready) {
    console.error('  → 读不到密钥，后续验证无意义（检查 $DSH_HOME/.credentials.yaml）');
    process.exitCode = 1;
    return;
  }

  const relayPort = await freePort();
  let cfg = normalizeConfig({
    enabled: true, listenHost: '127.0.0.1', listenPort: relayPort,
    targetHost: '127.0.0.1', targetPort: dshPort,
    password: PASSWORD, forceLoopback: false, autoSession: true,
  });
  const relay = createRelay({
    getDshEndpoint: () => ({ host: '127.0.0.1', port: dshPort }),
    getConfig: () => cfg,
    sessionSigner: signer,
    log: () => {},
  });

  section('启动中转');
  const st = await relay.start();
  check('中转运行中', st.state === 'running', st.lastError);
  check('上游目标指向真实 dsh', st.target && st.target.port === dshPort, JSON.stringify(st.target));

  section('第 1 步：未登录时被中转拦下');
  const anon = await req(relayPort, '/');
  check('未带口令 → 看到中转登录页（而非 dsh 的 401）',
    anon.status === 200 && anon.body.includes('dsh-relay 访问口令'),
    `status=${anon.status} body=${anon.body.slice(0, 60)}`);

  section('第 2 步：用中转口令登录');
  const login = await req(relayPort, '/__login', { method: 'POST' });
  check('登录成功（302）', login.status === 302, `status=${login.status}`);
  const cookie = login.setCookie.split(';')[0];
  check('拿到 relay_session', cookie.startsWith('relay_session='), cookie.slice(0, 40));

  section('第 3 步：带中转口令访问 → 应自动进入（核心验证）');
  const authed = await req(relayPort, '/', { cookie });
  check('拿到 dsh 应用页面（HTTP 200）', authed.status === 200, `status=${authed.status}`);
  check('页面包含 __DSH_BOOT__（是真的 dsh 应用，不是错误页）',
    authed.body.includes('__DSH_BOOT__'), `body 前 100 字：${authed.body.slice(0, 100)}`);
  check('没有出现 authentication required',
    !authed.body.includes('authentication required'), '仍被 dsh 拒绝');
  console.log(`      页面长度 ${authed.body.length} 字节`);

  section('第 4 步：反证 —— 关闭 autoSession 应失效');
  cfg = { ...cfg, autoSession: false };
  const off = await req(relayPort, '/', { cookie });
  check('autoSession=false → 不再自动进入（回到 dsh 的 401）',
    off.status === 401 || !off.body.includes('__DSH_BOOT__'),
    `status=${off.status} 含boot=${off.body.includes('__DSH_BOOT__')}`);

  section('第 5 步：反证 —— 口令为空时也不代签');
  cfg = { ...cfg, autoSession: true, password: '' };
  const noPw = await req(relayPort, '/');
  check('口令为空 → 不自动进入（安全硬约束）',
    noPw.status === 401 || !noPw.body.includes('__DSH_BOOT__'),
    `status=${noPw.status} 含boot=${noPw.body.includes('__DSH_BOOT__')}`);

  await relay.stop();

  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`真实端到端验证通过：${passed} 项断言 ✅`);
    console.log('→ 「只输中转口令即可进入 dsh」在真实环境成立。');
    process.exitCode = 0;
    return;
  }
  console.error(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n验证自身异常：', err);
  process.exitCode = 1;
});
