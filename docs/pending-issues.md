# 当前边界与待观察事项

本文件只记录**当前版本仍存在或需要持续观察**的事项。
已修复问题不再逐条保留；有效实现以源码、测试和 `CHANGELOG.md` 为准。

当前发布候选仍使用原组件模式：PowerShell watchdog + Node 监控。`rust-launcher/`
0.1.0 Alpha 已能在隔离环境替换 watchdog，并完成进程生命周期、计划任务安装/卸载与
doctor 测试，但尚未成为默认安装路径，也尚未完成多设备、企业安全策略和长期运行验证。
因此 **Rust 版本没有做详细测试**，不能按正式稳定组件宣传。
上下文能力与资源实测见 `docs/context-and-resources.md`。

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

## 3. 会话身份确认延迟

为避免在新对话或页面恢复时把多个旧会话混在一起：

- 候选必须存在对应 rollout，空白新对话除外
- 同一候选连续稳定 2.5 秒后才切换
- 页面最后确认 ID 最多沿用 8 秒
- 无文件、多候选或 placeholder 尚未生成文件时显示等待/陈旧状态

代价是极端情况下切到新会话会多延迟约一个轮询周期加 2.5 秒。

## 4. Watchdog 与单实例边界

当前计划任务：

- 登录时运行 watchdog
- 登录时启动一次常驻 watchdog
- watchdog 在同一进程内每 15 秒检查

监控使用两层单实例保护：

- 用户级 guard lock
- Codex Home 主锁 + 运行进程交叉检查

watchdog 只在以下情况重启：

- 监控 PID 消失
- PID/路径/启动时间身份完整，且心跳连续两次过期
- 旧版监控超过启动宽限且没有可验证心跳，确认脚本路径和单实例后受控迁移一次

以下状态不会触发重启：

- `waiting-for-cdp`
- `waiting-for-page`
- `waiting-for-data`
- `stale-data`
- 会话空闲

`--allow-multi-monitor` 只保留给隔离测试，不作为普通 UI 入口。

## 5. 实时速度不可逐 token 精确获得

Codex rollout 事件不提供逐 chunk/token 时间线。

当前方案：

- 紧凑条显示 `≈XXXT/s` 估算速度
- 使用 Reasoning / AgentMessage 条目耗时
- 详情页使用整轮耗时减去工具耗时计算有效速度

边界：

- 网络停顿会降低估算
- 工具执行不会进入紧凑条估算分子
- 会话级有效速度只使用高/中置信度样本

## 6. CDP 是本地信任边界

页面通过本机 CDP 接收监控负载。

已实施：

- 动态端口发现
- schema v4 / auth v2 签名-only
- HMAC-SHA256
- 30 秒时间窗
- nonce 防重放
- seq 单调
- keyId 标识监控会话
- CDP 目标只接受 `app://` 页面
- 本地客户端审计

仍需认识：

任意拥有当前用户同等权限、并能访问 CDP 端口的程序，仍可能读取页面或尝试干扰调试通道。
HMAC 能降低无密钥事件伪造和重放风险，但不能替代操作系统账户隔离、终端安全和进程白名单。
临时 bootstrap 只能缩短明文密钥暴露窗口，无法阻止主动观察 CDP 或同一 JS Realm 的代码。

## 7. MSIX 路径虚拟化边界

Codex 以 MSIX 安装时，`%LOCALAPPDATA%` 可能按包重定向到进程私有视图。
同一路径字符串在不同进程中不一定指向同一实体文件。

当前处理：

- JSON 读取兼容 UTF-8 BOM
- 可变状态默认写入解析后的 `<CODEX_HOME>\tokens-ui-for-codex\state`
- CLI、环境变量和 `runtime-paths.json` 可覆盖路径
- 自启状态文件不可见时，监控用同目录 `launch-silent.ps1` / `.vbs` 判断入口存在
- 旧 `%LOCALAPPDATA%` 仅用于迁移、诊断和卸载兼容

影响：

- 健康中的 `autostartInstalled` 是**入口存在性**判据，不是对计划任务状态的实时查询
- 精确任务状态应以 `Get-ScheduledTask` 为准

## 8. 大日志性能

当前增量解析避免每次重读全文，但首次加载超大会话仍需解析历史。

已测：

- 20k 行：解析约 50–62ms，统计约 36–43ms
- 100k 行：解析约 209–240ms，统计约 160–187ms

仍需观察：

- 数百万行会话首屏耗时
- 多分片同时增长的聚合成本
- 低端设备上首次构建 DOM 的开销

## 9. 真实输入测试默认跳过

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

## 10. 企业受控环境

以下能力可能被组织策略禁用：

- 用户级计划任务
- Codex++ 用户脚本
- 自定义 URL 协议
- `wscript.exe`
- 本地 CDP 端口
- PowerShell 执行策略

当前版本不尝试绕过这些策略。受限环境中应由管理员批准部署方式，或改用组织内签名分发。

## 11. 平台范围

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

## 12. Golden corpus 不随源码发布

真实会话 Golden corpus 涉及用户本地会话结构，默认不复制进仓库。

因此：

- `scripts/stats-snapshot.mjs --check` 使用固定合成 fixture，必须保持全绿；
- `golden-baseline.mjs --check` 在没有显式生成且获准保存本机语料时会失败关闭；
- 该失败不代表统计回归，也不能通过放宽脚本绕过；
- 发布验收以合成快照、单元测试、协议测试和实机测试为主。
