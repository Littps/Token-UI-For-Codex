# 统计管线

本文件描述 `token-stats.mjs` 从 rollout JSONL 到页面统计对象的当前数据流。

## 输入

- `IncrementalRolloutParser` 按文件偏移增量读取 JSONL。
- 同一会话的多个分片由 `mergeSegments()` 合并。
- parser 只保留结构化事件：usage、turn、task timing、item timing、model 和 user message 时间。

## 解析事件

`processParserEvent()` 只负责顺序敏感的分派，各事件由独立函数处理：

- `captureModelChange()`
- `captureTurnContext()`
- `captureEventMessageContext()`
- `captureTaskCompletion()`
- `captureItemTiming()`
- `captureUserMessage()`
- `captureModernUsage()`
- `captureLegacyTokenCount()`

必须保持的顺序：

1. 上下文窗口提取早于 usage 提前返回。
2. `trackGenWindow()` 早于所有 usage 分支。
3. modern usage 去重和冲突检测不后移。
4. legacy `token_count` 即使存在 modern 记录也必须保留。

## 统计装配

`buildStatsUnified()` 负责编排，不直接实现所有规则：

1. `collectUnifiedRecords()` 合并 legacy 与 modern 记录，并完成 echo / replay / unique 分类。
2. `seedTurnList()` 按 `turn_context`、记录 `turn_id`、`user_message`、单轮兜底的优先级建立轮次。
3. `assignRecordsToTurns()` 将记录归入轮次，维护线程累计、本轮累计、重置计数和最近 500 条明细。
4. `attachTurnTimings()` 附加生成区间、首字延迟、工具耗时、有效速度和本轮墙钟速度。
5. `buildSpeedMetrics()` 汇总会话速度、本轮速度、最近有效速度窗口和稳健速度样本。
6. `buildStatsUnified()` 将内部数据映射为稳定的对外统计对象。

## 不变量

- `requestCount` 只能是 unified 记录数。
- `sessionTotal` 使用最后一次线程累计，并经过 reset-aware 归一化。
- 本轮记录缺失 `turnUsage` 时，使用线程累计减本轮起点基线补齐。
- 有效速度只使用 timing quality 不为 low 的最近 `EFFECTIVE_SPEED_WINDOW` 轮。
- `retainRequests=false` 时只保留最后遇到轮次的最近 500 条明细，并使用环形缓冲避免数组搬移。
- 输出字段、空值语义和轮次顺序不能因内部重构变化。

## 验证

```powershell
npm test
node scripts\golden-baseline.mjs --check
node scripts\verify-live.mjs
```

结构重构的硬条件：全部 fixture 输出逐字段一致，性能不得出现超过 5% 的同机回退。
