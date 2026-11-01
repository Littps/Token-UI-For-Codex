# 上下文分类估算

## 目标

详情页展示：

- 系统/开发指令；
- 工具定义；
- 对话消息；
- 其他/模板开销。

所有数值使用完整整数，不使用 K/M/B 缩写。

## 数据真实性

Codex rollout 当前没有提供服务端官方的 prompt token 分类。

精确值只有：

- `contextUsed`
- `modelContextWindow`

分类值是本地估算，必须显示 `≈` 和“本地估算，不代表服务端计费分类”。

## 输入来源

只读取以下结构中的文本长度，不保存正文：

- `session_meta.base_instructions`
- `turn_context.collaboration_mode.settings.developer_instructions`
- `world_state.state` 中的 instructions 字段
- `compacted.retained_context` 中的用户和助手消息
- compaction 之后新增的 `response_item/message`
- `compacted.resume_metadata.dynamic_tools.tools`

## 权重

估算器版本 `1`：

```text
ASCII 字符权重 = 字符数 / 4
非 ASCII 字符权重 = 字符数 / 1.5
```

这不是精确 tokenizer。中文、代码、JSON 和工具定义的真实 token 数会有偏差。

## 分类规则

1. 系统权重取 world-state 指令权重与 base/developer 指令权重中的较大值，避免明显重复计算。
2. 工具权重来自最新可获得的 dynamic tools。
3. 对话权重来自最新 retained context，并追加其后的消息。
4. 若原始权重总和超过真实 `contextUsed`，按比例缩放。
5. 未分类部分写入“其他/模板”。
6. 四项总和必须等于 `floor(contextUsed)`。
7. 任一来源缺失时，对应分类为 `null`，页面显示 `--`，不得伪造 0。
8. 当“其他/模板”超过真实 `contextUsed` 的 60% 时，页面隐藏分类图例和分段条，
   只显示精确已用量、上限和“本地分类覆盖不足”提示。

## 隐私

- parsed 状态只保存数值权重和来源布尔值。
- CDP payload 只包含四个数值字段、估算版本和 `estimated=true`。
- 不发送消息正文、指令正文、工具描述、路径、线程 ID 或 response ID。
- 本地历史不保存上下文正文。

## 兼容

能力标识：

```text
context-breakdown-estimated-v1
timing-v1
```

字段为 schema v4 的可选能力字段。旧监控不提供时，页面继续显示精确的已用量与上限；旧页面对新字段按附加属性忽略。

上下文 UI、隐私边界和原组件模式资源占用见 `docs/context-and-resources.md`。
