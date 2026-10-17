# Tokens UI For Codex

在 Codex 桌面版输入区右下角显示一套原生风格的 Token 统计 UI：
上下文用量圆圈左侧是紧凑统计条，左键单击后打开详情弹层。

- 作者：**Littps**
- 平台：Windows 10 / 11
- 客户端：Codex / ChatGPT 桌面版
- 依赖：Codex++ 用户脚本
- 许可：MIT

本项目不修改 Codex 的 React bundle，不注入键盘事件，不展示用户消息正文、会话路径或线程 ID。

## 界面预览

![统计条与详情面板](readme01.png)

![浅色与深色主题](readme02.png)

## 当前界面

紧凑统计条固定在输入区右下、上下文用量圆圈左侧：

```text
会话  当前提问  请求
≈速度  命中率  命中  输出
```

- 第一行：会话累计、当前提问累计、会话请求次数
- 第二行：生成估算速度、当前提问缓存命中率、缓存命中量、当前提问输出量
- 速度使用 `≈XXXT/s`，明确表示估算值
- 指针停留在统计条上时冻结刷新，移出后立即追上最新值

详情弹层包含六个分区：

| 分区 | 内容 |
| --- | --- |
| 会话累计 | 总量、请求、输入/缓存命中、最近有效速度、缓存未命中、输出 |
| 当前提问统计 | 总量、请求、输入/缓存命中、本轮有效速度、缓存未命中、输出 |
| 上下文使用 | 已用 tokens、上下文上限、占用比例 |
| 运行状态 | 状态、监控、页面连接、数据新鲜度、模型切换、累计重置 |
| 当前提问请求明细 | 默认最近 10 条，加载更多每次 +20，最多 500 条 |
| 各轮摘要 | 默认最近 10 轮，加载更多每次 +50，最多 500 轮 |

两个列表均为最新在前。未显示的条目不会进入页面负载，只有点击“加载更多”才按窗口拉取。
页面、监控协议和接收端都严格限制最多 **500** 条；更早的结构化请求与轮次摘要写入本地历史文件，
不进入 CDP payload。达到界面上限时按钮会提示完整记录已保存在本地。

其他交互：

- 详情用 `role="dialog"`，支持点击外部和右上角 `×` 关闭
- 不注册任何键盘监听，Esc 不会关闭详情
- 浅色/深色主题跟随 Codex 宿主，主题切换在约 30ms 防抖后立即应用
- 磨砂玻璃在低性能设备上会自动降级为实色
- 健康指示灯：绿色正常、黄色等待或陈旧、红色异常

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 |
| Codex | 桌面版；支持 MSIX 商店版与传统安装位置 |
| Codex++ | 已安装并启用用户脚本 |
| Node.js | 22 或更高；优先复用 Codex 自带运行时 |
| PowerShell | Windows PowerShell 5.1 或 PowerShell 7 |
| 管理员权限 | 不需要 |

Node 定位规则：

1. 收集 `PATH`、Codex 自带运行时和常见安装位置的全部 `node.exe`
2. 忽略 `.cmd` 包装器和低于 v22 的版本
3. 选择版本最高的 v22+ 可执行文件
4. 找不到时明确中止并提示安装

## 项目依赖与构建

运行时没有第三方 npm 依赖，只使用 Node.js 内置模块：

- `fs` / `path` / `os`
- `crypto`（HMAC-SHA256 与会话哈希）
- `child_process`
- WebSocket / fetch（Node 22+ 内置）

因此部署时不需要执行 `npm install`。源码开发需要：

- Node.js 22 或 24
- Windows PowerShell 5.1 / PowerShell 7
- Playwright 仅在运行 `npm run test:live` 时需要，可安装在本地或全局 npm 目录

项目元数据以 `package.json` 和插件 `.codex-plugin/plugin.json` 为准；CI 会同时测试 Node 22 与 24。

## 安装

### 一键安装

双击部署包根目录的 `install.bat`，或运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\install.ps1"
```

安装器依次执行：

1. 检查 Windows、Node、Codex 桌面版、Codex++、用户脚本总开关和 `codex` CLI
2. 备份并安装 Codex++ 用户脚本，校验 SHA-256
3. 按脚本内容停用历史面板脚本，避免页面出现两条统计条
4. 注册或刷新 `tokens-ui-for-codex@tokens-ui-for-codex-local`
5. 注册用户级计划任务并立即启动一次监控
6. 复核任务、插件、用户脚本和监控进程

### 源码包安装

源码压缩包不要求预先包含 `plugins/` 布局。`install.ps1` 会在：

```text
%LOCALAPPDATA%\tokens-ui-for-codex\install-stage\
```

生成一次性 staging 布局，再注册插件。仓库不会维护两份手工复制的源码。

### 手动安装

```powershell
Copy-Item ".\plugins\tokens-ui-for-codex\tokens-ui-for-codex-panel.js" "$env:APPDATA\Codex++\user_scripts\" -Force
codex plugin marketplace add "<包根>"
codex plugin add tokens-ui-for-codex@tokens-ui-for-codex-local
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\install-autostart.ps1"
```

## 启动与恢复

计划任务名：`tokens-ui-for-codex-monitor`

- 触发：安装完成后立即启动一次；之后仅在当前用户登录时启动
- 周期巡检：无
- 动作：`wscript.exe → launch-silent.vbs → node`
- 重复实例：`IgnoreNew`，不会启动第二个监控
- 失败重启：最多 3 次，间隔 1 分钟
- 运行级别：Limited，不需要管理员权限

监控停止后不会自动反复拉起。手动入口有两种：

1. 详情弹层“启动监控”复制命令，再用 Win+R 打开开始菜单快捷方式
2. 从开始菜单运行“Tokens UI For Codex - 启动监控”

手动入口会先执行 `--instance-status`。若已有存活实例就退出；否则打开 Unicode
PowerShell 确认窗口，只有输入 `Y` 才会在后台启动监控。

## 数据链路

```text
本地 Codex 会话 JSONL
  → token-stats.mjs 增量解析与统计
  → 本机 CDP（动态端口）
  → 签名 schema v3 负载
  → Codex++ 用户脚本验签
  → 原生风格统计条与详情增量渲染
```

关键机制：

- 会话日志只读取结构化数值，不复制、不展示、不外传正文
- 长会话分片自动归组、合并、按 `(timestamp, ordinal)` 排序
- 增量解析器记录偏移、半行缓存和前缀指纹；截断、重建、同长度替换会重建基线
- 单次 `--thread` 与 watch 使用相同的全分片合流路径
- 两代日志格式统一合并，累计下降按 reset 处理，不做单调递增假设
- legacy 自身去重包含完整 input/output/cached 构成
- 现代格式后的 legacy 记录通过本轮线程累计基线差补齐当前轮

统计口径以 [docs/F1-merge-spec.md](docs/F1-merge-spec.md) 为准。

## 速度口径

紧凑条：

- 显示 `≈XXXT/s`
- 使用最近最多 5 个有效请求样本
- 先以中位数抑制单条尖峰，再用 MAD 过滤极端离群值
- 连续 3 个窄分布的高速/低速样本允许建立新速度区间
- 少于 3 个有效样本时显示 `--T/s`，不展示单条尖峰
- 生成耗时使用重叠生成区间并集，避免条目时长重复累加
- 仍明确标记为估算值，不声称是服务商侧纯解码速度

详情页：

- 有效速度 = 输出 tokens ÷（整轮耗时 − 工具执行耗时）
- 当前提问显示本轮有效速度
- 会话累计使用最近 25 个高/中置信度轮次，按输出和耗时加权
- 速度标题同时显示本轮墙钟平均速度；墙钟值只使用 output tokens，不使用上下文累计量
- 输出 tokens 已包含 reasoning、格式与工具结构，不重复添加 reasoning tokens

## 推送节奏

| 状态 | 行为 |
| --- | --- |
| 数据变化 | 立即推送 |
| 任务运行中 | 1 秒心跳 |
| 空闲 | 5 秒心跳 |
| 详情展开且加载长列表 | 不参与心跳，仅在数据/健康/窗口变化时推送 |

## 安全与隐私

- 页面协议为**签名-only schema v3**
- 每次监控启动生成随机 256-bit 会话密钥
- HMAC-SHA256 签名覆盖完整负载、时间戳与 nonce
- 拒绝无 auth、坏 MAC、超过 30 秒、nonce 重放和 seq 倒退
- boot 负载与普通事件负载使用同一验签路径
- 验证前深拷贝负载，验证与应用使用同一快照
- CDP 端口默认 `--port auto`，从 `ChatGPT.exe` 命令行发现；`--port <n>` 可覆盖
- 页面负载不含路径、线程 ID、消息正文、Token、密钥或凭据
- 本地历史归档同样不含消息正文、路径或原始线程标识，只使用会话哈希
- 健康快照和日志属于本机诊断数据，迁移时不建议复制

详细隐私边界见 [README.agent.md](README.agent.md) 与
[MIGRATION-FOR-AGENTS.md](MIGRATION-FOR-AGENTS.md)。

## 健康状态与日志

状态目录：

```text
%LOCALAPPDATA%\tokens-ui-for-codex\
├─ logs\watch-YYYY-MM-DD.log
├─ history\sessions\<sessionHash>\
│  ├─ requests-YYYYMM*.jsonl
│  └─ turns.json
├─ monitor-health.json
├─ autostart-state.json
└─ last-summary.json
```

常用状态：

| 状态 | 含义 |
| --- | --- |
| `starting` | 刚启动 |
| `healthy` | 正常 |
| `waiting-for-cdp` | 本机 CDP 不通 |
| `waiting-for-page` | 页面或对话尚未就绪 |
| `waiting-for-data` | 会话暂无用量数据 |
| `stale-data` | 数据超过时效或会话文件长期无新增 |
| `target-selection-required` | 多窗口且无法唯一确定焦点 |
| `protocol-mismatch` | 页面与监控协议版本不一致 |
| `failed` | 监控或负载校验失败 |

健康文件每个巡检周期更新 `lastSuccessAt` 和 mtime，即使没有向页面推送。

本地历史规则：

- 只保存结构化数值、时间标签、轮次索引和请求索引
- 不保存消息正文、会话路径、线程 ID、response ID 或 turn ID
- 从当前时间起保留 **60 天**
- 请求文件超过 32MB 自动分段
- 每 6 小时检查并清理过期历史
- 标准卸载保留历史；`-Full` 会删除历史

## 排障

| 现象 | 检查顺序 |
| --- | --- |
| 没有统计条 | Codex++ 是否运行；用户脚本总开关；用户脚本是否唯一；重载页面 |
| 统计条等待数据 | `monitor-health.json`、日志、监控进程、Codex CDP 端口 |
| 页面提示协议不匹配 | 用户脚本、插件 cache 和监控脚本是否来自同一版本 |
| 数字不增长 | 定位失败/分片预警；会话文件 mtime；是否切换到了空白新对话 |
| 速度不变化 | 数据源只在 Codex 写入用量记录时更新，心跳不产生新数据 |
| 多窗口异常 | 让目标窗口成为唯一焦点，或使用 `--target <ID>` |
| 中文路径安装失败 | 确认四个 PS1 为 UTF-8 BOM、VBS 为 UTF-16LE |

只读检查命令：

```powershell
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor | Format-List State
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'token-stats\.mjs' } |
  Select-Object ProcessId, CommandLine
Get-Content "$env:LOCALAPPDATA\tokens-ui-for-codex\monitor-health.json" -Raw
```

## 测试与验证

```powershell
npm run check
npm test
node scripts\golden-baseline.mjs --check
node scripts\verify-live.mjs
npm run test:live
node scripts\verify-sync.mjs --deploy "<部署根>"
```

当前基线：

- 单元测试：65 项
- Golden 行为基线：0 不一致
- 实机页面验收：15 项
- Playwright：12 通过，2 个真实输入用例按安全策略默认跳过
- 时序与重启场景要求至少 5 轮实机复测

## 更新、备份与恢复

更新前备份：

- 源码目录
- 正式部署目录
- 插件 cache
- Codex++ 用户脚本
- 状态目录
- Codex/Codex++ 配置（如需要）

更新顺序：

1. 停止旧监控
2. 同步文件
3. 刷新用户脚本
4. 重新注册插件
5. 启动新监控
6. 重载 Codex 页面
7. 执行同步校验与页面验收

安装器会在启动新实例前停止所有旧 `token-stats.mjs --watch` 进程。

## 卸载

```powershell
# 保留状态、日志和用户脚本
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1"

# 完全卸载：任务、进程、状态、用户脚本及备份、插件与缓存
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1" -Full
```

卸载后脚本会执行残留自检。部署包目录本身需要手动删除。

## 已知边界

- 仅支持 Windows + Codex 桌面版 + Codex++
- 页面锚点依赖 Codex 当前 DOM 的可访问性标签；Codex 大版本更新后可能需要调整选择器
- 当前无法从 rollout 事件获得逐 token/chunk 时间线，因此紧凑条速度是估算值
- 无周期 watchdog；进程彻底崩溃且超过任务重启策略后会保持停止，需要手动启动
- 多窗口需要唯一焦点；无法唯一判定时要求显式 `--target`
- 企业环境禁用了计划任务、用户脚本或 CDP 时，需要改用有权限的部署方式

## 许可

MIT License · Copyright (c) 2026 **Littps**
