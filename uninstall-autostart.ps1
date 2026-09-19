# Tokens UI For Codex —— 卸载登录自启，并停止监控进程
#
# 默认保留日志、会话映射和诊断状态；只有显式传入 -PurgeState 才会清理状态目录。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1 -PurgeState
#
# 可选参数：
#   -PurgeState        删除状态目录（日志、会话映射、诊断状态）
#   -RemoveUserScript  同时删除 Codex++ 用户脚本（统计条消失）
#   -RemovePlugin      同时请求摘除 Codex 插件

[CmdletBinding()]
param(
  [switch]$PurgeState,
  [switch]$RemoveUserScript,
  [switch]$RemovePlugin,
  # 一键全清：等价于同时指定上面三个开关，并额外清理插件缓存与 marketplace 注册
  [switch]$Full
)

$ErrorActionPreference = "Continue"

if ($Full) {
  $PurgeState = $true
  $RemoveUserScript = $true
  $RemovePlugin = $true
}

$stateDir = Join-Path $env:LOCALAPPDATA "tokens-ui-for-codex"
$legacyStateDir = Join-Path $env:LOCALAPPDATA "ccm-token-spend"
$taskName = "tokens-ui-for-codex-monitor"
$legacyTaskName = "ccm-token-spend-guardian"
$autostartState = Join-Path $stateDir "autostart-state.json"

function Write-Info { param([string]$Text) Write-Host ("   " + $Text) }
function Write-Ok { param([string]$Text) Write-Host ("   [OK] " + $Text) -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host ("   [提示] " + $Text) -ForegroundColor Yellow }
function Write-Bad { param([string]$Text) Write-Host ("   [错误] " + $Text) -ForegroundColor Red }

Write-Host "Tokens UI For Codex —— 卸载登录自启" -ForegroundColor White

# ------------------------------------------------------------ 1) 删除计划任务
Write-Host "`n== 1/4 删除计划任务" -ForegroundColor Cyan

foreach ($name in @($taskName, $legacyTaskName)) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    try {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
      Write-Ok ("已删除计划任务：" + $name)
    } catch {
      Write-Note ("删除计划任务失败 " + $name + "：" + $_.Exception.Message)
    }
  } else {
    Write-Info ("计划任务不存在，跳过：" + $name)
  }
}

$lnkPath = Join-Path ([Environment]::GetFolderPath("Startup")) "ccm-token-spend-guardian.lnk"
if (Test-Path -LiteralPath $lnkPath) {
  Remove-Item -LiteralPath $lnkPath -Force -ErrorAction SilentlyContinue
  Write-Ok "已删除旧启动文件夹快捷方式。"
}

# ---------------------------------------------- 2) 停止监控与旧版守护进程
Write-Host "`n== 2/4 停止后台进程" -ForegroundColor Cyan

# 只停止身份可确认的进程：进程名匹配，且命令行确实指向本插件的脚本。
function Stop-MatchedProcess {
  param(
    [string[]]$NamePattern,
    [string]$CommandPattern,
    [string]$Label
  )
  $targets = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $NamePattern -and $_.CommandLine -and $_.CommandLine -match $CommandPattern })
  if ($targets.Count -eq 0) {
    Write-Info ($Label + "未在运行，跳过。")
    return
  }
  foreach ($proc in $targets) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Ok ("已停止" + $Label + " PID " + $proc.ProcessId)
    } catch {
      Write-Note ("停止" + $Label + "失败 PID " + $proc.ProcessId + "：" + $_.Exception.Message)
    }
  }
}

Stop-MatchedProcess -NamePattern '^node(\.exe)?$' -CommandPattern 'token-stats\.mjs' -Label '监控进程'
Stop-MatchedProcess -NamePattern '^(powershell|pwsh)(\.exe)?$' -CommandPattern 'guardian\.ps1' -Label '旧守护进程'

# ------------------------------------------------------ 3) 清理状态与记录
Write-Host "`n== 3/4 清理状态文件" -ForegroundColor Cyan

foreach ($name in @("guardian.pid", "guardian-state.json", "guardian.lock", "monitor.pid", "monitor-state.json")) {
  foreach ($dir in @($stateDir, $legacyStateDir)) {
    $target = Join-Path $dir $name
    if (-not (Test-Path -LiteralPath $target)) { continue }
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $target) { Write-Note ("未能清理旧状态文件（可能被占用，不影响运行）：" + $name) }
    else { Write-Info ("已清理旧状态文件：" + (Split-Path $dir -Leaf) + "\" + $name) }
  }
}

if (-not $PurgeState) {
  if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
  [ordered]@{
    stateVersion = 2
    installed = $false
    mechanism = "scheduled-task"
    taskName = $taskName
    legacyTaskName = $legacyTaskName
    uninstalledAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $autostartState -Encoding UTF8
  Write-Host ("   已保留运行状态和日志：" + $stateDir) -ForegroundColor Cyan
} else {
  foreach ($dir in @($stateDir, $legacyStateDir)) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Note "已清理插件状态、日志和会话映射。"
}

# --------------------------------------------------------- 4) 可选：清理其它
Write-Host "`n== 4/4 可选项" -ForegroundColor Cyan

if ($RemoveUserScript) {
  $userScript = Join-Path $env:APPDATA "Codex++\user_scripts\codex-token-spend-panel.js"
  if (Test-Path -LiteralPath $userScript) {
    Remove-Item -LiteralPath $userScript -Force -ErrorAction SilentlyContinue
    Write-Ok "已删除 Codex++ 用户脚本（重启或重载 Codex 后统计条消失）。"
  } else {
    Write-Note "未找到 Codex++ 用户脚本，跳过。"
  }
} else {
  Write-Info "未指定 -RemoveUserScript，保留 Codex++ 用户脚本。"
}

if ($RemovePlugin) {
# 动态定位 codex CLI（共用逻辑，见插件根目录 find-codex.ps1）
$locator = Join-Path $PSScriptRoot "find-codex.ps1"
if (Test-Path -LiteralPath $locator) { . $locator }
$codexPath = if (Get-Command Resolve-CodexCli -ErrorAction SilentlyContinue) { Resolve-CodexCli } else { $null }

if ($codexPath) {
  try {
    & $codexPath plugin remove tokens-ui-for-codex@tokens-ui-for-codex-local 2>&1 | ForEach-Object { Write-Info $_ }
    Write-Ok "已摘除 Codex 插件。"
  } catch {
    Write-Note ("摘除插件失败：" + $_.Exception.Message)
  }

  # 摘除后验证插件缓存是否真的消失（不能只信命令返回值）
  $pluginCache = Join-Path $env:USERPROFILE ".codex\plugins\cache\tokens-ui-for-codex-local"
  if (Test-Path -LiteralPath $pluginCache) {
    Remove-Item -LiteralPath $pluginCache -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $pluginCache) { Write-Note ("插件缓存仍残留（可能被占用）：" + $pluginCache) }
    else { Write-Ok "已清理插件缓存目录。" }
  } else {
    Write-Info "插件缓存目录不存在，跳过。"
  }

  # 摘除本地 marketplace 注册（install 时用 codex plugin marketplace add 注册的）
  try {
    & $codexPath plugin marketplace remove tokens-ui-for-codex-local 2>&1 | ForEach-Object { Write-Info $_ }
    Write-Ok "已摘除本地 marketplace 注册。"
  } catch {
    Write-Note ("摘除 marketplace 失败（可手动执行 codex plugin marketplace list 查看）：" + $_.Exception.Message)
  }
} else {
  Write-Bad "未找到 codex 命令（已搜索 PATH、Codex 桌面版 bin 目录、npm 全局目录）。"
  Write-Note "插件与本机注册未摘除，请手动执行："
  Write-Note "  codex plugin remove tokens-ui-for-codex@tokens-ui-for-codex-local"
  Write-Note "  codex plugin marketplace remove tokens-ui-for-codex-local"
  Write-Note ("或手动删除目录：" + (Join-Path $env:USERPROFILE ".codex\plugins\cache\tokens-ui-for-codex-local"))
}
} else {
  Write-Info "未指定 -RemovePlugin，保留 Codex 插件。"
}

Write-Host "`n== 残留自检" -ForegroundColor Cyan

$leftTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($leftTask) { Write-Note ("计划任务仍在：" + $taskName) } else { Write-Ok "计划任务：已清除" }

$leftProc = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'token-stats\.mjs' })
if ($leftProc.Count -gt 0) { Write-Note ("监控进程仍在运行：PID " + $leftProc[0].ProcessId) }
else { Write-Ok "监控进程：已停止" }

$leftScript = Join-Path $env:APPDATA "Codex++\user_scripts\codex-token-spend-panel.js"
if (Test-Path -LiteralPath $leftScript) { Write-Info "Codex++ 用户脚本：保留（未指定 -RemoveUserScript）" }
else { Write-Ok "Codex++ 用户脚本：已删除" }

$leftCache = Join-Path $env:USERPROFILE ".codex\plugins\cache\tokens-ui-for-codex-local"
if (Test-Path -LiteralPath $leftCache) { Write-Note ("插件缓存仍在：" + $leftCache) }
else { Write-Ok "插件缓存：已清除" }

if (Test-Path -LiteralPath $stateDir) { Write-Info ("状态目录：" + $stateDir + "（未指定 -PurgeState 时保留）") }
else { Write-Ok "状态目录：已清除" }

# 唯一无法自动清理的就是安装包目录本身
Write-Info ("安装包目录需要你手动删除：" + $PSScriptRoot)

Write-Host ""
Write-Host "已移除登录自启并停止监控进程。" -ForegroundColor Green
Write-Host "（手动启动的监控窗口需要自行关闭）"
exit 0
