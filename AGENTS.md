# AGENTS.md — Tokens UI For Codex 工程约定

本文件写给在本仓库工作的 Agent。修改、部署或发布前先读完本文件。

作者：**Littps**
许可：MIT

## 1. 产品边界

- 仅支持 Windows 10/11 上的 Codex / ChatGPT 桌面版
- 依赖 Codex++ 用户脚本
- 不修改 Codex React bundle
- 不注册键盘监听
- 不修改 Codex `config.toml`
- 不读取、复制、展示或外传用户消息正文

页面只展示结构化统计：

- token 数量
- 时间标签
- 请求与轮次摘要
- 上下文使用量
- 健康与安装状态

运行时依赖边界：

- 没有第三方 npm 运行时依赖
- 只使用 Node.js 22+ 内置模块和 WebSocket/fetch
- 部署不需要 `npm install`
- Playwright 用于 `npm run test:auth-ui` 和 `npm run test:live`
- CI 同时覆盖 Node.js 22 和 24

## 2. 组件

### 页面

`tokens-ui-for-codex-panel.js`

- Codex++ 用户脚本
- 原生风格紧凑条
- 点击详情弹层
- 主题跟随
- HMAC 验签
- DOM 增量更新

### 监控

`token-stats.mjs`

- 读取本地 Codex rollout JSONL
- 增量解析与分片合并
- 统计请求、轮次、缓存、速度和上下文
- 通过本机 CDP 推送签名 schema v5 / auth v2 负载
- 写入健康快照、简略快照和日志

会话身份约束：

- 页面候选必须存在对应 rollout，空白新对话除外
- 候选连续稳定 2.5 秒后才允许切换
- `client-new-thread` 只接受激活后创建的唯一会话文件
- 禁止把新 placeholder 映射到任意“最新未认领旧文件”
- React Fiber 兜底只接受 `conversationId` / `localConversationId` / `threadId`
- 最后确认 ID 最多沿用 8 秒；过期后宁可等待，不得继续显示旧会话

### 协议

- `protocol.mjs`
- `schemas/payload-v5.schema.json`
- `docs/auth-v2.md`
- 页面事件：`tokens-ui-for-codex`
- 页面全局：`window.__tuiForCodex`

### 安装

- `find-codex.ps1`
- `install.ps1`
- `install-autostart.ps1`
- `uninstall-autostart.ps1`
- `install.bat`

### 测试与工具

- `test/token-stats.test.mjs`
- `test/live-ui.playwright.test.mjs`
- `scripts/check-page-state.mjs`
- `scripts/verify-live.mjs`
- `scripts/verify-sync.mjs`
- `scripts/golden-baseline.mjs`
- `scripts/perf-baseline.mjs`

## 3. 数据链路

```text
Codex rollout JSONL
  → IncrementalRolloutParser
  → buildStats / mixed-format merge
  → payloadFor
  → signPayload (auth v2：body + v + keyId + ts + nonce + seq)
  → local CDP
  → panel verifyPayloadAuth
  → adoptData
  → incremental render
```

页面 → 监控只有一个反向信号：

```html
<html data-tui-window="turns:requests">
```

监控每秒读取一次窗口值。

## 4. 协议约束

schema v5 / auth v2 是严格签名-only：

- 必须 `authRequired: true`
- 必须有 `auth.v=2`
- 必须有 `keyId`、`ts`、`nonce`、`seq`、`mac`
- 时间窗 ±30 秒
- nonce 不可重复
- seq 必须严格递增
- `keyId` 变化时清空旧密钥、nonce 与 seq 状态
- MAC 输入包含固定域分隔、body 和完整 auth 信封
- 验证前深拷贝，验证后应用同一快照

拒绝条件：

- 无 auth
- 坏 MAC
- 过期 ts
- nonce 重放
- seq 倒退
- `authRequired !== true`
- 旧 schema v4/v3 或 auth v1

## 5. 统计口径

权威文件：`docs/F1-merge-spec.md`

必须遵守：

- 两代日志格式统一合并
- 累计值不可假设单调递增
- 累计下降按 reset-aware normalizer 处理
- 现代格式是权威流
- legacy 回声一对一认领
- legacy 自身去重包含完整 input/output/cached
- 现代记录后的 legacy 当前轮用 thread delta 修正
- `requestCount = modern 去重数 + unique 补录数`
- `sessionTotal = 逐请求 total 前缀和`，偏差应为 0

轮次：

- `turn_context` 是权威来源
- 有 `turn_id` 精确归属
- 无 `turn_id` 按时间窗归属
- 没有 `turn_context` 才退回 user message 分界
- 排序键统一为 `(ts, ordinal)`

速度：

- 紧凑条：`≈XXXT/s`，最近最多 5 个有效请求样本的中位数 + MAD 离群过滤
- 少于 3 个有效样本显示 `--T/s`，禁止回退到单条尖峰
- 生成区间重叠时取并集；连续 3 个窄分布样本允许切换速度区间
- 详情：有效速度 = output ÷（轮耗时 − 工具耗时）
- 详情标题显示本轮墙钟平均；墙钟速度只使用 output，不使用上下文累计量
- 会话有效速度使用最近 25 个高/中置信度轮次加权
- 输出 token 已包含 reasoning，不得重复加
- 总用时优先取 `task_complete.duration_ms`
- 工具用时必须取工具区间并集，不能把并行工具 duration 直接相加
- 会话 TTFT 取有效轮次的算术平均值，并记录样本数
- 缺失计时保持 `null`，不得写 0

## 6. 推送与加载

| 场景 | 行为 |
| --- | --- |
| 数据变化 | 立即推送 |
| 任务运行中 | 1 秒心跳 |
| 空闲 | 5 秒心跳 |
| 展开长列表 | 不做心跳 |

窗口：

- 关闭：5 轮 / 0 明细
- 打开：10 轮 / 10 明细
- 请求加载更多：+20
- 轮次加载更多：+50
- 上限：各 500

未展示数据不进页面负载。
页面、协议和接收端数组上限均为 500；更早的结构化请求与轮次摘要写入本地历史，不经过 CDP。

本地历史：

- `<runtime-paths.json 的 historyDir>\sessions\<sessionHash>\`
- 请求：`requests-YYYYMM*.jsonl`
- 轮次：`turns.json`
- 保留 60 天；请求文件 32MB 分段；每 6 小时清理

## 7. UI 约束

- 统计条固定在上下文用量圆圈左侧
- 第一行：会话 / 当前提问 / 请求
- 第二行：≈速度 / 命中率 / 命中 / 输出
- 悬浮冻结
- 点击弹层外部或 × 关闭
- 无键盘监听
- 详情骨架一次构建
- 列表结构不变时按稳定 key 更新实际行
- 倒序列表必须更新顶部当前轮，不能固定更新最后一行
- 深浅色跟随宿主
- 主题观察器只监听 `<html>`，不要订阅整棵 DOM 的 class/style
- 磨砂玻璃必须有低性能降级
- 高性能设备使用强磨砂；关闭详情带约 110ms 退场动画
- 上下文分类是本地估算，界面必须标 `≈` 和免责声明
- 上下文分类数值总和必须等于 `floor(contextUsed)`，缺失来源显示 `--`
- 上下文分类只保存数值权重，不保存正文；other/template 超过 60% 时隐藏分类图
- 原组件模式资源基线按 watchdog 90–120 MB、Node 140–160 MB 记录；`rust-launcher/`
  0.1.0 Alpha 的 supervisor 实测约 6.8–6.9 MB，单独标注，不得把它与真实 Node 合计混写
- “统计信息”范围仅允许 `today / 3d / 7d / 30d / all`，默认 `all` 并持久化选择
- 详情关闭时必须停止范围计算并使 `rangeSummary` 为 `null`
- 范围统计只读取 `turns.json` 的结构化数值，不得读取原始会话正文
- 紧凑条完整线程累计与详情本地归档范围是不同口径；禁止用两者相等作为测试条件
- 重新打开详情时允许先显示最长 24 小时的范围数值缓存，但必须明确标记并在新负载到达后替换
- 同页详情快照缓存必须包含会话切换失效；缓存只保存现有脱敏数字、时间与索引
- 健康灯悬浮/聚焦提示必须展示错误码、原因、恢复状态和最近成功时间；未知错误统一标为“其他”

## 8. 文件编码

硬要求：

- `.ps1`：UTF-8 with BOM
- `launch-silent.vbs`：UTF-16LE with BOM
- `launch-confirm.vbs`：UTF-16LE with BOM
- 生成的 `start-monitor.ps1`：UTF-8 with BOM
- `.mjs` / `.js` / `.md`：UTF-8

原因：

- Windows PowerShell 5.1 对无 BOM UTF-8 中文解析不可靠
- 旧 ASCII VBS 会把中文安装路径写成 `???`
- PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，生成 JSON 必须用无 BOM UTF-8

使用 `[System.IO.File]::WriteAllText` 明确指定编码。

## 9. 安装与生命周期

计划任务：

- `tokens-ui-for-codex-monitor`
- 安装后立即执行一次
- 登录时启动一次常驻 watchdog；进程内每 15 秒检查
- Limited
- 不请求 UAC

主链：

```text
powershell.exe -WindowStyle Hidden → monitor-watchdog.ps1 -Resident
                                           ↓ 异常或停止时
                                      launch-silent.ps1 → node
```

手动入口：

```text
launch-confirm.vbs → start-monitor.ps1 → Y 确认
→ monitor-watchdog.ps1 -Resident -ForceStart → launch-silent.ps1 → node
```

watchdog 保持常驻；进程消失或连续心跳停滞时才重启。默认一个 Windows 用户
只允许一个监控。原地升级遗留的无心跳旧监控，只有超过启动宽限、脚本路径匹配
且不存在其他监控时才受控迁移一次；停止未确认时不得清理锁或启动第二实例。

## 10. 副本同步

生效副本：

1. 源码树
2. 正式部署
3. 插件 cache
4. Codex++ 用户脚本

运行：

```powershell
node scripts\verify-sync.mjs --deploy "<部署根>" --zip "<安装包>"
```

必须 `errors: []` 且 `mismatches: 0`。

默认严格要求源码、部署、cache、用户脚本和 ZIP 全部存在；`--allow-partial`
仅供开发诊断，不得作为发布门禁。

更新用户脚本后必须重载 Codex 页面。

## 11. 测试门禁

```powershell
npm run check
npm test
npm run test:auth-ui
node scripts\golden-baseline.mjs --check
node scripts\verify-live.mjs
npm run test:live
node scripts\verify-sync.mjs --deploy "<部署根>" --zip "<安装包>"
```

PowerShell：

```powershell
# Windows PowerShell 5.1
powershell.exe -NoProfile -Command '$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\install.ps1),[ref]$null,[ref]$errors)|Out-Null; $errors.Count'

# PowerShell 7
pwsh -NoProfile -Command '$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\install.ps1),[ref]$null,[ref]$errors)|Out-Null; $errors.Count'
```

完整四项检查由 `.github/workflows/test.yml` 执行。

规则：

- 时序、重启、心跳类改动至少做 5 轮实机
- 禁止改期望值来适配实现
- 数字口径改动必须附真实会话改前/改后对照
- 测试全绿不等于交付成功，还要检查页面和进程状态
- 真实输入注入默认跳过

## 12. 当前基线

- 单元测试：87
- 本地隔离页 auth UI：5
- 固定合成快照：0 不一致；真实本机 Golden corpus 未随源码发布
- `verify-live`：29 项，部署当前源码后复跑
- 实机 Playwright：19 个用例；当前 17 通过 / 2 安全跳过
- 连续监控重启：5 轮通过
- 分页：5 轮通过
- 主题快速切换：20 轮通过

## 13. 安全与隐私

- 页面负载不含路径、线程 ID、response ID、turn ID、消息正文、密钥
- 上下文估算只可下发数值权重和估算版本，不得下发 prompt、工具描述或消息正文
- 不读取会话正文
- 不修改 Codex++ `user_scripts.json`
- 不修改 Codex `config.toml`
- 审计脚本无中/高危项才可交付
- 本地 CDP 是信任边界：页面验签降低伪造风险，但不能替代操作系统账户隔离
- 任何新功能都不得把原始会话内容加入页面负载或日志
- 历史归档不得包含消息正文、路径、原始线程 ID、response ID 或 turn ID
- 历史归档只保存在本机，不得通过 CDP 下发

## 14. Git 与交付

- 不主动 commit / push，除非用户明确要求
- 不推送历史 alpha 标签
- 发布前检查本机绝对路径、用户名、Token、密钥
- 打包时明确区分：
  - 源码包：可构建、可测试
  - 安装包：只含运行所需文件和用户文档
- 交付说明必须写清版本、验证结果、回滚点和未覆盖项

## 15. 已知边界

- Windows only
- 依赖 Codex++
- DOM 锚点可能随 Codex 大版本更新变化
- watchdog 只处理进程存活，不重启 CDP/页面/数据暂时不可用
- 实时逐 token 速度不可得
- 多窗口需要唯一焦点或手动 target
- 受限企业环境可能禁用计划任务、用户脚本或 CDP
- HMAC 只提供基础完整性，不隔离同用户恶意进程或同一页面的恶意脚本
