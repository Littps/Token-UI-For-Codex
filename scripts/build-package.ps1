# 构建可发布的插件包（zip），默认输出到桌面。
# 只打包 DEPLOYMENT.md、.agents\、plugins\；不包含 backups / .git / node_modules / 旧压缩包。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-package.ps1 -SourceRoot "<部署根目录>" [-OutputPath "<zip 路径>"]
# 兼容 Windows PowerShell 5.1 与 PowerShell 7+（不使用仅 7+ 可解析的扩展方法调用）。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$resolvedRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$pluginJson = Join-Path $resolvedRoot "plugins\tokens-ui-for-codex\.codex-plugin\plugin.json"
if (-not (Test-Path -LiteralPath $pluginJson)) { throw "未找到插件清单: $pluginJson" }
$version = (Get-Content -Raw -LiteralPath $pluginJson | ConvertFrom-Json).version
if (-not $version) { throw "无法读取插件版本" }

if (-not $OutputPath) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $safeVersion = $version -replace "\+", "-"
  $OutputPath = Join-Path $desktop ("Tokens UI For Codex-v" + $safeVersion + ".zip")
}

# Windows PowerShell 5.1 需要同时加载这两个程序集：
#   System.IO.Compression        → ZipArchiveMode
#   System.IO.Compression.FileSystem → ZipFile / ZipFileExtensions
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$prefix = "Tokens UI For Codex/"
$files = @()
$files += Get-Item -LiteralPath (Join-Path $resolvedRoot "DEPLOYMENT.md")
$files += Get-ChildItem -LiteralPath (Join-Path $resolvedRoot ".agents") -Recurse -File -Force
$files += Get-ChildItem -LiteralPath (Join-Path $resolvedRoot "plugins") -Recurse -File -Force
foreach ($extra in @("install.bat", "install.ps1")) {
  $extraPath = Join-Path $resolvedRoot $extra
  if (Test-Path -LiteralPath $extraPath) { $files += Get-Item -LiteralPath $extraPath }
}

# 发布包只带运行所需文件与用户文档；开发源码（test/scripts/docs/.github、package.json、AGENTS.md 等）不打包。
$excluded = @(
  "\\backups\\", "\\.git\\", "\\node_modules\\",
  "\\test\\", "\\scripts\\", "\\docs\\", "\\.github\\",
  "\\package\.json$", "\\AGENTS\.md$", "\\.gitignore$", "\.bak$"
)
$files = $files | Where-Object {
  $path = $_.FullName
  -not ($excluded | Where-Object { $path -match $_ })
}

# ZipFile.Open(..., Create) 要求目标文件不存在；仅在确认位于桌面目录时才允许覆盖。
if (Test-Path -LiteralPath $OutputPath) {
  $desktopDir = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath("Desktop"))
  $fullTarget = [System.IO.Path]::GetFullPath($OutputPath)
  if (-not $fullTarget.StartsWith($desktopDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝覆盖非桌面路径的目标文件: $fullTarget"
  }
  Remove-Item -LiteralPath $fullTarget -Force
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
  version = $version
  entries = $files.Count
  sizeBytes = $item.Length
} | ConvertTo-Json -Compress
