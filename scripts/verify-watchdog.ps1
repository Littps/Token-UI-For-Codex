[CmdletBinding()]
param(
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

if (-not $RepoRoot) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$nodePath = (Get-Command node -ErrorAction Stop).Source
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("tui-watchdog-test-" + [Guid]::NewGuid().ToString("N"))
$pluginRoot = Join-Path $testRoot "plugin"
$codexHome = Join-Path $testRoot "codex"
$stateDir = Join-Path $testRoot "state"
$logDir = Join-Path $stateDir "logs"
$historyDir = Join-Path $stateDir "history"
$lockFile = Join-Path $testRoot "monitor.lock"
$guardLockFile = Join-Path $testRoot "monitor.guard.lock"
$heartbeatFile = Join-Path $stateDir "monitor-heartbeat.json"
$runtimeConfigFile = Join-Path $pluginRoot "runtime-paths.json"
$launcherPath = Join-Path $pluginRoot "launch-silent.ps1"
$watchdogPath = Join-Path $pluginRoot "monitor-watchdog.ps1"
$statsScript = Join-Path $pluginRoot "token-stats.mjs"
$startedPids = @()

function Write-TestJson {
  param([string]$Path, [object]$Value)
  [System.IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Compress) + "`r`n"), $utf8NoBom)
}

function Read-TestJson {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json)
}

function Invoke-Watchdog {
  param([switch]$ForceStart)
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $watchdogPath,
    "-PluginRoot",
    $pluginRoot,
    "-AllowOtherMonitors"
  )
  if ($ForceStart) { $arguments += "-ForceStart" }
  & powershell.exe @arguments
  return $LASTEXITCODE
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Wait-ForHeartbeat {
  param([int]$TimeoutSeconds = 10)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $heartbeat = Read-TestJson $heartbeatFile
    if ($heartbeat -and [int]$heartbeat.pid -gt 0) { return $heartbeat }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Heartbeat was not created"
}

function Wait-ForDifferentHeartbeat {
  param(
    [int]$PreviousPid,
    [int]$TimeoutSeconds = 10
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $heartbeat = Read-TestJson $heartbeatFile
    if ($heartbeat -and [int]$heartbeat.pid -gt 0 -and [int]$heartbeat.pid -ne $PreviousPid) {
      return $heartbeat
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  $state = Read-TestJson (Join-Path $stateDir "watchdog-state.json")
  $logPath = Join-Path $logDir ("watchdog-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
  $tail = if (Test-Path -LiteralPath $logPath) { Get-Content -Tail 8 -Encoding UTF8 -LiteralPath $logPath } else { @() }
  $launcherLog = Join-Path $logDir "launcher-error.log"
  $launcherTail =
    if (Test-Path -LiteralPath $launcherLog) { Get-Content -Tail 5 -Encoding UTF8 -LiteralPath $launcherLog } else { @() }
  $monitorLog = Join-Path $logDir ("watch-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
  $monitorTail =
    if (Test-Path -LiteralPath $monitorLog) { Get-Content -Tail 8 -Encoding UTF8 -LiteralPath $monitorLog } else { @() }
  $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'token-stats\.mjs' } |
    Select-Object ProcessId, CommandLine)
  throw (
    "Heartbeat PID did not change; phase=" + [string]$state.phase +
    "; action=" + [string]$state.lastAction +
    "; error=" + [string]$state.lastError +
    "; nodes=" + (($nodeProcesses | ConvertTo-Json -Compress)) +
    "; log=" + ($tail -join " | ") +
    "; launcher=" + ($launcherTail -join " | ") +
    "; monitor=" + ($monitorTail -join " | ")
  )
}

try {
  New-Item -ItemType Directory -Path $pluginRoot, $codexHome, $stateDir, $logDir, $historyDir -Force | Out-Null
  foreach ($name in @("token-stats.mjs", "runtime-paths.mjs", "speed-stats.mjs", "history-archive.mjs", "protocol.mjs", "monitor-watchdog.ps1")) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot $name) -Destination (Join-Path $pluginRoot $name) -Force
  }

  Write-TestJson $runtimeConfigFile ([ordered]@{
      schemaVersion = 1
      resolvedFrom = "test"
      codexHome = $codexHome
      stateDir = $stateDir
      lockFile = $lockFile
      guardLockFile = $guardLockFile
      heartbeatFile = $heartbeatFile
      logDir = $logDir
      historyDir = $historyDir
    })

  $launcherText = @'
$ErrorActionPreference = "Stop"
$nodePath = '__NODE__'
$statsScript = '__SCRIPT__'
$arguments = @(
  ('"' + $statsScript + '"'),
  "--watch",
  "--allow-multi-monitor",
  "--state-dir",
  '"__STATE__"',
  "--lock-file",
  '"__LOCK__"',
  "--guard-lock-file",
  '"__GUARD__"',
  "--heartbeat-file",
  '"__HEARTBEAT__"',
  "--log-dir",
  '"__LOG__"',
  "--history-dir",
  '"__HISTORY__"'
)
Start-Process -FilePath $nodePath -ArgumentList $arguments -WindowStyle Hidden | Out-Null
'@
  $launcherText = $launcherText.Replace("__NODE__", $nodePath.Replace("'", "''"))
  $launcherText = $launcherText.Replace("__SCRIPT__", $statsScript.Replace("'", "''"))
  $launcherText = $launcherText.Replace("__STATE__", $stateDir.Replace("'", "''"))
  $launcherText = $launcherText.Replace("__LOCK__", $lockFile.Replace("'", "''"))
  $launcherText = $launcherText.Replace("__GUARD__", $guardLockFile.Replace("'", "''"))
  $launcherText = $launcherText.Replace("__HEARTBEAT__", $heartbeatFile.Replace("'", "''"))
  $launcherText = $launcherText.Replace("__LOG__", $logDir.Replace("'", "''"))
  $launcherText = $launcherText.Replace("__HISTORY__", $historyDir.Replace("'", "''"))
  [System.IO.File]::WriteAllText($launcherPath, $launcherText, (New-Object System.Text.UTF8Encoding($true)))

  $env:TUI_WATCHDOG_START_TIMEOUT_MS = "5000"
  $env:TUI_MONITOR_HEARTBEAT_INTERVAL_MS = "60000"
  $env:TUI_WATCHDOG_STARTUP_GRACE_MS = "60000"
  $env:TUI_WATCHDOG_SOFT_STALE_MS = "45000"
  $env:TUI_WATCHDOG_HARD_STALE_MS = "120000"
  $env:TUI_WATCHDOG_RESUME_GAP_MS = "150000"

  $firstExit = Invoke-Watchdog -ForceStart
  Assert-True ($firstExit -eq 0) ("Initial watchdog start failed: " + $firstExit)
  $firstHeartbeat = Wait-ForHeartbeat
  $firstPid = [int]$firstHeartbeat.pid
  $startedPids += $firstPid

  $healthyExit = Invoke-Watchdog
  $healthyHeartbeat = Read-TestJson $heartbeatFile
  Assert-True ($healthyExit -eq 0) ("Healthy watchdog check failed: " + $healthyExit)
  Assert-True ([int]$healthyHeartbeat.pid -eq $firstPid) "Healthy check restarted the monitor"

  Stop-Process -Id $firstPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  $restartExit = Invoke-Watchdog -ForceStart
  Assert-True ($restartExit -eq 0) ("Crash recovery failed: " + $restartExit)
  $secondHeartbeat = Wait-ForHeartbeat
  $secondPid = [int]$secondHeartbeat.pid
  $startedPids += $secondPid
  Assert-True ($secondPid -ne $firstPid) "Crash recovery reused the dead PID"

  $stale = Read-TestJson $heartbeatFile
  $stale.heartbeatAt = [DateTimeOffset]::UtcNow.AddSeconds(-10).ToString("o")
  $stale.heartbeatSeq = [int]$stale.heartbeatSeq + 1
  Write-TestJson $heartbeatFile $stale
  $env:TUI_WATCHDOG_STARTUP_GRACE_MS = "100"
  $env:TUI_WATCHDOG_SOFT_STALE_MS = "200"
  $env:TUI_WATCHDOG_HARD_STALE_MS = "500"
  $candidateExit = Invoke-Watchdog
  Assert-True ($candidateExit -eq 0) ("Stale candidate check failed: " + $candidateExit)
  Start-Sleep -Milliseconds 900
  $hungExit = Invoke-Watchdog
  Assert-True ($hungExit -eq 0) ("Hung monitor recovery failed: " + $hungExit)
  $thirdHeartbeat = Wait-ForHeartbeat
  $thirdPid = [int]$thirdHeartbeat.pid
  $startedPids += $thirdPid
  Assert-True ($thirdPid -ne $secondPid) "Hung monitor was not replaced"

  Stop-Process -Id $thirdPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  Remove-Item -LiteralPath (Join-Path $stateDir "watchdog.lock") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $lockFile, $guardLockFile, $heartbeatFile -Force -ErrorAction SilentlyContinue

  # Simulate a pre-heartbeat build left by an in-place upgrade. It has the
  # expected script path and main lock, but never writes identity heartbeat.
  [System.IO.File]::WriteAllText($statsScript, "setInterval(() => {}, 60000);`r`n", $utf8NoBom)
  $legacyMonitor = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $statsScript + '"'), "--watch") -WindowStyle Hidden -PassThru
  $legacyPid = [int]$legacyMonitor.Id
  $startedPids += $legacyPid
  Start-Sleep -Milliseconds 350
  $legacyInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$legacyPid" -ErrorAction Stop
  Assert-True ($null -ne $legacyInfo) "Heartbeatless migration fixture did not start"
  Write-TestJson $lockFile ([ordered]@{
      schemaVersion = 1
      pid = $legacyPid
      startedAt = ([DateTimeOffset]$legacyInfo.CreationDate).ToUniversalTime().ToString("o")
      scriptPath = $statsScript
      stateDir = $stateDir
    })
  Copy-Item -LiteralPath (Join-Path $RepoRoot "token-stats.mjs") -Destination $statsScript -Force
  $migrationExit = Invoke-Watchdog -ForceStart
  Assert-True ($migrationExit -eq 0) ("Heartbeatless migration failed: " + $migrationExit)
  $fourthHeartbeat = Wait-ForHeartbeat
  $fourthPid = [int]$fourthHeartbeat.pid
  $startedPids += $fourthPid
  Assert-True ($fourthPid -ne $legacyPid) "Heartbeatless monitor was not replaced"
  Assert-True ($null -eq (Get-Process -Id $legacyPid -ErrorAction SilentlyContinue)) "Legacy monitor PID remained alive"

  Stop-Process -Id $fourthPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800

  Remove-Item -LiteralPath $lockFile, $guardLockFile, $heartbeatFile -Force -ErrorAction SilentlyContinue
  $env:TUI_WATCHDOG_START_TIMEOUT_MS = "5000"
  $env:TUI_WATCHDOG_RESIDENT_INTERVAL_MS = "500"
  $residentArgs = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $watchdogPath,
    "-PluginRoot",
    $pluginRoot,
    "-AllowOtherMonitors",
    "-Resident",
    "-ForceStart"
  )
  $resident = Start-Process -FilePath "powershell.exe" -ArgumentList $residentArgs -WindowStyle Hidden -PassThru
  $startedPids += [int]$resident.Id
  $residentHeartbeat = Wait-ForHeartbeat
  $residentMonitorPid = [int]$residentHeartbeat.pid
  $startedPids += $residentMonitorPid
  Assert-True ($null -ne (Get-Process -Id $resident.Id -ErrorAction SilentlyContinue)) "Resident watchdog exited"
  Start-Sleep -Milliseconds 1500
  Stop-Process -Id $residentMonitorPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1000
  $residentRestartHeartbeat = Wait-ForDifferentHeartbeat -PreviousPid $residentMonitorPid
  $residentRestartedPid = [int]$residentRestartHeartbeat.pid
  $startedPids += $residentRestartedPid
  Assert-True (
    $null -ne (Get-Process -Id $resident.Id -ErrorAction SilentlyContinue)
  ) "Resident watchdog exited after monitor restart"
  $residentState = Read-TestJson (Join-Path $stateDir "watchdog-state.json")
  Assert-True ($residentState.watchdogMode -eq "resident") "Watchdog state did not record resident mode"
  Stop-Process -Id $resident.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $residentRestartedPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800

  [System.IO.File]::WriteAllText($launcherPath, "exit 1`r`n", $utf8NoBom)
  $env:TUI_WATCHDOG_START_TIMEOUT_MS = "1000"
  $failureExit = Invoke-Watchdog -ForceStart
  Assert-True ($failureExit -ne 0) "Broken launcher unexpectedly reported success"
  $watchdogState = Read-TestJson (Join-Path $stateDir "watchdog-state.json")
  Assert-True ($null -ne $watchdogState) "Watchdog state was not written"
  Assert-True ([int]$watchdogState.consecutiveFailures -ge 1) "Watchdog failure counter did not increment"
  Assert-True ([long]$watchdogState.nextRestartAt -gt 0) "Watchdog backoff was not scheduled"

  Write-Output "watchdog verification passed"
} finally {
  Remove-Item Env:TUI_WATCHDOG_START_TIMEOUT_MS -ErrorAction SilentlyContinue
  Remove-Item Env:TUI_MONITOR_HEARTBEAT_INTERVAL_MS -ErrorAction SilentlyContinue
  Remove-Item Env:TUI_WATCHDOG_STARTUP_GRACE_MS -ErrorAction SilentlyContinue
  Remove-Item Env:TUI_WATCHDOG_SOFT_STALE_MS -ErrorAction SilentlyContinue
  Remove-Item Env:TUI_WATCHDOG_HARD_STALE_MS -ErrorAction SilentlyContinue
  Remove-Item Env:TUI_WATCHDOG_RESUME_GAP_MS -ErrorAction SilentlyContinue
  Remove-Item Env:TUI_WATCHDOG_RESIDENT_INTERVAL_MS -ErrorAction SilentlyContinue
  foreach ($testPid in $startedPids) {
    Stop-Process -Id $testPid -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
  $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedTestRoot.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
