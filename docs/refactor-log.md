# 核心重构进度日志

## 目标

把项目里继承自上游 `ccm-token-spend` 的实现替换为独立实现，同时**保证对外行为完全不变**。

保留的继承代码约 1019 行，其中 `token-stats.mjs` 内约 453 行，按函数分布如下（重构前统计）：

| 代码块 | 保留行数 | 保留比例 | 风险 |
| --- | --- | --- | --- |
| 线程 ID 检测（DOM / React fiber 扫描） | 129 | 98% | 高 |
| 主循环 `main()` | 111 | 86% | 中高 |
| 客户端状态映射 | 约 50 | 80%+ | 中 |
| 格式化 / 打印 / 文件发现 | 约 120 | 60–100% | 低 |
| CDP 辅助、参数解析 | 约 40 | 30–80% | 低 |

## 方法

1. **行为基线先行**：用本机 27 个真实会话（75 MB）冻结成快照，跑 31 个命令行用例，
   把输出的 SHA-256 固化为 `test/golden/cli-baseline.json`。
2. **逐块替换**：每完成一块就运行 ①语法检查 ②单元测试 ③行为基线 ④必要的实机冒烟。
3. **契约冻结**：CLI 参数与输出格式、payload schema v2、状态文件路径与字段、计划任务名、退出码均不得改动。
4. **不做顺手优化**：重构期间只做等价替换；发现的改进点另开一轮。

## 验证命令

```powershell
node --check token-stats.mjs                       # 语法
npm test                                           # 单元测试（34 项）
node scripts\golden-baseline.mjs --check           # 行为基线（必须 0 不一致）
node scripts\golden-baseline.mjs --check --refresh-corpus   # 需要重建语料快照时
```

> 基线脚本会把语料冻结到 `%TEMP%\ccm-golden-corpus` 并**重复复用**。
> 这是必要的：正在进行的会话文件会持续增长，每次重新复制语料会把「会话变长」
> 误判成「实现改坏」。需要更新语料时显式加 `--refresh-corpus`。

## 进度

| # | 代码块 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0 | 行为基线 | ✅ 完成 | 31 个用例；连续 3 次校验全绿，证明可复现 |
| 1 | 格式化与 CLI 打印 | ✅ 完成 | `labelOf`→`clockLabel`、`fmtInt`→`groupedInteger`、`fmtShort`→`compactNumber`；`printStats` 改为「先收集行再一次性输出」，字节输出等价；同步 5 处调用点 |
| 2 | 文件发现与会话定位 | ✅ 完成 | 递归遍历改为**迭代式栈遍历**（跳过符号链接目录）；`resolveFile` 拆为 `locateThreadFile` + `newestRolloutFile`；新增常量 `ROLLOUT_FILE_RE` |
| 3 | 客户端状态映射 | ✅ 完成 | 新增 `readClientStateFile`；`pruneClientState` 改为候选表 + `dropStale` 双向裁剪；常量抽出 `CLIENT_NEW_THREAD_PREFIX` / `CLIENT_UUID_RE` / `CLIENT_FILE_CREATE_SLACK_MS` |
| 4 | CDP 辅助与线程 ID 检测 | ✅ 完成 | 注入页面的表达式整体重写：`norm`→`normalizeThreadId`、`elConv`→`threadIdFromElement`、`confirm`→`rememberActiveThread`、`hasThreadMarker`→`touchesThreadMarker`；选择器与属性名抽成常量表；`firstQuery` 统一选择器轮询；哨兵改为 `BLANK_CONVERSATION` 常量 |
| 5 | 主循环 `main()` | ✅ 完成 | 285 行拆成 9 个具名函数：`printAllThreads` / `reportRuntimeWarnings` / `assertCdpRuntimeAvailable` / `createWatchSession` / `resolveWatchThread` / `readWatchStats` / `nextWatchHealth` / `buildWatchKey` / `logStatsAnomalies` / `publishWatchRound` / `handleWatchError` / `runWatchRound` / `runWatchLoop`；跨轮状态收进 session 对象；`main()` 只剩入口分发 |

## 已完成的验证记录

### 块 1（格式化与打印）

- `node --check`：通过
- `npm test`：34/34 通过
- 行为基线：31/31 一致，0 不一致
- 额外冒烟：`node token-stats.mjs --watch`（隔离状态目录）运行 8 秒无崩溃，
  日志正常输出 `会话累计 431.35M tokens / 1418 次请求`（该行正是新实现打的）

### 块 2（文件发现与会话定位）

- `node --check`：通过
- `npm test`：34/34 通过
- 行为基线：31/31 一致，0 不一致
- 额外结论：把递归遍历换成迭代式栈遍历后输出仍然逐字节一致，
  说明文件枚举顺序不影响任何对外可见结果

### 块 3（客户端状态映射）

- `node --check`：通过
- `npm test`：34/34 通过
- 行为基线：31/31 一致，0 不一致

### 块 4（CDP 辅助与线程 ID 检测）

这一段无法用命令行基线覆盖（它跑在 Codex 页面里），因此新增了实机差分探针
`scripts/probe-active-thread.mjs`：从 `token-stats.mjs` 里抽出注入表达式，在真实页面上执行。

| 步骤 | 结果 |
| --- | --- |
| 改写前探针（3 次） | `01a09af7-dad0-7662-9172-0be0345effdd`（与当前对话一致，稳定复现） |
| 改写后探针（3 次） | 同上，完全一致 |
| `node --check` | 通过 |
| `npm test` | 34/34 通过 |
| 行为基线 | 31/31 一致，0 不一致 |

> 探针开发中发现的真实细节：`${NEW_THREAD}` 在源码里嵌在字符串字面量内部
> （`return "${NEW_THREAD}";`），抽表达式时必须按原文替换，不能加引号包装。
> 这个坑如果不踩一次，探针会一直报页面语法错误。

> 覆盖边界：探针只验证了「当前这一种 DOM 状态」（侧边栏存在、对话有内容）。
> 空白新对话、侧边栏收起、多窗口这几条分支没有在实机上跑到，属于残留风险，
> 需要在实际使用中留意（面板显示 0 或不更新时优先怀疑这几条分支）。

### 块 5（主循环）

- `node --check`：通过
- `npm test`：34/34 通过
- 行为基线：31/31 一致，0 不一致
- 冒烟（隔离状态目录，各 10 秒）：
  - `--watch`：正常输出「监控启动」「会话累计 452.60M tokens / 1465 次请求」
  - `--watch --cdp`：正常输出「已推送: 累计 452.60M tokens，状态 healthy」＋错峰回声日志，
    并在 3 秒后按数据变化再次推送
- 重构中对 `main()` 的一处等价简化：原实现里 `thread === NEW_THREAD`、占位对话、
  启动加载期三个分支都返回同一个 `emptyStats(null, null)`，合并为一条判断（行为不变）

## 部署记录

1. 备份运行中版本 → `plugins\tokens-ui-for-codex\token-stats.mjs.before-refactor-20260917-153827.bak`
2. 同步新代码到部署目录，源码与部署 SHA-256 一致：
   `2A451D0151DB01856D954A4D79C5DEE45D56429B08818F4CA4B5F8B3140BC4AA`
3. 运行 `install-autostart.ps1`：停掉旧实例 PID 36232 → 计划任务拉起新实例 PID 29892
4. 健康状态：`healthy`，`cdpReachable` / `pageAttached` / `dataFresh` 均为 true
5. 刷新 Codex 页面（`npm run reload`）后跑 `scripts/verify-live.mjs`：**failed = 0**
   （统计条存在、详情分区顺序正确、会话累计含请求数量、Esc 可关闭详情）

## 回滚

- 基线快照：桌面 `重构0版本\`（34.2 MB 文件夹）与 `重构0版本.zip`
- git：本仓库 `fe3c584` 即重构前状态；`git checkout .` 可丢弃重构期间的全部改动
