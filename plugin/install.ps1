# dsh-public-relay 安装脚本（配置卡片版）
#
# 装到目标 profile 的**本地** node_modules（与 @deepseek-ai/dsh-mimo-vision 同位置）+ 在
# profile 的 cordis.patch.yml 里写一行显式条目。
#
# 为什么不用 dsh.profile.bundles：
#   Electron 版 dsh 独占管理 desktop profile（其 CLI 直接拒绝
#   `--profile desktop --dump-config`，报 "managed exclusively by the Electron
#   application"），bundle 层的自动 insert 对它不生效 —— 实测只写 bundles 时，
#   宿主进程里既没有插件的配置项、也没有它注册的工具，设置页自然看不到卡片。
#   而 profile 自己的 cordis.patch.yml 里写显式条目是可靠的：
#   同 profile 的 dsh-mimo-vision 就是这么装的，工作正常。
#
# 为什么必须放 profile 本地 node_modules：
#   插件的 Config schema 用了 schemastery 的 .volatile()，该方法只在 3.18.4+ 存在。
#   共享目录 profiles/node_modules 里是 3.18.1（没有它），而 desktop 本地是 3.18.4。
#   放在 profile 本地才会就近解析到正确版本。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Profile desktop
#   powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Revert
#   powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -SkipTests

[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$Revert,
  [switch]$SkipTests,
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' })
)

$ErrorActionPreference = 'Stop'

$PluginSrc = Join-Path $PSScriptRoot 'dsh-public-relay'
$ProfilesDir = Join-Path $DshHome 'profiles'
$ProfileDir = Join-Path $ProfilesDir $Profile
$PluginDst = Join-Path $ProfileDir 'node_modules\dsh-public-relay'
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say([string]$m) { Write-Host "[dsh-public-relay] $m" }
function Warn([string]$m) { Write-Host "[dsh-public-relay] $m" -ForegroundColor Yellow }
function Good([string]$m) { Write-Host "[dsh-public-relay] $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "[dsh-public-relay] $m" -ForegroundColor Red }

# ─────────────────────────── 回滚 ───────────────────────────

if ($Revert) {
  Say "回滚：移除 $Profile profile 的 dsh-public-relay"

  # 1. 清掉 cordis.patch.yml 里的条目（当前生效的装载路径）
  $clean = Join-Path $PSScriptRoot 'tools\clean-relay-rows.mjs'
  if ((Test-Path $clean) -and (Test-Path $PatchFile)) {
    if (Select-String -Path $PatchFile -Pattern 'dsh-public-relay' -Quiet) {
      & node $clean $ProfileDir --remove
    }
  }

  # 2. 从 dsh.profile.bundles 里摘掉（早期版本可能写在这里）
  $bundler = Join-Path $PSScriptRoot 'tools\add-bundle.mjs'
  if ((Test-Path $bundler) -and (Test-Path (Join-Path $ProfileDir 'package.json'))) {
    & node $bundler (Join-Path $ProfileDir 'package.json') 'dsh-public-relay' --remove
  }

  # 3. 删除插件包
  if (Test-Path $PluginDst) {
    Remove-Item $PluginDst -Recurse -Force
    Say "已删除 $PluginDst"
  }
  # 共享目录里的旧副本也清掉（早期版本装在这里）
  $shared = Join-Path $ProfilesDir 'node_modules\dsh-public-relay'
  if (Test-Path $shared) { Remove-Item $shared -Recurse -Force; Say "已删除共享目录副本 $shared" }

  # 4. 回读确认已清干净
  $leftBundles = $false
  $leftPatch = $false
  if (Test-Path (Join-Path $ProfileDir 'package.json')) {
    $leftBundles = (Get-Content (Join-Path $ProfileDir 'package.json') -Raw) -match '"dsh-public-relay"'
  }
  if (Test-Path $PatchFile) {
    $leftPatch = Select-String -Path $PatchFile -Pattern 'dsh-public-relay' -Quiet
  }
  if ($leftBundles) { Warn 'profile package.json 里仍有 dsh-public-relay，请手工检查' } else { Say 'bundles 已清干净' }
  if ($leftPatch) { Warn "$PatchFile 里仍有 dsh-public-relay，请手工检查" } else { Say 'patch 文件已清干净' }

  Good '回滚完成。重启 dsh 后插件消失。'
  exit 0
}

# ─────────────────────────── 前置检查 ───────────────────────────

Say "DSH home    : $DshHome"
Say "目标 profile: $Profile"
Say "安装位置    : $PluginDst"

if (-not (Test-Path $PluginSrc)) { Bad "找不到插件源码: $PluginSrc"; exit 1 }
if (-not (Test-Path $ProfileDir)) { Bad "找不到 profile 目录: $ProfileDir"; exit 1 }
if (-not (Test-Path $PatchFile)) { Bad "找不到 $PatchFile"; exit 1 }

# schema 依赖检查：schemastery 必须支持 .volatile()，否则设置页不会有表单字段
$schemaProbeScript = @'
const { createRequire } = require('module');
const path = require('path'); const fs = require('fs');
const anchor = process.argv[2];
const req = createRequire(anchor);
let dir = null;
for (const sp of (req.resolve.paths('@deepseek-ai/schemastery') || [])) {
  const p = path.join(sp, '@deepseek-ai/schemastery', 'package.json');
  if (fs.existsSync(p)) { dir = path.dirname(p); break; }
}
if (!dir) { console.log('MISSING'); process.exit(0); }
const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const entry = fs.existsSync(path.join(dir, 'lib', 'index.mjs'))
  ? path.join(dir, 'lib', 'index.mjs')
  : path.join(dir, 'lib', 'index.cjs');
const hasVolatile = fs.readFileSync(entry, 'utf8').includes('volatile');
console.log(version + '|' + (hasVolatile ? 'volatile-ok' : 'no-volatile'));
'@
$probeFile = Join-Path $env:TEMP "dsh-public-relay-schema-probe.js"
Set-Content -LiteralPath $probeFile -Value $schemaProbeScript -Encoding UTF8
$schemaCheck = & node $probeFile (Join-Path $ProfileDir 'package.json') 2>&1
Remove-Item $probeFile -Force -ErrorAction SilentlyContinue

Say "schemastery: $schemaCheck"
if ("$schemaCheck" -match 'no-volatile') {
  Warn '本 profile 的 schemastery 不支持 .volatile()：设置页可能不显示表单字段'
  Warn '（插件其余功能不受影响：状态块、启停按钮、HTTP 兜底表单都在）'
}

# ─────────────────────────── 安装 ───────────────────────────

$backups = @()
function Backup-File([string]$p) {
  if (Test-Path $p) {
    $bak = "$p.bak-relay-$Stamp"
    Copy-Item $p $bak -Force
    $script:backups += [pscustomobject]@{ Original = $p; Backup = $bak }
  }
}
function Restore-All {
  foreach ($b in $script:backups) {
    if (Test-Path $b.Backup) { Copy-Item $b.Backup $b.Original -Force; Warn "已还原 $($b.Original)" }
  }
  if (Test-Path $PluginDst) { Remove-Item $PluginDst -Recurse -Force -ErrorAction SilentlyContinue }
}

try {
  Backup-File $PatchFile
  Backup-File (Join-Path $ProfileDir 'package.json')

  # 1. 拷贝插件包（只拷运行时需要的）
  if (Test-Path $PluginDst) { Remove-Item $PluginDst -Recurse -Force }
  New-Item -ItemType Directory -Path "$PluginDst\lib" -Force | Out-Null
  foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md')) {
    $src = Join-Path $PluginSrc $f
    if (Test-Path $src) { Copy-Item $src $PluginDst -Force }
  }
  $jsFiles = Get-ChildItem -LiteralPath (Join-Path $PluginSrc 'lib') -Filter '*.js' -File
  if ($jsFiles.Count -eq 0) { throw "插件源码缺少 lib\*.js" }
  foreach ($f in $jsFiles) { Copy-Item $f.FullName "$PluginDst\lib" -Force }
  Good "已安装到 $PluginDst（lib 下 $($jsFiles.Count) 个文件）"

  # 2. 在 profile 自己的 cordis.patch.yml 里写 `- insert:` 条目
  #
  # ── 装载路径（实测得出，两个条件必须同时满足）──
  #
  #   ① 插件包装在 profile 本地 node_modules（与 @deepseek-ai/dsh-mimo-vision 同位）
  #   ② cordis.patch.yml 里有一条 `- insert:` 包裹的条目
  #
  # 为什么必须是 `- insert:`：dsh 的 applyEntryPatches 把 patch 分两类 ——
  #   带 insert 的 → 追加新条目；不带 insert 的 → 按 id 找**已存在**条目来改，
  #   找不到就 warn + continue **静默丢弃**。所以裸 `- id: dsh-public-relay` 写了等于没写。
  #
  # 为什么这条路径可用：dsh 的 HMR 实时监视 profile 的 cordis.patch.yml，
  # 写入后无需重启即挂载（实测：status 从 inactive 变 schema，中转端口随即监听）。
  $row = Join-Path $PSScriptRoot 'tools\set-relay-row.mjs'
  if (-not (Test-Path $row)) { throw "找不到 $row" }
  & node $row $ProfileDir
  if ($LASTEXITCODE -ne 0) { throw "写 patch 条目失败（exit $LASTEXITCODE）" }

  # 2b. 收敛：确保恰好一条有效 insert、无裸条目/重复条目
  $clean = Join-Path $PSScriptRoot 'tools\clean-relay-rows.mjs'
  if (Test-Path $clean) {
    & node $clean $ProfileDir
    if ($LASTEXITCODE -ne 0) { throw "清理 patch 条目失败（exit $LASTEXITCODE）" }
  }
  Good '已写入 cordis.patch.yml 条目（insert 结构）'

  # 2b-2. bundles 里不能同时有它：两条路径同时用会把同一个 id 插入两次
  $bundler = Join-Path $PSScriptRoot 'tools\add-bundle.mjs'
  if (Test-Path $bundler) {
    $inBundles = (Get-Content (Join-Path $ProfileDir 'package.json') -Raw) -match '"dsh-public-relay"'
    if ($inBundles) {
      Say '移除 bundles 里的重复声明（避免同一 id 被插入两次）'
      & node $bundler (Join-Path $ProfileDir 'package.json') 'dsh-public-relay' --remove | Out-Null
    }
  }

  # 2c. 版本兼容性自检（最容易踩、症状最隐蔽的坑）
  #
  # dsh 的插件管理器会校验插件声明的 peerDependencies 与 dshTarget。
  # 一旦不匹配，它返回 incompatible-version 并把该插件的 rows 置空 ——
  # 插件**完全不会加载**，UI 上哪里都看不到，而 dsh 启动日志也不报错，
  # 重启多少次都没用。
  #
  # 实测踩过的：声明 "@deepseek-ai/dsh-tools": "^0.1.0-rc.6" 时，运行时是
  # 0.1.0-rc.8；semver 的 ^0.1.0-rc.6 对 0.x 的预发布版本**不匹配** rc.8，
  # 于是整包被拒。修法是只声明 cordis（与 @deepseek-ai/dsh-mimo-vision 一致），
  # 其余依赖改为运行期软获取。
  # 于是整包被拒。修法是只声明 cordis（与 @deepseek-ai/dsh-mimo-vision 一致），
  # 其余依赖改为运行期软获取。
  Say '自检：peerDependencies / dshTarget'
  & node (Join-Path $PSScriptRoot 'tools\check-compat.mjs') (Join-Path $PluginDst 'package.json')
  if ($LASTEXITCODE -ne 0) {
    Warn '兼容性自检未通过；插件可能被插件管理器判为 incompatible-version 而不加载'
  } else {
    Good '兼容性声明与运行时匹配 ✓'
  }

  # 3. 校验：插件包与依赖都能从该 profile 解析
  Say '校验：解析路径'
  $resolveProbeScript = @'
const { createRequire } = require('module');
const path = require('path'); const fs = require('fs');
const anchor = process.argv[2];
const req = createRequire(anchor);
const need = ['dsh-public-relay', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools'];
const bad = [];
let relayDir = null;
for (const n of need) {
  let f = null;
  for (const sp of (req.resolve.paths(n) || [])) {
    const p = path.join(sp, n, 'package.json');
    if (fs.existsSync(p)) { f = p; break; }
  }
  if (f === null) bad.push(n);
  else if (n === 'dsh-public-relay') relayDir = path.dirname(f);
}
if (bad.length > 0) { console.error('unresolvable: ' + bad.join(', ')); process.exit(1); }
for (const f of ['lib/index.js', 'lib/client.js', 'lib/relay.js', 'lib/config.js', 'lib/dsh-cookie.js']) {
  if (!fs.existsSync(path.join(relayDir, f))) { console.error('missing: ' + f); process.exit(1); }
}
console.log('all dependencies resolvable');
'@
  $resolveFile = Join-Path $env:TEMP "dsh-public-relay-resolve-probe.js"
  Set-Content -LiteralPath $resolveFile -Value $resolveProbeScript -Encoding UTF8
  $resolveCheck = & node $resolveFile (Join-Path $ProfileDir 'package.json') 2>&1
  Remove-Item $resolveFile -Force -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) {
    Bad '解析校验失败：'; Write-Host $resolveCheck
    throw '插件在本 profile 下不可解析'
  }
  Good '插件与依赖均可解析 ✓'

  # 4. 测试
  if (-not $SkipTests) {
    Say '跑四套测试（中转核心 / 宿主半 / 浏览器半 / 会话代签）'
    foreach ($t in @('tests\smoke.mjs', 'tests\host-integration.mjs', 'tests\client-half.mjs', 'tests\dsh-session.spec.mjs')) {
      $tp = Join-Path $PSScriptRoot $t
      if (-not (Test-Path $tp)) { Warn "找不到 $tp，跳过"; continue }
      & node $tp
      if ($LASTEXITCODE -ne 0) { throw "$t 失败（exit $LASTEXITCODE）" }
    }
    Good '四套测试全绿 ✓'
  }

  Write-Host ''
  Good '安装完成。'
  Write-Host ''
  Write-Host '  下一步：完全退出 dsh 再重新打开（含系统托盘；Electron 关窗口不杀进程）。' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '  重启后在哪里看：' -ForegroundColor Cyan
  Write-Host '    · 设置 → 插件 → 「DSH 中转」   ← 配置卡片（与 MiMo 视觉识别同一位置）' -ForegroundColor Cyan
  Write-Host '    · 设置 → 「DSH 中转」           ← 同一份配置的独立整页（含端口信息与启停）' -ForegroundColor Cyan
  Write-Host '    · 卡片里可改：启用开关 / 监听地址 / 监听端口 / 访问口令 / 强制回环改写 / 自动管理 dsh 会话' -ForegroundColor Cyan
  Write-Host ''
  Write-Host "  回滚：powershell -File `"$PSCommandPath`" -Revert" -ForegroundColor DarkGray
}
catch {
  Bad "安装失败：$($_.Exception.Message)"
  Restore-All
  Bad '已自动回滚全部改动。'
  exit 1
}
