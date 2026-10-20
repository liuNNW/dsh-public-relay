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
和口令，**必须比普通请求更严**。它们要求：

1. 中转口令派生的 bearer token（`Authorization: Bearer …`）或有效的 `relay_session` Cookie
2. 同源（`Origin` 的 host 等于 `Host`），或对端是回环地址

这两条缺一不可：仅靠 Origin 是不够的 —— 中转会把每个转发请求的 `Host`/`Origin` 改写成
上游回环权威，所以经公网进来的请求在 dsh 侧「Origin == Host」按构造必然成立。反过来，
仅靠 bearer 也不够：无口令时中转允许无认证转发，那时就只剩「对端必须是回环」这一条。

> **无口令 ≠ 管理路由开放**。口令为空且监听 `0.0.0.0` 时，管理路由对非回环来源一律 403；
> 本机 UI 与 `relay_status` / `relay_control` 工具不受影响。

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
  tests/                         六套测试（352 项断言）
```

---

## 开发

```powershell
# 六套测试
node plugin\tests\smoke.mjs              # 中转核心      110 项
node plugin\tests\host-integration.mjs   # 宿主半         79 项
node plugin\tests\client-half.mjs        # 浏览器半       62 项
node plugin\tests\dsh-session.spec.mjs   # 会话代签       76 项
node plugin\tests\password-modes.mjs     # 口令模式        6 项
node plugin\tests\token-exchange.spec.mjs # token 交换验真 25 项

# 一键自检（manifest 兼容性 + 语法 + 四套测试）
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Check

# 兼容性自检（最容易踩、症状最隐蔽的坑）
node plugin\tools\check-compat.mjs plugin\dsh-public-relay\package.json

# 读 dsh 的 app.asar（ls / cat / grep）
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" grep "<正则>" [路径前缀]
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" ls  [路径前缀]
node plugin\tools\asar.mjs "F:\软件\dsh\resources\app.asar" cat <内部路径>

# 探测「中转能否从插件上下文取到 dsh 的 launchToken」（token 验真的前提）
node plugin\tools\probe-launch-token.mjs
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

**不带口令就进了页面，但所有操作都 401、控制台报 `transport failure for /api: HTTP 401`**

两种可能，按顺序排查：

1. **地址栏里带着 `?token=...`**（最常见）。那条 URL 来自**上一次 dsh 启动**，
   token 早已作废。旧版中转会放行它（只校验形状），于是绕过了中转口令、
   直接把请求丢给 dsh → dsh 回 401。
   **做法**：把 `?token=` 及之后全删掉，只访问 `https://<你的隧道域名>:<端口>/`，
   输入中转口令。0.3.1 起中转会自己拦下过期 token 并给登录页，不再有这条死路。
   状态面板的 `tokenExchange.rejects` 能确认是否发生了这种情况。
2. **`autoSession` 没生效**（口令为空、或读不到密钥）。看状态区「自动会话」那一行的原因。

**`install.ps1` 报语法错误（`The token '||' is not a valid statement separator` 等）**
Windows PowerShell 5.1 按系统 ANSI 代码页读无 BOM 脚本，而本脚本是 UTF-8。
保持该文件为 **UTF-8 带 BOM** 即可；用 PowerShell 7 跑不受影响。

> ⚠ **编辑 `install.ps1` 时必须补回 BOM**。多数编辑器与本环境的文件编辑工具写入时会
> 剥掉它，一旦剥掉脚本在 PowerShell 5.1 下会静默变成无法执行。这是该文件的存活条件。

**403（管理路由被拒）**
`/config`、`/control` 需要 bearer token 或 `relay_session` Cookie。从公网经隧道访问时，
宿主半的 Origin 检查会因中转改写过 Host 而失效 —— 请带上口令派生的 token 调用。
本机 UI 与工具调用不受影响。

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
