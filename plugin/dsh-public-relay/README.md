# dsh-public-relay — DSH 中转插件

把本机 dsh 的端口反向代理出去，配合内网穿透（樱花映射 / frp）从公网访问 dsh 界面。
常驻插件形态：随 dsh 启动加载，在**本进程内**跑中转，设置页里能看当前真实端口、随时启停。

- **npm**：`dsh-public-relay`
- **仓库**：<https://github.com/liuNNW/dsh-public-relay>
- **许可证**：MIT
- 零第三方依赖（只用 Node 内置模块 + 浏览器侧 `react`）

> **0.2.0 是围绕 dsh 0.2.x 的重写。** 三条实质变化：
> 1. 安装走**标准 bundle 通道**，不再手改 profile 的 `cordis.patch.yml`；
> 2. 配置由插件**自己的 JSON 文件**持有，不再依赖 dsh 的 settings 命名空间；
> 3. `isLoopback` 改写成**结构化扫描**，dsh 换写法也不会静默失效。
>
> 详见 [0.2.0 改了什么](#020-改了什么)。

---

## 它做什么

| 能力 | 说明 |
| --- | --- |
| **显示当前 dsh 端口** | 取本进程 `ctx.webServer.port` / `.host` 的实时值，不硬编码。dsh 换端口后 UI 自动跟着变 |
| **随时启用 / 关闭** | 设置页里一键切换。停用会**真正释放监听端口**，不需要重启 dsh |
| **Host/Origin 改写** | 过 dsh 的信任栅栏；公网域名访问不再被 403 拦下 |
| **force-loopback** | 把客户端 bundle 里的 `isLoopback` 判定改成恒真，公网域名下 dsh 仍认为自己是本机（插件列表不降级） |
| **自动管理 dsh 会话** | 按 dsh 的格式代签会话 Cookie：打开中转地址 → 只输中转口令 → 直接进入，不必再找 dsh 打印的 `?token=` URL。口令为空时自动禁用 |
| **口令认证** | HMAC-SHA256 签名 Cookie，`timingSafeEqual` 校验，失败固定延时 400ms |
| **WebSocket 透传** | 会话实时推送正常穿透中转 |
| **全局工具** | `relay_status` / `relay_control`，任何会话里都能让模型查端口、开关中转 |

---

## 界面在哪

两个入口，共用同一份配置（同一份 JSON 文件）：

1. **设置 → 「DSH 中转」** —— 独立整页，主入口。端口信息 + 启停 + 完整表单。
2. **设置 → 插件 → DSH 中转 → 配置** —— 本插件那一行的**行级配置页**。

这两个座位是 `settings.section` 与 `plugins.row.config`（后者按 key
`<包名>#<行 id>` 由插件页分发）。两个座位的注入面**刻意留空** —— 一旦声明了宿主
不提供的服务，座位 fiber 就永远不就绪，用户看到的是「设置里根本没有这个插件」。

状态区有六个指标：活动连接 / 已处理请求 / 运行时长 / 口令认证 / **自动会话** / 已改写脚本数。
自动会话三种状态互不混淆，因为这是最容易误判的地方：

| 显示 | 含义 |
| --- | --- |
| `已开启` | 代签生效，输完中转口令直接进 |
| `已关闭` | 用户主动关掉了这个功能 |
| `已禁用` | 用户开着，但被「口令为空」这条硬约束压掉了（附警告说明） |

开关开着却没读到 dsh 会话密钥时，状态区也会直接提示 —— 这个失败只在日志里，
不提示的话用户只会看到「还是要 token」而找不到原因。

---

## 安装

### 方式 A：官方 CLI（发布到 npm 后）

```sh
dsh plugin --profile <profile> add dsh-public-relay
```

### 方式 B：本地目录（本仓库，未发布也能装）

用 dsh 的 `plugin_manager`（`install_bundle`）指向包目录，或在 GUI 里
「设置 → 插件 → 安装本地插件」选该目录：

```
<repo>/plugin/dsh-public-relay
```

### 自检 / 清理

```powershell
# 自检：manifest 兼容性 + 所有 lib/*.js 语法 + 四套测试（共 222 项断言）
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Check

# 尝试用官方 CLI 安装
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Install

# 清理「早期手工安装方式」留下的残留（旧 patch 条目 / node_modules 副本）
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Revert
```

> 从 `-Install` / 上面的命令都**不会**改 profile 的 `cordis.patch.yml`。
> 装完重启 dsh 生效；之后启停都不用重启。

### 一个必须知道的前置条件

如果旧版本用**手工方式**装过（往 profile 的 `cordis.patch.yml` 里写过
`- insert: [{ id: dsh-public-relay, ... }]` 或拷过 `node_modules/dsh-public-relay`），
**必须先清掉**，否则同一个 id 会被插入两次，Loader 按重复 id 报冲突：

```powershell
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Revert
```

`-Revert` 只清那两种残留，不会动 bundle 通道装的版本（那个由 dsh 自己管理）。

---

## 配置

**唯一权威来源是插件自己的 JSON 文件**，落在 profile 目录下：

```
$DSH_HOME/profiles/<profile>/dsh-public-relay.json
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | dsh 启动时自动开始中转 |
| `listenHost` | `127.0.0.1` | 中转监听地址。`0.0.0.0` 会让局域网直接可达 |
| `listenPort` | `3091` | 隧道「本地端口」填这个。`0` 让系统分配 |
| `password` | `''` | 访问口令。留空 = 关闭认证（公网暴露时务必非空） |
| `forceLoopback` | `true` | 是否改写客户端 bundle 的 `isLoopback` |
| `autoSession` | `true` | 是否代签 dsh 会话（口令为空时强制不生效） |
| `targetHost` / `targetPort` | 空 / `0` | 高级项：代理**另一个** dsh 实例时用。不进表单 |

`cordis.patch.yml` 里的 `config:` 只作为**首次启动的种子**（文件不存在时用它初始化并落盘）。

### 为什么不用 dsh 的 settings 命名空间

0.1.x 时代靠 schemastery 的 `.volatile()` 把字段投进设置页自动表单。那条路在 0.2.x
两个层面都不可靠：

1. `.volatile()` 的提交链路绑定在「由宿主自己那份 schemastery 构建出来的 schema」上；
   第三方包用别处的副本会**静默丢掉每一次实时写入**（写入报成功，生效值从不变化）。
2. 第三方命名空间不在 api-proxy 的 exposedNamespaces 白名单里，浏览器端配置客户端读不到。

改成自有 JSON 文件后，配置能力与 dsh 版本、schemastery 版本、settings 服务是否存在**全部解耦**。

---

## `autoSession` 的安全硬约束

代签等价于「中转持有 dsh 的会话密钥」，所以**口令为空时代签强制不生效**（不是靠用户自觉）：

- 存储里保留的是「用户原意」，不是生效值 —— 否则口令一清空，开关会被偷偷关掉且无法恢复
- UI 上显示为「已禁用」并给出原因，而不是「已关闭」
- 代签失败一律**不注入**并原样转发：退回「用 dsh 打印的 `?token=`」，不让失败的代签变成完全进不去

dsh 的 Cookie 格式（从 `dsh-client-connection` 复刻）：

```
Cookie 名 = 'dsh-auth-' + base64url(sha256(authority))
Cookie 值 = 'v1.' + base64url(json({version, authority, issuedAt, expiresAt})) + '.' + base64url(hmacSha256(secret, body))
```

密钥取自 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录
（首次创建后持久不变，所以读文件即可，不必 hook dsh 进程）。

---

## `force-loopback` 怎么工作

dsh 的客户端连接模块里有这样一段：

```js
isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),
```

经隧道访问时 `pageLocation.hostname` 是公网域名，`isLoopback` 判 false，于是 dsh 认为
「不是本机」，设置平面降级为 memory、插件列表变空。

绕过方式是把这个值改成恒 `true`。**改写逻辑（0.2.0 重写）**：

1. 找键名 `isLoopback:`（且前面必须是 `{` `,` `(` 或空白 —— 保证是对象字面量里的键）
2. 从冒号后开始按 `()[]{}` 深度扫描，跳过字符串字面量，找出整个值表达式
3. 值里必须出现 `isLoopback` / `ownsHost` / `pageLocation` 之一（第二道闸门，防误伤）
4. 整段替换成 ` true`

**为什么不继续用候选正则**：0.1.x 用三条正则匹配 dsh 的原文，dsh 一改写法（0.2.x 就在
判据前加了 `transport?.ownsHost === true ||`）就失配，而且症状是静默的 ——
日志只有一句「未找到目标模式」，公网侧插件列表悄悄变空。结构化扫描与写法无关。

改写范围也从「某个固定文件路径」改成「`/plugins/` 下、content-type 是 JavaScript 的响应」——
0.2.x 的客户端 bundle 走 combo URL（`/plugins/??a/client.js,b/client.js&rev=…`），
单资源路径不再是唯一形态。SSE（`/plugins/events`）不会被缓冲，因为 content-type 不是 JS。

> 0.2.x 起 dsh 自身支持 `trustedHosts` 配置，是更正式的解法。能配 trustedHosts
> 就可以把这一项关掉。

---

## 与樱花映射 / frp 配合

1. 插件设置里记下「中转监听」的端口（默认 `3091`）
2. 隧道客户端里「本地端口」填**中转端口**（不是 dsh 端口）
3. 公网打开隧道地址 → 输入中转口令 → 直接进入 dsh

---

## 排障

**公网能连但看不到插件列表**
`force-loopback` 没生效。看状态区的「已改写脚本」计数：一直是 0 说明上游没返回可识别的
JS（检查 dsh 是否改成了压缩返回 —— 日志会有「上游响应已压缩，已按原样透传」）。
先 `Ctrl+F5` 硬刷新；仍无效则看日志里的 `没有 isLoopback 字段` 提示。

**502 Bad Gateway**
上游 dsh 没起来，或端口不对。状态区的「上游目标」直接显示当前指向。

**端口被占用**
不会退出进程，状态区显示「端口被占用」。换个端口即可。

**登录页打不开 / 一直 401**
口令错了，或浏览器带了旧的 `relay_session` Cookie（清掉即可）。

**经隧道访问时一直提示 `dsh web authentication required`**
状态区的「自动会话」指标会直接说明是「口令为空被禁用」还是「读不到密钥」，
不用猜。读不到密钥时确认 `$DSH_HOME/.credentials.yaml` 存在且含
`client-connection/browser-session` 记录。

**`install.ps1` 报语法错误（`The token '||' is not a valid statement separator` 等）**
Windows PowerShell 5.1 按系统 ANSI 代码页读无 BOM 脚本，而本脚本是 UTF-8。
保持该文件为 **UTF-8 带 BOM** 即可；用 PowerShell 7 跑不受影响。

**设置里完全没有这个插件**
按顺序查：
1. `plugin_manager list_plugins` 里 `include:dsh-public-relay` 的 `fiberPhase` 是否为 `active`
2. 若为 `absent`/`null`：manifest 被判 `incompatible-version`（跑 `check-compat.mjs`）
3. 若 `active` 却没有 UI：客户端 bundle 没加载（看 index 的 boot graph 里有没有
   `dsh-public-relay/client.js`）

---

## 开发

```powershell
# 四套测试
node plugin\tests\smoke.mjs              # 中转核心 63 项
node plugin\tests\host-integration.mjs   # 宿主半 53 项
node plugin\tests\client-half.mjs        # 浏览器半 62 项
node plugin\tests\dsh-session.spec.mjs   # 会话代签 52 项

# 兼容性自检
node plugin\tools\check-compat.mjs plugin\dsh-public-relay\package.json

# 读 dsh 的 app.asar（grep / 列目录 / 取文件）
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" grep "<正则>" [路径前缀]
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" ls  [路径前缀]
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" cat <内部路径>
```

### 0.2.0 改了什么

| 方面 | 0.1.x | 0.2.0 |
| --- | --- | --- |
| 安装 | 手改 profile `cordis.patch.yml` + 拷 `node_modules` | 标准 bundle 通道（`dsh plugin add` / `install_bundle`） |
| 配置 | settings 命名空间 + schemastery `.volatile()` | 自有 JSON 文件（`<profile>/dsh-public-relay.json`） |
| 宿主导出 `Config` | 有（依赖 volatile 链路） | **去掉**（在 0.2.x 不可靠） |
| 设置入口 | `settings.section` + `plugins.item` | `settings.section` + `plugins.row.config` |
| `isLoopback` 改写 | 三条候选正则 | 结构化扫描（按括号深度取值表达式） |
| 改写范围 | 固定单文件路径 | `/plugins/` 下 content-type 是 JS 的响应（含 combo URL） |
| 令牌交换转发 | 单独分支，与统一转发矛盾 | 只在「不代签」时走保留 authority 的路径 |
| 兼容性声明 | `dshTarget` + 宽松 peers | 不声明 `engines.dsh` / dsh-* peers → 恒通过（`dshTarget` 已证实 dsh 不读，删除） |
| 配置文件位置 | — | `profileContext.dir`（不是 `$DSH_HOME` 根） |

---

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | 宿主半：配置读写、`/dsh-public-relay/*` 路由、启停编排、全局工具 |
| `lib/relay.js` | 中转核心（纯库）：反向代理 + 口令认证 + `isLoopback` 改写 |
| `lib/dsh-cookie.js` | 按 dsh 的格式代签会话 Cookie |
| `lib/config.js` | 配置契约：默认值、归一化、可落盘形状 |
| `lib/client.js` | 浏览器半：两个设置座位 + 自绘表单（无需构建） |
| `cordis.patch.yml` | bundle 补丁层（一条 insert，带聚合双重挂载保护） |
| `locale/{zh,en}.json` | 插件列表里显示的标题/描述 |
| `icon.svg` | 插件图标 |

---

## 依赖

运行时只用 Node 内置模块（`node:http` / `node:crypto` / `node:fs` / `node:path` / `node:os`）；
浏览器半只用外壳提供的 `react`。**不需要 `npm install`，没有构建步骤。**
