# Tokens UI For Codex 部署说明

作者：**Littps** · 许可：MIT

## 环境

- Windows 10 22H2 / Windows 11
- Codex / ChatGPT 桌面版
- Codex++，且用户脚本总开关已启用
- Node.js 22+

## 安装

关闭正在运行的旧监控后，在包根运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\install.ps1"
```

安装器会：

1. 备份并替换 Codex++ 用户脚本；
2. 创建或刷新本地 Codex 插件；
3. 注册当前用户登录计划任务；
4. 安装后立即启动一次常驻 watchdog；
5. 验证任务、进程、用户脚本、插件和桌面版。

全程使用当前用户权限，不请求管理员权限。

## 验证

```powershell
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor
node plugins\tokens-ui-for-codex\scripts\check-page-state.mjs
node plugins\tokens-ui-for-codex\scripts\verify-live.mjs
```

页面应只有一个 `#tui-native` 面板，协议为 schema v4 / auth v2。

## 更新

更新前备份部署目录、插件 cache、用户脚本和状态目录。新安装器会停止旧监控并启动新实例，
随后重新加载 Codex 页面。

## 卸载

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1"
```

完全清理：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1" -Full
```

## 说明

- 当前发布物使用 PowerShell watchdog + Node 监控的“原组件模式”。
- 源码树包含独立的 `rust-launcher/` 0.1.0 Alpha；它只替换 watchdog，标准安装器
  不会自动切换，必须按该目录的 README 单独安装和回滚。
- 上下文分类是本地估算；精确已用量与上限来自最后一次请求和模型上限。
- 原组件模式的内存和上下文口径见 `plugins/tokens-ui-for-codex/docs/context-and-resources.md`。
