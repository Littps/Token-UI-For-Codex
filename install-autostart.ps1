# Tokens UI For Codex —— 登录自启安装（计划任务直启版）
#
# 作用：注册一个登录触发的计划任务，由 Windows 直接拉起 Node 监控进程。
#
# 为什么不再使用守护进程：
#   旧实现由一个常驻 PowerShell 守护进程每 2 秒轮询全系统进程并做一次 WMI 查询，
#   长期占用约 0.9% 单核 + 60 MB 内存；且脚本在磁盘上更新后，运行中的旧进程仍用内存里的
#   旧代码继续跑，导致状态文件与实际进程长期不一致（实测踩到过）。
#   现在改由计划任务负责"登录启动 + 崩溃重启"，监控进程自行负责"Codex 在不在"，
#   常驻进程从 2 个降为 1 个，且不再经过 PowerShell。
#
# 兼容性：
#   - 任务动作直接是 node.exe，不经过 PowerShell，因此不受 ExecutionPolicy 影响。
#   - 用户级任务（RunLevel Limited），不需要管理员权限，不弹 UAC。
#   - 会自动清理旧版守护进程遗留的计划任务、启动项快捷方式与 PID/状态文件。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
#
# 可选参数：
#   -Port <int>    监控使用的 CDP 端口，默认 9229
#   -SkipStart     只注册任务，不立即启动监控

[CmdletBinding()]
param(
  [int]$Port = 9229,
  [switch]$SkipStart,
  # 兜底巡检周期（分钟）：监控进程若意外死亡，最多等这么久就会被自动拉起。
  # 该触发在监控正常运行时不会产生任何新进程（被 IgnoreNew 跳过）。
  [int]$WatchdogMinutes = 5
)

$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$statsScript = Join-Path $scriptDir "token-stats.mjs"
$stateDir = Join-Path $env:LOCALAPPDATA "tokens-ui-for-codex"
$legacyStateDir = Join-Path $env:LOCALAPPDATA "ccm-token-spend"
$logDir = Join-Path $stateDir "logs"
$launcherPath = Join-Path $scriptDir "launch-silent.vbs"

$taskName = "tokens-ui-for-codex-monitor"
$legacyTaskName = "ccm-token-spend-guardian"
$codexPlusPlusUserScripts = Join-Path $env:APPDATA "Codex++\user_scripts"

function Write-Info { param([string]$Text) Write-Host ("   " + $Text) }
function Write-Ok { param([string]$Text) Write-Host ("   [OK] " + $Text) -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host ("   [提示] " + $Text) -ForegroundColor Yellow }
function Write-Bad { param([string]$Text) Write-Host ("   [错误] " + $Text) -ForegroundColor Red }

foreach ($dir in @($stateDir, $logDir)) {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

Write-Host "Tokens UI For Codex —— 安装登录自启" -ForegroundColor White

# ---------------------------------------------------------------- 1) 环境检查
Write-Host "`n== 1/5 检查运行环境" -ForegroundColor Cyan

$nodePath = $null
$nodeMajor = 0
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodePath = $nodeCmd.Source
  try {
    $nodeVersion = (& $nodePath --version 2>$null).Trim()
    if ($nodeVersion -match "^v(\d+)") { $nodeMajor = [int]$Matches[1] }
  } catch {}
}

if (-not $nodePath -or $nodeMajor -lt 22) {
  if ($nodePath) { Write-Bad ("需要 Node.js 22 或更高版本；当前为 v" + $nodeMajor) }
  else { Write-Bad "未检测到 Node.js。" }
  Write-Note "请安装 Node.js 22+ 后重新运行本脚本（安装时勾选加入 PATH）。"
  exit 1
}
Write-Ok ("Node.js v" + $nodeMajor + "：" + $nodePath)

if (-not (Test-Path -LiteralPath $statsScript)) {
  Write-Bad ("未找到 token-stats.mjs（应与本脚本同目录）：" + $statsScript)
  exit 1
}
Write-Ok "监控脚本 token-stats.mjs 已就位。"

if (-not (Test-Path -LiteralPath $codexPlusPlusUserScripts)) {
  Write-Note ("未检测到 Codex++ 用户脚本目录：" + $codexPlusPlusUserScripts)
  Write-Note "请先安装 Codex++，否则统计条无法注入页面（自启仍会安装）。"
}

# ------------------------------------------------------- 2) 清理旧版守护遗留
Write-Host "`n== 2/5 清理旧版守护进程遗留" -ForegroundColor Cyan

$legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
if ($legacyTask) {
  try {
    Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction Stop
    Write-Ok ("已删除旧计划任务：" + $legacyTaskName)
  } catch {
    Write-Note ("删除旧计划任务失败：" + $_.Exception.Message)
  }
} else {
  Write-Info "旧计划任务不存在，跳过。"
}

$legacyLnk = Join-Path ([Environment]::GetFolderPath("Startup")) "ccm-token-spend-guardian.lnk"
if (Test-Path -LiteralPath $legacyLnk) {
  Remove-Item -LiteralPath $legacyLnk -Force -ErrorAction SilentlyContinue
  Write-Ok "已删除旧启动文件夹快捷方式。"
}

# 只停止身份可确认的守护进程：进程名必须是 powershell/pwsh，且命令行含 guardian.ps1
$legacyGuardians = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -match 'guardian\.ps1' })
if ($legacyGuardians.Count -gt 0) {
  foreach ($proc in $legacyGuardians) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Ok ("已停止旧守护进程 PID " + $proc.ProcessId)
    } catch {
      Write-Note ("停止旧守护进程失败 PID " + $proc.ProcessId + "：" + $_.Exception.Message)
    }
  }
} else {
  Write-Info "旧守护进程未在运行，跳过。"
}

foreach ($name in @("guardian.pid", "guardian-state.json", "guardian.lock", "monitor.pid", "monitor-state.json")) {
  foreach ($dir in @($stateDir, $legacyStateDir)) {
    $target = Join-Path $dir $name
    if (-not (Test-Path -LiteralPath $target)) { continue }
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $target) { Write-Note ("未能清理旧状态文件（可能被占用，不影响运行）：" + $name) }
    else { Write-Info ("已清理旧状态文件：" + (Split-Path $dir -Leaf) + "\" + $name) }
  }
}

# ------------------------------------------------------------- 3) 注册计划任务
Write-Host "`n== 3/5 注册计划任务" -ForegroundColor Cyan

try {
  # 生成无窗口启动器。
  # 为什么需要它：wscript.exe 属于 GUI 子系统程序，本身不创建控制台；
  # 再用窗口样式 0 启动 node，实测不会出现任何终端窗口（Windows Terminal 也不会接管）。
  # 第三个参数 True 让启动器等待监控退出 —— 这样计划任务实例会一直存活，
  # IgnoreNew 才能真正拦住"兜底巡检又拉一份"的情况。
  $vbsCommand = ('"' + $nodePath + '" "' + $statsScript + '" --watch --cdp --port ' + $Port).Replace('"', '""')
  # 用 here-string + WriteAllText 生成，避免数组/拼接带来的换行歧义（踩过一次）。
  $vbsText = @"
' Tokens UI For Codex - silent monitor launcher (generated by install-autostart.ps1)
' Window style 0 = no terminal window. Wait = True keeps the scheduled-task instance alive.
Set sh = CreateObject("WScript.Shell")
sh.Run "$vbsCommand", 0, True
"@
  [System.IO.File]::WriteAllText($launcherPath, $vbsText, [System.Text.Encoding]::ASCII)
  Write-Ok "已生成无窗口启动器：launch-silent.vbs"

  $wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
  $action = New-ScheduledTaskAction -Execute $wscriptPath -Argument ('//nologo "' + $launcherPath + '"') -WorkingDirectory $scriptDir
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # 兜底巡检必须是**独立的 Once 触发器**。
  # 实测：把 Repetition 挂在 LogonTrigger 上不会真正触发；
  # 独立触发器带明确的 StartBoundary + 无 Duration（= 无限重复）才可靠。
  # 时间回拨一分钟，确保注册后立即进入重复周期。
  $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Settings $settings -Principal $principal -Description "Tokens UI For Codex: start the token monitor at logon (no guardian process)" -Force | Out-Null
  Write-Ok ("已注册计划任务：" + $taskName)
  Write-Info "动作：wscript.exe 调起 launch-silent.vbs（无终端窗口）"
  Write-Info ("触发器：登录时 + 每 " + $WatchdogMinutes + " 分钟兜底巡检")
  Write-Info "重复实例：不启动新实例（已在运行时空转，不产生新进程）；运行时限：不限；失败重启：3 次 / 间隔 1 分钟。"
} catch {
  Write-Bad ("计划任务注册失败：" + $_.Exception.Message)
  exit 1
}

# ------------------------------------------------------- 4) 立即启动（可选）
Write-Host "`n== 4/5 立即启动监控" -ForegroundColor Cyan

$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like ("*" + $statsScript + "*") })

if ($SkipStart) {
  Write-Note "按参数要求跳过立即启动；下次登录时会自动运行。"
} else {
  # 先停掉已在运行的旧实例：脚本内容可能在本次更新中已变化，而运行中的进程仍使用内存里的旧代码。
  if ($running.Count -gt 0) {
    foreach ($proc in $running) {
      try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        Write-Info ("已停止旧监控实例 PID " + $proc.ProcessId + "（确保加载最新脚本）")
      } catch {
        Write-Note ("停止旧监控实例失败 PID " + $proc.ProcessId + "：" + $_.Exception.Message)
      }
    }
    Start-Sleep -Milliseconds 800
  }
  try {
    Start-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 3
    $after = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like ("*" + $statsScript + "*") })
    if ($after.Count -gt 0) { Write-Ok ("监控已启动（PID " + $after[0].ProcessId + "）") }
    else { Write-Note "已触发任务，但暂未检测到监控进程；请稍后复查。" }
  } catch {
    Write-Note ("立即启动失败：" + $_.Exception.Message)
  }
}

# ------------------------------------------------------------------ 5) 汇总
Write-Host "`n== 5/5 完成" -ForegroundColor Cyan

[ordered]@{
  stateVersion = 2
  installed = $true
  mechanism = "scheduled-task"
  taskName = $taskName
  legacyTaskName = $legacyTaskName
  nodePath = $nodePath
  scriptPath = $statsScript
  port = $Port
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $stateDir "autostart-state.json") -Encoding UTF8

Write-Host "后续说明：" -ForegroundColor White
Write-Host "   1) 登录后由计划任务直接拉起 Node 监控，不经过 PowerShell，不需要管理员权限。"
Write-Host "   2) Codex 不在运行时监控保持待命，不会退出；Codex 启动后自动开始上报。"
Write-Host ("   3) 运行日志：" + (Join-Path $logDir "watch-YYYYMMDD.log"))
Write-Host "   4) 卸载：运行 uninstall-autostart.ps1"
exit 0
