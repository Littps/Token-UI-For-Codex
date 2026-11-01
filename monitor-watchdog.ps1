[CmdletBinding()]
param(
  [string]$PluginRoot = "",
  [switch]$ForceStart,
  [switch]$Resident,
  [switch]$CheckOnly,
  [switch]$ResetBackoff,
  [switch]$AllowOtherMonitors,
  [switch]$PrintPaths
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
if (-not $PluginRoot) { $PluginRoot = $PSScriptRoot }
$PluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path

$taskName = "tokens-ui-for-codex-monitor"
$runtimeConfigPath = Join-Path $PluginRoot "runtime-paths.json"
$launcherPath = Join-Path $PluginRoot "launch-silent.ps1"
$statsScript = Join-Path $PluginRoot "token-stats.mjs"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
function Get-EnvMilliseconds {
  param([string]$Name, [long]$DefaultValue)
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if (-not $raw) { return $DefaultValue }
  $number = 0L
  if ([long]::TryParse($raw, [ref]$number) -and $number -ge 0) { return $number }
  return $DefaultValue
}

$startupGraceMs = Get-EnvMilliseconds "TUI_WATCHDOG_STARTUP_GRACE_MS" 120000
$softStaleMs = Get-EnvMilliseconds "TUI_WATCHDOG_SOFT_STALE_MS" 45000
$hardStaleMs = Get-EnvMilliseconds "TUI_WATCHDOG_HARD_STALE_MS" 120000
$resumeGapMs = Get-EnvMilliseconds "TUI_WATCHDOG_RESUME_GAP_MS" 150000
$startTimeoutMs = Get-EnvMilliseconds "TUI_WATCHDOG_START_TIMEOUT_MS" 20000
$residentIntervalMs = Get-EnvMilliseconds "TUI_WATCHDOG_RESIDENT_INTERVAL_MS" 15000
if ($residentIntervalMs -lt 250) { $residentIntervalMs = 250 }
$backoffMinutes = @(1, 2, 5, 10, 15)

function Resolve-AbsolutePath {
  param(
    [string]$Value,
    [string]$BaseDir
  )
  if (-not $Value) { return "" }
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $Value))
}

function Read-JsonFile {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-JsonAtomic {
  param(
    [string]$Path,
    [object]$Value
  )
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $temp = $Path + "." + $PID + ".tmp"
  [System.IO.File]::WriteAllText($temp, (($Value | ConvertTo-Json -Compress) + "`r`n"), $utf8NoBom)
  try {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } catch {
    [System.IO.File]::Copy($temp, $Path, $true)
    [System.IO.File]::Delete($temp)
  }
}

function Get-ProcessInfo {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-ProcessIdAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-RuntimePaths {
  $config = Read-JsonFile $runtimeConfigPath
  $codexHome = if ($env:TUI_CODEX_HOME) {
    $env:TUI_CODEX_HOME
  } elseif ($env:CODEX_HOME) {
    $env:CODEX_HOME
  } else {
    Join-Path $env:USERPROFILE ".codex"
  }
  if ($config -and $config.codexHome) { $codexHome = [string]$config.codexHome }
  $codexHome = Resolve-AbsolutePath $codexHome $PluginRoot
  $runtimeBase = Join-Path $codexHome "tokens-ui-for-codex"
  $stateDir = if ($config -and $config.stateDir) {
    Resolve-AbsolutePath ([string]$config.stateDir) $PluginRoot
  } else {
    Join-Path $runtimeBase "state"
  }
  return [pscustomobject]@{
    codexHome = $codexHome
    stateDir = $stateDir
    lockFile = if ($config -and $config.lockFile) { Resolve-AbsolutePath ([string]$config.lockFile) $PluginRoot } else { Join-Path $runtimeBase "monitor.lock" }
    guardLockFile = if ($config -and $config.guardLockFile) { Resolve-AbsolutePath ([string]$config.guardLockFile) $PluginRoot } else { Join-Path $env:USERPROFILE ".tokens-ui-for-codex\monitor.guard.lock" }
    heartbeatFile = if ($config -and $config.heartbeatFile) { Resolve-AbsolutePath ([string]$config.heartbeatFile) $PluginRoot } else { Join-Path $stateDir "monitor-heartbeat.json" }
    logDir = if ($config -and $config.logDir) { Resolve-AbsolutePath ([string]$config.logDir) $PluginRoot } else { Join-Path $stateDir "logs" }
  }
}

$paths = Get-RuntimePaths
$watchdogLockFile = Join-Path $paths.stateDir "watchdog.lock"
$watchdogStateFile = Join-Path $paths.stateDir "watchdog-state.json"

if ($PrintPaths) {
  [pscustomobject]@{
    pluginRoot = $PluginRoot
    codexHome = $paths.codexHome
    stateDir = $paths.stateDir
    lockFile = $paths.lockFile
    guardLockFile = $paths.guardLockFile
    heartbeatFile = $paths.heartbeatFile
    logDir = $paths.logDir
    watchdogLockFile = $watchdogLockFile
    watchdogStateFile = $watchdogStateFile
  } | ConvertTo-Json -Compress
  exit 0
}

function Write-WatchdogLog {
  param([string]$Message)
  try {
    if (-not (Test-Path -LiteralPath $paths.logDir)) {
      New-Item -ItemType Directory -Path $paths.logDir -Force | Out-Null
    }
    $day = Get-Date -Format "yyyy-MM-dd"
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $Message
    [System.IO.File]::AppendAllText((Join-Path $paths.logDir ("watchdog-" + $day + ".log")), ($line + [Environment]::NewLine), $utf8NoBom)
  } catch {}
}

function Acquire-WatchdogLock {
  if (-not (Test-Path -LiteralPath $paths.stateDir)) {
    New-Item -ItemType Directory -Path $paths.stateDir -Force | Out-Null
  }
  try {
    $stream = [System.IO.File]::Open($watchdogLockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    $held = Read-JsonFile $watchdogLockFile
    if ($held -and (Test-ProcessIdAlive ([int]$held.pid))) {
      $heldInfo = Get-ProcessInfo ([int]$held.pid)
      if ($heldInfo -and $heldInfo.CommandLine -match "monitor-watchdog\.ps1") {
        return $false
      }
    }
    Remove-Item -LiteralPath $watchdogLockFile -Force -ErrorAction SilentlyContinue
    $stream = [System.IO.File]::Open($watchdogLockFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  }
  try {
    $payload = @{ pid = $PID; startedAt = ([DateTimeOffset]::UtcNow.ToString("o")) } | ConvertTo-Json -Compress
    $bytes = $utf8NoBom.GetBytes($payload)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  } finally {
    $stream.Dispose()
  }
  return $true
}

function Remove-WatchdogLock {
  $held = Read-JsonFile $watchdogLockFile
  if ($held -and [int]$held.pid -eq $PID) {
    Remove-Item -LiteralPath $watchdogLockFile -Force -ErrorAction SilentlyContinue
  }
}

function Get-MonitorProcesses {
  $items = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match "token-stats\.mjs" -and
      $_.CommandLine -match "--watch"
    }
  return @($items)
}

function Test-MonitorScriptIdentity {
  param([object]$ProcessInfo)
  if (-not $ProcessInfo) { return $false }
  if ($ProcessInfo.Name -ne "node.exe") { return $false }
  if (-not $ProcessInfo.CommandLine) { return $false }
  return $ProcessInfo.CommandLine.IndexOf($statsScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-MonitorIdentity {
  param(
    [object]$ProcessInfo,
    [object]$Heartbeat
  )
  if (-not $ProcessInfo) { return $false }
  if ($ProcessInfo.Name -ne "node.exe") { return $false }
  if (-not $ProcessInfo.CommandLine -or $ProcessInfo.CommandLine.IndexOf($statsScript, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    return $false
  }
  if (-not $Heartbeat) { return $false }
  if ([int]$Heartbeat.pid -ne [int]$ProcessInfo.ProcessId) { return $false }
  if ($Heartbeat.stateDir -and $Heartbeat.stateDir -ne $paths.stateDir) { return $false }
  try {
    $processStart = ([DateTime]$ProcessInfo.CreationDate).ToUniversalTime()
    $monitorStart = ([DateTimeOffset]::Parse([string]$Heartbeat.startedAt)).UtcDateTime
    if ([math]::Abs(($processStart - $monitorStart).TotalSeconds) -gt 20) { return $false }
  } catch {
    return $false
  }
  return $true
}

function Remove-LockArtifact {
  param(
    [string]$Path,
    [int]$OnlyPid
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  $value = Read-JsonFile $Path
  if ($value -and $OnlyPid -gt 0 -and [int]$value.pid -ne $OnlyPid) { return }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Start-MonitorProcess {
  if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "Missing launcher: $launcherPath"
  }
  $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
  $launcherProcess = Start-Process -FilePath $powershell -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ('"' + $launcherPath + '"')) -WindowStyle Hidden -PassThru

  $deadline = (Get-Date).AddMilliseconds($startTimeoutMs)
  do {
    Start-Sleep -Milliseconds 500
    $lock = Read-JsonFile $paths.lockFile
    $heartbeat = Read-JsonFile $paths.heartbeatFile
    if ($lock -and $heartbeat -and [int]$lock.pid -eq [int]$heartbeat.pid -and (Test-ProcessIdAlive ([int]$lock.pid))) {
      return [pscustomobject]@{ ok = $true; pid = [int]$lock.pid; reason = "started" }
    }
  } while ((Get-Date) -lt $deadline)
  $launcherProcess.Refresh()
  $launcherState = if ($launcherProcess.HasExited) { "exit-" + [string]$launcherProcess.ExitCode } else { "running" }
  $lastLock = Read-JsonFile $paths.lockFile
  $lastHeartbeat = Read-JsonFile $paths.heartbeatFile
  return [pscustomobject]@{
    ok = $false
    pid = $null
    reason = "start-timeout-launcher-$launcherState-lock-$([string]$lastLock.pid)-heartbeat-$([string]$lastHeartbeat.pid)"
  }
}

function Stop-MonitorProcessConfirmed {
  param(
    [int]$ProcessId,
    [int]$TimeoutMs = 5000
  )
  if (-not (Test-ProcessIdAlive $ProcessId)) { return $true }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  do {
    if (-not (Test-ProcessIdAlive $ProcessId)) { return $true }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Save-WatchdogState {
  param([hashtable]$State)
  $State.lastCheckAt = ([DateTimeOffset]::UtcNow.ToString("o"))
  Write-JsonAtomic $watchdogStateFile $State
}

$forceStartPending = [bool]$ForceStart
$resetBackoffPending = [bool]$ResetBackoff

if (-not (Acquire-WatchdogLock)) {
  exit 0
}

try {
  if ($Resident -and -not $CheckOnly) {
    Write-WatchdogLog "Resident watchdog started (PID $PID, interval ${residentIntervalMs}ms)"
  }
  while ($true) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $forceStartThisCycle = $forceStartPending
    $forceStartPending = $false
    $resetBackoffThisCycle = $resetBackoffPending
    $resetBackoffPending = $false
    $cycleExitCode = 0
    do {
$previous = Read-JsonFile $watchdogStateFile
$state = @{
  schemaVersion = 1
  watchdogMode = if ($Resident -and -not $CheckOnly) { "resident" } else { "one-shot" }
  watchdogPid = $PID
  pid = if ($previous) { $previous.pid } else { $null }
  monitorStartedAt = if ($previous) { $previous.monitorStartedAt } else { $null }
  lastCheckAt = if ($previous) { $previous.lastCheckAt } else { $null }
  heartbeatSeq = if ($previous) { $previous.heartbeatSeq } else { 0 }
  firstStaleAt = if ($previous) { $previous.firstStaleAt } else { 0 }
  consecutiveFailures = if ($previous) { [int]$previous.consecutiveFailures } else { 0 }
  nextRestartAt = if ($previous) { [long]$previous.nextRestartAt } else { 0 }
  lastRestartAt = if ($previous) { [long]$previous.lastRestartAt } else { 0 }
  identityRestartPid = if ($previous) { [int]$previous.identityRestartPid } else { 0 }
  identityRestartStartedAt = if ($previous) { [string]$previous.identityRestartStartedAt } else { "" }
  lastAction = "none"
  lastError = $null
  phase = "starting"
}

if ($resetBackoffThisCycle) {
  $state.firstStaleAt = 0
  $state.consecutiveFailures = 0
  $state.nextRestartAt = 0
}

$resumeDetected = $false
if ($state.lastCheckAt) {
  try {
    $lastCheck = ([DateTimeOffset]::Parse([string]$state.lastCheckAt)).ToUnixTimeMilliseconds()
    if ($now - $lastCheck -gt $resumeGapMs) { $resumeDetected = $true }
  } catch {}
}

  $lock = Read-JsonFile $paths.lockFile
  $heartbeat = Read-JsonFile $paths.heartbeatFile
  $monitorPid = if ($heartbeat -and [int]$heartbeat.pid -gt 0) { [int]$heartbeat.pid } elseif ($lock) { [int]$lock.pid } else { 0 }
  $processInfo = Get-ProcessInfo $monitorPid
  $ignoreOtherMonitors = $AllowOtherMonitors -or $env:TUI_WATCHDOG_ALLOW_OTHER_MONITORS -eq "1"
  $otherMonitors = if ($ignoreOtherMonitors) {
    @()
  } else {
    @(Get-MonitorProcesses | Where-Object { [int]$_.ProcessId -ne $monitorPid })
  }
  $scriptIdentityValid = Test-MonitorScriptIdentity $processInfo
  $identityValid = Test-MonitorIdentity $processInfo $heartbeat
  $heartbeatMs = 0
  if ($heartbeat -and $heartbeat.heartbeatAt) {
    try { $heartbeatMs = ([DateTimeOffset]::Parse([string]$heartbeat.heartbeatAt)).ToUnixTimeMilliseconds() } catch {}
  }
  $heartbeatAge = if ($heartbeatMs -gt 0) { $now - $heartbeatMs } else { [long]::MaxValue }
  $processAge = 0
  $processStartedAt = ""
  if ($processInfo -and $processInfo.CreationDate) {
    $processCreation = ([DateTimeOffset]$processInfo.CreationDate).ToUniversalTime()
    $processAge = $now - $processCreation.ToUnixTimeMilliseconds()
    $processStartedAt = $processCreation.ToString("o")
  }
  if (
    [int]$state.identityRestartPid -gt 0 -and
    (
      -not $processInfo -or
      [int]$state.identityRestartPid -ne $monitorPid -or
      [string]$state.identityRestartStartedAt -ne $processStartedAt
    )
  ) {
    $state.identityRestartPid = 0
    $state.identityRestartStartedAt = ""
  }

  $state.pid = if ($monitorPid -gt 0) { $monitorPid } else { $null }
  $state.monitorStartedAt = if ($heartbeat) { $heartbeat.startedAt } elseif ($lock) { $lock.startedAt } else { $null }
  $state.heartbeatSeq = if ($heartbeat) { [int]$heartbeat.heartbeatSeq } else { 0 }

  if ($identityValid -and $heartbeatAge -le $softStaleMs) {
    $state.phase = "healthy"
    $state.firstStaleAt = 0
    $state.lastAction = "none"
    $state.lastError = $null
    $state.identityRestartPid = 0
    $state.identityRestartStartedAt = ""
    if ($state.lastRestartAt -gt 0 -and $now - $state.lastRestartAt -gt 600000) {
      $state.consecutiveFailures = 0
    }
    Save-WatchdogState $state
    $cycleExitCode = 0
    break
  }

  if ($identityValid -and $processAge -lt $startupGraceMs) {
    $state.phase = "starting"
    $state.firstStaleAt = 0
    $state.lastAction = "wait-startup"
    Save-WatchdogState $state
    $cycleExitCode = 0
    break
  }

  if ($identityValid -and $heartbeatAge -gt $softStaleMs) {
    if ($resumeDetected) {
      $state.firstStaleAt = 0
      $state.phase = "recovering"
      $state.lastAction = "resume-grace"
      Save-WatchdogState $state
      $cycleExitCode = 0
      break
    }
    if ([long]$state.firstStaleAt -le 0) {
      $state.firstStaleAt = $now
      $state.phase = "stale-candidate"
      $state.lastAction = "observe-stale"
      Save-WatchdogState $state
      $cycleExitCode = 0
      break
    }
    if (($now - [long]$state.firstStaleAt) -lt $softStaleMs -or $heartbeatAge -lt $hardStaleMs) {
      $state.phase = "stale-candidate"
      $state.lastAction = "confirm-stale"
      Save-WatchdogState $state
      $cycleExitCode = 0
      break
    }
    if ($CheckOnly) {
      $state.phase = "hung"
      $state.lastAction = "check-only-hung"
      Save-WatchdogState $state
      $cycleExitCode = 2
      break
    }
    Write-WatchdogLog "Restarting hung monitor PID $monitorPid (heartbeat age ${heartbeatAge}ms)"
    if (-not (Stop-MonitorProcessConfirmed $monitorPid)) {
      $state.phase = "stop-failed"
      $state.lastAction = "stop-hung-failed"
      $state.lastError = "Could not stop hung monitor PID $monitorPid"
      Save-WatchdogState $state
      $cycleExitCode = 7
      break
    }
    Remove-LockArtifact $paths.lockFile $monitorPid
    Remove-LockArtifact $paths.guardLockFile $monitorPid
    $state.firstStaleAt = 0
  } elseif ($processInfo -and -not $identityValid) {
    if ($scriptIdentityValid) {
      if ($processAge -lt $startupGraceMs) {
        $state.phase = "starting"
        $state.firstStaleAt = 0
        $state.lastAction = "wait-identity"
        $state.lastError = "Monitor is running but heartbeat identity is not available yet"
        Save-WatchdogState $state
        $cycleExitCode = 0
        break
      }
      if ($otherMonitors.Count -gt 0) {
        $state.phase = "conflict"
        $state.lastAction = "identity-conflict"
        $state.lastError = "Another monitor process is active"
        Save-WatchdogState $state
        $cycleExitCode = 3
        break
      }
      if ($CheckOnly) {
        $state.phase = "heartbeat-missing"
        $state.lastAction = "check-only-identity"
        $state.lastError = "Monitor script is running but heartbeat identity is unavailable"
        Save-WatchdogState $state
        $cycleExitCode = 4
        break
      }
      if (
        [int]$state.identityRestartPid -eq $monitorPid -and
        [string]$state.identityRestartStartedAt -eq $processStartedAt
      ) {
        $state.phase = "heartbeat-missing"
        $state.lastAction = "restart-not-cleared"
        $state.lastError = "The unverified monitor remained after a controlled restart"
        Save-WatchdogState $state
        $cycleExitCode = 4
        break
      }
      Write-WatchdogLog "Restarting monitor PID $monitorPid once after startup grace because heartbeat identity is unavailable"
      if (-not (Stop-MonitorProcessConfirmed $monitorPid)) {
        $state.phase = "stop-failed"
        $state.lastAction = "stop-unverified-failed"
        $state.lastError = "Could not stop unverified monitor PID $monitorPid"
        Save-WatchdogState $state
        $cycleExitCode = 7
        break
      }
      $state.identityRestartPid = $monitorPid
      $state.identityRestartStartedAt = $processStartedAt
      Remove-LockArtifact $paths.lockFile $monitorPid
      Remove-LockArtifact $paths.guardLockFile $monitorPid
      Remove-Item -LiteralPath $paths.heartbeatFile -Force -ErrorAction SilentlyContinue
      $state.firstStaleAt = 0
    } else {
      if ($otherMonitors.Count -gt 0) {
        $state.phase = "conflict"
        $state.lastAction = "identity-conflict"
        $state.lastError = "Another monitor process is active"
        Save-WatchdogState $state
        $cycleExitCode = 3
        break
      }
      if ($CheckOnly) {
        $state.phase = "identity-mismatch"
        $state.lastAction = "check-only-identity"
        Save-WatchdogState $state
        $cycleExitCode = 4
        break
      }
      Remove-LockArtifact $paths.lockFile $monitorPid
      Remove-LockArtifact $paths.guardLockFile $monitorPid
      Remove-Item -LiteralPath $paths.heartbeatFile -Force -ErrorAction SilentlyContinue
    }
  }

  if ($otherMonitors.Count -gt 0) {
    $state.phase = "conflict"
    $state.lastAction = "process-audit-conflict"
    $state.lastError = "Detected another running monitor"
    Save-WatchdogState $state
    $cycleExitCode = 3
    break
  }

  if ($CheckOnly) {
    $state.phase = "stopped"
    $state.lastAction = "check-only-stopped"
    Save-WatchdogState $state
    $cycleExitCode = 1
    break
  }

  if (-not $forceStartThisCycle -and [long]$state.nextRestartAt -gt $now) {
    $state.phase = "backoff"
    $state.lastAction = "backoff"
    Save-WatchdogState $state
    $cycleExitCode = 5
    break
  }

  $start = Start-MonitorProcess
  $state.lastRestartAt = $now
  if ($start.ok) {
    $startedHeartbeat = Read-JsonFile $paths.heartbeatFile
    $state.pid = $start.pid
    if ($startedHeartbeat) {
      $state.monitorStartedAt = $startedHeartbeat.startedAt
      $state.heartbeatSeq = [int]$startedHeartbeat.heartbeatSeq
    }
    $state.phase = "starting"
    $state.lastAction = "started"
    $state.lastError = $null
    $state.nextRestartAt = 0
    $state.identityRestartPid = 0
    $state.identityRestartStartedAt = ""
    Write-WatchdogLog "Started monitor PID $($start.pid)"
    Save-WatchdogState $state
    $cycleExitCode = 0
    break
  }

  $state.consecutiveFailures = [int]$state.consecutiveFailures + 1
  $state.phase = "failed"
  $state.lastAction = "start-failed"
  $state.lastError = $start.reason
  $index = [math]::Min($state.consecutiveFailures - 1, $backoffMinutes.Count - 1)
  $state.nextRestartAt = $now + ($backoffMinutes[$index] * 60000)
  Write-WatchdogLog "Monitor start failed: $($start.reason); failures=$($state.consecutiveFailures)"
  Save-WatchdogState $state
  $cycleExitCode = 6
  break
    } while ($false)
    if (-not $Resident -or $CheckOnly) {
      exit $cycleExitCode
    }
    Start-Sleep -Milliseconds $residentIntervalMs
  }
} finally {
  Remove-WatchdogLock
}
