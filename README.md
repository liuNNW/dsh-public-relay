# dsh-public-relay — DSH 公网访问中转

配合 **樱花映射（Sakura Frp）/ frp 等 TCP 内网穿透**，把本机 dsh 安全地暴露到公网。

两种形态，同一套中转能力：

| 形态 | 适合 | 入口 |
| --- | --- | --- |
| **DSH 插件**（推荐） | 日常使用。跑在 dsh 进程内，设置页里看端口、随时开关 | [`plugin/dsh-public-relay`](plugin/dsh-public-relay) |
| **独立脚本** | 不想装插件、或要用它的 `dsh web` 守护 | [`dsh-public-relay.js`](dsh-public-relay.js) |

- **npm**：`dsh-public-relay`
- **仓库**：<https://github.com/liuNNW/dsh-public-relay>
- **许可证**：MIT
- **零第三方依赖**：只用 Node.js 内置模块（插件版浏览器半只用外壳提供的 `react`），无构建步骤

```sh
dsh plugin --profile desktop add dsh-public-relay
```

---

## 它解决什么问题

| 问题 | 本项目的处理 |
| --- | --- |
| 公网域名访问 dsh，Host/Origin 被信任栅栏拦下 → 403 | 反向代理把 `Host` / `Origin` 改写为上游回环权威 |
| 公网访问时 dsh 判定「非本机」，设置平面降级、插件列表变空 | `force-loopback`：把客户端 bundle 里的 `isLoopback` 判定改成恒真 |
| 经隧道访问还得去找 dsh 打印的 `?token=` URL，否则一直 `authentication required` | **自动代签 dsh 会话**：按 dsh 的格式签 Cookie →「只输中转口令 → 直接进入」（口令为空时强制关闭） |
| 隧道暴露公网后没有任何访问控制 | HMAC-SHA256 签名的会话 Cookie 口令认证 |
| dsh web 偶发崩溃后没人拉起（仅脚本版） | 内置守护进程：崩溃自动重启 + 静默崩溃诊断 |

---

## 快速开始

### 插件版（推荐）

```sh
# 1. 装
dsh plugin --profile desktop add dsh-public-relay

# 2. 完全退出 dsh 再打开（含系统托盘；Electron 关窗口不杀进程）
```

然后在 **设置 → 「DSH 中转」** 里：

1. 把「中转监听端口」记下来（默认 `3091`）
2. 填一个**访问口令**（留空等于关闭认证，公网暴露时务必填）
3. 隧道客户端的「本地端口」填**中转端口**（不是 dsh 端口）
4. 公网打开隧道地址 → 输口令 → 直接进入

配置项与排障见 [`plugin/dsh-public-relay/README.md`](plugin/dsh-public-relay/README.md)。

### 独立脚本版

```sh
node dsh-public-relay.js
```

默认行为：守护 `dsh web` 子进程（`127.0.0.1:3080`）、中转监听 `127.0.0.1:3081`、
启用 `force-loopback`、**启动时随机生成访问口令并打印到控制台**。

```
node dsh-public-relay.js [选项]

--host <ip>          中转监听地址（默认 127.0.0.1）
--port <port>        中转监听端口（默认 3081）
--target <url>       上游 dsh web 地址（默认 http://127.0.0.1:3080）
--password <口令>    访问口令（默认留空 → 随机生成并打印；传空字符串可完全关闭认证）
--no-watchdog        不启动 dsh web 守护（只跑中转）
--no-force-loopback  关闭强制回环改写
--help               显示帮助
```

环境变量：`DSH_RELAY_HOST` / `DSH_RELAY_PORT` / `DSH_RELAY_TARGET` / `DSH_RELAY_PASSWORD`。

示例：

```bash
node dsh-public-relay.js --port 9000                    # 换中转端口
node dsh-public-relay.js --password '自定义口令'          # 固定口令
node dsh-public-relay.js --no-watchdog                  # 只跑中转
node dsh-public-relay.js --target http://127.0.0.1:3085 # 换个上游
```

> **口令安全**：本项目**不含**任何硬编码默认口令。不传 `--password` 时每次启动
> 随机生成并打印一个，记下来后用 `--password` 或 `DSH_RELAY_PASSWORD` 复用。
> `--password ''` 会完全关闭认证 —— 只在受信网络里这么做。

**樱花映射隧道设置**：「本地端口」填**中转端口**（3081 或插件里的 3091），不是 3080。

---

## 架构

```
公网浏览器
   │  (隧道：樱花映射 / frp)
   ▼
中转（插件版：跑在 dsh 进程内 / 脚本版：独立进程）
   ├─ authGate()            口令认证（Cookie 会话 / 登录页 / 401）
   ├─ 会话代签              按 dsh 格式注入 dsh-auth-* Cookie
   ├─ force-loopback        改写客户端 bundle 的 isLoopback
   ├─ handleRequest()       HTTP 反向代理（Host/Origin 改写）
   └─ handleUpgrade()       WebSocket upgrade 代理
   │
   ▼
dsh 自身监听端口（插件版：热读 ctx.webServer；脚本版：由守护进程托管）
```

### 认证设计

- Cookie 名 `relay_session`，值 `payload.signature`（base64url）
- 签名 `HMAC-SHA256(HMAC-SHA256("dsh-public-relay", password), payload)`
- 校验用 `crypto.timingSafeEqual`，防时序侧信道
- 登录失败固定延时 400ms，拖慢暴力破解
- Cookie 属性 `HttpOnly; SameSite=Lax; Path=/`，7 天 TTL

### `force-loopback` 怎么改写

dsh 的客户端连接模块里有：

```js
isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),
```

经隧道访问时页面地址是公网域名，这项判 `false`，于是 dsh 认为「不是本机」，
设置平面降级为 memory、插件列表变空。

改写方式（插件版 0.2.0 起）：定位 `isLoopback:` 键 → 按 `()[]{}` 深度跳过字符串
字面量取出整个值表达式 → 整段替换为 `true`。与 dsh 具体怎么写这个表达式无关，
dsh 升级换写法也不会静默失效。

> dsh 0.2.x 起自带 `trustedHosts` 配置，是更正式的解法。能配 trustedHosts 就可以关掉这一项。

---

## 仓库结构

```
dsh-public-relay.js              独立脚本版（守护进程 + 反向代理）
plugin/
  dsh-public-relay/              插件版（npm 包本体）
    lib/index.js                 宿主半：配置、路由、启停编排、全局工具
    lib/relay.js                 中转核心：代理 + 认证 + isLoopback 改写
    lib/dsh-cookie.js            按 dsh 格式代签会话 Cookie
    lib/config.js                配置契约
    lib/client.js                浏览器半：两个设置座位 + 自绘表单
    cordis.patch.yml             bundle 补丁层
    locale/{zh,en}.json          插件列表展示元数据
  install.ps1                    自检 / 安装指引 / 旧安装残留清理
  tools/                         诊断与开发工具
  tests/                         五套测试（248 项断言）
```

---

## 开发

```powershell
# 五套测试
node plugin\tests\smoke.mjs              # 中转核心      76 项
node plugin\tests\host-integration.mjs   # 宿主半        53 项
node plugin\tests\client-half.mjs        # 浏览器半      62 项
node plugin\tests\dsh-session.spec.mjs   # 会话代签      52 项
node plugin\tests\password-modes.mjs     # 口令模式       5 项

# 一键自检（manifest 兼容性 + 语法 + 四套测试）
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Check

# 兼容性自检（最容易踩、症状最隐蔽的坑）
node plugin\tools\check-compat.mjs plugin\dsh-public-relay\package.json

# 读 dsh 的 app.asar（ls / cat / grep）
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" grep "<正则>" [路径前缀]
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" ls  [路径前缀]
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" cat <内部路径>
```

### 插件安装 / 清理

```powershell
# 自检
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Check

# 用官方 CLI 装
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Install

# 清理「早期手工安装方式」的残留（旧 patch 条目 / node_modules 副本）
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Revert
```

未发布到 npm 时，用 dsh 的 `plugin_manager`（`install_bundle`）指向
`plugin/dsh-public-relay` 目录即可；GUI 里是「设置 → 插件 → 安装本地插件」。

### 兼容性判据（已从 dsh 0.2.1-rc.2 源码核实）

`dsh-app-boot` 的 `evaluatePluginCompatibility()`：

1. 有 `engines.dsh` → **只看它**，`peerDependencies` 整个被忽略
2. 没有 `engines.dsh` → 逐个检查名字形如 `@deepseek-ai/dsh-*` 的 peer；其余不看
3. `peerDependenciesMeta.optional` **不参与判定** —— 标了 optional 的 dsh-* peer 照样校验
4. 两者都不声明 → 恒通过

判 `incompatible-version` 的症状极具误导性：dsh 正常启动、日志不报错、插件文件都在，
但 **rows 为空、UI 上哪里都看不到这个插件**，重启多少次都没用。本插件属第 4 种。

---

## 排障

**公网能连但看不到插件列表**
`force-loopback` 没生效。看插件状态区的「已改写脚本」计数：一直是 0 说明上游没返回
可识别的 JS。先 `Ctrl+F5` 硬刷新。或直接改用 dsh 的 `trustedHosts`。

**502 Bad Gateway**
上游 dsh 没起来，或端口不对。插件状态区的「上游目标」直接显示当前指向。

**端口被占用**
脚本版会 `EADDRINUSE` 退出并提示换端口；插件版不退出，状态区显示「端口被占用」。

**登录页打不开 / 一直 401**
口令错了，或浏览器带了旧的 `relay_session` Cookie（清掉即可）。

**经隧道访问时一直提示 `dsh web authentication required`**
插件状态区的「自动会话」指标会直接说明是「口令为空被禁用」还是「读不到密钥」。
读不到密钥时确认 `$DSH_HOME/.credentials.yaml` 含 `client-connection/browser-session` 记录。

**`install.ps1` 报语法错误（`The token '||' is not a valid statement separator` 等）**
Windows PowerShell 5.1 按系统 ANSI 代码页读无 BOM 脚本，而本脚本是 UTF-8。
保持该文件为 **UTF-8 带 BOM** 即可；用 PowerShell 7 跑不受影响。

**设置里完全没有这个插件**
1. `plugin_manager list_plugins` 里 `include:dsh-public-relay` 的 `fiberPhase` 是否为 `active`
2. 若为 `absent`/`null`：manifest 被判 `incompatible-version`（跑 `check-compat.mjs`）
3. 若 `active` 却没有 UI：客户端 bundle 没加载（看 index 的 boot graph 里有没有
   `dsh-public-relay/client.js`）

---

## 提交约定

每轮对话结束时提交**一次** git：一次提交 = 一轮完整改动，不要拆成多个碎提交。

提交信息统一用「前缀 + 三段正文」，正文只写真实发生的事：

```
<type>: <一句话概括这一轮做了什么>

操作：
- 按可验证的动作逐条写
- 不写「优化了一下」这类无法核对的话

文件：
- path/to/a.js — 改了什么

优化：
- 行为 / 性能 / 可维护性上的实际变化
- 附上验证结果（例：node plugin\tests\smoke.mjs 76 项全绿）
- 没有实质优化就写「无」
```

`<type>`：`feat` 新功能 / `fix` 修 bug / `docs` 文档 / `refactor` 重构 / `test` 测试 / `chore` 杂项。

约定：改完先跑测试再提交；运行时产物（`*.log`、`.mimocode/`、`node_modules/`）已在
`.gitignore` 里，不入库。

---

## 依赖

脚本版：Node.js 内置模块（`http` / `crypto` / `url` / `child_process` / `fs` / `path` / `os`）。
插件版：同样零第三方依赖；浏览器半只用外壳提供的 `react`。

两者都**不需要 `npm install`，没有构建步骤**。
