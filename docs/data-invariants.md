# 数据不变量

## 会话身份

- 非空白候选必须存在对应 rollout 文件。
- 候选连续稳定 2.5 秒后才允许切换，期间继续使用当前已确认会话。
- `client-new-thread` 只可映射到激活后创建的唯一 rollout。
- 禁止使用“最新未认领旧文件”推断新对话。
- 最后确认 ID 最多沿用 8 秒；过期后必须等待新候选。

## 请求

- `requestCount` 是跨 modern / legacy 去重后的 unified 记录数。
- 同 `response_id` 重复只算一次；数值不同进入真冲突计数。
- legacy 记录按一对一认领分为 echo、replay 和 unique。
- unique 记录计入请求数；replay 不重复计入。

## 会话累计

- `sessionTotal` 取归一化后的最后一次线程累计。
- 累计值只有权威 `total` 跌到上一值的一半或更低时，才作为完整重置并把旧基线加入新链。
- 更小回落是主机尾部修订：接受新值，不重复加入旧累计。
- 缺少权威 `total` 时，才按各字段自身的同一比例规则判断。
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

## 时间指标

- `wallMs` 来自 `task_complete.duration_ms`；缺失时才允许使用回退跨度并降低 timing quality。
- `toolWallMs` 使用工具执行区间并集，不是并行工具 duration 的简单求和。
- `ttftMs` 只接受有限的 `time_to_first_token_ms`。
- 会话 TTFT 是有效轮次的算术平均值，并同时记录样本数。
- 缺失计时字段必须为 `null`，不能写 0。

## 上下文分类

- `contextUsed` 和 `modelContextWindow` 是真实值。
- 系统、工具、消息和 other 分类是本地估算，必须携带 `estimated=true` 和估算器版本。
- 分类数值之和必须等于 `floor(contextUsed)`。
- 缺少来源的分类为 `null`，不得用 0 代替。
- 估算过程不得保留或发送 prompt、工具描述、消息正文。
- 详细公式与限制见 `docs/context-estimation.md`。

## 明细上限

- 页面、协议和接收端统一最多 500 条。
- `retainRequests=false` 只保留最后遇到轮次的最近 500 条。
- 环形缓冲必须最终恢复为时间正序，不能暴露内部覆盖顺序。

## 历史范围统计

- 范围只允许 `today / 3d / 7d / 30d / all`。
- 时间边界使用本地日历日：今日为 00:00，3 日含今天和前 2 日，7 日含今天和前 6 日，
  30 日含今天和前 29 日。
- `all` 只代表当前本地归档保留期，不等于账号全生命周期。
- 详情关闭时不计算范围汇总，`rangeSummary` 为 `null`。
- 汇总只读取 `turns.json` 的结构化数值与时间，不读取消息正文。
- 新增请求、轮次快照变化或清理历史后必须使范围缓存失效。
- 页面范围缓存最长 24 小时；必须标记“缓存时间/刷新中”，并由下一份有效签名负载替换。
- 同页详情快照只保存已有脱敏字段，`sessionChanged=true` 时必须清除。

## 隐私

- CDP payload 不包含消息正文、会话路径、原始 thread/response/turn ID 或凭据。
- 本地历史和日志只能保存统计所需的数字、时间标签、索引和会话哈希。
- 健康提示不发送原始异常文本，只展示受控健康字段和本地错误码映射。
