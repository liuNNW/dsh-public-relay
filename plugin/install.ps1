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

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
  # ── 参数净化 ────────────────────────────────────────────────────────────
  # 这两个值直接参与 Join-Path，随后会被 Remove-Item -Recurse 删除。因此必须
  # 在**参数绑定阶段**就拒掉一切能改变路径形状或指向别处的输入 —— 脚本体里
  # 任何一处疏漏都不至于变成「删掉了 $HOME 以外的东西」。
  #
  # $Profile：只允许 ASCII 字母数字打头，后跟字母数字 / '.' / '_' / '-'。
  #   · 禁止前导 '-'：否则 `powershell -File install.ps1 -Profile -Revert`
  #     这类调用会被 PowerShell 解析成 -Revert 开关（参数注入）。
  #   · 禁止前导 '.'：直接挡掉 '.' / '..'。
  #   · 禁止 '/' 与 '\'：Profile 是单段名字，不是路径。
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),

  # $DshHome：允许空格（路径里很常见），但禁止控制字符、NUL、引号、
  # 通配符与 '|', '<' '>' —— 这些在 Windows 路径解析里要么是分隔符、
  # 要么会被重定向，不该出现在一个会被递归删除的根目录里。
  # 纯词法挡住不了 '..'（'C:\a\..\b' 是合法字符串但语义指向别处），
  # 那一层由下面的 Assert-ContainedPath 在做任何事之前断言。
  [ValidatePattern('^[^<>|"''`$*?\x00-\x1f]+$')]
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),

  [switch]$Install,
  [switch]$Revert,
  [switch]$Check,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

# ─────────────────────────── 路径规范化与包含性断言 ───────────────────────────
#
# ValidatePattern 只管**词法**。下面这一层管**语义**：即便 $DshHome 与 $Profile
# 各自长得人畜无害，组合出来的路径也未必落在 $DshHome 之内（'..'、reparse
# point / junction / 符号链接都可以把目录解析到别处）。凡是要被
# Remove-Item -Recurse 碰的路径，都必须先过这个断言。

# 取绝对、规范化的完整路径（解析 '..'、'.'、相对段、尾部斜杠）。
function Get-NormalizedPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  # 去掉尾部分隔符，让比较不受 'C:\a\' vs 'C:\a' 影响；保留盘符根 'C:\'。
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $root.Length) {
    $full = $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar,
                          [System.IO.Path]::AltDirectorySeparatorChar)
  }
  return $full
}

# 用 OrdinalIgnoreCase 比较（Windows 路径大小写不敏感）。
function Test-SameOrUnder([string]$Root, [string]$Candidate) {
  if ($Root.Length -eq 0) { return $false }
  if ($Candidate.Length -lt $Root.Length) { return $false }
  if (-not $Candidate.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  # 必须是根本身，或根 + 一个分隔符。'$Root' = 'C:\a' 时，
  # 'C:\abc' 必须判为「不在里面」，否则前缀匹配会误判。
  if ($Candidate.Length -eq $Root.Length) { return $true }
  $sep = [System.IO.Path]::DirectorySeparatorChar
  return $Candidate[$Root.Length] -eq $sep
}

# 拒绝 reparse point / junction / 符号链接：它们能让「看起来在 $DshHome 内」
# 的目录实际解析到别处。沿整条链逐级检查。
function Assert-NoReparsePoint([string]$Path, [string]$StopAt) {
  $cur = $Path
  while ($true) {
    if (Test-Path -LiteralPath $cur) {
      $item = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
      if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "路径包含 reparse point / junction / 符号链接，已中止：$cur"
      }
    }
    if (-not (Test-SameOrUnder $StopAt $cur)) { return }
    if (Test-SameOrUnder $StopAt $cur) {
      $parent = [System.IO.Path]::GetDirectoryName($cur)
      if (-not $parent -or $parent -eq $cur) { return }
      $cur = $parent
    } else { return }
  }
}

# 组合一个「已规范化、且断言在 $Root 之内」的路径。任何越界立即 throw。
function Resolve-ContainedPath([string]$Root, [string[]]$Parts, [string]$What) {
  $rootNorm = Get-NormalizedPath $Root
  $joined = $Parts | ForEach-Object { Join-Path $rootNorm $_ }
  $full = Get-NormalizedPath ($joined -join [System.IO.Path]::DirectorySeparatorChar)

  if (-not (Test-SameOrUnder $rootNorm $full)) {
    throw "$What 越出了 DSH home（root='$rootNorm'，resolved='$full'），已中止。"
  }
  Assert-NoReparsePoint $full $rootNorm
  return $full
}

# 写入类 / 删除类目标都从这里出，拿到的一定是绝对规范路径。
$DshHomeNorm = Get-NormalizedPath $DshHome

$PluginSrc  = Get-NormalizedPath (Join-Path $PSScriptRoot 'dsh-public-relay')
$ToolsDir   = Get-NormalizedPath (Join-Path $PSScriptRoot 'tools')
$TestsDir   = Get-NormalizedPath (Join-Path $PSScriptRoot 'tests')

# Profile 相关的三个路径统一走包含性断言：'-Profile ..\..' 这类输入在这里
# 就地中止，**在任何 Test-Path / Remove-Item 之前**。
$ProfilesDir = Resolve-ContainedPath $DshHomeNorm @('profiles') 'profiles 目录'
$ProfileDir  = Resolve-ContainedPath $ProfilesDir  @($Profile)  'profile 目录'
$ProfilePkg  = Get-NormalizedPath (Join-Path $ProfileDir 'package.json')
$PatchFile   = Get-NormalizedPath (Join-Path $ProfileDir 'cordis.patch.yml')
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
  # 本函数自己是高级函数（SupportsShouldProcess），函数体内的 $PSCmdlet 直接可用，
  # -WhatIf 会正确传播到下面的删除守卫。
  # （不要试图把脚本级的 $PSCmdlet 当参数传进来：跨函数作用域的 $PSCmdlet
  #   在调用时并未绑定，会传成 $null。）
  # ConfirmImpact 必须显式压到 'Low'（默认值是 'Medium'）。若留成 'Medium'/'High'，
  # $PSCmdlet.ShouldProcess 会按 $ConfirmPreference 弹交互确认；在非交互宿主
  # （CI、计划任务、无人值守）里这不是提示，而是抛 NullReferenceException，
  # 结果是**真正该执行的那次运行直接失败**。
  # 'Low' = 默认不询问，只在调用方显式传 -WhatIf/-Confirm 时才生效。
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
  param()

  Say "清理：$Profile profile 的 dsh-public-relay"

  # 1. 早期手工方式写进 cordis.patch.yml 的条目
  $clean = Join-Path $ToolsDir 'clean-relay-rows.mjs'
  if ((Test-Path $clean) -and (Test-Path $PatchFile) -and (Select-String -Path $PatchFile -Pattern 'dsh-public-relay' -Quiet)) {
    & node $clean $ProfileDir --remove
  } else { Say 'cordis.patch.yml 里没有残留条目' }

  # 2. 早期手工方式放进 profile 本地 node_modules 的副本
  #
  # 删除是不可逆操作，这里做三件事：
  #   · 每个目标都重新过一遍包含性断言（不依赖脚本头部那次计算的假设）；
  #   · -LiteralPath：绝不让路径里的 [] 等字符被当成通配符；
  #   · -Force：显式要求。ReadOnly / Hidden / 只读文件在递归删除下会抛错，
  #     没有 -Force 会留下删不掉的半截目录 —— 宁可报错也不要静默半删。
  foreach ($dst in @(
      (Join-Path $ProfileDir  'node_modules\dsh-public-relay'),
      (Join-Path $ProfilesDir 'node_modules\dsh-public-relay'))) {
    $dstFull = Get-NormalizedPath $dst
    if (-not (Test-SameOrUnder $DshHomeNorm $dstFull)) {
      throw "待删除路径越出了 DSH home，已中止：$dstFull"
    }
    Assert-NoReparsePoint $dstFull $DshHomeNorm
    if (Test-Path -LiteralPath $dstFull) {
      if ($PSCmdlet.ShouldProcess($dstFull, '递归删除（-Recurse -Force）')) {
        Remove-Item -LiteralPath $dstFull -Recurse -Force
        Say "已删除 $dstFull"
      } else {
        Say "[WhatIf] 会删除 $dstFull"
      }
    }
  }

  # 3. 配置文件的「孤儿副本」：旧版本可能落在别处
  foreach ($cfg in @(
      (Join-Path $ProfileDir 'dsh-public-relay.json'),
      (Join-Path $DshHomeNorm 'dsh-public-relay.json'))) {
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
