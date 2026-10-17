# 核心实现与重构记录

作者：**Littps**

本文件记录当前核心实现的职责划分、关键重构结果和验证门禁。
历史细节以 Git 历史为准，本文件不再作为旧版本契约说明。

## 1. 当前架构

```text
Codex rollout JSONL
  │
  ├─ IncrementalRolloutParser
  │    ├─ 文件偏移
  │    ├─ 半行缓存
  │    ├─ 前缀指纹 / truncation 检测
  │    └─ usage / turn / timing / model 事件
  │
  ├─ collectUnifiedRecords
  │    ├─ legacy token_count
  │    ├─ modern token_usage_record
  │    ├─ echo / replay / unique
  │    └─ 真冲突计数
  │
  ├─ buildStats
  │    ├─ turn_context 轮次归属
  │    ├─ reset-aware cumulative counters
  │    ├─ cache 构成
  │    ├─ 速度和耗时
  │    └─ 上下文使用量
  │
  ├─ payloadFor
  │    └─ 按窗口裁剪请求/轮次
  │
  └─ signPayload
       ├─ HMAC-SHA256
       ├─ timestamp
       ├─ nonce
       └─ seq
```

页面：

```text
CDP payload
  → clone
  → verify auth
  → adoptData
  → compact metrics
  → details incremental update
```

## 2. 核心模块

### token-stats.mjs

职责：

- 枚举 Codex rollout 文件
- 识别同一会话的所有分片
- 增量解析
- 归并两代日志格式
- 统计 token、缓存、请求、轮次和速度
- 解析动态 CDP 端口
- 选择单窗口/焦点窗口
- 签名并推送 payload
- 写健康快照、简略快照和日志
- 维护单实例锁

当前关键常量：

- 最大请求明细：500
- 最大轮次摘要：500
- 运行中心跳：1 秒
- 空闲心跳：5 秒
- 回声阈值：60 秒
- 文件停滞预警：5 分钟
- 文件停滞降级：15 分钟
- 多窗口焦点复核：10 秒
- 紧凑速度：最近 5 个有效样本中位数 + MAD 离群过滤

### tokens-ui-for-codex-panel.js

职责：

- 找到上下文用量圆圈
- 在左侧挂载统计条
- 跟随宿主主题
- 打开/关闭详情
- 按窗口渲染请求和轮次
- 验签 schema v3
- 悬浮冻结
- 自适应磨砂玻璃
- MutationObserver 重挂载保护

当前 UI 约束：

- 骨架只构建一次
- 数值增量更新
- 列表结构不变时按稳定 key 更新每行
- 不注册键盘监听
- 不修改 React bundle

### protocol.mjs

职责：

- 协议名和版本
- 能力声明
- health 枚举
- payload 基础校验
- signed auth 结构校验

### 安装脚本

`find-codex.ps1`

- 定位 codex CLI
- 定位 Codex 桌面版
- 定位 Codex++
- 定位 Node 22+
- 读取 Codex++ 用户脚本开关

`install.ps1`

- 处理发布布局和源码 staging
- 安装用户脚本
- 刷新插件注册
- 调用自启安装

`install-autostart.ps1`

- 生成 Unicode VBS 与 start-monitor.ps1
- 注册计划任务
- 停止旧监控
- 启动新监控

`uninstall-autostart.ps1`

- 按动作和内容识别本插件资源
- 支持标准/完全卸载

### history-archive.mjs

- 按会话哈希归档完整结构化请求
- `turns.json` 保存最新轮次摘要
- 请求 JSONL 仅追加新记录
- 60 天保留期
- 32MB 分段
- 每 6 小时清理
- 不包含消息正文、路径或原始线程标识

## 3. 已落地的重要修复

### 数据正确性

- 两代格式统一合并
- reset-aware 累计归一化
- 分片合流
- `--thread` 与 watch 共用分片路径
- legacy 完整内容指纹去重
- echo/replay/unique 一对一认领
- 混合格式当前轮 thread delta
- 当前提问请求数独立字段

### 页面刷新

- 取消不完整的 `dataKey` 渲染门控
- 当前轮行按稳定 key 更新
- 主题变化立即应用
- 主题观察只监听 `<html>`
- 悬浮冻结和恢复
- 紧凑条优先读取 `compactTps`；样本不足显示 `--T/s`

### 协议与安全

- schema v3 签名-only
- boot payload 验签
- 深拷贝后再异步验证
- nonce 防重放
- seq 单调
- 安全拒绝计数
- CDP 客户端审计

### 安装兼容

- PS1 UTF-8 BOM
- Windows PowerShell 5.1 / 7 双解析
- PowerShell 5.1 单例数组修复
- JSON 禁止意外 BOM
- VBS UTF-16LE
- 中文安装路径
- 源码包 staging
- 旧监控统一停止
- Node 只选 `.exe` 且取最高 v22+

## 4. 验证门禁

```powershell
npm run check
npm test
node scripts\golden-baseline.mjs --check
node scripts\verify-live.mjs
npm run test:live
node scripts\verify-sync.mjs --deploy "<部署根>"
```

当前结果：

- 单元测试：65/65
- Golden：0 不一致
- verify-live：15/15
- Playwright：12 通过 / 2 安全跳过
- 连续重启：5 轮
- 分页：5 轮
- 主题：20 轮

## 5. 修改规则

- 先改规格，再改实现
- 不以单调递增假设处理累计值
- 不用时间戳作为跨格式唯一身份
- 不允许无签名负载
- 不允许键盘监听回归
- 不允许页面负载携带消息正文或路径
- 时序类修改必须多轮实机
- 交付前必须校验四个生效副本
