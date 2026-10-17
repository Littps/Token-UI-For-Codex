# 更新记录（Changelog）

版本倒序排列。作者：**Littps** · 许可：MIT。

---

## 1.0.1+codex.20261017170503（2026-10-17）

- 请求明细和各轮摘要的页面、协议、schema 上限统一为 **500**。
- 新增本地结构化历史归档，超过 500 条的数据不再依赖页面 payload。
- 归档路径：`%LOCALAPPDATA%\tokens-ui-for-codex\history\sessions\<sessionHash>\`。
- 请求记录按 JSONL 追加，轮次摘要保存为 `turns.json`；不保存消息正文、会话路径、线程 ID、response ID 或 turn ID。
- 历史保留 **60 天**，请求文件超过 32MB 自动分段，启动后每 6 小时清理一次过期文件。
- 页面对超出 500 条的列表显示“已达上限”，并在悬浮提示中说明完整结构化记录保存在本地。

## 1.0.0+codex.20261017165726（2026-10-17）

- 速度估算改为稳健模型：最近有效请求样本中位数 + MAD 离群过滤。
- 单条异常样本不再直接进入紧凑条；少于 3 个有效样本显示 `--T/s`。
- 生成耗时改为重叠生成区间并集，避免条目时长叠加造成虚高。
- 新增 `compactTps`、`compactSpeedSampleCount`、`compactSpeedConfidence`、
  `compactSpeedWindow`、`turnWallTps`，保留旧速度字段以维持兼容。
- 详情速度标题增加本轮墙钟平均速度；墙钟值只使用 output tokens，不使用上下文累计量。
- 新增 12 / 60 / 220 / 900 / 1300 T/s 区间用例、单条 2351 T/s 尖峰抑制和连续高速区间切换测试。

## 1.0.0+codex.20261017163400（2026-10-17）

- 协议升级为**严格签名-only schema v3**：拒绝无 auth、坏 MAC、过期时间戳、nonce 重放与 seq 倒退；
  boot 负载也验签，事件处理先深拷贝再验证，杜绝验签绕过。
- 安装器切换新版本前会停止所有旧 `token-stats.mjs --watch` 实例，避免旧协议进程继续占用资源。
- Node 定位改为候选全量收集、只接受 `node.exe`、过滤 v22 以下并选择最高版本。
- 四个 `.ps1` 统一 UTF-8 BOM，并在 Windows PowerShell 5.1 与 PowerShell 7 双解析；
  人工确认启动改为 Unicode `start-monitor.ps1`，`launch-*.vbs` 改为 UTF-16LE，中文路径不再损坏。
- 修复混合格式当前轮累计：现代记录后的 legacy 记录按线程累计基线差值更新当前轮。
- 修复倒序轮次列表只更新最后一行的问题，改为按稳定 key 更新实际变化行。
- legacy 自身去重键纳入完整 input/output/cached 构成；同 ts 数值不同会进入真冲突计数。
- `--thread` 单次命令改为与 watch 相同的全分片合流路径。
- 快照新增 `currentTurnRequestCount`，不再用会话总请求数冒充当前提问请求数。
- 主题观察独立监听 `<html>` 的 `data-theme` / `color-scheme` 相关属性与系统主题变化；
  MutationObserver 不再对整棵 DOM 的 class/style 变化做回调。
- 健康文件每个巡检周期写入 `lastSuccessAt` 与最新 mtime；写入错误不再被空 catch 吞掉。
- 多窗口自动目标每 10 秒复核唯一焦点；焦点切换时重连，探测失败保留现有连接。
- 源码包安装增加 staging 布局生成，安装器不再假设压缩包一定含预构建 `plugins/`。
- Windows PowerShell 5.1 实跑修复：单进程对象不再依赖 `.Count`，生成 JSON 强制无 BOM，
  控制台输出使用 UTF-8，中文环境下安装输出正常。
- README、Agent 手册、迁移指南、部署说明、工程约定、技能说明与技术规格已按当前实现全面重写。

## 1.0.0（2026-09-21，准备发布）

### CDP 端口自动发现（2026-10-17）

- 监控默认以 `--port auto` 启动：读取 `ChatGPT.exe` 命令行的 `--remote-debugging-port`，不再写死 9229；
- 多个候选端口时用 `/json` 校验只选包含 `app://` 页面的那个；发现失败回退 9229；
- 断线重连时区分「Codex 未运行」与「进程存在但没有调试参数」：未运行时 5 秒重试，进程存在但无参数时 30 秒冷却；
  health 新增 `cdpPort` / `cdpPortSource`；
- `--port <n>` 仍可手动覆盖；安装器生成的 `launch-silent.vbs` / `start-monitor.cmd` 已改用 `--port auto`。

### 详情弹层磨砂玻璃（2026-10-17）

- 详情弹层改为半透明磨砂玻璃：浅色 `rgba(255,255,255,.72)` / 深色 `rgba(30,30,32,.62)` 底色 +
  `backdrop-filter: blur(14px) saturate(130%)`；
- 叠加 3.5% 静态噪点与顶部内高光，打开时 140ms 淡入 + 轻微缩放（尊重 `prefers-reduced-motion`）；
- 自适应降级：打开后采样 0.8 秒帧时间，平均 > 20ms 时自动切换为实色（`tui-glass-lite`）；
- 回退：不支持 `backdrop-filter` 或系统要求减少透明时使用实色背景；圆角保持 12px。

### 启动方式与手动启动（2026-10-17）

- **移除周期巡检**：计划任务只保留「登录时启动」触发器；安装后仍会立即启动一次。
  取消每 5 分钟的重复触发（`-WatchdogMinutes` 参数一并删除）。
- **手动启动**：详情面板「运行状态」下新增宽按钮「启动监控」；点击**复制启动命令**
  （Win+R 粘贴回车）打开确认终端（`start-monitor.cmd`），用户按 `Y` 才启动。
  复制的命令使用系统 `explorer.exe` 打开开始菜单快捷方式；`start-monitor.cmd` 固定为 ASCII + CRLF，
  避免 cmd 在 UTF-8/LF 批处理上解析错位。手工启动前执行 `--instance-status`：已有存活实例时直接退出；
  确认后通过 `launch-silent.vbs` 后台启动，确认终端以 `/c` 关闭，不留下长期 `cmd.exe` 包装器。
  同时提供开始菜单入口；另注册 `tokens-ui-for-codex://start` 作为外部入口
  （Electron 渲染进程会拦截协议导航，面板内不使用）。卸载时一并清理。
- **详情面板布局**：运行状态由 8 格精简为 6 格（移除「窗口选择」「恢复」），
  「累计重置」上移一行；异常仍由「状态」格体现。
- **失效提示**：折叠态 90 秒未收到任何推送（空闲心跳 5 秒/次）时，统计条进入降级样式并提示
  「监控可能已停止，打开详情可手动启动」；展开态不参与判断，避免误报。
- 文档更新：README / README.en / README.agent / AGENTS / DEPLOYMENT / SKILL / MIGRATION。

### 文档与署名

- 全部 Markdown 依据**当前实现**重写：`README.md` / `README.en.md` / `README.agent.md` /
  `MIGRATION-FOR-AGENTS.md` / `AGENTS.md` / `CHANGELOG.md` / `DEPLOYMENT.md` /
  `skills/tokens-ui-for-codex/SKILL.md` / `docs/*`。
- 署名统一为 **Littps**（`plugin.json` 的 `author.name` 与 `developerName`、三份 `package.json` 的
  `author`、`LICENSE`）。
- 文档中不再出现任何历史项目名称、历史文件命名或历史字段；描述对象只有当前实现。

### 速度显示改造

- **紧凑条第二行**改为 `速度 · 命中率 · 命中 · 输出`（速度取整数，形如 `362T/s`）；
  「缓存未命中」按需求从紧凑条移除（无障碍文本仍保留完整信息），详情弹层「当前提问统计」继续显示未命中。
- **悬浮冻结**：指针停留在统计条上期间，冻结对统计条的一切写入（数字 / `aria-label` / `title`），
  移出后立即补一次渲染 —— 阅读或复制时数字不再跳动。
- **详情面板速度**：当前提问统计改为「**本轮平均速度**」（Σ 本轮输出 ÷ Σ 本轮生成耗时，协议新增可空字段 `turnTps`）；
  会话累计那格为「平均速度」。两格都取自官方数据，无数据时显示 `-- Tokens/s`。
- **结论（实测）**：生成过程中的实时 T/s 在当前 Codex 渲染方式下不可行 —— 会话日志没有 delta/chunk 事件；
  页面按**节点替换**而非字符追加（25 秒窗口内子节点新增 352 个，字符变更仅 28 次、净增 13）；
  轮块文本长度在 145 ↔ 10586 之间伸缩。因此不做前端估算，只显示可对账的官方口径。

### 估算速度与有效速度拆分（2026-10-17）

- 紧凑条改为 `≈XXXT/s`，使用 Reasoning/AgentMessage 条目耗时计算生成估算速度；不包含工具执行时间，但仍可能包含网络停顿。
- 详情页改为有效速度：输出 ÷（`task_complete.duration_ms` − 工具执行时间），包含首字等待和网络等待。
- 有效速度按最近 25 个有效轮次做耗时加权；当前轮单独计算，未完成时显示 `-- Tokens/s`。
- 新增 `genEstimateTps`、`effectiveTps`、`turnEffectiveTps`、`effectiveSampleCount`、`effectiveWindow`、`speedTimingConfidence` 字段；旧字段保留兼容。
- 官方 Responses usage 已确认：`output_tokens` 包含 reasoning、格式和工具结构等全部输出 token；不得再加 `reasoning_tokens`。

### 按需窗口、快照与视觉状态（2026-10-17）

- 详情页请求明细默认 10 条、每次 +20；各轮摘要默认 10 轮、每次 +50；窗口外内容不推送。
- 新增 `last-summary.json` 脱敏简略快照：监控重启或页面重新挂载时先显示“上次数据”，随后用实时数据替换；快照只保存数字和会话哈希。
- 增加渲染签名，紧凑条在没有可见字段变化时跳过重复 DOM 写入；详情仍走既有增量更新。
- Codex++ 的 `.codex-service-tier-badge` 服务模式提示视觉隐藏，文字移入详情副标题；详情标题旁新增绿/黄/红健康指示灯。

### 按需加载与推送节奏

- 请求明细与各轮摘要支持**按需加载**：关闭态只推 5 轮；打开推 10 轮 + 10 条明细；
  「加载更多」每次 +50 轮 / +20 条；上限各 500。未展示的数据**不推送**。
- 两个列表统一**倒序**（最新在最上面），按钮显示"已加载最新 N / 共 M"。
- 页面用 `<html data-tui-window="turns:requests">` 表达窗口，监控每秒读取并按需回推；上限由监控通过
  `turnsLimit` / `requestsLimit` 下发。
- **三段心跳**：数据变化立即推送；检测到任务运行中 1 秒心跳；空闲 5 秒心跳；
  **展开态不参与心跳**（该负载只在真正变化时推送）。
- 会话切换由监控下发一次性 `sessionChanged`，面板据此复位窗口与翻页进度。

### 统计正确性

- **轮次归属统一**：轮次列表以宿主写出的 `turn_context` 为权威来源（携带 `turn_id`、覆盖日志开头、
  含"没有任何用量记录的空轮"）；记录按 `turn_id` 归属，无 `turn_id` 的 legacy 记录按时间窗归属；
  仅当整份日志没有 `turn_context` 时才退回 `user_message` 分界。旧实现并行使用两套建轮规则，
  会填充空轮并让 `currentTurn` 指向空轮（面板当前提问恒为 0）。
- **混合格式合并**：两代事件格式（`token_count` / `token_usage_record`）统一合并，legacy 记录按
  **一对一认领**分类为 echo / replay / unique；`requestCount = modern 去重数 + unique 补录数`，
  `sessionTotal = 逐请求 total 前缀和`（偏差 0）。详见 `docs/F1-merge-spec.md`。
- **会话分片**：宿主切分超大会话时自动归组、合并、按内容键去重；停滞判据用最新分片的 mtime。
- **两级停滞告警**：5 分钟无新增仅写日志预警；15 分钟降级 `stale-data`；恢复后自动回 `healthy`。

### 界面与交互

- 统计条固定在输入区右下、上下文用量圆圈左侧，使用宿主主题变量（深浅色跟随宿主）。
- 详情弹层改为「骨架一次构建 + 数据增量更新」：数值更新不再重建 DOM；列表仅在结构变化时重建，
  并保持滚动位置与展开状态。
- 关闭方式只保留「点击外部」与「右上角 ×」；**插件不注册任何键盘监听**（无 Enter/空格/Esc 处理）。
- 「运行状态」分区位于「上下文使用」之下，含状态 / 监控 / 页面连接 / 数据 / 窗口选择 / 模型切换次数 /
  累计重置次数 / 恢复。
- 标识符彻底统一：事件 `tokens-ui-for-codex`、全局 `window.__tuiForCodex`、
  面板脚本 `tokens-ui-for-codex-panel.js`；不保留任何历史别名或历史字段兼容。

### 运行方式

- 计划任务 `tokens-ui-for-codex-monitor`：安装后立即执行一次 + 每 5 分钟兜底巡检 + 登录时启动；
  动作是 `wscript.exe → launch-silent.vbs → node`（无窗口、不经 PowerShell、不受执行策略影响）；
  重复实例策略「不启动新实例」，失败重启 3 次 / 间隔 1 分钟；用户级，不需要管理员权限。
- 不再使用常驻 PowerShell 守护进程（旧守护进程文件已删除）。
- 监控日志自管：`%LOCALAPPDATA%\tokens-ui-for-codex\logs\watch-YYYY-MM-DD.log`
  （按日、超 1MB 轮转、保留最近 30 份）。

### 验证

| 项目 | 结果 |
| --- | --- |
| 语法检查 | 通过 |
| 单元测试 `npm test` | **47/47** |
| 行为基线 `golden-baseline.mjs --check` | **31/31 一致，0 不一致** |
| 实机验收 `verify-live.mjs` | **13/13，failed = 0** |
| Playwright 实机用例 | 11 通过 / 2 跳过 / 0 失败 |
| 副本一致性 `verify-sync.mjs` | `mismatches = 0` |
| 实机多重测试 | 修复后累计 41 轮 0 失败 |

---

## 1.0.0-Alpha-3（2026-09-19）

- **会话分片支持**：适配宿主对超大会话的文件切分（`_<分段UUID>` 后缀、换日期目录），归组同一会话
  全部分片并合并统计，修复面板曾停滞 3.5 小时、健康值仍显示 `healthy` 的静默失效。
- **两级停滞告警 + 定位诊断**：5 分钟仅写日志、15 分钟才降级；定位失败时记录最近文件样本，
  发现"疑似本会话但未被识别"的文件时输出定位预警。
- **TPS 刷新修复**：移除渲染的 `dataKey` 门控，数据事件一律走增量渲染，修复"速度不随数据刷新"。
- **挂载收敛修复**：`mount()` 的位置判据归一化，`MutationObserver` 忽略面板自身移动，消除锚点结构
  异常时"每帧重挂载"的循环（同一实验：修复前 2.5 秒 128 次移动，修复后 2 次并收敛）。
- **详情弹层增量渲染**：骨架一次构建、数据增量更新，数值更新约 0.7ms（原全量重建约 17ms）。
- **键盘监听移除**：统计条与弹层不再注册任何按键监听（Esc 不再关闭弹层）。
- **安装/卸载完善**：`find-codex.ps1` 统一运行时定位（含 Codex++ 状态与用户脚本总开关检查）、
  `verify-sync.mjs` 比对文件扩到 7 个、卸载脚本新增 `-RemoveUserScript` / `-RemovePlugin`。

## 1.0.0-Alpha-2（2026-09-19）

- 标识符统一为 `tui` / `tokens-ui-for-codex` 命名，面板脚本改名为 `tokens-ui-for-codex-panel.js`。
- 实机测试套件修正过时断言（隐私白名单补齐 TPS / 命中率字段；Esc 用例改为断言"不关闭弹层"）。
- 深色 / 浅色主题跟随宿主变量；详情弹层分区与标题对齐原生风格。

## 1.0.0-Alpha-1（2026-09-17）

- 首个公开版本：统计条移到输入区右下、上下文用量圆圈左侧，使用原生横向布局与主题变量。
- 左键单击打开详情弹层（会话累计 / 当前提问统计 / 上下文使用 / 运行状态 / 请求明细 / 各轮摘要）。
- 页面负载升级为 schema v2，只含数字、时间标签与轮次摘要；不包含会话路径、线程 ID 或用户消息正文。
- 审计整改：混合格式统计合并（F1）、接上 `stale-data` 与模型切换/累计重置计数（F3）、监控自管日志（P1）、
  安装器缺少 Node 时明确报错中止、新增 `scripts/verify-sync.mjs`。
