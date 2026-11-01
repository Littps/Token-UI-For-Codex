[CmdletBinding()]
param(
  [string]$OutputDirectory = "",
  [string]$BuildDirectory = "",
  [switch]$WithoutSymbols
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Invoke-Checked {
  param(
    [string]$Label,
    [scriptblock]$Command
  )
  Write-Host ""
  Write-Host "==> $Label" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  $childFull = [System.IO.Path]::GetFullPath($Child)
  $prefix = $parentFull + [System.IO.Path]::DirectorySeparatorChar
  if (-not $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside output directory: $childFull"
  }
}

function Assert-PrivatePathsAbsent {
  param(
    [string]$Root,
    [string[]]$ForbiddenPrefixes
  )
  $latin1 = [System.Text.Encoding]::GetEncoding(28591)
  foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File) {
    $text = $latin1.GetString([System.IO.File]::ReadAllBytes($file.FullName))
    foreach ($prefix in $ForbiddenPrefixes) {
      if ($prefix -and $text.IndexOf($prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "Private build path leaked into package file: $($file.Name)"
      }
    }
  }
}

function Resolve-PdbCopy {
  $command = Get-Command "pdbcopy.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if ($programFilesX86) {
    $candidate = Get-ChildItem `
      -LiteralPath (Join-Path $programFilesX86 "Windows Kits\10\Debuggers\x64") `
      -Filter "pdbcopy.exe" `
      -File `
      -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }
  return $null
}

function Resolve-SymChk {
  $command = Get-Command "symchk.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if ($programFilesX86) {
    $candidate = Get-ChildItem `
      -LiteralPath (Join-Path $programFilesX86 "Windows Kits\10\Debuggers\x64") `
      -Filter "symchk.exe" `
      -File `
      -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }
  return $null
}

$rustRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = Split-Path -Parent $rustRoot
$licensePath = Join-Path $rustRoot "LICENSE"
if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
  $licensePath = Join-Path $repoRoot "LICENSE"
}
if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
  throw "Cannot locate LICENSE for the runtime and source packages"
}

$autoBuildDirectory = -not $BuildDirectory
if ($autoBuildDirectory) {
  if (-not $env:PUBLIC) {
    throw "PUBLIC is not set; pass -BuildDirectory to choose a non-user-specific build cache"
  }
  $BuildDirectory = Join-Path $env:PUBLIC (
    "TokensUIForCodexBuild-" + $PID + "-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
  )
}
$cargoTargetDir = [System.IO.Path]::GetFullPath($BuildDirectory)
New-Item -ItemType Directory -Path $cargoTargetDir -Force | Out-Null
$env:CARGO_TARGET_DIR = $cargoTargetDir

$encodedFlagSeparator = [char]31
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }
$privatePrefixes = @(
  @($cargoTargetDir, "/target"),
  @($rustRoot, "/rust-launcher"),
  @($repoRoot, "/workspace"),
  @($cargoHome, "/cargo-home"),
  @($env:USERPROFILE, "/home/user"),
  @($env:TEMP, "/tmp")
)
$encodedFlags = @("-C", "target-feature=+crt-static")
foreach ($mapping in $privatePrefixes) {
  if ($mapping[0]) {
    $encodedFlags += "--remap-path-prefix=$($mapping[0])=$($mapping[1])"
  }
}
if ($env:CARGO_ENCODED_RUSTFLAGS) {
  $encodedFlags = @($env:CARGO_ENCODED_RUSTFLAGS -split $encodedFlagSeparator) + $encodedFlags
}
$env:CARGO_ENCODED_RUSTFLAGS = $encodedFlags -join $encodedFlagSeparator
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $rustRoot "artifacts"
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runtimeStage = Join-Path $outputRoot (".runtime-stage-" + $PID)
$sourceStage = Join-Path $outputRoot (".source-stage-" + $PID)
Assert-ChildPath $outputRoot $runtimeStage
Assert-ChildPath $outputRoot $sourceStage

Push-Location $rustRoot
try {
  Invoke-Checked "cargo format check" { cargo fmt -- --check }
  Invoke-Checked "cargo clippy" {
    cargo clippy --all-targets --all-features -- -D warnings
  }
  Invoke-Checked "cargo tests" {
    cargo test --all-targets -- --test-threads=1
  }
  Invoke-Checked "cargo release build" { cargo build --release --locked }

  $metadataText = cargo metadata --no-deps --format-version 1
  if ($LASTEXITCODE -ne 0) {
    throw "cargo metadata failed with exit code $LASTEXITCODE"
  }
  $metadata = $metadataText | ConvertFrom-Json
  $package = @($metadata.packages | Where-Object { $_.name -eq "tokens-ui-launcher" })[0]
  if (-not $package) {
    throw "Cannot resolve tokens-ui-launcher package metadata"
  }
  $version = [string]$package.version
  $runtimeBase = "Tokens-UI-For_Codex_Rust-Launcher_${version}-Alpha"
  $sourceBase = "${runtimeBase}_Source"

  if (Test-Path -LiteralPath $runtimeStage) {
    Remove-Item -LiteralPath $runtimeStage -Recurse -Force
  }
  if (Test-Path -LiteralPath $sourceStage) {
    Remove-Item -LiteralPath $sourceStage -Recurse -Force
  }
  New-Item -ItemType Directory -Path $runtimeStage -Force | Out-Null
  New-Item -ItemType Directory -Path $sourceStage -Force | Out-Null

  $releaseDir = Join-Path $cargoTargetDir "release"
  foreach ($name in @("tokens-ui-launcher.exe", "tokens-ui-doctor.exe")) {
    $source = Join-Path $releaseDir $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Missing release binary: $source"
    }
    Copy-Item -LiteralPath $source -Destination $runtimeStage
  }
  if (-not $WithoutSymbols) {
    $pdbCopy = Resolve-PdbCopy
    if (-not $pdbCopy) {
      throw "pdbcopy.exe is required for public symbols; install Windows SDK Debugging Tools or pass -WithoutSymbols"
    }
    foreach ($name in @("tokens_ui_launcher.pdb", "tokens_ui_doctor.pdb")) {
      $source = Join-Path $releaseDir $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing release symbols: $source"
      }
      $publicPdb = Join-Path $cargoTargetDir ("public-$PID-$name")
      & $pdbCopy $source $publicPdb -p
      if ($LASTEXITCODE -ne 0) {
        throw "pdbcopy failed for $name with exit code $LASTEXITCODE"
      }
      Copy-Item -LiteralPath $publicPdb -Destination (Join-Path $runtimeStage $name) -Force
      Remove-Item -LiteralPath $publicPdb -Force
    }
  }

  foreach ($name in @(
    "README.md",
    "install-rust-launcher.ps1",
    "uninstall-rust-launcher.ps1",
    "install.cmd",
    "uninstall.cmd"
  )) {
    $source = Join-Path $rustRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Missing package file: $source"
    }
    Copy-Item -LiteralPath $source -Destination $runtimeStage
  }
  Copy-Item -LiteralPath $licensePath -Destination $runtimeStage

  $packageInfo = @(
    "Package: $runtimeBase"
    "Version: $version"
    "Built: $((Get-Date).ToUniversalTime().ToString('o'))"
    "Architecture: x86_64-pc-windows-msvc"
    "Code signing: unsigned"
    "Default runtime mode: experimental; not installed by this archive"
  )
  [System.IO.File]::WriteAllLines(
    (Join-Path $runtimeStage "PACKAGE-INFO.txt"),
    $packageInfo,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Assert-PrivatePathsAbsent -Root $runtimeStage -ForbiddenPrefixes @(
    $env:USERPROFILE,
    $rustRoot,
    $cargoHome
  )
  if (-not $WithoutSymbols) {
    $symChk = Resolve-SymChk
    if (-not $symChk) {
      throw "symchk.exe is required to validate public symbols; install Windows SDK Debugging Tools or pass -WithoutSymbols"
    }
    foreach ($name in @("tokens-ui-launcher.exe", "tokens-ui-doctor.exe")) {
      & $symChk /if (Join-Path $runtimeStage $name) /s $runtimeStage /ps /op /ot
      if ($LASTEXITCODE -ne 0) {
        throw "Public symbol validation failed for $name"
      }
    }
  }

  $hashLines = Get-ChildItem -LiteralPath $runtimeStage -File |
    Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
    Sort-Object Name |
    ForEach-Object {
      $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      "$hash  $($_.Name)"
    }
  [System.IO.File]::WriteAllText(
    (Join-Path $runtimeStage "SHA256SUMS.txt"),
    (($hashLines -join "`n") + "`n"),
    (New-Object System.Text.UTF8Encoding($false))
  )

  $runtimeZip = Join-Path $outputRoot "${runtimeBase}_$stamp.zip"
  Compress-Archive -Path (Join-Path $runtimeStage "*") -DestinationPath $runtimeZip -CompressionLevel Optimal

  $sourceProjectDir = Join-Path $sourceStage $sourceBase
  New-Item -ItemType Directory -Path $sourceProjectDir -Force | Out-Null
  foreach ($name in @(
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    ".gitignore",
    "README.md"
  )) {
    Copy-Item -LiteralPath (Join-Path $rustRoot $name) -Destination $sourceProjectDir
  }
  Copy-Item -LiteralPath (Join-Path $rustRoot ".cargo") -Destination $sourceProjectDir -Recurse
  foreach ($name in @("src", "tests")) {
    Copy-Item -LiteralPath (Join-Path $rustRoot $name) -Destination $sourceProjectDir -Recurse
  }
  foreach ($name in @(
    "build-and-package.ps1",
    "build.cmd",
    "install-rust-launcher.ps1",
    "uninstall-rust-launcher.ps1",
    "install.cmd",
    "uninstall.cmd"
  )) {
    Copy-Item -LiteralPath (Join-Path $rustRoot $name) -Destination $sourceProjectDir
  }
  Copy-Item -LiteralPath $licensePath -Destination $sourceProjectDir
  Assert-PrivatePathsAbsent -Root $sourceStage -ForbiddenPrefixes @(
    $env:USERPROFILE,
    $rustRoot,
    $cargoHome
  )

  $sourceZip = Join-Path $outputRoot "${sourceBase}_$stamp.zip"
  Compress-Archive -Path $sourceProjectDir -DestinationPath $sourceZip -CompressionLevel Optimal

  $runtimeHash = (Get-FileHash -LiteralPath $runtimeZip -Algorithm SHA256).Hash.ToLowerInvariant()
  $sourceHash = (Get-FileHash -LiteralPath $sourceZip -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host ""
  Write-Host "Runtime package: $runtimeZip" -ForegroundColor Green
  Write-Host "Runtime SHA256:  $runtimeHash"
  Write-Host "Source package:  $sourceZip" -ForegroundColor Green
  Write-Host "Source SHA256:   $sourceHash"
} finally {
  Pop-Location
  foreach ($stage in @($runtimeStage, $sourceStage)) {
    if (Test-Path -LiteralPath $stage) {
      Assert-ChildPath $outputRoot $stage
      Remove-Item -LiteralPath $stage -Recurse -Force
    }
  }
  if ($autoBuildDirectory -and (Test-Path -LiteralPath $cargoTargetDir)) {
    $publicRoot = [System.IO.Path]::GetFullPath($env:PUBLIC).TrimEnd(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    )
    $buildFull = [System.IO.Path]::GetFullPath($cargoTargetDir)
    $buildPrefix = $publicRoot + [System.IO.Path]::DirectorySeparatorChar
    if (
      $buildFull.StartsWith($buildPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $buildFull).StartsWith("TokensUIForCodexBuild-", [System.StringComparison]::Ordinal)
    ) {
      Remove-Item -LiteralPath $buildFull -Recurse -Force
    }
  }
}
