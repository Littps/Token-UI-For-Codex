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
#   -CodexHome <path>  覆盖解析到的 Codex Home
#   -StateDir <path>   覆盖状态目录
#   -LockFile <path>   覆盖监控锁文件

[CmdletBinding()]
param(
  [switch]$PurgeState,
  [switch]$RemoveUserScript,
  [switch]$RemovePlugin,
  [string]$CodexHome = "",
  [string]$StateDir = "",
  [string]$LockFile = "",
  # 一键全清：等价于同时指定上面三个开关，并额外清理插件缓存与 marketplace 注册
  [switch]$Full
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

if ($Full) {
  $PurgeState = $true
  $RemoveUserScript = $true
  $RemovePlugin = $true
}

$resolvedCodexHome = if ($CodexHome) {
  [System.IO.Path]::GetFullPath($CodexHome)
} elseif ($env:TUI_CODEX_HOME) {
  [System.IO.Path]::GetFullPath($env:TUI_CODEX_HOME)
} elseif ($env:CODEX_HOME) {
  [System.IO.Path]::GetFullPath($env:CODEX_HOME)
} else {
  Join-Path $env:USERPROFILE ".codex"
}
$runtimeConfigPath = Join-Path $PSScriptRoot "runtime-paths.json"
$runtimeConfig = $null
try {
  if (Test-Path -LiteralPath $runtimeConfigPath) {
    $runtimeConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $runtimeConfigPath | ConvertFrom-Json
  }
} catch {}
if (-not $CodexHome -and -not $env:TUI_CODEX_HOME -and -not $env:CODEX_HOME -and $runtimeConfig -and $runtimeConfig.codexHome) {
  $resolvedCodexHome = [System.IO.Path]::GetFullPath([string]$runtimeConfig.codexHome)
}

$stateDir = if ($StateDir) {
  [System.IO.Path]::GetFullPath($StateDir)
} elseif ($env:TUI_STATE_DIR) {
  [System.IO.Path]::GetFullPath($env:TUI_STATE_DIR)
} elseif ($runtimeConfig -and $runtimeConfig.stateDir) {
  [System.IO.Path]::GetFullPath([string]$runtimeConfig.stateDir)
} else {
  Join-Path $resolvedCodexHome "tokens-ui-for-codex\state"
}
$lockFile = if ($LockFile) {
  [System.IO.Path]::GetFullPath($LockFile)
} elseif ($env:TUI_LOCK_FILE) {
  [System.IO.Path]::GetFullPath($env:TUI_LOCK_FILE)
} elseif ($runtimeConfig -and $runtimeConfig.lockFile) {
  [System.IO.Path]::GetFullPath([string]$runtimeConfig.lockFile)
} else {
  Join-Path $resolvedCodexHome "tokens-ui-for-codex\monitor.lock"
}
$guardLockFile = if ($runtimeConfig -and $runtimeConfig.guardLockFile) {
  [System.IO.Path]::GetFullPath([string]$runtimeConfig.guardLockFile)
} else {
  Join-Path $env:USERPROFILE ".tokens-ui-for-codex\monitor.guard.lock"
}
$heartbeatFile = if ($runtimeConfig -and $runtimeConfig.heartbeatFile) {
  [System.IO.Path]::GetFullPath([string]$runtimeConfig.heartbeatFile)
} else {
  Join-Path $stateDir "monitor-heartbeat.json"
}
$logDir = if ($runtimeConfig -and $runtimeConfig.logDir) {
  [System.IO.Path]::GetFullPath([string]$runtimeConfig.logDir)
} else {
  Join-Path $stateDir "logs"
}
$historyDir = if ($runtimeConfig -and $runtimeConfig.historyDir) {
  [System.IO.Path]::GetFullPath([string]$runtimeConfig.historyDir)
} else {
  Join-Path $stateDir "history"
}
$legacyStateDir = Join-Path $env:LOCALAPPDATA "tokens-ui-for-codex"
$taskName = "tokens-ui-for-codex-monitor"
$autostartState = Join-Path $stateDir "autostart-state.json"
$userScriptsDir = Join-Path $env:APPDATA "Codex++\user_scripts"
$userScriptName = "tokens-ui-for-codex-panel.js"
# 识别“属于本插件”的计划任务、快捷方式与用户脚本时，只看它们的动作/内容，不看名字前缀：
# 历史版本换过名字也能被清掉，脚本里不需要写死任何旧名字。
$pluginArtifacts = @('token-stats\.mjs', 'monitor-watchdog\.ps1', 'guardian\.ps1', 'launch-silent\.(vbs|ps1)', 'launch-confirm\.vbs', 'start-monitor\.(cmd|ps1)')
$userScriptMarker = 'NativeUiInstalled'

function Write-Info { param([string]$Text) Write-Host ("   " + $Text) }
function Write-Ok { param([string]$Text) Write-Host ("   [OK] " + $Text) -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host ("   [提示] " + $Text) -ForegroundColor Yellow }
function Write-Bad { param([string]$Text) Write-Host ("   [错误] " + $Text) -ForegroundColor Red }
$script:uninstallFailures = @()

Write-Host "Tokens UI For Codex —— 卸载登录自启" -ForegroundColor White

# ------------------------------------------------------------ 1) 删除计划任务
Write-Host "`n== 1/4 删除计划任务" -ForegroundColor Cyan

$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  $_.TaskName -eq $taskName -or @($_.Actions | Where-Object {
    $text = [string]$_.Execute + " " + [string]$_.Arguments + " " + [string]$_.WorkingDirectory
    $pluginArtifacts | Where-Object { $text -match $_ }
  }).Count -gt 0
})
foreach ($task in $tasks) {
  try {
    Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false -ErrorAction Stop
    Write-Ok ("已删除计划任务：" + $task.TaskName)
  } catch {
    Write-Note ("删除计划任务失败 " + $task.TaskName + "：" + $_.Exception.Message)
    $script:uninstallFailures += "删除计划任务失败：$($task.TaskName)"
  }
}
if ($tasks.Count -eq 0) { Write-Info "计划任务不存在，跳过。" }

$startupDir = [Environment]::GetFolderPath("Startup")
$shell = $null
try { $shell = New-Object -ComObject WScript.Shell } catch { $shell = $null }
$staleLinks = @()
if ($shell) {
  foreach ($lnk in @(Get-ChildItem -LiteralPath $startupDir -Filter *.lnk -File -ErrorAction SilentlyContinue)) {
    $linkText = ""
    try { $sc = $shell.CreateShortcut($lnk.FullName); $linkText = [string]$sc.TargetPath + " " + [string]$sc.Arguments } catch { $linkText = "" }
    if ($pluginArtifacts | Where-Object { $linkText -match $_ }) { $staleLinks += $lnk }
  }
}
foreach ($lnk in $staleLinks) {
  Remove-Item -LiteralPath $lnk.FullName -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $lnk.FullName) {
    Write-Bad ("删除启动快捷方式失败：" + $lnk.Name)
    $script:uninstallFailures += "删除启动快捷方式失败：$($lnk.Name)"
  } else {
    Write-Ok ("已删除启动快捷方式：" + $lnk.Name)
  }
}
if ($staleLinks.Count -eq 0) { Write-Info "启动文件夹无本插件快捷方式残留。" }
if ($shell) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }

# 清理自定义 URL 协议（tokens-ui-for-codex://start）
$protoRoot = "HKCU:\Software\Classes\tokens-ui-for-codex"
if (Test-Path -LiteralPath $protoRoot) {
  Remove-Item -Path $protoRoot -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $protoRoot) {
    Write-Note "启动协议键未能删除：tokens-ui-for-codex://start"
    $script:uninstallFailures += "启动协议键未能删除。"
  }
  else { Write-Ok "已删除启动协议：tokens-ui-for-codex://start" }
} else {
  Write-Info "启动协议不存在，跳过。"
}

# 清理开始菜单入口
$startMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Tokens UI For Codex - 启动监控.lnk"
if (Test-Path -LiteralPath $startMenuShortcut) {
  Remove-Item -LiteralPath $startMenuShortcut -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $startMenuShortcut) {
    Write-Bad "删除开始菜单入口失败。"
    $script:uninstallFailures += "删除开始菜单入口失败。"
  } else {
    Write-Ok "已删除开始菜单入口：Tokens UI For Codex - 启动监控"
  }
} else {
  Write-Info "开始菜单无本插件入口残留。"
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
      $script:uninstallFailures += "停止$Label失败：PID $($proc.ProcessId)"
    }
  }
}

Stop-MatchedProcess -NamePattern '^(powershell|pwsh)(\.exe)?$' -CommandPattern 'monitor-watchdog\.ps1' -Label 'watchdog 进程'
Stop-MatchedProcess -NamePattern '^node(\.exe)?$' -CommandPattern 'token-stats\.mjs.*--watch' -Label '监控进程'
Stop-MatchedProcess -NamePattern '^(powershell|pwsh)(\.exe)?$' -CommandPattern 'guardian\.ps1' -Label '旧守护进程'
Start-Sleep -Milliseconds 300

foreach ($lockTarget in @($guardLockFile, $lockFile, $heartbeatFile, (Join-Path $legacyStateDir "monitor.lock")) | Select-Object -Unique) {
  if (-not (Test-Path -LiteralPath $lockTarget)) { continue }
  Remove-Item -LiteralPath $lockTarget -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $lockTarget) {
    Write-Note ("锁文件未能清理：" + $lockTarget)
    $script:uninstallFailures += "锁文件未能清理：$lockTarget"
  } else {
    Write-Ok ("已清理监控运行标记：" + $lockTarget)
  }
}

# ------------------------------------------------------ 3) 清理状态与记录
Write-Host "`n== 3/4 清理状态文件" -ForegroundColor Cyan

$knownStateDirs = @($stateDir, $legacyStateDir) | Select-Object -Unique
foreach ($knownStateDir in $knownStateDirs) {
  foreach ($name in @("guardian.pid", "guardian-state.json", "guardian.lock", "monitor.pid", "monitor-state.json")) {
    $target = Join-Path $knownStateDir $name
    if (-not (Test-Path -LiteralPath $target)) { continue }
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $target) {
      Write-Note ("未能清理旧状态文件（可能被占用）：" + $target)
      $script:uninstallFailures += "未能清理旧状态文件：$target"
    }
    else { Write-Info ("已清理旧状态文件：" + $target) }
  }
}

if (-not $PurgeState) {
  if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
  $stateJson = [ordered]@{
    stateVersion = 4
    installed = $false
    mechanism = "scheduled-task"
    taskName = $taskName
    uninstalledAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json -Compress
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($autostartState, ($stateJson + "`r`n"), $utf8NoBom)
  Write-Host ("   已保留运行状态和日志：" + $stateDir) -ForegroundColor Cyan
} else {
  $purgeTargets = @($stateDir, $legacyStateDir, $logDir, $historyDir, $heartbeatFile, $guardLockFile) | Select-Object -Unique
  foreach ($target in $purgeTargets) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $target) {
      Write-Bad ("状态路径未能完全清理：" + $target)
      $script:uninstallFailures += "状态路径未能完全清理：$target"
    }
  }
  $script:uninstallFailures = @($script:uninstallFailures | Select-Object -Unique)
  if (-not ($script:uninstallFailures -match "状态路径未能完全清理")) {
    Write-Note "已清理插件新/旧状态、日志和历史目录。"
  }
}

# --------------------------------------------------------- 4) 可选：清理其它
Write-Host "`n== 4/4 可选项" -ForegroundColor Cyan

if ($RemoveUserScript) {
  # 按内容识别本插件的用户脚本：无论它当前叫什么文件名、历史上叫什么文件名，全部清掉。
  $removedScripts = 0
  foreach ($file in @(Get-ChildItem -LiteralPath $userScriptsDir -File -Filter *.js -ErrorAction SilentlyContinue)) {
    $isOurs = $false
    try { $isOurs = (Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue) -match $userScriptMarker } catch { $isOurs = $false }
    if (-not $isOurs) { continue }
    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $file.FullName)) {
      Write-Ok ("已删除 Codex++ 用户脚本：" + $file.Name)
      $removedScripts += 1
    } else {
      Write-Bad ("Codex++ 用户脚本删除失败：" + $file.Name)
      $script:uninstallFailures += "Codex++ 用户脚本删除失败：$($file.Name)"
    }
  }
  if ($removedScripts -eq 0) { Write-Note "未找到本插件的 Codex++ 用户脚本，跳过。" }
  else { Write-Info "重启或重载 Codex 后统计条消失。" }
  # -Full 时连安装时生成的备份一并清理；默认（仅 -RemoveUserScript）保留备份作为可恢复点。
  if ($Full) {
    $userScriptBackups = @()
    foreach ($bak in @(Get-ChildItem -LiteralPath $userScriptsDir -File -Filter *.bak -ErrorAction SilentlyContinue)) {
      $isOurs = $false
      try { $isOurs = (Get-Content -LiteralPath $bak.FullName -Raw -ErrorAction SilentlyContinue) -match $userScriptMarker } catch { $isOurs = $false }
      if ($isOurs) { $userScriptBackups += $bak }
    }
    foreach ($backupFile in $userScriptBackups) {
      Remove-Item -LiteralPath $backupFile.FullName -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $backupFile.FullName) {
        $script:uninstallFailures += "用户脚本备份删除失败：$($backupFile.Name)"
      }
    }
    if ($userScriptBackups.Count -gt 0) { Write-Ok ("已清理安装备份 " + $userScriptBackups.Count + " 个（-Full）。") }
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
    if ($LASTEXITCODE -eq 0) { Write-Ok "已摘除 Codex 插件。" }
    else {
      Write-Bad ("摘除 Codex 插件失败，退出码 " + $LASTEXITCODE)
      $script:uninstallFailures += "摘除 Codex 插件失败。"
    }
  } catch {
    Write-Note ("摘除插件失败：" + $_.Exception.Message)
    $script:uninstallFailures += "摘除 Codex 插件异常。"
  }

  # 摘除后验证插件缓存是否真的消失（不能只信命令返回值）
  $pluginCache = Join-Path $resolvedCodexHome "plugins\cache\tokens-ui-for-codex-local"
  if (Test-Path -LiteralPath $pluginCache) {
    Remove-Item -LiteralPath $pluginCache -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $pluginCache) {
      Write-Note ("插件缓存仍残留（可能被占用）：" + $pluginCache)
      $script:uninstallFailures += "插件缓存仍残留。"
    }
    else { Write-Ok "已清理插件缓存目录。" }
  } else {
    Write-Info "插件缓存目录不存在，跳过。"
  }

  # 摘除本地 marketplace 注册（install 时用 codex plugin marketplace add 注册的）
  try {
    & $codexPath plugin marketplace remove tokens-ui-for-codex-local 2>&1 | ForEach-Object { Write-Info $_ }
    if ($LASTEXITCODE -eq 0) { Write-Ok "已摘除本地 marketplace 注册。" }
    else {
      Write-Bad ("摘除 marketplace 失败，退出码 " + $LASTEXITCODE)
      $script:uninstallFailures += "摘除 marketplace 注册失败。"
    }
  } catch {
    Write-Note ("摘除 marketplace 失败（可手动执行 codex plugin marketplace list 查看）：" + $_.Exception.Message)
    $script:uninstallFailures += "摘除 marketplace 注册异常。"
  }
} else {
  Write-Bad "未找到 codex 命令（已搜索 PATH、Codex 桌面版 bin 目录、npm 全局目录）。"
  Write-Note "插件与本机注册未摘除，请手动执行："
  Write-Note "  codex plugin remove tokens-ui-for-codex@tokens-ui-for-codex-local"
  Write-Note "  codex plugin marketplace remove tokens-ui-for-codex-local"
  Write-Note ("或手动删除目录：" + (Join-Path $resolvedCodexHome "plugins\cache\tokens-ui-for-codex-local"))
  $script:uninstallFailures += "未找到 codex 命令，插件未摘除。"
}
} else {
  Write-Info "未指定 -RemovePlugin，保留 Codex 插件。"
}

Write-Host "`n== 残留自检" -ForegroundColor Cyan

$leftTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($leftTask) {
  Write-Note ("计划任务仍在：" + $taskName)
  $script:uninstallFailures += "计划任务仍在。"
} else { Write-Ok "计划任务：已清除" }

$leftProc = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'token-stats\.mjs' -and $_.CommandLine -match '--watch' })
if ($leftProc.Count -gt 0) {
  Write-Note ("监控进程仍在运行：PID " + $leftProc[0].ProcessId)
  $script:uninstallFailures += "监控进程仍在运行。"
}
else { Write-Ok "监控进程：已停止" }

$leftScript = Join-Path $userScriptsDir $userScriptName
if (Test-Path -LiteralPath $leftScript) {
  if ($RemoveUserScript) {
    Write-Bad "Codex++ 用户脚本仍存在。"
    $script:uninstallFailures += "Codex++ 用户脚本仍存在。"
  } else {
    Write-Info "Codex++ 用户脚本：保留（未指定 -RemoveUserScript）"
  }
}
else { Write-Ok "Codex++ 用户脚本：已删除" }

$leftCache = Join-Path $resolvedCodexHome "plugins\cache\tokens-ui-for-codex-local"
if (Test-Path -LiteralPath $leftCache) {
  if ($RemovePlugin) {
    Write-Bad ("插件缓存仍在：" + $leftCache)
    $script:uninstallFailures += "插件缓存仍在。"
  } else {
    Write-Info ("插件缓存：保留（未指定 -RemovePlugin）")
  }
}
else { Write-Ok "插件缓存：已清除" }

foreach ($runtimeArtifact in @($guardLockFile, $heartbeatFile)) {
  if (Test-Path -LiteralPath $runtimeArtifact) {
    if ($PurgeState) {
      Write-Bad ("运行时文件仍在：" + $runtimeArtifact)
      $script:uninstallFailures += "运行时文件仍在：$runtimeArtifact"
    } else {
      Write-Info ("运行时文件保留：" + $runtimeArtifact)
    }
  } else {
    Write-Ok ("运行时文件已清除：" + $runtimeArtifact)
  }
}

$leftStatePaths = @($stateDir, $legacyStateDir) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -Unique
if ($leftStatePaths.Count -gt 0) {
  if ($PurgeState) {
    foreach ($leftStatePath in $leftStatePaths) {
      Write-Bad ("状态目录仍在：" + $leftStatePath)
      $script:uninstallFailures += "状态目录仍在：$leftStatePath"
    }
  } else {
    foreach ($leftStatePath in $leftStatePaths) {
      Write-Info ("状态目录：" + $leftStatePath + "（未指定 -PurgeState 时保留）")
    }
  }
}
else { Write-Ok "新/旧状态目录：已清除" }

# 唯一无法自动清理的就是安装包目录本身
Write-Info ("安装包目录需要你手动删除：" + $PSScriptRoot)

Write-Host ""
if ($script:uninstallFailures.Count -gt 0) {
  Write-Host "卸载未完全成功，请处理以下项目：" -ForegroundColor Red
  $script:uninstallFailures | Select-Object -Unique | ForEach-Object { Write-Bad $_ }
  exit 1
}
Write-Host "已移除登录自启并停止监控进程。" -ForegroundColor Green
Write-Host "（手动启动的监控窗口需要自行关闭）"
exit 0
