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
- 验证 HMAC schema v3 负载
- 增量更新 DOM

### 监控

`token-stats.mjs --watch --cdp --port auto`

- 读取本地 Codex rollout JSONL
- 增量解析、分片合并、统计
- 通过本机 CDP 推送签名 schema v3 负载
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

1. 会话累计
2. 当前提问统计
3. 上下文使用
4. 运行状态
5. 当前提问请求明细
6. 各轮摘要

行为：

- 列表最新在前
- 请求默认 10 条，加载更多 +20，上限 500
- 轮次默认 10 轮，加载更多 +50，上限 500
- 页面、协议和接收端均限制 500；更早的结构化记录写入本地历史
- 点击外部或右上角 × 关闭
- 无键盘监听，Esc 不关闭
- 指针悬浮时冻结刷新
- 磨砂玻璃在性能不足时降级
- 紧凑条速度使用最近 5 个有效请求样本的中位数和 MAD 离群过滤
- 样本少于 3 个时显示 `--T/s`
- 详情速度标题包含本轮墙钟平均，墙钟值只使用 output tokens

## 启动模型

计划任务：

```text
tokens-ui-for-codex-monitor
```

触发：

- 安装后立即启动一次
- 当前用户登录时启动

没有周期巡检。

任务动作：

```text
wscript.exe → launch-silent.vbs → node
```

手动启动：

```text
launch-confirm.vbs → start-monitor.ps1 → 用户输入 Y → launch-silent.vbs
```

监控停止后需要手动恢复，不会每几分钟自动拉起。

## 协议安全

页面只接受签名 schema v3：

- `authRequired=true`
- `auth.v=1`
- HMAC-SHA256
- ±30 秒时间窗
- nonce 防重放
- seq 严格递增
- boot 负载同样验签

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
| 状态目录 | `%LOCALAPPDATA%\tokens-ui-for-codex\` |
| 健康快照 | `...\monitor-health.json` |
| 日志 | `...\logs\watch-YYYY-MM-DD.log` |
| 自启状态 | `...\autostart-state.json` |
| 简略快照 | `...\last-summary.json` |
| 历史请求 | `...\history\sessions\<sessionHash>\requests-YYYYMM*.jsonl` |
| 历史轮次 | `...\history\sessions\<sessionHash>\turns.json` |

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
%LOCALAPPDATA%\tokens-ui-for-codex\install-stage\
```

## 验证

```powershell
npm run check
npm test
node scripts\golden-baseline.mjs --check
node scripts\verify-live.mjs
npm run test:live
node scripts\verify-sync.mjs --deploy "<部署根>"
```

页面必须满足：

- `panelCount=1`
- `styleCount=1`
- `payloadSchema=3`
- `auth.mac` 存在
- 统计条位于上下文圆圈左侧
- `window.__tuiForCodexNativeUiInstalled === true`

当前基线：

- 单元测试 65
- Golden 0 不一致
- verify-live 15 项
- Playwright 12 通过 / 2 安全跳过

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
- `launch-silent.vbs` 必须包含正确 Node 与脚本路径
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
- 无周期 watchdog
- 实时逐 token 速度不可得
- 多窗口需要唯一焦点或显式 target
