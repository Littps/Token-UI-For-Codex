# 运行时路径解析

状态、锁、日志和历史目录不再固定到 `%LOCALAPPDATA%`。所有组件共用
`runtime-paths.mjs` 的解析结果，避免 MSIX 文件虚拟化和跨设备路径漂移。

## 优先级

| 优先级 | 状态目录 | 锁文件 | 日志 / 历史 |
| --- | --- | --- | --- |
| 1 | `--state-dir` | `--lock-file` | `--log-dir` / `--history-dir` |
| 2 | `TUI_STATE_DIR` | `TUI_LOCK_FILE` | `TUI_LOG_DIR` / `TUI_HISTORY_DIR` |
| 3 | `runtime-paths.json` | `runtime-paths.json` | `runtime-paths.json` |
| 4 | `<CODEX_HOME>\tokens-ui-for-codex\state` | `<CODEX_HOME>\tokens-ui-for-codex\monitor.lock` | state 下的 `logs` / `history` |

另有独立存活与守护路径：

| 项目 | 默认值 | 覆盖 |
| --- | --- | --- |
| Heartbeat | `<stateDir>\monitor-heartbeat.json` | `--heartbeat-file` / `TUI_HEARTBEAT_FILE` |
| 用户级 guard lock | `%USERPROFILE%\.tokens-ui-for-codex\monitor.guard.lock` | `--guard-lock-file` / `TUI_GUARD_LOCK_FILE` |
| Watchdog 状态 | `<stateDir>\watchdog-state.json` | 随 stateDir |
| Watchdog 锁 | `<stateDir>\watchdog.lock` | 随 stateDir |

主锁始终默认位于 `<CODEX_HOME>\tokens-ui-for-codex\monitor.lock`，不会仅因
`--state-dir` 改变而生成第二把主锁。用户级 guard 再确保同一 Windows 用户默认
只有一个监控；只有隔离测试可显式使用 `--allow-multi-monitor`。

`CODEX_HOME` 解析顺序：

1. `TUI_CODEX_HOME`
2. `CODEX_HOME`
3. `%USERPROFILE%\.codex`

安装器可显式传入 `-CodexHome`、`-StateDir`、`-LockFile`。安装器忽略旧
`runtime-paths.json` 并重新解析，再把最终绝对路径写入插件目录下的
`runtime-paths.json`。该文件是本机生成物，不进入部署 ZIP。

## 默认目录

```text
<CODEX_HOME>\tokens-ui-for-codex\
├─ install-stage\
├─ monitor.lock
└─ state\
   ├─ monitor-health.json
   ├─ monitor-heartbeat.json
   ├─ watchdog-state.json
   ├─ watchdog.lock
   ├─ state-migration.json
   ├─ autostart-state.json
   ├─ last-summary.json
   ├─ client-thread-map.json
   ├─ logs\
   └─ history\
```

如果旧历史目录存在且新历史目录不存在，安装器会复制已有历史；完成后再让
`historyDir` 指向新状态目录。复制失败时保留旧目录并明确提示，不会删除原始历史。

## 旧路径兼容

旧路径：

```text
%LOCALAPPDATA%\tokens-ui-for-codex\
```

只用于迁移、诊断和卸载兼容。安装时会复制有效的 `last-summary.json` 和
`client-thread-map.json`（仅在新目标不存在时），健康文件始终重建。

## 查看当前解析结果

```powershell
node .\runtime-paths.mjs
Get-Content .\runtime-paths.json -Raw -Encoding UTF8
```

显式覆盖示例：

```powershell
node .\token-stats.mjs --watch --cdp `
  --state-dir "D:\Codex State\Tokens UI" `
  --lock-file "D:\Codex State\Tokens UI\monitor.lock"
```

PowerShell 脚本、JSON 和 Markdown 继续使用各自固定的编码约定；路径本身按 Unicode 处理，
不经过 GBK 或系统活动代码页。
