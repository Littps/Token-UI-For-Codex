# Tokens UI For Codex —— 登录自启安装（计划任务直启版）
#
# 作用：注册当前用户的计划任务。用户登录时启动一次常驻 monitor-watchdog.ps1；
#       watchdog 在同一进程内周期检查，异常时才按退避拉起 Node。
#
# 为什么替换旧守护进程：
#   旧实现由一个常驻 PowerShell 守护进程每 2 秒轮询全系统进程并做一次 WMI 查询，
#   长期占用约 0.9% 单核 + 60 MB 内存；且脚本在磁盘上更新后，运行中的旧进程仍用内存里的
#   旧代码继续跑，导致状态文件与实际进程长期不一致（实测踩到过）。
#   现在由登录任务启动一次常驻 watchdog，在自身循环中低频读取心跳；安装/卸载会先停止
#   旧 watchdog，确保升级后加载最新代码。
#
# 兼容性：
#   - 任务使用 -ExecutionPolicy Bypass；启动器只执行固定路径，不读取外部配置。
#   - 用户级任务（RunLevel Limited），不需要管理员权限，不弹 UAC。
#   - 会自动清理旧版守护进程遗留的计划任务、启动项快捷方式与 PID/状态文件。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
#
# 可选参数：
#   -Port <auto|int> 监控使用的 CDP 端口：默认 auto（从 ChatGPT.exe 命令行自动发现），也可指定 1-65535
#   -CodexHome <path> 覆盖解析到的 Codex Home
#   -StateDir <path>  覆盖状态目录
#   -LockFile <path>  覆盖监控锁文件
#   -ResetRuntimePaths 忽略已有 runtime-paths.json 并重新解析
#   -SkipStart     只注册任务，不立即启动监控

[CmdletBinding()]
param(
  [string]$Port = "auto",
  [string]$CodexHome = "",
  [string]$StateDir = "",
  [string]$LockFile = "",
  [switch]$ResetRuntimePaths,
  [switch]$SkipStart
)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$statsScript = Join-Path $scriptDir "token-stats.mjs"
$runtimePathsScript = Join-Path $scriptDir "runtime-paths.mjs"
$watchdogPath = Join-Path $scriptDir "monitor-watchdog.ps1"
$launcherPath = Join-Path $scriptDir "launch-silent.ps1"

$taskName = "tokens-ui-for-codex-monitor"
$codexPlusPlusUserScripts = Join-Path $env:APPDATA "Codex++\user_scripts"
# 识别“属于本插件”的计划任务与快捷方式时，只看它们指向的脚本，不看名字前缀：
# 这样历史版本换过多少种名字都能清掉，脚本里也不需要写死任何旧名字。
$pluginArtifacts = @('token-stats\.mjs', 'monitor-watchdog\.ps1', 'guardian\.ps1', 'launch-silent\.(vbs|ps1)', 'launch-confirm\.vbs', 'start-monitor\.(cmd|ps1)')

function Write-Info { param([string]$Text) Write-Host ("   " + $Text) }
function Write-Ok { param([string]$Text) Write-Host ("   [OK] " + $Text) -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host ("   [提示] " + $Text) -ForegroundColor Yellow }
function Write-Bad { param([string]$Text) Write-Host ("   [错误] " + $Text) -ForegroundColor Red }

if ($Port -ne "auto") {
  $portNumber = 0
  if (-not [int]::TryParse($Port, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
    Write-Bad ("端口参数无效：" + $Port + "（应为 auto 或 1-65535）")
    exit 1
  }
}

Write-Host "Tokens UI For Codex —— 安装登录自启" -ForegroundColor White

# ---------------------------------------------------------------- 1) 环境检查
Write-Host "`n== 1/5 检查运行环境" -ForegroundColor Cyan

# 动态定位 Node：PATH → Codex 自带运行时 → 常见安装位置。
# 共用逻辑见插件根目录 find-codex.ps1（实测 Codex 自带的是 Node v24，
# 所以用户机器即使没单独装 Node，监控也能跑起来）。
$nodeLocator = Join-Path $scriptDir "find-codex.ps1"
if (Test-Path -LiteralPath $nodeLocator) { . $nodeLocator }
$nodePath = $null
$nodeMajor = 0
if (Get-Command Resolve-NodeCli -ErrorAction SilentlyContinue) {
  $nodeInfo = Resolve-NodeCli
  if ($nodeInfo) {
    $nodePath = $nodeInfo.path
    $nodeMajor = $nodeInfo.major
    if ($nodeInfo.source -eq "fallback") {
      Write-Note ("PATH 中未找到 Node，已改用后备运行时：" + $nodeInfo.path + "（" + $nodeInfo.version + "）")
    }
  }
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

if (-not (Test-Path -LiteralPath $runtimePathsScript)) {
  Write-Bad ("未找到 runtime-paths.mjs（应与本脚本同目录）：" + $runtimePathsScript)
  exit 1
}
if (-not (Test-Path -LiteralPath $watchdogPath)) {
  Write-Bad ("未找到 monitor-watchdog.ps1（应与本脚本同目录）：" + $watchdogPath)
  exit 1
}

$resolverArgs = @($runtimePathsScript, "--json")
if ($ResetRuntimePaths) { $resolverArgs += "--ignore-config" }
if ($CodexHome) { $resolverArgs += @("--codex-home", $CodexHome) }
if ($StateDir) { $resolverArgs += @("--state-dir", $StateDir) }
if ($LockFile) { $resolverArgs += @("--lock-file", $LockFile) }
try {
  $runtimeJson = & $nodePath @resolverArgs
  if ($LASTEXITCODE -ne 0 -or -not $runtimeJson) { throw "runtime-paths.mjs 返回空结果" }
  $runtimePaths = ($runtimeJson | Out-String | ConvertFrom-Json)
} catch {
  Write-Bad ("运行路径解析失败：" + $_.Exception.Message)
  exit 1
}

$codexHomeRoot = [string]$runtimePaths.codexHome
$stateDir = [string]$runtimePaths.stateDir
$lockFile = [string]$runtimePaths.lockFile
$guardLockFile = [string]$runtimePaths.guardLockFile
$heartbeatFile = [string]$runtimePaths.heartbeatFile
$logDir = [string]$runtimePaths.logDir
$historyDir = [string]$runtimePaths.historyDir
$runtimePathSource = [string]$runtimePaths.resolvedFrom
$legacyStateDir = Join-Path $env:LOCALAPPDATA "tokens-ui-for-codex"

if (-not $codexHomeRoot -or -not $stateDir -or -not $lockFile -or -not $guardLockFile -or -not $heartbeatFile -or -not $logDir -or -not $historyDir) {
  Write-Bad "运行路径解析结果不完整。"
  exit 1
}

if (-not (Test-Path -LiteralPath $stateDir)) {
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}

function Copy-LegacyJsonIfMissing {
  param([string]$Name)
  $source = Join-Path $legacyStateDir $Name
  $target = Join-Path $stateDir $Name
  if ($source -eq $target -or -not (Test-Path -LiteralPath $source -PathType Leaf) -or (Test-Path -LiteralPath $target)) {
    return
  }
  try {
    Get-Content -Raw -Encoding UTF8 -LiteralPath $source | ConvertFrom-Json | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  } catch {}
}

Copy-LegacyJsonIfMissing "last-summary.json"
Copy-LegacyJsonIfMissing "client-thread-map.json"

foreach ($dir in @($stateDir, $logDir, (Split-Path -Parent $lockFile), (Split-Path -Parent $guardLockFile), (Split-Path -Parent $heartbeatFile))) {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$legacyHistoryDir = Join-Path $legacyStateDir "history"
if (
  $historyDir -eq (Join-Path $stateDir "history") -and
  -not (Test-Path -LiteralPath $historyDir) -and
  (Test-Path -LiteralPath $legacyHistoryDir -PathType Container)
) {
  try {
    Copy-Item -LiteralPath $legacyHistoryDir -Destination $historyDir -Recurse -Force -ErrorAction Stop
    Write-Info ("已迁移历史目录：" + $legacyHistoryDir + " → " + $historyDir)
  } catch {
    Write-Note ("旧历史目录复制失败，将使用新目录重新开始：" + $_.Exception.Message)
  }
}
if (-not (Test-Path -LiteralPath $historyDir)) {
  New-Item -ItemType Directory -Path $historyDir -Force | Out-Null
}

$runtimePathConfig = [ordered]@{
  schemaVersion = 1
  resolvedFrom = $runtimePathSource
  codexHome = $codexHomeRoot
  stateDir = $stateDir
  lockFile = $lockFile
  guardLockFile = $guardLockFile
  heartbeatFile = $heartbeatFile
  logDir = $logDir
  historyDir = $historyDir
  legacyStateDir = $legacyStateDir
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Compress
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try {
  [System.IO.File]::WriteAllText((Join-Path $scriptDir "runtime-paths.json"), ($runtimePathConfig + "`r`n"), $utf8NoBom)
  Write-Ok ("运行路径：" + $stateDir + "（来源：" + $runtimePathSource + "）")
} catch {
  Write-Note ("runtime-paths.json 写入失败，启动器参数仍会携带绝对路径：" + $_.Exception.Message)
}

$migrationState = [ordered]@{
  schemaVersion = 1
  migratedAt = (Get-Date).ToUniversalTime().ToString("o")
  legacyStateDir = $legacyStateDir
  stateDir = $stateDir
  historyDir = $historyDir
  note = "Ephemeral health is regenerated; durable JSON is copied only when valid and missing."
} | ConvertTo-Json -Compress
try {
  [System.IO.File]::WriteAllText((Join-Path $stateDir "state-migration.json"), ($migrationState + "`r`n"), $utf8NoBom)
} catch {}

if (-not (Test-Path -LiteralPath $codexPlusPlusUserScripts)) {
  Write-Note ("未检测到 Codex++ 用户脚本目录：" + $codexPlusPlusUserScripts)
  Write-Note "请先安装 Codex++，否则统计条无法注入页面（自启仍会安装）。"
}

# ------------------------------------------------------- 2) 清理旧版守护遗留
Write-Host "`n== 2/5 清理旧版守护进程遗留" -ForegroundColor Cyan

$staleTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  $_.TaskName -ne $taskName -and @($_.Actions | Where-Object {
    $text = [string]$_.Execute + " " + [string]$_.Arguments + " " + [string]$_.WorkingDirectory
    $pluginArtifacts | Where-Object { $text -match $_ }
  }).Count -gt 0
})
foreach ($task in $staleTasks) {
  try {
    Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false -ErrorAction Stop
    Write-Ok ("已删除历史计划任务：" + $task.TaskName)
  } catch {
    Write-Note ("删除历史计划任务失败 " + $task.TaskName + "：" + $_.Exception.Message)
  }
}
if ($staleTasks.Count -eq 0) { Write-Info "无历史计划任务残留。" }

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
  Write-Ok ("已删除历史启动快捷方式：" + $lnk.Name)
}
if ($staleLinks.Count -eq 0) { Write-Info "启动文件夹无本插件快捷方式残留。" }
if ($shell) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }

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
  $target = Join-Path $stateDir $name
  if (-not (Test-Path -LiteralPath $target)) { continue }
  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $target) { Write-Note ("未能清理旧状态文件（可能被占用，不影响运行）：" + $name) }
  else { Write-Info ("已清理旧状态文件：" + $name) }
}

# ------------------------------------------------------------- 3) 注册计划任务
Write-Host "`n== 3/5 注册计划任务" -ForegroundColor Cyan

try {
  $oldWatchdogs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '^(powershell|pwsh)\.exe$' -and
      $_.CommandLine -match 'monitor-watchdog\.ps1'
    })
  foreach ($oldWatchdog in $oldWatchdogs) {
    try {
      Stop-Process -Id $oldWatchdog.ProcessId -Force -ErrorAction Stop
      Write-Info ("已停止旧 watchdog PID " + $oldWatchdog.ProcessId + "（加载常驻版本）")
    } catch {
      Write-Note ("停止旧 watchdog 失败 PID " + $oldWatchdog.ProcessId + "：" + $_.Exception.Message)
    }
  }
  if ($oldWatchdogs.Count -gt 0) { Start-Sleep -Milliseconds 800 }

  # 生成无窗口的短生命周期 Node 启动器。
  # 当前 Windows 11 的 Task Scheduler 已无法执行 VBScript（wscript/cscript 均直接返回 1），
  # launch-silent.ps1 只负责以 -WindowStyle Hidden 启动 node，然后立即退出。
  # 常驻控制面由 monitor-watchdog.ps1 负责；监控实例唯一性仍由 token-stats.mjs 的锁保证。
  $stableProfile = $env:USERPROFILE
  $stableLocalAppData = Join-Path $stableProfile "AppData\Local"
  $stableAppData = Join-Path $stableProfile "AppData\Roaming"
  $stableCodexHome = $codexHomeRoot
  $stableStateDir = $stateDir
  $stableLockFile = $lockFile
  $stableGuardLockFile = $guardLockFile
  $stableHeartbeatFile = $heartbeatFile
  $stableLogDir = $logDir
  $stableHistoryDir = $historyDir
  $launcherTemplate = @'
$ErrorActionPreference = "Stop"
$env:USERPROFILE = '__PROFILE__'
$env:LOCALAPPDATA = '__LOCAL__'
$env:APPDATA = '__APPDATA__'
$env:CODEX_HOME = '__CODEX_HOME__'
$env:TUI_STATE_DIR = '__STATE__'
$env:TUI_LOCK_FILE = '__LOCK__'
$env:TUI_GUARD_LOCK_FILE = '__GUARDLOCK__'
$env:TUI_HEARTBEAT_FILE = '__HEARTBEAT__'
$env:TUI_LOG_DIR = '__LOGDIR__'
$env:TUI_HISTORY_DIR = '__HISTORYDIR__'
$nodePath = '__NODE__'
$statsScript = '__SCRIPT__'
$port = '__PORT__'
$stateDir = '__STATE__'
$lockFile = '__LOCK__'
$guardLockFile = '__GUARDLOCK__'
$heartbeatFile = '__HEARTBEAT__'
$logDir = '__LOGDIR__'
$historyDir = '__HISTORYDIR__'
try {
  $arguments = @(
    ('"' + $statsScript + '"'),
    "--watch",
    "--cdp",
    "--port",
    $port,
    "--state-dir",
    ('"' + $stateDir + '"'),
    "--lock-file",
    ('"' + $lockFile + '"'),
    "--guard-lock-file",
    ('"' + $guardLockFile + '"'),
    "--heartbeat-file",
    ('"' + $heartbeatFile + '"'),
    "--log-dir",
    ('"' + $logDir + '"'),
    "--history-dir",
    ('"' + $historyDir + '"')
  )
  Start-Process -FilePath $nodePath -ArgumentList $arguments -WindowStyle Hidden
  exit 0
} catch {
  try { New-Item -ItemType Directory -Path $logDir -Force | Out-Null } catch {}
  try {
    Add-Content -LiteralPath (Join-Path $logDir "launcher-error.log") -Encoding UTF8 -Value (
      (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $_.Exception.Message
    )
  } catch {}
  exit 1
}
'@
  $launcherText = $launcherTemplate.Replace('__NODE__', $nodePath.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__PROFILE__', $stableProfile.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__LOCAL__', $stableLocalAppData.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__APPDATA__', $stableAppData.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__CODEX_HOME__', $stableCodexHome.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__STATE__', $stableStateDir.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__LOCK__', $stableLockFile.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__GUARDLOCK__', $stableGuardLockFile.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__HEARTBEAT__', $stableHeartbeatFile.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__LOGDIR__', $stableLogDir.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__HISTORYDIR__', $stableHistoryDir.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__SCRIPT__', $statsScript.Replace("'", "''"))
  $launcherText = $launcherText.Replace('__PORT__', $Port.Replace("'", "''"))
  [System.IO.File]::WriteAllText($launcherPath, $launcherText, (New-Object System.Text.UTF8Encoding($true)))
  Write-Ok "已生成无窗口启动器：launch-silent.ps1"
  $oldLauncher = Join-Path $scriptDir "launch-silent.vbs"
  if (Test-Path -LiteralPath $oldLauncher) { Remove-Item -LiteralPath $oldLauncher -Force -ErrorAction SilentlyContinue }

  # ---- 人工确认启动（详情面板的"启动监控"按钮 / 开始菜单入口）------------
  # 设计原则：协议处理器只负责"打开终端"，绝不直接执行监控；
  # 必须由用户在终端里按 Y 确认后才启动，便于企业审计与防误触。
  $confirmScript = Join-Path $scriptDir "start-monitor.ps1"
  $nodeLiteral = "'" + $nodePath.Replace("'", "''") + "'"
  $portLiteral = "'" + $Port.Replace("'", "''") + "'"
  $stateDirLiteral = "'" + $stableStateDir.Replace("'", "''") + "'"
  $lockFileLiteral = "'" + $stableLockFile.Replace("'", "''") + "'"
  $guardLockFileLiteral = "'" + $stableGuardLockFile.Replace("'", "''") + "'"
  $logDirLiteral = "'" + $stableLogDir.Replace("'", "''") + "'"
  # 使用 PowerShell 确认窗口，而不是 cmd.exe 批处理：
  #   - 中文用户名/安装路径不再依赖活动代码页；
  #   - Windows PowerShell 5.1 与 PowerShell 7 均可运行；
  #   - 仍保留显式 Y/N 确认，企业审计时能看到将要执行的完整命令。
  $confirmLines = @(
    '# Tokens UI For Codex - 人工确认启动器（安装时生成）',
    '$ErrorActionPreference = "Continue"',
    '$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition',
    '$statsScript = Join-Path $scriptDir "token-stats.mjs"',
    ('$nodePath = ' + $nodeLiteral),
    ('$port = ' + $portLiteral),
    ('$stateDir = ' + $stateDirLiteral),
    ('$lockFile = ' + $lockFileLiteral),
    ('$guardLockFile = ' + $guardLockFileLiteral),
    ('$logDir = ' + $logDirLiteral),
    'if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {',
    '  $locator = Join-Path $scriptDir "find-codex.ps1"',
    '  if (Test-Path -LiteralPath $locator) { . $locator }',
    '  if (Get-Command Resolve-NodeCli -ErrorAction SilentlyContinue) { $info = Resolve-NodeCli; if ($info) { $nodePath = $info.path } }',
    '}',
    'Write-Host ""',
    'Write-Host "  Tokens UI For Codex - Local monitor start confirmation" -ForegroundColor Cyan',
    'Write-Host "  --------------------------------------------------"',
    'Write-Host "  Command to run (local only, no network access):"',
    'Write-Host ("    `"" + $nodePath + "`" `"" + $statsScript + "`" --watch --cdp --port " + $port)',
    'Write-Host ""',
    'if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { Write-Host "Node.js 22+ was not found. Install Node.js 22+ and retry." -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }',
    '& $nodePath $statsScript --instance-status --state-dir $stateDir --lock-file $lockFile --guard-lock-file $guardLockFile',
    'if ($LASTEXITCODE -eq 0) { Write-Host "Monitor is already running. This window will close."; Start-Sleep -Seconds 2; exit 0 }',
    'Write-Host ""',
    '$answer = Read-Host "Start monitor? [Y] Start  [N] Cancel"',
    'if ($answer -notmatch "^(?i)y$") { Write-Host "Cancelled."; Start-Sleep -Seconds 2; exit 1 }',
    '$watchdog = Join-Path $scriptDir "monitor-watchdog.ps1"',
    '$launcher = Join-Path $scriptDir "launch-silent.ps1"',
    'if (Test-Path -LiteralPath $watchdog -PathType Leaf) {',
    '  Start-Process -FilePath (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe") -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ("`"" + $watchdog + "`""), "-Resident", "-ForceStart") -WindowStyle Hidden',
    '} elseif (Test-Path -LiteralPath $launcher -PathType Leaf) {',
    '  Start-Process -FilePath (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe") -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ("`"" + $launcher + "`"")) -WindowStyle Hidden',
    '} else {',
    '  $launchArgs = @(("`"" + $statsScript + "`""), "--watch", "--cdp", "--port", $port, "--state-dir", ("`"" + $stateDir + "`""), "--lock-file", ("`"" + $lockFile + "`""))',
    '  Start-Process -FilePath $nodePath -ArgumentList $launchArgs -WindowStyle Hidden',
    '}',
    '$started = $false',
    'for ($attempt = 0; $attempt -lt 30; $attempt += 1) {',
    '  Start-Sleep -Seconds 1',
    '  & $nodePath $statsScript --instance-status --state-dir $stateDir --lock-file $lockFile --guard-lock-file $guardLockFile | Out-Null',
    '  if ($LASTEXITCODE -eq 0) { $started = $true; break }',
    '}',
    'if (-not $started) { Write-Host ("Monitor did not start. Check " + $logDir) -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }',
    'Write-Host "Monitor is running. This window will close." -ForegroundColor Green',
    'Start-Sleep -Seconds 2',
    'exit 0'
  )
  $confirmText = (($confirmLines -join "`r`n") + "`r`n")
  [System.IO.File]::WriteAllText($confirmScript, $confirmText, (New-Object System.Text.UTF8Encoding($true)))
  $oldConfirmCmd = Join-Path $scriptDir "start-monitor.cmd"
  if (Test-Path -LiteralPath $oldConfirmCmd) { Remove-Item -LiteralPath $oldConfirmCmd -Force -ErrorAction SilentlyContinue }
  Write-Ok "已生成人工确认启动脚本：start-monitor.ps1"

  $confirmLauncher = Join-Path $scriptDir "launch-confirm.vbs"
  $confirmVbs = @"
' Tokens UI For Codex - open confirmation console (generated by install-autostart.ps1)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ""$confirmScript""", 1, False
"@
  [System.IO.File]::WriteAllText($confirmLauncher, $confirmVbs, (New-Object System.Text.UnicodeEncoding($false, $true)))
  Write-Ok "已生成确认启动器：launch-confirm.vbs"

  # 自定义 URL 协议：tokens-ui-for-codex://start（仅当前用户，无需管理员）
  # 命令固定、不接收 %1 参数，避免被任意网页传参利用。
  $protoRoot = "HKCU:\Software\Classes\tokens-ui-for-codex"
  Remove-Item -Path $protoRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -Path (Join-Path $protoRoot "shell\open\command") -Force | Out-Null
  Set-ItemProperty -Path $protoRoot -Name "(Default)" -Value "URL:Tokens UI For Codex"
  Set-ItemProperty -Path $protoRoot -Name "URL Protocol" -Value ""
  $protoCommand = '"' + (Join-Path $env:WINDIR "System32\wscript.exe") + '" //nologo "' + $confirmLauncher + '"'
  Set-ItemProperty -Path (Join-Path $protoRoot "shell\open\command") -Name "(Default)" -Value $protoCommand
  Write-Ok "已注册启动协议：tokens-ui-for-codex://start（仅当前用户）"

  # 开始菜单兜底入口（企业策略禁用自定义协议时仍可手动启动）
  try {
    $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
    $shortcutPath = Join-Path $startMenu "Tokens UI For Codex - 启动监控.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($shortcutPath)
    $sc.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $sc.Arguments = '//nologo "' + $confirmLauncher + '"'
    $sc.WorkingDirectory = $scriptDir
    $sc.Description = "Tokens UI For Codex - 手动启动监控"
    $sc.Save()
    Write-Ok "已创建开始菜单入口：Tokens UI For Codex - 启动监控"
  } catch {
    Write-Note ("开始菜单入口创建失败（不影响协议启动）：" + $_.Exception.Message)
  }

  $powershellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
  $action = New-ScheduledTaskAction -Execute $powershellPath -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $watchdogPath + '" -Resident') -WorkingDirectory (Join-Path $env:WINDIR "System32")
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch {}
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger) -Settings $settings -Principal $principal -Description "Tokens UI For Codex: resident token monitor supervisor" -Force | Out-Null
  Write-Ok ("已注册计划任务：" + $taskName)
  Write-Info "动作：登录后启动一次隐藏的常驻 monitor-watchdog.ps1；异常时按退避拉起 Node"
  Write-Info ("CDP 端口：" + $Port + "（auto = 从 ChatGPT.exe 命令行自动发现）")
  Write-Info "触发器：当前用户登录；安装完成后会立即执行一次 watchdog"
  Write-Info "重复实例：watchdog 与监控均有独立锁；任务使用 IgnoreNew。"
} catch {
  Write-Bad ("计划任务注册失败：" + $_.Exception.Message)
  exit 1
}

# ------------------------------------------------------- 4) 立即启动（可选）
# 触发策略：安装完毕立即执行一次；之后用户登录时启动常驻 watchdog。
# 手动启动通过详情面板「启动/检查监控」按钮或开始菜单入口。启动失败必须显式报告（自动重试 1 次）。
Write-Host "`n== 4/5 立即启动监控" -ForegroundColor Cyan

function Get-MonitorProcesses {
  # 不绑定安装目录：升级/换盘/部署副本变化后，旧监控也必须被识别并释放。
  # token-stats.mjs + --watch 是本插件监控的稳定命令指纹。
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'token-stats\.mjs' -and $_.CommandLine -match '--watch' })
}

$running = @(Get-MonitorProcesses)
$startFailed = $false

if ($SkipStart) {
  Write-Note "按参数要求跳过立即启动；登录触发仍会照常拉起，也可从详情面板/开始菜单手动启动。"
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

  $started = $false
  for ($attempt = 1; $attempt -le 2; $attempt += 1) {
    try {
      Start-ScheduledTask -TaskName $taskName
    } catch {
      Write-Note ("第 " + $attempt + " 次触发任务失败：" + $_.Exception.Message)
    }
    Start-Sleep -Seconds 3
    $after = @(Get-MonitorProcesses)
    if ($after.Count -gt 0) {
      $attemptNote = if ($attempt -gt 1) { "，第 " + $attempt + " 次尝试成功" } else { "" }
      Write-Ok ("监控已启动（PID " + $after[0].ProcessId + $attemptNote + "）")
      $started = $true
      break
    }
    if ($attempt -lt 2) { Write-Note "本次未检测到监控进程，3 秒后自动重试…" }
  }
  if (-not $started) {
    $startFailed = $true
    Write-Bad "立即启动失败：触发任务后仍未检测到监控进程（已自动重试 1 次）。"
    Write-Note ("可手动重试：Start-ScheduledTask -TaskName `"" + $taskName + "`"")
    Write-Note "也可从详情面板「启动监控」或开始菜单入口手动重试；如持续失败请检查任务状态与监控日志。"
  }
}

# ------------------------------------------------------------------ 5) 汇总
Write-Host "`n== 5/5 完成" -ForegroundColor Cyan

$stateJson = [ordered]@{
  stateVersion = 4
  installed = $true
  mechanism = "scheduled-task"
  supervisorMode = "resident"
  supervisorIntervalMs = 15000
  schemaVersion = 5
  launcherEncoding = "utf-8-bom"
  confirmationScript = "start-monitor.ps1"
  taskName = $taskName
  nodePath = $nodePath
  scriptPath = $statsScript
  watchdogPath = $watchdogPath
  lockFile = $stableLockFile
  guardLockFile = $stableGuardLockFile
  heartbeatFile = $stableHeartbeatFile
  stateDir = $stableStateDir
  logDir = $stableLogDir
  historyDir = $stableHistoryDir
  runtimePathConfig = "runtime-paths.json"
  runtimePathSource = $runtimePathSource
  port = $Port
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Compress
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stateDir "autostart-state.json"), ($stateJson + "`r`n"), $utf8NoBom)

Write-Host "后续说明：" -ForegroundColor White
Write-Host "   1) 触发方式：登录时启动一次常驻 watchdog；手动启动用详情面板按钮或开始菜单。"
Write-Host "   2) 计划任务通过隐藏 PowerShell 启动器拉起 Node，不需要管理员权限。"
Write-Host "   3) Codex 不在运行时监控保持待命，不会退出；Codex 启动后自动开始上报。"
Write-Host ("   4) 运行日志：" + (Join-Path $logDir "watch-YYYYMMDD.log"))
Write-Host "   5) 卸载：运行 uninstall-autostart.ps1"
if ($startFailed) { exit 1 }
exit 0
