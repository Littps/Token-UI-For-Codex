# 本地历史范围统计

## 用户行为

“统计信息”支持五档范围：

- 今日
- 近 3 天
- 近 7 日
- 近 30 日
- 全部

默认选择“全部”。最近一次选择保存在浏览器本地存储
`tokens-ui-for-codex.stats-range`，关闭详情不会重置。

## 按需加载

详情关闭时：

- `data-tui-range` 为空；
- monitor 不计算范围汇总；
- payload 中 `rangeSummary=null`。

详情打开时：

- 页面写入当前选择到 `<html data-tui-range>`；
- 已有范围缓存时立即绘制，并标记缓存时间与“刷新中”；
- monitor 在下一次 1 秒巡检中读取；
- 只有范围变化或底层轮次快照变化时才重新汇总；
- 页面收到带签名的 `rangeSummary` 后更新统计卡片。

## 时间口径

- 使用系统本地时区；
- “今日”从本地 00:00 开始；
- “近 3 天”包含今天和前 2 个本地日历日；
- “近 7 日”包含今天和前 6 个本地日历日；
- “近 30 日”包含今天和前 29 个本地日历日；
- “全部”表示当前本地历史归档中的全部数据，最多保留 60 天。

## 数据来源

范围统计读取：

```text
<historyDir>\sessions\<sessionHash>\turns.json
```

使用轮次快照中的数值和时间标签，不上传或输出：

- 消息正文；
- 会话路径；
- thread/response/turn ID；
- 原始 rollout 内容。

`turns.json` 新增可选计时字段：

- `wallMs`
- `toolWallMs`
- `toolCallCount`
- `ttftMs`
- `timingCoverage`
- `timingQuality`

旧快照缺少计时字段时，范围耗时显示 `--`。

## 缓存

`UsageHistoryArchive` 对每个范围维护内存缓存。

出现以下情况时清空：

- 新增请求归档；
- 轮次快照内容变化；
- 60 天清理删除历史文件。

缓存只包含汇总数值，不保存正文。

页面另有独立的展示缓存：

- 每个范围保存最后一次通过校验的 `rangeSummary`；
- `localStorage` 最长保留 24 小时，超时或结构无效时丢弃；
- 缓存命中时先显示旧值，新签名负载到达后原位替换；
- 同一页面内保留上次展开的轮次和请求列表快照，会话切换时清除；
- 缓存只含数值、时间、索引和状态字段，不含正文、路径或原始 ID。

## 本地数据审计与修复

`scripts/repair-local-history.mjs` 默认只读审计，不会写入文件：

```powershell
npm run repair:history
```

审计会检查 JSONL 完整性、重复 key、负数、`cached > input`、轮次顺序，并尝试用仍存在的
rollout 重建轮次快照。只有旧快照的轮次标识、请求数和 Token 字段与重新解析结果一致时
才允许重建；缺失的原计时保持 `null`，不会补 0。

写入前必须提供包含全部目标会话的备份：

```powershell
npm run repair:history -- --backup "<备份目录>" --apply
```

## 已知边界

- 历史范围最大为 60 天，超过后由保留策略淘汰；
- 还没有被监控归档过的会话不会出现在范围统计中；
- 旧版本 `turns.json` 没有计时字段时，Token 数量仍可统计，耗时显示 `--`；
- 范围统计不是服务端账单，也不代表跨设备汇总。
