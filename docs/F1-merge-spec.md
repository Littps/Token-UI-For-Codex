# F1 规格：混合日志格式的统计合并

本文件是**统计口径的唯一权威**。`token-stats.mjs` 的实现、`test/token-stats.test.mjs` 的期望值
与 `scripts/check-request-count.mjs` 的真值对照都必须与本文件一致；改实现前先改这里。

## 0. 事件格式（两代并存）

会话日志里存在两代事件格式，同一会话可能同时出现（Codex 引擎升级或回退）：

| 类别 | 事件 | 逐请求量 | 累计量 |
| --- | --- | --- | --- |
| **A 类（legacy）** | `event_msg` / `payload.type = token_count` | `payload.info.last_token_usage` | `payload.info.total_token_usage`、`payload.info.model_context_window` |
| **B 类（new）** | `token_usage_record` | `payload.usage` | `payload.thread_token_usage`（线程）、`payload.turn_token_usage`（轮次） |

**契约**：两代必须**统一合并**，不允许"只要出现任一 B 类记录就整体丢弃 A 类"。

## 1. 规则

**R1 时间轴统一**：A、B 两类事件按 `timestamp` 稳定排序；同一时间戳时 A 在前、B 在后。
乱序不丢数据（排序消除顺序影响）。

**R2 累计链（接续 / 重启）**：去重后按时间序扫描累计值，维护一条统一累计链：

- 累计值**上升** → 视为接续，只把增量（`v - 上一次值`）计入总量；
- 累计值**下降** → 视为重启，把新基线整体计入总量，并记一次 reset 事件（线程与轮次各自计数）。

**禁止任何"累计必然单调递增"的假设**（上下文压缩、会话重置都会让累计下降）。

**R3 分类（一对一认领；时间不参与身份判定）**：

- 内容 key = `线程累计 | 本轮量`
  （A：`info.total_token_usage.total_tokens` + `info.last_token_usage.total_tokens`；
  B：`thread_token_usage.total_tokens` + `usage.total_tokens`）
- A 类先按 `ts|total|lastTotal` 指纹去重（legacy 自身重复），再逐条按时间序认领新格式本体
- 新格式是权威流：B 类自身按 `response_id`（无 id 时 `ts|total|turn_id`）与内容 key 去重

### 1.1 一对一认领表（每条 legacy 记录只落入一条）

| # | 判定 | 处理 | requestCount | sessionTotal |
| --- | --- | --- | --- | --- |
| 1 | 同内容 key 且**尚未被认领**的本体存在 → **echo** | 认领该本体（本体只能被认领一次；多具时取时间最近的一具），计入 `echoStats` | +0 | +0 |
| 2 | 同内容 key 的本体存在但**都已被认领** → **replay** | 计入 `replayStats`（不再算请求） | +0 | +0 |
| 3 | 新格式里**没有该 key** → **unique** | 作为独立请求补录 | +1 | 走累计链（R2） |
| 3b | unique 且该 key 已在 unique 桶出现过 → **自身重复** | 计入 `uniqueStats.selfDuplicate` | +0 | +0 |
| 4 | 同 `response_id` 或同内容 key（同格式内重复） | 去重，原样不变 | +0 | +0 |

**相加只能来自「累计下降 + 新 key」**；上升场景出现相加即为缺陷。

**结构不变量**：`echoStats.total = 被认领的本体数`；
`echo + replay + unique = legacy 去重后总数`；
`legacy 去重后 + 自身重复 = legacy 指纹去重后条数`。

**R4 会话总量**：取累计链终值，它等于逐请求 `total` 的前缀和（与实机核对口径一致）。
逐请求只累加 `input` / `output` / `cached`。

**R5 轮次归属**：轮次列表以 `turn_context` 事件为**权威来源** —— 宿主逐轮写出该事件并携带 `turn_id`，
实测覆盖到日志开头，且是记录里 `turn_id` 的超集（还包含"没有任何用量记录的空轮"）。

- 有 `turn_id` 的记录精确匹配到该轮；
- 无 `turn_id` 的 legacy 记录按「开始时间 ≤ 记录时间」落到所属轮；
- 仅当整份日志**没有** `turn_context` 时，才退回 `user_message` 时间分界；两者都没有时退化为单轮。

**禁止**把「有 `turn_id` 就新建轮」与「无 `turn_id` 就按用户消息序号取数组下标」两套规则并行写进同一个
轮次数组（会产生填充空轮，并让 `currentTurn = turns.at(-1)` 指向空轮 → 面板当前轮恒为 0）。

排序键统一为 `(ts, ordinal)`：`ordinal` 是宿主写出的全局事件序号，跨分片合并后仍是全序。

**R6 可观测（回声 / 重放 / 补录分开）**：

- `echoStats = { total, lagMaxMs, overThreshold, thresholdMs, topLag }`：**回声（正常现象）**，用于健康度。
  阈值 `thresholdMs = ECHO_LAG_THRESHOLD_MS`（60 秒）；统计范围**按会话**（每次 `buildStats` 从会话日志重算，
  不按监控进程累计）。`topLag` = 滞后最大的前 3 条时间戳；**只在 `overThreshold > 0` 时打一行日志**并附 top-3。
- `replayStats = { count, lagMaxMs }`：**重放陈旧度**（本体已被更早的 legacy 认领），**不混进 echoStats**。
- `uniqueStats = { count, selfDuplicate }`：无本体补录数（净计数）与自身重复数。
- `legacyStats = { raw, deduped, claimedModern }`：结构不变量核对用。
- `formatConflictCount`：**真冲突** —— 同 `response_id` 但数值不同，或同 `ts` 但数值不同。**非 0 即报警**。

**R7 截断 / 半行 / 重建**：沿用 `IncrementalRolloutParser` 语义（偏移 + 半行缓存 + 文件指纹）；
文件被截断或重建时按新基线重新统计，不沿用旧值。

**R8 上限与按需窗口**：

- 请求明细：每个轮对象最多保留最近 **500** 条；各轮摘要最多保留最近 **500** 轮。
- 推送窗口（页面 → 监控）：弹层关闭 = 5 轮 / 0 条明细；打开 = 25 轮 / 10 条明细；
  「加载更多」每次 +50 轮 / +20 条。超出窗口的数据**不进入负载**。
- 上限由监控通过 `turnsLimit` / `requestsLimit` 下发给页面；页面据此禁用"加载更多"并显示"已达上限"。

## 2. Fixture 矩阵

每条 fixture 断言 `requestCount` 与 `sessionTotal`（部分另外断言 `cumulativeResetCount` / `formatConflictCount`）。

| # | 场景 | 输入要点 | 期望 |
| --- | --- | --- | --- |
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
| 13 | 错峰回声 | 同内容 120、时间差 12s | 1 次请求，sessionTotal=120；`echoStats.total=1`、`overThreshold=0`、真冲突=0 |
| 14 | legacy 落后一拍的 echo + replay | R 600/1200/1800；C(600)、C(600)、C(1200)、C(1200) | 3 次请求，sessionTotal=1800；echo=2、replay=2 |
| 15 | 双写段 → 单格式段衔接 | 双写 600、1200 → 仅 legacy 1800 | 3 次请求，sessionTotal=1800 |
| 16 | 双写中途升降版 | 双写 600 → 仅 legacy 1200/1800 → 双写 2400 → 仅新格式 3000 | 5 次请求，sessionTotal=3000 |
| 17 | 降版重启 | 新格式 600 → legacy 50（下降 + 新 key） | 2 次请求，sessionTotal=650，reset=1 |
| 18 | 超阈值回声 | 同内容 120、时间差 90s | 1 次请求，sessionTotal=120；overThreshold=1，top-3 记录回声时间戳 |
| 19 | 双写段内 legacy-only | 双写 600、1200 之间插入 legacy 900（新 key） | 3 次请求，sessionTotal=1200 |
| 20 | 真冲突（同 id 不同值） | 同 response_id、线程累计 120 与 200 | 1 次请求，sessionTotal=120，formatConflictCount=1 |
| 21 | 一对一认领 | M(`100\|100`)、M(`200\|200`)；L(`100\|100`)×2、L(`300\|300`) | 3 次请求，sessionTotal=300；echo=1、replay=1、unique=1；claimedModern=echo |
| 22 | unique 自身重复 | M(`100\|100`)；L(`300\|300`)×2（时间戳不同） | 2 次请求，sessionTotal=300；unique=1、selfDuplicate=1 |

## 3. 轮次归属 fixture（B-1 .. B-8）

除 F1-1..22 的口径断言外，`test/token-stats.test.mjs` 另有 8 条**轮次归属 / 速度**用例。
其中 B-1 / B-3 / B-6 / B-7 在旧实现下**失败**，用来锁住"填充空轮导致 currentTurn 指向空轮"这个缺陷。

| # | 场景 | 期望 |
| --- | --- | --- |
| B-1 | 3 个 `turn_context` + 各 1 条新格式记录 | 轮数=3；当前轮序号=3；轮开始时间取自 `turn_context` |
| B-2 | 同轮双写（现代 + legacy 同值配对） | 轮数=1；requestCount=1（回声不计）；该轮只收一条记录 |
| B-3 | legacy 记录时间落在第 2 轮内（且存在 3 条用户消息） | 轮数=2；legacy 归入第 2 轮 |
| B-4 | 无 `turn_context`、仅有 `user_message` | 退回分界：轮数 = 用户消息数 |
| B-5 | 完全没有轮次线索 | 单轮 |
| B-6 | 分片合并两个 `turn_context` | 轮数=2；轮开始时间分别来自两段 |
| B-7 | 混排后检查 `currentTurn` | 当前轮序号=2；`turnTotal` 来自真实当前轮 |
| B-8 | 本轮平均速度 | Σ 本轮输出 ÷ Σ 本轮生成耗时（与 `lastRequestTps` 单条口径并列，互不覆盖） |

## 4. F1-8 收口（已定稿）

早期 F1-8 期望 170（把 50 与 120 相加），与 F1-4 / F1-9B 的"上升 = 接续"冲突。定为"真正测重复"的用例：

- 输入：`M(r1,120) ×2 + L(120) ×2 + M(r2,170,50)`
- 期望：`requestCount=2`、`sessionTotal=170`、`reset=0`
- 推导：重复的新格式记录按 `response_id` 去重；legacy 120 与 r1 内容 key 相同 → 回声丢弃；
  r1 累计 120 → r2 累计 170 是上升 = 接续，总量就是 170，**不是 50 + 120 相加**。

## 5. 真值对照（只读实测）

对照脚本：`scripts/check-request-count.mjs`（本实现侧）。在一份真实会话文件
（modern 1135 / legacy 1292）上逐项比对：

| 指标 | 参考值 | 本实现 | 一致 |
| --- | --- | --- | --- |
| echo | 1134 | 1134 | ✅ |
| replay | 152 | 152 | ✅ |
| unique（未剔自身重复） | 6 | 6（净 5 + selfDuplicate 1） | ✅ |
| 配对数 / 未配对 | 1134 / 158 | claimedModern 1134；未认领入账 158 | ✅ |
| 回声滞后 >60s | 6 | 6 | ✅ |
| 回声最大滞后 | 2,752,991 ms | `echoStats.lagMaxMs` 相同 | ✅ |
| 重放最大陈旧度 | 3,863,172 ms | `replayStats.lagMaxMs` 相同 | ✅ |

改用一对一认领后，滞后 >60s 的回声由"允许复用"口径的 56 条降到 **6 条**，
`overThreshold / echoStats.total = 6 / 1134 = 0.53% ≤ 1%`。

### 5.1 6 条 unique（净 5）的实证

逐条检查发现：每条 unique 的**线程累计**都能在新格式里找到同值记录（后者早约 13ms 写入），
只是"本轮量"不同（legacy 记增量口径，新格式记含重发上下文的口径）。

结论：这 5 条净 unique 按规格计入 `requestCount`（+5），但**不把它们的本轮量再加进总量** ——
它们对应的线程累计点已由新格式本体计入累计链，再加会双计。

## 6. 验收

1. 单元测试逐条断言上表数值（`test/token-stats.test.mjs`）。
2. 实机断言"页面数字 == payload 真值"（`test/live-ui.playwright.test.mjs`）。
3. 改前 / 改后同一真实会话数值对照（`scripts/check-request-count.mjs`，只读）。
4. 副本哈希对照（源码 / 部署 / 插件 cache / Codex++ 用户脚本 / 打包 zip）：
   `node scripts/verify-sync.mjs --deploy "<部署根>" --zip "<包路径>"`，必须 `mismatches: 0`。

**验收口径**（会话级，全部必须成立）：

- 结构：`echoStats.total = legacyStats.claimedModern`（一对一认领，本体只被认领一次）
- 结构：`echoStats.total + replayStats.count + uniqueStats.count = legacyStats.deduped`
- 结构：`legacyStats.deduped + uniqueStats.selfDuplicate = legacyStats.raw`
- 结构：`requestCount = modern 去重数 + uniqueStats.count`
- 结构：`sessionTotal = 逐请求 total 前缀和`，偏差 **0**
- `formatConflictCount`（真冲突）**= 0**
- 比例：`echoStats.overThreshold / echoStats.total ≤ 1%`
- `lagMaxMs` 只作观测，不设固定上限（随会话长度自然增长）

### 6.1 实机核对快照（只读）

| 指标 | 数值 | 判定 |
| --- | --- | --- |
| 原始事件 | `token_usage_record` 1135 条、`token_count` 1292 条 | — |
| echo / replay / unique | 1134 / 152 / 5（原始 unique 6，含 1 次自身重复） | 与参考脚本逐项一致 |
| `legacyStats` | raw 1292、deduped 1291、claimedModern 1134 | 三条结构不变量成立 |
| `requestCount` | **1140** = 新格式 1135 + unique 5 | 符合"modern 去重 + 净 unique 补录" |
| `sessionTotal` | 358,219,402 | = 新格式线程累计终值 = 逐请求 total 前缀和（偏差 0） |
| `echoStats` | total 1134、overThreshold 6、lagMaxMs 2,752,991、thresholdMs 60000 | 比例 0.53% ≤ 1% ✅ |
| `replayStats` | count 152、lagMaxMs 3,863,172 | 与参考口径最大滞后一致 |
| `formatConflictCount` | 0 | ✅ |
| `cumulativeResetCount` | 0 | 该会话未发生累计重置 |
