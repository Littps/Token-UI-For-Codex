[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory = $true)]
  [string]$PluginRoot,
  [string]$TaskName = "tokens-ui-for-codex-monitor",
  [int]$StartupTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Resolve-FullPath {
  param(
    [string]$Value,
    [string]$BaseDirectory
  )
  if (-not $Value) {
    return ""
  }
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BaseDirectory $Value))
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json)
}

function Test-PackageHashes {
  param([string]$Root)
  $manifest = Join-Path $Root "SHA256SUMS.txt"
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    Write-Warning "SHA256SUMS.txt is missing; package integrity cannot be verified"
    return
  }
  foreach ($line in Get-Content -LiteralPath $manifest -Encoding UTF8) {
    if (-not $line.Trim()) {
      continue
    }
    $match = [regex]::Match($line, "^([0-9a-fA-F]{64})\s{2}(.+)$")
    if (-not $match.Success) {
      throw "Invalid SHA256SUMS.txt line: $line"
    }
    $file = Join-Path $Root $match.Groups[2].Value
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "Package file is missing: $file"
    }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($file)
    try {
      $actual = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $stream.Dispose()
      $sha256.Dispose()
    }
    if ($actual -ne $match.Groups[1].Value.ToLowerInvariant()) {
      throw "SHA-256 mismatch: $file"
    }
  }
}

function Get-RuntimePaths {
  param([string]$Root)
  $configPath = Join-Path $Root "runtime-paths.json"
  $config = Read-JsonFile $configPath
  $codexHome = if ($env:TUI_CODEX_HOME) {
    $env:TUI_CODEX_HOME
  } elseif ($env:CODEX_HOME) {
    $env:CODEX_HOME
  } elseif ($config -and $config.codexHome) {
    [string]$config.codexHome
  } else {
    Join-Path $env:USERPROFILE ".codex"
  }
  $codexHome = Resolve-FullPath $codexHome $Root
  $base = Join-Path $codexHome "tokens-ui-for-codex"
  $stateDir = if ($config -and $config.stateDir) {
    Resolve-FullPath ([string]$config.stateDir) $Root
  } else {
    Join-Path $base "state"
  }
  $heartbeatFile = if ($config -and $config.heartbeatFile) {
    Resolve-FullPath ([string]$config.heartbeatFile) $Root
  } else {
    Join-Path $stateDir "monitor-heartbeat.json"
  }
  [pscustomobject]@{
    codexHome = $codexHome
    stateDir = $stateDir
    heartbeatFile = $heartbeatFile
    watchdogStateFile = Join-Path $stateDir "watchdog-state.json"
  }
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) {
    return $false
  }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
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
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw $FailureMessage
}

function Stop-ExistingMonitor {
  param(
    [string]$Root,
    [object]$Paths
  )
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task -and [string]$task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $TaskName
    Wait-Until -TimeoutSeconds 15 -FailureMessage "Scheduled task $TaskName did not stop" -Condition {
      $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      return (-not $current -or [string]$current.State -ne "Running")
    }
  }

  $watchdogScript = Join-Path $Root "monitor-watchdog.ps1"
  $watchdogProcesses = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.IndexOf($watchdogScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
  foreach ($process in $watchdogProcesses) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
  }

  $heartbeat = Read-JsonFile $Paths.heartbeatFile
  if ($heartbeat -and [int]$heartbeat.pid -gt 0 -and (Test-ProcessAlive ([int]$heartbeat.pid))) {
    $monitor = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$heartbeat.pid)" -ErrorAction SilentlyContinue
    $expectedScript = Join-Path $Root "token-stats.mjs"
    $identityValid = (
      $monitor -and
      $monitor.Name -eq "node.exe" -and
      $monitor.CommandLine -and
      $monitor.CommandLine.IndexOf($expectedScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    )
    if (-not $identityValid) {
      throw "Heartbeat PID $([int]$heartbeat.pid) does not match the expected Node monitor; refusing to stop it"
    }
    Stop-Process -Id ([int]$heartbeat.pid) -Force -ErrorAction Stop
    Wait-Until -TimeoutSeconds 15 -FailureMessage "Existing Node monitor did not stop" -Condition {
      return -not (Test-ProcessAlive ([int]$heartbeat.pid))
    }
  }
}

function Restore-PreviousTask {
  param(
    [string]$BackupXml,
    [string]$User
  )
  $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($current) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  if ($BackupXml -and (Test-Path -LiteralPath $BackupXml -PathType Leaf)) {
    $xml = Get-Content -Raw -Encoding UTF8 -LiteralPath $BackupXml
    Register-ScheduledTask -TaskName $TaskName -Xml $xml -User $User -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
  }
}

$pluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$packageRoot = $PSScriptRoot
Test-PackageHashes $packageRoot
$launcherSource = Join-Path $packageRoot "tokens-ui-launcher.exe"
$doctorSource = Join-Path $packageRoot "tokens-ui-doctor.exe"
$readmeSource = Join-Path $packageRoot "README.md"
$licenseSource = Join-Path $packageRoot "LICENSE"
$packageInfoSource = Join-Path $packageRoot "PACKAGE-INFO.txt"
$statsScript = Join-Path $pluginRoot "token-stats.mjs"
$runtimeConfig = Join-Path $pluginRoot "runtime-paths.json"
foreach ($required in @(
  $launcherSource,
  $doctorSource,
  $readmeSource,
  $licenseSource,
  $packageInfoSource,
  $statsScript,
  $runtimeConfig
)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required file is missing: $required"
  }
}

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
  throw "Task Scheduler cmdlets are unavailable"
}

$paths = Get-RuntimePaths $pluginRoot
$installRoot = Join-Path $pluginRoot "rust-launcher"
$installBin = Join-Path $installRoot "bin"
$launcherPath = Join-Path $installBin "tokens-ui-launcher.exe"
$doctorPath = Join-Path $installBin "tokens-ui-doctor.exe"
$backupRoot = Join-Path $paths.stateDir "rust-launcher-backup"
$backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $backupRoot $backupStamp
$backupTaskXml = Join-Path $backupDir "task-$TaskName.xml"
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not $PSCmdlet.ShouldProcess($pluginRoot, "Stop the current monitor and install the Rust launcher")) {
  return
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $backupTaskXml -Encoding UTF8
}

$installed = $false
try {
  Stop-ExistingMonitor -Root $pluginRoot -Paths $paths
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $installBin -Force | Out-Null
  Copy-Item -LiteralPath $launcherSource -Destination $launcherPath -Force
  Copy-Item -LiteralPath $doctorSource -Destination $doctorPath -Force
  Copy-Item -LiteralPath $readmeSource -Destination (Join-Path $installRoot "README.md") -Force
  Copy-Item -LiteralPath $licenseSource -Destination (Join-Path $installRoot "LICENSE") -Force
  Copy-Item -LiteralPath $packageInfoSource -Destination (Join-Path $installRoot "PACKAGE-INFO.txt") -Force
  foreach ($name in @("tokens_ui_launcher.pdb", "tokens_ui_doctor.pdb")) {
    $pdb = Join-Path $packageRoot $name
    if (Test-Path -LiteralPath $pdb -PathType Leaf) {
      Copy-Item -LiteralPath $pdb -Destination $installBin -Force
    }
  }

  $action = New-ScheduledTaskAction `
    -Execute $launcherPath `
    -Argument "--supervise --plugin-root `"$pluginRoot`"" `
    -WorkingDirectory $pluginRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  Wait-Until -TimeoutSeconds $StartupTimeoutSeconds -FailureMessage "Rust launcher did not become healthy" -Condition {
    $state = Read-JsonFile $paths.watchdogStateFile
    return (
      $state -and
      $state.watchdogPid -and
      [string]$state.launcherPath -eq $launcherPath -and
      [string]$state.phase -eq "healthy"
    )
  }
  $installed = $true

  $diagnosis = & $doctorPath --diagnose --plugin-root $pluginRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Doctor validation failed with exit code $LASTEXITCODE"
  }
  Write-Host "Rust launcher installed." -ForegroundColor Green
  Write-Host "Backup: $backupDir"
  Write-Host $diagnosis
} catch {
  Write-Warning "Installation failed; attempting to restore the previous scheduled task"
  Restore-PreviousTask -BackupXml $backupTaskXml -User $user
  if (-not $installed) {
    throw
  }
}
