# 构建「源码发布包」（GitHub 源码发布用 zip）。
# 与 scripts\build-package.ps1（部署包构建器，要求部署布局）互不影响：这里打包的是仓库源码本身。
#
# 用法（本地，默认输出到桌面）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-source-package.ps1
# 用法（CI / 自定义）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-source-package.ps1 -RepoRoot "<仓库根>" -OutputPath "<zip 路径>" [-Label <版本或日期>]
# 兼容 Windows PowerShell 5.1 与 PowerShell 7+。

[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [string]$OutputPath = "",
  [string]$Label = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
}
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

# 必需文件（缺任一即中止，避免打出残缺包）
foreach ($required in @("README.md", "LICENSE", "package.json", "token-stats.mjs", "codex-token-spend-panel.js")) {
  $requiredPath = Join-Path $resolvedRoot $required
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "缺少文件: $requiredPath" }
}

if (-not $Label) { $Label = Get-Date -Format "yyyyMMdd" }
if (-not $OutputPath) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $OutputPath = Join-Path $desktop ("Tokens UI For Codex-Source-" + $Label + ".zip")
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# 排除：版本库、备份、依赖、构建产物、日志与临时文件；以及本脚本自己的产物。
$prefix = "Tokens UI For Codex-Source/"
$excludeDirNames = @(".git", "backups", "node_modules", "dist", "build", "release")
$excludeFilePatterns = @("*.bak", "*.log", "*.tmp", "Tokens UI For Codex-Source-*.zip")

$files = Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File -Force | Where-Object {
  $relative = $_.FullName.Substring($resolvedRoot.Length).TrimStart("\")
  $parts = $relative -split "\\"
  if ($parts.Length -gt 1) {
    foreach ($dirName in $parts[0..($parts.Length - 2)]) {
      if ($excludeDirNames -contains $dirName) { return $false }
    }
  }
  foreach ($pattern in $excludeFilePatterns) {
    if ($_.Name -like $pattern) { return $false }
  }
  return $true
}

if (-not $files -or $files.Count -eq 0) { throw "没有可打包的文件: $resolvedRoot" }

# ZipFile.Open(..., Create) 要求目标不存在；只允许覆盖本脚本自己的产物。
if (Test-Path -LiteralPath $OutputPath) {
  $targetName = Split-Path -Leaf $OutputPath
  if ($targetName -notlike "Tokens UI For Codex-Source-*.zip") {
    throw "拒绝覆盖非源码包文件: $OutputPath"
  }
  Remove-Item -LiteralPath $OutputPath -Force
}

$archive = [System.IO.Compression.ZipFile]::Open($OutputPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($resolvedRoot.Length).TrimStart("\") -replace "\\", "/"
    $entry = $archive.CreateEntry($prefix + $relative, [System.IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    $fileStream = [System.IO.File]::OpenRead($file.FullName)
    try {
      $fileStream.CopyTo($entryStream)
    } finally {
      $fileStream.Dispose()
      $entryStream.Dispose()
    }
  }
} finally {
  $archive.Dispose()
}

$item = Get-Item -LiteralPath $OutputPath
[ordered]@{
  output = $item.FullName
  label = $Label
  root = $resolvedRoot
  entries = $files.Count
  sizeBytes = $item.Length
} | ConvertTo-Json -Compress
