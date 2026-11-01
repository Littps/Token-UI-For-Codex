# 上下文能力与原组件模式资源占用

本文描述当前已部署的“原组件模式”：

```text
PowerShell 常驻 watchdog
→ Node.js token-stats.mjs --watch
→ Codex++ 页面用户脚本
```

Rust launcher 是仓库内单独发布的 0.1.0 Alpha 组件，不是本文这些原组件模式数字的
组成部分。

## 上下文使用

### 精确值

上下文圆圈的已用量来自最后一次请求的：

```text
usage.total_tokens
```

并受模型上下文上限约束：

```text
contextUsed = min(lastRequestTotalTokens, modelContextWindow)
```

上限优先从 `task_started`、`token_count` 和会话元数据中读取。无法得到上限时显示
`未知`，不得伪造。

### 本地分类估算

详情页会把精确的 `contextUsed` 进一步拆成：

- 系统/开发指令；
- 工具定义；
- 对话消息；
- 其他/模板开销。

除已用量和上限外，其余分类都不是服务端计费值，而是本地字符权重估算：

```text
ASCII 字符权重 = 字符数 / 4
非 ASCII 字符权重 = 字符数 / 1.5
```

分类数值使用完整整数并带 `≈`。各已知来源缺失时显示 `--`；所有已知分类之和不会超过
`contextUsed`，差额归入“其他/模板”。

当“其他/模板”超过 `contextUsed` 的 60% 时，页面隐藏不可靠的分类分段和明细，只保留：

- 精确已用量；
- 模型上下文上限；
- “本地分类覆盖不足”说明。

### 隐私

上下文估算只读取结构中的文本长度，不保存、记录或下发：

- 消息正文；
- 系统/开发指令正文；
- 工具描述正文；
- 会话路径、thread ID、response ID、turn ID。

## 原组件模式资源占用

本机 2026-11-01 实测的代表值：

| 进程 | 工作集 | 私有提交 | 说明 |
| --- | ---: | ---: | --- |
| PowerShell watchdog | 约 90–120 MB | 约 90–100 MB | 常驻，每 15 秒检查一次 |
| Node 监控 | 约 140–160 MB | 约 140–160 MB | 读取、解析和统计 rollout |
| 合计 | 约 230–280 MB | 约 230–260 MB | 随会话大小和 GC 波动 |

资源特点：

- 空闲 CPU 采样接近 0%，启动、首次解析和长会话重算时会短时上升；
- 监控主循环约 1 秒一次，空闲心跳 5 秒一次，详细长列表展开时不发无意义心跳；
- 页面请求明细和各轮摘要各限制 500 条，长历史主要落在磁盘归档，不随每个 payload 重发；
- 运行时没有第三方 npm 依赖；
- Page、Relay、Codex++ 用户脚本、部署目录和插件 cache 共同完成运行，不启动第二套 Web 服务；
- 原组件模式额外承担 PowerShell watchdog 的内存；Rust launcher 只替换这一层，Node
  监控仍会保留。

这些数据是当前机器的观测值，不是跨设备 SLA。低内存设备、超大会话、首次解析和杀软扫描
可能使峰值更高。

## Rust launcher 隔离实测

2026-11-01 在 release 构建、随机临时任务和模拟 Node 心跳的隔离环境中：

| 进程 | 工作集 | CPU 观察 |
| --- | ---: | ---: |
| `tokens-ui-launcher.exe` | 约 6.8–6.9 MB | 3 秒切片低于 0.001% 单核显示精度 |
| 模拟 Node 心跳夹具 | 约 51.29 MB | 模拟器固定每 100ms 写心跳，不能代表真实 Node |

Rust launcher 的数值是 supervisor 本身；真实 Node 监控仍按上表的原组件范围波动。
该结果不能外推为中低端设备的 SLA。测试还验证了 Job Object 在 supervisor 被终止时
清理 Node、会话级单实例 Mutex、退避重启和计划任务安装/卸载。

## 相关文档

- `docs/context-estimation.md`
- `docs/metric-scopes.md`
- `docs/perf-budget.md`
- `docs/watchdog.md`
