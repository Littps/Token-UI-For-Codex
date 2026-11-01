# Tokens UI For Codex - Rust Launcher

作者：**Littps**

状态：**0.1.0 Alpha，隔离测试版**

> **重要：Rust 版本没有做详细测试。** 当前只完成构建、自动化隔离测试、短时计划任务
> 安装/卸载测试和本机资源采样；尚未完成多设备矩阵、长时间运行、睡眠唤醒、网络异常、
> 企业安全策略、杀软拦截、跨版本升级和故障注入验证。不要把它当作正式稳定默认启动层。

这个组件只替换 Tokens UI For Codex 的常驻启动层：

```text
旧模式：PowerShell watchdog -> Node token-stats.mjs
Rust：tokens-ui-launcher.exe -> Node token-stats.mjs
```

页面注入、CDP、认证协议、统计逻辑、历史归档和现有 UI 均不修改。Rust
launcher 默认不替换当前已安装的 PowerShell 模式；必须先完成隔离测试，再由
用户明确选择是否安装。

## 组件

| 文件 | 用途 |
| --- | --- |
| `tokens-ui-launcher.exe` | Windows GUI 子系统常驻 supervisor，不创建控制台窗口 |
| `tokens-ui-doctor.exe` | 控制台诊断、状态检查和停止工具 |
| `install-rust-launcher.ps1` | 备份旧任务、切换并验证 Rust supervisor |
| `uninstall-rust-launcher.ps1` | 停止 Rust supervisor并恢复原计划任务 |
| `SHA256SUMS.txt` | 发布文件完整性校验 |

## 一键构建

双击：

```text
build.cmd
```

或运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-and-package.ps1
```

脚本依次执行：

```text
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets -- --test-threads=1
cargo build --release --locked
运行包生成
源码包生成
SHA-256 生成
```

构建机需要 Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK
Debugging Tools（`pdbcopy.exe`、`symchk.exe`）。脚本把中间产物放在
`%PUBLIC%\TokensUIForCodexBuild-<PID>-<随机值>`，避免 PDB 写入个人目录绝对路径，
并在结束后删除该临时构建缓存。可用 `-BuildDirectory` 指定并保留其他公共构建目录。

输出默认写入 `rust-launcher\artifacts\`。可指定其他目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\build-and-package.ps1 `
  -OutputDirectory "$env:USERPROFILE\Desktop"
```

不需要发布 PDB 时可加 `-WithoutSymbols`；默认发布的 PDB 先经 `pdbcopy -p`
移除私有信息，再由 `symchk` 验证与 EXE 匹配。发布前还会扫描所有包文件，发现
用户目录、源码目录或 Cargo 目录绝对路径就中止。

## 隔离测试

集成测试使用临时目录和模拟 Node 监控，不读取真实会话，不修改正式插件，也不
使用真实 Codex 数据。当前测试覆盖：

1. 启动后写入 `watchdog-state.json` 并进入 `healthy`。
2. 第二个 Rust supervisor 被会话级 Mutex 拒绝。
3. 强杀模拟 Node 后，supervisor 按退避自动拉起新 PID。
4. `tokens-ui-doctor --diagnose` 能识别 launcher 与 monitor。
5. `tokens-ui-doctor --stop` 终止 supervisor。
6. Job Object 的 `KILL_ON_JOB_CLOSE` 连带清理 Node 子进程。
7. 随机临时计划任务完成安装、healthy 校验和完整卸载，正式任务保持不变。

单独复跑：

```powershell
cargo test --all-targets -- --test-threads=1
```

本机 2026-11-01 release 实测：Rust supervisor 工作集约 6.8–6.9 MB；3 秒采样低于
0.001% 单核显示精度。真实 Node 监控不计入该数字。

发布包的安装/卸载烟雾测试会创建一个随机命名的临时计划任务，验证完成后立即删除；
它不会改动 `tokens-ui-for-codex-monitor` 正式任务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\tests\install-smoke-test.ps1 `
  -PackageDirectory "<解压后的运行包目录>"
```

## 诊断

```powershell
.\tokens-ui-doctor.exe --diagnose --plugin-root "<插件部署目录>"
.\tokens-ui-doctor.exe --stop --plugin-root "<插件部署目录>"
```

`--diagnose` 输出 JSON，包括解析后的路径、Node 候选、watchdog 状态、心跳年龄和
两个进程是否存活。

## 安全边界

- 只接受本机文件路径和本机进程操作，不建立网络连接。
- Node 通过 `CREATE_NO_WINDOW` 启动。
- Node 被放入 Windows Job Object；supervisor 异常退出时由系统终止子进程。
- supervisor 使用当前 Windows 用户会话级单实例 Mutex。
- supervisor 在运行期间独占 `watchdog.lock` 文件句柄，阻止旧 PowerShell watchdog
  同时取得同一把锁。
- 启动前会拒绝复用已有 heartbeat/lock 指向的存活监控。
- 临时文件和日志只写入 `runtime-paths.json` 解析后的状态目录。
- 不读取、复制或外传 Codex 会话正文。
- 发布 EXE/PDB 在打包阶段执行路径重映射和私有路径扫描；PDB 不包含本机私有路径。
- 发布二进制当前未做 Authenticode 签名；下载后应核对 SHA-256。

## 安装与回滚

安装脚本要求已存在 Tokens UI For Codex 插件部署目录。它会导出旧计划任务 XML，
停止旧 watchdog 和对应 Node，再注册 Rust 启动任务；新任务无法进入可用状态时会
尝试恢复旧任务。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\install-rust-launcher.ps1 `
  -PluginRoot "$env:USERPROFILE\.codex\tokens-ui-for-codex\install-stage\plugins\tokens-ui-for-codex"
```

恢复原 PowerShell 模式：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\uninstall-rust-launcher.ps1 `
  -PluginRoot "$env:USERPROFILE\.codex\tokens-ui-for-codex\install-stage\plugins\tokens-ui-for-codex"
```

安装器带高风险确认。不要在当前正式实例仍运行时直接覆盖启动方式；先完成备份并
确认没有第二个监控。

## 已知边界

- 仅支持 Windows 10/11 x64。
- 需要 Node.js 22 或更高版本。
- 当前不是正式默认启动模式。
- 未做代码签名，企业环境可能触发 SmartScreen 或终端安全策略。
- Rust supervisor 只负责进程存活和停滞重启，不修复 CDP、页面或数据解析故障。
- Rust 包只包含 Rust 启动层；仍需原插件的 `token-stats.mjs`、用户脚本和配置。
