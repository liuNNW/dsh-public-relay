/**
 * probe-launch-token.mjs — 探测「中转能否从插件上下文取到 dsh 的 launchToken」
 *
 * 背景：dsh 的 /api 认证要求 **version 2** 的 Cookie（见 authenticateApi 的
 * `payload?.version === 2`），而 v2 只能由 `GET /connect?token=<launchToken>`
 * 交换得到。launchToken 是 BrowserAuth 实例的属性，中转是跑在同一进程里的插件，
 * 因此有可能直接取到 —— 但这条路是否可行取决于 dsh 把 connection 服务暴露成
 * 什么样。本脚本就是去**实测**这一点，而不是猜。
 *
 * 用法（在 dsh 进程内由插件调用，或作为子进程探测）：
 *   node plugin/tools/probe-launch-token.mjs
 *
 * 注意：本脚本只做探测与报告，**不打印 token 原值**（只打印长度与前 4 位指纹），
 * 避免把一次性凭据落到终端历史或日志里。
 */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 只给可核对的指纹，不给原值。 */
function fingerprint(value) {
  if (typeof value !== 'string' || value === '') return null;
  return { length: value.length, head: `${value.slice(0, 4)}…` };
}

/** dsh 可能存放「服务名 → 服务实例」的地方，逐层尝试。 */
const SERVICE_KEYS = ['connection'];

/**
 * 从一个 context 对象的各个可能位置取 connection 服务。
 * @returns {{ found: boolean, how: string|null, service: any }}
 */
function findConnectionService(ctx) {
  if (!ctx || typeof ctx !== 'object') return { found: false, how: null, service: null };

  const probes = [
    ['ctx.get("connection")', () => ctx.get?.('connection')],
    ['ctx.connection', () => ctx.connection],
    ['ctx.root.get("connection")', () => ctx.root?.get?.('connection')],
    ['ctx.root.connection', () => ctx.root?.connection],
    ['ctx.ctx.get("connection")', () => ctx.ctx?.get?.('connection')],
  ];

  for (const [how, read] of probes) {
    try {
      const service = read();
      if (service && typeof service === 'object') return { found: true, how, service };
    } catch {
      /* 这一层探针不可用，继续下一层 */
    }
  }
  return { found: false, how: null, service: null };
}

/** 从 service 上取 browserAuth.launchToken。 */
function findLaunchToken(service) {
  if (!service || typeof service !== 'object') return { found: false, how: null, token: null };
  const probes = [
    ['service.browserAuth.launchToken', () => service.browserAuth?.launchToken],
    ['service.browserAuth?.launchToken (getter)', () => service.browserAuth?.['launchToken']],
    ['service.launchToken', () => service.launchToken],
  ];
  for (const [how, read] of probes) {
    try {
      const token = read();
      if (typeof token === 'string' && token !== '') return { found: true, how, token };
    } catch {
      /* 继续 */
    }
  }
  return { found: false, how: null, token: null };
}

/**
 * 主探测：给出结论。
 *
 * @param ctx - dsh 插件上下文（由调用方传入，或从全局兜底拿）
 * @returns 结构化结论，供插件决定是否启用 v2 代签
 */
export function probeLaunchToken(ctx) {
  const report = {
    schema: 'probe-launch-token/1',
    ok: false,
    service: { found: false, how: null },
    launchToken: { found: false, how: null, fingerprint: null },
    authenticatedUrlProbe: { available: false, error: null },
    conclusion: '',
    limitations: [],
  };

  const { found, how, service } = findConnectionService(ctx);
  report.service = { found, how };

  if (!found) {
    report.conclusion = '取不到 connection 服务 → 无法走「中转代取 v2」方案';
    report.limitations.push(
      '已尝试 ctx.get / ctx.connection / ctx.root.* / ctx.ctx.*，均未命中',
      '需要改道：让 dsh 客户端自己走 /connect，或由插件注入 patch',
    );
    return report;
  }

  const { found: tokenFound, how: tokenHow, token } = findLaunchToken(service);
  report.launchToken = { found: tokenFound, how: tokenHow, fingerprint: fingerprint(token) };

  if (!tokenFound) {
    report.conclusion = '取到 connection 服务，但拿不到 launchToken → 方案受阻';
    report.limitations.push(
      '服务的 browserAuth 可能未暴露，或属性被改写为私有',
      '可用 authenticatedUrl() 间接探测（见下）',
    );
  } else {
    report.ok = true;
    report.conclusion = '可取到 launchToken → 中转可以代取 v2 Cookie';
  }

  // 间接验证：若服务上有 authenticatedUrl(baseUrl)，它能证明 token 确实可用。
  try {
    if (typeof service.authenticatedUrl === 'function') {
      const probeUrl = service.authenticatedUrl('http://127.0.0.1:9/');
      const parsed = new URL(probeUrl);
      const tokenParam = parsed.searchParams.get('token');
      report.authenticatedUrlProbe = {
        available: true,
        error: null,
        tokenMatches: tokenFound && tokenParam === token,
        tokenPresent: typeof tokenParam === 'string' && tokenParam !== '',
      };
    } else {
      report.authenticatedUrlProbe = { available: false, error: 'service.authenticatedUrl 不存在' };
    }
  } catch (err) {
    report.authenticatedUrlProbe = { available: false, error: String(err?.message || err) };
  }

  return report;
}

// ── 作为独立脚本运行时：尝试从环境里找到上下文（通常拿不到，仅作说明）──
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const report = probeLaunchToken(globalThis.__DSH_CTX);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.stdout.write(
      '\n提示：本脚本作为独立进程运行时拿不到 dsh 的插件上下文（那是进程内对象）。\n'
      + '真正的探测应在插件 apply() 内调用 probeLaunchToken(ctx)。\n'
      + `当前 DSH_HOME=${process.env.DSH_HOME || path.join(os.homedir(), '.dsh')}\n`,
    );
  }
}
