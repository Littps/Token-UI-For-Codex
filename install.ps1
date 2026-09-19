# Tokens UI For Codex —— 自动安装脚本（Windows）
#
# 用法：
#   install.bat                     双击即可（优先使用 pwsh 7，没有则用 Windows PowerShell 5.1）
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# 可选参数：
#   -SkipAutostart   不安装“登录自启守护”（默认会安装）
#   -SkipPlugin      跳过 Codex 插件注册（只安装用户脚本）

[CmdletBinding()]
param(
  [switch]$SkipAutostart,
  [switch]$SkipPlugin
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pluginRoot = Join-Path $root "plugins\tokens-ui-for-codex"
$marketplaceFile = Join-Path $root ".agents\plugins\marketplace.json"
$panelSource = Join-Path $pluginRoot "codex-token-spend-panel.js"
$statsScript = Join-Path $pluginRoot "token-stats.mjs"
$userScripts = Join-Path $env:APPDATA "Codex++\user_scripts"
$userScriptTarget = Join-Path $userScripts "codex-token-spend-panel.js"

function Write-Step { param([string]$Text) Write-Host ("`n== " + $Text) -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host ("   [OK] " + $Text) -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host ("   [提示] " + $Text) -ForegroundColor Yellow }
function Write-Bad { param([string]$Text) Write-Host ("   [错误] " + $Text) -ForegroundColor Red }

# ---- 工具：定位 codex CLI（不依赖 PATH）-----------------------------------
# 定位逻辑统一收拢在 find-codex.ps1（唯一实现，避免多处漂移）：
#   Resolve-CodexCli / Resolve-CodexApp / Test-CodexRunning /
#   Resolve-NodeCli / Resolve-CodexPlusPlus / Get-CodexPlusPlusSwitchState
# 背景：Codex 桌面版（MSIX）只给自身启动的子进程临时注入 bin 目录，系统 PATH
# 里没有 codex；bin 下的目录名还带随版本变化的哈希。所以"双击 install.bat"
# 时 Get-Command codex 必然失败，必须主动搜索，且不能写死任何路径。
$locator = Join-Path $pluginRoot "find-codex.ps1"
if (Test-Path -LiteralPath $locator) { . $locator }

# ---- 安装日志：安装窗口关闭后仍可回溯 --------------------------------------
$logFile = Join-Path $env:LOCALAPPDATA "tokens-ui-for-codex\install.log"
function Write-Log {
  param([string]$Text)
  try {
    $dir = Split-Path -Parent $logFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $Text
    [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

$blocking = @()

Write-Host "Tokens UI For Codex 安装程序" -ForegroundColor White
Write-Host ("包目录: " + $root)

Write-Step "1/5 检查运行环境"

if ($env:OS -ne "Windows_NT") { $blocking += "当前系统不是 Windows，本插件只支持 Windows。" }
else { Write-Ok "操作系统：Windows" }

if (-not (Test-Path -LiteralPath $panelSource)) { $blocking += "缺少用户脚本：$panelSource" }
else { Write-Ok "用户脚本存在" }

if (-not (Test-Path -LiteralPath $statsScript)) { $blocking += "缺少监控脚本：$statsScript" }
else { Write-Ok "监控脚本存在" }

if (-not (Test-Path -LiteralPath $locator)) {
  $blocking += "缺少定位脚本：$locator（安装依赖它定位 codex / Node / Codex++）。"
} else {
  Write-Ok "定位脚本 find-codex.ps1 存在"
}

# Node 定位：PATH → Codex 自带运行时（桌面版实测为 v24）→ 常见安装位置。
# 只要其一满足 22+ 即可；不再有"包内 exe"回退（本项目不提供预编译 exe）。
$nodeInfo = if (Get-Command Resolve-NodeCli -ErrorAction SilentlyContinue) { Resolve-NodeCli } else { $null }
if ($nodeInfo -and $nodeInfo.major -ge 22) {
  $nodeSourceLabel = if ($nodeInfo.source -eq "path") { "PATH" } else { "Codex 自带运行时" }
  Write-Ok ("Node.js " + $nodeInfo.version + "（来源：" + $nodeSourceLabel + "）")
  Write-Log ("Node: " + $nodeInfo.path + " (" + $nodeInfo.version + ", " + $nodeInfo.source + ")")
} else {
  if ($nodeInfo) { $blocking += ("运行时版本过低：检测到 Node.js " + $nodeInfo.version + "，需要 22 或更高。") }
  else { $blocking += "运行时缺失：未找到 Node.js 22+（已搜索 PATH、Codex 自带运行时与常见安装位置）。" }
  Write-Note "可安装 Node.js 22+（勾选加入 PATH），或确认 Codex 桌面版已安装（其自带运行时 v24 可被直接复用）。"
}

# Codex++：安装状态、运行状态与"用户脚本总开关"（只读检查，不修改任何文件）。
$codexPlusPlus = if (Get-Command Resolve-CodexPlusPlus -ErrorAction SilentlyContinue) { Resolve-CodexPlusPlus } else { $null }
if ($codexPlusPlus -and $codexPlusPlus.installed) {
  $runningLabel = if ($codexPlusPlus.running) { "运行中" } else { "未运行（启动后统计条才会注入页面）" }
  Write-Ok ("Codex++：已安装（" + $runningLabel + "）")
} else {
  Write-Note "未检测到 Codex++：请先安装 Codex++（否则统计条无法注入）。脚本会继续完成其余步骤。"
}
if (Test-Path -LiteralPath $userScripts) {
  Write-Ok ("Codex++ 用户脚本目录：" + $userScripts)
} else {
  Write-Note ("未检测到 Codex++ 用户脚本目录：" + $userScripts)
}
$plusSwitch = if (Get-Command Get-CodexPlusPlusSwitchState -ErrorAction SilentlyContinue) { Get-CodexPlusPlusSwitchState } else { "missing" }
switch ($plusSwitch) {
  "enabled"  { Write-Ok "Codex++ 用户脚本总开关：已启用" }
  "disabled" {
    Write-Bad "Codex++ 用户脚本总开关处于关闭状态（enabled=false）——统计条不会注入。"
    Write-Note "请在 Codex++ 管理器中启用用户脚本后重试；本安装器不会修改该配置文件。"
    Write-Log "Codex++ 用户脚本总开关: disabled"
  }
  "missing"  { Write-Note "未找到 Codex++ 的 user_scripts.json（Codex++ 首次启动后会自动生成）。" }
  default    { Write-Note ("Codex++ 用户脚本开关状态异常：" + $plusSwitch + "（只读检查，未修改该文件）。") }
}

$codexPath = if (Get-Command Resolve-CodexCli -ErrorAction SilentlyContinue) { Resolve-CodexCli } else { $null }
# 保留 .Source 属性，后续步骤的调用方式不用改
$codex = if ($codexPath) { [pscustomobject]@{ Source = $codexPath; FullName = $codexPath } } else { $null }
if ($codex) {
  Write-Ok ("codex 命令：" + $codex.Source)
  Write-Log ("codex 命令: " + $codex.Source)
} else {
  Write-Bad "未找到 codex 命令（已搜索 PATH、Codex 桌面版 bin 哈希目录、npm 全局与常见安装位置）。"
  Write-Note "后果：Codex 插件不会被注册 → 插件技能不可用（统计条与监控不受影响）。"
  Write-Note "如需插件技能，请在 Codex 自带的终端里重跑本脚本。"
  Write-Log "codex 命令未找到 -> 跳过插件注册"
}

# Codex 桌面版（MSIX）：动态查询包信息，用于自检与排障输出。
$codexApp = if (Get-Command Resolve-CodexApp -ErrorAction SilentlyContinue) { Resolve-CodexApp } else { $null }
if ($codexApp -and $codexApp.installed) {
  $appVersionLabel = if ($codexApp.version) { " v" + $codexApp.version } else { "" }
  Write-Ok ("Codex 桌面版：已安装" + $appVersionLabel + "（来源：" + $codexApp.source + "）")
  Write-Log ("Codex 桌面版: source=" + $codexApp.source + " version=" + $codexApp.version + " path=" + $codexApp.path)
} else {
  Write-Note "未检测到 Codex 桌面版安装痕迹（本插件面向桌面版；如已安装仍看到本提示，请反馈）。"
}

if ($blocking.Count -gt 0) {
  Write-Step "安装中止"
  foreach ($item in $blocking) { Write-Bad $item }
  exit 1
}

Write-Step "2/5 安装 Codex++ 用户脚本"
if (Test-Path -LiteralPath $userScripts) {
  if (Test-Path -LiteralPath $userScriptTarget) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -LiteralPath $userScriptTarget -Destination ($userScriptTarget + ".before-install-" + $stamp + ".bak") -Force
    Write-Note "已备份原用户脚本"
  }
  Copy-Item -LiteralPath $panelSource -Destination $userScriptTarget -Force
  $hashSource = (Get-FileHash -LiteralPath $panelSource -Algorithm SHA256).Hash
  $hashTarget = (Get-FileHash -LiteralPath $userScriptTarget -Algorithm SHA256).Hash
  if ($hashSource -eq $hashTarget) { Write-Ok "用户脚本已安装并校验一致（SHA-256）" }
  else { Write-Bad "用户脚本哈希不一致，请重新复制。"; exit 1 }
} else {
  Write-Note "跳过：未安装 Codex++。安装 Codex++ 后请重新运行本脚本。"
}

Write-Step "3/5 注册 Codex 本地插件"
if ($SkipPlugin -or -not $codex) {
  Write-Note "已跳过插件注册。"
} else {
  $marketplaceName = "tokens-ui-for-codex-local"
  if (Test-Path -LiteralPath $marketplaceFile) {
    $marketName = (Get-Content -Raw -LiteralPath $marketplaceFile | ConvertFrom-Json).name
    if ($marketName) { $marketplaceName = $marketName }
  }
  $addOutput = & $codex.Source plugin marketplace add $root 2>&1
  ($addOutput | Out-String).Trim() -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host ("   " + $_.Trim()) } }
  $installOutput = & $codex.Source plugin add ("tokens-ui-for-codex@" + $marketplaceName) 2>&1
  ($installOutput | Out-String).Trim() -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host ("   " + $_.Trim()) } }
  $listOutput = (& $codex.Source plugin list 2>&1 | Out-String)
  if ($listOutput -match "tokens-ui-for-codex@") { Write-Ok "插件已安装并启用" }
  else { Write-Note "未在 plugin list 中确认到插件，请手动执行：codex plugin list" }
}

Write-Step "4/5 安装登录自启守护"
if ($SkipAutostart) {
  Write-Note "已跳过（-SkipAutostart）。可稍后运行 install-autostart.ps1。"
} else {
  $autostart = Join-Path $pluginRoot "install-autostart.ps1"
  if (Test-Path -LiteralPath $autostart) {
    try {
      $preferPwsh = Get-Command pwsh -ErrorAction SilentlyContinue
      if ($preferPwsh) { & $preferPwsh.Source -NoProfile -ExecutionPolicy Bypass -File $autostart }
      else { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $autostart }
      # 关键修正：必须检查子脚本退出码。
      # 之前这里无条件打印"已安装"，子脚本失败（Node 版本不足 / 计划任务被权限拒绝）时
      # 会被完全掩盖——这是"装完却不生效"的直接原因。
      $autostartExit = $LASTEXITCODE
      if ($null -eq $autostartExit) { $autostartExit = 0 }
      if ($autostartExit -eq 0) {
        Write-Ok "登录自启已安装（登录后自动拉起监控）"
        Write-Log "自启安装成功"
      } else {
        Write-Bad ("登录自启安装失败，退出码 " + $autostartExit + "（原因见上方输出）")
        Write-Note ("可手动重试：powershell -ExecutionPolicy Bypass -File `"" + $autostart + "`"")
        Write-Log ("自启安装失败 exit=" + $autostartExit)
        $blocking += "登录自启未安装成功（退出码 " + $autostartExit + "）"
      }
    } catch {
      Write-Note ("自启安装未完成：" + $_.Exception.Message)
      Write-Note ("可手动运行：powershell -ExecutionPolicy Bypass -File `"" + $autostart + "`"")
    }
  } else {
    Write-Note "未找到 install-autostart.ps1，跳过。"
  }
}

Write-Step "自检"
$selfTask = Get-ScheduledTask -TaskName "tokens-ui-for-codex-monitor" -ErrorAction SilentlyContinue
if ($selfTask) {
  $selfInfo = Get-ScheduledTaskInfo -TaskName "tokens-ui-for-codex-monitor" -ErrorAction SilentlyContinue
  Write-Ok ("自启任务：已注册（状态 " + $selfTask.State + "，上次运行 " + $selfInfo.LastRunTime + "）")
  Write-Log ("自检 任务: 已注册 " + $selfTask.State)
} else {
  Write-Bad "自启任务：未注册 → 登录后不会自动启动监控"
  Write-Log "自检 任务: 未注册"
}

if ($codex) {
  $selfPluginList = (& $codex.Source plugin list 2>&1 | Out-String)
  if ($selfPluginList -match "tokens-ui-for-codex@") { Write-Ok "Codex 插件：已注册" }
  else { Write-Bad "Codex 插件：未注册（技能不可用）" }
} else {
  Write-Bad "Codex 插件：未注册（未找到 codex 命令）"
}

if (Test-Path -LiteralPath $userScriptTarget) { Write-Ok "Codex++ 用户脚本：已安装" }
else { Write-Bad "Codex++ 用户脚本：未安装（统计条不会出现）" }

if (Get-Command Test-CodexRunning -ErrorAction SilentlyContinue) {
  if (Test-CodexRunning) { Write-Ok "Codex 桌面版：正在运行" }
  else { Write-Note "Codex 桌面版：未在运行（监控会保持待命，Codex 启动后自动开始上报）" }
}

$selfMonitor = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'token-stats\.mjs' })
if ($selfMonitor.Count -gt 0) { Write-Ok ("监控进程：运行中 (PID " + $selfMonitor[0].ProcessId + ")") }
else { Write-Note "监控进程：未运行（自启任务会在 5 分钟巡检内拉起，也可手动启动）" }
Write-Note ("安装日志：" + $logFile)

Write-Step "5/5 完成"
Write-Host "后续步骤：" -ForegroundColor White
Write-Host "   1) 完全退出并重新打开 Codex 桌面版，让用户脚本注入页面。"
Write-Host "   2) 输入区底部、上下文用量圆圈左侧应出现 Token 统计条。"
Write-Host "   3) 左键单击统计条可打开详情；点击弹层外部或右上角 × 关闭。"
Write-Host "   4) 如未安装自启，可手动启动监控："
Write-Host ("      node `"" + $statsScript + "`" --watch --cdp")
Write-Host ""
Write-Host "卸载：运行 uninstall-autostart.ps1，并执行 codex plugin remove tokens-ui-for-codex@tokens-ui-for-codex-local" -ForegroundColor DarkGray
exit 0
