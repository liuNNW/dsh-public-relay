/**
 * config.js — dsh-public-relay 配置契约（宿主与设置页共用一份常量）
 *
 * 这里声明的字段就是「设置 → 插件 → DSH 中转」页面能改的全部内容。
 *
 * 关键约定（与 @deepseek-ai/dsh-mimo-vision 同构）：
 *   - 每个字段都加 `.volatile()`：宿主才会把它投进设置表单；
 *   - `.volatile()` 字段不能嵌套在另一个 `.volatile()` 字段里（schemastery 会抛
 *     ValidationError），所以本 schema 是一层扁平的字段集合；
 *   - 加载时 Loader 传给 apply 的 `.volatile()` 字段是引用对象（`{ get() }`），
 *     统一用 unwrap() 取值，让下游只面对普通对象。
 *
 * @module dsh-public-relay/config
 */
import z from '@deepseek-ai/schemastery';

/**
 * 给 schema 打 `.volatile()` 标记。
 *
 * 为什么需要这个包装：`.volatile()` 只在 schemastery >= 3.18.4 上存在，而
 * 不同 profile 可能解析到不同版本（实测共享目录是 3.18.1、desktop 本地是
 * 3.18.4）。直接链式调 `.volatile()` 会在旧版本上抛
 * `z.boolean(...).default(...).volatile is not a function`，让整个插件加载失败。
 *
 * 语义上 `.volatile()` 的作用是「让宿主把该字段投进设置表单」。旧版没有它时
 * 我们照常返回 schema —— 设置页可能少一个表单字段，但插件其余部分完好，
 * 这比整条插件链挂掉好得多。
 *
 * @param schema - schemastery schema。
 * @returns 打过标记（或原样）的 schema。
 */
function vol(schema) {
  if (schema && typeof schema.volatile === 'function') return schema.volatile();
  return schema;
}

/** Cordis 插件名：Loader 诊断与日志里可见。 */
export const name = 'dsh-public-relay';

/**
 * 设置命名空间 / profile 条目 id。
 * 必须与 cordis.patch.yml 里的 `id` 完全一致，设置页才有可读写的表单。
 */
export const SETTINGS_NAMESPACE = 'dsh-public-relay';

/** credentials 记录键（历史兼容：早期版本把整份配置存在这里）。 */
export const CRED_REF = 'DSH_RELAY_CONFIG';

/** 静态默认值（与下方 schema 的 default 必须一致）。 */
export const DEFAULTS = Object.freeze({
  /** 插件挂载时是否启动中转。 */
  enabled: true,
  /** 中转监听地址。127.0.0.1 = 只给本机隧道用；0.0.0.0 = 局域网直连。 */
  listenHost: '127.0.0.1',
  /** 中转监听端口（樱花映射隧道「本地端口」填这个）。0 = 让 OS 分配。 */
  listenPort: 3091,
  /** 上游地址覆盖；空 = 自动取本进程 dsh 端口（推荐）。 */
  targetHost: '',
  /** 上游端口覆盖；0 = 自动。 */
  targetPort: 0,
  /** 访问口令。空字符串 = 关闭认证（公网暴露时务必非空）。 */
  password: '20040915',
  /** 强制回环改写：让公网访问也能看到插件列表。 */
  forceLoopback: true,
  /**
   * 自动管理 dsh 会话：由中转按 dsh 的格式代签会话 Cookie，
   * 让用户只输中转口令就能进入，不必再要 dsh 打印的那个 ?token= URL。
   *
   * 安全前提：口令非空时才生效（见 normalizeConfig 的强制约束）——
   * 否则等于把 dsh 的完整会话无条件送出去。
   */
  autoSession: true,
});

/**
 * 插件 Config：设置页表单的唯一数据源。字段顺序 = 表单显示顺序。
 *
 * 只把「用户会改」的项放进 schema。targetHost/targetPort 是给「代理另一个 dsh
 * 实例」这种罕见场景留的口子，属高级项，因此不进表单，仍可由 cordis.patch.yml
 * 的 config 提供。
 */
export const Config = z.object({
  /** 启用中转：关闭后插件仍加载，可随时手动开启。 */
  enabled: vol(z.boolean().default(DEFAULTS.enabled)),
  /** 中转监听地址。 */
  listenHost: vol(z.string().default(DEFAULTS.listenHost)),
  /** 中转监听端口。 */
  listenPort: vol(z.natural().max(65535).default(DEFAULTS.listenPort)),
  /** 访问口令；留空 = 关闭认证。 */
  password: vol(z.string().default(DEFAULTS.password)),
  /** 强制回环改写。 */
  forceLoopback: vol(z.boolean().default(DEFAULTS.forceLoopback)),
  /** 自动管理 dsh 会话（口令非空时才真正生效）。 */
  autoSession: vol(z.boolean().default(DEFAULTS.autoSession)),
});

/**
 * 取出一个 Config 字段的实际值。
 * `.volatile()` 字段在 apply 收到的是 `{ get(): T }` 引用，普通字段是裸值。
 * @param value - 字段值或引用。
 * @returns 实际值。
 */
export function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/** 数值夹取。 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 归一化一份配置：取引用真值、类型收敛、范围夹取、未知键丢弃。
 * @param raw - 任意来源的原始对象（可能为 null / 含脏值 / 含 volatile 引用）。
 * @returns 完整且合法的配置。
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (key) => unwrap(src[key]);

  const rawEnabled = pick('enabled');
  const rawHost = pick('listenHost');
  const rawPort = pick('listenPort');
  const rawTargetHost = pick('targetHost');
  const rawTargetPort = pick('targetPort');
  const rawPassword = pick('password');
  const rawForce = pick('forceLoopback');
  const rawAutoSession = pick('autoSession');

  const listenHost = typeof rawHost === 'string' && rawHost.trim() !== ''
    ? rawHost.trim()
    : DEFAULTS.listenHost;

  // 端口 0 允许：让 OS 分配，UI 上显示真实分配值。
  const listenPort = clampInt(rawPort, 0, 65535, DEFAULTS.listenPort);

  const targetHost = typeof rawTargetHost === 'string' && rawTargetHost.trim() !== ''
    ? rawTargetHost.trim()
    : null;

  // 上游端口 0 没有意义 —— 归一为 null，走「自动取本进程 dsh 端口」。
  const targetPortNum = clampInt(rawTargetPort, 0, 65535, 0);
  const targetPort = targetPortNum > 0 ? targetPortNum : null;

  const password = typeof rawPassword === 'string' ? rawPassword : String(rawPassword ?? '');

  /**
   * 自动会话代签：口令为空时**强制关闭**。
   *
   * 理由：代签等价于「持有 dsh 会话密钥」，而中转口令是这道能力的唯一门槛。
   * 口令为空时若还自动代签，任何能连到中转端口的人都会直接获得 dsh 的完整会话 ——
   * 比「需要 dsh 打印的 ?token=」还糟。所以这里硬性约束，而不是交给用户自觉。
   */
  const autoSessionWanted = rawAutoSession !== false;
  const autoSession = autoSessionWanted && password !== '';

  return {
    enabled: rawEnabled !== false,
    listenHost,
    listenPort,
    targetHost,
    targetPort,
    password,
    forceLoopback: rawForce !== false,
    autoSession,
    /**
     * 用户原意（未被「口令为空」这条约束压过）。
     *
     * 为什么必须单独暴露：UI 的开关与回写都只能用原意。若用生效值，口令为空时
     * 开关会显示为「关」，用户随手一保存就把自己的开关真的关掉了 —— 填回口令
     * 也不会自动恢复，且用户完全不知道发生过什么。
     */
    autoSessionWanted,
    /** 用户想要但被口令为空这条约束压掉时，UI 需要知道，以便给出解释。 */
    autoSessionBlocked: autoSessionWanted && !autoSession,
  };
}

/** 只挑出与默认值不同的项（用于日志与 UI 的「已覆盖」提示）。 */
export function diffFromDefaults(config) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const a = config[key];
    const b = DEFAULTS[key];
    // targetHost/targetPort 的 null 与 schema 默认的 ''/0 等价，不算覆盖
    if (key === 'targetHost') { if (a !== null) out[key] = a; continue; }
    if (key === 'targetPort') { if (a !== null) out[key] = a; continue; }
    if (a !== b) out[key] = a;
  }
  return out;
}
