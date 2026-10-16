#!/usr/bin/env node
/**
 * dsh-session.spec.mjs — dsh 会话代签的单元与集成测试
 *
 * 覆盖：
 *   · Cookie 编码/解码往返（复刻 dsh 的严格 decodeBase64Url）
 *   · Cookie 名与 authority 的绑定
 *   · payload 校验边界（version / 缺字段 / 时间区间）
 *   · 密钥解析（含错误缩进、缺失、非法长度）
 *   · checkout 的三条路径：无 cookie→注入；有效 cookie→不覆盖；换 authority→重签
 *   · 中转集成：注入后上游收到正确的 Cookie 头；已有有效 cookie 不被动
 *   · 安全约束：口令为空时**不**代签
 *
 * 全程使用**合成密钥**，绝不读写真实凭据。
 *
 * 运行：node plugin/tests/dsh-session.spec.mjs
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSessionSigner, parseSecretFromCredentials, cookieNameFor,
  encodeCookie, decodeCookie, decodeBase64Url, encodeBase64Url, readCookieValue,
} from '../dsh-relay/lib/dsh-cookie.js';
import { createRelay } from '../dsh-relay/lib/relay.js';
import { normalizeConfig } from '../dsh-relay/lib/config.js';

/* ── 测试骨架 ── */
const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.error(`\n[test] 超时 ${WATCHDOG_MS / 1000}s，判定失败`);
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

/** 生成一个合成密钥（32 字节）并写出一个最小的 credentials 文件。 */
function writeFakeCredentials(secret) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cookie-spec-'));
  const file = path.join(dir, '.credentials.yaml');
  const text = [
    'version: 1',
    'refs: {}',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${encodeBase64Url(secret)}`,
    '  deepseek-account-platform/device:',
    '    kind: grant',
    '    payload:',
    `      id: ${crypto.randomUUID()}`,
    '',
  ].join('\n');
  fs.writeFileSync(file, text, 'utf8');
  return { dir, file, text };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ═══════════════════════════ 主流程 ═══════════════════════════

async function main() {
  const SECRET = crypto.randomBytes(32);
  const AUTHORITY = '127.0.0.1:19387';

  section('base64url 编解码（复刻 dsh 的严格实现）');
  {
    const buf = crypto.randomBytes(32);
    const enc = encodeBase64Url(buf);
    check('编码结果无 = 填充', !enc.includes('='), enc);
    check('解码可还原', Buffer.compare(decodeBase64Url(enc), buf) === 0, enc);
    check('拒绝非法字符', decodeBase64Url('abc$def') === undefined, 'accepted invalid');
    check('拒绝 length % 4 === 1', decodeBase64Url('abcde') === undefined, 'accepted invalid length');
    check('空串可解码为空 Buffer', decodeBase64Url('') !== undefined, 'rejected empty');
  }

  section('Cookie 编解码往返');
  {
    const now = Date.now();
    const payload = { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86400000 };
    const value = encodeCookie(payload, SECRET);
    check('格式为 v1.<body>.<sig>', value.split('.').length === 3 && value.startsWith('v1.'), value.slice(0, 40));
    const back = decodeCookie(value, SECRET);
    check('往返一致', back && back.authority === AUTHORITY && back.issuedAt === now && back.expiresAt === payload.expiresAt,
      JSON.stringify(back));

    // 换密钥必须解不开
    check('换密钥解不开', decodeCookie(value, crypto.randomBytes(32)) === undefined, 'accepted wrong secret');

    // 篡改 body 必须被发现
    const parts = value.split('.');
    const tamperedBody = encodeBase64Url(Buffer.from(JSON.stringify({ ...payload, authority: 'evil.example.com' }), 'utf8'));
    check('篡改 authority 后签名不符',
      decodeCookie(`v1.${tamperedBody}.${parts[2]}`, SECRET) === undefined, 'accepted tampered body');

    // payload 边界
    const mk = (p) => encodeCookie(p, SECRET);
    check('version 非 1 被拒',
      decodeCookie(mk({ ...payload, version: 2 }), SECRET) === undefined, 'accepted');
    check('缺 authority 被拒',
      decodeCookie(mk({ version: 1, issuedAt: now, expiresAt: now + 1 }), SECRET) === undefined, 'accepted');
    check('issuedAt 非整数被拒',
      decodeCookie(mk({ ...payload, issuedAt: 1.5 }), SECRET) === undefined, 'accepted');
    check('expiresAt 非整数被拒',
      decodeCookie(mk({ ...payload, expiresAt: 'x' }), SECRET) === undefined, 'accepted');
  }

  section('Cookie 名绑定 authority');
  {
    const a = cookieNameFor('127.0.0.1:19387');
    const b = cookieNameFor('example.com:3091');
    check('前缀正确', a.startsWith('dsh-auth-'), a);
    check('不同 authority → 不同名字', a !== b, `${a} vs ${b}`);
    check('同名 authority → 稳定', a === cookieNameFor('127.0.0.1:19387'), 'unstable');
    check('无 = 填充', !a.includes('='), a);
  }

  section('readCookieValue');
  {
    check('能从多 cookie 里取出', readCookieValue('a=1; dsh-auth-x=y; b=2', 'dsh-auth-x') === 'y', 'failed');
    check('不存在返回 undefined', readCookieValue('a=1', 'nope') === undefined, 'failed');
    check('非字符串返回 undefined', readCookieValue(undefined, 'a') === undefined, 'failed');
  }

  section('密钥解析');
  {
    const { text } = writeFakeCredentials(SECRET);
    const parsed = parseSecretFromCredentials(text);
    check('从正常文件解析到 32 字节', parsed && parsed.byteLength === 32, parsed && parsed.byteLength);
    check('解析出的密钥正确', parsed && Buffer.compare(parsed, SECRET) === 0, 'mismatch');

    check('空文本 → null', parseSecretFromCredentials('') === null, 'failed');
    check('无该记录 → null', parseSecretFromCredentials('records:\n  other/x:\n    kind: grant\n') === null, 'failed');
    check(
      '密钥长度不对 → null',
      parseSecretFromCredentials(`records:\n  client-connection/browser-session:\n    payload:\n      secret: ${encodeBase64Url(crypto.randomBytes(16))}\n`) === null,
      'accepted short secret',
    );
    // 关键：必须停在 request 块内，不能抓到别的 record 的 secret
    check(
      '不误取其它 record 的 secret',
      parseSecretFromCredentials(`records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n  other/thing:\n    payload:\n      secret: ${encodeBase64Url(SECRET)}\n`) === null,
      'leaked into next record',
    );
  }

  section('checkout 三条路径');
  {
    const { file } = writeFakeCredentials(SECRET);
    const signer = createSessionSigner({ credentialsFile: file });
    check('status 首次即 ready', signer.status().ready === true, JSON.stringify(signer.status()));

    const first = signer.checkout(AUTHORITY, undefined);
    check('无 cookie → 注入', first.injected === true, first.reason);
    check('注入的名字正确', first.name === cookieNameFor(AUTHORITY), first.name);
    const val = readCookieValue(first.cookieHeader, first.name);
    const decoded = decodeCookie(val, SECRET);
    check('注入的 cookie 可被解出且 authority 正确',
      decoded && decoded.authority === AUTHORITY, JSON.stringify(decoded));

    const second = signer.checkout(AUTHORITY, first.cookieHeader);
    check('已有有效 cookie → 不覆盖', second.injected === false && second.reason === 'already-valid', second.reason);
    check('不覆盖时头原样', second.cookieHeader === first.cookieHeader, 'changed');

    const other = signer.checkout('example.com:3091', first.cookieHeader);
    check('换 authority → 重新签名', other.injected === true, other.reason);
    check('原有 cookie 被保留在同一头里',
      other.cookieHeader.includes(first.name + '='), other.cookieHeader.slice(0, 80));

    // 密钥文件被删 → 保留旧密钥（不该突然失效）
    fs.rmSync(file);
    const stillOk = signer.checkout(AUTHORITY, undefined);
    check('密钥文件消失后仍能用缓存密钥', stillOk.injected === true, stillOk.reason);
  }

  section('配置归一化：autoSession 的安全约束');
  {
    const withPw = normalizeConfig({ password: 'pw', autoSession: true });
    check('有口令 → autoSession 生效', withPw.autoSession === true, String(withPw.autoSession));
    check('未被标记 blocked', withPw.autoSessionBlocked === false, String(withPw.autoSessionBlocked));
    check('原意与生效值一致（有口令时）', withPw.autoSessionWanted === true, String(withPw.autoSessionWanted));

    const noPw = normalizeConfig({ password: '', autoSession: true });
    check('口令为空 → autoSession 被强制关闭', noPw.autoSession === false, String(noPw.autoSession));
    check('标记 blockedByEmptyPassword', noPw.autoSessionBlocked === true, String(noPw.autoSessionBlocked));
    // 这一条是 UI 开关正确性的地基：原意必须保留 true。
    // 若 UI 拿生效值渲染开关，口令为空时用户会看到「关」，随手一保存就把自己的
    // 开关真的关掉了，填回口令也不会自动恢复。
    check('口令为空时仍保留用户原意（供 UI 渲染开关）',
      noPw.autoSessionWanted === true, String(noPw.autoSessionWanted));

    const off = normalizeConfig({ password: 'pw', autoSession: false });
    check('用户显式关闭 → 保持关闭', off.autoSession === false && off.autoSessionBlocked === false, JSON.stringify(off));
    check('显式关闭时原意也是关', off.autoSessionWanted === false, String(off.autoSessionWanted));

    // 缺省（完全没写这一项）应视为开启
    const dflt = normalizeConfig({ password: 'pw' });
    check('缺省视为开启', dflt.autoSession === true && dflt.autoSessionWanted === true, JSON.stringify(dflt));
  }

  section('中转集成：Cookie 注入与安全约束');
  {
    /** 记录上游收到的头。 */
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ url: req.url, cookie: req.headers.cookie, host: req.headers.host });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const { file } = writeFakeCredentials(SECRET);
    const signer = createSessionSigner({ credentialsFile: file });
    const relayPort = await freePort();

    let cfg = normalizeConfig({
      enabled: true, listenHost: '127.0.0.1', listenPort: relayPort,
      targetHost: '127.0.0.1', targetPort: upPort,
      password: 'pw', forceLoopback: false, autoSession: true,
    });
    const relay = createRelay({
      getDshEndpoint: () => ({ host: '127.0.0.1', port: upPort }),
      getConfig: () => cfg,
      sessionSigner: signer,
      log: () => {},
    });
    const st = await relay.start();
    check('中转启动', st.state === 'running', st.lastError);

    /** 走一遍中转自己的口令认证，拿到它的会话 cookie。 */
    const login = await new Promise((resolve, reject) => {
      const body = 'password=pw';
      const req = http.request({
        host: '127.0.0.1', port: relayPort, method: 'POST', path: '/__login',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), connection: 'close' },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie']?.[0] || '' }));
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
    const relayCookie = login.setCookie.split(';')[0];

    const get = (path, headers) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: relayPort, method: 'GET', path,
        headers: { connection: 'close', ...(headers || {}) }, agent: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });

    seen.length = 0;
    const r1 = await get('/api/ping', { cookie: relayCookie });
    check('经中转的请求成功', r1.status === 200, `got ${r1.status}`);
    const up1 = seen.pop();
    check('上游收到了 dsh 会话 cookie（自动注入）',
      typeof up1.cookie === 'string' && up1.cookie.includes(cookieNameFor(`127.0.0.1:${upPort}`)),
      String(up1.cookie).slice(0, 120));
    check('注入的 cookie 能被解出且 authority == 改写后的 Host',
      decodeCookie(readCookieValue(up1.cookie, cookieNameFor(`127.0.0.1:${upPort}`)), SECRET)?.authority === `127.0.0.1:${upPort}`,
      `host=${up1.host}`);
    check('上游看到的 Host 是回环权威', up1.host === `127.0.0.1:${upPort}`, up1.host);

    // 关闭 autoSession → 不应注入 dsh 会话 cookie。
    // 注意：请求仍会带中转自己的 relay_session（那是中转认证用的），
    // 所以这里只断言「没有 dsh-auth- 前缀的 cookie」。
    cfg = { ...cfg, autoSession: false };
    seen.length = 0;
    await get('/api/ping', { cookie: relayCookie });
    const up2 = seen.pop();
    check('autoSession=false → 不注入 dsh 会话 cookie',
      !String(up2.cookie || '').includes('dsh-auth-'),
      String(up2.cookie).slice(0, 120));
    check('autoSession=false 时中转自身 cookie 照常透传',
      String(up2.cookie || '').includes('relay_session='),
      String(up2.cookie).slice(0, 120));

    // 口令为空 → 即使 autoSession=true 也不注入（硬约束）
    cfg = { ...cfg, autoSession: true, password: '' };
    seen.length = 0;
    await get('/api/ping', {});   // 无口令时中转不要求登录
    const up3 = seen.pop();
    check('口令为空 → 不注入（安全硬约束）',
      !String(up3.cookie || '').includes('dsh-auth-'), String(up3.cookie).slice(0, 120));

    await relay.stop();
    await new Promise((r) => upstream.close(r));
  }

  console.log(`\n${'═'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`dsh 会话代签测试全部通过：${passed} 项断言 ✅`);
    process.exitCode = 0;
    return;
  }
  console.error(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n测试自身异常：', err);
  process.exitCode = 1;
});
