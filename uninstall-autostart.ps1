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
  [switch]$RemovePlugin
)

$ErrorActionPreference = "Continue"

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
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  if ($codex) {
    try {
      & $codex.Source plugin remove tokens-ui-for-codex@tokens-ui-for-codex-local
      Write-Ok "已请求摘除 Codex 插件。"
    } catch {
      Write-Note ("摘除插件失败：" + $_.Exception.Message)
    }
  } else {
    Write-Note "未找到 codex 命令，请手动执行：codex plugin remove tokens-ui-for-codex@tokens-ui-for-codex-local"
  }
} else {
  Write-Info "未指定 -RemovePlugin，保留 Codex 插件。"
}

Write-Host ""
Write-Host "已移除登录自启并停止监控进程。" -ForegroundColor Green
Write-Host "（手动启动的监控窗口需要自行关闭）"
exit 0
