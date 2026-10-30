# dsh-public-relay — DSH 公网访问中转

配合 **樱花映射（Sakura Frp）/ frp 等 TCP 内网穿透**，把本机 dsh 安全地暴露到公网。

两种形态，同一套中转能力：

| 形态 | 适合 | 入口 |
| --- | --- | --- |
| **DSH 插件**（推荐） | 日常使用。跑在 dsh 进程内，设置页里看端口、随时开关 | [`plugin/dsh-public-relay`](plugin/dsh-public-relay) |
| **独立脚本** | 不想装插件、或要用它的 `dsh web` 守护 | [`dsh-public-relay.js`](dsh-public-relay.js) |

- **当前版本**：`0.3.5`
- **npm**：`dsh-public-relay`
- **仓库**：<https://github.com/liuNNW/dsh-public-relay>
- **许可证**：MIT
- **零第三方依赖**：只用 Node.js 内置模块（插件版浏览器半只用外壳提供的 `react`），无构建步骤

```sh
dsh plugin --profile desktop add dsh-public-relay
```

**目录**

- [它解决什么问题](#它解决什么问题) · [快速开始](#快速开始) · [架构](#架构)
- 设计：[超时语义](#超时语义连接与响应分开032) · [认证](#认证设计) · [管理路由鉴权](#管理路由的鉴权) · [会话代签](#会话代签的权限边界) · [`?token=` 验真](#token-放行必须验真031) · [`force-loopback`](#force-loopback-怎么改写)
- 开发：[测试与自检](#开发) · [工具索引](#工具索引) · [安全审计](#安全审计工具)
- 排查：[隧道连通性](#隧道连通性排查) · [桌面端 405](#桌面端请求排查405-路由缺失) · [排障清单](#排障)

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
   ├─ authGate()            口令认证（Cookie 会话 / 登录页 / 限流 / 401）
   ├─ 会话代签              按 dsh 格式注入 dsh-auth-* Cookie
   ├─ force-loopback        改写客户端 bundle 的 isLoopback
   ├─ handleRequest()       HTTP 反向代理（Host/Origin 改写）
   └─ handleUpgrade()       WebSocket upgrade 代理（帧级 + 压缩）
   │
   ▼
dsh 自身监听端口（插件版：热读 ctx.webServer；脚本版：由守护进程托管）
```

两种形态**共用 `lib/` 的同一份实现**。独立脚本曾有一份手抄副本，审计发现其中 6 个安全
问题（CRLF 注入、免认证 body 累积、无登录限流、Cookie 缺 `Secure`、`force-loopback` 认不出
combo URL、WebSocket 丢首帧）全部源于两份实现的漂移 —— 逐条修库版不能根治，只要副本还在，
下次修库它就漂移回去。现已删除全部手抄代码，脚本 `import` 库。

### 超时语义：连接与响应分开（0.3.2）

转发到上游时有**两个**独立的超时，不要混为一谈：

| 常量 | 默认 | 管什么 |
| --- | --- | --- |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | 15s | DNS + TCP + 等到 socket 就绪。**不覆盖**等响应 |
| `UPSTREAM_RESPONSE_TIMEOUT_MS` | 5 分钟 | socket 就绪后，等**响应头**的上限。响应体开始传输后即不再计时 |

**为什么必须分开**（0.3.1 及以前的 bug）：

旧实现只有一个 15s 定时器，且直到收到 `response` 才 `clearTimeout` —— 于是「连接超时」
实际成了**整个请求的总时限**。任何上游响应慢于 15s 的请求都被 `destroy`，回 502
`upstream connect timeout`（而连接明明是好的）。

受害最重的是 `session/prompt`：它是发起 AI 对话，正常就要几十秒到几分钟。经中转时必然
在 15s 被掐断，表现成「一操作就失败」，极易被误判成认证问题。

反过来也**不能**简单地把定时器一到 socket 就清掉：上游若是「TCP 连得上但永不应答」
（进程挂死），请求会永久悬挂。所以拆成两段，各管一段。

响应体传输阶段**不设总时限** —— 长任务/流式输出由客户端 abort/close 决定何时放弃。
`plugin/tests/long-request.spec.mjs` 锁定了这三条不变量。

### 认证设计

中转口令是暴露到公网的**唯一**边界，所有认证原语集中在 `lib/auth.js`，宿主半与中转共用。

- Cookie 名 `relay_session`，值 `payload.signature`（base64url）
- 签名 `HMAC-SHA256(HMAC-SHA256("dsh-public-relay", password), payload)`
- 校验用 `crypto.timingSafeEqual`；登录口令先两侧哈希再比，避免长度差异
- Cookie 属性 `HttpOnly; SameSite=Lax; Path=/`，7 天 TTL；隧道走 HTTPS 时自动加 `Secure`
- 登录失败固定延时 400ms，外加**滑动窗口限流**（同 IP 5 分钟内 8 次失败即 429）

限流键默认取 `socket.remoteAddress`。**只有当直连对端本身是回环地址**（即确实有隧道
或反代夹在中间）才读 `x-forwarded-for`，并取**最后一项** —— 隧道追加的是链尾才是真实
来源。反代不校验 XFF 的话，攻击者每次换一个伪造 XFF 就能重置计数器，限流形同虚设。
代价是隧道场景下所有客户端共享「隧道出口 IP」这一个键，限流偏严而非偏松。

### 管理路由的鉴权

`/dsh-public-relay/config` 与 `/dsh-public-relay/control` 改的是监听地址、上游目标
和口令，**必须比普通请求更严**。通过条件（满足其一）：

1. **桌面外壳**：`Origin` 精确等于 `dsh-app://app`，且对端是回环
2. 中转口令派生的 bearer token（`Authorization: Bearer …`）或有效的 `relay_session` Cookie
3. 口令为空时：仅回环对端

此外**任何**一条都还要过同源校验（`Origin` 的 host 等于 `Host`，或对端是回环 / 无 Origin）。

仅靠 Origin 是不够的 —— 中转会把每个转发请求的 `Host`/`Origin` 改写成上游回环权威，
所以经公网进来的请求在 dsh 侧「Origin == Host」按构造必然成立。

> **为什么桌面外壳要豁免**（0.3.4）：设置页的每个按钮都走这两条路由，而它的 `fetch`
> **拿不到口令** —— 口令是 write-only、从不回填，前端无从派生 bearer。0.2.3 加入
> bearer 要求时没有同步给前端补上凭据，于是口令一旦设置，设置页写操作**永远 403**
> （表现为「保存/停用点了没反应」）。
>
> 豁免是安全的：`dsh-app://app` 是 Electron 注册的私有 scheme，只有桌面外壳页面能产生
> 这个 Origin，网页**无法**跨源伪造它（浏览器按页面来源写入，不是请求方可设的字符串）；
> 同时仍要求对端回环。公网面没有放宽 —— 中转会把 Origin 改写掉，永远不等于该值。
>
> 这个 bug 之所以逃过测试：所有管理路由用例都额外带了 `adminAs`（替前端补了一个真实
> 前端从未发送的 bearer）。0.3.4 起的回归用例**故意不带凭据**，复刻真实调用形状。

浏览器里直接改设置（`http://127.0.0.1:端口` 或经隧道）会走第 2 条：前端在口令框填过值后
会用它派生 token 并在本页内记住。口令框为空且本页还没派生过时会收到一条明确提示
（不再只是 `HTTP 403`）。

> **无口令 ≠ 管理路由开放**。口令为空且监听 `0.0.0.0` 时，管理路由对非回环来源一律 403；
> 桌面外壳与本机 UI 不受影响，`relay_status` / `relay_control` 工具也不受影响。

### 会话代签的权限边界

`autoSession` 用 `$DSH_HOME/.credentials.yaml` 里的持久密钥代签 dsh 会话 Cookie。
它签出的是**完整的 dsh 管理员会话**（工具执行、文件访问、设置改写），不是只读视图。

- 口令为空时**强制关闭**（`config.js` 的硬约束）
- 凭据读取失败或连续 10 分钟读不到 → 停止注入，退回「用 `?token=` 登录」，不会把人锁在门外
- ⚠ 改中转口令**不会**让已签发的 dsh 会话失效 —— 它们由 dsh 的持久密钥签名，不是由口令签名

### `?token=` 放行必须验真（0.3.1）

dsh 的浏览器认证是**一次性令牌交换**：每次启动随机生成一个 launchToken，只在
`GET /?token=<它>` 上接受。中转需要放行这类请求，否则 token 到不了 dsh。

但**只校验形状是不够的**。0.3.0 及以前的实现是「`GET /` + 恰好一个非空 token →
跳过中转口令」。于是浏览器书签里那条来自**上一次 dsh 启动**的旧 URL 也能绕过中转口令，
随后必然被 dsh 以 401 拒绝：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

用户看到的症状是「不用输口令就进去了，但所有操作都报错」—— 而正确行为是给中转登录页。
绕过自家中转口令、把请求丢给一个必然拒绝的上游，比直接要求输口令糟糕得多。

现在的规则：

| 情况 | 行为 |
| --- | --- |
| token 与**当次** launchToken 相等（恒定时比较） | 放行，让 dsh 完成交换 |
| token 不相等（过期/伪造/书签残留） | **拦截**，返回中转登录页，不转发 |
| 拿不到 launchToken（服务未就绪等） | **一律拦截**（安全默认：要求口令） |
| 多 token / 空 token / 非 GET / 非 `/` 路径 | 拦截 |

launchToken 从 dsh 的 `connection` 服务（`ctx.get('connection').browserAuth.launchToken`）
读取 —— 中转是跑在同一进程内的插件，可直接取到。读不到时宁可多要一次口令，
也不让一个过期 URL 把人送进死路。

拒绝次数与最近原因会出现在状态面板的 `tokenExchange` 字段里（只报计数与枚举，**不报 token 原值**）。

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
dsh-public-relay.js              独立脚本版（守护进程 + 反向代理，复用 lib/）
plugin/
  dsh-public-relay/              插件版（npm 包本体）
    lib/index.js                 宿主半：配置、路由、鉴权、启停编排、全局工具
    lib/relay.js                 中转核心：代理 + 认证 + isLoopback 改写
    lib/auth.js                  认证原语：口令会话、限流器、回环判定（宿主半与中转共用）
    lib/dsh-cookie.js            按 dsh 格式代签会话 Cookie
    lib/config.js                配置契约
    lib/client.js                浏览器半：两个设置座位 + 自绘表单
    cordis.patch.yml             bundle 补丁层
    locale/{zh,en}.json          插件列表展示元数据
  install.ps1                    自检 / 安装指引 / 旧安装残留清理（须保持 UTF-8 BOM）
  tools/                         诊断、安全审计与开发工具
  tests/                         七套测试（407 项断言）
```

---

## 开发

```powershell
# 七套测试
node plugin\tests\smoke.mjs              # 中转核心      110 项
node plugin\tests\host-integration.mjs   # 宿主半         94 项
node plugin\tests\client-half.mjs        # 浏览器半       81 项
node plugin\tests\dsh-session.spec.mjs   # 会话代签       76 项
node plugin\tests\password-modes.mjs     # 口令模式        6 项
node plugin\tests\token-exchange.spec.mjs # token 交换验真 25 项
node plugin\tests\long-request.spec.mjs  # 长耗时请求     15 项

# 一键自检（manifest 兼容性 + 语法 + 四套测试）
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Check

# 兼容性自检（最容易踩、症状最隐蔽的坑）
node plugin\tools\check-compat.mjs plugin\dsh-public-relay\package.json
```

### 工具索引

`plugin/tools/` 下 39 个脚本，按用途分五类。**遇到问题先查这张表，不要从零写探针。**

#### ① 只读 dsh 内部（app.asar）

```powershell
node plugin\tools\asar.mjs "<asar>" ls  [路径前缀]      # 列文件（输出 "<路径> (<字节数>)"）
node plugin\tools\asar.mjs "<asar>" cat <内部路径>       # 读单个文件
node plugin\tools\asar.mjs "<asar>" grep "<正则>" [前缀]  # 内容搜索
node plugin\tools\grep-asar.mjs                          # 同上，输出更精简
node plugin\tools\read-asar-file.mjs                     # 带行号读取
```

#### ② 认证 / 会话代签

```powershell
node plugin\tools\probe-authority.mjs [dsh端口]      # 代签 authority 与 Host 是否一致（不一致必 401）
node plugin\tools\probe-launch-token.mjs             # 能否取到当次 launchToken（token 验真的前提）
node plugin\tools\check-auth-chain.mjs               # 逐层核对认证链路
node plugin\tools\soak-relay-auth.mjs [轮数] [并发]    # 高频采样，捕间歇性 401
node plugin\tools\probe-prompt.mjs                   # /api 各端点经中转 vs 直连对比
node plugin\tools\fix-credentials-version.mjs        # 修 credentials 里的版本字段
node plugin\tools\probe-admin-403.mjs                # 管理路由 403 判定矩阵 + 快照 hasPassword 核对
node plugin\tools\repro-toggle-bug.mjs               # 抓一次「停用」的完整响应（含 viaRelay/停止态字段）
```

#### ③ 隧道 / 连通性

```powershell
node plugin\tools\check-tunnel-tls.mjs https://<域名>:<端口>     # 证书是否被浏览器信任
node plugin\tools\simulate-browser.mjs https://<域名>:<端口> <口令>  # 模拟浏览器全链路
node plugin\tools\trace-relay-load.mjs                            # 首页引用的 bundle 能否全拉到
node plugin\tools\probe-long-request.mjs                          # 长响应能否完整送达
```

#### ④ 桌面端 / 405 / 插件路由

```powershell
node plugin\tools\hook-dsh-405.mjs [秒数]      # 在 dsh 进程内挂钩 http.Server，记录收到的请求
node plugin\tools\read-405-hits.mjs            # 读上面记下的请求
node plugin\tools\probe-405.mjs                # 各路由 × 各方法的状态码矩阵
node plugin\tools\inspect-dsh-plugins.mjs      # 查运行中的插件状态
node plugin\tools\verify-sidebar-fixed.mjs     # /sidebar/* 是否由插件接管（而非落进 fallback）
node plugin\tools\diagnose.mjs                 # 综合诊断
node plugin\tools\verify-bundles-load.mjs      # 校验 bundle 能否加载
```

#### ⑤ 安装 / 修补 / 数据维护

```powershell
node plugin\tools\add-bundle.mjs               # 往 profile 追加 bundle
node plugin\tools\set-relay-row.mjs            # 写/改 relay 的 loader 行
node plugin\tools\clean-relay-rows.mjs         # 清理重复的 relay 行
node plugin\tools\fix-web-patch.mjs            # 修 web patch
node plugin\tools\repair-patch-array.mjs       # 修复被写坏的 patch 数组
node plugin\tools\analyze-relay-payload.mjs    # 分析中转载荷
node plugin\tools\probe-session-open.mjs       # 会话打开耗时/行为
node plugin\tools\probe-session-size.mjs       # 会话体积构成
node plugin\tools\probe-switch-cost.mjs        # 切换会话的开销
node plugin\tools\probe-ws-stability.mjs       # WebSocket 稳定性
node plugin\tools\probe-ws-wire.mjs            # WebSocket 线缆字节
node plugin\tools\e2e-session.mjs              # 会话端到端
node plugin\tools\e2e-verify.mjs               # 端到端校验
```

### 安全审计工具

`tools/audit-*.mjs` 是 2026-10 那轮安全审查留下的可复跑探针，每个脚本针对一个具体的
历史漏洞。它们不是回归测试（那些在 `tests/` 里），而是**当你不确定某个防线是否还在时**
可以手动敲一条命令去戳的那个洞：

```powershell
node plugin\tools\audit-token-bypass.mjs     # ?token= 后门是否又被打开
node plugin\tools\audit-csrf.mjs            # 管理路由的 Origin 判定是否可绕
node plugin\tools\audit-status-leak.mjs     # status / 工具是否泄露口令或密钥路径
node plugin\tools\audit-hardening.mjs       # 限流 / body 上限 / CRLF 过滤 / 恒定时比较
node plugin\tools\audit-patcher-edges.mjs   # isLoopback 改写是否会产生语法错误的 JS
```

修改认证、限流或改写逻辑后，值得跑一遍。

### 隧道连通性排查

```powershell
# 1) 隧道证书是否被浏览器信任（自签证书会让 /api 全面 401）
node plugin\tools\check-tunnel-tls.mjs https://<你的隧道域名>:<端口>

# 2) 完整模拟浏览器经隧道访问：登录 → 首页 → /api，逐环节报告
node plugin\tools\simulate-browser.mjs https://<你的隧道域名>:<端口> <中转口令>

# 3) 页面能开但操作失败时：确认首页引用的每个 bundle 是否都能拉到
node plugin\tools\trace-relay-load.mjs

# 4) 验证代签 Cookie 的 authority 与 dsh 的 Host 是否一致
node plugin\tools\probe-authority.mjs [dsh端口]
```

改隧道配置、换域名或遇到「页面能开但操作全 401」时，按 1 → 2 → 3 顺序跑：
第 1 条区分「证书问题」与「认证问题」，第 2 条给出完整链路结论，
第 3 条确认前端能否启动。**先跑工具，再下结论** —— 2026-10 那次排查因为直接
用 `curl -k` 测，把它能发现的证书问题整个掩盖了，绕了很久。

### 桌面端请求排查（405 / 路由缺失）

**桌面端**（`dsh-app://app`）的请求用 curl 和普通浏览器都抓不到 ——
它是 Electron 自定义 scheme，只存在于 dsh 进程内。
但 dsh 自带 experimental-inspector，在 `127.0.0.1:9230` 暴露 CDP，
其 target 能在 **Host realm**（Node 侧）执行代码，于是可以**在 dsh 自己的
进程里挂钩 `http.Server`，看到它收到的每一个请求**：

```powershell
# 1) 注入钩子（常驻，直到 dsh 退出）
node plugin\tools\hook-dsh-405.mjs 60

# 2) 在 dsh 界面里操作（点开文件、展开侧边栏…），然后读取记录
node plugin\tools\read-405-hits.mjs

# 3) 静态对照：哪些路由+方法组合会返回 405
node plugin\tools\probe-405.mjs

# 4) 查 dsh 运行中的插件状态
node plugin\tools\inspect-dsh-plugins.mjs sidebar

# 5) 验证 /sidebar/* 是否由 better-sidebar 接管（而非落进 dsh fallback）
node plugin\tools\verify-sidebar-fixed.mjs
```

**怎么区分「路由没注册」与「路由正常但参数不对」**：

| 现象 | 含义 |
| --- | --- |
| `405` + **空 body** | dsh fallback —— **路由没注册**（插件宿主半没加载） |
| `405` + `{"code":"method-error"}` | 路由已注册，是插件自己的方法校验 |
| `400` + `{"code":"bad-request"}` | 路由已注册，参数不合法 |
| `200` + `{"ok":true,...}` | 完全正常 |

这在 2026-10-20 的排查里是决定性的：静态分析能看出 dsh 里有 6 处会返 405，
但**无法确定实际命中哪一处**；钩子一挂上，真相立刻清楚 ——
侧边栏插件 `dsh-better-sidebar` 0.25.0 依赖一个 dsh 里不存在的服务
（`ctx.webRuntime`，实际叫 `ctx.web`），宿主半加载失败，
它的 `/sidebar/*` 路由全部没注册，客户端的 POST 掉进 fallback → 405。
升级到 0.28.0 即修复。

### 间歇性 401 排查（最难的一类）

症状：偶尔出现 `dsh web authentication required` 或
`transport failure for /api/...: HTTP 401`，刷新页面后恢复，单次测试永远复现不了。

**第一步：看观测记录**（0.3.3 起 relay 记录每一次上游 401）

```powershell
node plugin\tools\verify-upstream-401-observability.mjs   # 验证观测本身可用
node plugin\tools\watch-relay-flap.mjs 120 400            # 持续采样，捕捉故障窗口
```

`status.upstream401` 里有 `count`、`last`、`samples`（最近 10 条），
每条含方法、路径、**我们实际注入了哪些 dsh-auth cookie**（名字哈希 + 版本 +
authority + issuedAt/expiresAt + 剩余时长）—— 只记结构，不记签名原文。

**第二步：核对 dsh 接受 cookie 的硬边界**（实测得出）

```powershell
node plugin\tools\probe-dsh-cookie-bounds.mjs    # 有效期跨度 / 时钟偏移的边界扫描
node plugin\tools\probe-boundary-flap.mjs 200    # 连续压边界，看是否有抖动
node plugin\tools\diagnose-secret-mismatch.mjs   # 逐条核对五条件
```

实测边界（dsh 0.2.1-rc.2）：

| 条件 | 边界 | 说明 |
| --- | --- | --- |
| `expiresAt - issuedAt` | **> 30 天** → 401 | 中转签 30 天，恰好压线（`=30` 通过） |
| `issuedAt` 相对 dsh 的 now | **> 0ms** → 401 | 正向偏差 1ms 即拒 |
| `payload.authority` vs Host | 不等 → 401 | 见下面 audience 一节 |

**第三步：确认 HTTP/HTTPS 的 audience 错配**（最常见的真凶）

```powershell
node plugin\tools\probe-tunnel-401.mjs
```

dsh 的 `requestAudience(headers, secure)`：

```js
return secure ? url.origin : url.host;   // "https://host:port"  vs  "host:port"
```

**两者是不同名字的 cookie**：

```
secure=false → dsh-auth-0exPercd…   (authority = 127.0.0.1:19387)
secure=true  → dsh-auth-Fvz3nzXs…   (authority = https://127.0.0.1:19387)
```

实测：给 dsh 一个 `https://` 形态的 cookie，它回的就是
`dsh web authentication required`（与用户看到的文案完全一致）。

中转签 cookie 用 `TARGET.authority`（HTTP 形态），而 dsh 的 secure 取
`webServer.protocol === "https:"`。**两边一致时正常；不一致就全面 401。**

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

## 更新记录

| 版本 | 关键变化 |
| --- | --- |
| `0.3.5` | **修复**：点「停用」后报错、设置页整块失效。真因是 `relay.stop()` 一开头就销毁所有 socket，把承载这次请求的连接（用户正是经中转打开的设置页）连同响应一起掐断。改为优雅排空 + 先回响应再停用；并新增 `viaRelay` 让前端知道「你正在通过中转访问」，停用前二次确认。同时面板不再白屏 —— 渲染异常会显示原因与现场信息 |
| `0.3.4` | **修复**：设置页「保存/停用」必现 `HTTP 403` —— 管理路由要求 bearer，而前端从未发送。桌面外壳（`dsh-app://app`）改为免凭据，前端补上 bearer 派生（浏览器场景用）。同时修 `hasPassword` 位置错误导致的「口令为空」误报 |
| `0.3.3` | **观测**：记录每一次「上游 401」的完整上下文（方法/路径/注入的 dsh-auth cookie 结构），`status.upstream401` 可查。同时补齐间歇性 401 的排查工具链与 dsh 接受 cookie 的实测边界 |
| `0.3.2` | **修复**：15s「connect timeout」实为整个请求总时限，会掐断 `session/prompt` 等长耗时调用。拆成两段：连接 15s / 等响应头 5 分钟 / 响应体传输不限时 |
| `0.3.1` | **修复**：带过期 `?token=` 的 URL 可绕过中转口令（只校验形状），随后被 dsh 401。改为与当次 launchToken 恒定时比较，过期一律拦成登录页 |
| `0.3.0` | WebSocket 帧级代理 + `permessage-deflate` 压缩（会话历史压缩约 4.8x） |
| `0.2.x` | 配置改由插件自己的 JSON 持有（与 dsh settings 解耦）；管理路由加鉴权；`isLoopback` 改写改为按结构定位 |

> 升级后需**完全退出 dsh 再启动**（含系统托盘）才会加载新版本 —— Electron 关窗口不杀进程。

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

**不带口令就进了页面，但所有操作都 401、控制台报 `transport failure for /api: HTTP 401`**

按顺序排查（**先试第 0 条，它最省事且命中率最高**）：

0. **先按 `Ctrl+Shift+R` 强制刷新一次**。浏览器可能缓存了旧的 JS bundle 或旧的
   `dsh-auth-*` Cookie，导致前端拿着过期凭据发请求。2026-10-20 那次真实故障
   就是这样解决的：服务器端逐项验证全通（登录 302 → 首页 200/42 KB →
   `/api` ok:true），客户端硬刷新后立即恢复。
1. **地址栏里带着 `?token=...`**（最常见）。那条 URL 来自**上一次 dsh 启动**，
   token 早已作废。旧版中转会放行它（只校验形状），于是绕过了中转口令、
   直接把请求丢给 dsh → dsh 回 401。
   **做法**：把 `?token=` 及之后全删掉，只访问 `https://<你的隧道域名>:<端口>/`，
   输入中转口令。0.3.1 起中转会自己拦下过期 token 并给登录页，不再有这条死路。
   状态面板的 `tokenExchange.rejects` 能确认是否发生了这种情况。
2. **`autoSession` 没生效**（口令为空、或读不到密钥）。看状态区「自动会话」那一行的原因。
3. **跑了 `simulate-browser.mjs` 仍然全绿却还是不行**：那就是纯客户端缓存问题，
   清该站点的 Cookie/站点数据后重来（见第 0 条）。

**隧道证书是自签的 → 浏览器拦截 → 症状也是「页面能开、操作全挂」**

这是最容易误判的一类：症状和上面几乎一样，但**服务器端一切正常**。

```powershell
# 一条命令判定
node plugin\tools\check-tunnel-tls.mjs https://<你的隧道域名>:<端口>
```

若输出 `链验证 : 失败 ❌ (DEPTH_ZERO_SELF_SIGNED_CERT)`，说明隧道用的是自签证书：

- 浏览器显示「您的连接不是私密连接」/ `ERR_CERT_AUTHORITY_INVALID`
- 强行点「继续前往」后站点处于**不安全上下文**，Cookie 无法正常参与 `/api` 请求 → 全面 401
- 樱花映射启用 `auto_https = auto` 但**未绑定自有域名**时只能签自签证书（它自己的日志也会警告）

**⚠ 关键陷阱**：`curl -k` 忽略证书，所以「用 curl 测一切正常」**不能**排除此问题 ——
恰恰是 `-k` 把唯一线索藏起来了。实测对照：

```
curl -k  https://.../api/...   → 200   （忽略证书）
curl     https://.../api/...   → 000   （浏览器视角，TLS 握手失败）
```

**修复**（二选一）：

- **免费方案（无需自有域名）**：樱花映射为所有用户提供免费 `*.nyat.app` 子域 +
  受信任证书。在 <https://www.natfrp.com/tunnel/domain> 申请子域 → 绑定该隧道 →
  确认隧道「自动 HTTPS」为「自动」→ **重启隧道**。启动日志出现
  `已从服务器为 xxx.nyat.app 加载证书` 即成功（首次签发可能要几分钟）。
  子域绑定开启 HSTS Preloading，因此**必须**走 HTTPS。
- **自有域名方案**：用 Let's Encrypt 等公共 CA 证书替换
  `FrpcWorkingDirectory\<域名>.{crt,key}`，见 <https://doc.natfrp.com/frpc/ssl.html>。

**发消息（`session/prompt`）总是失败，或报 `transport failure for /api/session/prompt`**

先看是不是**超时**而不是认证：0.3.1 及以前有个 bug —— 转发用的 15s 「connect timeout」
实际上是**整个请求的总时限**，而 prompt 是发起 AI 对话，正常就要几十秒到几分钟，必然被掐断。

- 若状态码是 **502** 且正文含 `upstream connect timeout` → 就是这个 bug，升级到 0.3.2
- 若状态码是 **401** → 是认证问题，见上一条
- 自测：`node plugin\tools\probe-long-request.mjs`（长响应能否完整送达）

0.3.2 起拆成两段：连接 15s、等响应头 5 分钟、响应体传输不限时。

**`install.ps1` 报语法错误（`The token '||' is not a valid statement separator` 等）**
Windows PowerShell 5.1 按系统 ANSI 代码页读无 BOM 脚本，而本脚本是 UTF-8。
保持该文件为 **UTF-8 带 BOM** 即可；用 PowerShell 7 跑不受影响。

> ⚠ **编辑 `install.ps1` 时必须补回 BOM**。多数编辑器与本环境的文件编辑工具写入时会
> 剥掉它，一旦剥掉脚本在 PowerShell 5.1 下会静默变成无法执行。这是该文件的存活条件。

**设置页「保存 / 停用」点了没反应，或报 `HTTP 403`**

0.3.3 及以前这是个必现 bug（不是配置问题）：口令一旦设置，管理路由就要求 bearer，
而前端 `call()` 从来没发过 bearer → **写操作永远 403**，状态却照常能读，
于是表现为「看得见配置、改不动」。

```powershell
# 一条命令判定当前运行实例是旧代码还是已修复
node plugin\tools\probe-admin-403.mjs
```

看两处输出：

- `桌面壳 dsh-app://app（无凭据）` 是 `200` → 已修复；仍是 `403` → 运行中的插件还是旧代码
- `快照 config.hasPassword` 是 `true` → 已修复；`undefined` → 旧代码

旧代码只能靠**完全退出 dsh 再启动**（含系统托盘）来加载新版本。

修复后的规则：桌面外壳（`dsh-app://app`）免凭据；浏览器里改设置需要在口令框填一次口令
（前端用它派生 token 并在本页记住）。公网经隧道的请求仍然必须持凭据。

**点了「停用」之后弹一个报错，然后设置页整块变空 / 完全没内容了**

0.3.4 及以前的结构性问题，**最典型的发生条件是：你正通过中转地址（隧道域名）
打开着 dsh**。此时点「停用」等于把这个页面自己的传输掐掉：

1. 请求经中转到达 dsh，dsh 开始停用中转；
2. `relay.stop()` 一开头就 `closeAllConnections()` + 逐个 `socket.destroy()`；
3. **承载这条「停用」请求的连接就是其中之一** → 响应还没写回浏览器就被销毁；
4. 前端只看到网络错误（那句「报错」），随后整个页面失去传输（「看不到任何内容」），
   而且在这个已经失效的页面上没法再把中转打开。

0.3.5 起三层修复：

- **优雅排空**：停用时只立即断开已升级的 WebSocket，普通 HTTP 连接留出排空窗口
  （2s 兜底），在途响应能写完；
- **先回响应再停用**：`/control` 的停止类动作先把 200 发出去，`finish` 之后才真正停；
- **`viaRelay` + 二次确认**：宿主半把「这条请求是否经中转」如实告诉前端
  （中转给每个转发请求打 `x-dsh-public-relay-hop` 标记头），前端在本页正走中转时
  先弹警告、要求再点一次才真的停用。

```powershell
# 现场核对：直连与经中转的 viaRelay 分别是什么
node plugin\tools\repro-toggle-bug.mjs
```

**如果已经被断开了怎么恢复**：改用本机地址 `http://127.0.0.1:<dsh端口>` 打开 dsh
（桌面外壳默认就是这个），在那里停用/启用；或者完全退出并重启 dsh
（`重启dsh.cmd`），配置里 `enabled: true` 会在启动时自动拉起中转。

**现在不会再白屏了**：面板把渲染期异常捕获成可读文字 + 现场信息
（`state=` / `viaRelay=` / 异常原文），且明确告诉用户「配置未被改动」。
若再次出现「设置里没内容」，把那两行贴出来即可定位 —— 而不是又一次只剩
「什么都没有」。

**界面一直提示「口令为空」「自动管理 dsh 会话未生效…请先填一个访问口令」，但口令明明已设**

同属 0.3.3 及以前的 bug：状态快照把 `hasPassword` 放在顶层，而前端读的是
`config.hasPassword` → 拿到 `undefined` → 恒判定「没有口令」。
0.3.4 起两处都带（`snapshot.hasPassword` 与 `snapshot.config.hasPassword`），
仍然只暴露布尔值、不回传口令原值。

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
