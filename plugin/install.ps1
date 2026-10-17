# dsh-public-relay 安装/卸载脚本（bundle 通道）
#
# 0.2.0 起本插件按**标准 bundle 方式**安装，不再手改 profile 的 cordis.patch.yml。
# 这条通道由 dsh 自己维护：
#
#   · 官方 CLI:   dsh plugin --profile <name> add dsh-public-relay
#   · 本仓库本地目录:  由 dsh 的 plugin_manager（install_bundle）完成
#
# 本脚本做的事，都是在**没装上**时给出可复制的命令，以及在回滚时清理
# 「早期手工安装方式」留下的残留。它不再自己拼 node_modules、不再自己写 patch。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File plugin\install.ps1                 # 打印安装指引 + 自检
#   powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Install       # 尝试用官方 CLI 安装
#   powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Revert        # 清理残留（含旧手工安装）
#   powershell -ExecutionPolicy Bypass -File plugin\install.ps1 -Check         # 只跑自检

[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [switch]$Install,
  [switch]$Revert,
  [switch]$Check,
  [switch]$SkipTests,
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' })
)

$ErrorActionPreference = 'Stop'

$PluginSrc  = Join-Path $PSScriptRoot 'dsh-public-relay'
$ToolsDir   = Join-Path $PSScriptRoot 'tools'
$TestsDir   = Join-Path $PSScriptRoot 'tests'
$ProfilesDir = Join-Path $DshHome 'profiles'
$ProfileDir  = Join-Path $ProfilesDir $Profile
$ProfilePkg  = Join-Path $ProfileDir 'package.json'
$PatchFile   = Join-Path $ProfileDir 'cordis.patch.yml'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say([string]$m)  { Write-Host "[dsh-public-relay] $m" }
function Warn([string]$m) { Write-Host "[dsh-public-relay] $m" -ForegroundColor Yellow }
function Good([string]$m) { Write-Host "[dsh-public-relay] $m" -ForegroundColor Green }
function Bad([string]$m)  { Write-Host "[dsh-public-relay] $m" -ForegroundColor Red }
function Hint([string]$m) { Write-Host "    $m" -ForegroundColor Cyan }

# ─────────────────────────── 自检 ───────────────────────────

function Invoke-Checks {
  # 注意：PowerShell 函数会把所有未捕获输出都当成返回值，所以调用方拿到的会是
  # object[] 而不是失败计数。这里每条命令都吃掉输出，失败数写脚本作用域变量。
  $script:checkFailures = 0

  Say "DSH home    : $DshHome"
  Say "目标 profile: $Profile ($ProfileDir)"

  if (-not (Test-Path $PluginSrc)) { Bad "找不到插件源码: $PluginSrc"; $script:checkFailures = 1; return }

  # 1. package.json 语法
  try {
    $manifest = Get-Content (Join-Path $PluginSrc 'package.json') -Raw | ConvertFrom-Json
    Good "package.json 可解析（$($manifest.name)@$($manifest.version)）"
  } catch {
    Bad "package.json 解析失败：$($_.Exception.Message)"; $script:checkFailures = 1; return
  }

  # 2. 兼容性声明
  Say '自检：兼容性声明（engines.dsh / peerDependencies / bundle / client）'
  $compat = Join-Path $ToolsDir 'check-compat.mjs'
  if (Test-Path $compat) {
    & node $compat (Join-Path $PluginSrc 'package.json')
    if ($LASTEXITCODE -ne 0) { Bad '兼容性自检未通过（插件会被判 incompatible-version）'; $script:checkFailures++ }
    else { Good '兼容性声明 ✓' }
  } else { Warn "找不到 $compat，跳过" }

  # 3. 所有 lib/*.js 语法
  Say '自检：lib/*.js 语法'
  $bad = 0
  foreach ($f in (Get-ChildItem (Join-Path $PluginSrc 'lib') -Filter '*.js' -File)) {
    & node --check $f.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Bad "语法错误: $($f.Name)"; $bad++ }
  }
  if ($bad -eq 0) { Good 'lib 下所有 JS 语法 ✓' } else { $script:checkFailures += $bad }

  # 4. 配置文件里引用的资源是否都在
  $need = @('lib\index.js', 'lib\client.js', 'lib\relay.js', 'lib\config.js', 'lib\dsh-cookie.js',
            'cordis.patch.yml', 'locale\zh.json', 'locale\en.json', 'icon.svg')
  $missing = @($need | Where-Object { -not (Test-Path (Join-Path $PluginSrc $_)) })
  if ($missing.Count -gt 0) { Bad "缺少文件: $($missing -join ', ')"; $script:checkFailures++ }
  else { Good '必需文件齐全 ✓' }

  # 5. 四套测试
  if (-not $SkipTests) {
    Say '跑五套测试（中转核心 / 宿主半 / 浏览器半 / 会话代签 / 口令模式）'
    foreach ($t in @('smoke.mjs', 'host-integration.mjs', 'client-half.mjs', 'dsh-session.spec.mjs', 'password-modes.mjs')) {
      $tp = Join-Path $TestsDir $t
      if (-not (Test-Path $tp)) { Warn "找不到 $t，跳过"; continue }
      & node $tp *> $null
      if ($LASTEXITCODE -ne 0) { Bad "$t 失败（exit $LASTEXITCODE）"; $script:checkFailures++ }
      else { Good "$t ✓" }
    }
  }

  }

# ─────────────────────────── 回滚 / 清理 ───────────────────────────

function Invoke-Revert {
  Say "清理：$Profile profile 的 dsh-public-relay"

  # 1. 早期手工方式写进 cordis.patch.yml 的条目
  $clean = Join-Path $ToolsDir 'clean-relay-rows.mjs'
  if ((Test-Path $clean) -and (Test-Path $PatchFile) -and (Select-String -Path $PatchFile -Pattern 'dsh-public-relay' -Quiet)) {
    & node $clean $ProfileDir --remove
  } else { Say 'cordis.patch.yml 里没有残留条目' }

  # 2. 早期手工方式放进 profile 本地 node_modules 的副本
  foreach ($dst in @(
      (Join-Path $ProfileDir 'node_modules\dsh-public-relay'),
      (Join-Path $ProfilesDir 'node_modules\dsh-public-relay'))) {
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force; Say "已删除 $dst" }
  }

  # 3. 配置文件的「孤儿副本」：旧版本可能落在别处
  foreach ($cfg in @(
      (Join-Path $ProfileDir 'dsh-public-relay.json'),
      (Join-Path $DshHome 'dsh-public-relay.json'))) {
    if (Test-Path $cfg) {
      Say "保留用户配置 $cfg（删除它会丢掉口令与端口设置）"
      Say '  如需一并删除，手工 Remove-Item 该文件'
    }
  }

  Warn 'bundle 通道安装的版本请用官方命令移除：'
  Hint "dsh plugin --profile $Profile remove dsh-public-relay"
  Hint '  或在 GUI：设置 → 插件 → 找到 DSH 中转 → 卸载'
  Hint ''
  $leftPatch = (Test-Path $PatchFile) -and (Select-String -Path $PatchFile -Pattern 'dsh-public-relay' -Quiet)
  $leftBundles = (Test-Path $ProfilePkg) -and ((Get-Content $ProfilePkg -Raw) -match '"dsh-public-relay"')
  if ($leftPatch) { Warn "$PatchFile 里仍有 dsh-public-relay" } else { Good 'patch 文件已清干净' }
  if ($leftBundles) { Say 'profile package.json 里仍列着 dsh-public-relay（bundle 通道的正常状态）' } else { Good 'bundles 里没有它' }

  Good '清理完成。重启 dsh 后生效。'
  return 0
}

# ─────────────────────────── 安装指引 ───────────────────────────

function Show-InstallHint {
  Write-Host ''
  Good '安装本插件（二选一）'
  Write-Host ''
  Write-Host '  A. 官方 CLI（从 npm 安装）' -ForegroundColor Cyan
  Hint "dsh plugin --profile $Profile add dsh-public-relay"
  Write-Host ''
  Write-Host '  B. 本仓库的本地目录（不发布也能装）' -ForegroundColor Cyan
  Hint "在 dsh 会话里让 Agent 调用 plugin_manager 的 install_bundle，target 指向："
  Hint "  $PluginSrc"
  Hint '  或在 GUI：设置 → 插件 → 安装本地插件 → 选上面的目录'
  Write-Host ''
  Write-Host '  装完不用改任何 profile 文件：bundle 会自动追加到 dsh.profile.bundles，' -ForegroundColor DarkGray
  Write-Host '  并在启动时合并本包的 cordis.patch.yml。' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  重启后在哪里看：' -ForegroundColor Cyan
  Hint '设置 → 「DSH 中转」                ← 独立整页（主入口）'
  Hint '设置 → 插件 → DSH 中转 → 配置      ← 同一份配置的行级配置页'
  Write-Host ''
  Write-Host '  配置文件（改了就生效，无需重启）：' -ForegroundColor DarkGray
  Hint (Join-Path $ProfileDir 'dsh-public-relay.json')
  Write-Host ''
  Write-Host "  清理旧的手工安装残留：powershell -File `"$PSCommandPath`" -Revert" -ForegroundColor DarkGray
}

# ─────────────────────────── 入口 ───────────────────────────

if ($Revert) {
  Invoke-Revert
  exit 0
}

if ($Check) {
  Invoke-Checks
  if ($script:checkFailures -eq 0) { Good '自检全部通过 ✓'; exit 0 }
  Bad "自检失败 $($script:checkFailures) 项"; exit 1
}

if ($Install) {
  Invoke-Checks
  if ($script:checkFailures -ne 0) { Bad "自检失败 $($script:checkFailures) 项，已中止安装"; exit 1 }

  Say "尝试用官方 CLI 安装到 profile '$Profile'"
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if (-not $dsh) {
    Bad 'PATH 上找不到 dsh 命令'
    Show-InstallHint
    exit 1
  }
  & dsh plugin --profile $Profile add dsh-public-relay
  if ($LASTEXITCODE -ne 0) {
    Bad "安装失败（exit $LASTEXITCODE）。若本包尚未发布到 npm，请用本地目录方式（见下）。"
    Show-InstallHint
    exit 1
  }
  Good '安装完成，重启 dsh 生效。'
  exit 0
}

# 默认：自检 + 指引
Invoke-Checks
Write-Host ''
if ($script:checkFailures -ne 0) { Bad "自检失败 $($script:checkFailures) 项（见上）" } else { Good '自检全部通过 ✓' }
Show-InstallHint
exit 0
