# F1 规格：混合日志格式的统计合并

## 背景

会话日志存在两代事件格式，同一会话可能同时出现（例如 Codex 引擎升级或回退）：

- **A 类（legacy）**：`event_msg` / `payload.type = token_count`
  - 逐请求量：`payload.info.last_token_usage`
  - 线程累计：`payload.info.total_token_usage`、`payload.info.model_context_window`
- **B 类（new）**：`token_usage_record`
  - 逐请求量：`payload.usage`
  - 线程累计：`payload.thread_token_usage`；轮次累计：`payload.turn_token_usage`

旧实现二选一：只要存在任一 B 类记录，就整体丢弃 A 类（`toParsed()` 把 counts 置空，`token_count` 分支又被 `state.usageRecords.length` 提前 return）。结果是混合会话只统计到 B 类部分。

## 规则

**R1 时间轴统一**：A、B 两类事件按 `timestamp` 稳定排序；同一时间戳时 A 在前、B 在后。乱序不丢数据（排序即可消除顺序影响）。

**R2 累计链（接续 / 重启）**：去重后按时间序扫描累计值，维护一条统一累计链：

- 累计值**上升** → 视为接续，只把增量（`v - 上一次值`）计入总量；
- 累计值**下降** → 视为重启，把新基线整体计入总量，并记一次 reset 事件（线程与轮次各自计数）。

**禁止任何“累计必然单调递增”的假设**（压缩、重置都会让累计下降）。

**R3 分类（一对一认领；时间不参与身份判定）**：

- 内容 key = `线程累计 | 本轮量`（A：`info.total_token_usage.total_tokens` + `info.last_token_usage.total_tokens`；
  B：`thread_token_usage.total_tokens` + `usage.total_tokens`）——与参考脚本 `lag-methods.cjs` / `classify.cjs` 对齐
- A 类先按 `ts|total|lastTotal` 指纹去重（legacy 自身重复），再逐条按时间序认领新格式本体
- 新格式是权威流：B 类自身按 `response_id`（无 id 时 `ts|total|turn_id`）与内容 key 去重

### 一对一认领表（每条 legacy 记录只落入一条）

| # | 判定 | 处理 | requestCount | sessionTotal |
|---|---|---|---|---|
| 1 | 同内容 key 且**尚未被认领**的本体存在 → **echo** | 认领该本体（本体只能被认领一次；多具时取时间最近的一具），计入 `echoStats` | +0 | +0 |
| 2 | 同内容 key 的本体存在但**都已被认领** → **replay** | 计入 `replayStats`（不再算请求） | +0 | +0 |
| 3 | 新格式里**没有该 key** → **unique** | 作为独立请求补录 | +1 | 走累计链（R2） |
| 3b | unique 且该 key 已在 unique 桶出现过 → **自身重复** | 计入 `uniqueStats.selfDuplicate` | +0 | +0 |
| 4 | 同 response_id 或同内容 key（同格式内重复） | 去重，原样不变 | +0 | +0 |

**相加只能来自"累计下降 + 新 key"**（R2）；上升场景出现相加即为缺陷。

**结构不变量**：`echoStats.total = 被认领的本体数`；`echo + replay + unique = legacy 去重后总数`；
`legacy 去重后 + 自身重复 = legacy 指纹去重后条数`。

**R4 会话总量**：取累计链终值；该值等于逐请求 `total` 的前缀和（与实机核对口径一致）。逐请求只累加 `input/output/cached`。

**R5 轮次归属**：优先 `turn_id`；缺失时按 `user_message` 时间分界；跨格式共用同一分界逻辑。

**R6 可观测（回声 / 重放 / 补录分开）**：

- `echoStats = { total, lagMaxMs, overThreshold, thresholdMs, topLag }`：**回声（正常现象）**，用于健康度。
  阈值 `thresholdMs = ECHO_LAG_THRESHOLD_MS`（60 秒）。统计范围**按会话**（每次 `buildStats` 从会话日志重算，不按监控进程累计）。
  `topLag` = 滞后最大的前 3 条时间戳（供日志）；**只在 `overThreshold > 0` 时打一行日志**并附 top-3。
- `replayStats = { count, lagMaxMs }`：**重放陈旧度**（本体已被更早的 legacy 认领），**不混进 echoStats**。
- `uniqueStats = { count, selfDuplicate }`：无本体补录数（净计数）与自身重复数。
- `legacyStats = { raw, deduped, claimedModern }`：结构不变量核对用。
- `formatConflictCount`：**真冲突** —— 同 `response_id` 但数值不同，或同 `ts` 但数值不同。**非 0 即报警**。

**R7 截断/半行/重建**：沿用 `IncrementalRolloutParser` 现有语义（偏移 + 半行缓存 + 文件指纹），文件被截断或重建时按新基线重新统计。

**R8 上限**：请求明细最多保留最近 100 条/当前轮，历史轮只保留聚合值。

## Fixture 矩阵

每条 fixture 断言 `requestCount` 与 `sessionTotal`（部分另外断言 `cumulativeResetCount` / `formatConflictCount`）。

| # | 场景 | 输入要点 | 期望 |
|---|---|---|---|
| 1 | legacy-only | token_count 累计 100 → 300 → 600 | 3 次请求，sessionTotal=600，reset=0 |
| 2 | new-only | usage_record 线程累计 120 → 300 → 600 | 3 次请求，sessionTotal=600，reset=0 |
| 3 | 旧 → 新（升版） | 旧 1,000,000 后新 50 | 2 次请求，sessionTotal=1,000,050（下降 → 重启累加） |
| 4 | 新 → 旧（回退） | 新 600 后旧 1,000,000 | 2 次请求，sessionTotal=1,000,000（全程上升 → 不累加） |
| 5 | 混合 + 压缩重置 | 600 → 60 → 260 | sessionTotal=860，reset=2（线程累计与轮次累计各记一次） |
| 6 | 混合 + 尾部截断 | 文件重建后仅 50 | sessionTotal=50，reset=0 |
| 7 | 乱序 | 新在后但时间戳在前 | 与顺序无关，数值与顺序无关 |
| 8 | 重复事件（真正测重复） | `M(r1,120)×2 + L(120)×2 + M(r2,170,50)` | 2 次请求；sessionTotal=170；reset=0 |
| 9A | 同时间戳、500 的 key 全新 | A=1000、B=500 | 2 次请求，sessionTotal=1500（下降 → 累加），reset=1 |
| 9B | 同时间戳、500 的 key 已出现 | 早前已有 500，再出现 A=1000、B=500 | 2 次请求，sessionTotal=1000（上升 → 不累加），reset=0 |
| 10 | 标准双写 | 同内容 120 的两条事件 | 1 次请求，sessionTotal=120 |
| 11 | 双写 + 压缩 | 双写 600 → 双写 60 | 2 次请求，sessionTotal=660，reset=2 |
| 12 | 双写 + 尾部截断 | 截断重建后只剩 60 的双写 | 1 次请求，sessionTotal=60 |
| 13 | 错峰回声 | 同内容 120、时间差 12s | 1 次请求，sessionTotal=120，echoStats.total=1、overThreshold=0，真冲突=0 |
| 14 | legacy 落后一拍的 echo + replay | R 600/1200/1800；C(600)、C(600)、C(1200)、C(1200) | 3 次请求，sessionTotal=1800；echo=2、replay=2（旧实现 3300） |
| 15 | 双写段 → 单格式段衔接 | 双写 600、1200 → 仅 legacy 1800 | 3 次请求，sessionTotal=1800 |
| 16 | 双写中途升降版 | 双写 600 → 仅 legacy 1200/1800 → 双写 2400 → 仅新格式 3000 | 5 次请求，sessionTotal=3000 |
| 17 | 降版重启 | 新格式 600 → legacy 50（下降 + 新 key） | 2 次请求，sessionTotal=650，reset=1 |
| 18 | 超阈值回声 | 同内容 120、时间差 90s | 1 次请求，sessionTotal=120，overThreshold=1，top-3 记录回声时间戳 |
| 19 | 双写段内 legacy-only | 双写 600、1200 之间插入 legacy 900（新 key） | 3 次请求，sessionTotal=1200 |
| 20 | 真冲突（同 id 不同值） | 同 response_id、线程累计 120 与 200 | 1 次请求，sessionTotal=120，formatConflictCount=1 |
| 21 | 一对一认领 | M(`100|100`)、M(`200|200`)；L(`100|100`)×2、L(`300|300`) | 3 次请求，sessionTotal=300；echo=1、replay=1、unique=1；claimedModern=echo |
| 22 | unique 自身重复 | M(`100|100`)；L(`300|300`)×2（时间戳不同） | 2 次请求，sessionTotal=300；unique=1、selfDuplicate=1 |

## F1-8 收口（已定稿）

早期 F1-8 期望 170（把 50 与 120 相加），与 F1-4 / F1-9B 的"上升 = 接续"冲突。现按定稿重构为"真正测重复"的用例：

- 输入：`M(r1,120) ×2 + L(120) ×2 + M(r2,170,50)`（同一条新格式记录重复两条、legacy 累计 120 重复两条，再来一条 r2 累计 170、本轮 50）
- 期望：`requestCount=2`、`sessionTotal=170`、`reset=0`
- 推导：重复的新格式记录按 `response_id` 去重；legacy 120 与 r1 内容 key 相同 → 回声丢弃；
  r1 累计 120 → r2 累计 170 是上升 = 接续，总量就是 170，**不是 50 + 120 相加**。

## 与参考脚本的复算对照（只读实测，2026-09-17）

参考脚本：`%USERPROFILE%\.codex\.tmp\audit2\classify.cjs`（分类）与 `lag-methods.cjs`（四口径滞后）；
实现侧对照脚本：`scripts/check-request-count.mjs`。三者在**同一份会话文件**（`rollout-2026-09-13T21-32-09…`，
modern 1135 / legacy 1292）上运行：

| 指标 | 参考脚本 | 本实现 | 一致 |
|---|---|---|---|
| echo | 1134 | 1134 | ✅ |
| replay | 152 | 152 | ✅ |
| unique（未剔自身重复） | 6 | 6（净 5 + selfDuplicate 1） | ✅ |
| 配对数 / 未配对 | 1134 / 158 | claimedModern 1134；未认领入账 158（152 replay + 5 unique + 1 自身重复） | ✅ |
| 回声滞后 >60s | 6 | 6 | ✅ |
| 回声最大滞后 | 2,752,991ms | `echoStats.lagMaxMs` = 2,752,991ms | ✅ |
| 重放最大陈旧度 | 3,863,172ms（C/D 口径） | `replayStats.lagMaxMs` = 3,863,172ms | ✅ |

改动效果：改用一对一认领后，滞后 >60s 的回声由"允许复用（C/D）"口径的 56 条降到 **6 条**，
`overThreshold / echoStats.total = 6 / 1134 = 0.53% ≤ 1%` ✅。

### 6 条 unique（净 5）的实证

逐条检查发现：每条 unique 的**线程累计**都能在新格式里找到同值记录，且后者早了约 13ms 写入，
只是"本轮量"不同（legacy 记的是增量口径，新格式记的是含重发上下文的口径）：

| legacy 时间戳 | 线程累计 | legacy 本轮量 | 同线程累计的新格式记录（时间戳 / 本轮量） |
|---|---|---|---|
| 2026-09-14T13:51:02.367Z | 7,627,019 | 13,327 | 2026-09-14T13:51:02.353Z / 152,961 |
| 2026-09-14T13:51:23.858Z | 7,627,019 | 13,327 | （同上，自身重复 → selfDuplicate） |
| 2026-09-14T15:42:23.568Z | 20,617,672 | 6,879 | 2026-09-14T15:42:23.559Z / 189,600 |
| 2026-09-15T00:23:32.677Z | 29,543,922 | 14,616 | 2026-09-15T00:23:32.664Z / 174,737 |
| 2026-09-15T01:33:58.620Z | 39,448,815 | 14,502 | 2026-09-15T01:33:58.607Z / 155,826 |
| 2026-09-16T13:21:29.194Z | 171,531,127 | 18,379 | 2026-09-16T13:21:29.180Z / 593,099 |

结论：这 5 条 net unique 按规格计入 `requestCount`（+5），但**不把它们的本轮量再加进总量**——
它们对应的线程累计点已经由新格式本体计入累计链，再加会双计（合计 81,030 tokens，约占 0.02%）。

## 验收

1. 单元测试逐条断言上表数值（`test/token-stats.test.mjs`）。
2. 实机断言“页面数字 == payload 真值”（`test/live-ui.playwright.test.mjs`）。
3. 改前/改后同一真实会话数值对照（`scripts/check-request-count.mjs`，只读）。
4. 五处副本哈希对照（源码 / 部署 / 插件 cache / Codex++ user_scripts / 打包 zip）。

**验收口径**（会话级，全部必须成立；旧的 `overThreshold ≤ 10` 已作废）：

- 结构：`echoStats.total = legacyStats.claimedModern`（一对一认领，本体只被认领一次）
- 结构：`echoStats.total + replayStats.count + uniqueStats.count = legacyStats.deduped`
- 结构：`legacyStats.deduped + uniqueStats.selfDuplicate = legacyStats.raw`
- 结构：`requestCount = modern 去重数 + uniqueStats.count`
- 结构：`sessionTotal = 逐请求 total 前缀和`，偏差 **0**
- `formatConflictCount`（真冲突：同 `response_id` 或同 `ts` 但数值不同）**= 0**
- 比例：`echoStats.overThreshold / echoStats.total ≤ 1%`
- `lagMaxMs` 只作观测，不设固定上限（随会话长度自然增长）

### 实机核对（2026-09-17，最新会话，只读）

| 指标 | 数值 | 判定 |
|---|---|---|
| 原始事件 | R（token_usage_record）1135 条、C（token_count）1292 条 | — |
| echo / replay / unique | 1134 / 152 / 5（原始 unique 6，含 1 次自身重复） | 与参考脚本逐项一致 |
| `legacyStats` | raw 1292、deduped 1291、claimedModern 1134 | 三条结构不变量成立 |
| `requestCount` | **1140** = 新格式 1135 + unique 5 | 符合"modern 去重 + 净 unique 补录" |
| `sessionTotal` | 358,219,402 | = 新格式线程累计终值 = 逐请求 total 前缀和（偏差 0） |
| `echoStats` | total 1134、overThreshold 6、lagMaxMs 2,752,991、thresholdMs 60000 | 比例 0.53% ≤ 1% ✅ |
| `replayStats` | count 152、lagMaxMs 3,863,172 | 与参考 C/D 口径最大滞后一致 |
| `formatConflictCount` | 0 | ✅ |
| `cumulativeResetCount` | 0 | 本会话未发生累计重置 |

对照：修复前该会话显示 2373 → 1583 → 1132 次请求，现行实现为 1140 次（= 1135 + 5）。
