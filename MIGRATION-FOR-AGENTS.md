# Tokens UI For Codex 跨电脑迁移指南

面向 Agent 与手动操作者。目标是把当前有效版本迁移到另一台 Windows 电脑，
同时避免带入旧机器的会话映射、日志和插件 cache 污染。

作者：**Littps**

## 1. 目标电脑依赖

| 依赖 | 检查 | 不满足时 |
| --- | --- | --- |
| Windows 10 22H2 / 11 | `[Environment]::OSVersion` | 不支持 |
| Codex / ChatGPT 桌面版 | `Get-AppxPackage -Name "*Codex*"` 或 `ChatGPT.exe` | 先安装 |
| Codex++ | `codex-plus-plus.exe` 或常见安装目录 | 先安装 |
| Codex++ 用户脚本已启用 | 只读检查 `user_scripts.json` 的 `enabled` | 在 Codex++ 设置中开启 |
| Node.js 22+ | `node --version`，或 Codex 自带运行时 | 安装 Node 22+ |
| PowerShell 5.1+ | `powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion"` | 修复系统 PowerShell |

无需单独安装 Node：Codex 桌面版自带运行时可由 `find-codex.ps1` 自动发现。

## 2. 应迁移什么

推荐迁移完整部署目录：

```text
Tokens UI For Codex/
├─ install.bat
├─ install.ps1
├─ DEPLOYMENT.md
├─ .agents/plugins/marketplace.json
└─ plugins/tokens-ui-for-codex/
```

也可以迁移源码压缩包，然后运行根目录 `install.ps1`。

源码包没有 `plugins/` 时，安装器会生成：

```text
%LOCALAPPDATA%\tokens-ui-for-codex\install-stage\
```

## 3. 不应迁移什么

以下内容属于旧机器状态，不复制：

```text
%LOCALAPPDATA%\tokens-ui-for-codex\
```

尤其是：

- `client-thread-map.json`：旧机器线程映射
- `monitor.lock`：旧 PID
- `autostart-state.json`：旧安装路径
- `last-summary.json`：旧会话简略快照
- `logs\`：旧机器排障日志
- `install-stage\`：临时构建布局

如果确实需要保留日志做对照，可以单独复制 `logs\`，但不要复制映射、锁和自启状态。

## 4. 迁移步骤

1. 在旧机器确认当前版本和文件来自同一发布版本。
2. 只复制部署目录或源码包。
3. 把目录放在当前用户可写的位置，不要放系统目录。
4. 在目标机器运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<包根>\install.ps1"
```

5. 完全退出并重新打开 Codex。
6. 重载页面后确认只有一个统计条。

安装器会重新生成：

- Codex++ 用户脚本
- 插件 marketplace 注册
- 插件 cache
- 计划任务
- 自启状态
- VBS/PowerShell 启动器
- 新的监控状态

## 5. 安装后验证

### 任务

```powershell
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor | Format-List State
```

### 进程

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'token-stats\.mjs.*--watch' } |
  Select-Object ProcessId, CommandLine
```

只允许一个实例。

### 插件

```powershell
codex plugin list
```

必须出现：

```text
tokens-ui-for-codex@tokens-ui-for-codex-local  installed, enabled
```

### 用户脚本

```powershell
Get-FileHash "$env:APPDATA\Codex++\user_scripts\tokens-ui-for-codex-panel.js" -Algorithm SHA256
Get-FileHash "<包根>\plugins\tokens-ui-for-codex\tokens-ui-for-codex-panel.js" -Algorithm SHA256
```

两个哈希必须相同。

### 页面

```powershell
node "<包根>\plugins\tokens-ui-for-codex\scripts\check-page-state.mjs"
node "<包根>\plugins\tokens-ui-for-codex\scripts\verify-live.mjs"
```

期望：

- `panelCount=1`
- `payloadSchema=3`
- `installedFlag=true`
- `ringCount>=1`
- `failed=0`（verify-live）

### 全部副本

```powershell
node "<包根>\plugins\tokens-ui-for-codex\scripts\verify-sync.mjs" --deploy "<包根>"
```

必须 `mismatches: 0`。

## 6. 常见迁移问题

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| 找不到 codex | MSIX bin 不在 PATH | 让安装器自动搜索；仍失败时检查 `%LOCALAPPDATA%\OpenAI\Codex\bin` |
| 找不到 Node | 无系统 Node，且 Codex runtime 不可见 | 安装 Node 22+ |
| 用户脚本开关关闭 | Codex++ `enabled=false` | 在 Codex++ 中开启，不改 JSON |
| 无统计条 | 页面未重载或脚本未注入 | 重启 Codex，确认用户脚本存在 |
| 两条统计条 | 旧用户脚本残留 | 安装器按脚本内容改名，重载页面 |
| 中文路径失效 | PS1 无 BOM 或 VBS 被写成 ASCII | 使用当前安装器重新生成 |
| 协议不匹配 | 监控和用户脚本不是同一版本 | 重跑安装器、刷新 cache、重载页面 |
| 多窗口无数据 | 没有唯一焦点 | 聚焦一个窗口或传入 `--target <ID>` |
| 健康文件不更新 | 监控已停止或状态视图异常 | 检查单实例、日志和手动启动入口 |

## 7. 迁移后的状态目录

目标机器会生成：

```text
%LOCALAPPDATA%\tokens-ui-for-codex\
├─ logs\
├─ monitor-health.json
├─ autostart-state.json
├─ last-summary.json
└─ monitor.lock
```

这些文件不要从旧机器覆盖。

## 8. 卸载和重新迁移

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<包根>\plugins\tokens-ui-for-codex\uninstall-autostart.ps1" -Full
```

该命令清理任务、进程、用户脚本、插件、cache 和状态目录。
之后手动删除包目录即可。

## 9. 权限要求

- 当前用户即可
- 不请求 UAC
- 计划任务以 Limited 运行
- 不提供“未登录也运行”
- 进程枚举可能看不到其他用户或更高权限进程，但不影响本插件运行

## 10. 隐私边界

迁移后仍保持：

- 页面负载只有数值、时间和有限摘要
- 不包含会话路径、线程 ID、消息正文、密钥或 Token
- 本地 CDP 通信不经过网络
- schema v3 必须通过 HMAC、时间窗、nonce 与 seq 校验
- 不注册键盘监听
- 不修改 Codex React bundle
