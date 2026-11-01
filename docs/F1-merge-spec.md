# 混合日志格式统计规格

本文件是当前统计口径的权威规格。实现、测试与真实会话核对都必须与本文件一致。

## 1. 两代事件

| 类型 | 事件 | 逐请求 | 累计 |
| --- | --- | --- | --- |
| legacy | `event_msg / token_count` | `info.last_token_usage` | `info.total_token_usage` |
| modern | `token_usage_record` | `payload.usage` | `thread_token_usage` + `turn_token_usage` |

两代可同时存在于同一会话，必须统一合并。

## 2. 时间与稳定顺序

- 统一按 `timestamp` 排序
- 同 timestamp 时 legacy 在前、modern 在后
- 同来源同 timestamp 使用 `ordinal`
- 跨分片合并后仍使用 `(timestamp, ordinal)` 全序

## 3. 累计链

累计值使用 reset-aware normalizer：

- 上升：接续
- 完整重置：权威 `total` 跌到上一值的一半或更低，旧基线整体纳入新链
- 尾部修订：小于该幅度的回落只接受主机的新值，不重复加入旧累计
- 缺少权威 `total` 时，才按各字段自身的同一比例规则判断
- 禁止单调递增假设
- thread counter 与 turn counter 分别维护 reset 事件

## 4. 跨格式身份

内容 key：

```text
thread_total | request_total
```

时间不参与身份判断。时间只用于：

- 在多个候选本体中选择最近的一条
- 记录 echo lag
- 记录 replay lag

## 5. legacy 去重

legacy 自身去重指纹包含：

```text
timestamp
total
lastTotal
input
output
cached
cumulative input
cumulative output
cumulative cached
```

原因：

只用 `timestamp|total|lastTotal` 会把同 timestamp、同总量、但缓存构成不同的真实事件静默合并。

## 6. 一对一认领

每条 legacy 只进入一类：

| 分类 | 条件 | 请求数 | 总量 |
| --- | --- | --- | --- |
| echo | 同内容 key 且存在未认领 modern 本体 | +0 | +0 |
| replay | 同 key 的本体已经全部被认领 | +0 | +0 |
| unique | modern 中没有该 key | +1 | 按累计链 |
| selfDuplicate | unique key 已在该桶出现 | +0 | +0 |

结构不变量：

```text
echoStats.total = claimedModern
echo + replay + unique = legacyDeduped
legacyDeduped + selfDuplicate = legacyRawAfterFingerprint
requestCount = modernUnique + uniqueStats.count
```

## 7. 真冲突

`formatConflictCount` 只在以下情况增加：

- 同 `response_id` 但数值不同
- 同 timestamp 但完整数值构成不同

非 0 即报警。

## 8. 轮次归属

`turn_context` 是权威来源：

- 有 `turn_id` 精确归属
- 无 `turn_id` 的 legacy 按开始时间窗归属
- 没有 `turn_context` 才使用 `user_message` 分界
- 都没有时退化为单轮

禁止：

- 同时使用“turn_id 建轮”和“用户消息下标建轮”
- 创建无语义填充轮
- 让 `currentTurn` 指向空轮

## 9. 混合格式当前轮

每轮维护 `threadBase`：

```text
threadBase = 第一条记录的 normalized thread cumulative - 该请求量
```

一轮出现 modern `turn_token_usage` 后：

- modern 值作为本轮累计
- 后续 legacy 没有 turnUsage 时使用：

```text
currentTurnValue = normalized thread cumulative - threadBase
```

禁止只增加 requestCount 而不更新当前轮。

## 10. 会话总量与上下文

- sessionTotal = 累计链终值
- 逐请求只累加 input / output / cached
- contextUsed = 最后一次请求 total，并受 modelContextWindow 上限约束
- 上下文压缩不会直接制造 session reset

## 11. 速度

紧凑条估算：

```text
最近有效请求样本的稳健中位数
```

- 生成区间先合并为并集，重叠部分不重复计时
- 最多使用最近 5 个有效请求样本
- 用中位数和 MAD 抑制单条尖峰
- 少于 3 个有效样本时 `compactTps=null`，页面显示 `--T/s`
- 连续 3 个窄分布高速/低速样本可接受为新的速度区间

有效速度：

```text
output / (turn_duration - tool_duration)
```

- 会话有效速度取最近 25 个高/中置信度轮次
- 按输出和耗时加权
- `turnWallTps` = 当前轮 output ÷ 整轮墙钟耗时
- 墙钟速度不使用 input/cached/context 总量
- output tokens 已包含 reasoning，不重复添加
- 无可靠计时显示 `-- Tokens/s`

协议新增可选字段：

- `compactTps`
- `compactSpeedSampleCount`
- `compactSpeedWindow`
- `compactSpeedConfidence`
- `turnWallTps`

旧字段 `genEstimateTps`、`lastRequestTps`、`turnTps` 保留用于兼容。

## 12. 分片

- 同一 thread 的所有 rollout 文件归组
- 文件按时间和名称稳定排序
- 解析后合并事件再统计
- 分片重叠内容由统一身份规则去重
- watch 与 `--thread` 单次命令走同一合流路径

## 13. 推送窗口

- 关闭：5 轮 / 0 明细
- 打开：10 轮 / 10 明细
- 请求加载更多：+20
- 轮次加载更多：+50
- 上限：各 500
- 未展示内容不进 payload
- 超过 500 的完整结构化请求与轮次摘要写入本地历史，保留 60 天；不通过 CDP 下发

## 14. 测试矩阵

### 混合格式

| # | 场景 | 核心断言 |
| --- | --- | --- |
| F1-1 | legacy-only | 请求数、sessionTotal |
| F1-2 | modern-only | 与 legacy 口径一致 |
| F1-3 | 旧 → 新 | 总数接续 |
| F1-4 | 新 → 旧 | 不双计 |
| F1-5 | 混合 + 压缩 | reset 数正确 |
| F1-6 | 混合 + 截断 | 使用新基线 |
| F1-7 | 乱序 | 结果与事件顺序无关 |
| F1-8 | 重复事件 | 请求不翻倍 |
| F1-9A/B | 同 timestamp 新旧 key | 下降新 key/上升旧 key 区分 |
| F1-10 | 标准双写 | 只算一次 |
| F1-11 | 双写 + 压缩 | 只算一次并记 reset |
| F1-12 | 双写 + 截断 | 按新基线 |
| F1-13 | 错峰回声 | echo，不算请求 |
| F1-14 | legacy 落后一拍 | echo/replay 分列 |
| F1-15 | 双写段 → 单格式段 | 衔接正确 |
| F1-16 | 双写中途升降版 | 全程不重复 |
| F1-17 | 降版重启 | 下降 + 新 key |
| F1-18 | 超阈值回声 | 只影响健康统计 |
| F1-19 | 双写段 legacy-only | unique 补录 |
| F1-20 | 同 response_id 冲突 | conflict=1 |
| F1-21 | 一对一认领 | claimedModern=echo |
| F1-22 | unique 自身重复 | selfDuplicate |
| F1-23 | 混合格式当前轮 | thread delta 更新 total/input/output/cached |
| F1-24 | legacy cached 构成差异 | 不静默合并，conflict=1 |
| F1-25 | 分片尾部微降 | 按修订处理，不重复旧累计 |

### 轮次与快照

| # | 场景 | 核心断言 |
| --- | --- | --- |
| B-1 | turn_context 权威 | 当前轮正确 |
| B-2 | 同轮双写 | 只收一条 |
| B-3 | legacy 时间窗归属 | 不填充空轮 |
| B-4 | 仅 user_message | 旧日志回退 |
| B-5 | 无线索 | 单轮 |
| B-6 | 跨分片 turn_context | 合并正确 |
| B-7 | 混排当前轮 | currentTurn、total、input、output |
| B-8 | 本轮平均速度 | Σoutput ÷ Σgeneration time |
| S-1 | 快照当前请求数 | 不用 session requestCount 冒充 |

## 15. 验收

```powershell
npm test
node scripts\golden-baseline.mjs --check
node scripts\verify-live.mjs
```

交付前还必须有：

- 真实会话改前/改后对照
- schema v4 / auth v2 验签通过
- 页面/监控数值一致
- 源、部署、cache、用户脚本和安装 ZIP 均存在，`errors: []` 且 `mismatches: 0`
