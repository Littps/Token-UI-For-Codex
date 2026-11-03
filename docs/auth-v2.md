# HMAC auth v2

本文描述当前工作树的本地推送认证协议。已发布的 1.0.2 标签仍使用
schema v3 / auth v1；当前未发布源码升级为 schema v5 / auth v2。

## 目标

- 认证完整业务负载。
- 认证认证版本、密钥标识、时间戳、nonce 和序号。
- 阻止无密钥事件、坏 MAC、重放、过期消息和序号倒退。
- 不把 HMAC 当作加密、账号隔离或本机恶意进程防护。

## 载荷

```json
{
  "schemaVersion": 5,
  "authRequired": true,
  "auth": {
    "v": 2,
    "keyId": "32 hex characters",
    "ts": 1760000000000,
    "nonce": "32 hex characters",
    "seq": 1,
    "mac": "64 hex characters"
  }
}
```

## 签名文本

```text
tokens-ui-for-codex/auth-v2
<canonicalJson(body without auth)>
<canonicalJson({ v, keyId, ts, nonce, seq })>
```

签名算法为 HMAC-SHA256，密钥为 32 字节随机值。

`canonicalJson` 要求：

- 对象键按字典序排列
- 只接受 JSON 可表示值
- 拒绝 `undefined`、NaN、Infinity、函数、Symbol、BigInt 和循环引用

## 校验

页面必须同时满足：

- `schemaVersion=5`（v4 及更早版本不接受；v5 新增模型与费用结构，认证算法不变）
- `auth.v=2`
- `keyId` 与 `nonce` 为 32 位小写十六进制
- `mac` 为 64 位小写十六进制
- `ts` 与当前本机时间相差不超过 30 秒
- `seq` 为安全正整数且严格递增
- 同一 `keyId` 下 nonce 不得重复
- HMAC 必须匹配完整签名文本

`keyId` 变化后，旧密钥、nonce 集合和 `lastSeq` 全部丢弃。

## 密钥交接

监控进程在同一个 CDP 执行表达式中：

1. 写入一次性 `window.__tuiForCodexAuthBootstrap`
2. 写入签名负载
3. 同步派发 `tokens-ui-for-codex`
4. 在 `finally` 中删除 bootstrap

页面在事件处理器进入异步流程前同步复制并删除 bootstrap，只保留不可导出的
WebCrypto `CryptoKey`。

这缩短了明文密钥的存在窗口，但没有改变信任根：能主动观察 CDP/页面执行或劫持
同一 JS Realm 的代码仍可取得或替换密钥。

## 安全边界

该协议可以降低普通脚本误注入、无密钥伪造和重放风险，但不能提供强隔离：

- 同一页面 JS Realm 的脚本可以劫持属性、事件或内核 API。
- 拥有当前用户同等权限并可访问 CDP 的程序，仍可读取页面或修改 DOM。
- HMAC 不提供机密性。
- payload 本身不包含消息正文、路径、线程 ID、response ID 或凭据。
- 不采用 ECDH；没有可信身份锚点时，ECDH 无法阻止主动中间人。
- 范围缓存来自此前已验签负载，但写入 `localStorage` 后靠结构校验和 24 小时 TTL 恢复，
  不再保留 MAC；同一 Realm 的恶意脚本仍可篡改缓存。缓存只用于首屏展示，下一份签名
  负载必须覆盖它。

需要更强隔离时，应引入可信原生 IPC、独立系统服务、进程 ACL、代码签名验证
或操作系统级账户隔离，而不是继续堆叠页面内密码学。

## 兼容性

schema v5 与 schema v4/v3 不兼容。即使同为 auth v2，业务 schema 不匹配也拒绝：

| 面板 | 监控 | 结果 |
| --- | --- | --- |
| schema v5 / auth v2 | schema v5 / auth v2 | 正常 |
| schema v5 / auth v2 | schema v4 / auth v2 | `protocol-mismatch` |
| auth v1 | auth v2 | `protocol-mismatch` |
| auth v2 | auth v1 | `protocol-mismatch` |

安装、回滚和副本同步必须同时替换面板与监控，不允许混合版本降级运行。
