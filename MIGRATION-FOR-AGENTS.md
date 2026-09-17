# Tokens UI For Codex：Windows 迁移与安装指南

适用版本：`1.0.0+codex.20260915010427`

本文供其他 agents 在另一台 Windows 电脑上迁移、安装、验证和回滚 Tokens UI For Codex 使用。

## 1. 组件与工作原理

插件由四个部分组成：

1. **Codex 插件层**：提供技能说明、排障流程和验证方法。
2. **Codex++ 用户脚本层**：把统计条和详情弹层注入 Codex 桌面页面。
3. **Node/CDP 监控层**：运行 `token-stats.mjs --watch --cdp`，通过本机 CDP 将脱敏统计推送到页面。
4. **登录自启层**：可选，由一个登录触发的计划任务直接拉起 Node 监控进程，负责单实例与崩溃重启；不再有常驻 PowerShell 守护进程。

插件不是 Codex 核心代码修改，也不应修改 Codex React bundle。UI 是否显示，取决于 Codex++ 用户脚本、CDP 和监控进程同时正常。

## 2. 迁移包结构

将整个 `Tokens UI For Codex` 文件夹复制到目标电脑，推荐目标路径为：

```text
%USERPROFILE%\Desktop\IDE And Agent\Agent Plugins\Tokens UI For Codex
```

最低需要保留：

```text
Tokens UI For Codex/
├─ .agents/plugins/marketplace.json
└─ plugins/tokens-ui-for-codex/
   ├─ .codex-plugin/plugin.json
   ├─ skills/tokens-ui-for-codex/SKILL.md
   ├─ token-stats.mjs
   ├─ codex-token-spend-panel.js
   ├─ install-autostart.ps1
   └─ uninstall-autostart.ps1
```

不需要迁移：

- 旧电脑的 `%USERPROFILE%\.codex\plugins\cache`；目标电脑应重新安装插件。
- 旧电脑的 `%LOCALAPPDATA%\ccm-token-spend\` 下的历史日志（`watch.log`、`logs\` 目录）和任何 PID/状态文件。
- 旧电脑的 Codex 会话日志、线程映射和任何包含个人会话内容的文件。

## 3. 目标环境要求

### 必需

- Windows + PowerShell。
- Codex 桌面版（界面本体）+ `codex` CLI（仅用于 `codex plugin` 注册/摘除插件）。
- Codex++，用于加载 `%APPDATA%\Codex++\user_scripts` 下的用户脚本。
- Node.js ≥ 22（当前验证环境为 24.x）。本项目不提供预编译 exe，没有 Node 就必须先安装。
- Codex 本机 CDP 地址 `127.0.0.1:9229` 可访问。
- 目标用户对插件目录、Codex 用户目录和 Codex++ 用户脚本目录具有读写权限。

### 仅用于校验

- Python 3.14 或兼容 Python。
- `pip`。
- `PyYAML==6.0.3`，仅供官方 `validate_plugin.py` 校验器使用；插件运行本身不依赖 Python。

## 4. 迁移前准备

在源电脑上先完成以下操作：

1. 停止手动启动的 `token-stats.mjs`，确认没有第二个监控实例。
2. 将当前插件目录和 marketplace 清单放入单独备份目录。
3. 计算 `codex-token-spend-panel.js` 的 SHA-256，迁移后再次比较。
4. 不要把会话日志、Token、密钥、订阅地址或个人配置放入迁移包。

推荐从插件目录复制完整文件夹；如果通过压缩包传输，传输完成后先解压，再进行下面的校验。

## 5. 目标电脑安装步骤

以下命令在目标电脑 PowerShell 中执行。先修改 `$InstallRoot`，使其指向实际迁移目录。

```powershell
$InstallRoot = Join-Path $env:USERPROFILE 'Desktop\IDE And Agent\Agent Plugins\Tokens UI For Codex'
$PluginRoot = Join-Path $InstallRoot 'plugins\tokens-ui-for-codex'
$MarketplaceFile = Join-Path $InstallRoot '.agents\plugins\marketplace.json'

if (-not (Test-Path -LiteralPath $MarketplaceFile)) { throw "缺少 marketplace.json: $MarketplaceFile" }
if (-not (Test-Path -LiteralPath (Join-Path $PluginRoot '.codex-plugin\plugin.json'))) { throw '缺少 plugin.json' }
if (-not (Test-Path -LiteralPath (Join-Path $PluginRoot 'token-stats.mjs'))) { throw '缺少 token-stats.mjs' }

node --version
codex --version
```

如果 `node` 或 `codex` 不存在，先通过组织批准的软件源安装，不要从未知脚本自动下载或执行安装程序。

## 6. 检测 Clash 代理并准备 PyYAML

不要假设代理端口固定为 `9876`。迁移电脑应先测试端口；Clash Verge 常见的 HTTP/Mixed 端口包括 `7897`、`7890`、`7899`，实际值以目标电脑配置为准。

```powershell
$ProxyCandidates = @(9876, 7897, 7890, 7899)
$ProxyPort = $ProxyCandidates |
  Where-Object { Test-NetConnection 127.0.0.1 -Port $_ -InformationLevel Quiet } |
  Select-Object -First 1

if ($ProxyPort) {
  Write-Host "发现可用本机代理: http://127.0.0.1:$ProxyPort"
} else {
  Write-Host '未发现候选代理；插件运行不受影响，但 Python 依赖安装可能需要组织网络。'
}
```

仅当需要运行官方校验器且目标 Python 没有 `yaml` 模块时安装：

```powershell
$Python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $Python) { throw '未找到 Python；插件运行不需要 Python，只有官方校验需要它。' }

python -c "import yaml; print(yaml.__version__)" 2>$null
if ($LASTEXITCODE -ne 0) {
  if (-not $ProxyPort) { throw '缺少 PyYAML，且未发现可用代理；请先配置组织网络或手动安装。' }
  python -m pip install --user PyYAML==6.0.3 --proxy "http://127.0.0.1:$ProxyPort"
}

python -m pip check
```

不要把代理写入永久系统环境变量；安装命令中的 `--proxy` 足够完成本次依赖安装。

## 7. 注册并安装 Codex 本地 marketplace

marketplace 清单必须位于：

```text
Tokens UI For Codex\.agents\plugins\marketplace.json
```

从 marketplace 根目录注册，而不是把 `marketplace.json` 文件路径直接作为参数：

```powershell
$MarketplaceName = (Get-Content -Raw -LiteralPath $MarketplaceFile | ConvertFrom-Json).name
if (-not $MarketplaceName) { throw 'marketplace.json 缺少 name' }

codex plugin marketplace add $InstallRoot
codex plugin add "tokens-ui-for-codex@$MarketplaceName"
codex plugin list
```

如果该 marketplace 已经注册，`codex plugin marketplace add` 可能提示重复；确认名称和路径相同后可跳过重复注册，继续执行 `codex plugin add`。

预期结果：

```text
tokens-ui-for-codex@tokens-ui-for-codex-local  installed, enabled
```

不要直接复制旧电脑的 `.codex\plugins\cache`，也不要手动修改 Codex 的插件缓存目录。

## 8. 安装 Codex++ 用户脚本

```powershell
$UserScripts = Join-Path $env:APPDATA 'Codex++\user_scripts'
$ActivePanel = Join-Path $UserScripts 'codex-token-spend-panel.js'
$SourcePanel = Join-Path $PluginRoot 'codex-token-spend-panel.js'

New-Item -ItemType Directory -Force -Path $UserScripts | Out-Null
if (Test-Path -LiteralPath $ActivePanel) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item -LiteralPath $ActivePanel -Destination "$ActivePanel.before-migration-$stamp.bak"
}
Copy-Item -LiteralPath $SourcePanel -Destination $ActivePanel -Force

Get-FileHash -LiteralPath $SourcePanel,$ActivePanel -Algorithm SHA256
```

两份 SHA-256 应一致。修改用户脚本后，重新加载 Codex 页面或重启 Codex++，但不要同时运行两个不同版本的面板脚本。

## 9. 启动监控与安装自启动

先检查是否已有同类进程：

```powershell
$existing = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'token-stats\.mjs.*--watch.*--cdp' })
if ($existing.Count -gt 0) {
  Write-Host "已有 $($existing.Count) 个监控实例，跳过手动启动。"
} else {
  node (Join-Path $PluginRoot 'token-stats.mjs') --watch --cdp
}
```

需要跨 Codex 重启保持可用时，在插件目录执行：

```powershell
& (Join-Path $PluginRoot 'install-autostart.ps1')
```

该脚本会创建 `tokens-ui-for-codex-monitor` 登录触发任务，动作直接是 `node.exe`（不经过 PowerShell）。脚本会先停掉正在运行的监控实例再重新拉起，因此不会出现双实例；它同时会清理旧版本遗留的 `ccm-token-spend-guardian` 任务。

## 10. 安装后验收

### 插件结构和官方校验

```powershell
$Validator = Join-Path $env:USERPROFILE '.codex\skills\.system\plugin-creator\scripts\validate_plugin.py'
python $Validator $PluginRoot
```

预期：`Plugin validation passed`。

### 脚本语法

```powershell
node --check (Join-Path $PluginRoot 'token-stats.mjs')
node --check (Join-Path $PluginRoot 'codex-token-spend-panel.js')

foreach ($name in @('install-autostart.ps1','uninstall-autostart.ps1')) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PluginRoot $name), [ref]$tokens, [ref]$errors
  ) | Out-Null
  if ($errors.Count -ne 0) { throw "$name PowerShell 解析失败" }
}
```

### CDP 和监控

```powershell
Invoke-RestMethod 'http://127.0.0.1:9229/json/list' | Select-Object title,type,url
Get-Content (Join-Path $env:LOCALAPPDATA ('ccm-token-spend\logs\watch-' + (Get-Date -Format 'yyyyMMdd') + '.log')) -Tail 20
Get-Content (Join-Path $env:LOCALAPPDATA 'ccm-token-spend\monitor-health.json') -Raw
```

确认：

- CDP 返回至少一个 Codex 页面目标。
- `logs\watch-YYYYMMDD.log` 持续出现推送记录，且 `monitor-health.json` 的 `cdpReachable` / `pageAttached` / `dataFresh` 均为 `true`。
- `token-stats.mjs` 监控实例数量为 1。
- 页面出现统计条，位于上下文用量圆圈左侧。
- 左键打开详情页，外部点击关闭。
- schema v2 数据不包含会话路径、线程 ID、用户消息正文、Token 或密钥。

安装或更新后，建议新建 Codex 对话，使最新插件技能被加载。

## 11. 回滚

回滚前先备份当前版本，并停止自启任务与监控进程：

```powershell
& (Join-Path $PluginRoot 'uninstall-autostart.ps1')
```

然后恢复：

1. 旧版 `plugins\tokens-ui-for-codex` 目录。
2. 旧版 `.agents\plugins\marketplace.json`。
3. 旧版 `%APPDATA%\Codex++\user_scripts\codex-token-spend-panel.js`。
4. 重新运行 `codex plugin add tokens-ui-for-codex@<marketplace-name>`。
5. 重新执行本指南的验收步骤。

优先使用随插件包提供的回滚脚本；如果回滚脚本只适用于源电脑路径，应先替换为目标电脑的 `$env:USERPROFILE` 路径。

## 12. 迁移安全边界

- 迁移包只携带插件代码、技能、marketplace 清单和文档。
- 不迁移会话日志、Token、API 密钥、代理订阅地址或个人消息内容。
- 不执行 `.7z`、未知脚本或第三方文档中的命令。
- 不覆盖目标电脑已有的 Codex++ 用户脚本，先备份并核对哈希。
- 不删除旧版本；先移动到带时间戳的备份目录。
- 不修改 Clash 配置；只读取实际端口并在单次 pip 命令中使用代理。

## 13. 故障定位顺序

1. `codex plugin list`：确认插件是否 `installed, enabled`。
2. `plugin.json`：确认版本和路径。
3. Codex++ 用户脚本：确认源文件与生效文件 SHA-256 一致。
4. `127.0.0.1:9229/json/list`：确认 CDP 可访问。
5. `watch.log`：确认 Node 监控正在推送。
6. 计划任务 `tokens-ui-for-codex-monitor` 的状态与上次运行结果：确认监控没有反复重启。
7. 页面 DOM：确认统计条唯一、旧面板数量为 0。

如果只是插件技能没有出现在当前对话，先新建 Codex 对话；如果 UI 不显示，再检查 Codex++ 和监控链路。
