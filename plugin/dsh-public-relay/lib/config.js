/**
 * config.js — dsh-public-relay 配置契约（宿主与浏览器半共用一份常量）
 *
 * 设计决定（0.2.0 起）：
 *
 *   **不再依赖 dsh 的 settings 命名空间做持久化。**
 *
 *   0.1.x 时代本插件靠 schemastery 的 `.volatile()` 把字段投进「设置 → 插件」
 *   的自动表单。这条路在两个层面都不可靠：
 *     1. `.volatile()` 只在 schemastery >= 3.18.4 存在，且 DSH 的构建会把
 *        `meta.volatile` 包成 cosmokit `Volatile` 引用；只有「由宿主那份
 *        schemastery 构建出来的 schema」才会被 Loader 的 volatile 提交链路认到，
 *        用别处的副本会静默丢掉每一次实时写入。
 *     2. 第三方命名空间并不在 api-proxy 的 exposedNamespaces 白名单里，
 *        浏览器端配置客户端读不到它。
 *
 *   于是改成：**配置由本插件自己的 JSON 文件持有**，读写都走本插件自己的
 *   HTTP 路由（宿主半注册）。这样与 dsh 版本、schemastery 版本、settings
 *   服务是否存在全部解耦 —— 插件在任何 0.1.x / 0.2.x 上都能改配置。
 *
 *   `cordis.patch.yml` 里的 `config` 只作为**首次启动的种子**：文件不存在时
 *   用它初始化并落盘，之后一切以文件为准。
 *
 * @module dsh-public-relay/config
 */

/** Cordis 插件名（Loader 诊断与日志里可见）。 */
export const name = 'dsh-public-relay';

/** 配置文件 schema 版本；未来做迁移时用。 */
export const CONFIG_VERSION = 1;

/** 配置文件文件名（放在 profile home 下）。 */
export const CONFIG_FILENAME = 'dsh-public-relay.json';

/**
 * 静态默认值。
 *
 * 与 normalizeConfig 的兜底必须一致，UI 直接用这份常量渲染「恢复默认」。
 */
export const DEFAULTS = Object.freeze({
  /** 插件装载时是否自动启动中转。 */
  enabled: true,
  /** 中转监听地址。127.0.0.1 = 只给本机隧道用；0.0.0.0 = 局域网直连。 */
  listenHost: '127.0.0.1',
  /** 中转监听端口（樱花映射 / frp 隧道的「本地端口」填这个）。0 = 让 OS 分配。 */
  listenPort: 3091,
  /** 访问口令。空字符串 = 关闭认证（公网暴露时务必非空）。 */
  password: '',
  /**
   * 上游覆盖：留空 = 自动取本进程 dsh 的真实端口（推荐）。
   *
   * 只有「代理另一个 dsh 实例」这种罕见场景才需要显式指定；两项都不进
   * 设置表单，属高级项，只认配置文件 / cordis.patch.yml 的 config。
   */
  targetHost: '',
  /** 上游端口覆盖；0 = 自动。 */
  targetPort: 0,
  /**
   * 强制回环改写：把客户端 bundle 里的 `isLoopback` 判定改成恒真，
   * 让经隧道访问时 dsh 仍认为自己是本机（否则设置平面会降级为 memory，
   * 插件列表显示为空）。
   *
   * 0.2.x 起 dsh 自身已有 `trustedHosts` 配置可以正式解决这个问题，
   * 所以本项默认开启但**不再必需**：优先推荐在 dsh 侧配 trustedHosts。
   */
  forceLoopback: true,
  /**
   * 自动代签 dsh 会话 Cookie：让用户只输中转口令就能进入，
   * 不必再去找 dsh 打印的 `?token=` URL。
   *
   * 安全前提：口令非空时才生效（见 normalizeConfig 的硬约束）。
   */
  autoSession: true,
});

/** 数值夹取（端口等）。 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 归一化一份配置：类型收敛、范围夹取、未知键丢弃。
 *
 * @param raw - 任意来源的原始值（文件内容 / Loader 的 entry config / 请求体）。
 * @returns 完整且合法的配置。
 */
export function normalizeConfig(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const rawHost = src.listenHost;
  const listenHost = typeof rawHost === 'string' && rawHost.trim() !== ''
    ? rawHost.trim()
    : DEFAULTS.listenHost;

  // 端口 0 允许：让 OS 分配，UI 上显示真实分配值。
  const listenPort = clampInt(src.listenPort, 0, 65535, DEFAULTS.listenPort);

  const password = typeof src.password === 'string' ? src.password : String(src.password ?? '');

  const rawTargetHost = src.targetHost;
  const targetHost = typeof rawTargetHost === 'string' && rawTargetHost.trim() !== ''
    ? rawTargetHost.trim()
    : null;

  // 上游端口 0 没有意义 —— 归一为 null，走「自动取本进程 dsh 端口」。
  const targetPortNum = clampInt(src.targetPort, 0, 65535, 0);
  const targetPort = targetPortNum > 0 ? targetPortNum : null;

  /**
   * 自动会话代签：口令为空时**强制关闭**。
   *
   * 理由：代签等价于「持有 dsh 会话密钥」，而中转口令是这道能力的唯一门槛。
   * 口令为空时若还自动代签，任何能连到中转端口的人都会直接拿到 dsh 的完整会话。
   */
  const autoSessionWanted = src.autoSession !== false;
  const autoSession = autoSessionWanted && password !== '';

  return {
    enabled: src.enabled !== false,
    listenHost,
    listenPort,
    targetHost,
    targetPort,
    password,
    forceLoopback: src.forceLoopback !== false,
    autoSession,
    /**
     * 用户原意（未被「口令为空」这条约束压过）。
     *
     * UI 的开关与回写只能用原意：若用生效值，口令为空时开关会显示「关」，
     * 用户随手一保存就把自己的开关真的关掉了，填回口令也不会自动恢复。
     */
    autoSessionWanted,
    /** 用户想要但被「口令为空」压掉时，UI 需要知道，以便解释原因。 */
    autoSessionBlocked: autoSessionWanted && !autoSession,
  };
}

/** 只挑出与默认值不同的项（用于 UI 的「已覆盖」提示与日志）。 */
export function diffFromDefaults(config) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const a = config[key];
    const b = DEFAULTS[key];
    // targetHost/targetPort 的 null 与默认的 ''/0 等价，不算覆盖
    if (key === 'targetHost') { if (a !== null) out[key] = a; continue; }
    if (key === 'targetPort') { if (a !== null) out[key] = a; continue; }
    if (a !== b) out[key] = a;
  }
  return out;
}

/** 可落盘的纯数据形状（丢掉派生字段）。 */
export function toStorable(config) {
  return {
    version: CONFIG_VERSION,
    enabled: config.enabled,
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    targetHost: config.targetHost ?? '',
    targetPort: config.targetPort ?? 0,
    password: config.password,
    forceLoopback: config.forceLoopback,
    // 存「用户原意」，生效与否每次由 normalizeConfig 判。
    autoSession: config.autoSessionWanted,
  };
}
