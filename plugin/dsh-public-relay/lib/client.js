/**
 * client.js — dsh-public-relay 浏览器端（无需构建的 classic 脚本）
 *
 * ── 装载契约（dsh 0.2.x）──
 *
 *   window.__ModuleLoader__.load({ id, factory })  ← id 必须等于 npm 包名
 *   factory(require) 返回 Cordis 插件对象 { inject, apply }
 *
 * 可用的 require 只有外壳冻结的模块表（react / react-dom / react/jsx-runtime /
 * @deepseek-ai/dsh-client-ui-primitives / dsh-client-store / dsh-client-ui-slots …）。
 * 本文件只用 `react`，不引入任何可选依赖，因此不需要构建步骤。
 *
 * ── 两个座位 ──
 *
 *   1. `settings.section`      「设置」左栏的独立整页（主入口）
 *   2. `plugins.row.config`    「设置 → 插件」里本插件那一行上的「配置」页
 *
 * 两个座位都通过 `ctx.slots.inject(name, cb)` 注册：这些座位由设置外壳 / 插件页
 * 声明，声明时机不确定；`inject` 会在声明出现时（或已存在时立即）跑回调。
 *
 * ── 为什么自绘表单而不是导出 Config ──
 *
 * 宿主半**不再导出 Config**。0.2.x 的设置自动表单依赖「由宿主自己那份
 * schemastery 构建的 volatile schema」，第三方包拿不到那条提交链路；硬依赖它
 * 只会在换版本时静默失效。所以配置的读写全部走本插件自己的
 * `/dsh-public-relay/*` 路由，UI 只是那份 JSON 的一份视图。副作用是：
 * 这套 UI 在 0.1.x / 0.2.x 上行为完全一致。
 *
 * ── 防崩纪律 ──
 *
 * 座位注册、渲染、请求都 try/catch 包裹：任何一个失败都不该让设置面板白屏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-public-relay',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;
    const { useState, useEffect, useRef } = react;

    /** 与 lib/index.js 的 ROUTE_PREFIX 必须一致。 */
    const API_PREFIX = 'dsh-public-relay';

    /** locale 命名空间（同时也是 ctx.locale.register 的 key）。 */
    const LOCALE_NS = 'dsh-public-relay';

    /** 本包在 profile 里的 Loader 条目 id（= 包名，见 cordis.patch.yml）。 */
    const PACKAGE_NAME = 'dsh-public-relay';
    const ROW_ID = 'dsh-public-relay';

    /* ═══════════════════ 文案 ═══════════════════ */

    const zh = {
      nav: 'DSH 中转',
      title: 'DSH 中转（公网访问）',
      intro: '在本进程内把 dsh 自己的端口中转出去：改写 Host/Origin 过信任栅栏、可选强制回环改写、口令认证、自动代签 dsh 会话、WebSocket 透传。配合内网穿透即可从公网访问本机 dsh。',
      currentDshPort: '当前 dsh 端口',
      relayListen: '中转监听',
      upstream: '上游目标',
      tunnelHint: '樱花映射 / frp 隧道的「本地端口」填上面的中转端口。',
      state: '运行状态',
      running: '运行中',
      stopped: '已停止',
      error: '错误',
      portInUse: '端口被占用',
      enable: '启用中转',
      disable: '停用中转',
      copy: '复制',
      copied: '已复制：',
      copyFailed: '复制失败，请手工选择',
      readFailed: '读取状态失败',
      loading: '正在读取宿主状态…',
      connections: '活动连接',
      requests: '已处理请求',
      uptime: '运行时长',
      auth: '口令认证',
      autoSessionMetric: '自动会话',
      on: '已开启',
      off: '已关闭',
      blocked: '已禁用',
      enabled: '启用中转',
      enabledHint: 'dsh 启动时自动开始中转。关掉后插件仍加载，随时可手动启用。',
      listenHost: '中转监听地址',
      listenHostHint: '127.0.0.1 只给本机隧道用（推荐）；0.0.0.0 会让局域网直接可达。',
      listenPort: '中转监听端口',
      listenPortHint: '隧道「本地端口」填这个值。填 0 让系统自动分配。',
      password: '访问口令',
      passwordHint: '留空表示「保持当前口令不变」。口令从不回填、也不会显示，只能整体覆盖或清除。',
      passwordPlaceholder: '（不修改请留空）',
      passwordClear: '清除口令',
      passwordSetHint: '已设置口令。留空保存 = 保持不变；填新值 = 换成新口令。',
      passwordNoneHint: '⚠ 当前没有口令 —— 任何能连到中转端口的人都能直接进入。',
      passwordWillClear: '保存后将清除口令 —— 届时任何人都能直接进入。',
      forceLoopback: '强制回环改写',
      forceLoopbackHint: '把客户端 bundle 里的 isLoopback 判定改成恒真，使公网域名访问时 dsh 仍认为自己是本机（插件列表不降级）。dsh 已支持 trustedHosts 时可关掉。',
      autoSession: '自动管理 dsh 会话',
      autoSessionHint: '按 dsh 的格式代签会话 Cookie，于是「打开中转地址 → 只输中转口令 → 直接进入」，不必再找 dsh 打印的 ?token= URL。',
      autoSessionNoKey: '读不到 dsh 的会话密钥：自动进入当前不可用（仍需 ?token=）。确认 $DSH_HOME/.credentials.yaml 含 client-connection/browser-session 记录。',
      autoSessionBlockedWarn: '自动管理 dsh 会话未生效：口令为空时代签不会启用 —— 代签等价于「中转持有 dsh 会话密钥」，口令是唯一门槛。请先填一个访问口令。',
      passwordEmptyWarn: '当前口令为空：任何能连到中转端口的人都能直接访问你的 dsh（公网暴露时务必填口令）。',
      compressWebSocket: '压缩 WebSocket（会话历史）',
      compressWebSocketHint: 'dsh 的会话历史走 WebSocket，且是一个明文大帧（实测打开一个会话约 4.6 MB）。开启后这段在「浏览器↔中转」之间压缩（约 5.8x），切换会话明显更快；上游 dsh 载荷不受影响。依赖 dsh 自带的 ws，取不到时自动回退为不压缩。',
      compressUnavailableWarn: 'ws 不可用：WebSocket 按原样透传，会话历史不会压缩（功能正常，只是切换较慢）。',
      wsCompress: 'WS 压缩',
      wsDownlink: '历史下行',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saveOk: '已保存 ✓（监听参数变更会自动重启中转）',
      saveRecoverable: '已保存，但写入配置文件失败 —— 本次修改只在当前进程内生效。',
      saveFail: '保存失败',
      needPasswordToSave: '需要先填写访问口令：改配置/启停要求持有口令（它由口令派生，前端不保存口令本身）。填好后点保存即可；已填过则本页内会记住。',
      portInvalid: '请填 0–65535 的整数。',
      dirty: '有未保存的修改',
      configFile: '配置文件',
      patched: '已改写脚本',
      patchMiss: '未命中',
    };

    const en = {
      nav: 'DSH Relay',
      title: 'DSH Relay (public access)',
      intro: 'Reverse-proxy this process’s dsh port out: Host/Origin rewriting for the trust fence, optional forced-loopback patch, passcode auth, automatic dsh session signing, WebSocket passthrough. Point your tunnel at the relay port.',
      currentDshPort: 'Current dsh port',
      relayListen: 'Relay listen',
      upstream: 'Upstream',
      tunnelHint: 'Use the relay port above as the tunnel’s local port.',
      state: 'State',
      running: 'Running',
      stopped: 'Stopped',
      error: 'Error',
      portInUse: 'Port in use',
      enable: 'Start relay',
      disable: 'Stop relay',
      copy: 'Copy',
      copied: 'Copied: ',
      copyFailed: 'Copy failed — select the text manually',
      readFailed: 'Failed to read status',
      loading: 'Reading host status…',
      connections: 'Connections',
      requests: 'Requests',
      uptime: 'Uptime',
      auth: 'Passcode',
      autoSessionMetric: 'Auto session',
      on: 'On',
      off: 'Off',
      blocked: 'Disabled',
      enabled: 'Start relay on boot',
      enabledHint: 'Starts the relay when dsh boots. Turning it off keeps the plugin loaded.',
      listenHost: 'Listen address',
      listenHostHint: '127.0.0.1 for tunnel-only access (recommended); 0.0.0.0 exposes it to the LAN.',
      listenPort: 'Listen port',
      listenPortHint: 'The tunnel’s local port. Use 0 to let the OS choose.',
      password: 'Passcode',
      passwordHint: 'Leave empty to keep the current passcode. The passcode is never read back or displayed — you can only replace or clear it.',
      passwordPlaceholder: '(leave empty to keep)',
      passwordClear: 'Clear passcode',
      passwordSetHint: 'A passcode is set. Save with the field empty to keep it, or type a new value to replace it.',
      passwordNoneHint: '⚠ No passcode is set — anyone who can reach the relay port gets straight in.',
      passwordWillClear: 'Saving will clear the passcode — anyone who can reach the port will get in.',
      forceLoopback: 'Force loopback patch',
      forceLoopbackHint: 'Rewrites the client bundle’s isLoopback check to true so dsh still treats a public hostname as local. Turn this off once you configure dsh trustedHosts.',
      autoSession: 'Manage dsh session automatically',
      autoSessionHint: 'Signs the dsh session cookie so “open relay URL → enter passcode → straight in”, without hunting for the printed ?token= URL.',
      autoSessionNoKey: 'The dsh session secret could not be read: automatic entry is unavailable (?token= is still required). Check that $DSH_HOME/.credentials.yaml holds a client-connection/browser-session record.',
      autoSessionBlockedWarn: 'Automatic session signing is inactive: it never runs with an empty passcode — signing is equivalent to holding the dsh session secret, and the passcode is the only gate. Set a passcode first.',
      passwordEmptyWarn: 'The passcode is empty: anyone who can reach the relay port gets full access to your dsh.',
      compressWebSocket: 'Compress WebSocket (session history)',
      compressWebSocketHint: 'dsh serves session history over WebSocket as one large plaintext frame (measured: ~4.6 MB to open a session). This compresses it between browser and relay (~5.8x) so switching sessions is far faster; the upstream dsh payload is unchanged. Uses the ws package shipped with dsh and falls back to no compression when unavailable.',
      compressUnavailableWarn: 'ws is unavailable: WebSocket traffic passes through unchanged, so session history is not compressed (everything still works, switching is just slower).',
      wsCompress: 'WS compress',
      wsDownlink: 'History down',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saveOk: 'Saved ✓ (listen changes restart the relay automatically)',
      saveRecoverable: 'Saved, but writing the config file failed — this change only applies to the running process.',
      saveFail: 'Save failed',
      portInvalid: 'Enter an integer from 0 to 65535.',
      needPasswordToSave: 'Passcode required: changing settings or starting/stopping needs proof of the passcode (derived from it; the passcode itself is never stored). Type it and save again — it is remembered for this page.',
      dirty: 'Unsaved changes',
      configFile: 'Config file',
      patched: 'Patched bundles',
      patchMiss: 'Missed',
    };

    /* ═══════════════════ 样式 ═══════════════════ */

    const CSS = [
      '.dsr-page{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary,#e6e6e6)}',
      '.dsr-heading{margin:0;font-size:18px;font-weight:600}',
      '.dsr-intro{margin:0;color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:13px;line-height:20px}',
      '.dsr-text{margin:0;color:var(--dsw-alias-label-tertiary,#7f8797);font-size:12px;line-height:18px}',
      '.dsr-box{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.03))}',
      '.dsr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsr-key{color:var(--dsw-alias-label-tertiary,#7f8797);font-size:12px;min-width:96px}',
      '.dsr-val{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:16px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.dsr-valSm{font-size:13px;font-weight:500}',
      '.dsr-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.24));border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer;font:inherit;font-size:13px;min-height:28px;padding:4px 12px}',
      '.dsr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.dsr-btn:disabled{cursor:default;opacity:.5}',
      '.dsr-btnSm{font-size:12px;min-height:24px;padding:2px 8px;color:var(--dsw-alias-label-secondary,#9aa3b2)}',
      '.dsr-dot{width:7px;height:7px;border-radius:50%;flex:none}',
      '.dsr-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;border-radius:999px;padding:2px 10px;background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,#9aa3b2)}',
      '.dsr-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}',
      '.dsr-metric{display:flex;flex-direction:column;gap:2px}',
      '.dsr-metricK{color:var(--dsw-alias-label-tertiary,#7f8797);font-size:11px}',
      '.dsr-metricV{color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:13px;font-variant-numeric:tabular-nums}',
      '.dsr-warn{border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.24));border-radius:8px;padding:8px 12px;font-size:12px;line-height:18px}',
      '.dsr-note{font-size:12px;line-height:18px;margin:0}',
      '.dsr-ok{color:var(--dsw-alias-state-success-secondary,#45E7A4)}',
      '.dsr-err{color:var(--dsw-alias-state-error-primary,#f87171)}',
      '.dsr-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}',
      '.dsr-label{font-size:13px;font-weight:500;line-height:1.5}',
      '.dsr-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.24));background:0 0;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px}',
      '.dsr-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-1px}',
      '.dsr-check{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:12px;line-height:18px;cursor:pointer}',
      '.dsr-actions{display:flex;align-items:center;gap:10px;padding-top:6px;flex-wrap:wrap}',
    ].join('\n');

    const CSS_TAG_ID = 'dsh-public-relay/client.css';

    /**
     * 注入样式。
     *
     * **总是替换**旧标签而不是「已存在就跳过」：HMR 重载时上一次的样式标签
     * 会留在 <head>，若跳过注入，新版 CSS（例如删掉了某个组件的规则）永远
     * 不生效，页面会一直带残影。
     */
    function injectStyles() {
      try {
        if (typeof document === 'undefined') return;
        const existing = document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`);
        if (existing && typeof existing.remove === 'function') {
          try { existing.remove(); } catch { /* 已移除 */ }
        }
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-public-relay';
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch { /* 样式失败不影响功能 */ }
    }

    /**
     * 清掉历史版本留在 DOM 里的悬浮角标。
     *
     * 早期版本往 `shell.overlay` 座位注册过一个 `position:fixed; left:12px;
     * bottom:12px` 的角标，它正好压在侧栏底部的「设置」按钮上，导致设置点不开。
     * 该座位已移除，但已经打开过的页面里可能还留着它的 DOM 节点，所以这里主动
     * 清理，让用户刷新一次就干净（不必清缓存或重装）。
     */
    function removeLegacyBadge() {
      try {
        if (typeof document === 'undefined') return;
        for (const sel of ['.dsr-badge', '#dsh-public-relay-badge']) {
          const nodes = document.querySelectorAll(sel);
          for (let i = 0; i < nodes.length; i += 1) {
            try { nodes[i].remove(); } catch { /* 已移除 */ }
          }
        }
      } catch { /* 清理失败不影响功能 */ }
    }

    /* ═══════════════════ 与宿主通信 ═══════════════════ */

    function apiUrl(route) {
      try {
        return new URL(`${API_PREFIX}/${route}`, document.baseURI).href;
      } catch {
        return `/${API_PREFIX}/${route}`;
      }
    }

    /* ─────────── 管理 token（bearer）派生 ───────────
     *
     * 为什么需要：`/config` 与 `/control` 是**写**接口，宿主半要求
     * 「持有中转口令」才放行（`isAdminRequest`）。而口令是 write-only、
     * 从不回填，所以前端唯一的来源就是用户此刻敲进输入框的那个值。
     *
     * 算法必须与 lib/auth.js 的 makeAuth **逐字节一致**：
     *
     *   secret  = HMAC-SHA256(key="dsh-public-relay", msg=password)
     *   payload = base64url(JSON.stringify({ exp }))
     *   sig     = base64url(HMAC-SHA256(key=secret, msg=payload))
     *   token   = `${payload}.${sig}`
     *
     * 任一处不同都会静默变成 403，所以两边改动时必须同步。
     * 桌面外壳（dsh-app://app）不走这条路 —— 宿主半对它豁免，
     * 因为外壳页面拿不到口令，见 index.js 的 isAuthorizedAdmin。
     */

    /** 字节 → base64url（无填充）。 */
    function toBase64Url(bytes) {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).split('+').join('-').split('/').join('_').replace(/=+$/, '');
    }

    /** 本页内缓存的管理 token：密码框为空时复用它，避免每次点按钮都重敲口令。 */
    let adminTokenCache = null;

    /**
     * 用口令派生管理 token。
     * @returns token 字符串；口令为空或环境不支持 WebCrypto 时返回 null。
     */
    async function deriveAdminToken(password) {
      if (typeof password !== 'string' || password === '') return null;
      try {
        const subtle = globalThis.crypto && globalThis.crypto.subtle;
        if (!subtle) return null;
        const enc = new TextEncoder();
        const hmacKey = await subtle.importKey(
          'raw', enc.encode('dsh-public-relay'),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
        );
        const secret = await subtle.sign('HMAC', hmacKey, enc.encode(password));
        const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
        const payload = toBase64Url(enc.encode(JSON.stringify({ exp })));
        const msgKey = await subtle.importKey(
          'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
        );
        const sig = await subtle.sign('HMAC', msgKey, enc.encode(payload));
        return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
      } catch {
        return null;
      }
    }

    /** 取本次调用要用的 token：优先用新敲的口令，否则用本页缓存。 */
    async function resolveAdminToken(password) {
      if (typeof password === 'string' && password !== '') {
        const fresh = await deriveAdminToken(password);
        if (fresh !== null) adminTokenCache = fresh;
        return fresh;
      }
      return adminTokenCache;
    }

    async function call(route, payload, token) {
      const headers = { 'content-type': 'application/json' };
      if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`;
      const response = await fetch(apiUrl(route), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
      });
      if (!response.ok) {
        /*
         * 403 的两种成因要分开说：口令不对、或压根没带口令。
         * 直接把 `HTTP 403` 抛给用户等于什么都没解释 —— 而那正是
         * 「点了没反应」这类投诉的来源。
         */
        if (response.status === 403) return { ok: false, error: 'forbidden', status: 403 };
        return { ok: false, error: `HTTP ${response.status}` };
      }
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      if (parsed === null || typeof parsed !== 'object') return { ok: false, error: '宿主返回格式异常' };
      return parsed;
    }

    const readStatus = () => call('status');
    /** @param password - 用户在口令框里新敲的值（可为空，空时用本页缓存）。 */
    const sendControl = async (action, password) => call('control', { action }, await resolveAdminToken(password));
    const saveConfig = async (config, password) => call('config', { config }, await resolveAdminToken(password));

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* 退化到 execCommand */
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }

    /* ═══════════════════ 展示辅助 ═══════════════════ */

    function humanUptime(ms) {
      if (!ms || ms <= 0) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ${s % 60}s`;
      const hr = Math.floor(m / 60);
      if (hr < 24) return `${hr}h ${m % 60}m`;
      return `${Math.floor(hr / 24)}d ${hr % 24}h`;
    }

    function errorText(t, lastError) {
      if (!lastError) return null;
      if (lastError === 'port-in-use') return `${t('portInUse')}：换一个「中转监听端口」，或先停掉占用者，然后重新启用。`;
      if (String(lastError).startsWith('listen-failed')) return `无法绑定中转监听地址（${lastError}）：检查地址权限与端口范围。`;
      /*
       * 写接口 403 的唯一成因是「没拿到持口令凭据」：
       * 口令框为空且本页还没成功派生过 token（桌面外壳不会走到这里，
       * 宿主半对它豁免）。说清该怎么办，别把 HTTP 状态码丢给用户。
       */
      if (lastError === 'forbidden') return t('needPasswordToSave');
      return String(lastError);
    }

    /** 把字节数格式化成人能读的量级。 */
    function humanBytes(n) {
      if (!n || n <= 0) return '—';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    /**
     * WS 压缩状态的三态显示。
     *
     * `compressionReady === null` 表示还没有 WS 连接过（无法判断），
     * 不能显示成「关」—— 那会让用户以为开关坏了。
     */
    function wsCompressLabel(t, snap) {
      const ws = snap.websocket;
      if (!ws) return '—';
      if (ws.compressEnabled === false) return t('off');
      if (ws.compressionReady === null) return '—';
      return ws.compressionReady === true ? t('on') : t('blocked');
    }

    /* ═══════════════════ 面板 ═══════════════════ */

    /**
     * @param props.t     - 座位注入的翻译函数（无 locale 面时是内置回退）
     * @param props.mode  - 'section'（设置整页）| 'row'（插件行配置页）
     */
    function RelayPanel(props) {
      const t = typeof props.t === 'function' ? props.t : makeFallbackTranslate();
      const mode = props.mode === 'row' ? 'row' : 'section';

      const [snap, setSnap] = useState(null);
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState({ kind: '', text: '' });
      const mounted = useRef(true);

      /** 用户原意形式的 autoSession（不能用生效值，见宿主半 normalizeConfig 注释）。 */
      const wantedAutoSession = (config) => (
        config && config.autoSessionWanted !== undefined
          ? config.autoSessionWanted !== false
          : !config || config.autoSession !== false
      );

      /**
       * 表单草稿。
       *
       * 口令是 **write-only** 的：宿主半的 status 不再返回它（否则一次
       * 免认证/低权限读请求就能拿到唯一边界）。所以这里永远是空字符串，
       * 输入框也只是「填了就改成新口令」，不回填旧值。
       * `passwordTouched` 用来区分「没动」与「有意清空」。
       */
      const draftFrom = (config) => ({
        enabled: config.enabled !== false,
        listenHost: String(config.listenHost ?? ''),
        listenPort: String(config.listenPort ?? ''),
        password: '',
        passwordTouched: false,
        hasPassword: config.hasPassword === true,
        forceLoopback: config.forceLoopback !== false,
        autoSession: wantedAutoSession(config),
        compressWebSocket: config.compressWebSocket !== false,
      });

      useEffect(() => {
        mounted.current = true;
        let alive = true;

        const tick = async () => {
          const res = await readStatus().catch(() => null);
          if (!alive || !mounted.current) return;
          if (res && res.ok === true) {
            setSnap(res);
            // 只在还没编辑时同步草稿，避免覆盖用户正在输入的内容
            setDraft((prev) => (prev === null && res.config ? draftFrom(res.config) : prev));
          } else if (res && res.error) {
            setNote({ kind: 'error', text: `${t('readFailed')}：${res.error}` });
          }
        };

        void tick();
        const timer = setInterval(() => { void tick(); }, 3000);
        return () => {
          alive = false;
          mounted.current = false;
          clearInterval(timer);
        };
      }, []);

      const cfg = snap && snap.config ? snap.config : null;
      const cfgAutoSession = cfg ? wantedAutoSession(cfg) : true;
      // 口令不回填，所以只在用户真的敲过之后才算「改动」
      const passwordChanged = Boolean(draft && draft.passwordTouched === true);
      const dirty = Boolean(cfg && draft) && (
        draft.enabled !== (cfg.enabled !== false)
        || draft.listenHost !== String(cfg.listenHost ?? '')
        || draft.listenPort !== String(cfg.listenPort ?? '')
        || passwordChanged
        || draft.forceLoopback !== (cfg.forceLoopback !== false)
        || draft.autoSession !== cfgAutoSession
        || draft.compressWebSocket !== (cfg.compressWebSocket !== false)
      );

      const portText = draft ? draft.listenPort.trim() : '';
      const portBad = portText !== '' && (!/^\d+$/.test(portText) || Number(portText) > 65535);

      const onToggle = async () => {
        setBusy('toggle');
        setNote({ kind: '', text: '' });
        try {
          const res = await sendControl('toggle', draft ? draft.password : '');
          if (!mounted.current) return;
          if (res && res.status) setSnap(res.status);
          if (res && res.ok !== true && res.error) {
            setNote({ kind: 'error', text: errorText(t, res.error) || String(res.error) });
          }
        } catch (err) {
          if (mounted.current) setNote({ kind: 'error', text: String((err && err.message) || err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const onSave = async () => {
        if (!draft || portBad) return;
        setBusy('save');
        setNote({ kind: '', text: '' });
        try {
          const res = await saveConfig({
            enabled: draft.enabled,
            listenHost: draft.listenHost.trim(),
            listenPort: portText === '' ? 0 : parseInt(portText, 10),
            // 只有用户真的动过口令框才带上这个字段 —— 不带 = 保持原口令。
            // 宿主半按「字段是否存在」判断，见 writeConfig 的说明。
            ...(passwordChanged ? { password: draft.password } : {}),
            forceLoopback: draft.forceLoopback,
            autoSession: draft.autoSession,
            compressWebSocket: draft.compressWebSocket,
          }, passwordChanged ? draft.password : '');
          if (!mounted.current) return;
          if (res && res.ok === true) {
            if (res.status) {
              setSnap(res.status);
              if (res.status.config) setDraft(draftFrom(res.status.config));
            }
            setNote(res.persisted === false
              ? { kind: 'error', text: t('saveRecoverable') }
              : { kind: 'ok', text: t('saveOk') });
          } else {
            setNote({ kind: 'error', text: `${t('saveFail')}${res && res.error ? `：${res.error}` : ''}` });
          }
        } catch (err) {
          if (mounted.current) setNote({ kind: 'error', text: String((err && err.message) || err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const onDiscard = () => {
        if (busy !== '' || !cfg) return;
        setDraft(draftFrom(cfg));
        setNote({ kind: '', text: '' });
      };

      const onCopy = (value) => {
        void copyText(value).then((ok) => {
          if (mounted.current) {
            setNote(ok
              ? { kind: 'ok', text: t('copied') + value }
              : { kind: 'error', text: t('copyFailed') });
          }
        });
      };

      /* ---- 状态区 ---- */
      const body = [];
      body.push(h('p', { key: 'intro', className: 'dsr-intro' }, t('intro')));

      if (snap === null) {
        body.push(h('p', { key: 'loading', className: 'dsr-text' }, t('loading')));
      } else {
        const running = snap.state === 'running';
        const meta = snap.state === 'running'
          ? { label: t('running'), color: '#22c55e' }
          : snap.state === 'error'
            ? { label: snap.lastError === 'port-in-use' ? t('portInUse') : t('error'), color: '#ef4444' }
            : { label: t('stopped'), color: '#9ca3af' };

        body.push(h('div', { key: 'ports', className: 'dsr-box' },
          h('div', { className: 'dsr-row' },
            h('span', { className: 'dsr-key' }, t('currentDshPort')),
            h('span', { className: 'dsr-val' }, snap.dshAddress || `127.0.0.1:${snap.dshPort}`),
            h('button', {
              type: 'button',
              className: 'dsr-btn dsr-btnSm',
              onClick: () => onCopy(snap.dshAddress || `127.0.0.1:${snap.dshPort}`),
            }, t('copy'))),
          h('div', { className: 'dsr-row' },
            h('span', { className: 'dsr-key' }, t('relayListen')),
            h('span', { className: 'dsr-val dsr-valSm' }, snap.listen.address),
            h('button', {
              type: 'button',
              className: 'dsr-btn dsr-btnSm',
              onClick: () => onCopy(String(snap.listen.port)),
            }, t('copy'))),
          h('div', { className: 'dsr-row' },
            h('span', { className: 'dsr-key' }, t('upstream')),
            h('span', { className: 'dsr-val dsr-valSm' }, snap.target ? snap.target.origin : '—')),
          h('p', { className: 'dsr-text' }, t('tunnelHint'))));

        body.push(h('div', { key: 'state', className: 'dsr-row' },
          h('span', { className: 'dsr-state' },
            h('span', { className: 'dsr-dot', style: { background: meta.color } }),
            meta.label),
          h('button', {
            type: 'button',
            className: 'dsr-btn',
            disabled: busy !== '',
            onClick: onToggle,
          }, busy === 'toggle' ? '…' : (running ? t('disable') : t('enable')))));

        const sess = snap.session || null;
        const sessBlocked = Boolean(sess && sess.blockedByEmptyPassword);
        const sessOn = Boolean(sess && sess.enabled === true);

        body.push(h('div', { key: 'metrics', className: 'dsr-metrics' },
          h('div', { className: 'dsr-metric' },
            h('span', { className: 'dsr-metricK' }, t('connections')),
            h('span', { className: 'dsr-metricV' }, String(snap.connections))),
          h('div', { className: 'dsr-metric' },
            h('span', { className: 'dsr-metricK' }, t('requests')),
            h('span', { className: 'dsr-metricV' }, String(snap.requests))),
          h('div', { className: 'dsr-metric' },
            h('span', { className: 'dsr-metricK' }, t('uptime')),
            h('span', { className: 'dsr-metricV' }, humanUptime(snap.uptimeMs))),
          h('div', { className: 'dsr-metric' },
            h('span', { className: 'dsr-metricK' }, t('auth')),
            h('span', { className: 'dsr-metricV' }, snap.hasPassword ? t('on') : t('off'))),
          h('div', { className: 'dsr-metric' },
            h('span', { className: 'dsr-metricK' }, t('autoSessionMetric')),
            h('span', { className: 'dsr-metricV' }, sess === null ? '—' : (sessBlocked ? t('blocked') : sessOn ? t('on') : t('off')))),
          h('div', { className: 'dsr-metric' },
            h('span', { className: 'dsr-metricK' }, t('patched')),
            h('span', { className: 'dsr-metricV' }, String(snap.patchedScripts ?? 0))),
          h('div', { className: 'dsr-metric' },
            h('span', { className: 'dsr-metricK' }, t('wsCompress')),
            h('span', { className: 'dsr-metricV' }, wsCompressLabel(t, snap))),
          h('div', { className: 'dsr-metric' },
            h('span', { className: 'dsr-metricK' }, t('wsDownlink')),
            h('span', { className: 'dsr-metricV' }, humanBytes(snap.websocket?.downlinkBytes ?? 0)))));

        const err = errorText(t, snap.lastError);
        if (err) body.push(h('div', { key: 'err', className: 'dsr-warn' }, `⚠ ${err}`));
        if (!snap.hasPassword) body.push(h('div', { key: 'warn', className: 'dsr-warn' }, `⚠ ${t('passwordEmptyWarn')}`));
        // 开了压缩但 ws 加载失败：这是静默降级，必须让用户知道
        if (snap.websocket && snap.websocket.compressEnabled === true
          && snap.websocket.compressionReady === false) {
          body.push(h('div', { key: 'wsNoCompress', className: 'dsr-warn' }, `⚠ ${t('compressUnavailableWarn')}`));
        }
        if (sessBlocked) body.push(h('div', { key: 'sessBlocked', className: 'dsr-warn' }, `⚠ ${t('autoSessionBlockedWarn')}`));
        if (sessOn && !sessBlocked && sess.ready !== true) {
          body.push(h('div', { key: 'sessNoKey', className: 'dsr-warn' }, `⚠ ${t('autoSessionNoKey')}`));
        }
      }

      /* ---- 表单区 ---- */
      if (draft === null) {
        if (snap !== null) body.push(h('p', { key: 'nodraft', className: 'dsr-text' }, t('loading')));
      } else {
        const disabled = busy !== '';

        /**
         * 单行文本字段。
         * @param opts.secret - 口令类输入：用 password 类型（不明文显示），
         *   并且改动时打 passwordTouched 标记（见 draftFrom 的说明）。
         */
        const textField = (field, label, hint, placeholder, opts = {}) =>
          h('div', { key: field, className: 'dsr-field' },
            h('label', { className: 'dsr-label', htmlFor: `dsr-${mode}-${field}` }, label),
            h('input', {
              id: `dsr-${mode}-${field}`,
              className: 'dsr-input',
              type: opts.secret === true ? 'password' : 'text',
              autoComplete: opts.secret === true ? 'new-password' : 'off',
              value: draft[field],
              placeholder,
              disabled,
              onChange: (event) => setDraft((d) => ({
                ...d,
                [field]: event.target.value,
                ...(opts.secret === true ? { passwordTouched: true } : {}),
              })),
            }),
            h('p', { className: 'dsr-text' }, hint));

        const checkField = (field, label, hint) =>
          h('div', { key: field, className: 'dsr-field' },
            h('label', { className: 'dsr-check' },
              h('input', {
                type: 'checkbox',
                checked: draft[field] === true,
                disabled,
                onChange: (event) => setDraft((d) => ({ ...d, [field]: event.target.checked })),
              }),
              h('span', { className: 'dsr-label' }, label)),
            h('p', { className: 'dsr-text' }, hint));

        body.push(checkField('enabled', t('enabled'), t('enabledHint')));
        body.push(textField('listenHost', t('listenHost'), t('listenHostHint'), '127.0.0.1'));
        body.push(h('div', { key: 'listenPort', className: 'dsr-field' },
          h('label', { className: 'dsr-label', htmlFor: `dsr-${mode}-listenPort` }, t('listenPort')),
          h('input', {
            id: `dsr-${mode}-listenPort`,
            className: 'dsr-input',
            type: 'text',
            inputMode: 'numeric',
            value: draft.listenPort,
            placeholder: '3091',
            disabled,
            onChange: (event) => setDraft((d) => ({ ...d, listenPort: event.target.value })),
          }),
          h('p', { className: portBad ? 'dsr-note dsr-err' : 'dsr-text' },
            portBad ? t('portInvalid') : t('listenPortHint'))));
        // 口令：write-only。留空 = 保持不变，填值 = 覆盖，另有「清除」按钮。
        const effectiveHasPassword = passwordChanged ? draft.password !== '' : draft.hasPassword === true;
        body.push(textField(
          'password',
          t('password'),
          effectiveHasPassword ? t('passwordSetHint') : t('passwordNoneHint'),
          t('passwordPlaceholder'),
          { secret: true },
        ));
        if (effectiveHasPassword) {
          body.push(h('div', { key: 'pwClear', className: 'dsr-actions' },
            h('button', {
              type: 'button',
              className: 'dsr-btn dsr-btnSm',
              disabled,
              onClick: () => setDraft((d) => ({ ...d, password: '', passwordTouched: true })),
            }, t('passwordClear'))));
        }
        if (passwordChanged && draft.password === '' && draft.hasPassword === true) {
          body.push(h('p', { key: 'pwWillClear', className: 'dsr-note dsr-err' }, t('passwordWillClear')));
        }
        body.push(checkField('forceLoopback', t('forceLoopback'), t('forceLoopbackHint')));
        body.push(checkField('autoSession', t('autoSession'), t('autoSessionHint')));
        // WS 压缩：会话历史是明文大帧，这是「切会话卡」的直接解药
        body.push(checkField('compressWebSocket', t('compressWebSocket'), t('compressWebSocketHint')));
        if (!effectiveHasPassword) {
          body.push(h('p', { key: 'autoSessionBlocked', className: 'dsr-note dsr-err' }, t('autoSessionBlockedWarn')));
        }

        body.push(h('div', { key: 'actions', className: 'dsr-actions' },
          h('button', {
            type: 'button',
            className: 'dsr-btn',
            disabled: disabled || !dirty || portBad,
            onClick: onSave,
          }, busy === 'save' ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'dsr-btn',
            disabled: disabled || !dirty,
            onClick: onDiscard,
          }, t('discard')),
          dirty ? h('span', { className: 'dsr-text' }, t('dirty')) : null));
      }

      if (snap && snap.configFile) {
        body.push(h('p', { key: 'cfgfile', className: 'dsr-text' }, `${t('configFile')}：${snap.configFile}`));
      }

      if (note.text) {
        body.push(h('p', {
          key: 'note',
          className: `dsr-note${note.kind === 'error' ? ' dsr-err' : note.kind === 'ok' ? ' dsr-ok' : ''}`,
          role: 'status',
        }, note.text));
      }

      const children = mode === 'section'
        ? [h('h2', { key: 'h', className: 'dsr-heading' }, t('title')), ...body]
        : body;

      return h('div', { className: 'dsr-page' }, children);
    }

    /** 没有 locale 面时的兜底翻译：只回退到中文。 */
    function makeFallbackTranslate() {
      return (key) => (typeof zh[key] === 'string' ? zh[key] : key);
    }

    /* ═══════════════════ Cordis 插件形状 ═══════════════════ */

    /**
     * 只硬依赖 `slots`：没有座位就无处挂 UI。
     *
     * `locale` **不**写进 inject —— 它在 Cordis 里是「等这个服务就绪才激活」
     * 的硬依赖，一旦某个部署没有它，整个插件 fiber 就永远不就绪，用户看到的
     * 是「设置里根本没有这个插件」。文案降级由 apply 里的 ctx.get('locale')
     * 软获取处理：有就用宿主字典，没有就用内置中文。
     */
    const inject = ['slots'];

    function apply(ctx) {
      injectStyles();
      removeLegacyBadge();

      // ── 字典 ──
      // `locale` 面软获取：缺失时座位不声明 locale，面板退回内置中文。
      let localeFace = null;
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (service && typeof service.register === 'function' && typeof service.bind === 'function') {
          ctx.effect(() => service.register(LOCALE_NS, { zh, en }), 'dsh-public-relay: dictionaries');
          localeFace = service;
        }
      } catch (err) {
        try { ctx.logger?.warn?.(`[dsh-public-relay] 字典注册失败，退回内置文案：${err?.message || err}`); } catch { /* 忽略 */ }
      }

      const t = (key) => {
        if (localeFace !== null) {
          try {
            return localeFace.bind(LOCALE_NS)(key);
          } catch { /* 面板渲染期不接受异常 */ }
        }
        return typeof zh[key] === 'string' ? zh[key] : key;
      };

      /**
       * 注册一个座位。
       *
       * 两个座位都是「声明可能还不存在」的槽位，一律走 `ctx.slots.inject` 等待：
       * 回调在座位已声明时同步执行，否则等声明落地。座位注册本身已经挂在调用方
       * fiber 上（register 内部就是 ctx.effect），不需要再包一层。
       *
       * 注入面**刻意保持空对象**：一旦写了某个宿主不提供的服务名，该座位的
       * fiber 就永远不就绪，外壳不挂载它，用户看到的是「设置里根本没有这个插件」。
       * 座位差异（section / row）靠闭包固化，不走 inject。
       */
      const register = (slotName, options, mode, label) => {
        const Component = (props) => h(RelayPanel, {
          t: props && typeof props.t === 'function' ? props.t : t,
          mode,
        });
        try {
          ctx.slots.inject(slotName, () => ctx.slots.register({
            name: slotName,
            ...options,
            ...(localeFace !== null ? { locale: LOCALE_NS } : {}),
            inject: () => ({}),
          }, Component));
        } catch (err) {
          try { ctx.logger?.warn?.(`[dsh-public-relay] ${label} 注册失败：${err?.message || err}`); } catch { /* 忽略 */ }
        }
      };

      // 1) 设置整页（主入口）
      register('settings.section', {
        id: PACKAGE_NAME,
        order: 60,
        label: () => t('nav'),
      }, 'section', 'settings.section');

      // 2) 「设置 → 插件」里本插件那一行上的「配置」页
      //    key 的格式是 `<包名>#<行 id>`（插件页自己拼，见 dsh 文档）。
      register('plugins.row.config', {
        key: `${PACKAGE_NAME}#${ROW_ID}`,
      }, 'row', 'plugins.row.config');

      try {
        ctx.logger?.info?.('[dsh-public-relay] 浏览器端已挂载（settings.section + plugins.row.config）');
      } catch { /* 忽略 */ }
    }

    exports.name = PACKAGE_NAME;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
