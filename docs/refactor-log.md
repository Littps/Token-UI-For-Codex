# 核心重构进度日志

作者：**Littps**。本文件记录"把核心脚本逐块重写为独立实现"这一轮工作的目标、方法与验证证据。

## 目标

保证**对外行为完全不变**的前提下，把核心脚本的每个代码块替换为独立实现：
CLI 参数与输出格式、payload schema v2、状态文件路径与字段、计划任务名、退出码均冻结不动。

仓库内**不再保留**任何历史归档、历史分支或历史文件名；旧分支与旧标签已从版本库物理移除
（`reflog expire` + `gc --prune=now`），历史快照目录已删除而不是归档。

## 方法

1. **行为基线先行**：用本机真实会话冻结成快照语料，跑 31 个命令行用例，
   把输出的 SHA-256 固化为 `test/golden/cli-baseline.json`。
2. **逐块替换**：每完成一块就运行 ①语法检查 ②单元测试 ③行为基线 ④必要的实机冒烟。
3. **契约冻结**：CLI 参数与输出格式、payload schema v2、状态文件路径与字段、
   计划任务名、退出码都不得改动。
4. **不做顺手优化**：重构期间只做等价替换；发现的改进点另开一轮（见 `CHANGELOG.md`）。

## 验证命令

```powershell
node --check token-stats.mjs                       # 语法
npm test                                           # 单元测试（当前 47 项）
node scripts\golden-baseline.mjs --check           # 行为基线（必须 0 不一致）
node scripts\golden-baseline.mjs --check --refresh-corpus   # 需要重建语料快照时
```

> 基线脚本会把语料冻结到 `%TEMP%\tui-golden-corpus` 并**重复复用**。
> 这是必要的：正在进行的会话文件会持续增长，每次重新复制语料会把"会话变长"
> 误判成"实现改坏"。需要更新语料时显式加 `--refresh-corpus`。

## 进度

| # | 代码块 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0 | 行为基线 | ✅ 完成 | 31 个用例；连续多次校验全绿，证明可复现 |
| 1 | 格式化与 CLI 打印 | ✅ 完成 | `labelOf`→`clockLabel`、`fmtInt`→`groupedInteger`、`fmtShort`→`compactNumber`；`printStats` 改为"先收集行再一次性输出"，字节输出等价 |
| 2 | 文件发现与会话定位 | ✅ 完成 | 递归遍历改为**迭代式栈遍历**（跳过符号链接目录）；`resolveFile` 拆为 `locateThreadFile` + `newestRolloutFile`；新增常量 `ROLLOUT_FILE_RE` |
| 3 | 客户端状态映射 | ✅ 完成 | 新增 `readClientStateFile`；`pruneClientState` 改为候选表 + `dropStale` 双向裁剪；常量抽出 `CLIENT_NEW_THREAD_PREFIX` / `CLIENT_UUID_RE` / `CLIENT_FILE_CREATE_SLACK_MS` |
| 4 | CDP 辅助与线程 ID 检测 | ✅ 完成 | 注入表达式整体重写：`norm`→`normalizeThreadId`、`elConv`→`threadIdFromElement`、`confirm`→`rememberActiveThread`、`hasThreadMarker`→`touchesThreadMarker`；选择器与属性名抽成常量表；哨兵改为 `BLANK_CONVERSATION` 常量 |
| 5 | 主循环 `main()` | ✅ 完成 | 拆成具名函数：`printAllThreads` / `reportRuntimeWarnings` / `assertCdpRuntimeAvailable` / `createWatchSession` / `resolveWatchThread` / `readWatchStats` / `nextWatchHealth` / `buildWatchKey` / `logStatsAnomalies` / `publishWatchRound` / `handleWatchError` / `runWatchRound` / `runWatchLoop`；跨轮状态收进 session 对象；`main()` 只剩入口分发 |

## 分块验证记录

### 块 1（格式化与打印）

- `node --check` 通过；`npm test` 全绿；行为基线 31/31 一致
- 冒烟：`--watch`（隔离状态目录）运行 8 秒无崩溃，日志正常输出会话累计行

### 块 2（文件发现与会话定位）

- `node --check` 通过；`npm test` 全绿；行为基线 31/31 一致
- 结论：把递归遍历换成迭代式栈遍历后输出仍**逐字节一致**，说明文件枚举顺序不影响对外可见结果

### 块 3（客户端状态映射）

- `node --check` 通过；`npm test` 全绿；行为基线 31/31 一致

### 块 4（CDP 辅助与线程 ID 检测）

这一段无法用命令行基线覆盖（它跑在 Codex 页面里），因此新增实机差分探针
`scripts/probe-active-thread.mjs`：从 `token-stats.mjs` 里抽出注入表达式，在真实页面上执行。

| 步骤 | 结果 |
| --- | --- |
| 改写前探针（3 次） | 解析出的对话 ID 与当前对话一致，稳定复现 |
| 改写后探针（3 次） | 与改写前完全一致 |
| `node --check` / `npm test` / 行为基线 | 通过 / 全绿 / 31-31 一致 |

> 探针开发中发现的真实细节：`NEW_THREAD` 常量在源码里嵌在字符串字面量内部
> （`return "${NEW_THREAD}";`），抽表达式时必须按原文替换，不能加引号包装，
> 否则探针会一直报页面语法错误。

> 覆盖边界：探针只验证了"当前这一种 DOM 状态"（侧边栏存在、对话有内容）。
> 空白新对话、侧边栏收起、多窗口这几条分支没有在实机上跑到，属于残留风险 ——
> 面板显示 0 或不更新时优先怀疑这几条分支。

### 块 5（主循环）

- `node --check` 通过；`npm test` 全绿；行为基线 31/31 一致
- 冒烟（隔离状态目录，各 10 秒）：
  - `--watch`：正常输出「监控启动」与会话累计行
  - `--watch --cdp`：正常输出推送行（含状态与错峰回声日志），并在数据变化后再次推送
- 等价简化：`thread === NEW_THREAD`、占位对话、启动加载期三个分支都返回同一个
  `emptyStats(null, null)`，合并为一条判断（行为不变）

## 当前状态

- 重构块 1–5 全部完成并逐块通过"语法 + 单测 + 行为基线"三重校验；早期按行数统计的进度口径已失效，
  不再维护该计数。
- 现行门禁（2026-09-21）：`npm test` **47/47**、行为基线 **31/31 一致**、
  `verify-live` **13/13**、Playwright 实机 **11 通过 / 2 跳过 / 0 失败**、
  五处副本 `mismatches = 0`。
- 重构之后的增量改动（速度口径、按需加载、三段心跳、轮次归属统一等）见 `CHANGELOG.md`；
  统计口径以 `docs/F1-merge-spec.md` 为准。
