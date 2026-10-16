/**
 * client.js — dsh-relay 浏览器端（classic script）
 *
 * ── 座位（都在设置里，不往页面挂任何悬浮元素）──
 *   1. settings.section → 设置左侧栏的「DSH 中转」整页（主入口）
 *   2. plugins.item     → 「设置 → 插件」里的配置卡片
 *
 * ── 为什么零服务依赖 ──
 *
 * 本插件只 inject `slots`（没有座位就无处挂 UI），页面的读写全部走**自己的
 * HTTP 路由**（宿主半已注册 /dsh-relay/*）。不依赖 configForms / locale /
 * timer / ui-primitives 等宿主服务，理由是一个实测教训：
 *
 *   早先版本用 configForms 生成表单，但它并不在本宿主的客户端服务目录里
 *   （实测可用服务只有 layout / locale / sessions / slots / theme / timer /
 *   uiWorkspace / workspaces）。依赖一个不存在的服务 → 该座位的注入面永远
 *   不就绪 → 外壳始终不挂载它，槽位账本里停在 `active: false`，
 *   表现就是「设置里怎么都看不到这个插件」。
 *
 * 自绘表单 + 自有 HTTP 路由没有这个风险：只要 slots 在，面板就一定渲染得出。
 *
 * 防崩纪律：slot 注册与渲染都 try/catch 包裹，任何失败静默降级，绝不让设置
 * 面板或整个页面白屏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-relay',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;
    const { useState, useEffect, useRef } = react;

    /** 宿主 HTTP 路由前缀（相对页面 base 解析，Electron 的 dsh-app:// 也能命中）。 */
    const API_PREFIX = 'dsh-relay';

    /** 只硬依赖 slots：没有座位就无处挂 UI。其余一切自给自足。 */
    const inject = ['slots'];

    /** 纯计时器：不用 ctx.timer 服务（它可能缺失，且我们要零依赖）。 */
    function startInterval(fn, ms) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    }

    /* ═══════════════════ 文案 ═══════════════════ */

    const TEXT = {
      title: 'DSH 中转',
      description: '在本进程内把 dsh 自己的端口中转出去：改写 Host/Origin 过信任栅栏、可选强制回环改写（公网也能看到插件列表）、口令认证 + 自动代签 dsh 会话 + WebSocket 透传。',
      currentDshPort: '当前 dsh 端口',
      relayListen: '中转监听',
      upstream: '上游目标',
      state: '运行状态',
      connections: '活动连接',
      requests: '已处理请求',
      uptime: '运行时长',
      auth: '口令认证',
      autoSessionMetric: '自动会话',
      running: '运行中',
      stopped: '已停止',
      error: '错误',
      portInUse: '端口被占用',
      on: '已开启',
      off: '已关闭',
      blocked: '已禁用',
      enable: '启用中转',
      disable: '停用中转',
      copy: '复制',
      copied: '已复制：',
      copyFailed: '复制失败，请手工选择复制',
      readFailed: '读取状态失败',
      tunnelHint: '樱花映射 / frp 隧道的「本地端口」填上面的中转端口。',
      loading: '正在读取宿主状态…',
      enabled: '启用中转',
      enabledHint: 'dsh 启动时自动开始中转。关掉后插件仍加载，随时可手动启用。',
      listenHost: '中转监听地址',
      listenHostHint: '127.0.0.1 只给本机隧道用（推荐）；0.0.0.0 会让局域网直接可达。',
      listenPort: '中转监听端口',
      listenPortHint: '隧道「本地端口」填这个值。填 0 让系统自动分配。',
      password: '访问口令',
      passwordHint: '留空将关闭口令认证，任何能连到中转端口的人都能直接进入。',
      forceLoopback: '强制回环改写',
      forceLoopbackHint: '改写 dsh 客户端连接模块里的 isLoopback 判定，使公网域名访问时插件列表仍可见。dsh 升级后若正则失配，日志会打「未找到目标模式」。',
      autoSession: '自动管理 dsh 会话',
      autoSessionHint: '按 dsh 的格式代签会话 Cookie，于是「打开中转地址 → 只输中转口令 → 直接进入」，不必再找 dsh 打印的那个 ?token= URL。关闭后需按 dsh 原生流程带 token 进入。',
      autoSessionNoKey: '读不到 dsh 的会话密钥：自动进入当前不可用（仍需 dsh 打印的 ?token=）。确认 $DSH_HOME/.credentials.yaml 存在且含 client-connection/browser-session 记录。',
      autoSessionBlockedWarn: '自动管理 dsh 会话已被禁用：口令为空时它不能生效。代签等价于「中转持有 dsh 会话密钥」，口令是唯一门槛 —— 请先填一个访问口令。',
      passwordEmptyWarn: '当前口令为空：任何能连到中转端口的人都能直接访问你的 dsh（公网暴露时务必填一个口令）。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saveOk: '已保存 ✓（监听参数变更会自动重启中转）',
      saveFail: '保存失败',
      portInvalid: '请填 0–65535 的整数。',
      dirty: '有未保存的修改',
    };

    function t(key, ...args) {
      const v = TEXT[key];
      return typeof v === 'function' ? v(...args) : (v !== undefined ? v : key);
    }

    /* ═══════════════════ 样式（全部局部类名，无悬浮定位）═══════════════════ */

    const CSS = [
      '.dsr-page{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary)}',
      '.dsr-heading{margin:0;font-size:18px;font-weight:600}',
      '.dsr-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dsr-text{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsr-box{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsr-key{color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:84px}',
      '.dsr-val{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.dsr-valSm{font-size:13px;font-weight:500}',
      '.dsr-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;min-height:28px;padding:4px 12px}',
      '.dsr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsr-btn:disabled{cursor:default;opacity:.6}',
      '.dsr-btnSm{font-size:12px;min-height:24px;padding:2px 8px;color:var(--dsw-alias-label-secondary)}',
      '.dsr-dot{width:7px;height:7px;border-radius:50%;flex:none}',
      '.dsr-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;border-radius:999px;padding:2px 10px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}',
      '.dsr-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}',
      '.dsr-metric{display:flex;flex-direction:column;gap:2px}',
      '.dsr-metricK{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dsr-metricV{color:var(--dsw-alias-label-secondary);font-size:13px;font-variant-numeric:tabular-nums}',
      '.dsr-warn{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:8px 12px;font-size:12px;line-height:18px}',
      '.dsr-note{font-size:12px;line-height:18px;margin:0}',
      '.dsr-ok{color:var(--dsw-alias-state-success-secondary)}',
      '.dsr-err{color:var(--dsw-alias-state-error-primary)}',
      '.dsr-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsr-label{font-size:13px;font-weight:500;line-height:1.5}',
      '.dsr-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.dsr-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.dsr-check{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}',
      '.dsr-actions{display:flex;align-items:center;gap:10px;padding-top:6px;flex-wrap:wrap}',
    ].join('\n');

    const CSS_TAG_ID = 'dsh-relay/client.css';

    /**
     * 注入样式。**总是替换**旧标签而不是「已存在就跳过」：
     * HMR 重载时上一次的样式标签会留在 <head>，若跳过注入，新版 CSS
     * （例如删掉了某个组件的规则）永远不生效，页面会一直带残影。
     */
    function injectStyles() {
      try {
        if (typeof document === 'undefined') return;
        const existing = document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]');
        if (existing && typeof existing.remove === 'function') {
          try { existing.remove(); } catch (e) { /* 已移除 */ }
        }
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-relay';
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (e) { /* 样式失败不影响功能 */ }
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
        const sel = ['.dsr-badge', '#dsh-relay-badge'];
        for (let i = 0; i < sel.length; i++) {
          const nodes = document.querySelectorAll(sel[i]);
          for (let j = 0; j < nodes.length; j++) {
            try { nodes[j].remove(); } catch (e) { /* 已移除 */ }
          }
        }
      } catch (e) { /* 清理失败不影响功能 */ }
    }

    /* ═══════════════════ 与宿主通信（自有 HTTP 路由）═══════════════════ */

    function apiUrl(path) {
      try {
        return new URL(API_PREFIX + '/' + path, document.baseURI).href;
      } catch (e) {
        return '/' + API_PREFIX + '/' + path;
      }
    }

    async function call(method, payload) {
      const response = await fetch(apiUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
      let parsed = null;
      try { parsed = await response.json(); } catch (e) { parsed = null; }
      if (parsed === null || typeof parsed !== 'object') return { ok: false, error: '宿主返回格式异常' };
      return parsed;
    }

    const readStatus = () => call('status');
    const sendControl = (action) => call('control', { action });
    const saveConfig = (config) => call('config', { config });

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* 退化 */ }
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
      } catch (e) { return false; }
    }

    /* ═══════════════════ 展示辅助 ═══════════════════ */

    function stateMeta(snap) {
      if (snap === null) return { label: '…', color: '#6b7280' };
      if (snap.state === 'running') return { label: t('running'), color: '#22c55e' };
      if (snap.state === 'error') {
        return snap.lastError === 'port-in-use'
          ? { label: t('portInUse'), color: '#ef4444' }
          : { label: t('error'), color: '#ef4444' };
      }
      return { label: t('stopped'), color: '#9ca3af' };
    }

    function humanUptime(ms) {
      if (!ms || ms <= 0) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + ' 秒';
      const m = Math.floor(s / 60);
      if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
      const hr = Math.floor(m / 60);
      if (hr < 24) return hr + ' 小时 ' + (m % 60) + ' 分';
      return Math.floor(hr / 24) + ' 天 ' + (hr % 24) + ' 小时';
    }

    function errorText(lastError) {
      if (!lastError) return null;
      if (lastError === 'port-in-use') return t('portInUse') + '：换一个「中转监听端口」，或先停掉占用者，然后重新启用。';
      if (String(lastError).startsWith('listen-failed')) return '无法绑定中转监听地址（' + lastError + '）：检查地址权限与端口范围。';
      return String(lastError);
    }

    /* ═══════════════════ 面板（自绘表单，零服务依赖）═══════════════════ */

    /**
     * @param props.view - 座位契约：'summary' 时只回一行说明（卡片列表用）
     * @param props.mode - 'card'（插件页卡片）| 'section'（设置整页）
     */
    function RelayPanel(props) {
      const { view, mode } = props;

      const [snap, setSnap] = useState(null);
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState({ kind: '', text: '' });
      const mounted = useRef(true);

      /**
       * 取「用户原意」形式的 autoSession。
       *
       * 不能用生效值：口令为空时 normalizeConfig 会把它压成 false，若据此渲染
       * 开关，用户看到的是「关」，随手一保存就把自己的开关真的关掉了。
       * `autoSessionWanted` 是配置归一化里单独暴露的原意字段；旧宿主没有它时
       * 退回生效值（行为与升级前一致，不会更糟）。
       */
      const wantedAutoSession = (config) => (
        config.autoSessionWanted !== undefined
          ? config.autoSessionWanted !== false
          : config.autoSession !== false
      );

      const draftFrom = (config) => ({
        enabled: config.enabled !== false,
        listenHost: String(config.listenHost ?? ''),
        listenPort: String(config.listenPort ?? ''),
        password: String(config.password ?? ''),
        forceLoopback: config.forceLoopback !== false,
        autoSession: wantedAutoSession(config),
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
            setNote({ kind: 'error', text: t('readFailed') + '：' + res.error });
          }
        };

        void tick();
        const stop = startInterval(() => { void tick(); }, 3000);
        return () => {
          alive = false;
          mounted.current = false;
          try { stop(); } catch (e) { /* 已清理 */ }
        };
      }, []);

      // 插件页卡片的 summary 视图只出一行说明（该座位的契约）
      if (view === 'summary') return t('description');

      const cfg = snap && snap.config ? snap.config : null;
      // 比较也要用原意，否则「口令为空 + autoSession 开着」会被判成 dirty
      // （生效值 false ≠ 草稿 true），保存按钮莫名其妙一直亮着。
      const cfgAutoSession = cfg ? wantedAutoSession(cfg) : true;
      const dirty = Boolean(cfg && draft) && (
        draft.enabled !== (cfg.enabled !== false)
        || draft.listenHost !== String(cfg.listenHost ?? '')
        || draft.listenPort !== String(cfg.listenPort ?? '')
        || draft.password !== String(cfg.password ?? '')
        || draft.forceLoopback !== (cfg.forceLoopback !== false)
        || draft.autoSession !== cfgAutoSession
      );

      const portText = draft ? draft.listenPort.trim() : '';
      const portBad = portText !== '' && (!/^\d+$/.test(portText) || Number(portText) > 65535);

      const onToggle = async () => {
        setBusy('toggle');
        setNote({ kind: '', text: '' });
        try {
          const res = await sendControl('toggle');
          if (!mounted.current) return;
          if (res && res.status) setSnap(res.status);
          if (res && res.ok !== true && res.error) {
            setNote({ kind: 'error', text: errorText(res.error) || String(res.error) });
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
            password: draft.password,
            forceLoopback: draft.forceLoopback,
            autoSession: draft.autoSession,
          });
          if (!mounted.current) return;
          if (res && res.ok === true) {
            if (res.status) {
              setSnap(res.status);
              if (res.status.config) setDraft(draftFrom(res.status.config));
            }
            setNote({ kind: 'ok', text: t('saveOk') });
          } else {
            setNote({ kind: 'error', text: t('saveFail') + (res && res.error ? '：' + res.error : '') });
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

      body.push(h('p', { key: 'intro', className: 'dsr-intro' }, t('description')));

      if (snap === null) {
        body.push(h('p', { key: 'loading', className: 'dsr-text' }, t('loading')));
      } else {
        const meta = stateMeta(snap);
        body.push(h('div', { key: 'ports', className: 'dsr-box' },
          h('div', { className: 'dsr-row' },
            h('span', { className: 'dsr-key' }, t('currentDshPort')),
            h('span', { className: 'dsr-val' }, snap.dshAddress || ('127.0.0.1:' + snap.dshPort)),
            h('button', { type: 'button', className: 'dsr-btn dsr-btnSm', onClick: () => onCopy(snap.dshAddress || ('127.0.0.1:' + snap.dshPort)) }, t('copy'))),
          h('div', { className: 'dsr-row' },
            h('span', { className: 'dsr-key' }, t('relayListen')),
            h('span', { className: 'dsr-val dsr-valSm' }, snap.listen.address),
            h('button', { type: 'button', className: 'dsr-btn dsr-btnSm', onClick: () => onCopy(String(snap.listen.port)) }, t('copy'))),
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
          }, busy === 'toggle' ? '…' : (snap.state === 'running' ? t('disable') : t('enable')))));

        // 自动会话的三种状态要一眼可分：生效 / 用户关掉 / 被「口令为空」压掉。
        // 第三种单独显示「已禁用」并附警告，避免用户以为开关坏了。
        const sess = snap.session || null;
        const sessBlocked = Boolean(sess && sess.blockedByEmptyPassword);
        const sessOn = Boolean(sess && sess.enabled === true);
        const sessLabel = sessBlocked
          ? t('blocked')
          : (sessOn ? t('on') : t('off'));

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
            h('span', { className: 'dsr-metricV' }, sess === null ? '—' : sessLabel))));

        const err = errorText(snap.lastError);
        if (err) body.push(h('div', { key: 'err', className: 'dsr-warn' }, '⚠ ' + err));
        if (!snap.hasPassword) body.push(h('div', { key: 'warn', className: 'dsr-warn' }, '⚠ ' + t('passwordEmptyWarn')));
        // 用户开了自动会话，但被「口令为空」这条硬约束压掉 —— 必须解释原因，
        // 否则 UI 上只看得到一个不生效的开关。
        if (sessBlocked) body.push(h('div', { key: 'sessBlocked', className: 'dsr-warn' }, '⚠ ' + t('autoSessionBlockedWarn')));
        // 开关是开的、也没被口令约束压掉，但密钥读不到 —— 这个失败是静默的，
        // 只在日志里，用户需要知道「为什么还是要 token」。
        if (sessOn && !sessBlocked && sess.ready !== true) {
          body.push(h('div', { key: 'sessNoKey', className: 'dsr-warn' }, '⚠ ' + t('autoSessionNoKey')));
        }
      }

      /* ---- 表单区 ---- */
      if (draft === null) {
        if (snap !== null) body.push(h('p', { key: 'nodraft', className: 'dsr-text' }, t('loading')));
      } else {
        const disabled = busy !== '';

        const textField = (field, label, hint, placeholder, extra) =>
          h('div', { key: field, className: 'dsr-field' },
            h('label', { className: 'dsr-label', htmlFor: 'dsr-' + mode + '-' + field }, label),
            h('input', {
              id: 'dsr-' + mode + '-' + field,
              className: 'dsr-input',
              type: 'text',
              value: draft[field],
              placeholder: placeholder,
              disabled: disabled,
              ...(extra || {}),
              onChange: (event) => setDraft((d) => ({ ...d, [field]: event.target.value })),
            }),
            h('p', { className: 'dsr-text' }, hint));

        const checkField = (field, label, hint) =>
          h('div', { key: field, className: 'dsr-field' },
            h('label', { className: 'dsr-check' },
              h('input', {
                type: 'checkbox',
                checked: draft[field] === true,
                disabled: disabled,
                onChange: (event) => setDraft((d) => ({ ...d, [field]: event.target.checked })),
              }),
              h('span', { className: 'dsr-label' }, label)),
            h('p', { className: 'dsr-text' }, hint));

        body.push(checkField('enabled', t('enabled'), t('enabledHint')));
        body.push(textField('listenHost', t('listenHost'), t('listenHostHint'), '127.0.0.1'));
        body.push(h('div', { key: 'listenPort', className: 'dsr-field' },
          h('label', { className: 'dsr-label', htmlFor: 'dsr-' + mode + '-listenPort' }, t('listenPort')),
          h('input', {
            id: 'dsr-' + mode + '-listenPort',
            className: 'dsr-input',
            type: 'text',
            inputMode: 'numeric',
            value: draft.listenPort,
            placeholder: '3091',
            disabled: disabled,
            onChange: (event) => setDraft((d) => ({ ...d, listenPort: event.target.value })),
          }),
          h('p', { className: portBad ? 'dsr-note dsr-err' : 'dsr-text' },
            portBad ? t('portInvalid') : t('listenPortHint'))));
        body.push(textField('password', t('password'), t('passwordHint'), ''));
        body.push(checkField('forceLoopback', t('forceLoopback'), t('forceLoopbackHint')));

        // 自动管理 dsh 会话：开关本身照原意保存（不会因口令为空被悄悄关掉），
        // 但生效与否受口令约束 —— 这里就地说明，避免用户以为开关坏了。
        body.push(checkField('autoSession', t('autoSession'), t('autoSessionHint')));
        if (draft.password === '') {
          body.push(h('p', { key: 'autoSessionBlocked', className: 'dsr-note dsr-err' },
            t('autoSessionBlockedWarn')));
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

      if (note.text) {
        body.push(h('p', {
          key: 'note',
          className: 'dsr-note' + (note.kind === 'error' ? ' dsr-err' : note.kind === 'ok' ? ' dsr-ok' : ''),
          role: 'status',
        }, note.text));
      }

      if (mode === 'section') {
        return h('section', { className: 'dsr-page' }, [
          h('h2', { key: 'h', className: 'dsr-heading' }, t('title')),
          ...body,
        ]);
      }
      return h('div', { className: 'dsr-page' }, body);
    }

    /* ═══════════════════ Cordis 插件形状 ═══════════════════ */

    function apply(ctx) {
      injectStyles();
      removeLegacyBadge();

      /**
       * 两个座位的注入面**都是空对象**：不声明任何服务依赖。
       *
       * 这是刻意设计 —— 一旦注入面里写了某个宿主不提供的服务名，该座位的
       * fiber 就永远停在不就绪状态，外壳不会挂载它，槽位账本里表现为
       * `active: false`，用户看到的就是「设置里根本没有这个插件」。
       * 面板的数据全部走自有的 /dsh-relay/* 路由，不需要任何服务。
       */
      const panel = (mode) => (props) => h(RelayPanel, {
        view: props && props.view,
        mode: mode,
      });

      let okCount = 0;

      // 座位 1：设置侧栏整页（主入口）
      try {
        const Section = panel('section');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dshRelay',
          order: 40,
          label: t('title'),
          inject: () => ({}),
        }, Section));
        okCount++;
      } catch (e) {
        console.error('[dsh-relay] settings.section 注册失败：', e);
      }

      // 座位 2：「设置 → 插件」里的配置卡片
      try {
        const Card = panel('card');
        ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: 'dshRelay',
          order: 60,
          label: t('title'),
          inject: () => ({}),
        }, Card));
        okCount++;
      } catch (e) {
        console.error('[dsh-relay] plugins.item 注册失败：', e);
      }

      try {
        ctx.logger?.info?.('[dsh-relay] 浏览器端已挂载（注册了 ' + okCount + ' 个设置座位，零服务依赖）');
      } catch (e) { /* 日志失败忽略 */ }
    }

    exports.name = 'dsh-relay';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
