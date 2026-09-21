# 迁移指南 —— 把 Tokens UI For Codex 移到另一台 Windows 电脑

面向 Agent 与手动操作者。目标：在新电脑上得到与旧电脑一致的工作状态，
且每一步都能验证"是否真的到位"。作者 **Littps**。

## 0. 迁移前：新电脑必须具备什么

| 项目 | 检查方式 | 不满足时 |
| --- | --- | --- |
| Windows 10 22H2 / 11 | `[Environment]::OSVersion` | 不支持 |
| Codex / ChatGPT 桌面版 | `Get-AppxPackage -Name "*Codex*"` 或进程 `ChatGPT.exe` | 先安装桌面版 |
| Codex++ | 进程 `codex-plus-plus.exe` 或 `%LOCALAPPDATA%\Programs\Codex++\codex-plus-plus.exe` | 先安装 Codex++ |
| Codex++ 用户脚本已启用 | `%APPDATA%\Codex++\user_scripts.json` 的 `enabled`（**只读检查**） | 在 Codex++ 里启用后重跑安装器 |
| Node.js 22+ | `node --version`，或 Codex 自带运行时 `%USERPROFILE%\.cache\codex-runtimes` 下存在 `node.exe` | 二选一即可；都没有则装 Node 22+ |
| PowerShell 5.1+ | 系统自带 | — |

Node 可以省略：Codex 桌面版自带运行时（实测 v24）会被自动复用。
`find-codex.ps1` 的查找顺序是 **PATH → Codex 自带运行时 → 常见安装位置**；都找不到时安装器会
明确报错并提示安装，而不是静默失败。

## 1. 需要带走什么

只需要**一个部署包目录**（含 `install.bat`、`install.ps1`、`DEPLOYMENT.md`、`.agents\`、`plugins\`）。

**不需要**带走状态目录（`%LOCALAPPDATA%\tokens-ui-for-codex\`）、日志与会话映射：
它们会在新机器上重新生成，旧机器的历史数据不迁移（也不建议迁移，避免会话映射错配）。

如果确实要保留旧机器的日志做对照，可以单独复制 `logs\` 目录，但**不要复制
`client-thread-map.json`**（它记录的是旧机器的线程 ID 映射）。

## 2. 安装步骤（新电脑）

1. 把包目录放到任意位置（例如桌面；路径不要放在需要管理员权限的位置）。
2. 运行一键安装：

   ```powershell
   pwsh -NoProfile -ExecutionPolicy Bypass -File "<包根>\install.ps1"
   ```

   或直接双击 `<包根>\install.bat`（优先 PowerShell 7，回退 5.1）。
3. 完全退出并重新打开 Codex 桌面版。

安装器会自动：定位 `codex` CLI（含 MSIX 的 bin 哈希目录）、定位 Node（含 Codex 自带运行时）、
检查 Codex++ 与其用户脚本总开关、写入用户脚本（备份 + SHA-256 校验）、注册本地插件、
注册计划任务并**立即启动一次**监控（失败自动重试 1 次）。

## 3. 迁移后的验证（四条硬标准 + 页面侧）

```powershell
# ① 计划任务
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor | Get-ScheduledTaskInfo

# ② 监控进程
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'token-stats'

# ③ 用户脚本哈希（应与包内文件一致）
Get-FileHash "$env:APPDATA\Codex++\user_scripts\tokens-ui-for-codex-panel.js"
Get-FileHash "<包根>\plugins\tokens-ui-for-codex\tokens-ui-for-codex-panel.js"

# ④ 插件注册
codex plugin list
```

页面侧（可选，需要监控进程已运行）：

```powershell
node "<包根>\plugins\tokens-ui-for-codex\scripts\check-page-state.mjs"
```

期望：`panelCount=1`、`payloadSchema=2`、`ringCount≥1`、`installedFlag=true`。

想一次比对全部生效副本（源码 / 部署 / 插件 cache / 用户脚本 / 打包 zip）：

```powershell
node "<包根>\plugins\tokens-ui-for-codex\scripts\verify-sync.mjs" --deploy "<包根>" --zip "<包 zip>"
```

输出必须为 `mismatches: 0`。

> 说明：`scripts\`（含 `check-page-state.mjs`、`verify-sync.mjs` 等诊断与校验脚本）只随
> **完整部署目录**与**源码包**提供；精简的安装包 zip 按设计只含运行所需文件与用户文档。
> 新电脑上若只有安装包，可先复制旧机器的完整部署目录，或从源码包取 `scripts\`。

## 4. 常见迁移问题

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 安装器报"未找到 codex 命令" | 桌面版是 MSIX，bin 不在 PATH | 安装器已自动搜索；仍失败时检查 `%LOCALAPPDATA%\OpenAI\Codex\bin` 是否存在 |
| 安装器报"运行时缺失" | 既没装 Node，也没有 Codex 自带运行时 | 安装 Node 22+（勾选加入 PATH）后重跑 |
| 提示"Codex++ 用户脚本总开关关闭" | `user_scripts.json` 的 `enabled=false` | 在 Codex++ 管理器中启用后重跑安装器 |
| 统计条不出现 | 用户脚本未注入或页面未重载 | 确认 Codex++ 运行中 → 重载 Codex 页面（或重启 Codex） |
| 出现两条统计条 | 用户脚本目录里有历史面板脚本 | 安装器会按脚本内容把非当前脚本改名为 `.superseded-*.bak`；重载页面后确认条数为 1 |
| 健康值长期 `waiting-for-page` | Codex 未启动或页面未就绪 | 启动 Codex；监控会保持待命并自动恢复 |
| `target-selection-required` | 新机器上开了多个 Codex 窗口且无唯一目标 | 用 `--target <ID>` 指定，或在页面侧只保留一个窗口 |
| 面板数字停滞不增长 | 宿主把会话分片了，或日志命名再次变化 | 查日志中的「数据停滞 / 定位失败 / 定位预警」；当前版本已自动合并分片，出现「定位预警」请反馈维护者 |

## 5. 卸载（如需回退）

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "<包根>\plugins\tokens-ui-for-codex\uninstall-autostart.ps1" -Full
```

`-Full` 会清除计划任务、监控进程、状态目录、用户脚本及其备份、插件与插件缓存；
最后手动删除包目录。默认模式只停进程并删除计划任务，保留日志与状态目录，便于复查。

## 6. 权限说明（迁移相关）

- 全程不需要管理员权限，不弹 UAC；
- 计划任务注册在**当前用户**下（登录触发 + 每 5 分钟巡检 + 安装后立即执行）；
- 不提供"未登录也运行"：那需要管理员权限或存储凭据，本项目明确不使用；
- 进程检测依赖 `Get-CimInstance` 读取命令行，对其他用户/提权进程可能读不到（已做容错，
  只影响检测精度，不影响运行）。

## 7. 隐私边界（跨设备一致）

迁移不会改变隐私边界，新机器上同样成立：

- 页面负载只含数字统计、时间标签、各轮摘要与当前轮有限请求明细；
- **不含**会话文件路径、线程 ID、用户消息正文、Token、密钥或任何凭据；
- 监控读取本地会话日志，但只提取结构化数值，不复制、不展示、不外传正文；
- 页面与监控通过本机 CDP（默认 `127.0.0.1:9229`）通信，不经过网络；
- 面板不注册键盘监听、不修改 Codex 的 React bundle、不写入 Codex 配置文件。

因此日志、状态目录与 `client-thread-map.json` 都属于**本机私有数据**，迁移时不建议复制。
