# Tokens UI For Codex

A compact token usage bar inside the Codex desktop composer, plus a native-style detail popover.
Everything is computed locally; nothing is sent anywhere.

## What it looks like

The bar sits to the left of the native context-usage ring:

- Line 1: `session total / current prompt total / request count`
- Line 2: `hit rate / cached / uncached / output`

Left-click the bar to open the detail popover with six sections:
session totals, current-prompt stats, context usage, run status, current-prompt request details (latest 100), and per-turn summaries (latest 200).

Close the popover by clicking outside it or clicking `×`. The plugin registers **no keyboard listeners** (Esc does not close it).

Light/dark theming follows the Codex theme automatically.

## Requirements

| Item | Requirement |
| --- | --- |
| OS | Windows 10 22H2 / Windows 11 |
| Client | Codex / ChatGPT **desktop** (MSIX store build or classic install) |
| Codex++ | Required. Injects the user script and provides the local CDP port (default `127.0.0.1:9229`) |
| Node.js | 22+; if not installed separately, the runtime bundled with the Codex desktop app (v24 in practice) is reused |
| PowerShell | 5.1+ (used by install/uninstall scripts; no admin rights required) |
| Network | Not required |

## Installation

### One-click (recommended)

1. Make sure **Codex++** is installed (otherwise the bar cannot be injected).
2. Put the package folder anywhere (e.g. Desktop) and double-click `install.bat`.
3. The installer runs: environment checks → user-script install (auto backup + SHA-256 verify) → local plugin registration → logon autostart → immediate monitor start with self-check.
4. Fully quit and reopen the Codex desktop app so the user script is injected.

Optional parameters:

| Parameter | Effect |
| --- | --- |
| `install.ps1 -SkipAutostart` | Skip autostart (run `install-autostart.ps1` later) |
| `install.ps1 -SkipPlugin` | Install only the Codex++ user script |

### Manual (three steps)

```powershell
# 1) User script (the bar itself)
Copy-Item ".\plugins\tokens-ui-for-codex\codex-token-spend-panel.js" "$env:APPDATA\Codex++\user_scripts\" -Force

# 2) Register the local Codex plugin (skills for the agent)
codex plugin marketplace add "<package folder>"
codex plugin add tokens-ui-for-codex@tokens-ui-for-codex-local

# 3) Logon autostart (scheduled task; no admin rights)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\install-autostart.ps1"
```

## Autostart and watchdog

Autostart uses a **scheduled task** `tokens-ui-for-codex-monitor`; there is no resident guardian process:

| Trigger | Behavior |
| --- | --- |
| Right after install | Starts once immediately (retries once on failure and reports clearly) |
| Every 5 minutes | Watchdog: restarts the monitor if it died; adds zero processes while it runs |
| At logon | Starts automatically after you sign in |

The monitor itself stays alive while Codex is closed and starts reporting as soon as Codex appears.
Multiple-instance policy is "do not start a new instance", so the watchdog never double-launches.

Manual run (debug):

```powershell
node .\token-stats.mjs --watch --cdp
```

## Data reliability and alerts

The host may **segment** a session log (large conversations are split into multiple files with different names
and directories). The monitor discovers **all segments** of a session and merges them chronologically
(cross-segment deduplication by content key), so numbers stay continuous across segmentation.

Stall alerts are written to `logs\watch-YYYYMMDD.log`:

| Level | Condition | Action |
| --- | --- | --- |
| Warning | Session file unchanged for 5 minutes | Log only (normal idle sessions fall here) |
| Degrade | Session file unchanged for 15 minutes | Panel shows "data not updated" (grey state) |

If no file matches the session ID, or files that look like this session are found but not recognized
(the host may have changed its naming again), the log prints a **locate failure / locate warning**
with recent file samples for fast triage. Thresholds can be overridden with
`CCM_FILE_STALL_WARN_MINUTES` / `CCM_FILE_STALL_MINUTES`.

## Uninstall

```powershell
# Standard: remove the task, stop processes, keep logs and state
powershell -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1"

# Full wipe: also remove state, user script (incl. install backups), plugin and plugin cache
powershell -NoProfile -ExecutionPolicy Bypass -File ".\plugins\tokens-ui-for-codex\uninstall-autostart.ps1" -Full
```

| Switch | Effect |
| --- | --- |
| `-PurgeState` | Delete the state directory (logs, thread map, diagnostics) |
| `-RemoveUserScript` | Delete the Codex++ user script |
| `-RemovePlugin` | Remove the Codex plugin and local marketplace entry |

The script finishes with a leftover self-check (task / processes / user script / plugin cache / state dir).
The package folder itself is the only thing you must delete manually.

## Data and privacy

- The monitor reads only structured fields from local session logs;
- The payload pushed to the page (schema v2) contains numbers, time labels, turn summaries and a bounded current-prompt request list;
- It contains **no** message text, file paths, thread IDs or credentials;
- No network requests are made.

## Troubleshooting

Map the `run status` health value:

| Status | Meaning |
| --- | --- |
| `healthy` | Normal |
| `starting` | Monitor just started, waiting for the first sample |
| `waiting-for-cdp` | Cannot reach `127.0.0.1:9229`; start Codex and Codex++ |
| `waiting-for-page` | Page not ready; reload the Codex page |
| `waiting-for-data` | Connected but this conversation has no stats yet |
| `stale-data` | Two sources: (1) no data for 15s; (2) session file unchanged for 15 minutes (see "Data reliability and alerts"). Check the monitor process and the "数据停滞" log entries |
| `target-selection-required` | Multiple Codex windows; pass `--target <ID>` explicitly |

Handy checks:

```powershell
Get-ScheduledTask -TaskName tokens-ui-for-codex-monitor | Get-ScheduledTaskInfo
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'token-stats'
Get-Content "$env:LOCALAPPDATA\tokens-ui-for-codex\monitor-health.json" -Raw
```

If the bar is missing: Codex++ running → user script present (`%APPDATA%\Codex++\user_scripts\codex-token-spend-panel.js`) → monitor running → reload the page.

## How it works

```
Codex session logs (local JSONL)
    └─ token-stats.mjs: incremental parse → unified merge → TPS / cache split / context
        └─ pushed over CDP (127.0.0.1:9229) as a schema v2 payload
            └─ codex-token-spend-panel.js: mounts the bar + detail popover (skeleton once, then incremental updates)
```

- The monitor pushes every 5 seconds, and immediately when data changes;
- The page script self-heals: it remounts the bar if it is removed or the anchor changes;
- The popover updates incrementally and preserves scroll position and expanded cells across rebuilds.

## License

MIT (see `LICENSE`).
