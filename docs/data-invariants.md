# 数据不变量

## 请求

- `requestCount` 是跨 modern / legacy 去重后的 unified 记录数。
- 同 `response_id` 重复只算一次；数值不同进入真冲突计数。
- legacy 记录按一对一认领分为 echo、replay 和 unique。
- unique 记录计入请求数；replay 不重复计入。

## 会话累计

- `sessionTotal` 取归一化后的最后一次线程累计。
- 累计值下降必须结合 reset-aware normalizer 和新 key 判断。
- 上下文压缩造成的单请求 total 变化不能误判为累计重置。

## 当前轮

- 本轮优先使用 `turn_token_usage`。
- legacy 缺少本轮用量时，用线程累计减去本轮起点基线。
- `currentTurnRequestCount` 只表示当前轮，不得复用会话总请求数。

## 缓存

- 命中率为 `cached / input`，范围限制在 0～1。
- input 为 0 或 cached 缺失时命中率为 `null`。
- 页面显示时再转换为百分比。

## 速度

- 输出 token 已包含 reasoning，不得重复加 reasoning token。
- 生成估算速度使用生成条目耗时并集。
- 有效速度使用任务总耗时减工具执行时间，并受 timing quality 约束。
- 稳健速度使用最近有效记录样本的中位数与 MAD 离群过滤。
- 有效速度窗口只使用最近 `EFFECTIVE_SPEED_WINDOW` 个合格轮次。

## 明细上限

- 页面、协议和接收端统一最多 500 条。
- `retainRequests=false` 只保留最后遇到轮次的最近 500 条。
- 环形缓冲必须最终恢复为时间正序，不能暴露内部覆盖顺序。

## 隐私

- CDP payload 不包含消息正文、会话路径、原始 thread/response/turn ID 或凭据。
- 本地历史和日志只能保存统计所需的数字、时间标签、索引和会话哈希。
