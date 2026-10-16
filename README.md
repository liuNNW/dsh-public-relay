# dsh-public-relay — DSH Web 反向代理中转

配合 **樱花映射（Sakura Frp）TCP 内网穿透**，把本机 `dsh web` 安全地暴露到公网。

零第三方依赖，只用 Node.js 内置模块。

- **npm**：`dsh-public-relay`
- **仓库**：<https://github.com/liuNNW/dsh-public-relay>
- **许可证**：MIT

```sh
# 直接装（市场或 npm）
dsh plugin --profile web add dsh-public-relay
```

---

## 它解决什么问题

| 问题 | 本项目的处理 |
| --- | --- |
| 公网域名访问 dsh web，Host/Origin 校验被信任栅栏拦下 | 反向代理改写 `Host` / `Origin` 为上游回环权威，放行请求 |
| 公网访问时 dsh 判定「非本机」，设置平面降级为 memory（插件配置显示为空） | `--force-loopback` 拦截并改写 client bundle，让 `isLoopback` 恒为 true |
| dsh web 偶发崩溃后没人拉起 | 内置守护进程，崩溃自动重启 + 静默崩溃诊断 |
| 隧道暴露公网后无任何访问控制 | HMAC-SHA256 签名的会话 Cookie 口令认证 |
| 经隧道访问还得去找 dsh 打印的 `?token=` URL，否则一直 `authentication required` | **自动管理 dsh 会话**：按 dsh 的格式代签会话 Cookie，「只输中转口令 → 直接进入」（插件版；口令为空时强制关闭） |

---

## 快速开始

```bash
node dsh-public-relay.js
```

默认行为：

- 启动并守护 `dsh web` 子进程（监听 `127.0.0.1:3080`）
- 中转监听 `127.0.0.1:3081`，转发到 `http://127.0.0.1:3080`
- 访问口令 `20040915`
- 启用 `force-loopback`

**樱花映射隧道设置**：「本地端口」填 **3081**（即中转端口，不是 3080）。

---

## 命令行参数

```
node dsh-public-relay.js [选项]

--host <ip>          中转监听地址（默认 127.0.0.1）
--port <port>        中转监听端口（默认 3081）
--target <url>       上游 dsh web 地址（默认 http://127.0.0.1:3080）
--password <口令>    访问口令（默认 20040915；传空字符串可关闭认证）
--no-watchdog        不启动 dsh web 守护（只跑中转）
--no-force-loopback  关闭强制回环改写
--help               显示帮助
```

可用环境变量：`DSH_RELAY_HOST` / `DSH_RELAY_PORT` / `DSH_RELAY_TARGET`。

示例：

```bash
node dsh-public-relay.js --port 9000              # 换中转端口
node dsh-public-relay.js --password '自定义口令'    # 换口令
node dsh-public-relay.js --no-watchdog            # 只跑中转，dsh web 自己起
node dsh-public-relay.js --target http://127.0.0.1:3085
```

> 口令改为公网可猜的弱口令前请三思；`--password ''` 会完全关闭认证。

---

## 架构

```
公网浏览器
   │  (樱花映射隧道)
   ▼
dsh-public-relay.js  监听 127.0.0.1:3081
   ├─ authGate()          口令认证（Cookie 会话 / 登录页 / 401）
   ├─ handlePatchedBundle() force-loopback 时改写 client bundle
   ├─ handleRequest()     HTTP 反向代理
   └─ handleUpgrade()     WebSocket upgrade 代理
   │
   ▼
dsh web        127.0.0.1:3080（由守护进程托管）
```

### 核心模块

| 函数 | 职责 |
| --- | --- |
| `parseArgs()` | 参数与环境变量解析、端口合法性校验 |
| `resolveTarget()` | 上游 URL 规范化，产出连接参数 + 权威（authority/origin） |
| `rewriteHeaders()` | 改写 Host/Origin 过信任栅栏；剥离 hop-by-hop 头；upgrade 场景保留 Connection/Upgrade |
| `makeAuth()` | 生成/校验 HMAC-SHA256 签名 Cookie（7 天 TTL）、解析 Cookie、登录页模板 |
| `authGate()` | 统一认证入口：登录提交、登录页、401（HTTP 与裸 socket 双路径） |
| `handlePatchedBundle()` | 命中目标 bundle 时缓冲响应体，正则改写 `isLoopback` 后重新计算 Content-Length |
| `handleRequest()` | 常规 HTTP 代理，含 15s 上游连接超时与双向中断清理 |
| `handleUpgrade()` | WebSocket 透传，握手被拒时把上游状态码回传客户端 |
| `startDshWeb()` / `stopDshWeb()` | dsh web 守护：detached 进程组、崩溃重启、杀整棵进程树 |

### 认证设计

- Cookie 名 `relay_session`，格式 `payload.signature`（base64url）
- 签名：`HMAC-SHA256(HMAC-SHA256("dsh-public-relay", password), payload)`
- 校验用 `crypto.timingSafeEqual`，防时序侧信道
- 登录失败固定延迟 400ms，拖慢暴力破解
- Cookie 属性：`HttpOnly; SameSite=Lax; Path=/`

### 守护进程与静默崩溃诊断

`startDshWeb()` 用 `detached: true` 让子进程独立于父进程，Windows 下父进程退出不会连带杀掉 dsh web。退出时记录：

- 存活时长、stdout/stderr 行数、最后一行输出
- **静默崩溃**判定：非正常退出码 **且** stdout ≤ 1 行 **且** stderr 为 0 行 → 打印四条可能原因（杀毒拦截 / 原生模块崩溃 / 内存不足 / 内部 exit(1)）与三步排查指引，并扫描 `$DSH_HOME/logs` 下最新 3 个 dsh 日志
- 快速崩溃保护：30 秒内崩 3 次 → 暂停 30 秒再重启
- `exit code 0 / 130` 视为正常退出，不再重启

### 稳定性措施

- `uncaughtException` / `unhandledRejection` 全局捕获并记录，避免静默退出
- 60 秒心跳定时器（不 `unref()`）保证事件循环永不为空
- `clientError` 兜底返回 400，避免畸形请求崩溃
- 上游连接 15 秒超时；`req`/`res`/`proxyReq` 错误与关闭事件全链路 destroy 清理
- `SIGINT` / `SIGTERM` / `SIGHUP` 优雅关闭，3 秒兜底强退，防重复调用

---

## 插件版（推荐）：`plugin/`

同一个中转能力已经做成 **常驻 DSH 插件**，跑在 dsh 进程内，并能在设置页直接看到
**当前 dsh 的真实端口**、随时开关。

```powershell
# 安装（默认 desktop profile；任何一步失败自动回滚）
powershell -ExecutionPolicy Bypass -File plugin\install.ps1

# 装到 web profile
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Profile web

# 回滚
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Revert
```

装完**完全退出 dsh 再打开**（含系统托盘；Electron 关窗口不杀进程），然后：

1. **设置 → 插件 → 「DSH 中转」**：配置卡片，与「MiMo 视觉识别」同一位置同一形态。
   在这里改启用开关、监听地址/端口、访问口令、force-loopback
2. **设置 → 「DSH 中转」**：同一份配置的独立整页，另附端口信息与启停按钮

> 早期版本还有一个左下角悬浮角标，它压在侧栏「设置」按钮上导致设置点不开，已移除。
> 现在的入口只有上面两个，端口信息直接显示在卡片/整页里。

插件与独立脚本是两套实现，可以共存。完整的部署约束、排障与设计取舍见
[`plugin/dsh-public-relay/README.md`](plugin/dsh-public-relay/README.md)。

### 两个关键部署点（否则看不到面板）

**一、装到 profile 本地 `node_modules`，而不是共享目录。**
配置卡片依赖 schemastery 的 `.volatile()`（把字段投进设置表单），该方法只在 **3.18.4+** 存在：
共享目录 `profiles/node_modules` 是 3.18.1（没有），`profiles/desktop/node_modules` 是 3.18.4（有）。
安装在 profile 本地才会就近解析到正确版本。

**二、用 `cordis.patch.yml` 条目，而不是 `dsh.profile.bundles`。**
Electron 版 dsh 独占管理 desktop profile（其 CLI 直接拒绝 `--profile desktop --dump-config`，
报 `managed exclusively by the Electron application`），bundle 层的自动 insert 对它不生效。
实测只写 bundles 时，宿主里既没有插件的配置项、也没有它注册的工具，设置页自然看不到卡片。

诊断命令：

```powershell
node plugin\tools\diagnose.mjs
```

### 插件顺带修的问题：`dsh web` 起不来

`~/.dsh/profiles/web/cordis.patch.yml` 原本只有注释 → YAML 解析为 `null` → dsh 报
`must be a top-level YAML array of loader patch entries` 并拒绝启动 web profile。
**这就是 `dsh-web.log` 里那些「静默崩溃」的真因**（原脚本日志里那四条猜测全部落空）。

相关工具：

```powershell
node plugin\tools\fix-web-patch.mjs <path-to-cordis.patch.yml> [--check]  # 顶层非数组
node plugin\tools\repair-patch-array.mjs <path-to-cordis.patch.yml>       # 顶层多个文档
```

---

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `dsh-public-relay.js` | 独立脚本版主程序（守护进程 + 反向代理），零依赖 |
| `plugin/dsh-public-relay/` | 插件版（宿主半 + 浏览器半；npm 包本体） |
| `plugin/tools/` · `plugin/tests/` | 15 个诊断/修复工具 + 四套测试（合计 222 项断言） |
| `dsh-web.log` | dsh web 守护日志（运行时生成，已 gitignore） |
| `_relay_out.log` / `_relay_err.log` | 启动重定向输出（运行时生成，已 gitignore） |

---

## 排障

**公网能连但看不到插件列表**
`force-loopback` 依赖上游未压缩返回。若日志出现「上游响应已压缩，已按原样透传」，说明 bundle 改写未生效 → 浏览器 `Ctrl+F5` 硬刷新；仍无效则检查 dsh 是否升级导致正则失配（日志会打「未找到目标模式」）。
插件版会在 `lib/relay.js` 的 `LOOPBACK_PATTERNS` 里依次尝试候选正则，并把失配告警打到 UI 上。

**502 Bad Gateway**
上游 `dsh web` 没起来。看 `dsh-web.log` 确认守护是否在重启循环里。
若日志显示「静默崩溃」，先按上面的办法检查 `web/cordis.patch.yml` 是否为合法 YAML 数组。

**端口被占用**
脚本版：`EADDRINUSE` 会直接退出并提示换端口：`--port 9000`。
插件版：不会退出，UI 上显示「端口被占用」，换个端口即可。

**登录页打不开 / 一直 401**
口令错了，或浏览器带了旧的 `relay_session` Cookie（清掉即可）。

**经隧道访问时一直提示 `dsh web authentication required`**
插件版已默认解决：它会按 dsh 的格式**代签会话 Cookie**，因此「打开隧道地址 → 只输中转口令 → 直接进入」。
这条能力由 `autoSession` 控制（默认开，**口令为空时强制关闭**）。
若仍要 `?token=`，看设置页状态区的「自动会话」指标 —— 它会直接说明是「口令为空被禁用」还是「读不到密钥」。
细节与安全边界见 [`plugin/dsh-public-relay/README.md`](plugin/dsh-public-relay/README.md#自动管理-dsh-会话autosession)。

**`install.ps1` 报语法错误（`The token '||' is not a valid statement separator` 等）**
Windows PowerShell 5.1 按系统 ANSI 代码页读无 BOM 脚本，而本脚本是 UTF-8。保持该文件为
**UTF-8 带 BOM** 即可；诊断与修法见插件文档的排障节。用 PowerShell 7 跑不受影响。

---

## 提交约定

每轮对话结束时提交**一次** git：一次提交 = 一轮完整改动，不要拆成多个碎提交，也不要攒着不提交。

提交信息统一用「前缀 + 三段正文」，正文只写真实发生的事：

```
<type>: <一句话概括这一轮做了什么>

操作：
- 按可验证的动作逐条写（例：把 isLoopback 正则从 1 条扩成 3 条候选）
- 不写「优化了一下」这类无法核对的话

文件：
- path/to/a.js — 改了什么
- path/to/b.js — 改了什么

优化：
- 行为 / 性能 / 可维护性上的实际变化
- 附上验证结果（例：node plugin\tests\smoke.mjs 54 项全绿）
- 没有实质优化就写「无」
```

`<type>` 取值：`feat` 新功能 / `fix` 修 bug / `docs` 文档 / `refactor` 重构 / `test` 测试 / `chore` 杂项。

约定：不主动 `git push`（本仓库暂无 remote）；改完先跑测试再提交；运行时产物（`*.log`、`.mimocode/`、`plugin/dsh-public-relay/node_modules/`）已在 `.gitignore` 里，不入库。

---

## 依赖

脚本版：Node.js 内置模块（`http` / `crypto` / `url` / `child_process` / `fs` / `path` / `os`）。
插件版：同样零第三方依赖，可选使用 `@deepseek-ai/dsh-tools` 注册全局工具。
两者都不需要 `npm install`。

