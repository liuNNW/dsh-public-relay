# 发布物（submission artifacts）

这里存放**提交给外部注册表**的文件，不是本插件的运行时代码。

## `awesome-dsh-plugin/liuNNW__dsh-public-relay--plugin-dsh-public-relay.yml`

提交给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的收录条目。

那个仓库把列表数据放在 `data/plugins/`，**一个插件一个 YAML**，PR 只加这一个文件；
两份 README 与网站都由它自动生成，不需要手工编辑、也不需要跑生成脚本。

目标路径（在**对方仓库**里）：

```
data/plugins/liuNNW__dsh-public-relay--plugin-dsh-public-relay.yml
```

文件名规则：`<owner>__<repo>.yml`；monorepo 子包把子路径的 `/` 换成 `-` 并用 `--` 接在仓库名后面。

### 提交步骤

```sh
# 1. fork（一次即可）
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false

# 2. 拉下自己的 fork，加条目
gh repo clone liuNNW/awesome-dsh-plugin
cd awesome-dsh-plugin
mkdir -p data/plugins
cp <本目录>/liuNNW__dsh-public-relay--plugin-dsh-public-relay.yml data/plugins/
git checkout -b add-dsh-public-relay
git add data/plugins/liuNNW__dsh-public-relay--plugin-dsh-public-relay.yml
git commit -m "Add liuNNW/dsh-public-relay"

# 3. 提 PR（只加一个文件、只动自己那条）
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add liuNNW/dsh-public-relay" \
  --body "Reverse-proxy relay for a local dsh web profile (tunnel/frp friendly). Adds one entry file."
```

### 收录门槛自查

| 要求 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle`（可被 `dsh plugin add` 安装） | ✅ `{"bundle":{"patch":"./cordis.patch.yml"}}` |
| 同级有 `cordis.patch.yml` | ✅ |
| 真实可用代码，非占位 | ✅ 五套测试 235 项 + 在真实 dsh 0.2.1-rc.2 上端到端验证 |
| 仓库创建满 1 天 | ⏳ 2026-10-17T13:41Z 之后满足 |
| 加 `dsh-plugin` topic | ⏳ 见下 |
| 描述属实、无营销词 | ✅ 只写实测存在的机制 |
| 非纯聚合包（自己带行为） | ✅ 自带代理/认证/改写逻辑，非依赖清单 |

补 topic：

```sh
gh repo edit liuNNW/dsh-public-relay --add-topic dsh-plugin --add-topic deepseek-harness
```

### 关于 `npm:` 字段（重要）

**当前刻意不写 `npm:` 字段。** 市场的 `lib/sources.js` 里 `installTargetFor()` 的逻辑是：

```js
if (typeof entry.npm === 'string' && NPM_NAME_RE.test(entry.npm)) return entry.npm;  // ← 优先
return source.subpath !== null ? `github:${source.repo}#path:/${source.subpath}` : `github:${source.repo}`;
```

也就是说，一旦写了 `npm:`，给用户的安装命令就变成 `dsh-public-relay` —— 包若还没发到 npm，
**用户点了就是失败**。而我们现在还没发布，所以走 `github:` 回落路径是当下唯一正确的选择：

```
github:liuNNW/dsh-public-relay#path:/plugin/dsh-public-relay
```

（这条需要用户按提示做一次 `allowBuilds` 授权，因为 GitHub 来源会跑安装期脚本。）

**npm 发布成功后**，再单独提一个小 PR 把这一行加回去，让安装跳过授权步骤：

```sh
editor data/plugins/liuNNW__dsh-public-relay--plugin-dsh-public-relay.yml
# 在 category 下面插入一行：
# npm: dsh-public-relay
```

> 顺序很重要：**先发 npm，再加 `npm:` 字段**。反过来会让那条命令指向一个不存在的包。

### 描述为什么这么写

收录指南明确写着：**描述会被当作对插件的声明并与代码逐条核对**，夸大是唯一会让好插件被打回的原因。
所以上面 `description` 里每一项都能在代码里指到具体位置：

| 声明 | 实现位置 |
| --- | --- |
| 改写 Host/Origin 过信任栅栏 | `lib/relay.js` 的 `rewriteHeaders()` |
| 改写 `isLoopback` 让公网插件列表可见 | `lib/relay.js` 的 `LOOPBACK_PATTERNS`（三条候选正则） |
| HMAC 签名口令 Cookie | `lib/relay.js` 的 `makeAuth()`（`timingSafeEqual` 校验、失败固定延时） |
| 代签宿主会话 Cookie | `lib/dsh-cookie.js`（复刻 `dsh-auth-*` 格式：`v1.<payload>.<sig>`） |
| WebSocket 透传 | `lib/relay.js` 的 `handleUpgrade()` |
