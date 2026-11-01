[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageDirectory,
  [switch]$Keep
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json)
}

function Wait-Until {
  param(
    [int]$TimeoutSeconds,
    [scriptblock]$Condition,
    [string]$FailureMessage
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw $FailureMessage
}

function Invoke-Doctor {
  param(
    [string]$Doctor,
    [string]$Action,
    [string]$PluginRoot
  )
  $output = & $Doctor $Action --plugin-root $PluginRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Doctor $Action failed with exit code $LASTEXITCODE`n$output"
  }
  return ($output -join "`n")
}

$packageRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path
$installer = Join-Path $packageRoot "install-rust-launcher.ps1"
$uninstaller = Join-Path $packageRoot "uninstall-rust-launcher.ps1"
$doctor = Join-Path $packageRoot "tokens-ui-doctor.exe"
$fixture = Join-Path $PSScriptRoot "fixtures\mock-monitor.mjs"
foreach ($required in @($installer, $uninstaller, $doctor, $fixture)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required smoke-test file is missing: $required"
  }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
  "tokens-ui-rust-install-smoke-" + [guid]::NewGuid().ToString("N")
)
$pluginRoot = Join-Path $tempRoot "plugin"
$codexHome = Join-Path $tempRoot "codex-home"
$stateDir = Join-Path $codexHome "tokens-ui-for-codex\state"
$taskName = "tokens-ui-rust-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
$officialTask = Get-ScheduledTask -TaskName "tokens-ui-for-codex-monitor" -ErrorAction SilentlyContinue
$officialAction = if ($officialTask) { [string]$officialTask.Actions[0].Execute } else { "" }

try {
  New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
  Copy-Item -LiteralPath $fixture -Destination (Join-Path $pluginRoot "token-stats.mjs")
  $runtimePaths = @{
    schemaVersion = 1
    codexHome = $codexHome
    stateDir = $stateDir
    heartbeatFile = (Join-Path $stateDir "monitor-heartbeat.json")
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText(
    (Join-Path $pluginRoot "runtime-paths.json"),
    $runtimePaths,
    (New-Object System.Text.UTF8Encoding($false))
  )

  & $installer -PluginRoot $pluginRoot -TaskName $taskName -StartupTimeoutSeconds 30 -Confirm:$false
  if ($LASTEXITCODE -ne 0) {
    throw "Installer failed with exit code $LASTEXITCODE"
  }

  $stateFile = Join-Path $stateDir "watchdog-state.json"
  Wait-Until -TimeoutSeconds 20 -FailureMessage "Installed Rust launcher did not become healthy" -Condition {
    $state = Read-JsonFile $stateFile
    return ($state -and [string]$state.phase -eq "healthy")
  }

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $installedLauncher = Join-Path $pluginRoot "rust-launcher\bin\tokens-ui-launcher.exe"
  if ([string]$task.Actions[0].Execute -ne $installedLauncher) {
    throw "Scheduled task points to an unexpected executable: $($task.Actions[0].Execute)"
  }

  $diagnosis = Invoke-Doctor -Doctor $doctor -Action "--diagnose" -PluginRoot $pluginRoot
  $report = $diagnosis | ConvertFrom-Json
  if (-not $report.launcherAlive -or -not $report.monitorAlive) {
    throw "Doctor did not report both processes alive`n$diagnosis"
  }

  $launcherPid = [int]$report.watchdogState.watchdogPid
  $monitorPid = [int]$report.heartbeat.pid
  $launcherProcess = Get-Process -Id $launcherPid -ErrorAction Stop
  $monitorProcess = Get-Process -Id $monitorPid -ErrorAction Stop
  $launcherCpuStart = $launcherProcess.CPU
  $monitorCpuStart = $monitorProcess.CPU
  $sampleStarted = Get-Date
  Start-Sleep -Seconds 3
  $launcherProcess.Refresh()
  $monitorProcess.Refresh()
  $sampleSeconds = ((Get-Date) - $sampleStarted).TotalSeconds
  $launcherCpuPct = (($launcherProcess.CPU - $launcherCpuStart) / $sampleSeconds) * 100
  $monitorCpuPct = (($monitorProcess.CPU - $monitorCpuStart) / $sampleSeconds) * 100
  $launcherWorkingSetMb = $launcherProcess.WorkingSet64 / 1MB
  $monitorWorkingSetMb = $monitorProcess.WorkingSet64 / 1MB

  & $uninstaller `
    -PluginRoot $pluginRoot `
    -TaskName $taskName `
    -RestorePreviousTask $false `
    -Full `
    -Confirm:$false
  if ($LASTEXITCODE -ne 0) {
    throw "Uninstaller failed with exit code $LASTEXITCODE"
  }

  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw "Smoke-test scheduled task was not removed"
  }
  if (Test-Path -LiteralPath (Join-Path $pluginRoot "rust-launcher")) {
    throw "Rust launcher binaries were not removed by -Full"
  }

  $officialAfter = Get-ScheduledTask -TaskName "tokens-ui-for-codex-monitor" -ErrorAction SilentlyContinue
  $officialActionAfter = if ($officialAfter) { [string]$officialAfter.Actions[0].Execute } else { "" }
  if ($officialAction -ne $officialActionAfter) {
    throw "The official scheduled task changed during the isolated smoke test"
  }

  Write-Host "Install/uninstall smoke test passed." -ForegroundColor Green
  Write-Host "Temporary task: $taskName"
  Write-Host "Official task unchanged: $officialActionAfter"
  Write-Host ("Rust launcher: {0:N2} MB working set, {1:N3}% of one CPU core" -f (
    $launcherWorkingSetMb
  ), $launcherCpuPct)
  Write-Host ("Mock Node:     {0:N2} MB working set, {1:N3}% of one CPU core" -f (
    $monitorWorkingSetMb
  ), $monitorCpuPct)
} finally {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    if ([string]$task.State -eq "Running") {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }

  $state = Read-JsonFile (Join-Path $stateDir "watchdog-state.json")
  if ($state -and [int]$state.watchdogPid -gt 0) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.watchdogPid)" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq "tokens-ui-launcher.exe") {
      Stop-Process -Id ([int]$state.watchdogPid) -Force -ErrorAction SilentlyContinue
    }
  }

  if (-not $Keep -and (Test-Path -LiteralPath $tempRoot)) {
    $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $tempFull = [System.IO.Path]::GetFullPath($tempRoot)
    if (-not $tempFull.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove smoke-test path outside temp root: $tempFull"
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  } elseif ($Keep) {
    Write-Host "Kept smoke-test directory: $tempRoot"
  }
}
