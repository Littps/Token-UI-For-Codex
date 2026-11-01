---
name: tokens-ui-for-codex
description: 安装、更新、验证、备份、恢复和排查 Tokens UI For Codex；用于 Codex 桌面版原生风格 Token 统计条、详情弹层、Codex++ 用户脚本和本地监控进程。
---

# Tokens UI For Codex

作者：**Littps**

平台：Windows 10/11 + Codex 桌面版 + Codex++
插件标识：`tokens-ui-for-codex@tokens-ui-for-codex-local`

运行时无第三方 npm 依赖；部署不需要 `npm install`。Playwright 只在
`npm run test:live` 时需要。

## 何时使用

用户提到以下内容时使用本技能：

- Tokens UI For Codex
- Codex Token 统计条 / 用量详情
- Token 面板不显示、不更新或数字异常
- 安装、更新、迁移、备份、恢复、卸载本插件
- Codex++ 用户脚本或本地监控进程排障

## 系统组成

### 页面

`tokens-ui-for-codex-panel.js`

- 由 Codex++ 注入
- 将紧凑统计条放在上下文用量圆圈左侧
- 左键打开详情弹层
- 跟随 Codex 浅色/深色主题
- 验证 HMAC schema v4 / auth v2 负载
- 增量更新 DOM

### 监控

`token-stats.mjs --watch --cdp --port auto`

- 读取本地 Codex rollout JSONL
- 增量解析、分片合并、统计
- 通过本机 CDP 推送签名 schema v4 / auth v2 负载
- 会话候选需存在对应 rollout 并稳定 2.5 秒后才切换
- 新对话 placeholder 不允许映射到任意旧文件
- 写入健康快照、简略快照和日志

### 安装

- `install.ps1`
- `install-autostart.ps1`
- `uninstall-autostart.ps1`
- `find-codex.ps1`

## 用户可见 UI

紧凑条：

```text
会话  当前提问  请求
≈速度  命中率  命中  输出
```

详情六区：

1. 统计信息（今日 / 近3天 / 近7日 / 近30日 / 全部）
2. 当前提问统计
3. 上下文使用
4. 监控操作
5. 当前提问请求明细
6. 各轮摘要

详情扩展：

- 统计信息与当前提问各有一行紧凑时间带：总用时、工具并集耗时、TTFT；
- 上下文分类为本地估算，显示完整整数、`≈` 和明确免责声明；
- 工具定义等来源缺失时显示 `--`，不得伪造 0；
- 未归类内容超过 60% 时隐藏分类，仅保留精确已用量和上限；
- 高性能设备自动使用强磨砂，低性能、远程桌面或减少透明效果时降级；
- 关闭详情使用约 110ms 退场动画。
- “统计信息”默认加载全部本地归档，可切换今日、近3天、近7日、近30日和全部；
  选择会持久化，详情关闭时不计算范围汇总；重新打开先显示最长 24 小时的范围缓存，
  再用新签名负载替换。同页重开会恢复上次展开的轮次与请求快照。
- 紧凑条“会话”是完整线程累计；详情“全部”是本地 60 天可定位轮次之和。首条日志前的
  无日期基线不进入详情时间范围，两者不能按相等验收；详见 `docs/metric-scopes.md`。
- 健康灯支持鼠标悬浮或键盘聚焦，显示错误码、原因、恢复状态、CDP/页面状态和最近成功时间。

行为：

- 列表最新在前
- 请求默认 10 条，加载更多 +20，上限 500
- 轮次默认 10 轮，加载更多 +50，上限 500
- 页面、协议和接收端均限制 500；更早的结构化记录写入本地历史
- 点击外部或右上角 × 关闭
- 无键盘监听，Esc 不关闭
- 指针悬浮时冻结刷新
- 强磨砂在性能不足时自动降级
- 紧凑条速度使用最近 5 个有效请求样本的中位数和 MAD 离群过滤
- 样本少于 3 个时显示 `--T/s`
- 详情速度标题包含本轮墙钟平均，墙钟值只使用 output tokens

## 上下文与资源

- `contextUsed` 取最后一次请求 total，并受模型上下文上限约束。
- 系统/开发指令、工具定义、对话消息和其他/模板分类都是本地字符权重估算。
- 缺失分类显示 `--`；未归类超过 60% 时只显示精确已用量和上限。
- 估算只保留数值权重，不保存或下发正文、路径、线程 ID 或 response ID。
- 当前原组件模式为 PowerShell watchdog + Node monitor；本机代表值约 watchdog
  90–120 MB、Node 140–160 MB，合计 230–280 MB，空闲 CPU 通常接近 0%。
- 源码树另有 `rust-launcher/` 0.1.0 Alpha 实验组件，只替换 watchdog，仍使用同一
  Node monitor；标准安装包不会自动切换。其独立运行包的构建、诊断、安装和回滚说明
  以 `rust-launcher/README.md` 为准。Rust 版本没有做详细测试，未完成多设备、
  长时间、睡眠唤醒、网络异常、企业策略和跨版本升级验证。

## 启动模型

默认安装仍使用以下 PowerShell 模型：

计划任务：

```text
tokens-ui-for-codex-monitor
```

触发：

- 登录时启动一次常驻 watchdog；进程内每 15 秒检查
- 安装后立即执行一次 watchdog

任务动作：

```text
powershell.exe -WindowStyle Hidden → monitor-watchdog.ps1 -Resident
                                           ↓ 异常时
                                      launch-silent.ps1 → node
```

手动启动：

```text
launch-confirm.vbs → start-monitor.ps1 → 用户输入 Y
→ monitor-watchdog.ps1 -Resident -ForceStart
```

watchdog 保持常驻；进程消失或连续心跳停滞时才重启。原地升级遗留的无心跳
旧监控超过启动宽限后只受控迁移一次；停止未确认时不会启动第二实例。

单实例策略：一个 Windows 用户默认只允许一个监控。用户级 guard lock、主锁和
进程交叉审计共同生效；`--allow-multi-monitor` 仅供隔离测试。

## 协议安全

页面只接受签名 schema v4：

- `authRequired=true`
- `auth.v=2`
- HMAC-SHA256
- HMAC 只做完整性和来源校验，不是加密
- ±30 秒时间窗
- nonce 防重放
- seq 严格递增
- `keyId` 变化时轮换密钥状态
- 临时密钥入口在同步事件派发后立即删除

以下负载会被拒绝：

- 无 auth
- 坏 MAC
- 过期
- nonce 重放
- seq 倒退

页面负载不含：

- 会话路径
- 线程 ID
- response ID / turn ID
- 消息正文
- API key / Token

完整认证格式与威胁边界见 `docs/auth-v2.md`。

## 推送节奏

| 状态 | 行为 |
| --- | --- |
| 数据变化 | 立即推送 |
| 任务运行中 | 1 秒心跳 |
| 空闲 | 5 秒心跳 |
| 展开长列表 | 不心跳，只在变化时推送 |

## 常用路径

| 项目 | 路径 |
| --- | --- |
| 用户脚本 | `%APPDATA%\Codex++\user_scripts\tokens-ui-for-codex-panel.js` |
| 运行时路径配置 | 插件目录下的 `runtime-paths.json` |
| 状态目录 | `runtime-paths.json` 解析出的 `<CODEX_HOME>\tokens-ui-for-codex\state\` |
| 健康快照 | `...\monitor-health.json` |
| 独立心跳 | `...\monitor-heartbeat.json` |
| Watchdog 状态 | `...\watchdog-state.json` |
| Watchdog 锁 | `...\watchdog.lock` |
| 日志 | `...\logs\watch-YYYY-MM-DD.log` |
| 自启状态 | `...\autostart-state.json` |
| 简略快照 | `...\last-summary.json` |
| 历史请求 | `...\history\sessions\<sessionHash>\requests-YYYYMM*.jsonl` |
| 历史轮次 | `...\history\sessions\<sessionHash>\turns.json` |

实际路径读取插件目录中的 `runtime-paths.json`。CLI、环境变量和路径优先级见
`docs/runtime-paths.md`。

## 安装

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<包根>\install.ps1"
```

安装器会：

1. 检查 Codex++、用户脚本开关、Node 22+、Codex 和 codex CLI
2. 备份并安装用户脚本
3. 停用历史面板脚本
4. 注册/刷新插件
5. 注册计划任务
6. 停止所有旧监控并启动新监控
7. 自检任务、进程、用户脚本、插件和桌面版

源码包没有预构建 `plugins/` 时，会自动生成：

```text
<CODEX_HOME>\tokens-ui-for-codex\install-stage\
```

## 验证

```powershell
npm run check
npm test
npm run test:auth-ui
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-watchdog.ps1
node scripts\golden-baseline.mjs --check
node scripts\verify-live.mjs
npm run test:live
node scripts\verify-sync.mjs --deploy "<部署根>" --zip "<安装包>"
```

默认严格要求五副本完整存在；发布验收必须同时满足 `errors: []` 与
`mismatches: 0`。`--allow-partial` 仅供开发诊断，发布验收不得使用。

页面必须满足：

- `panelCount=1`
- `styleCount=1`
- `payloadSchema=4`
- `auth.v=2`
- `auth.keyId` / `auth.nonce` 各 32 位十六进制
- `auth.mac` 存在
- 统计条位于上下文圆圈左侧
- `window.__tuiForCodexNativeUiInstalled === true`

当前基线：

- 单元测试 87
- 本地隔离页 auth UI 5
- 固定合成快照 0 不一致；真实本机 Golden corpus 未随源码发布
- verify-live 29 项，部署当前源码后实跑通过
- 实机 Playwright 19 个用例；当前 17 通过 / 2 安全跳过

## 健康状态

| 状态 | 含义 |
| --- | --- |
| `starting` | 刚启动 |
| `healthy` | 正常 |
| `waiting-for-cdp` | 本机 CDP 不可达 |
| `waiting-for-page` | 页面未就绪或对话 ID 未解析 |
| `waiting-for-data` | 当前会话无用量 |
| `stale-data` | 数据过期或文件长期无新增 |
| `target-selection-required` | 多窗口且无唯一焦点 |
| `protocol-mismatch` | 协议版本不一致 |
| `failed` | 监控或负载校验失败 |

健康文件每个巡检周期都应更新 mtime 和 `lastSuccessAt`。

## 本地历史

- 保留 60 天
- 请求文件超过 32MB 自动分段
- 每 6 小时清理一次过期文件
- 只保存数值、时间标签、轮次/请求索引和会话哈希
- 不保存消息正文、路径、原始线程 ID、response ID 或 turn ID
- 页面接口仍严格限制 500 条，历史归档不经过 CDP
- 标准卸载保留历史；`-Full` 删除历史

## 排障顺序

### 没有统计条

1. Codex++ 是否运行
2. 用户脚本总开关是否启用
3. 用户脚本是否唯一
4. 用户脚本与部署哈希是否一致
5. 页面是否重载

### 等待数据

1. 检查 `monitor-health.json`
2. 检查最近日志
3. 检查 `node token-stats.mjs --instance-status`
4. 检查 Codex CDP 端口
5. 检查当前是否为空白新对话

### 数字不增长

1. 检查日志中的“数据停滞 / 定位失败 / 定位预警”
2. 检查会话文件 mtime
3. 检查是否合并了所有分片
4. 检查是否切换了会话

### 协议不匹配

1. 重新安装用户脚本
2. 重载 Codex 页面
3. 确认插件 cache 版本
4. 确认监控进程命令行指向当前部署

### 中文路径或启动失败

- PS1 必须 UTF-8 BOM
- VBS 必须 UTF-16LE BOM
- `launch-silent.ps1` 必须包含正确 Node 与脚本路径
- `start-monitor.ps1` 必须存在

## 备份

完整备份应包含：

- 源码
- 部署
- 插件 cache
- Codex++ 用户脚本
- 状态目录
- 必要配置

清单至少包含：

- 相对路径
- 大小
- SHA-256
- 文件数

恢复后重新运行安装器并验证副本哈希。

## 卸载

```powershell
# 保留状态和日志
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\uninstall-autostart.ps1"

# 完全卸载
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\uninstall-autostart.ps1" -Full
```

`-Full` 清理：

- 计划任务
- 开始菜单和 URL 协议
- 监控/旧守护进程
- 用户脚本及备份
- 状态目录和日志
- Codex 插件、marketplace 和 cache

清理不完整时卸载器返回非 0，并列出残留任务、进程、脚本、插件或状态目录。
包目录本身最后手动删除。

## 禁止事项

- 不读取、复制或外传会话正文
- 不修改 Codex++ `user_scripts.json`
- 不修改 Codex `config.toml`
- 不使用管理员权限
- 不把未签名负载接入页面
- 不把本地历史归档随页面 payload 发送
- 不重新引入键盘监听
- 不把历史 `start-monitor.cmd` 当作当前实现

## 已知边界

- Windows only
- 依赖 Codex++
- DOM 锚点可能随 Codex 更新变化
- watchdog 只处理进程存活，不重启 CDP/页面/数据暂时不可用
- 上下文分类是本地字符权重估算，不是服务端 tokenizer 或计费分类
- 实时逐 token 速度不可得
- 多窗口需要唯一焦点或显式 target
- HMAC 是基础完整性验证，不隔离同用户恶意进程或同 Realm 页面脚本
- 新会话候选需稳定确认，极端情况下切换会比页面慢约 2.5–5 秒
