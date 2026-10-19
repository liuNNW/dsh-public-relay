#!/usr/bin/env node
/**
 * audit-status-leak.mjs — 确认 /status 不再回传明文口令
 *
 * 背景：`/dsh-public-relay/status` 会返回给任何能访问中转的客户端，而中转
 * 就暴露在公网。旧实现把整份 config 展开，于是明文口令随一次 GET 泄露。
 * 本脚本对比「写入一个已知口令 → 读回 status」，断言它永不出现。
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../dsh-public-relay/lib/index.js';

const SECRET = 'AUDIT-SECRET-9f3c1b';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-leak-'));
const routes = new Map();
const ctx = {
  profileContext: { dir: home, home: os.tmpdir(), name: 'audit' },
  webServer: {
    host: '127.0.0.1',
    port: 19998,
    register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path); },
  },
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const c = fn(); return () => { if (typeof c === 'function') c(); }; },
  get() { return undefined; },
};

apply(ctx, { enabled: false, password: SECRET });

const handler = routes.get('/dsh-public-relay');
const srv = http.createServer((req, res) => { void handler(req, res); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

function call(method, route, body = null) {
  return new Promise((resolve) => {
    const payload = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { connection: 'close' };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length; }
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ' + (detail || '')}`);
};

console.log('口令泄露检查\n');

const st = await call('GET', '/dsh-public-relay/status');
check('GET /status 不含明文口令', !st.body.includes(SECRET), st.body.slice(0, 200));
const parsed = JSON.parse(st.body);
check('config 里没有 password 字段', parsed.config !== undefined && !Object.hasOwn(parsed.config, 'password'));
check('defaults 里没有 password 字段', !Object.hasOwn(parsed.defaults || {}, 'password'));
check('提供 hasPassword 布尔值', parsed.hasPassword === true, String(parsed.hasPassword));
check('overrides 里没有 password', !Object.hasOwn(parsed.overrides || {}, 'password'));

// POST /status 也应同样脱敏
const stp = await call('POST', '/dsh-public-relay/status', {});
check('POST /status 不含明文口令', !stp.body.includes(SECRET));

// 配置写入：不带 password 字段 = 保持原口令
const save1 = await call('POST', '/dsh-public-relay/config', { config: { listenPort: 3092 } });
const parsed1 = JSON.parse(save1.body);
check('不带 password 保存后仍有口令', parsed1.status.hasPassword === true, String(parsed1.status.hasPassword));

// 带 password 字段 = 覆盖
const save2 = await call('POST', '/dsh-public-relay/config', { config: { password: 'NEW-PW-xyz' } });
check('带 password 保存后口令仍存在', JSON.parse(save2.body).status.hasPassword === true);
check('覆盖后旧口令不泄露', !save2.body.includes(SECRET));

// 显式清空
const save3 = await call('POST', '/dsh-public-relay/config', { config: { password: '' } });
check('显式传空串 = 清除口令', JSON.parse(save3.body).status.hasPassword === false);

// 落盘文件里确实有口令（这是设计），但 API 不返回。
// 注意：上一步已显式清空口令，所以这里重新设一个再检查。
const save4 = await call('POST', '/dsh-public-relay/config', { config: { password: 'ON-DISK-pw' } });
const cfgFile = path.join(home, 'dsh-public-relay.json');
const onDisk = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
check('配置文件仍保存口令（服务端需要它）', onDisk.includes('ON-DISK-pw'), onDisk.slice(0, 120));
check('但响应体里没有它', !save4.body.includes('ON-DISK-pw'));

await new Promise((r) => srv.close(r));
fs.rmSync(home, { recursive: true, force: true });

console.log('');
console.log(bad === 0 ? '口令不再通过网络接口泄露 ✅' : `有 ${bad} 项失败 ❌`);
process.exitCode = bad === 0 ? 0 : 1;
