# Watchdog 与单实例控制面

## 架构

- 数据面：`token-stats.mjs --watch --cdp`
- 控制面：`monitor-watchdog.ps1`
- 调度：计划任务 `tokens-ui-for-codex-monitor`

计划任务在用户登录时启动一次常驻 watchdog。watchdog 在同一进程内默认每 15 秒
检查心跳和进程状态，不再每次创建新的 PowerShell 控制台。

资源取舍：

- 消除每分钟计划任务窗口闪烁；
- 增加一个低频常驻 PowerShell supervisor；
- 不再使用旧版每 2 秒 WMI 轮询；
- 安装/卸载会先停止旧 watchdog，避免继续运行旧代码。

当前开发机实测常驻 supervisor 的工作集约 90–120 MB，15 秒检查间隔下
空闲 CPU 约 0.3% 单核。该数值会随 PowerShell、系统负载和检查路径变化，
不能视为所有设备固定值。

该常驻 PowerShell supervisor 属于“原组件模式”。完整资源口径见
`docs/context-and-resources.md`。

## Rust 启动层（实验组件）

`rust-launcher/` 0.1.0 Alpha 用 `tokens-ui-launcher.exe` 替换上述 PowerShell
supervisor，Node 数据面保持不变：

```text
tokens-ui-launcher.exe
  -> Windows Job Object
  -> node token-stats.mjs --watch --cdp --port auto
```

- `tokens-ui-launcher.exe` 使用 Windows GUI subsystem，不创建控制台窗口。
- 当前 Windows 用户会话使用命名 Mutex 限制为单实例，并在运行期间独占
  `watchdog.lock` 文件句柄，阻止旧 PowerShell watchdog 双重取锁。
- 子进程位于启用 `KILL_ON_JOB_CLOSE` 的 Job Object。
- heartbeat 身份匹配后进入 `healthy`；无心跳、停滞或 Node 退出时按
  `1 / 2 / 5 / 10 / 15` 分钟退避重启。
- `tokens-ui-doctor.exe --diagnose` 输出路径、Node、状态文件和进程存活信息。
- 标准安装包仍使用 PowerShell 模式；Rust 包必须单独安装，并先备份旧计划任务。

隔离计划任务实测 supervisor 工作集约 6.8–6.9 MB；真实 Node 不包含在该数值内。

## 单实例

默认策略是一个 Windows 用户只运行一个监控。

三层保护：

1. 用户级 guard lock
2. Codex Home 主锁
3. `node.exe + token-stats.mjs + --watch` 进程交叉检查

默认路径：

```text
%USERPROFILE%\.tokens-ui-for-codex\monitor.guard.lock
<CODEX_HOME>\tokens-ui-for-codex\monitor.lock
```

`--allow-multi-monitor` 只允许隔离测试绕过 guard 和进程审计，不提供给普通 UI。

## 心跳

监控每 10 秒写入：

```text
<stateDir>\monitor-heartbeat.json
```

字段包括：

- `pid`
- `startedAt`
- `heartbeatAt`
- `heartbeatSeq`
- `phase`
- `scriptPath`
- `stateDir`
- `lockFile`
- `guardLockFile`

watchdog 校验 PID、脚本绝对路径和进程启动时间，并记录心跳序号；卡死判定使用
独立心跳文件的更新时间，不只比较锁文件时间戳。

## 判定时序

| 场景 | 行为 |
| --- | --- |
| PID 不存在 | 下一次 watchdog 检查中启动 |
| 新进程启动不足 120 秒 | 不判死 |
| 心跳超过 45 秒未更新 | 只记录 stale candidate |
| 休眠或检查间隔超过 150 秒 | 本次只恢复基线，不重启 |
| 心跳超过 120 秒且连续两次检查不前进 | 停止 PID 并重启 |
| 旧版进程超过启动宽限但无有效心跳身份 | 确认脚本路径后受控停止一次并迁移到新监控 |
| CDP、页面或数据不可用 | 不重启 |

旧版迁移只会在以下条件全部满足时发生：进程是 `node.exe`、命令行引用当前
`token-stats.mjs`、已超过 120 秒启动宽限、没有可验证心跳，并且不存在其他监控
进程。停止后必须确认 PID 已退出；确认失败时不会清理锁或再启动第二个实例。

启动失败退避：

```text
1 / 2 / 5 / 10 / 15 分钟
```

成功运行达到稳定窗口后清零连续失败计数。

## 状态文件

```text
<stateDir>\watchdog-state.json
<stateDir>\watchdog.lock
```

watchdog 使用独立锁，避免两个巡检实例同时运行。

## 手动启动

详情面板按钮名称为“启动/检查监控”：

1. 优先请求 `tokens-ui-for-codex://start`
2. 同时复制 Win+R 备用命令
3. 确认窗口先执行全局实例检查
4. 只有用户输入 `Y` 后才调用 `monitor-watchdog.ps1 -Resident -ForceStart`

页面不能静默启动本地进程。

## 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-watchdog.ps1
```

隔离测试覆盖：

- 首次启动
- 健康状态不重启
- 强制终止后重启
- 心跳停滞两次确认
- 无心跳旧版实例受控迁移
- 常驻 watchdog 在 Node 被强杀后自动恢复
- 启动失败计数与退避
- 状态文件写入

正式计划任务还应检查：

```powershell
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor
Get-ScheduledTaskInfo -TaskName tokens-ui-for-codex-monitor
```

任务的 ExecutionTimeLimit 必须为不限时，触发器中只保留当前用户登录。
常驻任务运行期间，`LastTaskResult=267009`（`0x41301`）表示任务仍在运行，
不是失败；判断健康应同时查看进程、heartbeat 和 `watchdog-state.json`。

## 兼容边界

- Windows 10/11
- Windows PowerShell 5.1+
- 当前用户 Limited 任务，无管理员权限
- watchdog 只处理进程存活，不修复 Codex DOM、CDP 权限或损坏会话
- 企业策略禁用周期任务时，自动恢复能力不可用
