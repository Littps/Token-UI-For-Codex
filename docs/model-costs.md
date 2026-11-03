# GPT 模型记录与参考费用

状态：未发布工作树功能，版本号仍为 `1.0.2+codex.20261020131145`；等待人工验收。
业务协议为 schema v5，HMAC auth v2 的签名、时窗、nonce、seq 规则不变。

## 模型与价格核验

2026-11-03（Asia/Shanghai）匿名读取 [OpenRouter 模型目录](https://openrouter.ai/api/v1/models)
返回 HTTP 200，以下 8 个精确 ID 均存在。仅接受表中的 `openai/…` 与无前缀 ID，
不根据子串、相似名称或当前选中模型猜测历史归属。

下表为本次核验的 USD / 百万 token 快照，**不是运行时常量，也不是实际账单**：

| 模型 ID（省略 openai/） | 普通输入 | 缓存读取 | 输出 | 目录缓存写入 |
| --- | ---: | ---: | ---: | ---: |
| gpt-6.1-sol | 2 | 0.1 | 10 | 2.5 |
| gpt-6-astra | 10 | 1 | 50 | 12.5 |
| gpt-6.1-terra | 1 | 0.05 | 5 | 1.25 |
| gpt-6-sol | 2 | 0.2 | 10 | 2.5 |
| gpt-6-luna | 0.1 | 0.01 | 0.5 | 0.125 |
| gpt-5.6-sol | 4 | 0.4 | 20 | 5 |
| gpt-5.6-terra | 2 | 0.2 | 12 | 2.5 |
| gpt-5.6-luna | 0.2 | 0.02 | 1.2 | 0.25 |

目录单位是 USD / token，运算直接使用该单位。目录同时返回 `min_prompt_tokens=272000`
的上下文档位；只有可验证的完整档位才可选用。参考资料：
[OpenRouter 目录接口](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)、
[OpenAI 官方定价](https://developers.openai.com/api/docs/pricing)。

目录文档的认证示例包含 Bearer token，匿名读取只是当前可用的 best-effort 行为，不承诺永久可用。
实现不会索取或读取 key；401/403/429、超时、坏 JSON 都使用最后有效缓存或返回不可用。

## 计价与未知值

每个模型单独记录 input、cached、output、total、请求数、参考费用以及已计价/未计价请求数。
费用与原有 token 统计独立；不改 F1 合并、速度、计时与原有累计数字。

```text
普通输入 = input − cached − 已确认的缓存写入
参考费用 = 普通输入 × prompt 价格
         + cached × input_cache_read 价格
         + 缓存写入 × input_cache_write 价格
         + output × completion 价格
```

- output 已含 reasoning，不再加一次 reasoning。
- 缓存分类缺失、非有限/负值或分类合计大于 input 时不可计价，不夹断成貌似准确的金额。
- 没有可靠模型、价格或 usage 时金额为 null，页面显示 `--` 或未知；未知不是免费。
- 有部分可计价请求时只列已知小计及覆盖率，不能当成完整费用。
- Standard 公共价参考不是实际调用渠道的账单。未核实的 Fast/Batch/12h/API profile 不套通用倍率；
  API profile 解析支持精确 model/tier/TTL/上下文区间与官方来源及有效期，未提供证据的组合保持未知。
- 不计算账号余额、订阅剩余额度、真实扣款或外汇换算；不恢复历史账号实验。

## 获取、历史与隐私

- 唯一外部请求为匿名 GET 公开目录，10 秒超时；不发送本机模型用量、消息、路径或凭据。
- 缓存位于 `runtimePaths.stateDir/pricing/openrouter-catalog.json`，24 小时复用，临时文件加 rename 原子写入。
- 失败不会清空最后有效快照；stale 状态和快照时间随签名负载展示。不在每秒心跳中重新联网。
- 请求首次归档的价格结果保留；新价不重估旧请求，旧档案缺模型/费用时仍未知，不回填猜价。
- 时间范围沿用 today / 3d / 7d / 30d / all，只读取脱敏的结构化轮次档案；详情关闭时停止范围计算。
- schema、监控和面板成套使用 v5；新字段经过 auth v2 完整签名并按白名单校验，列表上限仍为 500。

## 查看方式

在详情中查看模型列表，再点击单个模型查看 token 分类、请求数、费用覆盖率。
会话、当前轮、请求明细和已有历史范围保留各自统计口径，不将它们再次相加。
紧凑条布局、宿主模型选择菜单和 Codex 配置保持原样。
