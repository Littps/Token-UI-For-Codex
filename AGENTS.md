# AGENTS.md

## 项目定位

- 工具：Codex / ChatGPT 桌面版 Token 用量统计面板（项目名 Tokens UI For Codex）。
- 仅针对 Codex / ChatGPT 桌面版，不针对 codex cli。
- 依赖 Codex++：面板脚本必须放到 `%APPDATA%\Codex++\user_scripts` 才会生效；未安装 Codex++ 时工具不支持。
- 已内置「当前对话 ID」检测逻辑（从页面 DOM / React fiber 读取当前对话），完全自研，无需任何外部脚本。

## 目录结构

- `codex-token-spend-panel.js`：面板 UI 脚本，注入 Codex 页面（基于 Codex++ 用户脚本机制）。
- `token-stats.mjs`：核心监控，读 Codex 会话日志统计 token，通过 CDP（127.0.0.1:9229）WebSocket 向页面推送数据。
- `install-autostart.ps1` / `uninstall-autostart.ps1`：登录自启安装与卸载（计划任务直接拉起 Node 监控，无常驻守护进程）。
- `README.md`：说明文档（含测试环境与支持环境说明）。
- `README.en.md`：英文版说明文档（中文版顶部含语言切换链接）。
- `docs\` / `scripts\` / `test\` / `schemas\` / `.github\`：规格、工具脚本、测试、schema 与 CI。
- **本源码仓库不含** `release\`、`build\`、`node-version\`、`exe-version` 与预编译 exe/zip；发布包（`.agents\` + `plugins\` + `DEPLOYMENT.md` + `install.bat`）在本机部署目录生成，用 `scripts\build-package.ps1` 打包。

## 工作原理

- 监控进程读 Codex 本地会话日志，统计当前对话的 token 消耗（输入含缓存命中/未命中、输出、请求数、会话累计、每轮明细等）。
- 通过 CDP WebSocket 推送数据：数据变化时立即推送，无变化时每 5 秒固定推送一次。`window.__ccmTokenSpend` 为 schema v2 负载，包含汇总数字、时间标签、各轮摘要和当前提问最近最多 100 条请求明细，并触发事件 `ccm-token-spend`。负载不包含会话文件路径、线程 ID 或用户消息片段。
- 面板脚本将紧凑统计条插入 Codex 原生上下文用量圆圈所在的同级横向容器左侧；左键单击统计条打开原生风格详情弹层；不修改 React bundle，不再创建右下角悬浮面板。
- 新对话的占位 ID（`local:client-new-thread:<uuid>`）到真实 UUID 的映射会持久化到 `%LOCALAPPDATA%\tokens-ui-for-codex\client-thread-map.json`（旧目录 `ccm-token-spend` 存在时自动迁移，不覆盖已有新目录）。
- 监控日志：`%LOCALAPPDATA%\tokens-ui-for-codex\logs\watch-YYYYMMDD.log`（按日分文件）。Codex 重启后若面板卡「等待数据」，先查该日志与进程是否存活。
- 登录自启：计划任务 `tokens-ui-for-codex-monitor`，触发方式为「安装后立即执行 + 每 5 分钟兜底巡检 + 登录时启动」；任务动作是 `wscript.exe → launch-silent.vbs → node`（无终端窗口、不经 PowerShell、不受执行策略影响），重复实例策略「不启动新实例」，失败重启 3 次 / 间隔 1 分钟，运行级别 Limited（不需要管理员权限）。自启状态见 `%LOCALAPPDATA%\tokens-ui-for-codex\autostart-state.json`（`stateVersion: 2`）与 `monitor-health.json`。**项目不使用常驻 PowerShell 守护进程**（`guardian.ps1` 已删除）。

## 修改约定（重要）

- 编辑 JS / 含中文文件时，必须使用 Node `fs.writeFileSync`（UTF-8）写入，不要用 PowerShell 直写，否则中文编码会坏。
- 修改后保持源码、部署目录、插件 cache、`%APPDATA%\Codex++\user_scripts` 下的生效脚本同步；用 `node scripts\verify-sync.mjs --deploy <部署根> --zip <包路径>` 校验（当前比对 7 个文件：`token-stats.mjs` / `codex-token-spend-panel.js` / `protocol.mjs` / `find-codex.ps1` / `install.ps1` / `install-autostart.ps1` / `uninstall-autostart.ps1`；不一致即失败）。
- 写 `%APPDATA%\Codex++\user_scripts`、停止/重启监控进程都属于用户级操作，**不需要管理员权限**；但在受限沙箱里执行时可能需要向用户申请文件或进程权限。
- 用户偏好：
  - 全程使用中文沟通。
  - 改完不主动重新打包 exe；用户说需要打包时才打包。
  - 重大改动先记录下来再动手改。
  - 不主动 git commit / push，除非用户明确要求。
- 提交/发布前检查是否包含隐私或本机敏感信息（真实用户目录、Token、密钥、邮箱、私网地址、带凭据的 URL 等）。

## 面板设计

- 第一行从左到右显示「会话 / 当前提问 / 请求」，第二行显示当前提问「命中 / 未命中 / 输出」。
- 统计条使用原生布局、字体和主题变量，紧邻上下文用量圆圈左侧；无独立悬浮窗口、拖拽、缩放或位置记忆。
- 详情弹层使用 `role="dialog"`，关闭方式为「点击外部或右上角 ×」（`mousedown`/`pointerdown` 双重兜底）；**插件不注册任何键盘监听**（统计条与弹层均无 Enter/空格/Esc 处理）。弹层不拦截上下文圆圈和模型选择器。
- 启动加载期读不到对话 ID 时显示 0（不回退到上一条对话的数据）。
- 监控程序缓存未变化的会话文件和已生成的页面负载，减少重复解析与序列化；页面负载只保留展示所需的数字字段。
- 增量读取器记录文件偏移、半行缓存和文件指纹；检测到截断、重建或同长度替换时必须安全重建，不得继续沿用旧统计。
- 多窗口默认选择唯一焦点目标，其次唯一可见目标；无法唯一判断时必须报 `CDP_TARGET_SELECTION_REQUIRED`，不得随机选择。
- 页面与监控程序通过 schema v2、协议名和能力集合握手；未知字段可忽略，但不支持的版本必须显示协议不匹配。

## 运行 / 测试 / 打包

- 环境：Node v24.x；脚本用 `.mjs` 结尾避免 require/await 冲突。
- `token-stats.mjs` 支持 `CCM_TOKENS_AS_MODULE=1` 导入做单元测试，导出 `clientState`、`findNewestClientFileSince`、`findNewestUnclaimedFile` 等。
- `npm test` 使用 Node 内置 `node:test`（当前 39 项），覆盖截断、乱序、重复事件、上下文压缩、模型切换、累计重置、schema 校验、多窗口目标选择、会话分片（归组/合并/后缀剥离）与停滞两级告警。
- `npm run perf -- 20000` 运行本地脱敏性能基准；当前无第三方运行时依赖，不需要安装 Playwright 才能执行核心测试。
- `npm run verify:live` 做本机实机验收（协议、统计条位置、分区顺序、外部点击关闭）；附加 `-- --refresh` 可实测 5 秒固定刷新。
- `npm run reload` 用于更新 Codex++ 用户脚本后重载 Codex 渲染页面；重载不会修改会话数据或配置。
- `npm test` 只跑单元测试；`npm run test:live` 跑 Playwright 实机测试（当前 13 个用例：11 通过 + 2 个真实输入用例按安全约定跳过；需要 Codex 桌面版与 CDP 端口在线，且必须带 `--test-force-exit`，否则 CDP 连接会阻止进程退出）。Esc 相关用例断言"不关闭弹层"——键盘监听已按用户要求移除。
- 排查用只读脚本：`node scripts/check-page-state.mjs`（页面与负载状态）、`node scripts/close-detail-dialog.mjs`（仅用 DOM 事件关闭弹层）、`node scripts/reset-page-input-state.mjs`（清理诊断残留并关闭焦点模拟）。
- 严禁在默认测试流程里注入真实键鼠：CDP 注入的 Escape 会被 Codex 当作“停止回答”，字符注入会污染输入框；真实输入测试必须显式设置 `CCM_ALLOW_REAL_INPUT=1`。
- 统计口径以 `docs/F1-merge-spec.md` 为准：A（token_count）与 B（token_usage_record）统一合并，累计量走 reset-aware 归一化，**禁止单调递增假设**。
- 监控日志由监控进程自管（`%LOCALAPPDATA%\tokens-ui-for-codex\logs\watch-YYYYMMDD.log`）；不要再让 `Start-Process -RedirectStandardOutput` 覆盖同名日志。
- 发布前必须运行 `node scripts/verify-sync.mjs --deploy <部署根> --zip <包路径>`，五处副本哈希不一致即视为发布失败。
- 运行时状态读取注意 MSIX 虚拟化：在 Codex 应用上下文里读 `%LOCALAPPDATA%` 可能看到包 LocalCache 的陈旧副本，结论前必须与非打包进程读数或活体日志交叉验证。
- 注意 `NODE_OPTIONS` 可能让子 Node 进程继承 `--inspect-port=127.0.0.1:9229`，与 Codex 的 CDP 端口相同；测试脚本不要假设 9229 一定属于 Codex，连不上时应先确认端口占用方。
- CDP 目标：`http://127.0.0.1:9229/json/list`。
- **本项目不提供预编译 exe**，安装器也没有 exe 回退分支：运行时只支持 Node 22+（或复用 Codex 自带运行时）。如未来需要单文件分发，再另行设计（当前明确不做）。
- 测试环境说明（已写入 README）：接入第三方 API、固定单模型下测试；未测试切换模型的效果。
