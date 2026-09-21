# AGENTS.md —— 仓库内 Agent 工作约定

> 写给在本仓库工作的 Agent：改代码、跑测试、部署或发布前先读完本文件，**不要凭记忆操作**。
> 项目：**Tokens UI For Codex**（作者 **Littps**，许可 MIT）。

## 1. 项目定位

- 在 Codex / ChatGPT **桌面版**中显示当前会话的 Token 用量：输入区右下角的紧凑统计条 + 可点击的详情弹层。
- **仅支持桌面版**；不支持 codex CLI 的终端界面。
- **依赖 Codex++**：统计条以 Codex++ 用户脚本形式注入（`%APPDATA%\Codex++\user_scripts\`）。未安装 Codex++ 时本项目不可用。
- 不修改 Codex 的 React bundle、不注册键盘监听、不写 Codex 的 `config.toml`。
- 页面负载只含数字统计、时间标签、轮次摘要与当前轮有限请求明细；**不含**会话文件路径、线程 ID、用户消息正文、Token 或凭据。

## 2. 目录结构

- `tokens-ui-for-codex-panel.js` —— 面板 UI（Codex++ 用户脚本）。
- `token-stats.mjs` —— 监控进程：读会话日志统计，经 CDP 推送 schema v2 负载。
- `protocol.mjs` / `schemas/payload-v2.schema.json` —— 协议契约与 JSON Schema。
- `find-codex.ps1` / `install.ps1` / `install-autostart.ps1` / `uninstall-autostart.ps1` / `install.bat` —— 运行时定位与安装卸载。
- `scripts/` 工具与校验脚本、`test/` 测试、`docs/` 规格与记录、`.github/` CI。
- 源码树**不含**预编译 exe、`node-version\`、`release\`、`build\`；发布包由 `scripts\build-package.ps1`（部署包）与 `scripts\build-source-package.ps1`（源码包）生成。
- `skills/tokens-ui-for-codex/SKILL.md` 只存在于**部署包与插件 cache**，源码树不含 `skills\`。

## 3. 工作原理（改代码前必须知道）

### 3.1 数据链路

```text
本地会话日志(.jsonl) -> token-stats.mjs 统计 -> CDP(127.0.0.1:9229) -> window.__tuiForCodex + 事件 tokens-ui-for-codex -> 面板增量渲染
```

- 监控只提取结构化字段，不复制、不展示、不外传正文。
- 页面与监控之间是**单向推送**（监控 → 页面）；页面只能通过 `<html data-tui-window>` 反向表达"想看多少条"。

### 3.2 推送节奏（三段心跳）

| 状态 | 间隔 |
| --- | --- |
| 数据变化 | 立即推送 |
| 检测到任务正在运行 | 1 秒心跳 |
| 空闲 | 5 秒心跳 |
| 展开态（窗口大于默认档） | **不参与心跳**，仅变化时推送 |

心跳只重发最后一份负载，不重新解析未变化的会话文件。监控日志只记录"数据变化"的推送，**心跳是静默的**——不要用日志时间戳去测心跳频率。

### 3.3 按需窗口（页面 → 监控的信号）

- 面板把所需条数写进 `<html data-tui-window="turns:requests">`，监控每秒读一次；窗口变化立刻推送。
- 弹层关闭：5 轮 / 0 条明细；打开：25 轮 / 10 条明细；「加载更多」每次 +50 轮 / +20 条。
- 上限由监控下发（`turnsLimit` / `requestsLimit`，各 500）；未展示的部分不推送。
- 会话切换时监控下发一次性 `sessionChanged: true`，面板据此复位窗口与翻页进度。

### 3.4 轮次归属

- 轮次列表以 `turn_context` 事件为**权威来源**：宿主逐轮写出、携带 `turn_id`、覆盖日志开头，且包含「没有任何用量记录的空轮」。
- 记录按 `turn_id` 精确归属；无 `turn_id` 的 legacy 记录按「开始时间 ≤ 记录时间」落到所属轮；仅当整份日志没有 `turn_context` 时才退回 `user_message` 分界。
- **禁止**把「有 `turn_id` 就新建轮」与「无 `turn_id` 按数组下标」两套规则并行写进同一个轮次数组——会填充空轮，让 `currentTurn` 指向空轮（面板当前提问恒为 0）。
- 排序键统一为 `(ts, ordinal)`；`ordinal` 是宿主全局事件序号，跨分片合并后仍是全序。

### 3.5 统计口径

- 以 `docs/F1-merge-spec.md` 为准：两代事件格式（`token_count` / `token_usage_record`）统一合并，累计量走 reset-aware 归一化，**禁止单调递增假设**。
- 计数不变量：`requestCount = modern 去重数 + unique 补录数`；`sessionTotal = 逐请求 total 前缀和`（偏差 0）。
- 速度口径：当前提问「本轮平均速度」= Σ本轮输出 ÷ Σ本轮生成耗时；会话累计「平均速度」= Σ会话输出 ÷ Σ会话生成耗时。

### 3.6 增量解析与会话分片

- 增量解析器记录文件偏移 + 半行缓存 + 文件指纹；截断、重建、同长度替换一律按新基线重建，不沿用旧统计。
- 宿主会切分超大会话（文件名追加 `_<分段UUID>`、可能换日期目录）；监控归组同一会话全部分片、合并后统计，停滞判据使用**最新分片**的 mtime。
- 两级停滞告警：5 分钟无新增仅写日志预警；15 分钟降级为面板 `stale-data`；恢复后自动回 `healthy`。

### 3.7 运行与自启

- 计划任务 `tokens-ui-for-codex-monitor`：触发为「安装完成后立即执行 + 每 5 分钟兜底巡检 + 登录时启动」。
- 任务动作是 `wscript.exe → launch-silent.vbs → node`（无终端窗口、不经 PowerShell、不受执行策略影响）；重复实例策略「不启动新实例」；失败重启 3 次 / 间隔 1 分钟；运行级别 Limited，**不需要管理员权限**。
- **项目不使用常驻 PowerShell 守护进程**（历史 `guardian.ps1` 已删除），不要再引入同类常驻守护。
- 状态目录 `%LOCALAPPDATA%\tokens-ui-for-codex\`：`monitor-health.json`、`autostart-state.json`、
  `client-thread-map.json`（占位对话映射，按需生成）、`logs\watch-YYYY-MM-DD.log`
  （按日；超过 1MB 时轮转为 `*.log.<时间戳>`；保留最近 30 份 `watch-*` / `monitor-*` 文件）。

## 4. 修改约定（必须遵守）

- 编辑 JS 或含中文的文件必须用 Node `fs.writeFileSync`（UTF-8）；不要用 PowerShell 直写，否则中文会坏。
- 改完保持**四处生效副本同步**：源码树 / 部署包 / 插件 cache / `%APPDATA%\Codex++\user_scripts\`。
  用 `node scripts\verify-sync.mjs --deploy "<部署根>" [--zip <包路径>]` 校验，`mismatches` 必须为 0。当前比对 7 个文件：
  `token-stats.mjs`、`tokens-ui-for-codex-panel.js`、`protocol.mjs`、`find-codex.ps1`、`install.ps1`、`install-autostart.ps1`、`uninstall-autostart.ps1`。
- 写用户脚本、停/起监控进程、注册计划任务都是用户级操作，不需要管理员权限；受限沙箱里可能需要向用户申请文件或进程权限。
- 沟通用中文；**不主动 git commit / push**；用户说打包时才打包。
- **发现问题先报告再修**；不要顺手改用户没要求的部分。
- 提交/发布前检查是否残留本机敏感信息（真实用户目录、Token、密钥、邮箱、私网地址、带凭据的 URL）。

## 5. 测试与门禁

| 命令 | 内容 | 当前基线 |
| --- | --- | --- |
| `npm run check` | 三个 JS 文件语法检查 | 全部通过 |
| `npm test` | 单元测试（`node:test`） | **47/47** |
| `node scripts\golden-baseline.mjs --check` | 行为基线（CLI 输出哈希） | **31/31，0 不一致** |
| `node scripts\verify-live.mjs` | 页面实机验收 | **13/13，failed = 0** |
| `npm run test:live` | Playwright 实机用例 | 11 通过 / 2 跳过（真实输入用例默认跳过） |
| `node scripts\verify-sync.mjs --deploy "<部署根>"` | 副本一致性 | `mismatches = 0` |
| `npm run perf -- 20000` | 本地脱敏性能基准 | 无第三方运行时依赖 |

硬规矩：

- **时序 / 心跳类断言必须多轮实机（≥ 5 轮）**，单轮通过不算。历史上出现过"单轮绿、多轮间歇失败"的用例（无效负载被 1 秒心跳覆盖）。
- **禁止改期望值来适配实现**；期望值只能来自规格推导或实测真值对照。
- **禁止凭记忆打补丁**；不确定就重读源码 / 日志 / 规格。
- 测试全绿不等于验收通过：涉及数字口径的改动必须附"同一会话改前 / 改后真值对照"。
- 真实输入用例默认不跑：CDP 注入的 Escape 会被 Codex 当成「停止回答」，字符注入会污染输入框；需要时显式设 `TUI_ALLOW_REAL_INPUT=1`。
- 实机测试必须带 `--test-force-exit`，否则 CDP 连接会阻止进程退出。
- 行为基线语料冻结在 `%TEMP%\tui-golden-corpus` 并重复复用；要更新语料时显式加 `--refresh-corpus`（否则"会话变长"会被误判成"实现改坏"）。

## 6. 面板设计约定

- 统计条固定在**输入区右下、上下文用量圆圈左侧**：第一行 `会话 / 当前提问 / 请求`，第二行 `速度 · 命中率 · 命中 · 输出`（「缓存未命中」已从统计条移除，详情弹层仍保留）。
- 使用宿主主题变量，深浅色都跟随宿主；无独立悬浮窗、拖拽、缩放、位置记忆。
- 指针停留在统计条上时**冻结写入**（数字 / `aria-label` / `title`），移出后立即补一次渲染。
- 详情弹层用 `role="dialog"`，只支持「点击外部」与「右上角 ×」关闭；**不注册任何键盘监听**（无 Enter / 空格 / Esc 处理）。
- 详情弹层是「骨架一次构建 + 数据增量更新」；列表仅在结构变化（条数 / 首尾序号 / 截断标志 / 总数）时重建，并保持滚动位置与展开状态。
- 列表倒序（最新在最上面）：请求明细默认 10 条、「加载更多」+20；各轮摘要默认 25 轮、「加载更多」+50。
- **不要重新引入前端实时估算**：在当前 Codex 渲染方式下不可行（日志没有逐块事件；页面按节点替换而非字符追加，实测 25 秒窗口内子节点新增 352 个而字符净增 13）。速度只显示可对账的官方口径，无数据时显示 `-- Tokens/s`。
- 多窗口默认选唯一焦点目标，其次唯一可见目标；无法唯一判断时报 `CDP_TARGET_SELECTION_REQUIRED`，不得随机选。
- 启动加载期读不到对话 ID 时显示 0，不回退到上一条对话的数据。

## 7. 运行时注意事项

- 只读排查脚本：`node scripts\check-page-state.mjs`、`node scripts\close-detail-dialog.mjs`、`node scripts\reset-page-input-state.mjs`。
- `npm run reload` 重载 Codex 渲染页面后常停在新对话页，需要用 DOM 点击侧栏标题恢复会话（见 `scripts\reload-page.mjs`）。
- MSIX 虚拟化：在 Codex 应用上下文里读 `%LOCALAPPDATA%` 可能看到包 LocalCache 的陈旧副本；结论前必须与非打包进程读数或活体日志交叉验证。
- `NODE_OPTIONS` 可能让子 Node 进程继承 `--inspect-port=127.0.0.1:9229`，与 Codex 的 CDP 端口相同；连不上时先确认端口占用方。CDP 目标列表：`http://127.0.0.1:9229/json/list`。
- `cdpEval` 有表达式白名单（必须以 `JSON.stringify(` / `(function ()` 等开头），否则抛 `CDP_EXPRESSION_BLOCKED`。
- 插件版本号写在 `.codex-plugin/plugin.json` 的 `version`，它决定插件 cache 目录名；改版本号后必须重新 `marketplace add` + `plugin add`。
- 页面诊断字段：`window.__tuiForCodexStatus`（`""` 表示正常；其余为 `anchor-missing` / `mount-point-missing` / `insert-failed` / `mount-crashed`）；协议探针为 `window.__tuiForCodex`、`window.__tuiForCodexProtocol`、`window.__tuiForCodexNativeUiInstalled`。
