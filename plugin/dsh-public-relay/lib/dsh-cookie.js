/**
 * dsh-cookie.js — 按 dsh 的会话 Cookie 格式代签浏览器会话
 *
 * ── 为什么需要它 ──
 *
 * dsh 的浏览器认证是**一次性 token 交换**：进程启动时生成一个随机 launchToken，
 * 打印/打开 `http://<authority>/?token=XXX`，只在 `GET /` 接受该 token 并换出
 * `dsh-auth-*` 签名 Cookie，之后所有请求都要求这个 Cookie。
 *
 * 用户经中转（隧道）访问时，那个 `?token=` URL 很难拿到、且每个进程只用一次 ——
 * 于是这里直接**按 dsh 的格式代签一个 Cookie**，让用户只输中转口令就能进入。
 *
 * ── dsh 的格式（从 dsh-client-connection 的实现中复刻）──
 *
 *   Cookie 名 = 'dsh-auth-' + base64url(sha256(authority))
 *   Cookie 值 = 'v1.' + base64url(json(payload)) + '.' + base64url(hmacSha256(secret, body))
 *   payload   = { version: 1, authority, issuedAt, expiresAt }   // 只这四个字段
 *
 *   校验只有三条：签名对、payload.authority === 本次请求的 Host、时间区间有效。
 *
 * ── 密钥来源与安全前提 ──
 *
 * 密钥是 `$DSH_HOME/.credentials.yaml` 里 `client-connection/browser-session` 记录的
 * `payload.secret`（32 字节 base64url）。它首次创建后**持久不变**（dsh 源码称之为
 * durable signing secret），所以读文件即可，不必 hook 进程。
 *
 * 这意味着：**任何能读该文件的进程本来就能伪造 dsh 会话**，本模块没有引入新的
 * 越权面。但「自动进入」把门槛降到了中转口令这一个点，因此：
 *   · 口令为空时必须禁用（由调用方保证，见 index.js 的配置归一化）
 *   · 读不到密钥、签不出来时**不注入**，退回需要 `?token=` 的现状（不让失败变成进不去）
 */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Cookie 前缀（与 dsh 的 COOKIE_PREFIX 一致）。 */
const COOKIE_PREFIX = 'dsh-auth-';

/** payload 版本（与 dsh 的 COOKIE_PAYLOAD_VERSION 一致）。 */
const COOKIE_PAYLOAD_VERSION = 1;

/** 密钥字节数（与 dsh 的 SECRET_BYTES 一致）。 */
const SECRET_BYTES = 32;

/** Cookie 有效期，与 dsh 的 cookieMaxAgeDays 默认值一致（30 天）。 */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 复查密钥文件的时间间隔（dsh 重建记录时能自动跟上）。 */
const SECRET_RECHECK_MS = 30 * 1000;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** 与 dsh 的 encodeBase64Url 等价（去掉尾部的 = 填充）。 */
export function encodeBase64Url(value) {
  let s = Buffer.from(value).toString('base64').split('+').join('-').split('/').join('_');
  while (s.endsWith('=')) s = s.slice(0, -1);
  return s;
}

/**
 * 与 dsh 的 decodeBase64Url 等价。
 *
 * 它比普通 base64 解码严格：会用「重编码结果是否等于原文」来拒绝非规范输入。
 * 复刻这一行为，避免我们把 dsh 不会接受的字符串当成合法密钥。
 *
 * @returns 解码后的 Buffer，或 undefined（格式不合法）。
 */
export function decodeBase64Url(value) {
  if (typeof value !== 'string') return undefined;
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(
    value.split('-').join('+').split('_').join('/') + padding,
    'base64',
  );
  // 重编码校验：非规范输入（例如含非法字符被忽略）会被这里挡下
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

/** Cookie 名：authority 的 sha256（与 dsh 的 cookieName 一致）。 */
export function cookieNameFor(authority) {
  return COOKIE_PREFIX + encodeBase64Url(crypto.createHash('sha256').update(authority).digest());
}

/** 签名：HMAC-SHA256(secret, body)，body 是 payload 的 base64url 文本。 */
function signatureOf(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest();
}

/**
 * 按 dsh 的格式编一个 Cookie 值。
 * @param payload - `{ version, authority, issuedAt, expiresAt }`
 * @param secret  - 32 字节密钥
 */
export function encodeCookie(payload, secret) {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `v1.${body}.${encodeBase64Url(signatureOf(secret, body))}`;
}

/**
 * 解码并校验一个 Cookie 值（复刻 dsh 的 decodeCookie），用于自检与"识别已有 cookie"。
 * @returns payload 对象，或 undefined。
 */
export function decodeCookie(value, secret) {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('.');
  const [version, body, encodedSignature] = parts;
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined;
  }
  const actual = decodeBase64Url(encodedSignature);
  if (actual === undefined) return undefined;
  const expected = signatureOf(secret, body);
  if (actual.byteLength !== expected.byteLength) return undefined;
  if (!crypto.timingSafeEqual(actual, expected)) return undefined;

  const bodyBytes = decodeBase64Url(body);
  if (bodyBytes === undefined) return undefined;
  let decoded;
  try {
    decoded = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)
  ) {
    return undefined;
  }
  return decoded;
}

/** 从 `Cookie:` 头里取指定名字的值（与 dsh 的 cookieValue 一致）。 */
export function readCookieValue(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/** credentials 文件路径（$DSH_HOME/.credentials.yaml）。 */
export function credentialsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/**
 * 从 credentials 文本里取出 browser-session 的密钥。
 *
 * 不引入 YAML 依赖：只需要在 `client-connection/browser-session:` 这个块内找到
 * `secret:`。缩进以「同级下一个条目」为界，避免误取别的 record 里的同名键。
 *
 * @param text - .credentials.yaml 的内容。
 * @returns 32 字节密钥，或 null（未找到 / 格式非法）。
 */
export function parseSecretFromCredentials(text) {
  if (typeof text !== 'string' || text === '') return null;
  const lines = text.split(/\r?\n/);
  const blockRe = /^\s{2}client-connection\/browser-session:\s*$/;
  let inBlock = false;
  for (const line of lines) {
    if (blockRe.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    // 退回到同级（两个空格缩进的另一个 record）就结束
    if (/^\s{0,2}\S/.test(line) && line.trim() !== '') break;
    const m = /^\s+secret:\s*(.+?)\s*$/.exec(line);
    if (m) {
      const raw = m[1].replace(/^["']|["']$/g, '');
      const buf = decodeBase64Url(raw);
      if (buf === undefined || buf.byteLength !== SECRET_BYTES) return null;
      return buf;
    }
  }
  return null;
}

/**
 * 建一个「dsh 会话代签器」。
 *
 * @param options.log          - (level, message) => void
 * @param options.maxAgeMs     - Cookie 有效期，默认 30 天（与 dsh 一致）
 * @param options.credentialsFile - 覆盖凭据文件路径（测试用）
 * @returns { status, refresh, checkout }
 */
export function createSessionSigner(options = {}) {
  const {
    log = () => {},
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    credentialsFile = credentialsPath(),
  } = options;

  /** @type {Buffer|null} */
  let secret = null;
  let loadedAt = 0;
  let lastError = null;
  let lastMtimeMs = 0;

  /**
   * 读/刷新密钥。带 mtime 检查，避免每个请求都碰磁盘。
   * @param force - 忽略 mtime 直接重读。
   * @returns 当前是否持有可用密钥。
   */
  function refresh(force = false) {
    const now = Date.now();
    if (!force && secret !== null && now - loadedAt < SECRET_RECHECK_MS) return true;
    try {
      const st = fs.statSync(credentialsFile);
      // 未变更就不重读（但首次仍需读一次）
      if (!force && secret !== null && st.mtimeMs === lastMtimeMs) {
        loadedAt = now;
        return true;
      }
      const text = fs.readFileSync(credentialsFile, 'utf8');
      const parsed = parseSecretFromCredentials(text);
      if (parsed === null) {
        lastError = 'credentials 里没有可用的 browser-session 密钥';
        log('warn', `[dsh-cookie] ${lastError}（路径 ${credentialsFile}）`);
        // 保留旧密钥：文件被临时截断时不该立刻失效
        loadedAt = now;
        return secret !== null;
      }
      secret = parsed;
      lastMtimeMs = st.mtimeMs;
      loadedAt = now;
      lastError = null;
      return true;
    } catch (err) {
      const code = err?.code || '';
      lastError = code === 'ENOENT'
        ? 'credentials 文件不存在'
        : `读取凭据失败：${err?.message || err}`;
      log('warn', `[dsh-cookie] ${lastError}`);
      loadedAt = now;
      return secret !== null;
    }
  }

  /** 状态快照，供 UI/诊断显示。会按需触发一次加载，避免首次调用误报 ready:false。 */
  function status() {
    // 没用过就先尝试加载一次：否则 UI 上会短暂显示「未就绪」，
    // 让人误以为密钥读不到。
    if (secret === null) refresh();
    return {
      ready: secret !== null,
      hasSecret: secret !== null,
      lastError,
      credentialsFile,
      maxAgeMs,
    };
  }

  /** 浏览器已带的一个 cookie 是否仍被 dsh 认可（避免重复注入）。 */
  function isValidFor(authority, value) {
    if (secret === null) return false;
    const payload = decodeCookie(value, secret);
    if (payload === undefined) return false;
    const now = Date.now();
    return payload.authority === authority
      && payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= maxAgeMs;
  }

  /**
   * 为一次转发准备 Cookie。
   *
   * @param authority    - 本次转发用的权威（必须与转发时改写的 Host 一致）
   * @param existingCookieHeader - 浏览器带来的 Cookie 头（可为 undefined）
   * @returns `{ cookieHeader, name, injected, reason }`
   *   · injected=true  → cookieHeader 是「原有内容 + 新签的」合并结果
   *   · injected=false → cookieHeader 原样返回（已有可用 cookie，或签不出来）
   */
  function checkout(authority, existingCookieHeader) {
    if (!refresh()) {
      return { cookieHeader: existingCookieHeader, name: null, injected: false, reason: lastError || 'no-secret' };
    }
    const name = cookieNameFor(authority);
    const existing = readCookieValue(existingCookieHeader, name);
    if (existing !== undefined && isValidFor(authority, existing)) {
      return { cookieHeader: existingCookieHeader, name, injected: false, reason: 'already-valid' };
    }

    const now = Date.now();
    let value;
    try {
      value = encodeCookie({
        version: COOKIE_PAYLOAD_VERSION,
        authority,
        issuedAt: now,
        expiresAt: now + maxAgeMs,
      }, secret);
    } catch (err) {
      return { cookieHeader: existingCookieHeader, name, injected: false, reason: `encode-failed: ${err?.message || err}` };
    }

    // 合并：去掉同名旧值，附上新的
    const kept = typeof existingCookieHeader === 'string'
      ? existingCookieHeader.split(';')
        .map((s) => s.trim())
        .filter((s) => s !== '' && s.slice(0, s.indexOf('=')).trim() !== name)
        .join('; ')
      : '';
    const cookieHeader = kept === '' ? `${name}=${value}` : `${kept}; ${name}=${value}`;
    return { cookieHeader, name, injected: true, reason: 'injected' };
  }

  return { status, refresh, checkout };
}
