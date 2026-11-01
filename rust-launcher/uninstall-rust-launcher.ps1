[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory = $true)]
  [string]$PluginRoot,
  [string]$TaskName = "tokens-ui-for-codex-monitor",
  [bool]$RestorePreviousTask = $true,
  [switch]$Full
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

function Get-RuntimePaths {
  param([string]$Root)
  $config = Read-JsonFile (Join-Path $Root "runtime-paths.json")
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
  [pscustomobject]@{
    stateDir = $stateDir
    watchdogStateFile = Join-Path $stateDir "watchdog-state.json"
  }
}

function Stop-RustSupervisor {
  param([string]$StateFile)
  $state = Read-JsonFile $StateFile
  if (-not $state -or [int]$state.watchdogPid -le 0) {
    return
  }
  $pidValue = [int]$state.watchdogPid
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
  if (-not $process) {
    return
  }
  if ($process.Name -ne "tokens-ui-launcher.exe") {
    throw "Refusing to stop unexpected watchdog process $pidValue ($($process.Name))"
  }
  Stop-Process -Id $pidValue -Force
  $deadline = (Get-Date).AddSeconds(15)
  do {
    if ($null -eq (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Rust launcher process $pidValue did not stop"
}

$pluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$paths = Get-RuntimePaths $pluginRoot
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$backupRoot = Join-Path $paths.stateDir "rust-launcher-backup"
$installRoot = Join-Path $pluginRoot "rust-launcher"

if (-not $PSCmdlet.ShouldProcess($pluginRoot, "Stop the Rust launcher and restore the previous startup mode")) {
  return
}

$currentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($currentTask -and [string]$currentTask.State -eq "Running") {
  Stop-ScheduledTask -TaskName $TaskName
}
Stop-RustSupervisor -StateFile $paths.watchdogStateFile

if ($currentTask) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$restored = $false
if ($RestorePreviousTask -and (Test-Path -LiteralPath $backupRoot -PathType Container)) {
  $latestBackup = Get-ChildItem -LiteralPath $backupRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if ($latestBackup) {
    $taskXml = Join-Path $latestBackup.FullName "task-$TaskName.xml"
    if (Test-Path -LiteralPath $taskXml -PathType Leaf) {
      $xml = Get-Content -Raw -Encoding UTF8 -LiteralPath $taskXml
      Register-ScheduledTask -TaskName $TaskName -Xml $xml -User $user -Force | Out-Null
      Start-ScheduledTask -TaskName $TaskName
      $restored = $true
    }
  }
}

if ($Full) {
  if (Test-Path -LiteralPath $installRoot -PathType Container) {
    $pluginPrefix = $pluginRoot.TrimEnd(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    $installFull = [System.IO.Path]::GetFullPath($installRoot)
    if (-not $installFull.StartsWith($pluginPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove path outside plugin root: $installFull"
    }
    Remove-Item -LiteralPath $installRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $backupRoot -PathType Container) {
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
  }
}

if ($restored) {
  Write-Host "Rust launcher removed; previous scheduled task restored." -ForegroundColor Green
} else {
  Write-Warning "Rust launcher removed; no previous scheduled task backup was restored."
}
