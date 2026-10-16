# dsh-relay — DSH 中转插件

把工作区根的 `dsh-relay.js` 脚本改造成**常驻 DSH 插件**：随 dsh 启动加载，在**本进程内**把 dsh 自己的端口中转出去，并在设置页显示当前真实端口、随时启停。

---

## 它做什么

| 能力 | 说明 |
| --- | --- |
| **显示当前 dsh 端口** | 取本进程 `ctx.webServer.port` / `.host` 的实时值，不硬编码。dsh 换端口后 UI 自动跟着变 |
| **随时启用 / 关闭** | 设置页里的开关一键切换。停用会**真正释放监听端口**，不需要重启 dsh |
| **Host/Origin 改写** | 过 dsh 的信任栅栏；公网域名访问不再被 403 拦下 |
| **force-loopback** | 改写 dsh 客户端连接模块的 `isLoopback` 判定，公网域名下插件列表不再变空 |
| **自动管理 dsh 会话** | 按 dsh 的格式代签会话 Cookie：打开中转地址 → 只输中转口令 → 直接进入，不必再找 dsh 打印的 `?token=` URL。口令为空时自动禁用 |
| **口令认证** | HMAC-SHA256 签名 Cookie，`timingSafeEqual` 校验，失败固定延时 400ms |
| **WebSocket 透传** | 会话实时推送正常穿透中转 |
| **全局工具** | `relay_status` / `relay_control`，任何会话里都能让模型查端口、开关中转 |

---

## 界面在哪

两个入口，共用同一份配置：

1. **设置 → 插件 → 「DSH 中转」** —— **配置卡片**，与「MiMo 视觉识别」同一位置同一形态。
   改参数的主入口：启用开关、监听地址、监听端口、访问口令、强制回环改写、自动管理 dsh 会话。
2. **设置 → 「DSH 中转」** —— 同一份配置的独立整页，另附端口信息与启停按钮。

> 早期版本还有第三个入口：左下角常驻角标 `● dsh :19387 → relay :3091`。它 `position:fixed`
> 压住了侧栏底部的「设置」按钮，导致设置点不开，**已随 `shell.overlay` 座位一起移除**。
> `lib/client.js` 的 `removeLegacyBadge()` 会在挂载时清掉旧版本残留在 DOM 里的节点，
> 老页面刷新一次即可干净。

状态区有五个指标：活动连接 / 已处理请求 / 运行时长 / 口令认证 / **自动会话**。
最后一项目的是让「为什么没自动进入」一眼可见，三种状态互不混淆：

| 显示 | 含义 |
| --- | --- |
| `已开启` | 代签生效，输完中转口令直接进 |
| `已关闭` | 用户主动关掉了这个功能 |
| `已禁用` | 用户开着，但被「口令为空」这条硬约束压掉了（会附警告说明） |

另外，开关开着却没读到 dsh 会话密钥时，状态区会直接提示 —— 这个失败只在日志里，
不提示的话用户只会看到「还是要 token」而找不到原因。

配置表单是**自绘**的（不是 MiMo 那种 `SettingsFormModel` 生成）：两个座位的注入面刻意
留空，页面数据全部走自己的 `/dsh-relay/*` 路由。原因见 `lib/client.js` 顶部注释 ——
早期版本依赖 `configForms`，那个服务并不在本宿主的客户端服务目录里，导致座位永远
不就绪、设置里怎么都看不到插件。

---

## 安装

```powershell
# 默认装到 desktop profile（Electron 版 dsh 用的那个）
powershell -ExecutionPolicy Bypass -File plugin\install.ps1

# 装到 web profile
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Profile web

# 回滚
powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Revert
```

安装脚本做四件事，任何一步失败都会自动还原全部改动：

1. 备份 `profile/cordis.patch.yml` 与 `profile/package.json`
2. 把 `plugin/dsh-relay` 拷到 **`$DSH_HOME/profiles/<profile>/node_modules/dsh-relay`**
3. 在 profile 自己的 `cordis.patch.yml` 里写一条显式 `- id: dsh-relay` 条目
4. 校验解析路径 + 跑四套测试（共 199 项断言）

**首次生效需要完全退出 dsh 再打开**（含系统托盘；Electron 关窗口不杀进程）。之后启停都不用重启。

### 两个必须知道的部署约束

**一、为什么不用 `dsh.profile.bundles`，而写 `cordis.patch.yml` 条目？**

Electron 版 dsh **独占管理** desktop profile——它的 CLI 会直接拒绝
`--profile desktop --dump-config`：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以 bundle 层的自动 insert 对它不生效。实测只写 `dsh.profile.bundles` 时，宿主进程里
既没有插件的配置项、也没有它注册的工具，设置页自然看不到卡片。而 profile 自己的
`cordis.patch.yml` 写显式条目是可靠的——同 profile 的 `dsh-mimo-vision` 就是这么装的。

**二、为什么必须装到 profile 本地 `node_modules`？**

插件的 `Config` schema 用了 schemastery 的 `.volatile()`（宿主据此把字段投进设置表单），
而该方法只在 **3.18.4+** 存在：

| 位置 | schemastery | `.volatile()` |
| --- | --- | --- |
| `profiles/node_modules`（共享回退） | 3.18.1 | ✗ |
| `profiles/desktop/node_modules`（profile 本地） | 3.18.4 | ✓ |

放在 profile 本地才会就近解析到正确版本。安装脚本会先探测并告知结果。

即使版本不支持，插件也**不会崩**：`lib/config.js` 的 `vol()` 包装会在缺方法时降级
（设置页可能少几个字段），其余功能完好。

---

## 配置

配置有两层，后者覆盖前者：

1. 插件行的 `config:`（写在 profile 补丁里，作为部署默认值）
2. **设置命名空间** —— `lib/index.js` 用 `ctx.get('settings').register('dsh-relay', Config)`
   把 schema 注册成 settings 命名空间，于是设置页里改的值就是权威来源
   （用户层 > 本插件 composition base）。`settings` 服务不可用时退回插件的
   entry config，状态与启停照常，只是改不了参数。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | dsh 启动时是否自动启用中转 |
| `listenHost` | `'127.0.0.1'` | 中转监听地址。`0.0.0.0` 会让局域网直达 |
| `listenPort` | `3091` | 中转监听端口。**隧道「本地端口」填这个值**；填 `0` 让系统分配 |
| `targetHost` | `null` | 上游地址覆盖。`null` = 自动取本进程 dsh 端口（推荐）。不在表单里，只能写进补丁 |
| `targetPort` | `null` | 上游端口覆盖。`null` = 自动。同上 |
| `password` | `'20040915'` | 访问口令。空字符串 = **关闭认证**（公网暴露时务必非空） |
| `forceLoopback` | `true` | 强制回环改写 |
| `autoSession` | `true` | 按 dsh 的格式代签会话 Cookie，用户只输中转口令即可进入。**口令为空时被强制关闭**（见下） |

**热生效规则**：口令、`forceLoopback`、`autoSession` 改完立即生效（每个请求实时读取，
口令还会按值重建认证器）。`listenHost` / `listenPort` 需要重新绑定，保存时自动按需重启中转。

### `autoSession` 的安全硬约束

代签能力等价于「持有 dsh 的会话签名密钥」，而中转口令是这道能力的**唯一门槛**。
所以 `normalizeConfig` 在口令为空时把 `autoSession` 强制压成 `false`，而不是交给用户自觉：

| 口令 | `autoSession` 设定 | 实际结果 |
| --- | --- | --- |
| 非空 | `true` | 生效：转发前补签 `dsh-auth-*` Cookie |
| 非空 | `false` | 不代签，退回「需要 dsh 打印的 `?token=` URL」 |
| **空** | 任意 | **强制不代签**；UI 上会标 `blockedByEmptyPassword` 并解释原因 |

另外，保存配置时写回的永远是**用户原意**而不是压过的结果 —— 否则用户只是临时清空口令，
开关就会被偷偷关掉，填回口令也不会自动恢复。

---

## 与樱花映射 / frp 配合

1. 在插件 UI 上确认「中转监听」的端口（默认 `127.0.0.1:3091`）
2. 樱花映射隧道设置里，「本地端口」填**中转端口**（`3091`），不是 dsh 自己的端口
3. 公网访问时用插件的口令登录

> 只想在本机访问，直接用 UI 上显示的「当前 dsh 端口」即可，不需要中转。

---

## 与独立脚本 `dsh-relay.js` 的关系

两者是**独立实现**，可以共存：

- `dsh-relay.js`：独立进程 + dsh web 守护 + 崩溃重启。适合不用插件、想单独跑中转的场景。
- 本插件：跑在 dsh 进程内，无子进程可守（宿主本来就不会退出），不需要 watchdog。

端口的语义以**插件 UI** 为准。插件的 `lib/relay.js` 从脚本移植，并去掉了四处「独立进程」假设：

1. 删除 `process.exit()` / `fail()` / 打印 HELP → 改抛异常或记入 `lastError`
2. 删除整个 dsh web watchdog（`startDshWeb` / 快速崩溃保护 / 心跳 / SIGINT 处理）
3. `EADDRINUSE` 不再退出进程 → 记 `lastError='port-in-use'`，UI 上显示，可换端口重试
4. 上游 target 惰性求值 → 默认取本进程真实端口

另外 `stop()` 修复了原来只 `server.close()` 的问题：keep-alive 连接与已升级的 WebSocket 会让端口继续挂着，现在会跟踪所有 socket 并逐个 `destroy`。

---

## 顺带修好的问题：`dsh web` 起不来

`~/.dsh/profiles/web/cordis.patch.yml` 原本**只有注释**，YAML 把它解析为 `null`，而 dsh 的 `parsePatchList` 要求顶层是数组：

```
Error: dsh: overlay ...\cordis.patch.yml must be a top-level YAML array of loader patch entries
```

这就是 `dsh-web.log` 里那些被标为「静默崩溃」的真实原因（日志里那四条猜测全都落空了）。

安装脚本会用 `plugin/tools/fix-web-patch.mjs` 做**最小修正**：保留全部原有注释，只在末尾补一个空数组。

单独使用：

```powershell
node plugin\tools\fix-web-patch.mjs <path-to-cordis.patch.yml>          # 修
node plugin\tools\fix-web-patch.mjs <path-to-cordis.patch.yml> --check  # 只检查（退出码 0=合法）
```

---

## 文件说明

```
plugin/
  install.ps1                     安装 / 回滚
  tools/set-relay-row.mjs         写/更新 profile 里的 dsh-relay 条目（YAML 安全）
  tools/clean-relay-rows.mjs      收敛：只留一条有效 insert，清裸条目/重复条目
  tools/repair-patch-array.mjs    修「顶层多个文档」的 cordis.patch.yml
  tools/fix-web-patch.mjs         修补丁层顶层数组（纯注释文件解析为 null 的情况）
  tools/add-bundle.mjs            往 profile package.json 加/删 bundle（JSON 安全）
  tools/check-compat.mjs          自检 peerDependencies / dshTarget（防 incompatible-version）
  tools/check-auth-chain.mjs      只读诊断 ?token= 交换链路是否被中转拦下
  tools/diagnose.mjs              只读诊断：插件、依赖、patch 条目、进程逐项检查
  tools/e2e-verify.mjs            干净环境起真实 dsh，确认插件被加载
  tools/e2e-session.mjs           连真实 dsh，验证「只输中转口令就能进」
  tools/fix-credentials-version.mjs  .credentials.yaml 的 version 改回字符串（npm CLI 要求）
  tools/grep-asar.mjs             在 app.asar 原始字节里搜文本（宿主代码只在这里）
  tools/read-asar-file.mjs        从 app.asar 读出某个文件的文本
  tests/smoke.mjs                 中转核心：54 项断言
  tests/host-integration.mjs      宿主半集成：46 项断言
  tests/client-half.mjs           浏览器半：51 项断言
  tests/dsh-session.spec.mjs      dsh 会话代签：48 项断言
  tests/resolve-deps.mjs          测试用的 dsh 模块解析引导
  dsh-relay/
    package.json                  dsh.bundle.patch + dsh.client 声明
    cordis.patch.yml              bundle 层（bundles 方式安装时用）
    lib/relay.js                  中转核心（纯库，无进程副作用）
    lib/config.js                 配置契约：schemastery Config + 归一化
    lib/dsh-cookie.js             按 dsh 格式代签会话 Cookie（autoSession 用）
    lib/index.js                  宿主半：读真实端口、settings 注册、HTTP 路由、工具
    lib/client.js                 浏览器半：插件配置卡片 + 设置页整页
```

四套测试都不需要 dsh 运行，随时可跑（合计 199 项断言）：

```powershell
node plugin\tests\smoke.mjs
node plugin\tests\host-integration.mjs
node plugin\tests\client-half.mjs
node plugin\tests\dsh-session.spec.mjs
```

> 测试从工作区运行时需要能解析 dsh 自带模块（`@deepseek-ai/schemastery` 等）。
> 开发时在 `plugin/dsh-relay/` 下建一个指向 dsh 模块目录的 junction 即可（已 gitignore）：
> `cmd /c mklink /J plugin\dsh-relay\node_modules C:\Users\<你>\.dsh\profiles\node_modules`

---

## 排障

**在 Electron 里点「停用 / 启用 / 保存」没反应，返回 403 `untrusted origin`**

这是写操作的 CSRF 防护判据没认出 Electron 的自渲染页面导致的（已修）。

Electron 的客户端页面跑在 **`dsh-app://app/`** 下，该协议被注册为 standard+secure
（asar 里的 `registerSchemesAsPrivileged`），所以页面 fetch 会带
`Origin: dsh-app://app`。而 `new URL('dsh-app://app').host` 是字符串 `"app"`，
与请求头里的 `Host: 127.0.0.1:19387` 永不相等 —— 若判据写成「Origin 的 host 必须
等于 Host」，就会一律 403。

现在判据与 dsh 自己的 `isTrustedApiRequest` 对齐：

| 情形 | 结果 | 理由 |
| --- | --- | --- |
| 无 `Origin` | 放行 | 浏览器对跨站写请求**必带** Origin，故此处不可能跨站 |
| `Origin: dsh-app://…` | 放行 | 应用私有 scheme，普通网页无法伪造 |
| `http(s)` 且 Origin 与 Host **同 authority** | 放行 | 正常同源（含隧道域名） |
| `http(s)` 但 authority 不一致 | **403** | 真跨站，仍拒绝 |

`GET /dsh-relay/status` 没有这道校验，所以即使写操作被拒状态仍能显示 ——
症状就是「面板看得到，但按钮点了没反应」。

403 的响应体现在带 `detail`（`origin=… host=…`），便于直接看出是哪一种不匹配。

修改 `lib/index.js` 后需**重启 dsh**（宿主半代码在进程内）。

**公网/中转访问时一直提示 `dsh web authentication required; reopen the URL printed by dsh web`（输了口令也没用）**

这是**两套认证被串错顺序**导致的，与口令是否正确无关。

dsh 自己的浏览器认证是**一次性 token 交换**：

```
dsh 启动 → 生成随机 launchToken → 打印/打开 http://<authority>/?token=XXX
        → 只在 `GET /` 接受该 token → 写 dsh-auth-* 签名 Cookie（绑定 authority）→ 302 到 ./
        → 之后每个请求都要求这个 Cookie，缺了就 401
```

中转插件有自己的口令认证。如果它在 `GET /` 上抢先接管，`?token=XXX` 就被丢掉了 ——
dsh 的 Cookie 从未签发，之后无论输多少次中转口令都进不去（那是两套互不相通的认证）。

**本插件已修**：`GET /?token=...` 会被**直接放行给上游**，并保留浏览器的 Host（dsh 要按它签 Cookie）。
判断修复是否生效：

```powershell
node plugin\tools\check-auth-chain.mjs
```

看到「✗ 中转把 ?token= 请求拦下了」就是跑着旧代码 —— **完全退出 dsh（含系统托盘）再打开**。

**正确的进入顺序**

开启「自动管理 dsh 会话」（默认开）后，**只需要两步**：

1. 打开中转对外暴露的地址（隧道域名 / `127.0.0.1:<中转端口>`）
2. 输一次中转口令（`relay_session`，7 天有效）→ 直接进入，`?token=` 那个 URL 不用管

关掉这个开关时，退回 dsh 原生流程：

1. 用 dsh 打印的那个带 `?token=` 的 URL 首次进入（**必须**，token 每个进程只生成一次、用完即弃）
2. 该请求被中转放行 → dsh 校验 token → 下发自己的 Cookie → 302 到 `./`
3. 浏览器再访问 `/` → 中转要求**它的**口令 → 登录一次（7 天有效）
4. 之后放行给 dsh，dsh 已有自己的 Cookie → 正常会话

注意 authority 是**绑定**在 dsh Cookie 上的：`127.0.0.1:19387` 与 `localhost:19387` 是两个不同的
authority，各需一次登录。经中转访问时，用它对外暴露的那个地址。

---

## 自动管理 dsh 会话（`autoSession`）

### 目标与结论

**打开映射的端口 → 只输中转口令 → 直接进入**，不再需要 dsh 打印的 `?token=` URL。

### dsh 的 Cookie 机制（从宿主的 client bundle 复刻）

```
Cookie 名 = 'dsh-auth-' + base64url(sha256(authority))
Cookie 值 = 'v1.' + base64url(json(payload)) + '.' + base64url(hmacSha256(secret, body))
payload   = { version: 1, authority, issuedAt, expiresAt }        // 只有这四个字段
校验       = 签名对 + payload.authority === 本次请求的 Host + 时间区间有效
```

密钥在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录的
`payload.secret`（32 字节 base64url）。它首次创建后**持久不变**，重启不失效，所以读文件即可，
不需要 hook dsh 进程。

### 它怎么工作

```
浏览器 → 中转（隧道端口 3091）
  ① 中转自己的口令认证
       未过 → 显示登录页
       已过 ↓
  ② 若请求没带 dsh 的有效 Cookie，就地替它签一个，注入 Cookie 头
  ③ 转发给 dsh（Host 已改写成 127.0.0.1:19387，与代签的 authority 一致）
  ④ dsh 认出 Cookie → 直接返回应用页面
```

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 代签绑定的 authority | `target.authority`（即 `127.0.0.1:<dsh端口>`） | 转发时把 Host 改写成它；dsh 校验 `payload.authority === Host`，两者必须一致 |
| 密钥来源 | 读 `.credentials.yaml`，无需 hook 进程 | 与 dsh 同源；该文件本来就等价于「dsh 会话伪造凭据」 |
| 缓存策略 | 启动读一次 + 30 秒复查 mtime | dsh 重建该记录（极少见）时能自动跟上；文件被临时截断时保留旧密钥 |
| Cookie 有效期 | 30 天（与 dsh 一致），每次请求注入新的 | 中转自己管生命周期，用户无感 |
| 覆盖已有 Cookie | **不覆盖**：只在「没有 dsh 有效 Cookie」时补签 | 尊重 dsh 自己签发的会话，避免行为分叉 |
| 失败降级 | 读不到密钥 / 签不出来 → 不注入，退回 `?token=` 现状 | 不能让「自动进入」的失败变成「完全进不去」 |

### 安全边界（重要）

这个能力等价于「持有密钥即可伪造 dsh 会话」。密钥就在 `~/.dsh/.credentials.yaml` 里，
任何能读该文件的进程本来就能做到 —— **中转读它没有引入新的越权面**。但有两点必须明确：

1. **中转口令是这个能力的唯一门槛。** 口令泄露／为空 = 直接交出 dsh 的完整会话。
   因此 `normalizeConfig` 在口令为空时**强制**把 `autoSession` 压成 false，是硬约束而非建议。
   保存时写回的仍是「用户原意」，但填回口令后它会自动恢复生效，不需要用户再动开关。
2. **代签的 Cookie 只发给经中转认证通过的请求。** 本机直连 dsh（不经过中转）的行为完全不变。

### 验证

```powershell
# 单元 + 集成（合成密钥，不碰真实凭据）
node plugin\tests\dsh-session.spec.mjs

# 真实端到端：连真实 dsh、用真实凭据文件
node plugin\tools\e2e-session.mjs

# 只看「自动会话能不能用」（密钥读不到会直接报出来）
node plugin\tools\diagnose.mjs
```

`e2e-session.mjs` 覆盖正反两面：带口令访问应拿到含 `__DSH_BOOT__` 的应用页面；
关掉 `autoSession` 应退回 dsh 的 401；口令为空时同样不代签。

**设置里看不到「DSH 中转」**

按顺序查三件事：

1. **是否完全重启过 dsh**（含系统托盘）。插件在启动时组装，运行中不会自动发现新插件。
   确认方法：`Get-Process "DeepSeek Harness"` 看进程启动时间是否晚于安装时间。
2. **条目是否进了 profile**：
   ```powershell
   node plugin\tools\diagnose.mjs
   ```
   它会逐项报告插件文件、依赖解析、`cordis.patch.yml` 条目。
3. **`peerDependencies` 是否声明了 dsh 自带包**（这是最隐蔽的一种"启动正常但插件完全不显示"）：
   声明 `@deepseek-ai/dsh-tools: ^0.1.0-rc.6` 之类时，semver 的 `^` 对 `0.x` 预发布版本
   不匹配同系列 rc.8，插件管理器判 `incompatible-version` 并把 `rows` 置空，插件彻底不加载。
   自检：`node plugin\tools\check-compat.mjs <插件目录>/package.json`

**配置卡片里没有表单字段（只有开关或空白）**
profile 的 schemastery 低于 3.18.4，`.volatile()` 不生效。把插件装到 profile 本地
`node_modules`（而非共享目录）通常就解决了。

**`dsh` 启动报 "must be a top-level YAML array"**
profile 的 `cordis.patch.yml` 顶层不是数组。用：
```powershell
node plugin\tools\fix-web-patch.mjs <path-to-cordis.patch.yml> --check
```

**`dsh` 启动报 "end of the stream or a document separator is expected"**
patch 文件里同时有 `[]` 占位和 `- id:` 条目（两个顶层文档）。修：
```powershell
node plugin\tools\repair-patch-array.mjs <path-to-cordis.patch.yml>
```

**公网能连但插件列表为空**
force-loopback 的正则失配（dsh 升级后可能发生）。看日志里的
`[dsh-relay] force-loopback: 未找到目标模式`，并把新版本的判定式加进
`lib/relay.js` 的 `LOOPBACK_PATTERNS`。浏览器 `Ctrl+F5` 硬刷新。

**UI 上状态是「端口被占用」**
中转端口被别的进程占了。在设置页换一个「中转监听端口」，或先停掉占用者。

**口令丢了 / UI 一直提示未登录**
中转用的是自己的 `relay_session` Cookie。在设置页确认口令，清掉浏览器里旧的 `relay_session`。

**开着「自动管理 dsh 会话」，但访问时还是要 `?token=`**

先看状态区那个「自动会话」指标，它直接给出原因：

| 显示 | 处理 |
| --- | --- |
| `已禁用` | 口令是空的。填一个访问口令后它会自动恢复生效（不用再动开关） |
| `已开启` 但有「读不到密钥」提示 | `$DSH_HOME/.credentials.yaml` 里没有 `client-connection/browser-session` 记录或其 `payload.secret` 不是 32 字节。跑 `node plugin\tools\diagnose.mjs` 的第 5b 节确认 |
| `已开启` 且无提示 | 说明代签已注入但 dsh 仍拒绝：多半是 authority 不匹配。代签绑定的是 `127.0.0.1:<dsh端口>`，如果你访问的地址与之不同（例如局域网 IP），检查是不是有另一层代理改写了 Host |

**`install.ps1` 报一堆语法错误（`The token '||' is not a valid statement separator` 之类）**

PowerShell **5.1** 用系统 ANSI 代码页（中文 Windows 下是 GBK）读取无 BOM 的脚本文件，
而本脚本是 UTF-8 无 BOM —— 中文注释与 here-string 被解成乱码，边界随之破坏。
修法（保持文件为 UTF-8 **带 BOM**）：

```powershell
$p = 'plugin\install.ps1'
$t = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($true))
```

> 维护提醒：某些编辑器／自动化改写会**静默丢掉 BOM**，改完这个文件后跑一次
> `powershell -File plugin\install.ps1 -SkipTests` 或上面的解析检查确认没退化。
> 用 PowerShell 7 跑则不受影响（它默认按 UTF-8 读取）。

---

## 设计取舍

- **只硬依赖 `webServer`**：没有它既读不到真实端口，也没地方挂路由。
  `settings` / `tools` 走 `ctx.get()` 软获取——缺失时分别退回「配置只来自
  `cordis.patch.yml`」「跳过工具注册」，插件本体照常工作。这避免了
  `dsh-mimo-vision` 早期那种「一个依赖解析不到就把 dsh 启动打挂」的问题。
- **不 import `dsh-settings`**：与 MiMo 同做法，只导出 `Config` schema，
  由宿主侧注册成同名 settings 命名空间。少一个可失败的外部依赖，且 schema 用的
  schemastery 由宿主那份提供，`.volatile()` 一定存在。
- **传输用 `ctx.webServer` HTTP 路由，不用 Typert Remote 服务**：Remote 需要静态
  import `@deepseek-ai/dsh-typert-protocol`，多一层解析风险。webServer 路由零额外
  依赖，且同一台 webServer 上 `dshmarket` 的 `/dsh-market/*` 已是被验证的模式。
- **`.volatile()` 用 `vol()` 包装**：旧版 schemastery 没有该方法，直接链式调用会抛
  `volatile is not a function` 让插件加载失败。包装后缺失时降级（少几个表单字段），
  而不是整条插件链挂掉。
- **写路由都要求同源**（`Origin` 的 authority 必须等于 `Host`），与 dshmarket 一致。

---

## 依赖

Node.js 内置模块（`http` / `crypto` / `fs` / `os` / `path` / `url`）。

宿主侧可选依赖（缺失均自动降级）：
- `@deepseek-ai/schemastery` ≥ 3.18.4 —— `Config` schema（低于此版本降级为无 volatile）
- `@deepseek-ai/dsh-tools` —— `relay_status` / `relay_control` 全局工具
- `@deepseek-ai/dsh-settings` —— 由宿主使用，插件本身不 import
