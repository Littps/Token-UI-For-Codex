# Tokens UI For Codex —— 动态定位工具（install / uninstall / autostart 共用）
#
# 为什么需要它（全部来自实测）：
#   1) Codex 桌面版是 MSIX 安装（WindowsApps），只在它自己启动的子进程里
#      临时注入 bin 目录，**系统 PATH 里并没有** —— 所以"双击运行"时
#      Get-Command codex 必然失败。
#   2) bin 下的目录名带随版本变化的哈希（实测同时存在两个哈希目录），
#      **任何写死路径的做法都会在 Codex 更新后失效**。
#   3) 桌面版进程名是 ChatGPT.exe（不是 codex.exe），且 MSIX 包名里含版本号。
#   4) Codex 自带 Node 运行时（v24），用户机器没装 Node 也能跑监控。
#
# 用法：在脚本里 dot-source 本文件
#   . (Join-Path $PSScriptRoot "find-codex.ps1")
# 然后调用：
#   Resolve-CodexCli         定位 codex CLI（PATH → MSIX bin 哈希目录 → npm → 常见位置）
#   Resolve-CodexApp         定位 Codex 桌面版（MSIX 包 → 运行中进程 → 常见安装位置）
#   Test-CodexRunning        判断 Codex 桌面版是否在运行
#   Resolve-NodeCli          定位 Node（PATH → Codex 自带运行时 → 常见安装位置）
#   Resolve-CodexPlusPlus    定位 Codex++（运行中进程 → 常见安装位置）
#   Get-CodexPlusPlusSwitchState  读取 Codex++ 用户脚本总开关状态

# ---- Codex 桌面版 bin 根目录 ------------------------------------------------
function Get-CodexBinRoot {
  return (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin")
}

# ---- 定位 codex CLI（返回完整路径或 $null）----------------------------------
# 顺序：PATH → Codex bin 下最新的哈希目录 → npm 全局 → 常见安装位置
function Resolve-CodexCli {
  $fromPath = Get-Command codex -ErrorAction SilentlyContinue
  if ($fromPath -and $fromPath.Source) { return $fromPath.Source }

  $binRoot = Get-CodexBinRoot
  if (Test-Path -LiteralPath $binRoot) {
    $found = Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName "codex.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($found) { return $found }
  }

  foreach ($candidate in @(
      (Join-Path $env:APPDATA "npm\codex.cmd"),
      (Join-Path $env:APPDATA "npm\codex.ps1"),
      (Join-Path $env:LOCALAPPDATA "Programs\codex\codex.exe"),
      (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\codex.exe")
    )) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

# ---- 定位 Codex 桌面版（返回含 installed / source / path 的对象）------------
function Resolve-CodexApp {
  $result = [ordered]@{ installed = $false; source = ""; path = ""; packageFullName = ""; version = "" }

  # 1) 商店(MSIX)安装：包名与安装位置都随版本变化，必须动态查询
  $package = Get-AppxPackage -Name "*Codex*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($package) {
    $result.installed = $true
    $result.source = "msix"
    $result.path = $package.InstallLocation
    $result.packageFullName = $package.PackageFullName
    $result.version = [string]$package.Version
    return [pscustomobject]$result
  }

  # 2) 传统安装：从运行中的进程反查可执行文件位置
  $proc = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='codex.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath } | Select-Object -First 1
  if ($proc) {
    $result.installed = $true
    $result.source = "process"
    $result.path = Split-Path -Parent $proc.ExecutablePath
    return [pscustomobject]$result
  }

  # 3) 已知的传统安装位置兜底
  foreach ($candidate in @(
      (Join-Path $env:LOCALAPPDATA "Programs\ChatGPT\ChatGPT.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\Codex\Codex.exe"),
      (Join-Path $env:PROGRAMFILES "ChatGPT\ChatGPT.exe")
    )) {
    if (Test-Path -LiteralPath $candidate) {
      $result.installed = $true
      $result.source = "path"
      $result.path = Split-Path -Parent $candidate
      return [pscustomobject]$result
    }
  }
  return [pscustomobject]$result
}

# ---- 桌面版是否在运行 -------------------------------------------------------
# 实测：MSIX 版进程名是 ChatGPT.exe；旧版/其他渠道可能是 codex.exe。
# 同时用「可执行文件路径里含 OpenAI\Codex」兜底，避免只认进程名而漏判。
function Test-CodexRunning {
  $candidates = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='codex.exe'" -ErrorAction SilentlyContinue
  foreach ($proc in $candidates) {
    $path = [string]$proc.ExecutablePath
    if (-not $path) { return $true }              # 路径读不到也认为在运行（宁松勿漏）
    if ($path -match 'OpenAI\\Codex' -or $path -match 'ChatGPT' -or $path -match 'Codex') { return $true }
  }
  return $false
}

# ---- 定位 Codex++（负责注入用户脚本并提供本地 CDP 端口）----------------------
# 顺序：运行中的 codex-plus-plus 进程 → 常见安装位置。
# 返回对象：{ installed, exePath, running, userScriptsDir, userScriptsDirExists }
function Resolve-CodexPlusPlus {
  $userScriptsDir = Join-Path $env:APPDATA "Codex++\user_scripts"
  $result = [ordered]@{
    installed = $false
    exePath = ""
    running = $false
    userScriptsDir = $userScriptsDir
    userScriptsDirExists = (Test-Path -LiteralPath $userScriptsDir)
  }
  $proc = Get-CimInstance Win32_Process -Filter "Name='codex-plus-plus.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc) {
    $result.running = $true
    $result.installed = $true
    if ($proc.ExecutablePath) { $result.exePath = $proc.ExecutablePath }
  }
  if (-not $result.installed) {
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA "Programs\Codex++\codex-plus-plus.exe"),
        (Join-Path $env:PROGRAMFILES "Codex++\codex-plus-plus.exe")
      )) {
      if (Test-Path -LiteralPath $candidate) {
        $result.installed = $true
        $result.exePath = $candidate
        break
      }
    }
  }
  return [pscustomobject]$result
}

# ---- 读取 Codex++ 用户脚本总开关 --------------------------------------------
# 只读 %APPDATA%\Codex++\user_scripts.json 的 enabled 字段，绝不修改该文件。
# 返回：enabled / disabled / missing / invalid / unreadable
function Get-CodexPlusPlusSwitchState {
  $file = Join-Path $env:APPDATA "Codex++\user_scripts.json"
  if (-not (Test-Path -LiteralPath $file)) { return "missing" }
  try {
    $json = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
  } catch {
    return "unreadable"
  }
  if ($null -eq $json -or $null -eq $json.enabled) { return "invalid" }
  if ($json.enabled -eq $true) { return "enabled" }
  return "disabled"
}

# ---- 定位 Node（PATH → Codex 自带运行时 → 常见安装位置）---------------------
# 返回对象：{ path, version, major, source }
function Resolve-NodeCli {
  $candidates = @()
  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($fromPath -and $fromPath.Source) { $candidates += $fromPath.Source }

  # Codex 自带运行时（实测 v24），用户没装 Node 时的最佳回落
  $runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes"
  if (Test-Path -LiteralPath $runtimeRoot) {
    $candidates += Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Filter "node.exe" -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName
  }

  $candidates += @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  )

  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
    $version = ""
    try { $version = ((& $candidate --version 2>$null) | Select-Object -First 1).Trim() } catch { continue }
    if ($version -notmatch "^v(\d+)") { continue }
    return [pscustomobject]@{
      path    = $candidate
      version = $version
      major   = [int]$Matches[1]
      source  = if ($fromPath -and $fromPath.Source -eq $candidate) { "path" } else { "fallback" }
    }
  }
  return $null
}
