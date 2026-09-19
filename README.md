# Tokens UI For Codex

在 Codex 桌面版的输入区显示一个紧凑的 Token 统计条，并提供原生风格的详情弹层。
全部统计在本机完成，不联网、不上传任何数据。

## 它长什么样

统计条挂在上下文用量圆圈左侧，与原生布局同排：

- 第一行：`会话总量 / 当前提问总量 / 请求次数`
- 第二行：`命中率 / 缓存命中 / 缓存未命中 / 输出量`

左键单击统计条打开详情弹层，包含六个分区：
会话累计、当前提问统计、上下文使用、运行状态、当前提问请求明细（最近 100 条）、各轮摘要（最近 200 轮）。

弹层关闭方式：点击弹层外部，或点击右上角 `×`。**插件不注册任何键盘监听**（Esc 不会关闭弹层）。

深浅色主题跟随 Codex 当前主题自动切换。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 22H2 / Windows 11 |
| 客户端 | Codex / ChatGPT **桌面版**（MSIX 商店版或传统安装均可） |
| Codex++ | 必需。负责把用户脚本注入页面，并提供本地 CDP 端口（默认 `127.0.0.1:9229`） |
| Node.js | 22+；未单独安装时可直接复用 **Codex 自带运行时**（实测 v24） |
| PowerShell | 5.1+（安装/卸载脚本使用，无需管理员权限） |
| 网络 | 不需要外网 |

## 安装

### 一键安装（推荐）

1. 确保已安装 **Codex++**（否则统计条无法注入页面）。
2. 把整个包目录放到任意位置（例如桌面），双击根目录的 `install.bat`。
3. 脚本会依次完成：环境检查 → 安装用户脚本（覆盖前自动备份 + SHA-256 校验）→ 注册 Codex 本地插件 → 安装登录自启 → 立即启动监控并自检。
4. 安装完成后，完全退出并重新打开 Codex 桌面版，让用户脚本注入。

可选参数：

| 参数 | 作用 |
| --- | --- |
| `install.ps1 -SkipAutostart` | 不安装登录自启（可稍后单独运行 `install-autostart.ps1`） |
| `install.ps1 -SkipPlugin` | 只装 Codex++ 用户脚本，不注册 Codex 插件 |

### 手动安装（三步）

```powershell
# 1) 用户脚本（统计条本体）
Copy-Item ".\plugins\tokens-ui-for-codex\codex-token-spend-panel.js" "$env:APPDATA\Codex++\user_scripts\" -Force

# 2) 注册 Codex 本地插件（技能，可让 Agent 解释与排障）
codex plugin marketplace add "<包目录>"
codex plugin add tokens-ui-for-codex@tokens-ui-for-codex-local

# 3) 登录自启（注册计划任务；不需要管理员）
powershell -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\install-autostart.ps1"
```

## 自动启动与巡检

自启由**计划任务** `tokens-ui-for-codex-monitor` 负责，不需要常驻守护进程：

| 触发方式 | 说明 |
| --- | --- |
| 安装完成时 | 立即启动一次（失败自动重试 1 次并明确报告） |
| 每 5 分钟 | 兜底巡检：监控若意外死亡会被自动拉起；正常运行时不会产生任何新进程 |
| 登录时 | 登录后自动启动 |

监控进程自身负责判断"Codex 是否在运行"：Codex 不在时保持待命不退出，Codex 启动后自动开始上报。
重复实例策略为"不启动新实例"，因此巡检天然不会重复拉起进程。

手动运行方式（调试用）：

```powershell
node .\token-stats.mjs --watch --cdp
```

## 卸载

```powershell
# 标准卸载：删除计划任务、停止进程、保留日志与状态目录
powershell -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1"

# 一键全清：额外删除日志/状态、用户脚本、插件与插件缓存
powershell -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1" -Full
```

可选开关：

| 开关 | 作用 |
| --- | --- |
| `-PurgeState` | 删除状态目录（日志、会话映射、诊断状态） |
| `-RemoveUserScript` | 删除 Codex++ 用户脚本（统计条消失） |
| `-RemovePlugin` | 摘除 Codex 插件与本地 marketplace 注册 |

脚本最后会做残留自检（计划任务 / 进程 / 用户脚本 / 插件缓存 / 状态目录逐项确认）。
唯一无法自动清理的是包目录本身，需要手动删除。

## 数据与隐私

- 监控进程只读取本地会话统计日志中的**结构化字段**；
- 推送到页面的负载（schema v2）只包含数字、时间标签、轮次摘要与当前轮有限请求明细；
- **不包含**：消息正文、会话文件路径、线程 ID、任何凭据；
- 所有统计在本机完成，不产生任何网络请求。

## 排障

按"运行状态"健康值对照：

| 状态 | 含义与处理 |
| --- | --- |
| `healthy` | 正常运行 |
| `starting` | 监控刚启动，等待首个数据 |
| `waiting-for-cdp` | 连接不到 `127.0.0.1:9229`，确认 Codex 与 Codex++ 已启动 |
| `waiting-for-page` | 页面未就绪，重载 Codex 页面 |
| `waiting-for-data` | 已连接但当前会话暂无统计，随便发一条消息即可 |
| `stale-data` | 超过 15 秒没有拿到新数据，检查监控进程是否存活 |
| `target-selection-required` | 检测到多个 Codex 窗口，需显式指定：`node token-stats.mjs --watch --cdp --target <ID>` |

常用检查命令：

```powershell
# 监控是否存活
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor | Get-ScheduledTaskInfo
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'token-stats'

# 健康快照与日志
Get-Content "$env:LOCALAPPDATA\tokens-ui-for-codex\monitor-health.json" -Raw
Get-ChildItem "$env:LOCALAPPDATA\tokens-ui-for-codex\logs"
```

页面没有统计条时，依次确认：Codex++ 运行中 → 用户脚本存在（`%APPDATA%\Codex++\user_scripts\codex-token-spend-panel.js`）→ 监控进程运行中 → 重载页面。

## 技术原理（简述）

```
Codex 会话日志（本地 JSONL）
    └─ 监控进程 token-stats.mjs：增量解析 → 统计合流 → 计算 TPS/缓存拆分/上下文
        └─ 经 CDP（127.0.0.1:9229）推送 schema v2 负载到页面
            └─ 用户脚本 codex-token-spend-panel.js：挂载统计条 + 详情弹层（骨架一次构建 + 增量更新）
```

- 监控每 5 秒推送一次；数据变化时立即推送；
- 页面脚本自愈：统计条被移除或锚点变化时自动重新挂载；
- 详情弹层增量更新，重建时保持滚动位置与展开状态。

## 目录结构（部署包）

```
Tokens UI For Codex/
├─ install.bat / install.ps1            一键安装入口与主安装器
├─ DEPLOYMENT.md                        部署与依赖说明
├─ .agents/plugins/marketplace.json     Codex 本地 marketplace 清单
└─ plugins/tokens-ui-for-codex/
   ├─ .codex-plugin/plugin.json         插件清单
   ├─ skills/tokens-ui-for-codex/       插件技能（Agent 可调用）
   ├─ codex-token-spend-panel.js        Codex++ 用户脚本
   ├─ token-stats.mjs                   监控进程
   ├─ protocol.mjs · schemas/           页面负载协议与 Schema
   ├─ find-codex.ps1                    动态定位（codex / Codex / Node / Codex++）
   ├─ install-autostart.ps1 · uninstall-autostart.ps1
   └─ README*.md · AGENTS.md · CHANGELOG.md
```

## 许可

MIT（见 `LICENSE`）。
