# 当前边界与待观察事项

本文件只记录**当前版本仍存在或需要持续观察**的事项。
已修复问题不再逐条保留；有效实现以源码、测试和 `CHANGELOG.md` 为准。

## 1. Codex DOM 锚点变化

统计条依赖 Codex 页面中带以下可访问性语义的上下文用量元素：

- `aria-label` 含“上下文用量”
- `aria-label` 含“上下文窗口”
- 英文 `Context usage` / `Context window`
- 元素内存在 SVG

Codex 若重构无障碍标签或输入区布局，可能导致：

- `anchor-missing`
- 统计条无法找到挂载点
- 位置退化或消失

诊断：

```javascript
window.__tuiForCodexStatus
window.__tuiForCodexStatusAt
```

处理方向：

- 保留多语言 aria-label 匹配
- 保留最小尺寸和 SVG 约束
- 不依赖单个固定 class
- Codex 大版本更新后重新执行实机验收

## 2. 多窗口目标选择

自动模式要求存在唯一焦点窗口，其次允许唯一可见窗口。

无法唯一判断时返回：

```text
CDP_TARGET_SELECTION_REQUIRED
```

处理：

```powershell
node token-stats.mjs --watch --cdp --target <ID>
```

多窗口连接每 10 秒复核一次焦点。焦点探测失败时保留当前连接，避免闪断；
这是“稳定优先”的取舍，焦点切换可能最多延迟一个复核周期。

## 3. 无周期 watchdog

计划任务只在：

- 安装后立即启动
- 用户登录时启动

监控停止后不会按固定间隔反复拉起。

原因：

- 避免常驻轮询资源占用
- 避免重复实例
- 避免企业环境中的持续后台进程告警

代价：

- 任务重试耗尽后需要手动启动
- 详情面板会通过 stale 状态提示用户

## 4. 实时速度不可逐 token 精确获得

Codex rollout 事件不提供逐 chunk/token 时间线。

当前方案：

- 紧凑条显示 `≈XXXT/s` 估算速度
- 使用 Reasoning / AgentMessage 条目耗时
- 详情页使用整轮耗时减去工具耗时计算有效速度

边界：

- 网络停顿会降低估算
- 工具执行不会进入紧凑条估算分子
- 会话级有效速度只使用高/中置信度样本

## 5. CDP 是本地信任边界

页面通过本机 CDP 接收监控负载。

已实施：

- 动态端口发现
- schema v3 签名-only
- HMAC-SHA256
- 30 秒时间窗
- nonce 防重放
- seq 单调
- CDP 目标只接受 `app://` 页面
- 本地客户端审计

仍需认识：

任意拥有当前用户同等权限、并能访问 CDP 端口的程序，仍可能读取页面或尝试干扰调试通道。
HMAC 能阻止伪造负载进入 UI，但不能替代操作系统账户隔离、终端安全和进程白名单。

## 6. MSIX 状态视图差异

Codex 以 MSIX 安装时，PowerShell 与 Node 进程可能看到不同的
`%LOCALAPPDATA%` 虚拟视图。

当前处理：

- JSON 读取兼容 UTF-8 BOM
- 自启状态文件不可见时，监控用同目录 `launch-silent.vbs` 判断自启入口已安装
- 健康文件由监控自身持续重写

影响：

- 健康中的 `autostartInstalled` 是**入口存在性**判据，不是对计划任务状态的实时查询
- 精确任务状态应以 `Get-ScheduledTask` 为准

## 7. 大日志性能

当前增量解析避免每次重读全文，但首次加载超大会话仍需解析历史。

已测：

- 20k 行：解析约 50–62ms，统计约 36–43ms
- 100k 行：解析约 209–240ms，统计约 160–187ms

仍需观察：

- 数百万行会话首屏耗时
- 多分片同时增长的聚合成本
- 低端设备上首次构建 DOM 的开销

## 8. 真实输入测试默认跳过

Playwright 默认真实鼠标/键盘用例会跳过。

原因：

- Escape 可能停止 Codex 回答
- 字符注入可能污染输入框
- 真实输入会改变用户会话

当前验证：

- DOM 事件测试
- CDP 验签测试
- VBS → PowerShell 启动链测试
- 手动确认窗口路径测试

如显式设置 `TUI_ALLOW_REAL_INPUT=1`，才执行真实输入用例。

## 9. 企业受控环境

以下能力可能被组织策略禁用：

- 用户级计划任务
- Codex++ 用户脚本
- 自定义 URL 协议
- `wscript.exe`
- 本地 CDP 端口
- PowerShell 执行策略

当前版本不尝试绕过这些策略。受限环境中应由管理员批准部署方式，或改用组织内签名分发。

## 10. 平台范围

当前只支持：

- Windows 10/11
- Codex / ChatGPT 桌面版
- Codex++
- Node.js 22+

不包含：

- macOS
- Linux
- codex CLI 终端界面
- 无 Codex++ 的官方原生注入
