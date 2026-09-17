# Tokens UI For Codex —— 自动安装脚本（Windows）
#
# 用法：
#   install.bat                     双击即可（优先使用 pwsh 7，没有则用 Windows PowerShell 5.1）
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# 可选参数：
#   -SkipAutostart   不安装“登录自启守护”（默认会安装）
#   -SkipPlugin      跳过 Codex 插件注册（只安装用户脚本）

[CmdletBinding()]
param(
  [switch]$SkipAutostart,
  [switch]$SkipPlugin
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pluginRoot = Join-Path $root "plugins\tokens-ui-for-codex"
$marketplaceFile = Join-Path $root ".agents\plugins\marketplace.json"
$panelSource = Join-Path $pluginRoot "codex-token-spend-panel.js"
$statsScript = Join-Path $pluginRoot "token-stats.mjs"
$userScripts = Join-Path $env:APPDATA "Codex++\user_scripts"
$userScriptTarget = Join-Path $userScripts "codex-token-spend-panel.js"

function Write-Step { param([string]$Text) Write-Host ("`n== " + $Text) -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host ("   [OK] " + $Text) -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host ("   [提示] " + $Text) -ForegroundColor Yellow }
function Write-Bad { param([string]$Text) Write-Host ("   [错误] " + $Text) -ForegroundColor Red }

$blocking = @()

Write-Host "Tokens UI For Codex 安装程序" -ForegroundColor White
Write-Host ("包目录: " + $root)

Write-Step "1/5 检查运行环境"

if ($env:OS -ne "Windows_NT") { $blocking += "当前系统不是 Windows，本插件只支持 Windows。" }
else { Write-Ok "操作系统：Windows" }

if (-not (Test-Path -LiteralPath $panelSource)) { $blocking += "缺少用户脚本：$panelSource" }
else { Write-Ok "用户脚本存在" }

if (-not (Test-Path -LiteralPath $statsScript)) { $blocking += "缺少监控脚本：$statsScript" }
else { Write-Ok "监控脚本存在" }

$node = Get-Command node -ErrorAction SilentlyContinue
$nodeMajor = 0
$versionText = ""
if ($node) {
  try {
    $versionText = (& $node.Source --version) -replace "^v", ""
    $nodeMajor = [int]($versionText.Split(".")[0])
  } catch { $nodeMajor = 0 }
}
if ($nodeMajor -ge 22) {
  Write-Ok ("Node.js v" + $versionText + "（满足 CDP 模式要求）")
} else {
  $exeFallback = Join-Path $pluginRoot "exe-version\ccm-token-spend.exe"
  if (Test-Path -LiteralPath $exeFallback) {
    Write-Note "未检测到 Node.js 22+，将使用包内内置运行时 exe。"
  } else {
    $blocking += "运行时缺失：未检测到 Node.js 22+，且包内没有 exe-version\ccm-token-spend.exe；监控无法启动。"
  }
}

if (Test-Path -LiteralPath $userScripts) {
  Write-Ok ("Codex++ 用户脚本目录：" + $userScripts)
} else {
  Write-Note ("未检测到 Codex++ 用户脚本目录：" + $userScripts)
  Write-Note "请先安装 Codex++（否则统计条无法注入）。脚本会继续完成其余步骤。"
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) { Write-Ok ("codex 命令：" + $codex.Source) } else { Write-Note "未找到 codex 命令；将跳过插件注册（仅安装用户脚本）。" }

if ($blocking.Count -gt 0) {
  Write-Step "安装中止"
  foreach ($item in $blocking) { Write-Bad $item }
  exit 1
}

Write-Step "2/5 安装 Codex++ 用户脚本"
if (Test-Path -LiteralPath $userScripts) {
  if (Test-Path -LiteralPath $userScriptTarget) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -LiteralPath $userScriptTarget -Destination ($userScriptTarget + ".before-install-" + $stamp + ".bak") -Force
    Write-Note "已备份原用户脚本"
  }
  Copy-Item -LiteralPath $panelSource -Destination $userScriptTarget -Force
  $hashSource = (Get-FileHash -LiteralPath $panelSource -Algorithm SHA256).Hash
  $hashTarget = (Get-FileHash -LiteralPath $userScriptTarget -Algorithm SHA256).Hash
  if ($hashSource -eq $hashTarget) { Write-Ok "用户脚本已安装并校验一致（SHA-256）" }
  else { Write-Bad "用户脚本哈希不一致，请重新复制。"; exit 1 }
} else {
  Write-Note "跳过：未安装 Codex++。安装 Codex++ 后请重新运行本脚本。"
}

Write-Step "3/5 注册 Codex 本地插件"
if ($SkipPlugin -or -not $codex) {
  Write-Note "已跳过插件注册。"
} else {
  $marketplaceName = "tokens-ui-for-codex-local"
  if (Test-Path -LiteralPath $marketplaceFile) {
    $marketName = (Get-Content -Raw -LiteralPath $marketplaceFile | ConvertFrom-Json).name
    if ($marketName) { $marketplaceName = $marketName }
  }
  $addOutput = & $codex.Source plugin marketplace add $root 2>&1
  ($addOutput | Out-String).Trim() -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host ("   " + $_.Trim()) } }
  $installOutput = & $codex.Source plugin add ("tokens-ui-for-codex@" + $marketplaceName) 2>&1
  ($installOutput | Out-String).Trim() -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Host ("   " + $_.Trim()) } }
  $listOutput = (& $codex.Source plugin list 2>&1 | Out-String)
  if ($listOutput -match "tokens-ui-for-codex@") { Write-Ok "插件已安装并启用" }
  else { Write-Note "未在 plugin list 中确认到插件，请手动执行：codex plugin list" }
}

Write-Step "4/5 安装登录自启守护"
if ($SkipAutostart) {
  Write-Note "已跳过（-SkipAutostart）。可稍后运行 install-autostart.ps1。"
} else {
  $autostart = Join-Path $pluginRoot "install-autostart.ps1"
  if (Test-Path -LiteralPath $autostart) {
    try {
      $preferPwsh = Get-Command pwsh -ErrorAction SilentlyContinue
      if ($preferPwsh) { & $preferPwsh.Source -NoProfile -ExecutionPolicy Bypass -File $autostart }
      else { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $autostart }
      Write-Ok "自启守护已安装（随 Codex 启停监控）"
    } catch {
      Write-Note ("自启安装未完成：" + $_.Exception.Message)
      Write-Note ("可手动运行：powershell -ExecutionPolicy Bypass -File `"" + $autostart + "`"")
    }
  } else {
    Write-Note "未找到 install-autostart.ps1，跳过。"
  }
}

Write-Step "5/5 完成"
Write-Host "后续步骤：" -ForegroundColor White
Write-Host "   1) 完全退出并重新打开 Codex 桌面版，让用户脚本注入页面。"
Write-Host "   2) 输入区底部、上下文用量圆圈左侧应出现 Token 统计条。"
Write-Host "   3) 左键单击统计条可打开详情；点击弹层外部或右上角 × 关闭。"
Write-Host "   4) 如未安装自启，可手动启动监控："
Write-Host ("      node `"" + $statsScript + "`" --watch --cdp")
Write-Host ""
Write-Host "卸载：运行 uninstall-autostart.ps1，并执行 codex plugin remove tokens-ui-for-codex@tokens-ui-for-codex-local" -ForegroundColor DarkGray
exit 0
