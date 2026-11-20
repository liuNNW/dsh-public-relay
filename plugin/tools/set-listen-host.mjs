/**
 * set-listen-host.mjs — 把中转监听地址改成指定值（默认 0.0.0.0）
 *
 * 为什么需要：`listenHost: "127.0.0.1"` 只绑回环，手机/局域网设备连不上。
 * 改成 0.0.0.0 才会在所有网卡（含 192.168.x.x）上监听。
 *
 * 走插件自己的 /config 路由，所以会**同时**落盘 JSON 并让中转按新地址重启，
 * 而不是只改文件（改了文件不重启是不生效的）。
 *
 * 鉴权：用配置文件里的口令派生 bearer（0.3.4 之前的管理路由必须带它；
 * 0.3.4 起桌面 Origin 已豁免，带上也无害）。
 *
 * 用法：node plugin/tools/set-listen-host.mjs [host]
 */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DSH = 19387;
const HOST_HEADER = `127.0.0.1:${DSH}`;
const NEW_HOST = process.argv[2] || '0.0.0.0';
const CFG = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'dsh-public-relay.json');

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
console.log(`当前 listenHost = ${cfg.listenHost}  → 目标 = ${NEW_HOST}`);
if (!cfg.password) {
  console.log('⚠ 口令为空：监听 0.0.0.0 时，任何能连到该端口的人都能直接进入。');
}

/** 由口令派生管理 token（与 lib/auth.js 的 makeAuth 一致）。 */
function adminToken(password) {
  const secret = crypto.createHmac('sha256', 'dsh-public-relay').update(password).digest();
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function post(pathname, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const headers = {
      host: HOST_HEADER,
      origin: 'dsh-app://app',
      'content-type': 'application/json',
      'content-length': payload.length,
    };
    if (cfg.password) headers.authorization = `Bearer ${adminToken(cfg.password)}`;
    const q = http.request({ host: '127.0.0.1', port: DSH, path: pathname, method: 'POST', headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    q.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    q.end(payload);
  });
}

const res = await post('/dsh-public-relay/config', { config: { listenHost: NEW_HOST } });
console.log(`\n/config → HTTP ${res.status}`);
if (res.status !== 200) {
  console.log(`  失败：${res.body.slice(0, 300)}`);
  process.exit(1);
}

const json = JSON.parse(res.body);
console.log(`  ok=${json.ok}  persisted=${json.persisted}`);
console.log(`  生效的 listen = ${JSON.stringify(json.status && json.status.listen)}`);
console.log(`  状态 = ${json.status && json.status.state}`);

// 落盘再确认一次
const after = JSON.parse(fs.readFileSync(CFG, 'utf8'));
console.log(`  配置文件 listenHost = ${after.listenHost}`);
