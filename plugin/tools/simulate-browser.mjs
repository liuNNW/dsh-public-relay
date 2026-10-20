/**
 * simulate-browser.mjs — 完整模拟浏览器经隧道访问 dsh 的流程
 *
 * 为什么需要：服务器端已逐项验证正常（首页 200、4 个 bundle 全 200、
 * patch 生效、/api ok:true），但用户浏览器仍报 dsh 的 401。
 * 必须复现「浏览器真实行为」才能定位差异 —— 尤其是 cookie 的存取。
 *
 * 本脚本严格按浏览器的规则处理 cookie：
 *   · 按 Secure 属性决定是否在 https 下回传
 *   · 按 Domain/Path 匹配
 *   · 处理 302 跳转链
 *   · 带上浏览器会带的请求头（Accept / Sec-Fetch-*）
 *
 * 用法：
 *   node plugin\tools\simulate-browser.mjs https://frp-dad.com:16689 20040915
 */
'use strict';

import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const base = process.argv[2] || 'https://frp-dad.com:16689';
const password = process.argv[3] || '20040915';

/** 简易 cookie 罐，遵循浏览器的 Secure / Domain / Path 规则。 */
class CookieJar {
  constructor() { this.items = []; }

  /** 从 Set-Cookie 头吸收。 */
  absorb(setCookieList, requestUrl) {
    for (const raw of setCookieList || []) {
      const parts = raw.split(';').map((s) => s.trim());
      const [pair, ...attrs] = parts;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const cookie = { name, value, domain: requestUrl.hostname, path: '/', secure: false, httpOnly: false };
      for (const a of attrs) {
        const low = a.toLowerCase();
        if (low === 'secure') cookie.secure = true;
        else if (low === 'httponly') cookie.httpOnly = true;
        else if (low.startsWith('path=')) cookie.path = a.slice(5);
        else if (low.startsWith('domain=')) cookie.domain = a.slice(7).replace(/^\./, '');
      }
      // 同名同域同路径覆盖
      this.items = this.items.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
      this.items.push(cookie);
    }
  }

  /** 生成某个 URL 应带的 Cookie 头（浏览器的过滤规则）。 */
  header(requestUrl) {
    const isHttps = requestUrl.protocol === 'https:';
    const applicable = this.items.filter((c) => {
      if (c.secure && !isHttps) return false;              // Secure 只走 https
      const host = requestUrl.hostname;
      if (!(host === c.domain || host.endsWith(`.${c.domain}`))) return false;
      return requestUrl.pathname.startsWith(c.path);
    });
    return applicable.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  describe() {
    return this.items.map((c) => `${c.name}${c.secure ? ' [Secure]' : ''}${c.httpOnly ? ' [HttpOnly]' : ''} domain=${c.domain} path=${c.path}`);
  }
}

/** 发一次请求，返回 { status, headers, body, url }。 */
function fetchOnce(target, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body === null ? null : Buffer.from(body);
    const h = { ...headers };
    if (payload) h['content-length'] = payload.length;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method,
      headers: h,
      rejectUnauthorized: false,   // 用户已点过「继续前往」，等价于此
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        url: target,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 跟着重定向走，最多 maxHops 次，持续维护 cookie。 */
async function follow(startUrl, jar, { maxHops = 8, headers = {} } = {}) {
  let url = startUrl;
  const chain = [];
  for (let i = 0; i < maxHops; i += 1) {
    const cookie = jar.header(new URL(url));
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    const res = await fetchOnce(url, { headers: h });
    jar.absorb(res.headers['set-cookie'], new URL(url));
    chain.push({ url, status: res.status, location: res.headers.location || null });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      url = new URL(res.headers.location, url).href;
      continue;
    }
    return { res, chain, finalUrl: url };
  }
  return { res: null, chain, finalUrl: url };
}

const jar = new CookieJar();
const origin = new URL(base);

console.log(`[simulate-browser] 目标：${base}\n`);

// ── 步骤 1：直接访问首页（模拟「输入域名进来」）──
console.log('── 步骤 1：输入域名访问 / ──');
{
  const { res, chain, finalUrl } = await follow(base, jar, {
    headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
  });
  for (const c of chain) console.log(`   ${c.status}  ${c.url}${c.location ? ` → ${c.location}` : ''}`);
  const text = res ? res.body.toString() : '';
  const kind = text.includes('dsh-public-relay') ? '中转登录页'
    : text.includes('authentication required') ? 'dsh 401'
      : text.includes('DeepSeek Harness') ? 'dsh 界面'
        : '(未知)';
  console.log(`   结果：${kind}  (${res ? res.status : '?'}, ${text.length} B)`);
  console.log(`   最终 URL：${finalUrl}`);
  console.log(`   拿到 cookie：${jar.describe().join(' | ') || '(无)'}`);
}
console.log('');

// ── 步骤 2：登录 ──
console.log('── 步骤 2：提交口令登录 ──');
{
  const body = `password=${encodeURIComponent(password)}`;
  const loginUrl = new URL('/__login', base).href;
  const cookie = jar.header(new URL(loginUrl));
  const res = await fetchOnce(loginUrl, {
    method: 'POST',
    headers: {
      accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
  jar.absorb(res.headers['set-cookie'], new URL(loginUrl));
  console.log(`   ${res.status}  ${loginUrl}`);
  console.log(`   Set-Cookie: ${(res.headers['set-cookie'] || []).join(' | ') || '(无)'}`);
  console.log('');
  console.log(`   cookie 罐：`);
  for (const d of jar.describe()) console.log(`     · ${d}`);
}
console.log('');

// ── 步骤 3：重定向后访问首页 ──
console.log('── 步骤 3：登录后访问 / ──');
{
  const { res, chain, finalUrl } = await follow(base, jar, {
    headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
  });
  for (const c of chain) console.log(`   ${c.status}  ${c.url}${c.location ? ` → ${c.location}` : ''}`);
  const text = res ? res.body.toString() : '';
  /*
   * 判定顺序很重要：**先看 dsh 界面的特征**。
   *
   * 不能先判 `includes('dsh-public-relay')` —— dsh 界面本身会包含这个字样
   * （插件把自己的 client.js 注入了 boot graph），那样会把正常的 dsh 界面
   * 误判成登录页。真正的登录页特征是 `<title>dsh-public-relay 登录</title>`
   * 且体积约 1.2 KB；dsh 界面则约 42 KB。
   */
  const kind = text.includes('authentication required') ? 'dsh 401 ❌'
    : /<title>dsh-public-relay\s*登录<\/title>/.test(text) ? '中转登录页 ❌'
      : text.includes('DeepSeek Harness') ? 'dsh 界面 ✅'
        : '(未知)';
  console.log(`   结果：${kind}  (${res ? res.status : '?'}, ${text.length} B)`);
  if (res && res.status !== 200) console.log(`   正文：${text.slice(0, 150)}`);
}
console.log('');

// ── 步骤 4：调用 /api ──
console.log('── 步骤 4：调用 /api/session/modelCatalog ──');
{
  const apiUrl = new URL('/api/session/modelCatalog', base).href;
  const cookie = jar.header(new URL(apiUrl));
  const res = await fetchOnce(apiUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'sim-1', method: 'session/modelCatalog', payload: { args: {} },
    }),
  });
  const text = res.body.toString();
  const ok = text.includes('"ok":true');
  console.log(`   ${res.status}  ${apiUrl}`);
  console.log(`   发送的 Cookie：${cookie || '(无)'}`);
  console.log(`   结果：${ok ? '✅ ok:true' : `❌ ${text.slice(0, 150)}`}`);
}
